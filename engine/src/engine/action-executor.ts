import type { PendingAction } from './actions.js';

export async function runPendingActions(
  pending: PendingAction[],
  multipleErrorMessage: string,
): Promise<void> {
  if (pending.length === 0) return;
  const settled = await Promise.allSettled(pending.map((p) => p.fn()));
  const errors: unknown[] = [];
  for (const s of settled) {
    if (s.status === 'rejected') errors.push(s.reason);
  }
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];

  const errObjs = errors.map((e) => (e instanceof Error ? e : new Error(String(e))));
  if (typeof AggregateError !== 'undefined') {
    throw new AggregateError(errObjs, multipleErrorMessage);
  }
  const err = new Error(multipleErrorMessage) as Error & { errors: Error[] };
  err.errors = errObjs;
  throw err;
}
