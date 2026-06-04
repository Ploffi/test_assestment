import type { z } from 'zod';
import type {
  EngineOptions,
  RuleEngine,
  RegisterBatch,
  EvaluateOptions,
} from '../public/engine.js';
import type {
  EngineEventName,
  EngineEventPayload,
  ScheduledOutcome,
} from '../public/emitter.js';
import {
  RegistrationError,
  EngineNotReadyError,
  type RegistrationIssue,
} from '../public/register.js';
import type {
  RegisteredPredicate,
  RegisteredAction,
  RegisteredAggregatedAction,
  RegisteredScheduledAction,
  RegisteredIntegration,
  RegisteredRule,
  AnyRegisteredAction,
  EventEnvelope,
  WebhookEventName,
  BaseCtx,
  AggregatedCtx,
  ScheduledCtx,
  AnyEventPayload,
  Clock,
  Timer,
  Logger,
  AggregationStore,
  ScheduledStore,
  WhenNode,
  AllNode,
  AnyNode,
  NotNode,
  UseRef,
  IntegrationAdapter,
  IntegrationMethods,
  CheckCtx,
  CheckResult,
  ActionAttachment,
  RuleStrategy,
} from '../public/index.js';

import { SystemClock } from '../utility/clock.js';
import { createNoopLogger } from '../utility/logger.js';
import { createInMemoryAggregationStore } from '../utility/aggregation-store.js';
import { createInMemoryScheduledStore } from '../utility/scheduled-store.js';
import { parseDuration } from './duration.js';
import { canonicalJson } from './canonical.js';
import { attachIntegrationCallContext, buildAdapter } from './adapter.js';

interface Registry {
  predicates: Map<string, RegisteredPredicate<string, any>>;
  actions: Map<string, RegisteredAction<string, any>>;
  aggregatedActions: Map<string, RegisteredAggregatedAction<string, WebhookEventName, any, any>>;
  scheduledActions: Map<string, RegisteredScheduledAction<string, any>>;
  integrations: Map<string, RegisteredIntegration<string, any>>;
  rules: Map<string, RegisteredRule<string, WebhookEventName, any>>;
  actionByName: Map<string, AnyRegisteredAction>;
  dispatch: Map<WebhookEventName, RegisteredRule<string, WebhookEventName, any>[]>;
  adapters: Record<string, IntegrationAdapter<IntegrationMethods>>;
}

interface PendingAction {
  fn: () => Promise<void>;
}

interface MemoSlot {
  promise: Promise<boolean>;
}

class EngineImpl implements RuleEngine {
  private opts: EngineOptions;
  private clock: Clock;
  private aggStore: AggregationStore;
  private schedStore: ScheduledStore;
  private logger: Logger;
  private evalTimeoutMs: number;
  private schedPollMs: number;
  private registry: Registry | null = null;
  private subs: Map<string, Set<(p: any) => void>> = new Map();
  private inflight = new Set<Promise<unknown>>();
  private evalControllers = new Set<AbortController>();
  private started = false;
  private stopped = false;
  private schedTimer: Timer | null = null;

  constructor(opts: EngineOptions = {}) {
    this.opts = opts;
    this.clock = opts.clock ?? SystemClock;
    this.aggStore = opts.aggregationStore ?? createInMemoryAggregationStore({ clock: this.clock });
    this.schedStore = opts.scheduledStore ?? createInMemoryScheduledStore();
    this.logger = opts.logger ?? createNoopLogger();
    this.evalTimeoutMs = opts.evaluationTimeoutMs ?? 15_000;
    const requestedPoll = opts.scheduledPollMs ?? 10_000;
    this.schedPollMs = Math.max(10_000, requestedPoll);
  }

  /* ============================================================ *
   * register
   * ============================================================ */

