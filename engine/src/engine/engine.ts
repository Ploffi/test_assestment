import type {
  EngineOptions,
  RuleEngine,
  RegisterBatch,
  EvaluateOptions,
} from '../public/engine.js';
import { createConsoleLogger } from '../public/logger.js';
import type { Registry } from '../internal/registry.js';
import type { MemoSlot } from '../internal/eval-context.js';
import type {
  EngineEventName,
  EngineEventPayload,
  ScheduledOutcome,
} from '../public/emitter.js';
import { EngineNotReadyError } from '../public/register.js';
import type {
  RegisteredAction,
  RegisteredAggregatedAction,
  RegisteredScheduledAction,
  EventEnvelope,
  WebhookEventName,
  ScheduledCtx,
  Clock,
  Timer,
  Logger,
  AggregationStore,
  ScheduledStore,
  CheckCtx,
  CheckResult,
  RuleStrategy,
  ScheduledCheck,
  AnyEventPayload,
  BaseCtx,
  ScheduledView,
} from '../public/index.js';

import { SystemClock } from '../utility/clock.js';
import { createInMemoryAggregationStore } from '../utility/aggregation-store.js';
import { createInMemoryScheduledStore } from '../utility/scheduled-store.js';
import { parseDuration } from './duration.js';
import { buildRegistry } from './registration.js';
import { EngineEmitter } from './emitter.js';
import { bindIntegrations, makeBaseCtx } from './context.js';
import {
  type PendingAction,
  mergeActionArgs,
  queueAggregatedAction,
  queuePlainAction,
} from './actions.js';
import { evaluateWhen } from './predicates.js';

type ScheduledPlainActionCtx = BaseCtx<AnyEventPayload, unknown> & {
  scheduled: ScheduledView;
};

class EngineImpl implements RuleEngine {
  private clock: Clock;
  private aggStore: AggregationStore;
  private schedStore: ScheduledStore;
  private logger: Logger;
  private evalTimeoutMs: number;
  private schedPollMs: number;
  private registry: Registry | null = null;
  private events = new EngineEmitter();
  private inflight = new Set<Promise<unknown>>();
  private evalControllers = new Set<AbortController>();
  private started = false;
  private stopped = false;
  private schedTimer: Timer | null = null;

  constructor(opts: EngineOptions = {}) {
    this.clock = opts.clock ?? SystemClock;
    this.aggStore = opts.aggregationStore ?? createInMemoryAggregationStore({ clock: this.clock });
    this.schedStore = opts.scheduledStore ?? createInMemoryScheduledStore();
    this.logger = opts.logger ?? createConsoleLogger();
    this.evalTimeoutMs = opts.evaluationTimeoutMs ?? 15_000;
    const requestedPoll = opts.scheduledPollMs ?? 10_000;
    this.schedPollMs = Math.max(10_000, requestedPoll);
  }

  /* ============================================================ *
   * register
   * ============================================================ */

  register(batch: RegisterBatch): void {
    this.registry = buildRegistry(batch, {
      clock: this.clock,
      emitExternalCall: (event) => this.emit('external.call', event),
    });
  }

  /* ============================================================ *
   * on / off
   * ============================================================ */

  on<N extends EngineEventName>(eventName: N, cb: (p: EngineEventPayload<N>) => void): void {
    this.events.on(eventName, cb);
  }

  off<N extends EngineEventName>(eventName: N, cb: (p: EngineEventPayload<N>) => void): void {
    this.events.off(eventName, cb);
  }

  private emit<N extends EngineEventName>(eventName: N, payload: EngineEventPayload<N>): void {
    this.events.emit(eventName, payload);
  }

