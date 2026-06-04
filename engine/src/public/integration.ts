/**
 * External integration adapter (ADR-005).
 *
 * Each integration combines four resilience patterns layered in order:
 *   cache → semaphore → breaker → retry → underlying call.
 *
 * The builder shape is `integration(name).<config>...methods({...})` —
 * cache/breaker/concurrency/retry are optional; methods is required.
 */

import type { z } from 'zod';

/** TTL cache config (ADR-005). Omit on write-side integrations. */
export interface CacheConfig {
  /** Either a duration string ('24h', '5m') or ms. */
  ttl: string | number;
  /** Max entries; LRU eviction beyond this. */
  max?: number;
}

/** Circuit-breaker config (ADR-005, opossum-shaped). */
export interface BreakerConfig {
  errorThresholdPct: number;
  resetMs: number;
}

/** Bounded retry with exponential backoff (ADR-005). */
export interface RetryConfig {
  attempts: number;
  backoffMs: number;
  jitter?: boolean;
}

/**
 * Method record on an `integration(...)`: each value is an async function
 * taking one input object and returning a result.
 *
 * The input object should include `signal?: AbortSignal` so the adapter
 * can forward cancellation to the underlying call (ADR-005, ADR-014).
 */
export type IntegrationMethods = Record<
  string,
  (input: any) => Promise<any>
>;

/**
 * Resolved integration adapter — what `ctx.integrations.<name>` exposes
 * at evaluate time. The methods record is preserved; each call goes
 * through the resilience chain (cache → semaphore → breaker → retry → fn).
 */
export type IntegrationAdapter<M extends IntegrationMethods = IntegrationMethods> = M;

/** Public marker for a registered integration (what `register({ integrations })` accepts). */
export interface RegisteredIntegration<
  Name extends string = string,
  M extends IntegrationMethods = IntegrationMethods,
> {
  readonly kind: 'integration';
  readonly name: Name;
  readonly cache?: CacheConfig;
  readonly breaker?: BreakerConfig;
  readonly concurrency?: number;
  readonly retry?: RetryConfig;
  readonly methods: M;
}

/* ============================================================ *
 * Progressive builder shape
 * ============================================================ */

/**
 * Inert builder returned by `integration(name)`. Each step is optional and
 * can appear in any order, except `.methods(...)` which terminates.
 */
export interface IntegrationBuilder<Name extends string = string> {
  cache(cfg: CacheConfig): IntegrationBuilder<Name>;
  breaker(cfg: BreakerConfig): IntegrationBuilder<Name>;
  concurrency(limit: number): IntegrationBuilder<Name>;
  retry(cfg: RetryConfig): IntegrationBuilder<Name>;
  methods<M extends IntegrationMethods>(methods: M): RegisteredIntegration<Name, M>;
}

/** Factory shape — `integration(name)` returns an `IntegrationBuilder`. */
export type IntegrationFactory = <Name extends string>(name: Name) => IntegrationBuilder<Name>;

/* ============================================================ *
 * Shared zod-schema type alias used across builders
 * ============================================================ */

/** Any Zod schema; reused by predicate / action / rule `.args(schema)`. */
export type AnyArgsSchema = z.ZodTypeAny;
