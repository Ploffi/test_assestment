# Air Automation Rule Engine Prototype

This repository contains a TypeScript rule engine for filtering GitHub webhook events through code-as-config rules. The implementation lives in `interfaces/`; the ADRs in `adr/` document the design decisions and tradeoffs.

## Run It

```sh
cd interfaces
npm test
npm run build
```

`npm test` runs `tsc --noEmit` and the Vitest suite. `npm run build` emits the package entry under `interfaces/dist/`.

## DSL Shape

Rules are TypeScript values built with fluent builders:

```ts
const infraPrFromOutsider = rule('infra-pr-from-outsider')
  .on('pull_request.opened')
  .when(
    all(
      (ctx) => ctx.event.pull_request.base.ref === 'main',
      not(use('is_team_member', {
        team: 'core',
        login: (ctx) => ctx.event.pull_request.user.login,
      })),
      use('touches_paths', { glob: 'infra/**' }),
    ),
  )
  .action('notify-slack');
```

The `.on(...)` step narrows `ctx.event` using `@octokit/webhooks-types`. Boolean composition uses `all`, `any`, and `not`. Reusable predicates are referenced by name with `use(name, args)` and resolved during `engine.register(...)`.

## Evaluation Model

The engine evaluates in two phases:

1. Dispatch by event name/action, so unrelated rules do no work.
2. Evaluate each matching rule's condition tree asynchronously with sequential short-circuiting.

Predicate calls are memoized per event by `(predicateName, canonicalMergedArgs)`. Predicate errors and invalid dynamic predicate args isolate to `false` by default; `failOpen: true` makes them isolate to `true`. Action errors reject `evaluate()` after all sibling actions have settled.

`ctx.now` is frozen at evaluation start, and the engine uses the injected `Clock` for timeouts and scheduled polling.

## External Integrations

Integrations are registered once and exposed at `ctx.integrations.<name>.<method>()`. The adapter layers are:

1. TTL/LRU cache, keyed by input minus `signal`.
2. Per-integration concurrency limit.
3. Circuit breaker with half-open reset.
4. Bounded retry with exponential backoff.
5. Underlying method call.

Engine events include `external.call` so consumers can aggregate latency, cache hits, and breaker state without the library depending on a telemetry SDK.

## Aggregation And Scheduling

Aggregation is declared on rules with `.aggregate({ window, count, key, at? })` and consumed by `aggregatedAction(...)`. The store is keyed by `(ruleId, actionId, keyId)` and stores projected entries, not full webhook payloads.

Scheduled/absence rules use `.schedule({ delay, deadline?, key, transform, check })` and `scheduledAction(...)`. The engine enqueues a projected payload, polls a `ScheduledStore` at a 10s minimum cadence, and branches on `pass`, `skip`, or `recheck`.

Both stores are pluggable. The included in-memory implementations are for development, demos, and tests only.

## Tradeoffs

The prototype chooses TypeScript code-as-config rather than YAML/JSON, so rule authors get compile-time GitHub payload typing and IDE autocomplete. The cost is that rule changes require a TypeScript build. Persistent stores, webhook ingress, queueing, and telemetry backends are intentionally outside this package boundary.
