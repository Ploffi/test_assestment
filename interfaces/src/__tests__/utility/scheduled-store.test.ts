/**
 * Unit tests for `createInMemoryScheduledStore` (ADR-007).
 *
 * Covers:
 *  - enqueue → claim → remove / reschedule lifecycle
 *  - duplicate (ruleId, keyId) enqueue replaces the record
 *  - claim returns only due records (runAt ≤ now), sorted by runAt
 *  - claim limit caps the batch
 *  - leaseMs > 0 fences subsequent claims until the lease expires
 *  - leaseMs = 0 is a no-op (single-process mode)
 *  - remove and reschedule release any prior lease
 *  - missing records are no-ops on remove / reschedule
 */

import { describe, test, expect } from 'vitest';

import { createInMemoryScheduledStore } from '../../utility/scheduled-store.js';

describe('createInMemoryScheduledStore — enqueue + claim basics', () => {
  test('enqueue then claim returns the record', async () => {
    const store = createInMemoryScheduledStore();
    await store.enqueue('r', 'k', 100, { p: 'payload' }, 50, undefined);
    const claimed = await store.claim(200, 10, 0);
    expect(claimed.length).toBe(1);
    expect(claimed[0]?.ruleId).toBe('r');
    expect(claimed[0]?.keyId).toBe('k');
    expect(claimed[0]?.runAt).toBe(100);
    expect(claimed[0]?.scheduledAt).toBe(50);
    expect(claimed[0]?.payload).toEqual({ p: 'payload' });
  });

  test('claim excludes records whose runAt > now', async () => {
    const store = createInMemoryScheduledStore();
    await store.enqueue('r', 'past', 100, {}, 50);
    await store.enqueue('r', 'future', 1_000, {}, 50);
    const claimed = await store.claim(500, 10, 0);
    expect(claimed.length).toBe(1);
    expect(claimed[0]?.keyId).toBe('past');
  });

  test('claim returns due records sorted by runAt ascending', async () => {
    const store = createInMemoryScheduledStore();
    await store.enqueue('r', 'b', 200, {}, 0);
    await store.enqueue('r', 'a', 100, {}, 0);
    await store.enqueue('r', 'c', 150, {}, 0);

    const claimed = await store.claim(1_000, 10, 0);
    expect(claimed.map((c) => c.keyId)).toEqual(['a', 'c', 'b']);
  });

  test('claim limit caps the size of the returned batch', async () => {
    const store = createInMemoryScheduledStore();
    for (let i = 0; i < 5; i++) {
      await store.enqueue('r', `k${i}`, i * 10, {}, 0);
    }
    const got = await store.claim(1_000, 2, 0);
    // limit=2 → only the two earliest records are returned.
    expect(got.length).toBe(2);
    expect(got.map((c) => c.keyId)).toEqual(['k0', 'k1']);
  });

  test('limit + lease: subsequent claim sees the un-leased remainder', async () => {
    const store = createInMemoryScheduledStore();
    for (let i = 0; i < 5; i++) {
      await store.enqueue('r', `k${i}`, i * 10, {}, 0);
    }
    const first = await store.claim(1_000, 2, /* leaseMs */ 5_000);
    expect(first.length).toBe(2);
    // The two leased records are fenced; the next claim sees the remaining
    // three (which were never returned in the first call due to the limit).
    const second = await store.claim(1_000, 10, 0);
    expect(second.length).toBe(3);
    expect(second.map((c) => c.keyId).sort()).toEqual(['k2', 'k3', 'k4']);
  });
});

describe('createInMemoryScheduledStore — duplicate enqueue replaces', () => {
  test('latest enqueue wins for the same (ruleId, keyId)', async () => {
    const store = createInMemoryScheduledStore();
    await store.enqueue('r', 'k', 100, { v: 1 }, 50, undefined);
    await store.enqueue('r', 'k', 200, { v: 2 }, 150, undefined);

    const claimed = await store.claim(1_000, 10, 0);
    expect(claimed.length).toBe(1);
    expect(claimed[0]?.runAt).toBe(200);
    expect(claimed[0]?.payload).toEqual({ v: 2 });
  });
});

