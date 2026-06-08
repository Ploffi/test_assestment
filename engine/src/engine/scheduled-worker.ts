import type { Registry } from '../internal/registry.js';
import type {
  Clock,
  CheckResult,
  Logger,
  RegisteredAction,
  RegisteredScheduledAction,
  RuleStrategy,
  ScheduledCheck,
  ScheduledCtx,
  ScheduledStore,
  Timer,
} from '../public/index.js';
import type { ScheduledOutcome } from '../public/emitter.js';
import type { EngineEmit } from './utility/emitter.js';
import type { PendingAction } from './actions.js';
import { mergeActionArgs } from './actions.js';
import { runPendingActions } from './action-executor.js';
import { CancellationScope, throwIfAborted } from './utility/cancellation.js';
import {
  type ScheduledPlainActionCtx,
  makeScheduledBaseCtx,
  makeScheduledCheckCtx,
  makeScheduledView,
  scheduledDeliveryId,
} from './utility/context-factories.js';
import { parseDuration } from './utility/duration.js';

const DEFAULT_SCHEDULED_MAX_ATTEMPTS = 10;

export interface ScheduledWorkerOptions {
  clock: Clock;
  schedStore: ScheduledStore;
  logger: Logger;
  evalTimeoutMs: number;
  schedPollMs: number;
  getRegistry(): Registry | null;
  emit: EngineEmit;
}

export class ScheduledWorker {
  private started = false;
  private stopped = false;
  private schedTimer: Timer | null = null;
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly scopes = new Set<CancellationScope>();
  private readonly attempts = new Map<string, number>();

