# ADR-008: State persistence — pluggable stores with in-memory defaults; event retry on the caller

**Status:** Accepted (revised 2026-06-04 to allow pluggable persistent stores)
**Date:** 2026-05-28

## Context

The engine maintains several distinct kinds of state during operation. Each has different durability needs:

| State | Where it lives | Pluggable? | Survives engine restart? |
|---|---|---|---|
| Aggregation windows ([ADR-006](006-aggregation-windows.md)) | `AggregationStore` | yes | only with a non-default backend |
| Pending scheduled checks ([ADR-007](007-temporal-absence-rules.md)) | `ScheduledStore` | yes | only with a non-default backend |
| Integration TTL caches ([ADR-005](005-external-integration-resilience.md)) | inside each `IntegrationAdapter` | yes | only with a non-default backend |
| Per-event memoization ([ADR-004](004-evaluation-model.md)) | engine-internal `EvalContext` | no — ephemeral by definition | n/a |
| In-flight evaluation registry ([ADR-012](supervisor/012-supervisor-graceful-shutdown.md)) | in-process `Map` | no — ephemeral by definition | n/a |

Earlier this ADR locked in *"all engine state lives in process memory."* That was right for the original prototype but became overly restrictive once aggregation and scheduling were generalized behind store interfaces ([ADR-006](006-aggregation-windows.md) and [ADR-007](007-temporal-absence-rules.md) revisions). The current question is sharper: **which state is pluggable, which is ephemeral, and where does event-delivery durability sit**.

The service that invokes the engine — webhook receiver / orchestrator between GitHub and us — already owns webhook ack/retry, delivery dedupe (via the `X-GitHub-Delivery` UUID), and dead-lettering. Adding any of that inside the engine would duplicate machinery the caller already has.

## Decision

**Engine state splits cleanly into three classes.**

1. **Long-lived rule state is pluggable**, with in-memory defaults the library ships. Consumers can swap in Redis, SQLite, or any backend that conforms to the store interface — same rule code, same engine. The in-memory defaults lose state on restart; persistent backends preserve it. This applies to `AggregationStore`, `ScheduledStore`, and the per-integration TTL caches inside `IntegrationAdapter`.

   **The shipped in-memory implementations are explicitly for development, demo, and testing — not production.** They are unbounded `Map`s with no eviction, no size cap, no spillover, and no cross-process coordination. They exist so a consumer can `new RuleEngine()` and have a working engine without wiring infrastructure, and so the engine's own tests can run without external dependencies. A production deployment is expected to pass a persistent store implementation. The store interfaces ([ADR-006](006-aggregation-windows.md), [ADR-007](007-temporal-absence-rules.md)) are the durable contract; the in-memory defaults are not.

2. **Per-evaluation state is ephemeral by design.** Per-event memoization, the in-flight evaluation registry, and any other state scoped to a single `evaluate(event)` call live in process memory and disappear when the call ends. There is no value in persisting these — they exist only to coordinate work within one evaluation.

3. **Event-delivery durability stays with the caller, regardless of how the engine's stores are configured.** When the engine pod shuts down mid-evaluation (graceful drain timeout or crash), the engine cancels in-flight work and the supervisor marks those `delivery_id`s as abandoned ([ADR-012](supervisor/012-supervisor-graceful-shutdown.md)). The caller, holding the webhook ack, retries. Persistent stores prevent loss of *rule state* (the aggregation window, the pending scheduled check); they do not promise that a particular `evaluate(event)` call completed.

**The library guarantees:**
- `evaluate(event)` is idempotent given the same `(event, rule-set, store-contents)`. The same event resubmitted produces the same outcome — with the caveat that store contents may differ if other events landed between attempts, but those other events are independent inputs, not a violation of idempotency.
- On engine restart with persistent stores: aggregation counts and scheduled checks resume from wherever they were when the previous instance stopped writing. Time-sensitive semantics (e.g., a check whose `runAt` passed during downtime) fire on the first scheduler tick after restart.
- On engine restart with in-memory stores: all rule state is lost; aggregation windows under-count until refilled; scheduled checks that were pending are silently dropped.

