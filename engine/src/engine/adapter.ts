import type {
  RegisteredIntegration,
  IntegrationAdapter,
  IntegrationMethods,
} from '../public/integration.js';
import type { Clock } from '../public/clock.js';
import type { ExternalCallEvent } from '../public/emitter.js';
import { canonicalJson } from './canonical.js';
import { parseDuration } from './duration.js';

export const integrationCallContext: unique symbol = Symbol('integrationCallContext');

export interface IntegrationCallContext {
  deliveryId: string;
}

export interface AdapterOptions {
  clock: Clock;
  emit(event: ExternalCallEvent): void;
}

interface CacheEntry {
  promise: Promise<unknown>;
  expiresAt: number;
}

type BreakerState = 'closed' | 'open' | 'half-open';

export function attachIntegrationCallContext<T>(
  input: T,
  ctx: IntegrationCallContext,
): T {
  if (input === null || typeof input !== 'object') return input;
  const withCtx = { ...(input as Record<string, unknown>) } as T;
  Object.defineProperty(withCtx as object, integrationCallContext, {
    value: ctx,
    enumerable: false,
    configurable: true,
  });
  return withCtx;
}

function sleep(clock: Clock, ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((resolve, reject) => {
    const timer = clock.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      timer.cancel();
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function buildAdapter(
  integ: RegisteredIntegration<string, IntegrationMethods>,
  opts: AdapterOptions,
): IntegrationAdapter<IntegrationMethods> {
  const cache = integ.cache ? new Map<string, CacheEntry>() : null;
  const cacheTtlMs = integ.cache ? parseDuration(integ.cache.ttl) : 0;
  const cacheMax = integ.cache?.max ?? Number.POSITIVE_INFINITY;
  const concurrency = integ.concurrency === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(1, Math.floor(integ.concurrency));
  let active = 0;
  const waiters: Array<() => void> = [];

  let breakerState: BreakerState = 'closed';
  let breakerOpenedAt = 0;
  let successes = 0;
  let failures = 0;

  const acquire = async (): Promise<() => void> => {
    if (active < concurrency) {
      active++;
      return release;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    active++;
    return release;
  };

  const release = (): void => {
    active--;
    const next = waiters.shift();
    if (next) next();
  };

  const openBreaker = (): void => {
    breakerState = 'open';
    breakerOpenedAt = opts.clock.now();
  };

  const beforeBreakerCall = (): void => {
    if (!integ.breaker) return;
    if (breakerState !== 'open') return;
    if (opts.clock.now() - breakerOpenedAt >= integ.breaker.resetMs) {
      breakerState = 'half-open';
      return;
    }
    throw new Error(`integration breaker open: ${integ.name}`);
  };

  const afterBreakerSuccess = (): void => {
    if (!integ.breaker) return;
    if (breakerState === 'half-open') {
      breakerState = 'closed';
      successes = 0;
      failures = 0;
      return;
    }
    successes++;
  };

  const afterBreakerFailure = (): void => {
    if (!integ.breaker) return;
    if (breakerState === 'half-open') {
      openBreaker();
      return;
    }
    failures++;
    const total = successes + failures;
    const failurePct = total === 0 ? 0 : (failures / total) * 100;
    if (failurePct >= integ.breaker.errorThresholdPct) openBreaker();
  };

  const runWithRetry = async (
    fn: (input: any) => Promise<any>,
    input: any,
  ): Promise<any> => {
    const attempts = Math.max(1, Math.floor(integ.retry?.attempts ?? 1));
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await fn(input);
      } catch (err) {
        lastErr = err;
        if (attempt >= attempts) break;
        const base = integ.retry?.backoffMs ?? 0;
        const jitter = integ.retry?.jitter ? Math.floor(Math.random() * base) : 0;
        await sleep(opts.clock, base * 2 ** (attempt - 1) + jitter, input?.signal);
      }
    }
    throw lastErr;
  };

  const runThroughLayers = async (
    fn: (input: any) => Promise<any>,
    input: any,
  ): Promise<any> => {
    const releaseSemaphore = await acquire();
    try {
      beforeBreakerCall();
      try {
        const result = await runWithRetry(fn, input);
        afterBreakerSuccess();
        return result;
      } catch (err) {
        afterBreakerFailure();
        throw err;
      }
    } finally {
      releaseSemaphore();
    }
  };

  const getCacheKey = (methodName: string, input: any): string => {
    const sansSignal = { ...(input ?? {}) };
    delete sansSignal.signal;
    return methodName + '@' + canonicalJson(sansSignal);
  };

  const getCached = (key: string): CacheEntry | undefined => {
    if (!cache) return undefined;
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= opts.clock.now()) {
      cache.delete(key);
      return undefined;
    }
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  };

  const setCached = (key: string, promise: Promise<unknown>): void => {
    if (!cache) return;
    cache.set(key, { promise, expiresAt: opts.clock.now() + cacheTtlMs });
    while (cache.size > cacheMax) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    promise.catch(() => cache.delete(key));
  };

  const wrapped: Record<string, (input: any) => Promise<any>> = {};
  for (const [name, fn] of Object.entries(integ.methods)) {
    wrapped[name] = async (input: any) => {
      const startedAt = opts.clock.now();
      const callCtx = input?.[integrationCallContext] as IntegrationCallContext | undefined;
      const deliveryId = callCtx?.deliveryId ?? 'unknown';
      const key = cache ? getCacheKey(name, input) : '';
      const hit = cache ? getCached(key) : undefined;
      const cacheHit = Boolean(hit);
      const promise = hit?.promise ?? runThroughLayers(fn, input);
      if (cache && !hit) setCached(key, promise);
      try {
        const result = await promise;
        opts.emit({
          deliveryId,
          integrationName: integ.name,
          methodName: name,
          ok: true,
          elapsedMs: opts.clock.now() - startedAt,
          cacheHit,
          breakerState,
        });
        return result;
      } catch (err) {
        opts.emit({
          deliveryId,
          integrationName: integ.name,
          methodName: name,
          ok: false,
          elapsedMs: opts.clock.now() - startedAt,
          cacheHit,
          breakerState,
        });
        throw err;
      }
    };
  }
  return wrapped as IntegrationAdapter<IntegrationMethods>;
}
