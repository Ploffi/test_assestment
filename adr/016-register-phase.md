# ADR-016: Register phase — canonical entity signatures and aggregated error shape

**Status:** Accepted
**Date:** 2026-06-04

## Context

[ADR-002](002-dsl-design.md) introduces a unified builder shape — `entity(name).args(...).<config>...` — and says `register()` runs two validation passes synchronously: a dependency-graph check and a registration-args schema check. Both passes aggregate errors and throw a single composite error.

What [ADR-002](002-dsl-design.md) does *not* pin:

- The exact `ctx` shape that arrives at each entity's `.fn(ctx)` — particularly how `.on(eventName)` narrows `ctx.event` for actions versus predicates, and what extra fields appear on aggregated / scheduled action contexts.
- The aggregated-error type thrown by `register()`. Consumers will want to inspect it programmatically (locate the offending entity, surface failures in their build) — an untyped `Error` with a multi-line message is not enough.

This ADR pins both. It is the contract the implementation owes the consumer at registration time.

## Decision

### Canonical `.fn` signatures

All entity kinds share a base context — `event`, `args`, `signal`, `deliveryId`, `installation`, `repo`, `now`, `logger`, `integrations` ([ADR-002](002-dsl-design.md), [ADR-011](011-observability.md), [ADR-015](015-clock.md)) — and then add fields specific to the kind.

```ts
// Shared base — every entity's ctx extends this.
interface BaseCtx<Event extends WebhookEvent, Args> {
  event: Event;                      // narrowed by the entity's .on(eventName) when present
  args: Args;                        // merged + Zod-validated args (registration > use-site)
  signal: AbortSignal;               // per-evaluation cancellation
  deliveryId: string;                // X-GitHub-Delivery
  installation?: { id: number };     // from payload, optional (some events have no installation)
  repo?: { id: number; fullName: string };
  now: number;                       // frozen at evaluation start; clock.now() at start time
  logger: Logger;                    // Pino-compatible, bound to (deliveryId, ruleId, entityName)
  integrations: Record<string, IntegrationAdapter>;
}

// --- predicate ---
predicate(name)
  .args(schema)
  .fn((ctx: BaseCtx<E, Args>) => boolean | Promise<boolean>);
// E is the union of all webhook events; predicates are not pinned to a single .on(),
// so authors narrow inside .fn via discriminator checks if they need a specific shape.

// --- action (plain) ---
action(name)
  .args(schema)
  .fn((ctx: BaseCtx<E, Args>) => void | Promise<void>);
// E narrowed by the parent rule's .on(eventName) when ctx is constructed at evaluate time.

// --- aggregatedAction ---
aggregatedAction(name)
  .on(eventName)                     // pins E to the matching WebhookEventName variant
  .args(schema)
  .transform((ctx: BaseCtx<E, Args>) => Payload)
  .fn((ctx: BaseCtx<E, Args> & {
    aggregate: {
      entries: ReadonlyArray<{ at: number; deliveryId: string; payload: Payload }>;
      count: number;
      windowMs: number;
      keyId: string;
    };
  }) => void | Promise<void>);
// Payload is the return type of .transform; .fn sees the stored window via ctx.aggregate.

// --- scheduledAction ---
scheduledAction(name)
  .args(schema)
  .fn((ctx: Omit<BaseCtx<E, Args>, 'event'> & {
    scheduled: {
      payload: unknown;              // type carried by the rule's .schedule({ transform }) — see ADR-007
      keyId: string;
      scheduledAt: number;           // when the rule enqueued this check
      ranAt: number;                 // when the scheduler fired the check
    };
  }) => void | Promise<void>);
// scheduledAction has no .on() of its own — the rule's .on() pinned E when the entry was enqueued.
// .transform lives on the rule's .schedule(...), not on the action — see ADR-007.
```

A few invariants:

- **Predicates return boolean.** A `Promise<boolean>` is fine. Any throw is captured by the engine's error isolation ([ADR-004](004-evaluation-model.md)) and turns into a `false` leaf.
- **All actions return `void`.** They are side effects; their value is not consumed. A throw rejects `evaluate()` (with sibling action results aggregated, [ADR-014](014-engine-api-surface.md)).
- **`ctx.signal` is the same `AbortSignal` for every entity inside one evaluation.** Predicates and actions that perform async I/O are expected to thread it into `fetch` / integration calls.
- **`ctx.now` is frozen at evaluation start.** Read it instead of `Date.now()` so two predicates in the same evaluation that ask "current time" get the same answer.

### `register()` aggregated error shape

`register()` validates the full batch synchronously and throws on the first failed pass. The thrown value is a structured `RegistrationError`, never a bare `Error`:

