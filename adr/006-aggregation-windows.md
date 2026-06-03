# ADR-006: Aggregation — projected windows, split action kinds, swappable store

**Status:** Accepted (revised 2026-06-03 to split `action` / `aggregatedAction` and define the `AggregationStore` interface)
**Date:** 2026-05-28

## Context

Rules of the form "fire only if 3 failed CI runs happen on the same PR within 1 hour" require querying recent event history at evaluation time. Two design questions:

1. **What to store** — raw webhook payloads, or projected events?
2. **Where to store it** — in memory, or in a persistent store?

The naive choice (raw payloads in memory) is wasteful by a wide margin: GitHub webhook payloads are 30–100 KB JSON, and a parsed object in V8 adds another 2–3× overhead. At 100 RPS over a 1-hour window, that's 50 GB+ of payload data — impossible on a single node.

By contrast, the fields a downstream consumer actually needs (PR number, conclusion, run URL, a few labels) project to a few hundred bytes per entry.

There is a third question that fell out of revising this ADR: **who owns the projection** — the rule, or the consumer of the aggregation? The earlier draft had projection on the rule (`rule.aggregate({ select })`). The current decision moves it to the action — the data's actual consumer — by splitting actions into two kinds.

## Decision

**Aggregation lives behind a swappable `AggregationStore` keyed by `(ruleId, actionId, keyId)`. Default implementation is in-memory. Projection is declared by a new `aggregatedAction` entity that carries a `.transform(...)` step; plain `action` is unchanged.**

### Two action kinds

```ts
// Plain action — fires per matching event (or per threshold hit on an aggregating
// rule). ctx.event is always the current / triggering event. No knowledge of history.
const notifySlack = action('notify-slack')
  .args(z.object({ channel: z.string() }))
  .fn(async (ctx) => {
    await ctx.integrations.slack.post({
      channel: ctx.args.channel,
      text: `event ${ctx.event.action} on ${ctx.event.repository.full_name}`,
      signal: ctx.signal,
    });
  });

// Aggregated action — declares a per-event transform from the source event to the
// payload it wants stored. Attaches only to aggregating rules. .fn receives the
// transformed history through ctx.aggregate.entries[*].payload; no event fields
// are passed in by default.
const notifyFlakyRuns = aggregatedAction('notify-flaky-runs')
  .on('workflow_run.completed')                            // narrows the event type for .transform
  .args(z.object({ channel: z.string() }))
  .transform((ctx) => ({
    runUrl: ctx.event.workflow_run.html_url,
    conclusion: ctx.event.workflow_run.conclusion,
    headSha: ctx.event.workflow_run.head_sha,
  }))
  .fn(async (ctx) => {
    // ctx.aggregate.entries[i].payload is `any`; the author knows what .transform produced.
    const lines = ctx.aggregate.entries
      .map((e) => `• ${e.payload.runUrl} (${e.payload.conclusion})`)
      .join('\n');
    await ctx.integrations.slack.post({
      channel: ctx.args.channel,
      text: `flaky runs in window:\n${lines}`,
      signal: ctx.signal,
    });
  });
```

Differences at a glance:

| | `action` | `aggregatedAction` |
|---|---|---|
| `.on(eventName)` step | not used | required — narrows `ctx.event` in `.transform` |
| `.transform(ctx) => payload` step | n/a | required |
| `ctx.event` in `.fn` | the current / triggering event | the threshold-triggering event (also available) |
| `ctx.aggregate` in `.fn` | not present | `{ entries, count, windowMs, keyId }`; `entries[i].payload: any` |
| Storage write per event | none | one append per attached `(ruleId, actionId, keyId)` |
| Attachable to | any rule | only rules with `.aggregate(...)` |

Rules attach both kinds with the same `.action(name, { args })` verb; the engine determines kind by looking up `name` in the registry. Register-time checks ([ADR-002](002-dsl-design.md)):
- Every `aggregatedAction` attached to a rule must reference a rule with `.aggregate(...)`.
- The rule's `.on(...)` must match the aggregated action's `.on(...)`.
- A rule with `.aggregate(...)` must have at least one aggregated action attached — otherwise there is no consumer producing storage writes, and the count bucket is undefined. Use a non-aggregating rule if you only need a plain action.
- A rule may not have both `.aggregate(...)` and `.schedule(...)` ([ADR-007](007-temporal-absence-rules.md)). The two carry incompatible lifecycle and storage models and are mutually exclusive at register time.

### Storage interface

