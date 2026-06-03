# ADR-001: Language and runtime — TypeScript on Node.js

**Status:** Accepted
**Date:** 2026-05-28

## Context

The task allows TypeScript/Node.js or Kotlin/JVM, and explicitly permits anything else if defensible. The choice shapes everything downstream: DSL ergonomics, async model, cancellation propagation, dependency footprint, and whether the optional UI can share a stack.

Relevant constraints:
- Prototype-grade timeline; setup overhead is a real cost.
- Heavy IO concurrency (webhook ingress + external classifier calls + GitHub API), not CPU-bound.
- Optional UI mentioned as a bonus — same-language frontend would be a win.
- Rules engine code is interpreter-heavy (AST walking, registry lookup, dynamic dispatch).

## Decision

**TypeScript on Node.js 20+ LTS.**

Library deps (lean): Zod, Chevrotain, lru-cache, p-limit. opossum as optional peer.
Demo server deps: Fastify, @fastify/rate-limit, Pino, OpenTelemetry JS SDK, prom-client.
Tooling: Vitest, npm workspaces (see [ADR-013](supervisor/013-library-demo-separation.md)).

## Alternatives considered

- **Kotlin/JVM with Ktor.** Stronger DSL ergonomics via sealed class hierarchies; structured concurrency makes cancellation propagation automatic (a real advantage given how much the engine cancels). Rejected because (a) the optional UI gains nothing from JVM, (b) warmup time and memory footprint aren't justified at the target scale, (c) the Node webhook ecosystem (Octokit, Probot, GitHub App helpers) is more mature.
- **Go.** Excellent for the ingress layer and trivial concurrency. Rejected because the interpreter/evaluator code is significantly more verbose without generics-heavy DSL helpers, and there's no CPU bottleneck that demands Go's profile.
- **Python.** Fast prototyping, but the async ecosystem is less consistent and the type story (mypy/pyright) lags TypeScript's, which matters for a DSL where load-time validation is central.

## Consequences

**Positive:**
- Single language across server, DSL evaluator, and optional UI.
- Strong load-time validation via Zod; types flow from schema to runtime.
- Mature webhook tooling (Octokit signature verification, etc.).

**Negative:**
- TypeScript lacks Kotlin's automatic structured-concurrency cancellation. We must propagate `AbortSignal` through every async call in the eval path by hand. Enforced by lint rule and code review (see [ADR-012](supervisor/012-supervisor-graceful-shutdown.md)).
- Heap is the natural scaling ceiling; past one node we'd need clustering or sharding.