  register(batch: RegisterBatch): void {
    const issues: RegistrationIssue[] = [];
    const reg: Registry = {
      predicates: new Map(),
      actions: new Map(),
      aggregatedActions: new Map(),
      scheduledActions: new Map(),
      integrations: new Map(),
      rules: new Map(),
      actionByName: new Map(),
      dispatch: new Map(),
      adapters: {},
    };

    const addUnique = <T extends { name: string }>(
      map: Map<string, T>,
      entity: T,
      kind: RegistrationIssue['entity']['kind'],
    ) => {
      if (map.has(entity.name)) {
        issues.push({
          code: 'duplicate-name',
          entity: { kind, name: entity.name },
          message: `duplicate ${kind} name: ${entity.name}`,
        });
        return;
      }
      map.set(entity.name, entity);
    };

    for (const p of batch.predicates ?? []) addUnique(reg.predicates, p, 'predicate');
    for (const a of batch.actions ?? []) addUnique(reg.actions, a, 'action');
    for (const a of batch.aggregatedActions ?? []) addUnique(reg.aggregatedActions, a, 'aggregatedAction');
    for (const a of batch.scheduledActions ?? []) addUnique(reg.scheduledActions, a, 'scheduledAction');
    for (const i of batch.integrations ?? []) addUnique(reg.integrations, i, 'integration');
    for (const r of batch.rules ?? []) addUnique(reg.rules, r, 'rule');

    // Build unified action lookup. Rule attachments are by name only, so names
    // must be globally unique across the three action kinds.
    const addActionLookup = (a: AnyRegisteredAction): void => {
      if (reg.actionByName.has(a.name)) {
        issues.push({
          code: 'duplicate-name',
          entity: { kind: a.kind, name: a.name },
          message: `duplicate action name across action kinds: ${a.name}`,
        });
        return;
      }
      reg.actionByName.set(a.name, a);
    };
    for (const a of reg.actions.values()) addActionLookup(a);
    for (const a of reg.aggregatedActions.values()) addActionLookup(a);
    for (const a of reg.scheduledActions.values()) addActionLookup(a);

    // Pass 1: dependency graph + cross-references
    for (const r of reg.rules.values()) {
      // Walk when tree for use(name)
      const checkUse = (n: WhenNode<any, any>) => {
        if (typeof n === 'function') return;
        if ('kind' in n) {
          if (n.kind === 'use') {
            const useRef = n as UseRef;
            if (!reg.predicates.has(useRef.name)) {
              issues.push({
                code: 'unknown-predicate',
                entity: { kind: 'rule', name: r.name },
                message: `rule "${r.name}" uses unknown predicate "${useRef.name}"`,
                related: { kind: 'predicate', name: useRef.name },
              });
            }
          } else if (n.kind === 'all' || n.kind === 'any') {
            for (const c of (n as AllNode<any, any> | AnyNode<any, any>).children) checkUse(c);
          } else if (n.kind === 'not') {
            checkUse((n as NotNode<any, any>).child);
          }
        }
      };
      if (r.when) checkUse(r.when);

      // Check action attachments
      const strat = r.strategy;
      let hasAggregatedActionAttached = false;
      let hasScheduledActionAttached = false;
      for (const att of r.actions) {
        const found = reg.actionByName.get(att.name);
        if (!found) {
          issues.push({
            code: 'unknown-action',
            entity: { kind: 'rule', name: r.name },
            message: `rule "${r.name}" references unknown action "${att.name}"`,
            related: { kind: 'action', name: att.name },
          });
          continue;
        }
        if (found.kind === 'aggregatedAction') {
          hasAggregatedActionAttached = true;
          const agg = found as RegisteredAggregatedAction<string, WebhookEventName, any, any>;
          if (strat.kind !== 'aggregate') {
            issues.push({
              code: 'kind-mismatch',
              entity: { kind: 'rule', name: r.name },
              message: `aggregatedAction "${agg.name}" attached to non-aggregating rule "${r.name}"`,
              related: { kind: 'aggregatedAction', name: agg.name },
            });
          }
          if (agg.eventName !== r.eventName) {
            issues.push({
              code: 'on-mismatch',
              entity: { kind: 'rule', name: r.name },
              message: `aggregatedAction "${agg.name}" .on(${agg.eventName}) does not match rule "${r.name}" .on(${r.eventName})`,
              related: { kind: 'aggregatedAction', name: agg.name },
            });
          }
        } else if (found.kind === 'scheduledAction') {
          hasScheduledActionAttached = true;
          if (strat.kind !== 'schedule') {
            issues.push({
              code: 'kind-mismatch',
              entity: { kind: 'rule', name: r.name },
              message: `scheduledAction "${found.name}" attached to non-scheduled rule "${r.name}"`,
              related: { kind: 'scheduledAction', name: found.name },
            });
          }
        }
      }

      if (strat.kind === 'aggregate' && !hasAggregatedActionAttached) {
        issues.push({
          code: 'missing-aggregated-action',
          entity: { kind: 'rule', name: r.name },
          message: `aggregating rule "${r.name}" has no aggregatedAction attached`,
        });
      }
      if (strat.kind === 'schedule' && !hasScheduledActionAttached) {
        issues.push({
          code: 'missing-scheduled-action',
          entity: { kind: 'rule', name: r.name },
          message: `scheduled rule "${r.name}" has no scheduledAction attached`,
        });
      }
    }

    // Pass 2: schema validation on pinned args
    const validateArgs = (
      schema: z.ZodType<any> | undefined,
      pinned: unknown,
      entity: RegistrationIssue['entity'],
      partial: boolean,
    ) => {
      if (!schema || typeof (schema as any).safeParse !== 'function') return;
      // Predicate/action pinned args are Partial<Args>; rule args have no
      // use-site merge later and must be complete at registration time.
      const partialed = partial && typeof (schema as any).partial === 'function'
        ? (schema as any).partial()
        : schema;
      const result = (partialed as any).safeParse(pinned ?? {});
      if (!result.success) {
        const zerr = result.error;
        const zissues = zerr?.issues ?? zerr?.errors ?? [];
        for (const zi of zissues) {
          issues.push({
            code: 'invalid-args',
            entity,
            path: zi.path ?? [],
            message: zi.message ?? 'invalid args',
          });
        }
      }
    };

    for (const p of reg.predicates.values()) {
      validateArgs(p.argsSchema, p.pinnedArgs, { kind: 'predicate', name: p.name }, true);
    }
    for (const a of reg.actions.values()) {
      validateArgs(a.argsSchema, a.pinnedArgs, { kind: 'action', name: a.name }, true);
    }
    for (const a of reg.aggregatedActions.values()) {
      validateArgs(a.argsSchema, a.pinnedArgs, { kind: 'aggregatedAction', name: a.name }, true);
    }
    for (const a of reg.scheduledActions.values()) {
      validateArgs(a.argsSchema, a.pinnedArgs, { kind: 'scheduledAction', name: a.name }, true);
    }
    for (const r of reg.rules.values()) {
      if (r.argsSchema) validateArgs(r.argsSchema, r.pinnedArgs, { kind: 'rule', name: r.name }, false);
    }

    if (issues.length) throw new RegistrationError(issues);

    // Build dispatch index
    for (const r of reg.rules.values()) {
      let list = reg.dispatch.get(r.eventName);
      if (!list) {
        list = [];
        reg.dispatch.set(r.eventName, list);
      }
      list.push(r);
    }

    // Build adapters
    for (const i of reg.integrations.values()) {
      reg.adapters[i.name] = buildAdapter(i as RegisteredIntegration<string, IntegrationMethods>, {
        clock: this.clock,
        emit: (event) => this.emit('external.call', event),
      });
    }

    this.registry = reg;
  }

