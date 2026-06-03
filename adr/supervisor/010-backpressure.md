# ADR-010: Backpressure — layered rejection over async pipeline

**Status:** Accepted
**Date:** 2026-05-28
**Scope:** Split — the library provides per-integration concurrency primitives (layers 4, 5); the demo server provides ingress queue, status-code rejection, and readiness signaling (layers 1, 2, 3, 6). See [ADR-013](013-library-demo-separation.md). Each layer below is annotated `[library]` or `[demo]`.

## Context

Capacity profile we're designing for:
- ~100 RPS sustained, ~1–2k RPS burst (mid-size multi-tenant SaaS).
- External-call latency creates an inherent throughput ceiling per worker (e.g., classifier at 200ms p50 × 10 concurrent in-flight = 50 evals/sec ceiling for classifier-bound rules).
- Unbounded queueing causes OOM and unbounded latency under sustained overload — both worse than rejection.

The caller's retry behavior ([ADR-008](../008-in-memory-state-caller-retry.md)) means rejection is acceptable; we should reject fast and visibly rather than queue silently.

## Decision

**Layered backpressure with explicit rejection points, not implicit queueing.**

### Layer 1 — Bounded ingress queue `[demo]`
- Default capacity: 10k events. Full queue → 503 ([ADR-009](009-webhook-ingress.md)).
- This is the **last** line of defence; everything else aims to reject before reaching here.

### Layer 2 — Per-installation token bucket `[demo]`
- Bounded refill rate per GitHub App installation. Drained bucket → 429 ([ADR-009](009-webhook-ingress.md)).
- This is the **first** rejection layer and the most common one in steady state.

### Layer 3 — Worker pool `[demo]`
- Bounded async worker count for evaluation (default: CPU count × 2).
- Workers pull from the ingress queue. No worker = queue depth grows = eventually triggers readiness flip (layer 5).

### Layer 4 — Per-integration concurrency semaphores `[library]`
- One `p-limit` instance per external integration ([ADR-005](../005-external-integration-resilience.md)).
- A slow classifier consumes only its own budget — the worker pool isn't held hostage. Predicates awaiting a saturated integration park until budget frees.

### Layer 5 — Adaptive concurrency on external calls `[library]`
- Vegas-style limiter that adjusts integration concurrency based on observed latency. Beats fixed pools when external latency drifts (degraded classifier doesn't keep getting hammered).

### Layer 6 — Readiness signal `[demo]`
- `/readyz` flips false when queue depth crosses 80% of capacity.
- Load balancer steers traffic away **before** we start 503ing.
- Same signal flips false during graceful shutdown ([ADR-012](012-supervisor-graceful-shutdown.md)).

## Alternatives considered

- **Unbounded queue + worker pool.** OOM and latency blowup under sustained overload; failure is silent and catastrophic. Rejected.
- **Slow-accept push-back** (deliberately stalling 200 responses to slow the caller). Abuses HTTP semantics; breaks GitHub's 10s timeout; harder to instrument. Rejected.
- **Fixed concurrency on externals without adaptation.** Under-utilizes capacity in good times, over-commits in bad. Adaptive is strictly better at the cost of slightly more complexity.
- **Single global concurrency cap across integrations.** A slow classifier starves GitHub API calls and vice versa. The whole point of layer 4 is to prevent this.
- **Drop strategy instead of reject (silently discard at queue full).** No signal to the caller, no metric trail. Rejected — explicit 503 + metrics is strictly better.

## Consequences

**Positive:**
- Behavior under overload is predictable: 429s first (per-tenant fairness), then 503s (server emergency), with readiness signaling before either.
- Failure modes are observable: every rejection increments a labeled counter; pattern is clear in metrics.
- Slow integrations don't cascade; their semaphore caps containment.

**Negative:**
- More tunables: queue size, worker count, per-integration concurrency, adaptive limiter parameters, watermark percentages. All config-driven with documented defaults. Mitigated by sensible defaults that work out of the box.
- Adaptive concurrency takes a few seconds to converge on a new equilibrium when latency shifts. Acceptable; the alternative is stale fixed values.
- Multi-replica deployments share none of this state — each replica enforces its own buckets and queues. The effective capacity is N×, which is usually what you want, but documented for clarity.
