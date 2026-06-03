# ADR-014: Engine API surface — constructor, evaluate contract, action execution

**Status:** Accepted
**Date:** 2026-06-04

## Context

ADRs 002–008 and 011 cover the conceptual surface of the engine (DSL, evaluation model, integrations, aggregation, scheduling, state, observability). They do not pin three contracts that the very first line of consumer code will exercise:

1. The **constructor** — what options the consumer passes, what defaults they get.
2. The **return shape of `evaluate(event)`** — what the Promise resolves with, and which failures surface as rejections.
3. The **execution semantics of actions** — order, parallelism, and failure isolation across actions that matched the same event.

The previous home for the first item was [supervisor/ADR-013](supervisor/013-library-demo-separation.md), which sketched a `RuleEngine` class signature when the engine and the demo server were not yet separated. That sketch is now stale and lives in the supervisor subdirectory. The engine itself needs an authoritative ADR.

## Decision

### Engine construction

```ts
import type { Logger } from 'pino';
import type { WebhookEventName } from '@octokit/webhooks-types';

interface EngineOptions {
  // Pluggable rule state — all optional, in-memory defaults shipped (see ADR-008).
  aggregationStore?: AggregationStore;
  scheduledStore?: ScheduledStore;

  // Time source — optional, default real wall-clock (see ADR-015).
  clock?: Clock;

  // Observability — optional, no-op default (see ADR-011).
  logger?: Logger;

  // Cancellation budgets — optional, sensible defaults.
  evaluationTimeoutMs?: number;   // default 15_000
  scheduledPollMs?: number;       // default 10_000, minimum 10_000 — see ADR-007

  // Aggregated/scheduled stores need a poll cadence — see ADR-007.
}

class RuleEngine {
  constructor(opts?: EngineOptions);

  register(batch: {
    predicates?: RegisteredPredicate[];
    actions?: RegisteredAction[];
    aggregatedActions?: RegisteredAggregatedAction[];
    scheduledActions?: RegisteredScheduledAction[];
    integrations?: RegisteredIntegration[];
    rules: RegisteredRule[];
  }): void;                       // throws on validation failure — see ADR-016

  evaluate(
    event: WebhookEvent,
    opts?: { deliveryId?: string; installation?: { id: number }; signal?: AbortSignal },
  ): Promise<void>;               // see "evaluate contract" below

  on(eventName: EngineEventName, cb: (e: EngineEvent) => void): void;  // ADR-011
  off(eventName: EngineEventName, cb: (e: EngineEvent) => void): void;

  start(): void;                  // begin the scheduled-store poll loop
  stop(): Promise<void>;          // cancel in-flight evaluations + stop poller
}
```

All options are optional. The defaults add up to a runnable engine: pass rules and integrations, call `evaluate(event)`, get void back. No external infrastructure required for a working dev / demo deployment.

`start()` / `stop()` exist for the scheduled-store poll loop ([ADR-007](007-temporal-absence-rules.md)) and the in-flight evaluation cancellation budget. A consumer that does not use `.schedule(...)` rules never needs to call `start()` — `evaluate(event)` works on its own.

### `evaluate(event)` return contract

`evaluate(event)` returns `Promise<void>`. It does **not** resolve with matched rule IDs, an explain tree, or per-action outcomes — those flow through the metrics emitter ([ADR-011](011-observability.md)). The Promise is a binary signal: either every effect the engine intended to run for this event ran to completion (or was cleanly skipped), or something went wrong that the caller needs to know about.

**Resolves (`Promise<void>`) when:**

