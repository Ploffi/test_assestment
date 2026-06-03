# ADR-004: Evaluation model — async, two-phase, memoized, short-circuit

**Status:** Accepted (terminology updated 2026-06-03 to match [ADR-002](002-dsl-design.md))
**Date:** 2026-05-28

## Context

A single event may be evaluated against many rules. Rules mix:
- **Cheap predicates** (event-field comparison, simple boolean) — microseconds, pure.
- **Expensive predicates** (external classifier call, aggregation query, internal lookup) — tens of milliseconds to seconds, IO-bound.

A naive evaluator (sync, every predicate per rule per event) would either block on IO or make the same expensive call multiple times per event when several rules ask the same question.

The dominant cost driver in production will be external API calls — that is what we optimize against, not in-process compute.

This ADR describes how the engine walks the `.when` tree produced by the code-as-config DSL ([ADR-002](002-dsl-design.md)). The DSL surface — `rule(...).on(...).when(all(...))`, `use(name, args)` references, the unified `ctx` shape — is the input contract; this ADR is the runtime behavior.

## Decision

**Async-first, two-phase, with per-event memoization and short-circuit semantics.**

### Phase 1 — synchronous candidate filtering by event name

`.on(eventName)` on a rule is indexed into a `Map<EventName, Rule[]>` at `engine.register()` time. When an event arrives, the engine does a single map lookup by `event.name + '.' + event.action` (matching the discriminator in `@octokit/webhooks-types`) and proceeds only with the rules registered for that variant. Done as one O(1) lookup per incoming event; rules for unrelated event variants pay nothing.

No predicate or `.when` callback runs in Phase 1.

### Phase 2 — async tree evaluation

For each surviving candidate rule, walk its `.when` tree asynchronously. The tree is composed of:
- **Combinator nodes** — `all` (n-ary AND), `any` (n-ary OR), `not` (negation). Defined in [ADR-002](002-dsl-design.md).
- **Leaf nodes** — either an inline `(ctx) => boolean | Promise<boolean>` function or a `use(name, args)` reference resolved to a registered predicate.

Evaluation rules:
- `all` short-circuits at the first `false` child.
- `any` short-circuits at the first `true` child.
- `not` evaluates its single child and inverts the result.
- Children of `all` / `any` are evaluated **sequentially** — short-circuit only saves work if we do not speculatively launch all branches.

> *Parallel child evaluation (`all` / `any` racing their branches) is a clear future extension: cheaper wall-clock latency in exchange for wasted external calls when short-circuit would have skipped them. Out of scope for the prototype; see Alternatives.*

For a `use(name, args)` leaf:
1. Resolve the predicate by name from the registry. (Missing names are impossible at evaluate time — `register()` validates referentially per [ADR-002](002-dsl-design.md).)
2. Resolve any `(ctx) => value` callbacks in the use-site args against the current `ctx`.
3. Merge use-site args with the predicate's registration args, **registration wins** (per [ADR-002](002-dsl-design.md) — registration > use-site, defined-only override).
4. Validate the merged object against the predicate's `argsSchema` (Zod). Validation failure throws a `PredicateArgsError` for this rule's evaluation; other rules in the same event continue.
5. Build the inner `ctx` for the predicate (same `event`, `signal`, `deliveryId`, `integrations`; `args` replaced with the validated merged args) and `await predicate.fn(ctx)`.

For an inline `(ctx) => ...` leaf, call it with the rule's own `ctx`.

### Per-event memoization

Each evaluation creates a fresh internal `EvalContext` (distinct from the user-facing `ctx`) carrying a memoization map keyed by `(predicate_name, args_hash)`. Within one event's evaluation, the same `use(name, args)` call across all rules resolves to the same in-flight `Promise` — the second caller awaits the first's result instead of triggering another `.fn` invocation. This is the DataLoader pattern.

Args hashing canonicalizes the merged args object (recursive sorted keys → stable JSON) before hashing. Two `use(...)` sites with the same name and the same merged args share a result; different args (e.g., different `team` values for `is_team_member`) do not collide.

Memoization is **scoped to a single event** — no cross-event sharing in this layer. Cross-event caching is the TTL cache inside each `IntegrationAdapter` ([ADR-005](005-external-integration-resilience.md)). This split keeps the engine's correctness guarantee simple: predicates must be referentially transparent *within one event*, which is a sane contract for rule authors.

## Predicate protection

Predicates are the engine's most failure-prone unit — they may be slow, throw, hang, or cost real money per call. Protections sit in two layers: the engine wraps every `.fn` invocation in cancellation and error isolation; the IntegrationAdapter layer wraps external calls themselves. Listed by where the mechanism lives.

**Engine layer (this ADR):**

