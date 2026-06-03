# Architecture Decision Records

Design decisions for the GitHub event filtering rules engine.

Each ADR follows the same shape: **Context** (what we're addressing), **Decision** (what we chose), **Alternatives** (other options + why rejected), **Consequences** (trade-offs that follow).

The repository is structured as a **library** (the engine) plus a **demo server** that wraps it. ADRs in the top level are engine concerns; ADRs under [`supervisor/`](supervisor/) are demo/server / process-supervision concerns that are explicitly out of the engine's scope.

## Engine

- [ADR-001 — Language and runtime: TypeScript on Node.js](001-language-and-runtime.md)
- [ADR-002 — DSL design: code-as-config using `@octokit/webhooks-types`](002-dsl-design.md)
- [ADR-003 — Engine architecture (superseded by ADR-002)](003-engine-architecture.md)
- [ADR-004 — Evaluation model: async, two-phase, memoized, short-circuit](004-evaluation-model.md)
- [ADR-005 — External integration resilience: cache, circuit breaker, per-integration concurrency](005-external-integration-resilience.md)
- [ADR-006 — Aggregation: projected windows, split action kinds, swappable store](006-aggregation-windows.md)
- [ADR-007 — Scheduled rules: deferred checks behind a swappable store](007-temporal-absence-rules.md)
- [ADR-008 — State persistence: pluggable stores with in-memory defaults; event retry on the caller](008-in-memory-state-caller-retry.md)
- [ADR-011 — Engine observability: logger via ctx, GitHub-id tracing, metrics emitter](011-observability.md)
- [ADR-014 — Engine API surface: constructor, evaluate contract, action execution](014-engine-api-surface.md)
- [ADR-015 — Clock: injectable time source, default real, primary purpose is testability](015-clock.md)
- [ADR-016 — Register phase: canonical entity signatures and aggregated error shape](016-register-phase.md)

## Supervisor (demo / process)

Out of the engine's scope — these document how the demo server wraps the engine for an HTTP / Kubernetes deployment.

- [ADR-009 — Webhook ingress: signature verification and status code semantics](supervisor/009-webhook-ingress.md)
- [ADR-010 — Backpressure: layered rejection over async pipeline](supervisor/010-backpressure.md)
- [ADR-012 — Supervisor and graceful shutdown: in-flight registry, watchdog](supervisor/012-supervisor-graceful-shutdown.md)
- [ADR-013 — Deliverable structure: library is primary, server is demo-only](supervisor/013-library-demo-separation.md)

## Status legend

- **Accepted** — current direction; code is expected to reflect this.
- **Proposed** — under discussion; not yet binding.
- **Superseded** — replaced; the file remains for history, with a pointer to the replacement.