- No rule matched (Phase 1 dispatch was empty, or every candidate's `.when` returned `false`).
- One or more rules matched, all their actions were invoked, and every action returned without throwing.
- An aggregated rule matched but its threshold has not yet been met — the entry was appended to the `AggregationStore`, no action ran, the call resolves.
- A scheduled rule matched and the deferred check was enqueued — the entry was written to the `ScheduledStore`, no action ran, the call resolves.

**Rejects when:**

- Any action thrown / rejected — including aggregated and scheduled actions invoked synchronously during this `evaluate()` call. Note that scheduled actions invoked *later* (when the poller fires) reject the poller's internal evaluation, not the original `evaluate()` — the original call already resolved when the entry was enqueued.
- An engine-internal failure (store I/O error, integration adapter throwing outside the predicate path, the evaluator itself crashing).
- The per-evaluation timeout fires before all actions complete.

**Does not reject for:**

- Predicate errors. These follow [ADR-004](004-evaluation-model.md)'s protection contract: the leaf returns `false`, the error is logged with `deliveryId` and `predicateName`, evaluation continues. A misbehaving predicate cannot reject `evaluate()`.

Rationale: the caller (a webhook receiver) only has two questions to ask after a delivery — "did my downstream effects run?" and "do I need to retry?". A void/throw split answers both. Predicate failures are observability concerns ([ADR-011](011-observability.md)) and a rule that depends on a flaky predicate naturally evaluates to `false`; surfacing those as caller-visible rejections would force the caller to retry events that *correctly* did not match.

### Action execution

When multiple actions are reachable from a single event (one rule with several `.action(...)` calls, or several rules matching the same event), the engine runs them **in parallel** and **error-isolated**:

- Each action's `.fn(ctx)` is invoked in its own micro-task; the engine does not await one action before starting the next.
- One action throwing does not cancel or short-circuit the others. The engine awaits all of them via `Promise.allSettled`.
- If any action rejected, `evaluate()` rejects after all actions have settled. The rejection's `error` carries the first failure; a `errors` field on the same error object lists every failure when more than one action threw (an `AggregateError` when the runtime supports it).
- Each action's `ctx.signal` is the same `AbortSignal` as the evaluation's overall signal. One action's failure does not abort sibling actions — they share a deadline (the per-evaluation watchdog), not a cancellation channel.

Rationale: actions are independent side effects (post to Slack, open a Linear ticket, call a webhook). Failing one Slack call should not silently swallow the Linear ticket. Running them in parallel is the right default for "post-match side effects" — they have no dependency on each other, and the evaluation has already paid the latency for the `.when` tree.

The contract is symmetric across action kinds — plain `action`, `aggregatedAction` invoked synchronously when the threshold is met, and `scheduledAction` invoked synchronously during the evaluate that enqueues it (the no-op case) all follow the same parallel-isolated rule. Scheduled actions invoked *later* by the poller run under that poll cycle's contract, which is the same rule applied to one event (the deferred decision).

## Alternatives considered

- **`evaluate()` returns `Promise<EvaluationResult>`** with matched rule IDs, action outcomes, explain tree. Considered. Pushes the engine toward shipping a result object whose shape is hard to evolve without breaking consumers, and the same information is already on the metrics emitter ([ADR-011](011-observability.md)) where it does not constrain the call signature. Consumers who need an explain trace will get an opt-in `explain` builder later — pluggable into the emitter, not the return type.
- **Sequential action execution.** Simpler, but the wrong default: actions are inherently independent side effects, and one slow Slack call would block an unrelated Linear ticket. Parallel-isolated is the natural shape and the engine already pays the latency budget.
- **Fail-fast action execution** (cancel siblings on first throw). Rejected for the same reason as sequential — siblings are independent effects, not steps in a transaction. A failed action does not invalidate the others; it just needs to be visible to the caller.
- **Predicate errors surface as `evaluate()` rejections.** Considered. Would push observability into the caller's control flow ("does my retry path treat a flaky predicate the same as a successful no-match?"). Rejected — the existing ADR-004 contract (leaf returns false, error logged) is the right shape for the caller, and the metrics emitter still surfaces the failure for the operator.
- **Engine owns `start()` automatically on construction.** Would start a poll loop the consumer never wired up. Explicit `start()` keeps the construction step inert and side-effect-free.

## Consequences

**Positive:**
- One-call surface for the common case: `new RuleEngine(); engine.register({...}); engine.evaluate(event)` works, no other wiring required.
- The void/throw contract on `evaluate()` is the same shape webhook receivers already use to drive ack/retry — engine integration is a one-liner on the caller side.
- Parallel-isolated actions match how callers think about side effects ("each notification is independent") and remove a class of confusing failures where one bad action hides another's success.
- The constructor is small and grows on the additive axis (more optional pluggable parts), not by widening the call signature.

**Negative:**
- Consumers who want per-action outcome reporting must wire the metrics emitter; the return type alone won't tell them which actions ran. Mitigation: documented; the emitter already carries everything ([ADR-011](011-observability.md)).
- `Promise.allSettled` over actions means a single slow action delays the overall `evaluate()` resolution by its full duration — there is no fail-fast lever. The per-evaluation timeout is the backstop; tightening per-action latency is a deployment-side concern.
- The `AggregateError` shape on multi-action failure is awkward to introspect compared to a richer `EvaluationResult`. Consumers who care about granular per-action attribution use the emitter; the rejection is for "did anything go wrong" decisions.
- `start()` / `stop()` add lifecycle to an otherwise stateless-looking API. Mitigation: only needed for `.schedule(...)` rules, called once per process by the embedder.
