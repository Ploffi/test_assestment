/**
 * Storage interfaces for long-lived rule state (ADR-006, ADR-007, ADR-008).
 *
 * Both stores ship with in-memory defaults that are explicitly dev/demo only
 * (unbounded, no eviction). Production consumers pass persistent backends
 * (Redis, SQLite, etc.) that conform to these interfaces.
 */

/* ============================================================ *
 * Aggregation (ADR-006)
 * ============================================================ */

/** One projected entry in an aggregation window. */
export interface AggregationEntry {
  /** ms since epoch — rule's `.aggregate.at(ctx)` or `ctx.now` fallback. */
  at: number;
  /** Original webhook delivery for correlation / dedup. */
  deliveryId: string;
  /**
   * Whatever the aggregated action's `.transform(ctx)` returned.
   *
   * Intentionally `any` — the action author wrote `.transform` and reads it
   * back in `.fn`; we don't propagate per-action types through storage
   * because that would couple the backend to the rule registry (ADR-006).
   */
  payload: any;
}

/**
 * Append-window store keyed by `(ruleId, actionId, keyId)` (ADR-006).
 *
 * Two aggregated actions on the same rule have independent buckets — each
 * stores what its own `.transform` produced. Two rules that happen to share
 * a key value still do not share buckets.
 */
export interface AggregationStore {
  /** Append a projected entry to the bucket. */
  append(
    ruleId: string,
    actionId: string,
    keyId: string,
    entry: AggregationEntry,
  ): Promise<void>;

  /** Entries in `[now − windowMs, now]`. */
  list(
    ruleId: string,
    actionId: string,
    keyId: string,
    windowMs: number,
  ): Promise<AggregationEntry[]>;

  /** Count in `[now − windowMs, now]` — cheap path; backends typically have a dedicated op. */
  count(
    ruleId: string,
    actionId: string,
    keyId: string,
    windowMs: number,
  ): Promise<number>;

  /**
   * Optional atomic `append + count` for distributed backends. Default impl
   * composes `append()` + `count()`; adequate single-process / in-memory.
   */
  appendAndCount?(
    ruleId: string,
    actionId: string,
    keyId: string,
    entry: AggregationEntry,
    windowMs: number,
  ): Promise<number>;

  /** Optional sweeper; in-memory runs this on a ~10s timer, Redis no-ops. */
  prune?(olderThanMs: number): Promise<void>;
}

/* ============================================================ *
 * Scheduled checks (ADR-007)
 * ============================================================ */

/** A pending deferred check returned by `ScheduledStore.claim`. */
export interface ScheduledCheck {
  ruleId: string;
  keyId: string;
  runAt: number;
  scheduledAt: number;
  deadline?: number;
  /** Whatever the rule's `.schedule.transform(ctx)` returned. */
  payload: any;
}

/** Outcome of a scheduled rule's `.check(ctx)` function (ADR-007). */
export type CheckResult =
  | { kind: 'pass' }
  | { kind: 'skip' }
  | { kind: 'recheck'; after: string | number };

/**
 * Single-record-per-key store for scheduled checks (ADR-007).
 *
 * Separate interface from `AggregationStore` because the operations are
 * incompatible: claim-with-lease, in-place reschedule, delete-on-completion
 * (vs. append-only window queries).
 */
export interface ScheduledStore {
  /** Enqueue a deferred check. Replaces any existing record for `(ruleId, keyId)`. */
  enqueue(
    ruleId: string,
    keyId: string,
    runAt: number,
    payload: any,
    scheduledAt: number,
    deadline?: number,
  ): Promise<void>;

  /**
   * Atomically claim due records (`runAt <= now`). `leaseMs` fences the claim
   * for distributed backends; in-memory single-process passes `0` / ignores.
   */
  claim(now: number, limit: number, leaseMs: number): Promise<ScheduledCheck[]>;

  /** Remove a record (pass or skip outcome). */
  remove(ruleId: string, keyId: string): Promise<void>;

  /** Update `runAt` (recheck outcome). Engine validates against `deadline` first. */
  reschedule(ruleId: string, keyId: string, newRunAt: number): Promise<void>;
}
