# ADR-013: Deliverable structure — library is primary, server is demo-only

**Status:** Accepted
**Date:** 2026-05-28

## Context

The deliverable is a **library**: an embeddable rule engine that any caller (a webhook receiver, an internal orchestrator, a CLI, a test harness) can pull in. The HTTP server is a **demo** that exercises the library against sample events and showcases the DSL — it is not the product.

This reframing forces several earlier decisions into one of two buckets:

- **Library** owns DSL parsing, evaluation, predicate registry, aggregation, temporal scheduling, cancellation contract, and observability *hooks*.
- **Demo** owns HTTP transport, signature verification, status code semantics, ingress backpressure, health endpoints, SIGTERM handling, and concrete telemetry SDK wiring.

Anything HTTP-shaped, anything coupled to a specific telemetry SDK, anything wired to a specific lifecycle (Kubernetes SIGTERM, ALB drain) belongs to the demo. The library exposes contracts; the demo wires them up.

This boundary is the single most important architectural commitment in the repo, because it determines what consumers of the library can and cannot assume.

## Decision

### Repository layout

```
test-air/
├── engine/           # the library
├── demo-server/      # demo HTTP server exercising the library
├── adr/              # this directory
└── package.json      # npm workspaces: ["engine", "demo-server"]
```

npm workspaces give clean imports (`import { RuleEngine } from '@air/engine'`) and atomic refactor of API + demo without monorepo tooling overhead.

### Library public API

```ts
class RuleEngine {
  constructor(opts?: {
    aggregationStore?: AggregationStore;
    scheduler?: ScheduledDecisionQueue;
    clock?: Clock;
    integrationCache?: IntegrationCache;
  });

  loadRules(yaml: string | object[]): Result<LoadedRules, ValidationError[]>;
  registerPredicate(p: Predicate): void;
  registerIntegration(name: string, adapter: IntegrationAdapter): void;

  evaluate(event: Event, opts?: {
    deliveryId?: string;        // correlation ID
    explain?: boolean;          // include evaluation tree in result
    signal?: AbortSignal;       // cancellation
  }): Promise<EvaluationResult>;

  on(event: 'rule.matched' | 'predicate.evaluated' | 'external.call' | ..., cb): void;
  inflight(): InflightSnapshot; // for caller-side supervision
  shutdown(opts?: { drainMs?: number }): Promise<ShutdownReport>;
}
```

Key properties of the API:
- **Async-first.** Every operation that may touch IO returns a Promise.
- **Cancellation via `AbortSignal`** on `evaluate()` and threaded through every predicate. No `setTimeout` without abort. No `fetch` without `signal`.
- **No transport.** No HTTP, no message bus, no queue dependency. Caller invokes `evaluate()`.
- **No telemetry SDK dep.** Observability is via an event emitter; caller wires OTel / Pino / whatever.
- **No lifecycle dep.** No SIGTERM listener inside the library; caller calls `shutdown()` when it wants.
- **Pluggable interfaces with in-memory defaults.** `AggregationStore`, `ScheduledDecisionQueue`, `Clock`, `IntegrationCache` all ship with in-memory implementations and accept custom ones.

### Library dependencies (lean)

Runtime: Zod, Chevrotain, lru-cache, p-limit.
Optional peer: opossum (circuit breaker) — caller chooses whether to install.
Dev: Vitest, TypeScript.

### Demo dependencies

Fastify, @fastify/rate-limit, Pino, @opentelemetry/* SDKs, prom-client. Plus the engine via workspace link.

## Alternatives considered

- **Single package mixing library and server.** Forces every consumer to pull HTTP / telemetry deps they don't need. Couples library API evolution to server changes. Rejected.
- **Two separate repos.** Heavier for prototype iteration; loses atomic refactor of library API + demo. Workspaces give the same separation with less friction.
- **Library couples to OpenTelemetry directly** (calls `tracer.startSpan()` inside the engine). Forces every consumer to use OTel; precludes embedding in callers with their own observability stack. Rejected in favor of emitter-based hooks the demo wires into OTel.
- **Library exposes only a sync API; async wrapping in the demo.** Doesn't work — external integrations are inherently async, and that's a defining feature of the engine. The library must be async-first.
- **`packages/` + `apps/` deeper layout.** Conventional for large monorepos; overhead at this size. Flat workspaces is enough; can promote later.

## Consequences

**Positive:**
- Library is embeddable anywhere. The demo is one way to wire it, not the only way.
- API surface is forced to be deliberate: observability and lifecycle become first-class library citizens via hooks rather than buried SDK calls.
- Tests are simpler — library tests don't need a server harness, just construct an engine and call `evaluate()`.
- The "embedded in someone else's webhook receiver" use case is supported by construction, not by accident.

**Negative:**
- Emitter-based observability is more work than directly calling OTel inside the engine. Pays for itself the first time someone embeds without OTel.
- Two `package.json`s and a workspace root is more setup than one. Acceptable.
- Some earlier ADRs (009, 010, 012) had decisions that span both library and demo; they are updated to mark which decisions live where. (ADR-011 was rescoped to engine-only observability and lives outside this subdirectory.)
