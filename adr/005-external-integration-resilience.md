# ADR-005: External integration resilience — TTL cache + circuit breaker + per-integration concurrency limit

**Status:** Accepted
**Date:** 2026-05-28

## Context

Predicates may call external services: a classification API, GitHub's REST/GraphQL, internal lookups (team membership, ownership). These calls are slow, fallible, and rate-limited. Two failure modes are particularly damaging:

1. **A slow integration stalls the whole engine** — without isolation, one wedged classifier consumes the worker pool and blocks unrelated rule evaluations.
2. **Repeated identical calls dominate cost** — billing-per-call services (LLM, classifier) get hit redundantly without caching.

The engine must tolerate slow / failing integrations gracefully.

## Decision

**Every external integration sits behind a typed adapter combining four resilience patterns.**

For each integration:

1. **TTL cache** (`lru-cache`) — keyed by call signature. TTL configurable per integration (team membership: 5min; LLM classification: 24h; GitHub API: 1min for fast-changing data, longer for stable). Reduces both latency and cost.
2. **Circuit breaker** (`opossum`) — opens after a configurable failure threshold; while open, calls fail fast without hitting the network. Half-open probes test recovery. Prevents a wedged dependency from cascading.
3. **Per-integration concurrency semaphore** (`p-limit`) — bounds in-flight calls *per integration*. A slow classifier consumes only its own budget. Default budgets: classifier 10, GitHub API 20, internal lookups 50; all overridable in config.
4. **Bounded retry with exponential backoff** — retry policy lives inside the adapter (the engine doesn't know about retries). Cap at 3 attempts, jittered backoff. Retries are scoped per call and do not extend the per-evaluation deadline.

These are composed in order: cache check → semaphore acquire → circuit breaker → retry → underlying call.

### Defining and using an integration

Integrations use the same builder shape as the other entities in [ADR-002](002-dsl-design.md): `integration(name).<config>...methods({...})` produces a registered integration. Predicates and actions reach it through `ctx.integrations.<name>.<method>(...)`.

```ts
import { integration, predicate, action } from '@air/engine';
import { z } from 'zod';

// Read-side integration: classifier.
// Cache TTL is the dominant cost lever (each call is billed).
// Concurrency keeps a slow classifier from starving unrelated integrations.
const classifier = integration('classifier')
  .cache({ ttl: '24h', max: 10_000 })
  .breaker({ errorThresholdPct: 50, resetMs: 30_000 })
  .concurrency(10)
  .retry({ attempts: 3, backoffMs: 200, jitter: true })
  .methods({
    classify: async (input: {
      text: string;
      signal?: AbortSignal;
    }): Promise<{ label: string; confidence: number }> => {
      const res = await fetch('https://classifier.internal/v1/classify', {
        method: 'POST',
        body: JSON.stringify({ text: input.text }),
        signal: input.signal,
      });
      if (!res.ok) throw new Error(`classifier ${res.status}`);
      return res.json();
    },
  });

// Write-side integration: Slack.
// No TTL cache — every post is a distinct side effect.
// Lower concurrency budget; one extra retry is enough.
const slack = integration('slack')
  .breaker({ errorThresholdPct: 50, resetMs: 30_000 })
  .concurrency(5)
  .retry({ attempts: 2, backoffMs: 500, jitter: true })
  .methods({
    post: async (input: {
      channel: string;
      text: string;
      signal?: AbortSignal;
    }): Promise<void> => {
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.SLACK_TOKEN}` },
        body: JSON.stringify({ channel: input.channel, text: input.text }),
        signal: input.signal,
      });
      if (!res.ok) throw new Error(`slack ${res.status}`);
    },
  });

// Predicate using the classifier integration.
// Engine-side wrap: error isolation + AbortSignal + per-event memoization ([ADR-004](004-evaluation-model.md)).
// Adapter-side wrap on .classify: cache → semaphore → breaker → retry → fetch.
const isHostileComment = predicate('is_hostile_comment')
  .args(z.object({ minConfidence: z.number() }))
  .fn(async (ctx) => {
    const { label, confidence } = await ctx.integrations.classifier.classify({
      text: ctx.event.comment.body,
      signal: ctx.signal,
    });
    return label === 'hostile' && confidence >= ctx.args.minConfidence;
  });

