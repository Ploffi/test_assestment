# ADR-012: Supervisor and graceful shutdown — in-flight registry, watchdog, drain on SIGTERM

**Status:** Accepted
**Date:** 2026-05-28
**Scope:** Split — the library provides cancellation contract (`AbortSignal`), per-eval watchdog, in-flight evaluation tracking (`engine.inflight()`), and `engine.shutdown({ drainMs })`; the demo provides HTTP health endpoints, the SIGTERM listener, and Kubernetes integration. See [ADR-013](013-library-demo-separation.md). Each mechanism below is annotated `[library]` or `[demo]`.

## Context

With in-memory state ([ADR-008](../008-in-memory-state-caller-retry.md)) and fully async evaluation ([ADR-004](../004-evaluation-model.md)), an unsupervised process can:

- Leak in-flight evaluations indefinitely (a forgotten `await` on a wedged external call).
- Stall on a slow integration past any reasonable per-event deadline.
- Lose work on hard shutdown (SIGKILL, OOM, crash).

Operators need to answer **"where is delivery X right now?"** at any second, and **"can I deploy without dropping evaluations?"** before every release.

TypeScript adds one specific challenge here that Kotlin doesn't: there is no automatic structured-concurrency cancellation. If a parent task is cancelled, its async children continue unless we explicitly thread an `AbortSignal` through every async call. This must be a contract enforced by code, not assumed.

## Decision

**Five coordinated mechanisms.**

### 1. In-flight registry `[library]`
- `Map<delivery_id, { startedAt, ruleId, stage, abortController }>`.
- Every evaluation registers on start and removes on completion / failure.
- Each stage transition (ingress → match → evaluate → action) updates the `stage` field — lets `/inflight` show *where* a stuck evaluation is stuck.

### 2. Watchdog sweeper `[library]`
- Background interval (every 1s).
- Cancels and removes any registry entry older than its per-stage timeout.
- Each cancellation aborts the entry's `AbortController`, increments `evaluations_timed_out` counter, logs with `delivery_id`.
- Default stage timeouts: match 1s, evaluate 15s, action 30s.

### 3. Per-evaluation watchdog `[library]`
- Each evaluation runs as `Promise.race(work, timeout(perStageDeadline))` at each stage transition.
- The `AbortController` is plumbed through every async call (`fetch`, classifier client, GitHub client). On abort, in-flight work cancels cooperatively.

### 4. Health surface `[demo]` (reads `engine.inflight()` and `engine.isReady()`)
- `/livez` — true unless the watchdog itself is wedged. Wedge detection: registry not draining AND no new starts in 30s. K8s liveness probe.
- `/readyz` — false above queue watermark (per [ADR-010](010-backpressure.md)) OR during shutdown. K8s readiness probe.
- `/inflight` — debug endpoint. Dumps current registry sorted by age. Authenticated; not exposed publicly.

### 5. Graceful shutdown (SIGTERM) `[demo]` (calls `engine.shutdown({ drainMs })`)
The sequence:
1. Flip `/readyz` to false → load balancer drains the replica.
2. Stop accepting at ingress (return 503 for any new requests that arrive during LB propagation).
3. Drain the in-flight registry — wait up to a configurable deadline (default 20s) for in-flight evaluations to complete.
4. Cancel anything still in-flight at deadline. Log `events_abandoned_at_shutdown` with the list of `delivery_id`s — caller's retry covers these.
5. Flush pending tracing/metric exports.
6. Exit cleanly.

Kubernetes integration:
- `preStop` hook with a short sleep (5s) to bridge LB propagation lag before SIGTERM arrives.
- `terminationGracePeriodSeconds` ≥ drain deadline + buffer (e.g., 30s).

### 6. AbortSignal discipline (enforcement, not a mechanism) `[library contract]`
- Every async function in the eval path accepts an `AbortSignal`. Cancellation is part of the contract.
- ESLint rule (`no-floating-promises`, custom rule banning `setTimeout` without abort and `fetch` without `signal`) — leaks fail CI, not production.
- Code review checklist item.

## Alternatives considered

- **Process supervisor only (PM2 / k8s liveness), no internal registry.** Answers "is the process up?" — does *not* answer "where is delivery X?" or "is the process making progress?" Insufficient for operator debugging.
- **Crash-only design** (let stuck evals crash the process, restart, caller retries). Correct under [ADR-008](../008-in-memory-state-caller-retry.md) but eliminates per-eval visibility, loses pending temporal decisions every restart, and turns every stuck classifier into a restart loop. Rejected.
- **Background heartbeat from each eval.** Functionally equivalent to the registry approach but more allocations and complexity. Registry is simpler.
- **Trace-spans-as-supervisor** (query in-progress spans from the OTel backend to find stuck evals). Useful diagnostic but not load-bearing — too slow and indirect to drive cancellation. Registry is the source of truth; spans are derived.
- **Auto-amputate** (process self-kills on N timeouts to force k8s restart). Hides the underlying problem and disrupts unrelated in-flight work. Better to surface the metric and let oncall decide.

## Consequences

**Positive:**
- "Where is delivery X?" is an answerable question via `/inflight`.
- Deployments are safe — graceful drain lets in-flight evaluations finish before pod termination.
- Leak detector (`events_received − events_completed − events_failed − events_in_flight → 0`) is built in.
- Per-stage timeouts give bounded latency guarantees end-to-end.

**Negative:**
- AbortSignal discipline must be enforced everywhere — easy to leak by forgetting `signal: ctx.signal` on one `fetch`. Mitigated by ESLint and review, but real risk in TS. Kotlin would get this for free with structured concurrency.
- Registry adds a `Map` write/delete per evaluation. Negligible at target scale.
- During shutdown, any evaluation that exceeds the drain deadline is abandoned and the caller retries. Documented behavior; rare in practice if per-stage timeouts are set well below drain deadline.
