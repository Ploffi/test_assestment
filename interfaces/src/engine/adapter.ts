import type {
  RegisteredIntegration,
  IntegrationAdapter,
  IntegrationMethods,
} from '../public/integration.js';
import { canonicalJson } from './canonical.js';

export function buildAdapter(
  integ: RegisteredIntegration<string, IntegrationMethods>,
): IntegrationAdapter<IntegrationMethods> {
  const cache = integ.cache ? new Map<string, Promise<unknown>>() : null;
  const wrapped: Record<string, (input: any) => Promise<any>> = {};
  for (const [name, fn] of Object.entries(integ.methods)) {
    wrapped[name] = (input: any) => {
      if (!cache) return fn(input);
      const sansSignal = { ...(input ?? {}) };
      delete sansSignal.signal;
      const key = name + '@' + canonicalJson(sansSignal);
      const hit = cache.get(key);
      if (hit) return hit;
      const p = (async () => fn(input))().catch((err) => {
        cache.delete(key);
        throw err;
      });
      cache.set(key, p);
      return p;
    };
  }
  return wrapped as IntegrationAdapter<IntegrationMethods>;
}