```ts
interface AggregationStore {
  // Append a projected entry to the (ruleId, actionId, keyId) bucket.
  append(
    ruleId: string,
    actionId: string,
    keyId: string,
    entry: AggregationEntry,
  ): Promise<void>;

  // Entries in [now - windowMs, now]. Used by the action's ctx.aggregate.entries.
  list(
    ruleId: string,
    actionId: string,
    keyId: string,
    windowMs: number,
  ): Promise<AggregationEntry[]>;

  // Count in [now - windowMs, now]. Cheap path — backends typically have a
  // dedicated op (Redis ZCOUNT, SQLite COUNT(*), in-memory array length).
  count(
    ruleId: string,
    actionId: string,
    keyId: string,
    windowMs: number,
  ): Promise<number>;

  // Optional: atomic append + count, for distributed backends where two
  // webhooks can race for the same bucket. Default impl in the engine
  // composes append() + count() — adequate for single-process in-memory.
  appendAndCount?(
    ruleId: string,
    actionId: string,
    keyId: string,
    entry: AggregationEntry,
    windowMs: number,
  ): Promise<number>;

  // Optional: sweep entries older than the cutoff. In-memory runs this on a
  // ~10s timer. Redis-backed implementations set EXPIRE on append and no-op.
  prune?(olderThanMs: number): Promise<void>;
}

interface AggregationEntry {
  at: number;            // ms since epoch
  deliveryId: string;    // from ctx.deliveryId, for correlation / dedup
  payload: any;          // whatever the action's .transform returned; intentionally `any`
}
```

Properties:

- **`payload: any` is deliberate.** The aggregated action's `.transform` is the source of truth for what's in there; the action's `.fn` reads it back with knowledge it just put it. We do not propagate the transform's return type through storage because that would force the store to be generic over per-action payload shapes, which couples the storage backend to the rule registry. Authors who want stronger typing inside `.fn` can cast.
- **Keyed by `(ruleId, actionId, keyId)`.** Two aggregated actions on the same rule have independent buckets — each stores what its own `.transform` produced. Two rules that produce the same key value also do not share buckets.
- **`windowMs` is a read-side parameter.** The store doesn't carry per-rule window settings; the engine passes the current window on every read. Maps directly to Redis `ZRANGEBYSCORE` / `ZCOUNT`.
- **Count is per `(ruleId, actionId, keyId)`.** Every aggregated action attached to the same rule produces a bucket with the same count (each passing event triggers one append per attached aggregated action). The engine queries the first attached aggregated action's bucket as canonical for the threshold check.
- **The engine supplies `at` on `append`.** Either the rule's `.aggregate({ at: (ctx) => ... })` resolved against `ctx`, or `ctx.now` when the rule doesn't specify. Storage never reads its own clock.

### Default in-memory implementation

`Map<ruleId, Map<actionId, Map<keyId, SortedTimestampList<AggregationEntry>>>>`:
- `append`: O(log n) sorted insert by `at`.
- `list` / `count` over window: O(log n) lower-bound scan from `now - windowMs`.
- `prune` sweeper: every 10s, walks each bucket and drops entries older than `max(rule.window)` across loaded rules.

Ships with the library; consumers pass any `AggregationStore` to the engine constructor. Redis sketch: `ZADD ${ruleId}:${actionId}:${keyId} <at> <encoded-entry>`, `ZCOUNT` / `ZRANGEBYSCORE` for reads, `EXPIRE` per key.

### Evaluation lifecycle for aggregation rules