**The library does not promise:**
- That any specific `evaluate(event)` call is processed exactly once. Retries are the caller's job; the engine's idempotency contract supports them.
- Atomic commit of "store update + caller ack." There is no such transaction — the caller acks based on its own success criteria, regardless of which backend the engine's stores use.

## Alternatives considered

- **In-memory only, no swap-out** (the previous decision). Right for the original prototype; obsolete once [ADR-006](006-aggregation-windows.md) / [ADR-007](007-temporal-absence-rules.md) generalized to store interfaces. Those revisions made the in-memory floor a default rather than a constraint; ADR-008 is updated here to follow.
- **Persistent state required from day one.** Adds an external dependency (Redis or SQLite) and a single point of failure the in-memory default doesn't have. Forces every consumer — unit tests, demos, CI — to depend on infrastructure. Keeping in-memory as the default and persistent backends as opt-in makes both deployment shapes first-class.
- **Engine-owned event retry on internal failure.** Re-runs `evaluate(event)` on retriable errors internally. Couples the engine to delivery semantics it doesn't see (the engine doesn't hold the webhook ack), and duplicates the caller's existing retry infrastructure. Rejected.
- **Engine writes a per-event commit log** (so the engine knows whether a given delivery was already processed). Effectively makes the engine an event broker — adds a persistent store dependency even when consumers don't need one, and the caller is already deduping by `X-GitHub-Delivery`. Rejected.
- **Per-store choice at construction vs. one global "persistence mode" flag.** Per-store is what the interfaces already enable, and it's the right granularity: a consumer might want persistent aggregation windows but in-memory scheduled checks (or vice versa) depending on which they can afford to lose. A single flag would force a coarser decision.

## Consequences

**Positive:**
- Consumers pick durability per concern: Redis-backed `AggregationStore` and `ScheduledStore` for production, in-memory for tests and demos, mix as needed.
- Library stays dependency-free. Persistent backends are opt-in and live in consumer code.
- The retry / dedupe boundary stays sharp: caller owns the wire, engine owns the evaluation. Each can be tested in isolation.
- Engine logic remains a function `(event, store-contents) → (result, store-updates)` — easier to reason about and test than an engine that also owns delivery.
- Restart-resilient deployments are a configuration choice, not a code change. A consumer that starts on in-memory can swap to Redis later without touching rule code.

**Negative:**
- "Restart-resilient" requires the consumer to wire persistent stores; an out-of-the-box deployment with the in-memory defaults still loses aggregation windows and pending scheduled checks on restart. The store interfaces ([ADR-006](006-aggregation-windows.md), [ADR-007](007-temporal-absence-rules.md)) make the upgrade a one-class swap, not a refactor.
- A misbehaving caller (no retry, no dedupe) can degrade effective correctness: events arriving twice will be counted twice in aggregation; events dropped will be missing from windows. The contract is documented and the engine's idempotency guarantees are explicit, but the engine cannot enforce the caller's discipline.
- Multi-replica deployments need shared persistent stores for correct cross-replica rule semantics — two replicas with in-memory stores will each accumulate their own (sharded or duplicated) state. Documented; consumers running multi-replica must use persistent backends.
- Cross-process atomicity (`AggregationStore.appendAndCount`, `ScheduledStore.claim` with `leaseMs`) is the backend's responsibility, not the library's. The store interfaces accommodate it; the in-memory defaults don't, which is fine for single-process and incorrect for multi-replica without a shared persistent backend.
- The in-memory defaults grow unbounded. A long-running process using only the in-memory stores will leak memory proportional to event volume × window length × distinct keys. Documented and intentional — these implementations are not the production path; consumers wiring persistent stores get the eviction / sizing semantics of that backend.
- An evaluation in-flight at the moment of pod termination is still abandoned and retried by the caller. Persistent stores narrow the surface of "data loss on shutdown" but don't eliminate it for events mid-evaluation.
