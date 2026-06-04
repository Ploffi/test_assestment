/**
 * In-memory `ScheduledStore` (ADR-007, ADR-008).
 *
 * Dev / demo / test only — unbounded `Map`, no cross-process leases.
 * `claim` is still safe within one process via the in-memory lease map;
 * multi-replica deployments must swap in a backend that fences claims
 * across processes (Redis `SET NX EX`, SQLite `UPDATE ... WHERE
 * leased_until < ?`).
 *
 * Layout: `ruleId → keyId → ScheduledCheck`. Lease lookups by composite
 * `${ruleId}:${keyId}` key.
 *
 * No clock injection — `claim` receives `now` from the caller (the
 * engine's scheduler tick), so the store itself never reads time.
 */

import type {
  ScheduledStore,
  ScheduledCheck,
} from '../public/stores.js';

export function createInMemoryScheduledStore(): ScheduledStore {
  // ruleId → keyId → record
  const records = new Map<string, Map<string, ScheduledCheck>>();
  // "${ruleId}:${keyId}" → leasedUntil (ms). Absent ⇒ unleased.
  const leases = new Map<string, number>();

  const leaseKey = (ruleId: string, keyId: string): string =>
    `${ruleId}:${keyId}`;

  const ensureByKey = (ruleId: string): Map<string, ScheduledCheck> => {
    let byKey = records.get(ruleId);
    if (!byKey) {
      byKey = new Map();
      records.set(ruleId, byKey);
    }
    return byKey;
  };

  return {
    async enqueue(
      ruleId,
      keyId,
      runAt,
      payload,
      scheduledAt,
      deadline,
    ): Promise<void> {
      // Replaces any existing record for (ruleId, keyId) — ADR-007.
      const byKey = ensureByKey(ruleId);
      byKey.set(keyId, {
        ruleId,
        keyId,
        runAt,
        scheduledAt,
        deadline,
        payload,
      });
      // A fresh enqueue invalidates any prior lease — the new triggering
      // event supersedes the older check (e.g., user reopened + reclosed).
      leases.delete(leaseKey(ruleId, keyId));
    },

    async claim(now, limit, leaseMs): Promise<ScheduledCheck[]> {
      const candidates: ScheduledCheck[] = [];
      for (const byKey of records.values()) {
        for (const rec of byKey.values()) {
          if (rec.runAt > now) continue;
          const lk = leaseKey(rec.ruleId, rec.keyId);
          const until = leases.get(lk);
          // Skip records currently leased by an in-flight claim.
          if (until !== undefined && until > now) continue;
          candidates.push(rec);
        }
      }
      candidates.sort((a, b) => a.runAt - b.runAt);

      const claimed = candidates.slice(0, Math.max(0, limit));
      if (leaseMs > 0) {
        for (const rec of claimed) {
          leases.set(leaseKey(rec.ruleId, rec.keyId), now + leaseMs);
        }
      }
      return claimed;
    },

    async remove(ruleId, keyId): Promise<void> {
      const byKey = records.get(ruleId);
      if (byKey) byKey.delete(keyId);
      leases.delete(leaseKey(ruleId, keyId));
    },

    async reschedule(ruleId, keyId, newRunAt): Promise<void> {
      const byKey = records.get(ruleId);
      const rec = byKey?.get(keyId);
      if (!byKey || !rec) return;
      byKey.set(keyId, { ...rec, runAt: newRunAt });
      // Successful reschedule releases the prior lease — the next tick
      // can pick this record up at the new `runAt`.
      leases.delete(leaseKey(ruleId, keyId));
    },
  };
}