describe('createInMemoryScheduledStore — leases', () => {
  test('leaseMs > 0 fences subsequent claims for the lease window', async () => {
    const store = createInMemoryScheduledStore();
    await store.enqueue('r', 'k', 100, {}, 50);

    const first = await store.claim(1_000, 10, /* leaseMs */ 5_000);
    expect(first.length).toBe(1);

    // Within the lease, the record is invisible to a second claim.
    const inLease = await store.claim(1_500, 10, 0);
    expect(inLease.length).toBe(0);

    // Past the lease (now > leased_until), reclaimable.
    const afterLease = await store.claim(1_000 + 5_001, 10, 0);
    expect(afterLease.length).toBe(1);
  });

  test('leaseMs = 0 means no fencing — the next claim sees the record again', async () => {
    const store = createInMemoryScheduledStore();
    await store.enqueue('r', 'k', 100, {}, 50);

    const a = await store.claim(1_000, 10, 0);
    const b = await store.claim(1_000, 10, 0);
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
  });

  test('remove() releases the lease', async () => {
    const store = createInMemoryScheduledStore();
    await store.enqueue('r', 'k', 100, {}, 50);
    await store.claim(1_000, 10, 5_000);
    await store.remove('r', 'k');

    // Re-enqueue with same key; the prior lease must not block it.
    await store.enqueue('r', 'k', 200, {}, 150);
    const claimed = await store.claim(1_500, 10, 0);
    expect(claimed.length).toBe(1);
    expect(claimed[0]?.runAt).toBe(200);
  });

  test('reschedule() releases the lease so the new runAt can be claimed', async () => {
    const store = createInMemoryScheduledStore();
    await store.enqueue('r', 'k', 100, {}, 50);
    await store.claim(1_000, 10, 5_000);

    await store.reschedule('r', 'k', 2_000);
    const claimed = await store.claim(2_500, 10, 0);
    expect(claimed.length).toBe(1);
    expect(claimed[0]?.runAt).toBe(2_000);
  });
});

describe('createInMemoryScheduledStore — remove + reschedule', () => {
  test('remove() drops the record (subsequent claim is empty)', async () => {
    const store = createInMemoryScheduledStore();
    await store.enqueue('r', 'k', 100, {}, 50);
    await store.remove('r', 'k');
    const claimed = await store.claim(1_000, 10, 0);
    expect(claimed.length).toBe(0);
  });

  test('remove() on a missing key is a no-op', async () => {
    const store = createInMemoryScheduledStore();
    await store.remove('does-not-exist', 'either');
    // No throw; nothing to assert beyond reaching here.
  });

  test('reschedule() shifts runAt; new value used in subsequent claim', async () => {
    const store = createInMemoryScheduledStore();
    await store.enqueue('r', 'k', 100, {}, 50);
    await store.reschedule('r', 'k', 1_000);

    const tooEarly = await store.claim(500, 10, 0);
    expect(tooEarly.length).toBe(0);

    const onTime = await store.claim(1_000, 10, 0);
    expect(onTime.length).toBe(1);
    expect(onTime[0]?.runAt).toBe(1_000);
  });

  test('reschedule() preserves payload + scheduledAt + deadline', async () => {
    const store = createInMemoryScheduledStore();
    await store.enqueue('r', 'k', 100, { kept: true }, 50, 5_000);
    await store.reschedule('r', 'k', 200);
    const claimed = await store.claim(500, 10, 0);
    expect(claimed[0]?.scheduledAt).toBe(50);
    expect(claimed[0]?.deadline).toBe(5_000);
    expect(claimed[0]?.payload).toEqual({ kept: true });
  });

  test('reschedule() on a missing record is a no-op', async () => {
    const store = createInMemoryScheduledStore();
    await store.reschedule('r', 'k', 100);
    const claimed = await store.claim(1_000, 10, 0);
    expect(claimed.length).toBe(0);
  });
});

describe('createInMemoryScheduledStore — multiple rules / keys', () => {
  test('records are isolated across rules and keys', async () => {
    const store = createInMemoryScheduledStore();
    await store.enqueue('r1', 'k', 100, { from: 'r1' }, 50);
    await store.enqueue('r2', 'k', 100, { from: 'r2' }, 50);
    await store.enqueue('r1', 'k2', 100, { from: 'r1-k2' }, 50);

    const claimed = await store.claim(1_000, 10, 0);
    expect(claimed.length).toBe(3);
    const seen = new Set(
      claimed.map((c) => `${c.ruleId}:${c.keyId}`),
    );
    expect(seen.has('r1:k')).toBe(true);
    expect(seen.has('r2:k')).toBe(true);
    expect(seen.has('r1:k2')).toBe(true);
  });
});