  /* ============================================================ *
   * on / off
   * ============================================================ */

  on<N extends EngineEventName>(eventName: N, cb: (p: EngineEventPayload<N>) => void): void {
    let set = this.subs.get(eventName as string);
    if (!set) {
      set = new Set();
      this.subs.set(eventName as string, set);
    }
    set.add(cb as (p: any) => void);
  }

  off<N extends EngineEventName>(eventName: N, cb: (p: EngineEventPayload<N>) => void): void {
    this.subs.get(eventName as string)?.delete(cb as (p: any) => void);
  }

  private emit<N extends EngineEventName>(eventName: N, payload: EngineEventPayload<N>): void {
    const set = this.subs.get(eventName as string);
    if (!set) return;
    for (const cb of set) {
      try { cb(payload); } catch { /* ignore */ }
    }
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
    if (opts?.signal) {
      if (opts.signal.aborted) {
        try { controller.abort((opts.signal as any).reason); } catch { /* */ }
      } else {
        userAbortHandler = () => {
          try { controller.abort((opts.signal as any).reason); } catch { /* */ }
        };
        opts.signal.addEventListener('abort', userAbortHandler);
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
      if (opts?.signal && userAbortHandler) {
        opts.signal.removeEventListener('abort', userAbortHandler);
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
      const baseCtx = this.makeBaseCtx(envelope, deliveryId, startedAt, signal, registry, ruleArgs, rule.name);
      let whenResult = true;
      if (rule.when !== undefined) {
        whenResult = await this.evaluateWhen(rule.when, baseCtx, memo, registry, deliveryId);
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
          this.queuePlainAction(pending, rule, att, baseCtx, registry);
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
              this.queueAggregatedAction(pending, rule, agg, att, baseCtx, keyId, windowMs, registry);
            }
          }
        }
        if (ruleFired) {
          matchedCount++;
          this.emit('rule.matched', { deliveryId, ruleId: rule.name, elapsedMs: this.clock.now() - ruleStartedAt });
          for (const att of rule.actions) {
            const action = registry.actionByName.get(att.name);
            if (action && action.kind === 'action') {
              this.queuePlainAction(pending, rule, att, baseCtx, registry);
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
    const reason = (signal as any).reason;
    throw reason instanceof Error ? reason : new Error('aborted');
  }

  private scopedLogger(bindings: object): Logger {
    return this.logger.child(bindings);
  }

  private bindIntegrations(
    registry: Registry,
    deliveryId: string,
  ): Record<string, IntegrationAdapter<IntegrationMethods>> {
    const out: Record<string, IntegrationAdapter<IntegrationMethods>> = {};
    for (const [integrationName, adapter] of Object.entries(registry.adapters)) {
      const methods: Record<string, (input: any) => Promise<any>> = {};
      for (const [methodName, fn] of Object.entries(adapter)) {
        methods[methodName] = (input: any) =>
          fn(attachIntegrationCallContext(input, { deliveryId }));
      }
      out[integrationName] = methods as IntegrationAdapter<IntegrationMethods>;
    }
    return out;
  }

  private makeBaseCtx(
    envelope: EventEnvelope,
    deliveryId: string,
    startedAt: number,
    signal: AbortSignal,
    registry: Registry,
    args: any,
    ruleId?: string,
  ): BaseCtx<AnyEventPayload, any> {
    const payload: any = envelope.payload ?? {};
    const loggerBindings: Record<string, unknown> = { deliveryId };
    if (ruleId !== undefined) loggerBindings.ruleId = ruleId;
    if (payload?.installation?.id !== undefined) loggerBindings.installation = { id: payload.installation.id };
    if (payload?.repository) {
      loggerBindings.repo = {
        id: payload.repository.id ?? 0,
        fullName: payload.repository.full_name ?? '',
      };
    }
    const ctx: BaseCtx<AnyEventPayload, any> = {
      event: payload,
      args,
      signal,
      deliveryId,
      now: startedAt,
      logger: this.scopedLogger(loggerBindings),
      integrations: this.bindIntegrations(registry, deliveryId),
    };
    if (payload?.installation?.id !== undefined) {
      ctx.installation = { id: payload.installation.id };
    }
    if (payload?.repository) {
      ctx.repo = {
        id: payload.repository.id ?? 0,
        fullName: payload.repository.full_name ?? '',
      };
    }
    return ctx;
  }

  private async evaluateWhen(
    node: WhenNode<any, any>,
    ctx: BaseCtx<AnyEventPayload, any>,
    memo: Map<string, MemoSlot>,
    registry: Registry,
    deliveryId: string,
  ): Promise<boolean> {
    if (typeof node === 'function') {
      try {
        return !!(await (node as (c: any) => boolean | Promise<boolean>)(ctx));
      } catch {
        return false;
      }
    }
    if ('kind' in node) {
      if (node.kind === 'all') {
        for (const c of (node as AllNode<any, any>).children) {
          const v = await this.evaluateWhen(c, ctx, memo, registry, deliveryId);
          if (!v) return false;
        }
        return true;
      }
      if (node.kind === 'any') {
        for (const c of (node as AnyNode<any, any>).children) {
          const v = await this.evaluateWhen(c, ctx, memo, registry, deliveryId);
          if (v) return true;
        }
        return false;
      }
      if (node.kind === 'not') {
        const v = await this.evaluateWhen((node as NotNode<any, any>).child, ctx, memo, registry, deliveryId);
        return !v;
      }
      if (node.kind === 'use') {
        return this.resolveUse(node as UseRef, ctx, memo, registry, deliveryId);
      }
    }
    return false;
  }

  private async resolveUse(
    ref: UseRef,
    ctx: BaseCtx<AnyEventPayload, any>,
    memo: Map<string, MemoSlot>,
    registry: Registry,
    deliveryId: string,
  ): Promise<boolean> {
    const pred = registry.predicates.get(ref.name);
    if (!pred) return false;
    const startedAt = this.clock.now();
    let merged: Record<string, unknown> = {};
    const pinnedFailOpen = (pred.pinnedArgs as any)?.failOpen === true;
    const useSiteFailOpen = (ref.args as any)?.failOpen === true;
    const fail = (err: unknown): boolean => {
      try {
        ctx.logger.warn({ err, predicateName: ref.name }, 'predicate evaluated as false');
      } catch { /* logger failures must not break predicate isolation */ }
      return pinnedFailOpen || useSiteFailOpen || merged.failOpen === true;
    };

    try {
      // Resolve use-site args: evaluate (ctx)=>value callbacks against rule ctx.
      const useArgs: Record<string, unknown> = {};
      for (const k of Object.keys(ref.args ?? {})) {
        const v = (ref.args as any)[k];
        useArgs[k] = typeof v === 'function' ? v(ctx) : v;
      }
      // Merge: registration > use-site
      merged = { ...useArgs };
      for (const k of Object.keys(pred.pinnedArgs ?? {})) {
        const v = (pred.pinnedArgs as any)[k];
        if (v !== undefined) merged[k] = v;
      }

      const hash = canonicalJson(merged);
      const key = `${ref.name}@${hash}`;
      const cached = memo.get(key);
      if (cached) {
        const result = await cached.promise;
        this.emit('predicate.evaluated', {
          deliveryId,
          predicateName: ref.name,
          result,
          elapsedMs: 0,
          cached: true,
        });
        return result;
      }

      const promise = (async (): Promise<boolean> => {
        let argsForFn: any = merged;
        if (pred.argsSchema && typeof (pred.argsSchema as any).safeParse === 'function') {
          const result = (pred.argsSchema as any).safeParse(merged);
          if (result.success) argsForFn = result.data;
          else return fail(result.error);
        }
        const predCtx: BaseCtx<AnyEventPayload, any> = {
          ...ctx,
          args: argsForFn,
          logger: ctx.logger.child({ predicateName: ref.name }),
        };
        try {
          return !!(await pred.fn(predCtx));
        } catch (err) {
          return fail(err);
        }
      })();

      const slot: MemoSlot = { promise };
      memo.set(key, slot);

      const result = await promise;
      this.emit('predicate.evaluated', {
        deliveryId,
        predicateName: ref.name,
        result,
        elapsedMs: this.clock.now() - startedAt,
        cached: false,
      });
      return result;
    } catch (err) {
      const result = fail(err);
      this.emit('predicate.evaluated', {
        deliveryId,
        predicateName: ref.name,
        result,
        elapsedMs: this.clock.now() - startedAt,
        cached: false,
      });
      return result;
    }
  }

  private queuePlainAction(
    pending: PendingAction[],
    rule: RegisteredRule<string, WebhookEventName, any>,
    att: ActionAttachment,
    baseCtx: BaseCtx<AnyEventPayload, any>,
    registry: Registry,
  ): void {
    const action = registry.actionByName.get(att.name);
    if (!action) return;
    if (action.kind !== 'action') return; // not a plain action
    const plain = action as RegisteredAction<string, any>;
    void rule;
    pending.push({
      fn: async () => {
        const mergedArgs = this.mergeActionArgs(plain.pinnedArgs, att.args, baseCtx, plain.argsSchema);
        const ctx = {
          ...baseCtx,
          args: mergedArgs,
          logger: baseCtx.logger.child({ actionName: plain.name }),
        };
        await plain.fn(ctx);
      },
    });
  }

  private queueAggregatedAction(
    pending: PendingAction[],
    rule: RegisteredRule<string, WebhookEventName, any>,
    agg: RegisteredAggregatedAction<string, WebhookEventName, any, any>,
    att: ActionAttachment,
    baseCtx: BaseCtx<AnyEventPayload, any>,
    keyId: string,
    windowMs: number,
    registry: Registry,
  ): void {
    void registry;
    pending.push({
      fn: async () => {
        const entries = await this.aggStore.list(rule.name, agg.name, keyId, windowMs);
        const mergedArgs = this.mergeActionArgs(agg.pinnedArgs, att.args, baseCtx, agg.argsSchema);
        const aggCtx: AggregatedCtx<WebhookEventName, any> = {
          ...baseCtx,
          args: mergedArgs,
          logger: baseCtx.logger.child({ actionName: agg.name }),
          aggregate: {
            entries: entries.map((e) => ({ at: e.at, deliveryId: e.deliveryId, payload: e.payload })),
            count: entries.length,
            windowMs,
            keyId,
          },
        };
        await agg.fn(aggCtx);
      },
    });
  }

  private mergeActionArgs(
    pinned: any,
    useSite: any,
    baseCtx: BaseCtx<AnyEventPayload, any>,
    schema: z.ZodType<any> | undefined,
  ): any {
    const useArgs: Record<string, unknown> = {};
    for (const k of Object.keys(useSite ?? {})) {
      const v = (useSite as any)[k];
      useArgs[k] = typeof v === 'function' ? v(baseCtx) : v;
    }
    const merged = { ...useArgs };
    for (const k of Object.keys(pinned ?? {})) {
      const v = (pinned as any)[k];
      if (v !== undefined) merged[k] = v;
    }
    if (schema && typeof (schema as any).safeParse === 'function') {
      const r = (schema as any).safeParse(merged);
      if (r.success) return r.data;
      throw r.error;
    }
    return merged;
  }

  /* ============================================================ *
   * scheduled rule check
   * ============================================================ */

  private async runScheduledCheck(rec: any): Promise<void> {
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
      integrations: this.bindIntegrations(registry, `scheduler:${rec.ruleId}:${rec.keyId}`),
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
      const baseCtx = this.makeBaseCtx(
        { name: rule.eventName, payload: {} as any, deliveryId: checkCtx.deliveryId },
        checkCtx.deliveryId,
        ranAt,
        controller.signal,
        registry,
        rule.pinnedArgs,
        rule.name,
      );
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
              const mergedArgs = this.mergeActionArgs(sched.pinnedArgs, att.args, baseCtx, sched.argsSchema);
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
              const mergedArgs = this.mergeActionArgs(plain.pinnedArgs, att.args, baseCtx, plain.argsSchema);
              const ctx = {
                ...baseCtx,
                args: mergedArgs,
                logger: baseCtx.logger.child({ actionName: plain.name }),
                scheduled: scheduledView,
              } as any;
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

/* ============================================================ *
 * test helper
 * ============================================================ */

function skeletonPayload(name: WebhookEventName): any {
  switch (name) {
    case 'workflow_run.completed':
    case 'workflow_run.requested':
      return {
        action: name.split('.')[1],
        workflow_run: {
          id: 0,
          html_url: '',
          conclusion: 'success',
          head_sha: '',
          pull_requests: [],
        },
      };
    case 'pull_request.opened':
    case 'pull_request.closed':
    case 'pull_request.reopened':
    case 'pull_request.synchronize':
    case 'pull_request.ready_for_review':
      return {
        action: name.split('.')[1],
        pull_request: {
          base: { ref: '' },
          user: { login: '' },
        },
      };
    case 'pull_request_review.submitted':
      return { action: 'submitted', review: {} };
    case 'issues.opened':
    case 'issues.closed':
    case 'issues.reopened':
    case 'issues.edited':
      return {
        action: name.split('.')[1],
        issue: {
          id: 0,
          html_url: '',
          title: '',
          state_reason: null,
        },
      };
    case 'issue_comment.created':
    case 'issue_comment.edited':
      return {
        action: name.split('.')[1],
        issue: { id: 0 },
        comment: { body: '', user: { login: '' } },
      };
    case 'check_run.completed':
      return { action: 'completed', check_run: {} };
    case 'release.published':
    case 'release.edited':
      return {
        action: name.split('.')[1],
        release: { tag_name: '', body: '' },
      };
    case 'push':
      return {};
    default:
      return {};
  }
}

function deepMerge(base: any, override: any): any {
  if (override === null || override === undefined) return base;
  if (typeof override !== 'object' || Array.isArray(override)) return override;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return override;
  const out: Record<string, any> = { ...base };
  for (const k of Object.keys(override)) {
    out[k] = deepMerge(base?.[k], (override as any)[k]);
  }
  return out;
}

export function fakeEnvelope<N extends WebhookEventName>(
  name: N,
  payload?: any,
  deliveryId?: string,
): EventEnvelope<N> {
  const merged = deepMerge(skeletonPayload(name), payload ?? {});
  return {
    name,
    payload: merged as any,
    deliveryId: deliveryId ?? `delivery-${Math.random().toString(36).slice(2, 10)}`,
  };
}
