# ADR-011: Engine observability — logger via ctx, GitHub-id tracing, metrics emitter

**Status:** Accepted (revised 2026-06-04 to scope strictly to engine surface; demo/server wiring moved under `supervisor/`)
**Date:** 2026-05-28

## Context

A rule engine that can't answer *"why did this rule fire (or not)?"* is operationally useless. The engine must expose enough surface for a consumer to debug rule evaluation, correlate work across async boundaries, and aggregate metrics — but it should **not** bundle a specific telemetry stack. Different consumers run different observability stacks (OTel vs. custom, Pino vs. Winston vs. console, Prometheus vs. CloudWatch vs. none), and forcing a specific SDK into the library means every embedder has to either install it or fight it.

The library's job is to expose stable hooks keyed on stable identifiers. The wiring — pushing logs to a backend, starting spans on a tracer, aggregating events into metric histograms — belongs to the consumer.

## Decision

**Three engine-side observability mechanisms, no SDK dependencies.** All three are keyed on GitHub's per-delivery UUID (`X-GitHub-Delivery`, surfaced as `ctx.deliveryId`) so a single ID stitches logs, traces, and metrics together.

### 1. Logger via `ctx`

The consumer passes a logger object at engine construction; the engine threads it through `ctx.logger` to every predicate, action, aggregated action, scheduled action, and scheduled `check` function. The logger is wrapped at each scope so the right correlation fields are already bound:

- engine root logger → no extra bindings
- per-evaluation child → `{ deliveryId, repo, installation }`
- per-rule child → adds `{ ruleId }`
- per-predicate / per-action child → adds `{ predicateName }` or `{ actionName }`

User code never has to remember to attach the delivery id — the engine already did. The engine expects a **Pino-compatible logger** (object-first, optional message, with a `child(bindings)` method):

```ts
interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  child(bindings: object): Logger;
}
```

Pino and Bunyan satisfy this shape directly. Consumers using a different convention — Winston (`info(msg, meta?)`), log4js, or any custom logger — wrap once at engine construction with a thin adapter. We picked Pino's shape rather than declaring a neutral one because the engine's own log calls are mostly "structured fields, sometimes a message" rather than "sentence, sometimes some fields" — Pino reads naturally for that, and it's the default in most modern Node frameworks (Fastify, NestJS). It is a choice, not a universal contract; documented here so consumers know which side of the convention split to plug into.

The engine ships a default no-op logger so an embedder who doesn't care still gets a working engine.

