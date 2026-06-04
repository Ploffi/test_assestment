# AGENTS.md

## What this is

A prototype rule engine that filters GitHub webhook events through code-as-config rules written in TypeScript. Built for the Air Automation take-home (see `task.md`).

## Layout

- `adr/` — Architecture Decision Records. Authoritative for design intent. Numbered; the README indexes them. Do **not** change the intent of an ADR; if behavior must change, write a follow-up ADR.
- `interfaces/` — the npm package.
  - `src/public/` — public type surface (engine API, DSL builder types, ctx shapes). Types only — no runtime.
  - `src/internal/` — engine-internal types (registry, eval context, emitter).
  - `src/utility/` — runtime implementations of public shapes that are **not** engine-coupled: `SystemClock` / `ManualClock`, no-op logger, combinator factories (`all` / `any` / `not` / `use`), in-memory `AggregationStore` / `ScheduledStore`.
  - `src/engine/` — the engine itself: builder factories (`predicate` / `action` / `aggregatedAction` / `scheduledAction` / `rule` / `integration`), `createEngine`, `fakeEnvelope`, and the integration adapter.
  - `src/__tests__/` — vitest suites: `utility/`, `smoke/`, `integration/`, `acceptance/`. Plus `_harness.ts` (re-exports the engine entry points the tests use) and `_fixtures.ts` (shared rule/predicate/action fixtures).
- `task.md` — the original assignment.

## Workflow

- `npm test` (from `interfaces/`) — runs `tsc --noEmit` then the full vitest suite. This is the gate.
- `npm run typecheck` — TypeScript only.
- `npm run test:utility` / `npm run test:all` — narrower runs.

## Conventions

- **ADRs are the contract.** Tests encode them. When tests and intuition disagree, re-read the ADR first.
- **Public types live in `src/public/`** and are types-only. Runtime code that depends on the public surface goes in `src/utility/` (entity-agnostic) or `src/engine/` (engine-coupled).
- `_harness.ts` is the seam tests import through. If the engine grows a new entry point a test needs, re-export it there rather than importing from `src/engine/` directly in each test.
- ESM with `.js` import suffixes — TypeScript is configured for `"moduleResolution": "Bundler"` with `verbatimModuleSyntax: false`, but the codebase keeps `.js` suffixes for portability.
- Zod is the args schema validator; the engine validates pinned args as **partial** (registration args may supply only some keys) and re-validates the merged use-site + registration args at evaluate time.

## Things that bite

- `register()` runs two passes (dependency-graph + schema) and throws an aggregated `RegistrationError` with every issue. Don't fail-fast.
- Predicate errors **isolate to `false`** — they never reject `evaluate()`. Action errors **do** reject (aggregated via `AggregateError` when multiple).
- `ctx.now` is frozen at evaluation start. Engine code uses the injected `Clock`, never `Date.now()` / global `setTimeout`.
- Scheduled-rule poll cadence is clamped to a **10s floor** (ADR-007). The in-memory scheduler re-arms its next tick synchronously so cascades survive a `ManualClock.advance(...)` sweep, and uses store leases to dedup claims.
- Per-event predicate memoization keys on `(name, canonicalJSON(merged args))`. Args precedence: **registration > use-site**.
