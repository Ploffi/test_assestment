# ADR-009: Webhook ingress — signature verification and status code semantics

**Status:** Accepted
**Date:** 2026-05-28
**Scope:** Demo server. The library does not ship HTTP — callers wire their own ingress. The decisions here document the demo's design and serve as reference for other consumers wiring ingress around the engine. See [ADR-013](013-library-demo-separation.md).

## Context

The ingress endpoint accepts GitHub webhook deliveries. It has several jobs that must run in the right order:

1. Reject forged requests (signature verification).
2. Enforce per-tenant fairness (one noisy org shouldn't starve others).
3. Signal aggregate capacity exhaustion distinctly from per-tenant rate-limiting.
4. Acknowledge accepted work promptly — GitHub times out webhook deliveries at ~10 seconds.

Status code selection is not a trivia detail: different codes route to different alerting paths, distinguish "expected client behavior" from "server emergency" in dashboards, and inform whether oncall pages.

## Decision

**Fastify endpoint with the following ordered hooks. Each rejection class uses a distinct status code carrying clear intent.**

```
1. HMAC signature verification (X-Hub-Signature-256)        →  401 Unauthorized
2. Per-installation token bucket                            →  429 Too Many Requests + Retry-After
3. Global queue depth check                                 →  503 Service Unavailable + Retry-After
4. Enqueue + immediate acknowledge                          →  202 Accepted
```

### Status code rationale

| Code | When | Routes to | Pages? |
|---|---|---|---|
| **401** | Invalid HMAC signature | Security alert | Alert on sustained rate |
| **429** | Per-installation bucket drained | Fairness / quota | No (expected behavior) |
| **503** | Global queue above high-watermark | Capacity / overload | Yes (server emergency) |
| **202** | Accepted for async processing | — | No |

**Why per-installation 429 in front of global 503:** GitHub is not a misbehaving client — it emits events at the rate things happen in the repo. There is no "slow down" GitHub can comply with at the aggregate level. When one tenant fan-outs (mass CI runs, bulk label changes), the right response is "*this tenant* is over its slice" — a per-sender problem, semantically a 429. Reserving 503 for the rare aggregate-capacity case means a 503 in dashboards is a real server emergency, not routine burst.

**Why verify signature first:** If we rate-limit before verification, an attacker can forge `X-GitHub-Hook-Installation-Target-Id` to burn arbitrary tenants' budgets. Signature verification must precede any per-installation logic.

**Why 202, not 200:** Semantically correct for "accepted for async processing"; most monitoring stacks distinguish 202 from 200, useful for "evaluation success" vs "ack success" metrics.

**On `Retry-After`:** Both 429 and 503 set `Retry-After`. GitHub's webhook deliverer does not strictly respect that header (it uses its own exponential backoff schedule), but the header is correct for any non-GitHub callers (testing harness, custom integrations) and shows in delivery dashboards.

## Alternatives considered

- **503 for all queue-related rejection.** Conflates per-tenant rate-limiting with global overload. Oncall pages on routine bursts. Rejected.
- **429 for everything.** Treats GitHub as "over-quota" which is misleading semantically, and a sustained-queue-full situation no longer pages oncall — exactly when it should. Rejected.
- **Synchronous evaluation in the request handler.** Risks the 10-second GitHub timeout if a classifier is slow. Rejected; we ack on enqueue, evaluate async.
- **No per-tenant fairness.** A single fan-out storm degrades service for every tenant. Rejected for any multi-tenant deployment.
- **Validate signature after rate-limit.** Cheaper (rate-limit short-circuits before HMAC compute) but lets attackers forge installation IDs to grief tenants. Rejected — the security cost outweighs the small CPU saving.

## Consequences

**Positive:**
- Each rejection class carries actionable signal: 429 = tune your bucket, 503 = scale or investigate, 401 = security.
- Multi-tenant fairness is a first-class ingress concern, not bolted on later.
- A well-tuned deployment hits 429 thousands of times before ever hitting 503; the 503 alert is meaningful.

**Negative:**
- Per-installation bucket state is per-process in the prototype. Multi-replica deployments either need shared bucket state (Redis-backed) or accept the effective limit is N× the configured per-replica limit. Documented as a scaling consideration; the bucket is an interface, swap in a Redis implementation when needed.
- HMAC verification adds CPU to every request even forged ones. Acceptable — the work is small (~tens of μs) and the security guarantee is essential.
- Caller-side dashboards see a mix of 401/429/503 and must be configured to interpret them correctly. Documented in the operator guide.