```ts
type IssueCode =
  // dependency-graph (pass 1)
  | 'unknown-predicate'              // use(name, ...) → predicate not registered
  | 'unknown-action'                 // .action(name, ...) → action of any kind not registered
  | 'on-mismatch'                    // aggregatedAction .on() ≠ rule .on()
  | 'kind-mismatch'                  // action kind incompatible with rule's aggregate/schedule
  | 'missing-aggregated-action'      // rule has .aggregate(...) but no aggregatedAction attached
  | 'missing-scheduled-action'       // rule has .schedule(...) but no scheduledAction attached
  | 'aggregate-and-schedule'         // rule has both .aggregate(...) and .schedule(...)
  | 'duplicate-name'                 // re-register of the same name within one batch (not across batches)
  // schema (pass 2)
  | 'invalid-args';                  // Zod failure on registration args

interface RegistrationIssue {
  code: IssueCode;
  entity: {
    kind: 'predicate' | 'action' | 'aggregatedAction' | 'scheduledAction' | 'rule' | 'integration';
    name: string;
  };
  path?: ReadonlyArray<string | number>;   // for 'invalid-args' — Zod path inside args object
  message: string;                         // human-readable; suitable for build logs
  related?: { kind: string; name: string }; // for 'on-mismatch' / 'kind-mismatch', the counterpart entity
}

class RegistrationError extends Error {
  readonly issues: ReadonlyArray<RegistrationIssue>;
  constructor(issues: RegistrationIssue[]) {
    super(`engine.register() failed with ${issues.length} issue(s): ` +
          issues.map(i => `[${i.code}] ${i.entity.kind} ${i.entity.name}: ${i.message}`).join('; '));
    this.issues = issues;
  }
}
```

Two contract points:

- **Both passes run.** Pass 1 (dependency graph) and pass 2 (schema) both execute over the full batch before throwing. The thrown `RegistrationError.issues` contains issues from both passes mixed — a consumer's build log surfaces every problem at once instead of "fix one, re-run, find the next." Fail fast on the *call*, not on the first issue.
- **Issue order is stable** so test snapshots are usable: pass 1 issues in entity-registration order, pass 2 issues in entity-registration order, with kind-tie-broken by name. The implementation freezes a sorted view before constructing the error.

What is *not* validated at register time:

- Use-site args supplied via `(ctx) => value` callbacks. These resolve per event, are merged with registration args, and the merged object is re-validated at evaluate time ([ADR-004](004-evaluation-model.md)).
- Action `.fn` behavior. `register()` cannot test that an action does what its name suggests; that is a unit-test concern, not a registration concern.
- `IntegrationAdapter` reachability. The engine does not call `integrations.health()` at register time; a misconfigured adapter is a runtime failure surfaced through the breaker.

### What "register phase" means as a lifecycle step

`register()` is the single transition from "builders are inert TypeScript values" to "the engine is ready to evaluate." Before `register()` the engine refuses `evaluate()` (throws `EngineNotReadyError`). After `register()` the registry is immutable for the lifetime of the engine — re-registering replaces the previous batch wholesale; partial mutation is not supported.

This makes the engine's mental model two-phase:
1. **Build phase** (TypeScript code) — declare entities, compose rules.
2. **Run phase** (after `register()`) — evaluate events.

Hot-swap of rules requires a fresh `register()` call. Two-phase commit is not provided; if the new batch's `register()` throws, the previous batch is preserved (the engine never enters a half-updated state).

## Alternatives considered

- **`RegistrationError` as a string-only message.** Forces consumers to grep build logs. Rejected — the registry validation is the engine's single chance to give a tooling-friendly error and we should take it.
- **Throw on the first issue (fail-fast).** Faster code path but worse author experience: a single rule file with three typos requires three runs. The two-pass model already collects everything; we surface everything.
- **Run validation asynchronously, return a `Promise<Result<Engine, RegistrationError>>`.** The user explicitly chose synchronous in [ADR-002](002-dsl-design.md). Synchronous keeps the failure trivially observable at the call site and the registry has no I/O.
- **Allow incremental registration (`engine.add(predicate)`).** Forces the dependency-graph pass to re-run on every add, or run on first `evaluate()`. Worse failure timing. Rejected — `register()` takes a complete batch; consumers compose the batch in TypeScript first.
- **Type `ctx.scheduled.payload` on `scheduledAction.fn` via the rule's `.schedule({ transform })` return type.** Would be type-safe but couples two entities through the registry types. Currently typed as `unknown`; consumers cast inside `.fn` if they want. A future ADR can tighten this once the engine has shipped and consumers have a concrete use case for the stricter type.
- **Surface `RegistrationError` issues as compiler diagnostics via a build plugin.** Out of scope. The error already carries enough structure for a build plugin to render diagnostics if a consumer wants one.

## Consequences

**Positive:**
- Every entity's `.fn` signature is pinned in one place — implementing the engine and writing rules both reference this ADR for "what arrives on ctx."
- `register()` failures are programmatically inspectable. A consumer's build pipeline can read `err.issues`, group by `entity.kind`, and emit per-file diagnostics.
- Two-pass + aggregated error means a noisy refactor surfaces every break in one shot instead of slow drip-feed.
- Build-phase / run-phase split is unambiguous: builders are TypeScript values, registration is the synchronous gate, evaluation is what runs after.

**Negative:**
- `RegistrationIssue.path` for invalid-args mirrors Zod's path shape; if we ever change the args validator we have to map paths to the same shape. Acceptable; Zod is the chosen validator.
- `scheduledAction.fn`'s `ctx.scheduled.payload: unknown` is weaker typing than the rest of the surface; tightened in a later ADR if usage patterns make a stronger contract cheap.
- A consumer who only wants a quick try-out has to construct a complete batch and call `register()` before any `evaluate()` works. The friction is one line; the win is "either the engine is ready or it tells you exactly what's wrong."
- Re-registration is whole-batch replacement, not patch. A consumer hot-reloading rules pays full revalidation. Acceptable for the rule-engine use case; rules change far less often than events fire.