  /* ============================================================ *
   * start / stop
   * ============================================================ */

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.scheduleNextTick();
  }

  private scheduleNextTick(): void {
    if (!this.started || this.stopped) return;
    this.schedTimer = this.clock.setTimeout(() => {
      this.schedTimer = null;
      this.runTick();
    }, this.schedPollMs);
  }

  private runTick(): void {
    // Re-arm the next tick synchronously so the cascade continues even while
    // this tick's async work is suspended on the store.
    this.scheduleNextTick();
    if (this.stopped || !this.registry) return;
    const work = this.processClaim();
    this.inflight.add(work);
    work.then(
      () => this.inflight.delete(work),
      () => this.inflight.delete(work),
    );
  }

  private async processClaim(): Promise<void> {
    try {
      const now = this.clock.now();
      const leaseMs = Math.max(this.schedPollMs * 2, 30_000);
      const claimed = await this.schedStore.claim(now, 100, leaseMs);
      for (const rec of claimed) {
        try {
          await this.runScheduledCheck(rec);
        } catch (err) {
          this.emit('evaluation.failed', {
            deliveryId: `scheduler:${rec.ruleId}:${rec.keyId}`,
            error: err,
          });
        }
      }
    } catch (err) {
      this.emit('evaluation.failed', { deliveryId: 'scheduler', error: err });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    for (const controller of this.evalControllers) {
      try { controller.abort(new Error('engine stopped')); } catch { /* */ }
    }
    if (this.schedTimer) {
      this.schedTimer.cancel();
      this.schedTimer = null;
    }
    const pending = [...this.inflight];
    await Promise.allSettled(pending);
  }

  /* ============================================================ *
   * evaluate
   * ============================================================ */

  evaluate(envelope: EventEnvelope, opts?: EvaluateOptions): Promise<void> {
    if (!this.registry) return Promise.reject(new EngineNotReadyError());
    const promise = this.runEvaluation(envelope, opts);
    this.inflight.add(promise);
    promise.then(
      () => this.inflight.delete(promise),
      () => this.inflight.delete(promise),
    );
    return promise;
  }

  private async runEvaluation(envelope: EventEnvelope, opts?: EvaluateOptions): Promise<void> {
    const registry = this.registry!;
    const deliveryId = opts?.deliveryId ?? envelope.deliveryId;
    const startedAt = this.clock.now();

    const controller = new AbortController();
    this.evalControllers.add(controller);
    const watchdog = this.clock.setTimeout(() => {
      try { controller.abort(new Error('evaluation timeout')); } catch { /* */ }
    }, this.evalTimeoutMs);
    let userAbortHandler: (() => void) | null = null;
    const userSignal = opts?.signal;
    if (userSignal) {
      if (userSignal.aborted) {
        try { controller.abort(userSignal.reason); } catch { /* */ }
      } else {
        userAbortHandler = () => {
          try { controller.abort(userSignal.reason); } catch { /* */ }
        };
        userSignal.addEventListener('abort', userAbortHandler);
      }
    }

    const abortPromise = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      controller.signal.addEventListener('abort', () => {
        reject(new Error('aborted'));
      });
    });
    // Swallow unhandled rejection if the main evaluation wins the race.
    abortPromise.catch(() => {});

    const mainPromise = this.doEvaluate(envelope, deliveryId, startedAt, controller.signal, registry);
    // Swallow unhandled rejection if the abort wins the race.
    mainPromise.catch(() => {});

    try {
      const result = await Promise.race([mainPromise, abortPromise]);
      this.emit('evaluation.completed', {
        deliveryId,
        matchedCount: result.matchedCount,
        totalElapsedMs: this.clock.now() - startedAt,
      });
    } catch (err) {
      this.emit('evaluation.failed', { deliveryId, error: err });
      throw err;
    } finally {
      this.evalControllers.delete(controller);
      watchdog.cancel();
      if (userSignal && userAbortHandler) {
        userSignal.removeEventListener('abort', userAbortHandler);
      }
    }
  }

  private async doEvaluate(
    envelope: EventEnvelope,
    deliveryId: string,
    startedAt: number,
    signal: AbortSignal,
    registry: Registry,
  ): Promise<{ matchedCount: number }> {
    const rules = registry.dispatch.get(envelope.name) ?? [];
    const memo = new Map<string, MemoSlot>();
    const pending: PendingAction[] = [];
    let matchedCount = 0;

    for (const rule of rules) {
      this.throwIfAborted(signal);
      const ruleStartedAt = this.clock.now();
      const ruleArgs = (rule.pinnedArgs ?? {}) as Record<string, unknown>;
      const baseCtx = makeBaseCtx({
        envelope,
        deliveryId,
        startedAt,
        signal,
        registry,
        args: ruleArgs,
        logger: this.logger,
        ruleId: rule.name,
      });
      let whenResult = true;
      if (rule.when !== undefined) {
        whenResult = await evaluateWhen({
          node: rule.when,
          ctx: baseCtx,
          memo,
          registry,
          deliveryId,
          clock: this.clock,
          emitPredicateEvaluated: (event) => this.emit('predicate.evaluated', event),
        });
        this.throwIfAborted(signal);
      }
      if (!whenResult) {
        this.emit('rule.skipped', { deliveryId, ruleId: rule.name, reason: 'when-false' });
        continue;
      }

      const strat = rule.strategy as RuleStrategy;

      if (strat.kind === 'plain') {
        this.throwIfAborted(signal);
        matchedCount++;
        this.emit('rule.matched', { deliveryId, ruleId: rule.name, elapsedMs: this.clock.now() - ruleStartedAt });
        for (const att of rule.actions) {
          queuePlainAction(pending, att, baseCtx, registry);
        }
      } else if (strat.kind === 'aggregate') {
        this.throwIfAborted(signal);
        const keyId = strat.key(baseCtx);
        const at = strat.at ? strat.at(baseCtx) : baseCtx.now;
        const windowMs = parseDuration(strat.window);
        let ruleFired = false;

        for (const att of rule.actions) {
          const action = registry.actionByName.get(att.name);
          if (!action) continue;
          if (action.kind === 'aggregatedAction') {
            const agg = action as RegisteredAggregatedAction<string, WebhookEventName, any, any>;
            const payload = agg.transform(baseCtx);
            this.throwIfAborted(signal);
            const entry = { at, deliveryId, payload };
            let count: number;
            if (typeof this.aggStore.appendAndCount === 'function') {
              count = await this.aggStore.appendAndCount(rule.name, agg.name, keyId, entry, windowMs);
            } else {
              await this.aggStore.append(rule.name, agg.name, keyId, entry);
              count = await this.aggStore.count(rule.name, agg.name, keyId, windowMs);
            }
            this.emit('aggregate.appended', {
              deliveryId,
              ruleId: rule.name,
              actionId: agg.name,
              keyId,
              count,
            });
            if (count >= strat.count) {
              ruleFired = true;
              queueAggregatedAction(pending, {
                aggStore: this.aggStore,
                rule,
                agg,
                att,
                baseCtx,
                keyId,
                windowMs,
              });
            }
          }
        }
        if (ruleFired) {
          matchedCount++;
          this.emit('rule.matched', { deliveryId, ruleId: rule.name, elapsedMs: this.clock.now() - ruleStartedAt });
          for (const att of rule.actions) {
            const action = registry.actionByName.get(att.name);
            if (action && action.kind === 'action') {
              queuePlainAction(pending, att, baseCtx, registry);
            }
          }
        } else {
          this.emit('rule.skipped', { deliveryId, ruleId: rule.name, reason: 'aggregate-below-threshold' });
        }
      } else if (strat.kind === 'schedule') {
        this.throwIfAborted(signal);
        const keyId = strat.key(baseCtx);
        const payload = strat.transform(baseCtx);
        const now = this.clock.now();
        const runAt = now + parseDuration(strat.delay);
        const deadline = strat.deadline !== undefined ? now + parseDuration(strat.deadline) : undefined;
        await this.schedStore.enqueue(rule.name, keyId, runAt, payload, now, deadline);
        this.emit('scheduled.enqueued', { ruleId: rule.name, keyId, runAt });
        this.emit('rule.skipped', { deliveryId, ruleId: rule.name, reason: 'scheduled-enqueued' });
      }
    }

    // Run all queued actions in parallel with isolation
    if (pending.length > 0) {
      this.throwIfAborted(signal);
      const settled = await Promise.allSettled(pending.map((p) => p.fn()));
      const errors: unknown[] = [];
      for (const s of settled) {
        if (s.status === 'rejected') errors.push(s.reason);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        // AggregateError available in modern runtimes
        const errObjs = errors.map((e) => (e instanceof Error ? e : new Error(String(e))));
        if (typeof AggregateError !== 'undefined') {
          throw new AggregateError(errObjs, 'multiple actions failed');
        }
        const err = new Error('multiple actions failed') as Error & { errors: Error[] };
        err.errors = errObjs;
        throw err;
      }
    }

    return { matchedCount };
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    const reason = signal.reason;
    throw reason instanceof Error ? reason : new Error('aborted');
  }

  /* ============================================================ *
   * scheduled rule check
   * ============================================================ */

  private async runScheduledCheck(rec: ScheduledCheck): Promise<void> {
    const registry = this.registry;
    if (!registry) return;
    const rule = registry.rules.get(rec.ruleId);
    if (!rule || rule.strategy.kind !== 'schedule') {
      await this.schedStore.remove(rec.ruleId, rec.keyId);
      return;
    }
    const strat = rule.strategy as Extract<RuleStrategy, { kind: 'schedule' }>;
    const ranAt = this.clock.now();
    const controller = new AbortController();
    const watchdog = this.clock.setTimeout(() => {
      try { controller.abort(); } catch { /* */ }
    }, this.evalTimeoutMs);

    const checkCtx: CheckCtx = {
      args: rule.pinnedArgs,
      payload: rec.payload,
      scheduledAt: rec.scheduledAt,
      signal: controller.signal,
      deliveryId: `scheduler:${rec.ruleId}:${rec.keyId}`,
      now: ranAt,
      logger: this.logger.child({ deliveryId: `scheduler:${rec.ruleId}:${rec.keyId}`, ruleId: rec.ruleId }),
      integrations: bindIntegrations(registry, `scheduler:${rec.ruleId}:${rec.keyId}`),
    };

    let result: CheckResult;
    try {
      const abortPromise = new Promise<never>((_, reject) => {
        if (controller.signal.aborted) {
          reject(new Error('aborted'));
          return;
        }
        controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      abortPromise.catch(() => {});
      const checkPromise = Promise.resolve(strat.check(checkCtx));
      checkPromise.catch(() => {});
      result = await Promise.race([checkPromise, abortPromise]);
    } catch {
      result = { kind: 'skip' };
    } finally {
      watchdog.cancel();
    }

    if (result.kind === 'pass') {
      // The original webhook payload was discarded when the scheduled record was stored.
      const emptyEventPayload = {} as AnyEventPayload;
      const baseCtx = makeBaseCtx({
        envelope: { name: rule.eventName, payload: emptyEventPayload, deliveryId: checkCtx.deliveryId },
        deliveryId: checkCtx.deliveryId,
        startedAt: ranAt,
        signal: controller.signal,
        registry,
        args: rule.pinnedArgs,
        logger: this.logger,
        ruleId: rule.name,
      });
      const scheduledView = {
        payload: rec.payload,
        scheduledAt: rec.scheduledAt,
        ranAt,
        keyId: rec.keyId,
      };
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
      const settled = await Promise.allSettled(pending.map((p) => p.fn()));
      const errors = settled.filter((s) => s.status === 'rejected').map((s) => (s as PromiseRejectedResult).reason);
      if (errors.length) {
        if (errors.length === 1) throw errors[0];
        throw new AggregateError(errors as Error[], 'scheduled actions failed');
      }
      await this.schedStore.remove(rec.ruleId, rec.keyId);
      this.emit('scheduled.checked', {
        ruleId: rec.ruleId,
        keyId: rec.keyId,
        outcome: 'pass' as ScheduledOutcome,
      });
    } else if (result.kind === 'skip') {
      await this.schedStore.remove(rec.ruleId, rec.keyId);
      this.emit('scheduled.checked', { ruleId: rec.ruleId, keyId: rec.keyId, outcome: 'skip' as ScheduledOutcome });
    } else if (result.kind === 'recheck') {
      const newRunAt = this.clock.now() + parseDuration(result.after);
      if (rec.deadline !== undefined && newRunAt > rec.deadline) {
        await this.schedStore.remove(rec.ruleId, rec.keyId);
        this.emit('scheduled.checked', {
          ruleId: rec.ruleId,
          keyId: rec.keyId,
          outcome: 'deadline_exceeded' as ScheduledOutcome,
        });
      } else {
        await this.schedStore.reschedule(rec.ruleId, rec.keyId, newRunAt);
        this.emit('scheduled.checked', { ruleId: rec.ruleId, keyId: rec.keyId, outcome: 'recheck' as ScheduledOutcome });
      }
    }
  }
}

export function createEngine(opts: EngineOptions = {}): RuleEngine {
  return new EngineImpl(opts);
}