// Action using the slack integration.
// Engine-side wrap: error isolation + AbortSignal. NO memoization — actions are
// side-effecting; coalescing would silently drop a post.
// Adapter-side wrap on .post: semaphore → breaker → retry → fetch.
const notifySlackAction = action('notify-slack')
  .args(z.object({ channel: z.string() }))
  .fn(async (ctx) => {
    await ctx.integrations.slack.post({
      channel: ctx.args.channel,
      text: render(ctx.event),
      signal: ctx.signal,
    });
  });

// Registration: integrations join the unified register() call alongside
// predicates / actions / rules. register() ([ADR-002](002-dsl-design.md))
// walks the full dependency graph, so any ctx.integrations.<name> reference
// inside a registered predicate or action must resolve to an integration
// included in this call — otherwise register() throws with the missing names.
engine.register({
  integrations: [classifier, slack],
  predicates: [isHostileComment()],
  actions: [notifySlackAction({ channel: '#moderation' })],
  rules: [hostilePrComment({ allowedAuthors: ['Marat'] })],
});
```

A few properties worth calling out:

- **The four resilience patterns are properties of the integration, not of each call site.** Five predicates calling `ctx.integrations.classifier.classify(...)` share one cache, one breaker, one concurrency budget. A wedged classifier opens the breaker once and every dependent rule sees the same fail-fast behavior.
- **`signal` flows through explicitly.** The predicate/action body passes `signal: ctx.signal` into the adapter method; the adapter then forwards it to the underlying `fetch`. This is the [ADR-012](supervisor/012-supervisor-graceful-shutdown.md) discipline — every async call in the eval path threads an `AbortSignal`. The ESLint rule banning `fetch` without `signal` catches drift. Because the same signal is the per-evaluation `AbortController`, `engine.shutdown(...)` could cancel in-flight integration calls by tripping that controller on graceful shutdown — the scheme enables it, but wiring shutdown through to per-call abort is out of scope for the current implementation.
- **The cache key is the input object minus `signal`.** Two calls with the same `{ text }` reuse the cached result regardless of which evaluation's signal they're passing.
- **Predicates get one more layer than actions.** Both go through engine error isolation + AbortSignal + the adapter's full chain; only predicates are coalesced by the per-event memoization in [ADR-004](004-evaluation-model.md). The action surface is intentionally not idempotent — if a rule fires twice in one evaluation pass, it sends two messages, not one.

## Alternatives considered

- **Shared global pool across integrations.** A slow integration starves the rest. Rejected; isolation is the whole point.
- **No caching.** Classifier billing and tail latency dominate. Rejected.
- **Engine-level retry (predicate retries itself).** Couples the engine to integration-specific failure modes (which errors are retriable, what backoff, what jitter). Wrong layer; retries belong to the IO adapter.
- **Bulkhead via separate worker threads per integration.** Heavyweight in Node (`worker_threads` setup cost); semaphores achieve the same isolation at lower cost since the actual work is IO-bound, not CPU-bound.
- **Hedged requests (fire two, take the first).** Lower tail latency but doubles cost. Defer until we can measure that it's worth it.

## Consequences

**Positive:**
- Integration failures are localized; the engine never blocks on a wedged dependency past the breaker threshold.
- Cost is bounded predictably (cache hit ratio + concurrency caps).
- Each integration's resilience knobs are tunable in config without code changes.

**Negative:**
- Stale cache reads are possible; TTLs must be chosen per integration. Documented in the integration registry.
- Circuit-breaker open state means *all* predicates depending on that integration return... what? **Decision:** evaluate to `false` and log; do not crash the rule. A rule author can opt into "fail-open" (treat unavailable as `true`) per predicate via an arg. Documented in the predicate-author guide.
- Retry budget is per call; long predicates that internally make multiple calls can blow through the per-eval watchdog ([ADR-012](supervisor/012-supervisor-graceful-shutdown.md)). The watchdog wins — it cancels outstanding work via `AbortSignal`.
