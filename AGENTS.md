# AGENTS.md

## What this is

A prototype rule engine that filters GitHub webhook events through code-as-config rules written in TypeScript. Built for the Air Automation take-home (see `task.md`).

## Layout

- `adr/` — Architecture Decision Records. Authoritative for design intent. Numbered; the README indexes them. Do **not** change the intent of an ADR; if behavior must change, write a follow-up ADR.
- `engine/` — the npm package (`@air/engine`).
  - `src/public/` — public API contracts and lightweight public runtime classes (engine API, DSL builder types, ctx shapes, register errors). This is the supported surface, not just types.
  - `src/internal/` — engine-internal contracts used by the implementation (registry, eval context, emitter helpers). Do not export these from the package root.
  - `src/utility/` — runtime implementations of public shapes that are **not** engine-coupled: `SystemClock`, no-op logger, combinator factories (`all` / `any` / `not` / `use`), in-memory `AggregationStore` / `ScheduledStore`.
  - `src/engine/` — the engine itself: builder factories (`predicate` / `action` / `aggregatedAction` / `scheduledAction` / `rule` / `integration`), `createEngine`, and the integration adapter.
  - `src/__tests__/` — vitest suites: `utility/`, `smoke/`, `integration/`, `acceptance`. Plus `_harness.ts` (test import seam), `_helpers.ts` (test-only implementations such as `createManualClock` / `fakeEnvelope`), and `_fixtures.ts` (shared rule/predicate/action fixtures).
- `demo/` — Fastify webhook ingress package (`@air/demo`) that accepts GitHub webhooks and evaluates them with `@air/engine`.
  - `src/server.ts` — Fastify app factory, webhook signature verification, event-name mapping, and `/demo/notifications` endpoint.
  - `src/index.ts` — runtime entrypoint. Uses in-memory stores by default; when `DATABASE_URL` is set, initializes PostgreSQL storage and closes it on shutdown.
  - `src/rules.ts` — demo rule/action definitions plus the in-memory `DemoStore`.
  - `src/postgres-storage.ts` — PostgreSQL-backed demo notification store plus engine `AggregationStore` and `ScheduledStore` implementations.
  - `test/` — demo E2E tests that start the HTTP server and send signed webhook requests.
- `docker-compose.yml` — runs PostgreSQL and the demo app together for local end-to-end use.
- `task.md` — the original assignment.

## Workflow

- `npm test` (from `engine/`) — runs `tsc --noEmit` then the full vitest suite. This is the gate.
- `npm run build` (from `engine/`) — emits the package to `engine/dist/`; `dist/` is ignored.
- `npm run typecheck` (from `engine/`) — TypeScript only.
- `npm run test:utility` / `npm run test:all` (from `engine/`) — narrower runs.
- `npm test` (from `demo/`) — builds the engine, typechecks the demo, and runs demo Vitest E2E tests.
- `npm run dev` (from `demo/`) — builds the engine and runs the demo via `tsx src/index.ts` with in-memory storage unless `DATABASE_URL` is set.
- `docker compose up --build` (from repo root) — runs PostgreSQL and the demo app in Docker. Compose sets `DATABASE_URL=postgres://air:air@postgres:5432/air_demo`.

## Conventions

- **ADRs are the contract.** Tests encode them. When tests and intuition disagree, re-read the ADR first.
- **The supported public surface lives in `src/public/` plus runtime exports from `src/engine/index.ts`.** Runtime code that implements public shapes goes in `src/utility/` (entity-agnostic) or `src/engine/` (engine-coupled).
- `_harness.ts` is the seam tests import through. If the engine grows a new entry point a test needs, re-export it there rather than importing from `src/engine/` directly in each test.
- Test-only helpers belong in `src/__tests__/_helpers.ts`; keep them out of package root exports and `src/utility/`.
- ESM with `.js` import suffixes — TypeScript is configured for `"moduleResolution": "Bundler"` with `verbatimModuleSyntax: false`, but the codebase keeps `.js` suffixes for portability.
- Zod is the args schema validator; predicates/actions validate pinned args as **partial** (registration args may supply only some keys) and re-validate merged use-site + registration args at evaluate time. Rule args are complete at registration because rules have no use-site merge.
- `node_modules/` and `dist/` are intentionally ignored. Do not commit generated dependency or build output.

## Things that bite

- `register()` runs two passes (dependency-graph + schema) and throws an aggregated `RegistrationError` with every issue. Don't fail-fast.
- Predicate errors **isolate to `false`** — they never reject `evaluate()`. Action errors **do** reject (aggregated via `AggregateError` when multiple).
- `ctx.now` is frozen at evaluation start. Engine code uses the injected `Clock`, never `Date.now()` / global `setTimeout`.
- Test-only helpers such as `createManualClock` and `fakeEnvelope` live under `src/__tests__/`; do not export them from the runtime package.
- Scheduled-rule poll cadence is clamped to a **10s floor** (ADR-007). The in-memory scheduler re-arms its next tick synchronously so cascades survive a `ManualClock.advance(...)` sweep, and uses store leases to dedup claims.
- Per-event predicate memoization keys on `(name, canonicalJSON(merged args))`. Args precedence: **registration > use-site**.
- Integration adapters own external-call resilience: cache, concurrency, circuit breaker, retry, and `external.call` emitter events. Engine-side predicate memoization is still per event only.