The engine itself logs at three points: per-evaluation start/end, per-predicate error/short-circuit, and per-integration call failure (above the adapter's retry budget). Verbosity is left to the consumer's logger level — the engine emits at `debug` for hot paths and `info`/`warn`/`error` for actionable events.

### 2. Tracing via GitHub IDs

The engine does not start spans, does not depend on any tracer, and does not own a trace ID format. What it does is **expose stable correlation IDs** on `ctx` so the consumer's tracer can use them:

- **`ctx.deliveryId`** — `X-GitHub-Delivery` (a UUID). One per webhook delivery; the natural trace-correlation key. Persists through every async boundary in the evaluation tree.
- **`ctx.installation`** — `installation.id` from the webhook payload. Useful for grouping traces by GitHub App installation (i.e., by tenant).
- **`ctx.repo`** — `repository.full_name` and `repository.id` from the payload. Useful for repo-level filtering.

A consumer running OTel typically derives a 128-bit trace ID by hashing `deliveryId` and attaches `installation` / `repo` as span attributes. A consumer running nothing more elaborate than structured logs gets the same correlation by putting `deliveryId` in every log line (the engine already does this via the logger). The library doesn't have an opinion on which path — both work because the IDs are stable and propagated identically.

Predicates, actions, and integration adapters that make outbound HTTP calls can attach `deliveryId` to outgoing headers (`X-Correlation-Id` or whatever the receiving service expects) so external-service traces link back to the original webhook. The engine does not do this automatically — it would conflict with adapter-defined headers — but `ctx.deliveryId` is always there for the adapter to attach.

### 3. Metrics emitter

The engine exposes an event emitter for observability events that consumers aggregate into metrics. The engine emits; the consumer counts:

```ts
engine.on('rule.matched',         (e: { deliveryId, ruleId, elapsedMs }) => {/* count */});
engine.on('rule.skipped',         (e: { deliveryId, ruleId, reason }) => {/* count */});
engine.on('predicate.evaluated',  (e: { deliveryId, predicateName, result, elapsedMs, cached }) => {/* histogram */});
engine.on('external.call',        (e: { deliveryId, integrationName, methodName, ok, elapsedMs, cacheHit, breakerState }) => {/* histogram + counter */});
engine.on('aggregate.appended',   (e: { deliveryId, ruleId, actionId, keyId, count }) => {/* gauge */});
engine.on('scheduled.enqueued',   (e: { ruleId, keyId, runAt }) => {/* counter */});
engine.on('scheduled.checked',    (e: { ruleId, keyId, outcome: 'pass' | 'skip' | 'recheck' }) => {/* counter */});
engine.on('evaluation.completed', (e: { deliveryId, matchedCount, totalElapsedMs }) => {/* histogram */});
engine.on('evaluation.failed',    (e: { deliveryId, error }) => {/* counter */});
```

> **NOTE — implementation of metric aggregation is out of scope for the current prototype.** The engine *emits* events; the *aggregation* (counters, histograms, percentile tracking, persistence to Prometheus / CloudWatch / wherever) is the consumer's responsibility, wired via `engine.on(...)` callbacks. The emitter hook surface is committed; the aggregation implementation is not part of this ADR or the prototype deliverable. When we do implement an aggregation layer it will sit on top of these events without changing them.

Event payloads carry `deliveryId` wherever an event is in the scope of a single evaluation — that is the link back to logs and traces for the same delivery. Scheduled-rule events (`scheduled.enqueued`, `scheduled.checked`) don't have a `deliveryId` for the check phase (the original delivery is gone by then); they carry `ruleId` + `keyId` instead, which the consumer can stitch back via the original `scheduled.enqueued` event if needed.

## Alternatives considered

- **Library couples to OpenTelemetry directly** — calls `tracer.startSpan()` inside the engine, depends on `@opentelemetry/api`. Forces every consumer to use OTel; precludes embedding in stacks that use something else (or nothing). Rejected. The emitter-based approach lets an OTel consumer wire spans in a few lines and lets a non-OTel consumer ignore it entirely.
- **Library ships a default Pino-based logger.** Forces a Pino dependency even on consumers who pass their own logger. Rejected — the default is a no-op logger; consumers pass a real one if they want output.
- **Engine aggregates metrics internally and exposes a `/metrics` endpoint.** Pulls every consumer into a Prometheus-shaped model and forces decisions about counter cardinality, histogram buckets, and retention. Rejected — emit raw events, let consumers decide. (Also: the engine ships no HTTP at all, per the library/demo boundary in [supervisor/ADR-013](supervisor/013-library-demo-separation.md).)
- **Bake `deliveryId` into a W3C TraceContext header automatically.** Couples the engine to specific header conventions and the specific tracer the consumer might use. Rejected — the ID is on `ctx`, the adapter can choose what to do with it.
- **Strongly typed `engine.on(...)` discriminated-union overloads.** Considered. Would catch typos in event names at compile time. Worth doing if the event surface ossifies; not blocking. The names above are the committed set.
- **Logger as a free function (`log.info(...)`) rather than `ctx.logger`.** Free functions can't carry per-evaluation correlation bindings without an `AsyncLocalStorage` layer; threading via `ctx.logger` is explicit and works without async-context plumbing.

## Consequences

**Positive:**
- The library has zero telemetry SDK dependencies. Pino, OTel, prom-client, CloudWatch — all consumer choices.
- One ID (`deliveryId`) ties logs, traces, and metrics together. "What happened with delivery X?" is a single grep on the consumer's log backend.
- `ctx.logger` carries the right bindings without rule authors having to remember. A `ctx.logger.warn({...})` call from inside a predicate already has `deliveryId`, `ruleId`, `predicateName` attached.
- The emitter surface is small (nine event types) and engine-controlled — consumers wiring metrics aggregate over a stable shape.
- The default no-op logger means the engine works without any wiring; observability is opt-in.

**Negative:**
- A consumer that doesn't wire anything (no logger, no emitter listeners) gets no observability. Documented; the default no-op logger makes this loud (no output) rather than silent (allocations without exposure).
- The emitter pattern is heavier than direct SDK calls for the consumer who would happily depend on OTel — they have to write the wiring once. Pays off the first time someone embeds without OTel.
- `engine.on(event, cb)` is untyped today — a typo in the event name silently subscribes to nothing. Mitigation: a TypeScript union for event names is shipped with the library; tightening `on(...)` to use it is a small follow-up.
- Metrics aggregation being a consumer concern means the prototype itself gets no metrics out of the box. Acceptable per the "out of scope" note above; the events are emitted and inspectable, the aggregation layer comes later.
- Scheduled-rule events lack `deliveryId` at check time (the original delivery is no longer in flight). Consumers correlating scheduled-rule metrics back to the triggering delivery bridge via `ruleId` + `keyId` (and, if needed, `scheduledAt`). Documented.