1. **Per-event memoization (coalescing).** As above — same `(name, args)` resolves once per event. Eliminates duplicate work and duplicate cost when N rules ask the same question.
2. **AbortSignal-driven cancellation.** Every predicate's `ctx.signal` is the same `AbortController` driving the per-event watchdog ([ADR-012](supervisor/012-supervisor-graceful-shutdown.md)). When the per-stage deadline trips, every in-flight `.fn` sees its signal aborted; well-behaved predicates that thread `ctx.signal` into `fetch` / integration calls cancel cooperatively.
3. **Per-stage timeout.** The whole `.when` tree evaluates under the `evaluate`-stage deadline (default 15s, configurable per [ADR-012](supervisor/012-supervisor-graceful-shutdown.md)). A predicate that ignores `ctx.signal` does not extend the deadline — the watchdog still aborts the evaluation; the leaked predicate's eventual return is dropped.
4. **Error isolation.** If a predicate's `.fn` throws or rejects, the engine treats the leaf as `false` by default and continues evaluating sibling rules. The error is logged with `delivery_id` and `predicate_name` ([ADR-011](011-observability.md)). Predicate authors can opt into fail-open per-call via a reserved arg (`failOpen: true`) — documented in [ADR-005](005-external-integration-resilience.md) for the integration-failure case; the engine honors it for any throw.
5. **Args validation at evaluate time** (backstop for the dynamic portion). The pinned portion of every entity's args is already validated at `register()` time against its Zod schema, and missing dependencies are caught there too ([ADR-002](002-dsl-design.md) — `register()` runs a dependency-graph check and a registration-args schema check over the full batch). The evaluate-time check exists because `use(...)` args may contain `(ctx) => value` callbacks that only resolve per event: those are resolved against the current `ctx`, merged with the registration args (registration wins), and the **merged** object is re-validated before `.fn` runs. A validation failure here is an error for that rule's evaluation, treated like a throw (logged, leaf returns `false`).

**Integration-adapter layer (cross-ref [ADR-005](005-external-integration-resilience.md)):**

6. **TTL cache (cross-event).** Each `IntegrationAdapter` keeps an `lru-cache` keyed by call signature; TTL per integration (e.g., team membership 5m, classifier 24h). The engine memoization above handles same-event fan-out; this handles cross-event reuse.
7. **Circuit breaker.** `opossum`-based, per integration. Open breaker fails fast without hitting the network — predicate gets a thrown error, which under the engine's error-isolation rule resolves the leaf to `false` (or to `true` if the predicate opted into fail-open).
8. **Per-integration concurrency limit.** `p-limit` semaphore per integration. A slow classifier consumes only its own budget — unrelated predicates on the same event are not starved.
9. **Bounded retry with backoff.** Lives inside the adapter, capped at 3 attempts with jittered backoff. Retries do not extend the per-evaluation deadline.

**Not currently addressed** (deferred):

- **Per-predicate timeout independent of stage deadline.** Today every predicate in a rule shares the stage budget; a long-running predicate can starve later siblings (mitigated by sequential short-circuit and by the watchdog as a backstop, but not by a true per-predicate deadline). Worth adding a `.timeout(ms)` builder step on predicate definitions if we see this pattern in practice.
- **Per-rule cost budget.** No mechanism to cap "this rule's evaluation must not cost more than N external calls"; meaningful only once we wire billing into telemetry.

## Alternatives considered

- **Synchronous-only.** Impossible — external calls are required by the task.
- **Single-phase async (no event-name index).** Works but wastes async overhead on rules that do not apply to this event variant (e.g., issue rules running against a push event). Phase 1's O(1) dispatch cuts the candidate set to ~the rules that actually subscribed to this variant before any async code runs.
- **Cross-event caching only, no per-event memoization.** Doesn't help with same-event fan-out (multiple rules asking the same question), which is the more common pattern. Cross-event caching is layered separately in [ADR-005](005-external-integration-resilience.md).
- **Speculative parallel evaluation of all branches** (`all` / `any` racing their children). Lower wall-clock latency on matched evaluations, but burns external API calls on branches that short-circuit would have skipped — wrong trade-off when external calls are paid per-invocation (LLM, classifier). Deferred; can be opted in per-node (`.all({ parallel: true })`) once we have a use case where the author can defend the extra cost.
- **Lazy futures (don't evaluate until needed).** Functionally equivalent to short-circuit-with-sequential, just with more allocations.
- **Predicates can `use` other predicates** (nested references). Would force recursion handling, cycle detection, and a different memoization key shape. Predicates are leaf-only by design; composition lives in `all` / `any` / `not` on the rule. Cheaper to keep flat.

## Consequences

**Positive:**
- External API call count grows roughly with *unique calls per event*, not *rules × events*.
- Short-circuit means cheap predicates dominate cost in the common case (most rules do not fire).
- Two-phase separation maps cleanly to instrumentation — Phase 1 metrics (events vs. candidates) vs. Phase 2 metrics (predicate latency, short-circuit ratio).
- Predicate failure modes (throw, timeout, circuit-open) all resolve to a documented `false` (or opt-in `true`) — a misbehaving predicate cannot crash an evaluation.
- Registration-wins arg precedence in `use(...)` is enforced at the single merge point above — one place to reason about precedence, easy to surface in explain mode.

**Negative:**
- Predicates must be referentially transparent within one event — documented contract. A predicate that reads "current wall-clock time" within a single evaluation would surprise authors; we provide `ctx.now` to address this (engine-supplied, frozen at evaluation start).
- Memoization key derivation (args hashing) must be stable. Canonicalization is recursive sorted-keys → stable JSON; functions in args (the `(ctx) => value` form) are resolved to their value *before* hashing.
- Sequential short-circuit means tail latency is the sum of branches up to the deciding one; rule authors influence latency by branch ordering. Documented in the DSL guide — put cheap, likely-to-short-circuit predicates first inside `all`, expensive ones last.
- Cross-layer behavior (engine memoization on top of adapter TTL cache) needs careful telemetry to attribute cache hits to the right layer; both layers report hit/miss counters separately ([ADR-011](011-observability.md)).
