# ADR-015: Clock — injectable time source, default real, primary purpose is testability

**Status:** Accepted
**Date:** 2026-06-04

## Context

Three engine subsystems are time-sensitive:

- **Aggregation** ([ADR-006](006-aggregation-windows.md)) prunes window entries older than `now − window`.
- **Scheduled rules** ([ADR-007](007-temporal-absence-rules.md)) compare `runAt` to `now` to decide whether a check is due, and add `delay` to `now` when enqueueing.
- **Integration adapters** ([ADR-005](005-external-integration-resilience.md)) expire TTL-cache entries against a wall-clock timestamp.

If every call site reads `Date.now()` (or `setTimeout` / `setInterval` directly), tests have no way to drive these subsystems deterministically. Faking time across an asynchronous engine then becomes a library-of-tricks problem (`sinon.useFakeTimers`, `@sinonjs/fake-timers`, monkey-patched globals) — each fragile and noisy.

The fix is the standard one: route time through an injectable interface, default to a real-wall-clock implementation, document that the seam exists primarily so tests can pin time.

## Decision

**The engine accepts an optional `clock` in `EngineOptions` ([ADR-014](014-engine-api-surface.md)) and threads it to every subsystem that asks "what time is it" or "wake me up later".**

### Interface

```ts
interface Clock {
  now(): number;                                                    // ms since epoch
  setTimeout(cb: () => void, delayMs: number): { cancel(): void };
}
```

Two methods, no Date object — `now()` returns a number, which is what the time-comparison code paths actually need, and `setTimeout` returns a cancellable handle rather than a Node `Timeout` so the fake implementation does not have to mimic Node's timer surface.

Engine code never calls `Date.now()`, `setTimeout`, or `setInterval` directly. It calls `this.clock.now()` and `this.clock.setTimeout(...)`. This is enforced by a lint rule in the engine package.

### Default implementation

The engine ships a `SystemClock`:

```ts
const SystemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => {
    const t = setTimeout(cb, ms);
    return { cancel: () => clearTimeout(t) };
  },
};
```

This is installed when `EngineOptions.clock` is omitted. A consumer who never thinks about time gets a working engine.

### Test implementations

The public type surface defines a `ManualClock` shape for tests and other deterministic callers:

```ts
interface ManualClock extends Clock {
  set(timeMs: number): void;
  advance(deltaMs: number): void;                                   // fires due timers in order
}
```

The engine's own `createManualClock(...)` implementation lives in `src/__tests__` and is not exported from the runtime package. Consumers can provide their own implementation through `EngineOptions.clock`; `advance(ms)` should walk pending `setTimeout` callbacks in `runAt` order, firing each whose deadline now lies in the past before advancing the cursor. Callbacks scheduled during a firing callback should be inserted into the same advance pass. This is the conventional fake-clock contract.

### What goes through the Clock

- `AggregationStore` pruning: `now()` is compared to each entry's `at`.
- `ScheduledStore` polling: the engine's scheduler reads `now()` on each tick to decide which `runAt`s have come due.
- `ScheduledStore.enqueue`: `runAt = now() + delay`, set by the engine on the rule's behalf.
- `IntegrationAdapter` TTL cache: entry expiry compared to `now()`.
- `ctx.now` on predicate / action contexts: frozen at evaluation start (per [ADR-004](004-evaluation-model.md)), pulled from `clock.now()`. This is what keeps "current time" consistent within one evaluation.

### What does *not* go through the Clock

- Per-evaluation deadline ([ADR-014](014-engine-api-surface.md)): driven by an `AbortSignal` plumbed through `ctx.signal`. The underlying `setTimeout` for the deadline timer **does** use `clock.setTimeout` so that tests pinning time also pin the deadline.
- Real-time durations measured for metrics (`elapsedMs` on emitter events, [ADR-011](011-observability.md)): use `clock.now()` for the start/end boundaries so a fake clock produces deterministic histograms in tests.
- Logger timestamps: belong to the consumer's logger ([ADR-011](011-observability.md)); the engine does not insert its own.

## Alternatives considered

- **Hard-code `Date.now()` and `setTimeout` everywhere.** Forces tests to patch globals or use `useFakeTimers` — fragile across module boundaries, leaks into other test files. Rejected.
- **Pass a tracer / scheduler abstraction broader than time.** Tempting — would unify the poll loop, the deadline watchdog, and the timer queue under one interface. Overshoots: the poll loop has a different shape (long-lived, cadence-driven) than a one-shot deadline timer, and conflating them adds vocabulary without saving code. The `Clock` here is narrow on purpose.
- **`Date` object on the interface** (`now(): Date`). Every call site already coerces to a number for arithmetic and comparison. Returning `number` removes a coercion and matches what `Date.now()` returns.
- **AsyncLocalStorage-bound clock.** Avoids threading `this.clock` through every call site, but introduces a hidden context the engine otherwise does not need. Explicit injection is simpler and the engine has few enough timestamp-readers that the threading is unobtrusive.
- **Lift the clock entirely outside the engine and pass timestamps in on every call.** Works for `now()` but does not solve `setTimeout` — the scheduled-store poll loop and deadline watchdog need to *schedule* future work, which the caller cannot do on the engine's behalf. The Clock interface covers both shapes.

## Consequences

**Positive:**
- Aggregation, scheduling, and TTL caches are deterministically testable without global timer mocking. A test can `clock.advance(1h + 1ms)` and assert that the window pruned exactly the entries it should.
- Engine code never reaches for the global `Date` or `setTimeout` — the seam is single and obvious. Reviewing time-sensitive code is reading one method-call pattern.
- The default `SystemClock` means every non-test consumer is unaffected by the abstraction. Construction stays one line.

**Negative:**
- One more option on `EngineOptions`, one more method to remember when the engine grows. Acceptable given how often time appears in this engine's semantics.
- `ManualClock.advance` is conventional but subtle — callbacks scheduled during firing need correct ordering. The engine keeps its own test-only implementation and test suite to keep the contract honest without exporting that helper as runtime API.
- Mixing `clock.setTimeout` with `Promise`-based async means `await` boundaries do not magically yield to a fake clock; tests still need to `await` between `advance(...)` calls to let scheduled callbacks run. Documented in the engine test guide.
- The lint rule (no direct `Date.now()` / `setTimeout` in engine code) is one more thing to maintain. Trivial; far cheaper than the bugs it prevents.
