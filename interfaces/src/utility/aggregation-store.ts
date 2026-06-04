/**
 * In-memory `AggregationStore` (ADR-006, ADR-008).
 *
 * Dev / demo / test only. Unbounded `Map` — no eviction, no size cap, no
 * cross-process coordination. The store interface is the durable
 * contract; this implementation is what consumers get when they don't
 * wire Redis / SQLite.
 *
 * Layout: `ruleId → actionId → keyId → AggregationEntry[]`, with each
 * bucket maintained in sorted order by `at` (binary insertion).
 *
 * "Now" for read-side cutoffs (`list`, `count`, `prune`) is sourced from
 * an injected `Clock`. Defaults to `SystemClock`; tests pass `ManualClock`
 * so rolling-window assertions are deterministic.
 */

import type {
  AggregationStore,
  AggregationEntry,
} from '../public/stores.js';
import type { Clock } from '../public/clock.js';
import { SystemClock } from './clock.js';

export interface InMemoryAggregationStoreOpts {
  /** Time source for read-side cutoffs. Default: `SystemClock`. */
  clock?: Clock;
}

export function createInMemoryAggregationStore(
  opts: InMemoryAggregationStoreOpts = {},
): AggregationStore {
  const clock = opts.clock ?? SystemClock;

  // ruleId → actionId → keyId → entries (sorted ascending by `at`)
  const buckets = new Map<
    string,
    Map<string, Map<string, AggregationEntry[]>>
  >();

  const getBucket = (
    ruleId: string,
    actionId: string,
    keyId: string,
  ): AggregationEntry[] => {
    let byAction = buckets.get(ruleId);
    if (!byAction) {
      byAction = new Map();
      buckets.set(ruleId, byAction);
    }
    let byKey = byAction.get(actionId);
    if (!byKey) {
      byKey = new Map();
      byAction.set(actionId, byKey);
    }
    let entries = byKey.get(keyId);
    if (!entries) {
      entries = [];
      byKey.set(keyId, entries);
    }
    return entries;
  };

  // Lower bound on `arr` where `arr[i].at >= target`.
  const lowerBound = (arr: AggregationEntry[], target: number): number => {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid]!.at < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  // Insertion point preserving ascending `at` order.
  const insertSorted = (
    arr: AggregationEntry[],
    entry: AggregationEntry,
  ): void => {
    // For ties, append after — preserves insertion order among same-`at`.
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid]!.at <= entry.at) lo = mid + 1;
      else hi = mid;
    }
    arr.splice(lo, 0, entry);
  };

  return {
    async append(ruleId, actionId, keyId, entry): Promise<void> {
      const bucket = getBucket(ruleId, actionId, keyId);
      insertSorted(bucket, entry);
    },

    async list(ruleId, actionId, keyId, windowMs): Promise<AggregationEntry[]> {
      const bucket = getBucket(ruleId, actionId, keyId);
      const cutoff = clock.now() - windowMs;
      const start = lowerBound(bucket, cutoff);
      // Return a copy so callers can mutate without affecting the store.
      return bucket.slice(start);
    },

    async count(ruleId, actionId, keyId, windowMs): Promise<number> {
      const bucket = getBucket(ruleId, actionId, keyId);
      const cutoff = clock.now() - windowMs;
      return bucket.length - lowerBound(bucket, cutoff);
    },

    async appendAndCount(
      ruleId,
      actionId,
      keyId,
      entry,
      windowMs,
    ): Promise<number> {
      const bucket = getBucket(ruleId, actionId, keyId);
      insertSorted(bucket, entry);
      const cutoff = clock.now() - windowMs;
      return bucket.length - lowerBound(bucket, cutoff);
    },

    async prune(olderThanMs): Promise<void> {
      const cutoff = clock.now() - olderThanMs;
      for (const byAction of buckets.values()) {
        for (const byKey of byAction.values()) {
          for (const [keyId, entries] of byKey.entries()) {
            const start = lowerBound(entries, cutoff);
            if (start === 0) continue;
            byKey.set(keyId, entries.slice(start));
          }
        }
      }
    },
  };
}
