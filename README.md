# Air Automation Rule Engine Prototype

## Design Decisions

Important choices are recorded as ADRs, with context, alternatives, consequences, and tradeoffs. The main entry point is [`adr/README.md`](adr/README.md).

- Language/runtime: [`ADR-001`](adr/001-language-and-runtime.md).
- DSL shape and code-as-config approach: [`ADR-002`](adr/002-dsl-design.md).
- Evaluation model: [`ADR-004`](adr/004-evaluation-model.md).
- External integration resilience: [`ADR-005`](adr/005-external-integration-resilience.md).
- Aggregation windows: [`ADR-006`](adr/006-aggregation-windows.md).
- Scheduled/absence rules: [`ADR-007`](adr/007-temporal-absence-rules.md).
- Store boundaries and retry ownership: [`ADR-008`](adr/008-in-memory-state-caller-retry.md).
- Observability: [`ADR-011`](adr/011-observability.md).
- Engine API surface: [`ADR-014`](adr/014-engine-api-surface.md).
- Injectable clock: [`ADR-015`](adr/015-clock.md).
- Registration validation: [`ADR-016`](adr/016-register-phase.md).
- Demo/server decisions: [`adr/supervisor/`](adr/supervisor/).

This is a TypeScript prototype for the Air Automation interview task in [`task.md`](task.md): evaluate GitHub webhook events against user-defined rules, support composable conditions, allow slow external lookups, and handle rules that depend on event history or delayed checks.

The repository is split into a reusable engine package and a small demo server:

- [`engine/`](engine/) contains `@air/engine`, the rule DSL and evaluation runtime.
- [`demo/`](demo/) contains a Fastify GitHub webhook ingress that wires real HTTP requests into the engine.
- [`adr/`](adr/) contains the design decisions and tradeoffs. Start with [`adr/README.md`](adr/README.md); the README intentionally does not repeat those details.

## What Is In The Engine Core

`@air/engine` is the primary deliverable. It includes:

- A code-as-config TypeScript DSL: `rule`, `predicate`, `action`, `aggregatedAction`, `scheduledAction`, `integration`, `all`, `any`, `not`, and `use`.
- GitHub webhook event typing through `@octokit/webhooks-types`, with `.on(...)` narrowing rule context by event name and action.
- Batch registration with dependency/schema validation and aggregated registration errors.
- Async rule evaluation with dispatch by event, condition composition, predicate isolation, per-event predicate memoization, action execution, and typed engine events.
- External integration adapters with timeout/cancellation support plus cache, concurrency limiting, circuit breaker, retry, and `external.call` instrumentation.
- Aggregation windows through a pluggable `AggregationStore` for rules like "3 failures on the same PR within 1 hour".
- Scheduled/absence rules through a pluggable `ScheduledStore` for delayed checks like "closed and not reopened after 5 minutes".
- Injectable clock, logger, in-memory stores, and tests for unit, integration, smoke, and task-example acceptance coverage.

The task examples are covered in [`engine/src/__tests__/acceptance/task-examples.test.ts`](engine/src/__tests__/acceptance/task-examples.test.ts).

## What Is Left To The Demo

The demo is intentionally outside the engine boundary. It shows how an application can host the engine, but it is not the reusable library API.

The demo includes:

- `POST /github/webhook` with GitHub headers, event/action mapping, JSON parsing, and optional `X-Hub-Signature-256` verification.
- A few concrete demo rules and notification actions in [`demo/src/rules.ts`](demo/src/rules.ts).
- In-memory notification storage by default.
- Optional PostgreSQL-backed notification, aggregation, and scheduled stores when `DATABASE_URL` is set.
- `GET /demo/notifications`, `GET /demo/dashboard`, and `GET /demo/dashboard/data` for observing demo behavior.
- Docker/Compose wiring for running the app with PostgreSQL locally.

Production ingress concerns such as durable queues, webhook delivery deduplication, retry/dead-letter handling, telemetry export, auth for dashboard endpoints, and production deployment supervision are intentionally not promoted into the engine. The relevant demo/supervisor decisions are linked from [`adr/README.md`](adr/README.md).

## Run The Engine

```sh
cd engine
npm install
npm test
npm run build
```

`npm test` runs TypeScript typechecking and the full Vitest suite.

## Run The Demo

```sh
cd demo
npm install
npm test
GITHUB_WEBHOOK_SECRET=dev-secret npm run dev
```

Then send signed GitHub-style webhooks to `POST http://localhost:3300/github/webhook` and inspect results at `GET http://localhost:3300/demo/notifications` or `GET http://localhost:3300/demo/dashboard`.

To run the demo with PostgreSQL from the repository root:

```sh
docker compose up --build
```

Compose exposes the demo app on `http://localhost:3300` and PostgreSQL on `localhost:15432`.

## Review Guide

- For the assignment requirements, read [`task.md`](task.md).
- For the engine API and implementation, start in [`engine/src/index.ts`](engine/src/index.ts), [`engine/src/public/`](engine/src/public/), and [`engine/src/engine/`](engine/src/engine/).
- For the task examples as executable specs, read [`engine/src/__tests__/acceptance/task-examples.test.ts`](engine/src/__tests__/acceptance/task-examples.test.ts).
- For the demo boundary and HTTP wrapper, read [`demo/README.md`](demo/README.md), [`demo/src/server.ts`](demo/src/server.ts), and [`demo/src/rules.ts`](demo/src/rules.ts).
- For all important decisions and tradeoffs, read [`adr/README.md`](adr/README.md) and the ADRs it links.