1. `.on(eventName)` candidate filter ([ADR-004](004-evaluation-model.md) Phase 1).
2. `.when(ctx)` returns `true`. (Returning `false` short-circuits — events that don't pass `.when` never enter the window.)
3. Engine resolves `key(ctx) → keyId`, `at(ctx) → at` (or `ctx.now`).
4. **For each aggregated action attached to this rule**, engine resolves `transform(ctx) → payload` and calls `store.appendAndCount(ruleId, actionId, keyId, { at, deliveryId, payload }, windowMs)` (or `append` + `count`). The first attached aggregated action's returned count is the canonical threshold value.
5. If `count >= rule.aggregate.count`, all attached actions fire:
   - Plain actions: `ctx.event = triggering event`. `ctx.aggregate` is absent.
   - Aggregated actions: engine calls `store.list(ruleId, actionId, keyId, windowMs)` and populates `ctx.aggregate = { entries, count, windowMs, keyId }`. `ctx.event` is also the triggering event for these.

### Example: flaky PR CI with aggregation

```ts
export const flakyPrCi = rule('flaky-pr-ci')
  .on('workflow_run.completed')
  .when((ctx) =>
    ctx.event.workflow_run.conclusion === 'failure' &&
    ctx.event.workflow_run.pull_requests.length > 0
  )
  .aggregate({
    window: '1h',
    count: 3,
    key: (ctx) => ctx.event.workflow_run.pull_requests[0].id,
    // Optional: timestamp of the entry. Defaults to ctx.now. Override when the
    // event carries a meaningful occurred-at you'd rather track than arrival time.
    at: (ctx) => Date.parse(ctx.event.workflow_run.created_at),
  })
  .action('notify-flaky-runs');   // aggregated action, registered separately

engine.register({
  aggregatedActions: [notifyFlakyRuns({ channel: '#flaky-ci' })],
  rules: [flakyPrCi()],
  // predicates: [], actions: [], integrations: [], ...
});
```

### Capacity envelope (default in-memory store)

On an 8 GB heap, typical projection sizes (~200 B per entry): ~1.5M–4M entries in window per `(ruleId, actionId, keyId)` bucket. Comfortably covers 100 RPS × 1 hour at the rule/action counts we expect. Beyond that, swap the store for Redis ZSETs — same interface, no rule changes.

## Alternatives considered

- **Hold raw webhook payloads.** Simplest to implement; 30–100× memory blowup; capacity ceiling collapses. Rejected.
- **Engine-inferred projection** (walk the rule set, project every field any rule references). Earlier draft. Replaced because (a) rules vary in what their consumers need, (b) "engine reads your rule and figures out what to keep" is magic at a distance and fragile, (c) it forced a startup-time projection-schema rebuild.
- **Rule-level `select` on `.aggregate(...)`.** First revision moved projection from the engine to the rule. Rejected after another pass because *the action* is the consumer of the projection. Putting `select` on the rule means rule writers must know what every attached action wants, and adding a new action requires editing the rule.
- **Attach-site `select` on plain `.action(name, { select })`.** Considered. Mechanically works, but blurs the type: `action` then has two modes (with or without `select`), and a single `action` definition can't have a typed `.fn` because the attach-site decides whether `ctx.aggregate` is populated. Splitting into a separate `aggregatedAction` primitive keeps each entity's `.fn` signature exact — `aggregatedAction.fn` always sees `ctx.aggregate`; `action.fn` never does.
- **Aggregated action declared on the action **definition** (one transform per action, fixed event).** Adopted. The tradeoff: an aggregated action is bound to one event variant via `.on(...)`. A consumer that wants "the same downstream notification for both workflow_run failures and check_run failures" defines two aggregated actions, or extracts a shared `.fn` helper they both call. Acceptable — aggregation projections are inherently event-specific in a way that plain actions are not.
- **Shared windows across rules with the same key** (one bucket, many rules query it). Rejected — two rules with the same key but different attached actions would collide on storage layout. Per-rule keying keeps the model simple.
- **Redis sorted sets directly (no abstraction).** The production-grade choice for storage, but baking Redis into the library forces every consumer to depend on Redis even for unit tests. The `AggregationStore` interface keeps the library dependency-free with in-memory default; Redis is a drop-in.
- **Stream processor (Kafka Streams, Flink).** Vastly overkill at this scale. Rejected.
- **SQLite with timestamp index.** Reasonable middle ground; can be implemented as another `AggregationStore` if a consumer wants on-disk persistence without Redis. Not the default for the same dependency-freeness reason.

## Consequences

**Positive:**
- The projection lives next to its consumer (the aggregated action) — adding or modifying an action is a one-file change.
- Two clean action types: `action.fn` and `aggregatedAction.fn` each have an exact, non-conditional context shape.
- Swapping persistence (in-memory → Redis → SQLite) is a one-class change; rule and action code are untouched.
- `payload: any` lets the storage interface stay simple and decoupled from per-action types. Aggregated action authors retain control of their payload shape inside `.fn` (they wrote `.transform`, they know what to expect).
- Aggregation queries are O(log n) in the default store; well under 1 ms at expected sizes.

**Negative:**
- Aggregated actions are bound to one event variant (their `.on(...)`). A consumer that wants the same notification across multiple event types defines multiple aggregated actions or shares a helper. Plain actions remain event-agnostic.
- Storage growth is `O(rules × aggregatedActions × keys × eventsInWindow)`. Two aggregated actions on the same rule store the same entries twice (with different payloads). Tolerable at expected fan-out (1–3 aggregated actions per rule); if it becomes a problem, the consumer can extract shared logic to one aggregated action that fans out internally.
- `payload: any` means no static type checking on aggregated entries inside `.fn`. The author already knows their `.transform`'s shape, so the cost is small, but TypeScript can't catch a typo in `e.payload.runUrl`. A future refinement could infer the entry type from the `.transform` return — explicitly out of scope here.
- Default in-memory state is lost on restart ([ADR-008](008-in-memory-state-caller-retry.md)). After a restart, threshold rules under-count until the window refills. Consumers needing restart-survivability swap in Redis.
- `appendAndCount` is non-atomic in the in-memory default — two simultaneous webhooks could both decide they're the Nth event. In-process this means the action fires twice (recoverable); distributed backends must implement the atomic variant.
- ADR-002 needs a small extension to add `aggregatedAction` to its entity list and the `register({ aggregatedActions: [...] })` key. Tracked separately.
