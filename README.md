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

## Production System Follow-Ups

If this prototype moved toward production, I would keep the engine as a small embeddable library and harden the application that hosts it. The first production iteration would focus on operational correctness, visibility, and recoverability rather than adding more DSL features.

### Engine Built-In Improvements

- [High] Built-in durable storage adapters: ship production-supported adapters for the pluggable delivery, notification, aggregation, scheduled-job, lease, and execution-attempt stores. Keep in-memory defaults for local use, but make durable storage the recommended production path.
- Schema and rule lifecycle: version event normalization, rule bundles, action arguments, and persisted state. Add dry-run evaluation, staged rollout, canary rules, and a rollback path for bad rule changes.
- Scheduler correctness: run scheduled checks with durable leases, clock-skew tolerance, deduped claims, lag metrics, and safe recovery after worker restarts. Scheduled work should survive deploys and host crashes.

### Observability

- [High] Observability wiring: connect the engine emitter from [`ADR-011`](adr/011-observability.md) to real metrics, structured logs, and tracing. Every log, span, and metric should carry `deliveryId`, `ruleId` when available, repository, installation, action name, and integration name.
- Metrics and SLOs: publish counters for accepted, rejected, retried, dead-lettered, matched, skipped, and failed deliveries; histograms for end-to-end latency, rule latency, predicate latency, action latency, external-call latency, queue age, and scheduler lag; gauges for queue depth, breaker state, cache hit rate, active workers, aggregate rows, and scheduled jobs.
- Alerting: page on sustained delivery failures, queue age breaching the freshness SLO, scheduler lag, dead-letter growth, PostgreSQL connection exhaustion, backup failures, and external integration circuit breakers stuck open. Ticket-level alerts are enough for noisy single-rule failures.
- Tracing: create an ingress span per delivery, child spans for evaluation, rule checks, predicates, actions, scheduled checks, store calls, and external integrations. Propagate a correlation header on outbound integration calls where the target service supports it.
- Logging policy: use structured JSON logs with stable event names, severity conventions, and redaction of secrets, tokens, signatures, and PII-like payload fields. Keep raw webhook payload access controlled and time-limited.

### Deployment

- Deployment operations: run stateless workers behind health checks with graceful shutdown, readiness based on store/queue connectivity, config validation at boot, resource limits, autoscaling on queue age, and separate worker pools for latency-sensitive and slow integration-heavy rules.
- Security and tenancy: authenticate dashboard/API access, authorize by installation or repository, rotate secrets, store webhook secrets in a secret manager, validate outbound integration credentials per tenant, and audit administrative operations.
- Rate limits and external dependencies: track GitHub and third-party rate-limit budgets, apply per-installation throttles, expose breaker state, and make degradation explicit when enrichment data is unavailable.

### Error Correction

- [High] Error correctness: preserve the current distinction between predicate failures isolating to `false` and action failures rejecting evaluation, but classify errors as retryable, non-retryable, validation, dependency, or bug. Store that classification with the delivery result.
- [High] Idempotent side effects: require action implementations to be idempotent or guarded by an execution ledger keyed by delivery, rule, action, and target resource. External notifications should carry deterministic idempotency keys when providers support them.

### Reliability

- [High] Durable webhook ingress: verify signatures, validate event shape, persist the raw delivery, and enqueue work before evaluating rules. Use `X-GitHub-Delivery` as the idempotency key so duplicate GitHub retries are safe and replayable.
- [High] Queue and retry semantics: process deliveries through a managed queue with bounded concurrency, exponential backoff, poison-message detection, and a dead-letter queue with tooling to inspect, re-drive, or permanently discard failed deliveries.
- Backups and disaster recovery: enable point-in-time recovery, regular restore tests, retention policies, and documented RPO/RTO. Back up enough raw delivery data to replay rule evaluation after a deploy, bug fix, or partial outage.

### Maintenance

- Testing and verification: add contract tests for store implementations, replay tests from captured GitHub fixtures, failure-injection tests for queues/stores/integrations, migration tests, load tests around queue and scheduler behavior, and production smoke tests after deploy.
- Runbooks: document how to investigate a single `deliveryId`, replay a failed delivery, drain or pause workers, handle a stuck circuit breaker, restore from backup, rotate secrets, and disable a bad rule safely.

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

## Engine Test Coverage

Latest local coverage run:

```sh
cd engine
npm run typecheck && npx vitest run src/__tests__ --coverage
```

Result from the latest run:

- Test files: 20 passed.
- Tests: 199 passed.
- Statements: 94.17%.
- Branches: 88.45%.
- Functions: 90.95%.
- Lines: 95.43%.

The engine test suite is split by intent:

- `utility/`: focused tests for reusable runtime helpers such as stores, clocks, loggers, combinators, and cancellation utilities.
- `integration/`: cross-component behavior for registration, evaluation, scheduling, aggregation, memoization, and integration adapters.
- `smoke/`: package-level checks that the public API can be imported and used through the intended surface.
- `acceptance/`: executable coverage for the original task examples and expected rule-engine behavior.

The normal engine gate is `npm test` from `engine/`, which runs TypeScript typechecking and the full Vitest suite. Use the coverage command above when you need the coverage report.
