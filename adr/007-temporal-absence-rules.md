# ADR-007: Scheduled rules — deferred checks behind a swappable store

**Status:** Accepted (revised 2026-06-03 to generalize absence into scheduled checks and add `ScheduledStore`)
**Date:** 2026-05-28

## Context

Rules like *"fire on `issue.closed` only if the issue was NOT reopened in the last 5 minutes"* have a fundamentally different shape than counting/comparison predicates:

- The decision depends on what happens (or doesn't happen) during a **future window**.
- It cannot be evaluated at the moment the triggering event arrives — the next 5 minutes haven't happened yet.

Absence is one instance of a broader pattern: a rule wants to defer a decision until later, then run a check that can pass, skip, or postpone again. Other instances:
- "After release published, poll the artifact service every 30 minutes; notify when artifacts are complete; give up after 24h."
- "After PR merged, wait an hour, then verify the deploy succeeded; otherwise alert."

Earlier this ADR scoped narrowly to absence with an in-memory min-heap and ~1s ticks. Two problems forced a revisit: (1) deferred decisions in memory are lost on every redeploy, which silently swallows rule fires; (2) absence is a special case of a broader scheduled-check primitive that's cheap to generalize.

## Decision

**Generalize absence into `.schedule({ delay, key, transform, check })` on rules, with a swappable `ScheduledStore` for persistence. The scheduler polls the store on a 10s minimum cadence; check functions return `pass` / `skip` / `recheck`. A new `scheduledAction` entity is the action kind these rules attach.**

### The `.schedule(...)` rule step

```ts
rule('issue-closed-quiet')
  .on('issues.closed')
  .when((ctx) => ctx.event.issue.state_reason !== 'duplicate')   // optional, normal predicate tree
  .schedule({
    delay: '5m',
    deadline: '1h',                              // optional — auto-skip if still pending after this
    key: (ctx) => String(ctx.event.issue.id),
    transform: (ctx) => ({
      issueId: ctx.event.issue.id,
      url: ctx.event.issue.html_url,
      repo: ctx.event.repository.full_name,
    }),
    check: async (ctx) => {
      // ctx.payload is the transform's output (typed `any`, matches the aggregation convention).
      // ctx.scheduledAt is when the schedule was enqueued (ms since epoch).
      // ctx.args, ctx.integrations, ctx.signal, ctx.deliveryId all behave as elsewhere.
      const reopened = await ctx.integrations.github.wasReopenedSince(
        ctx.payload.issueId,
        ctx.scheduledAt,
      );
      return reopened ? { kind: 'skip' } : { kind: 'pass' };
    },
  })
  .action('notify-quiet-close');                 // a scheduledAction (see below)
```

**Shape of each `.schedule` field:**

| field | required | type | role |
|---|---|---|---|
| `delay` | yes | duration string or number (ms) | when to first check, relative to enqueue time |
| `deadline` | no | duration string or number (ms) | upper bound from enqueue time; if a `recheck` would push past this, the engine treats the record as `skip` |
| `key` | yes | `(ctx) => string` | uniqueness key; duplicate enqueue for the same `(ruleId, keyId)` replaces the existing record |
| `transform` | yes | `(ctx) => any` | projection from the triggering event into the stored payload; same name and role as `aggregatedAction.transform` ([ADR-006](006-aggregation-windows.md)) |
| `check` | yes | `(ctx) => Promise<CheckResult>` | the deferred decision; sees `ctx.payload`, not `ctx.event` |

**`CheckResult` is a discriminated union:**

```ts
type CheckResult =
  | { kind: 'pass' }                                  // fire attached actions; remove the record
  | { kind: 'skip' }                                  // remove the record; no action
  | { kind: 'recheck'; after: string | number };      // update runAt to now + after; keep the record
```

`pass` and `skip` both delete the record. `recheck` updates `runAt` and leaves it in storage.

### The `scheduledAction` entity

Scheduled rules attach a new action kind. Its `.fn` receives the rule's projected payload through `ctx.scheduled.payload` — not `ctx.event` (the triggering event was discarded after `.transform` ran, and `check` is gating the fire).

```ts
const notifyQuietClose = scheduledAction('notify-quiet-close')
  .args(z.object({ channel: z.string() }))
  .fn(async (ctx) => {
    // ctx.scheduled = { payload, scheduledAt, ranAt, keyId }
    // No ctx.event; no ctx.aggregate.
    await ctx.integrations.slack.post({
      channel: ctx.args.channel,
      text: `Issue ${ctx.scheduled.payload.url} stayed closed for the quiet window.`,
      signal: ctx.signal,
    });
  });

engine.register({
  scheduledActions: [notifyQuietClose({ channel: '#triage' })],
  rules: [issueClosedQuiet()],
  // ...
});
```

Compared to `aggregatedAction`:
- `aggregatedAction.transform` lives on the action (different actions on the same rule can want different projections of the same events).
- `scheduledAction` has no `.transform` — the rule's `.schedule({ transform })` is rule-level, since the check function consumes the same payload and the actions inherit it. One projection per rule.
- `scheduledAction` has no `.on(...)` either — it never sees the event, only the rule's payload.

**Register-time checks** ([ADR-002](002-dsl-design.md)):
- A `scheduledAction` may only attach to a rule with `.schedule(...)`.
- A rule with `.schedule(...)` must have at least one attached `scheduledAction`. (No bare schedules — there has to be a consumer for the `pass` outcome.)
- Plain `action` may *also* attach to a scheduled rule; it fires on `pass` and receives `ctx.scheduled.payload` (no `ctx.event`).
- A rule may not have both `.schedule(...)` and `.aggregate(...)` ([ADR-006](006-aggregation-windows.md)). The two are mutually exclusive: aggregation fires on a threshold of recent live events, scheduling fires on a deferred check at a future time. Combining them has no coherent semantics (whose lifecycle wins? does the schedule's `pass` retire the aggregation's window?), and the storage models (append-collection vs single-record-per-key) don't compose. Register-time rejection.

### `ScheduledStore` interface

Separate from `AggregationStore` ([ADR-006](006-aggregation-windows.md)) — the operations are too different to share one interface (atomic claim with lease, mutation/reschedule, delete-on-completion vs. append-only window queries). Same swap-out pattern: default in-memory, drop-in Redis or SQLite. A consumer can serve both stores from one backend with separate key schemas.

```ts
interface ScheduledStore {
  // Enqueue a deferred check. Replaces any existing record for (ruleId, keyId).
  enqueue(
    ruleId: string,
    keyId: string,
    runAt: number,             // ms since epoch
    payload: any,              // rule's .schedule.transform output
    scheduledAt: number,       // ms since epoch; recorded once, preserved across reschedules
    deadline?: number,         // ms since epoch absolute; engine resolves rule.deadline once on enqueue
  ): Promise<void>;

  // Atomically claim due records (runAt <= now). leaseMs gives the engine that many ms to
  // process before another worker may reclaim — only meaningful when multiple engine instances
  // share a backend. In-memory single-process passes leaseMs=0 / ignores.
  claim(now: number, limit: number, leaseMs: number): Promise<ScheduledCheck[]>;

  // Remove a record (pass or skip outcome).
  remove(ruleId: string, keyId: string): Promise<void>;

  // Update runAt for a record (recheck outcome). Engine validates against deadline before calling.
  reschedule(ruleId: string, keyId: string, newRunAt: number): Promise<void>;
}

interface ScheduledCheck {
  ruleId: string;
  keyId: string;
  runAt: number;
  scheduledAt: number;
  deadline?: number;
  payload: any;                // intentionally `any`, matching AggregationEntry.payload
}
```

Notes:

- **`enqueue` replaces.** If a duplicate `(ruleId, keyId)` arrives, the newer triggering event supersedes — common case is "user reopened then closed the issue again," and the later closure is the one we care about.
- **`payload: any`** matches the aggregation convention. The rule's `.transform` is the source of truth; the check function and `scheduledAction.fn` already know what to expect.
- **`leaseMs` is the engine's only nod to distributed deployment.** Single-process in-memory ignores it. Redis-backed implementations use `SET NX EX` or similar to fence claims; SQLite uses `UPDATE ... WHERE leased_until < ?`.
- **`deadline` is absolute and resolved once on enqueue.** The engine does the math at enqueue (`scheduledAt + deadline`) and stores it. On `reschedule`, if `newRunAt > deadline`, the engine substitutes a `remove(...)` and logs a `scheduled.deadline_exceeded` event ([ADR-011](011-observability.md)) — keeps the storage layer free of policy.

### Default in-memory implementation

`Map<ruleId, Map<keyId, ScheduledCheck>>` plus a min-heap over `runAt` for the claim ordering. `claim` walks the heap until `runAt > now` or `limit` is reached. `enqueue` replaces if exists. `remove` and `reschedule` are O(log n) on the heap. Ships with the library; consumers swap as needed.

### Scheduler

A background loop, driven inside the library, runs at most every **10 seconds** — the minimum cadence is a floor, not a default; consumers can configure longer intervals but not shorter. Rationale: reducing read load on external stores (Redis / SQLite) and matching the granularity that absence/scheduled rules actually need (5-minute windows tolerate 10s jitter — ~3.3% worst case — perfectly well).

Each tick:
1. `store.claim(now, batchSize, leaseMs)` returns due records.
2. For each, the engine builds the check `ctx` (`payload` from the record, `args` from the rule, `integrations`, `signal` for cancellation per [ADR-012](supervisor/012-supervisor-graceful-shutdown.md), `deliveryId` synthesized from the original enqueue, `scheduledAt` from the record) and `await rule.schedule.check(ctx)`.
3. Branch on the result:
   - `{ kind: 'pass' }` → fire every attached `scheduledAction` (and any plain `action`) with `ctx.scheduled = { payload, scheduledAt, ranAt: now, keyId }`; then `store.remove(...)`.
   - `{ kind: 'skip' }` → `store.remove(...)`. No action fires.
   - `{ kind: 'recheck', after }` → compute `newRunAt = now + parse(after)`; if `newRunAt > deadline`, treat as `skip`; otherwise `store.reschedule(...)`.

The scheduler runs inside the same supervisor as evaluation ([ADR-012](supervisor/012-supervisor-graceful-shutdown.md)) and respects graceful shutdown: tick stops accepting new claims, lets in-flight checks finish under the drain deadline, and yields.

### Evaluation lifecycle for scheduled rules

1. `.on(eventName)` candidate filter ([ADR-004](004-evaluation-model.md) Phase 1).
2. `.when(ctx)` returns `true`. (If false, no schedule.)
3. Engine resolves `key(ctx) → keyId`, `transform(ctx) → payload`, `delay → runAt = now + delay`, `deadline → now + deadline` (if set).
4. `store.enqueue(ruleId, keyId, runAt, payload, now, deadline)`.
5. Time passes. Scheduler tick claims, runs `check(ctx)`, branches.

### Example: recheck-until-ready

```ts
const checkReleaseArtifacts = rule('check-release-artifacts')
  .on('release.published')
  .when((ctx) => /^v\d+\.\d+\.\d+$/.test(ctx.event.release.tag_name))
  .schedule({
    delay: '30m',
    deadline: '24h',
    key: (ctx) => String(ctx.event.release.id),
    transform: (ctx) => ({
      releaseId: ctx.event.release.id,
      tag: ctx.event.release.tag_name,
      repo: ctx.event.repository.full_name,
    }),
    check: async (ctx) => {
      const status = await ctx.integrations.artifacts.status(ctx.payload.releaseId);
      if (status === 'complete') return { kind: 'pass' };
      if (status === 'failed') return { kind: 'skip' };
      return { kind: 'recheck', after: '30m' };
    },
  })
  .action('notify-release-ready');
```

Without a `deadline`, this would loop forever on a stuck release; with `deadline: '24h'`, the engine auto-skips after a day. The `check` function never has to know about the deadline — that policy lives in the engine.

## Alternatives considered

- **Block evaluation until the window passes.** Wedges a worker for minutes; unacceptable at any RPS.
- **In-memory min-heap with 1s ticks (the prior design).** What this ADR replaced. Loses state on every redeploy — silent under-fire of every absence/scheduled rule for the duration of the pending window. The 1s cadence also produces more wakeups than necessary; 10s is plenty for the windows these rules express (minutes to hours). The store interface makes Redis/SQLite a drop-in instead of a future migration.
- **Materialized per-rule state machines** (each rule maintains a state-per-key, transitions on events). Equivalent in expressiveness but harder to author and introspect than scheduled callbacks. Also forces every rule with deferred semantics to carry its own state.
- **Push absence semantics into the action layer.** Action receives the event, `await sleep`, decides. Wedges workers and leaks rule semantics into integration code; rule authors lose visibility into pending state.
- **Reuse `AggregationStore` for scheduled records.** Tempting (same pattern, same swap-out story), but the operations don't fit: scheduled records need atomic claim with lease, in-place reschedule, and explicit delete-on-completion — none of which AggregationStore exposes. Forcing them in would require sentinel actionIds and conventions like "count == 1 means scheduled," which obscure both models. Sibling interface is cleaner; a consumer can still back both from one Redis instance with separate key schemas.
- **Tick at 1s (or 100ms) instead of 10s.** Lower jitter but heavier read pressure on external stores; not justified by use cases (the shortest realistic absence/scheduled window is 1–5 minutes, where 10s jitter is <3.5%).
- **Per-action `transform` and `check` on `scheduledAction` (symmetric with `aggregatedAction`).** Considered. Each attached action would have its own independent scheduled job. Rejected because (a) the check is logically rule-level — "should this rule's deferred decision fire" — not per-consumer; (b) it would multiply storage writes for typical "one schedule, one consumer" rules; (c) the user-facing model is simpler with one schedule per rule. The asymmetry with `aggregatedAction` is intentional and reflects a real semantic difference: aggregations naturally fan out to multiple consumers with different projections; scheduled decisions are gated by a single check.
- **Block plain `action` from attaching to scheduled rules.** Considered for tidiness, but rejected because a plain action whose `.fn` body doesn't reference `ctx.event` works fine on a scheduled rule (it just sees `ctx.scheduled.payload`). The cost of letting both attach is small and the flexibility is real.

## Consequences

**Positive:**
- Scheduled / absence semantics are first-class in the DSL — `.schedule({ delay, transform, check })` covers absence, polling, deadline-based skips, and arbitrary deferred decisions.
- Pending decisions survive redeploys when the consumer plugs in a persistent `ScheduledStore` (Redis or SQLite). The library still ships an in-memory default for the prototype.
- The check function's three outcomes (pass/skip/recheck) map directly to the three storage operations (remove/remove/reschedule) — no hidden state.
- Polling is bounded at 10s minimum: low read load on external stores, plenty of resolution for the window sizes these rules need.
- Scheduled decisions are introspectable: a consumer can dump the `ScheduledStore` to see what's pending and when it will fire.
- One storage backend (Redis, SQLite) can serve both `AggregationStore` and `ScheduledStore` with separate key schemas — a single piece of operational infrastructure handles both.

**Negative:**
- 10s minimum cadence means up to ~10s jitter on every fire. Acceptable for the use cases (5-min absence windows, 30-min polls, hour-plus deadlines); not appropriate for sub-second deferred decisions (which we don't support).
- `payload: any` again means no static typing inside `check.fn` or `scheduledAction.fn`. Authors who wrote `transform` know its shape; cost is small.
- Default in-memory `ScheduledStore` still loses state on restart. The interface enables persistent backends; the prototype doesn't ship one.
- Adds a third action kind (`scheduledAction`) to the DSL surface. Three action types is the ceiling we should hold at — any future deferred-evaluation pattern should layer on top of `.schedule(...)` rather than introducing a fourth.
- `appendAndCount`-style atomicity isn't applicable here, but **`claim` must be atomic with leasing** to be safe in multi-process deployments. The in-memory default ignores `leaseMs`; backends that span processes must honor it.
- ADR-002 needs extension to introduce `aggregatedAction` (flagged in [ADR-006](006-aggregation-windows.md)) and now `scheduledAction`, plus the corresponding `register({ aggregatedActions: [...], scheduledActions: [...] })` keys. Tracked as a follow-up sweep.