  constructor(private readonly opts: ScheduledWorkerOptions) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.scheduleNextTick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    if (this.schedTimer) {
      this.schedTimer.cancel();
      this.schedTimer = null;
    }
    for (const scope of this.scopes) {
      scope.abort(new Error('scheduler stopped'));
    }
    await Promise.allSettled([...this.inflight]);
  }

  private scheduleNextTick(): void {
    if (!this.started || this.stopped) return;
    this.schedTimer = this.opts.clock.setTimeout(() => {
      this.schedTimer = null;
      this.runTick();
    }, this.opts.schedPollMs);
  }

  private runTick(): void {
    // Re-arm synchronously so ManualClock sweeps keep scheduler cascades alive.
    this.scheduleNextTick();
    if (this.stopped || !this.opts.getRegistry()) return;
    const work = this.processClaim();
    this.inflight.add(work);
    work.then(
      () => this.inflight.delete(work),
      () => this.inflight.delete(work),
    );
  }

  private async processClaim(): Promise<void> {
    try {
      const now = this.opts.clock.now();
      const leaseMs = Math.max(this.opts.schedPollMs * 2, 30_000);
      const claimed = await this.opts.schedStore.claim(now, 100, leaseMs);
      for (const rec of claimed) {
        try {
          await this.runScheduledCheck(rec);
          this.clearAttempts(rec);
        } catch (err) {
          this.opts.emit('evaluation.failed', {
            deliveryId: scheduledDeliveryId(rec),
            error: err,
          });
          await this.handleScheduledFailure(rec);
        }
      }
    } catch (err) {
      this.opts.emit('evaluation.failed', { deliveryId: 'scheduler', error: err });
    }
  }

  private async runScheduledCheck(rec: ScheduledCheck): Promise<void> {
    const registry = this.opts.getRegistry();
    if (!registry) return;
    const rule = registry.rules.get(rec.ruleId);
    if (!rule || rule.strategy.kind !== 'schedule') {
      await this.opts.schedStore.remove(rec.ruleId, rec.keyId);
      return;
    }

    const strat = rule.strategy as Extract<RuleStrategy, { kind: 'schedule' }>;
    const ranAt = this.opts.clock.now();
    const scope = new CancellationScope({
      clock: this.opts.clock,
      timeoutMs: this.opts.evalTimeoutMs,
    });
    this.scopes.add(scope);

    try {
      let result: CheckResult;
      try {
        const checkCtx = makeScheduledCheckCtx({
          rec,
          rule,
          registry,
          signal: scope.signal,
          ranAt,
          logger: this.opts.logger,
        });
        result = await scope.run(() => Promise.resolve(strat.check(checkCtx)));
      } catch {
        throwIfAborted(scope.signal);
        result = { kind: 'skip' } as const;
      }

      if (result.kind === 'pass') {
        throwIfAborted(scope.signal);
        const baseCtx = makeScheduledBaseCtx({
          rec,
          rule,
          registry,
          signal: scope.signal,
          ranAt,
          logger: this.opts.logger,
        });
        const scheduledView = makeScheduledView(rec, ranAt);
        const pending: PendingAction[] = [];
        for (const att of rule.actions) {
          const action = registry.actionByName.get(att.name);
          if (!action) continue;
          if (action.kind === 'scheduledAction') {
            const sched = action as RegisteredScheduledAction<string, any>;
            pending.push({
              fn: async () => {
                const mergedArgs = mergeActionArgs(sched.pinnedArgs, att.args, baseCtx, sched.argsSchema);
                const schedCtx: ScheduledCtx<any> = {
                  args: mergedArgs,
                  signal: baseCtx.signal,
                  deliveryId: baseCtx.deliveryId,
                  now: baseCtx.now,
                  logger: baseCtx.logger.child({ actionName: sched.name }),
                  integrations: baseCtx.integrations,
                  scheduled: scheduledView,
                };
                await sched.fn(schedCtx);
              },
            });
          } else if (action.kind === 'action') {
            const plain = action as RegisteredAction<string, any>;
            pending.push({
              fn: async () => {
                const mergedArgs = mergeActionArgs(plain.pinnedArgs, att.args, baseCtx, plain.argsSchema);
                const ctx: ScheduledPlainActionCtx = {
                  ...baseCtx,
                  args: mergedArgs,
                  logger: baseCtx.logger.child({ actionName: plain.name }),
                  scheduled: scheduledView,
                };
                await plain.fn(ctx);
              },
            });
          }
        }
        await scope.run(() => runPendingActions(pending, 'scheduled actions failed'));
        await this.opts.schedStore.remove(rec.ruleId, rec.keyId);
        this.emitChecked(rec.ruleId, rec.keyId, 'pass');
      } else if (result.kind === 'skip') {
        await this.opts.schedStore.remove(rec.ruleId, rec.keyId);
        this.emitChecked(rec.ruleId, rec.keyId, 'skip');
      } else if (result.kind === 'recheck') {
        const newRunAt = this.opts.clock.now() + parseDuration(result.after);
        if (rec.deadline !== undefined && newRunAt > rec.deadline) {
          await this.opts.schedStore.remove(rec.ruleId, rec.keyId);
          this.emitChecked(rec.ruleId, rec.keyId, 'deadline_exceeded');
        } else {
          await this.opts.schedStore.reschedule(rec.ruleId, rec.keyId, newRunAt);
          this.emitChecked(rec.ruleId, rec.keyId, 'recheck');
        }
      }
    } finally {
      this.scopes.delete(scope);
      scope.dispose();
    }
  }

  private emitChecked(ruleId: string, keyId: string, outcome: ScheduledOutcome): void {
    this.opts.emit('scheduled.checked', { ruleId, keyId, outcome });
  }

  private attemptKey(rec: ScheduledCheck): string {
    return `${rec.ruleId}\0${rec.keyId}\0${rec.scheduledAt}`;
  }

  private clearAttempts(rec: ScheduledCheck): void {
    this.attempts.delete(this.attemptKey(rec));
  }

  private async handleScheduledFailure(rec: ScheduledCheck): Promise<void> {
    const key = this.attemptKey(rec);
    const attempts = (this.attempts.get(key) ?? 0) + 1;
    if (attempts < DEFAULT_SCHEDULED_MAX_ATTEMPTS) {
      this.attempts.set(key, attempts);
      return;
    }

    this.attempts.delete(key);
    await this.opts.schedStore.remove(rec.ruleId, rec.keyId);
    this.emitChecked(rec.ruleId, rec.keyId, 'max_attempts_exceeded');
  }
}
