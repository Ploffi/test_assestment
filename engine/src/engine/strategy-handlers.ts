import type { Registry } from '../internal/registry.js';
import type {
  AggregationStore,
  AnyEventPayload,
  BaseCtx,
  Clock,
  RegisteredAggregatedAction,
  RegisteredRule,
  RuleStrategy,
  ScheduledStore,
  WebhookEventName,
} from '../public/index.js';
import type { EngineEmit } from './utility/emitter.js';
import { parseDuration } from './utility/duration.js';
import {
  type PendingAction,
  queueAggregatedAction,
  queuePlainAction,
} from './actions.js';
import { throwIfAborted } from './utility/cancellation.js';

export interface StrategyHandlerOptions {
  rule: RegisteredRule<string, WebhookEventName, any>;
  baseCtx: BaseCtx<AnyEventPayload, any>;
  pending: PendingAction[];
  registry: Registry;
  deliveryId: string;
  ruleStartedAt: number;
  signal: AbortSignal;
  clock: Clock;
  aggStore: AggregationStore;
  schedStore: ScheduledStore;
  emit: EngineEmit;
}

export async function handleRuleStrategy(opts: StrategyHandlerOptions): Promise<boolean> {
  const strat = opts.rule.strategy as RuleStrategy;
  if (strat.kind === 'plain') return handlePlainStrategy(opts);
  if (strat.kind === 'aggregate') return handleAggregateStrategy(opts, strat);
  return handleScheduleStrategy(opts, strat);
}

function handlePlainStrategy(opts: StrategyHandlerOptions): boolean {
  throwIfAborted(opts.signal);
  opts.emit('rule.matched', {
    deliveryId: opts.deliveryId,
    ruleId: opts.rule.name,
    elapsedMs: opts.clock.now() - opts.ruleStartedAt,
  });
  for (const att of opts.rule.actions) {
    queuePlainAction(opts.pending, att, opts.baseCtx, opts.registry);
  }
  return true;
}

async function handleAggregateStrategy(
  opts: StrategyHandlerOptions,
  strat: Extract<RuleStrategy, { kind: 'aggregate' }>,
): Promise<boolean> {
  throwIfAborted(opts.signal);
  const keyId = strat.key(opts.baseCtx);
  const at = strat.at ? strat.at(opts.baseCtx) : opts.baseCtx.now;
  const windowMs = parseDuration(strat.window);
  let ruleFired = false;

  for (const att of opts.rule.actions) {
    const action = opts.registry.actionByName.get(att.name);
    if (!action) continue;
    if (action.kind !== 'aggregatedAction') continue;

    const agg = action as RegisteredAggregatedAction<string, WebhookEventName, any, any>;
    const payload = agg.transform(opts.baseCtx);
    throwIfAborted(opts.signal);
    const entry = { at, deliveryId: opts.deliveryId, payload };
    let count: number;
    if (typeof opts.aggStore.appendAndCount === 'function') {
      count = await opts.aggStore.appendAndCount(opts.rule.name, agg.name, keyId, entry, windowMs);
    } else {
      await opts.aggStore.append(opts.rule.name, agg.name, keyId, entry);
      count = await opts.aggStore.count(opts.rule.name, agg.name, keyId, windowMs);
    }
    opts.emit('aggregate.appended', {
      deliveryId: opts.deliveryId,
      ruleId: opts.rule.name,
      actionId: agg.name,
      keyId,
      count,
    });
    if (count >= strat.count) {
      ruleFired = true;
      queueAggregatedAction(opts.pending, {
        aggStore: opts.aggStore,
        rule: opts.rule,
        agg,
        att,
        baseCtx: opts.baseCtx,
        keyId,
        windowMs,
      });
    }
  }

  if (ruleFired) {
    opts.emit('rule.matched', {
      deliveryId: opts.deliveryId,
      ruleId: opts.rule.name,
      elapsedMs: opts.clock.now() - opts.ruleStartedAt,
    });
    for (const att of opts.rule.actions) {
      const action = opts.registry.actionByName.get(att.name);
      if (action && action.kind === 'action') {
        queuePlainAction(opts.pending, att, opts.baseCtx, opts.registry);
      }
    }
    return true;
  }

  opts.emit('rule.skipped', {
    deliveryId: opts.deliveryId,
    ruleId: opts.rule.name,
    reason: 'aggregate-below-threshold',
  });
  return false;
}

async function handleScheduleStrategy(
  opts: StrategyHandlerOptions,
  strat: Extract<RuleStrategy, { kind: 'schedule' }>,
): Promise<boolean> {
  throwIfAborted(opts.signal);
  const keyId = strat.key(opts.baseCtx);
  const payload = strat.transform(opts.baseCtx);
  const now = opts.clock.now();
  const runAt = now + parseDuration(strat.delay);
  const deadline = strat.deadline !== undefined ? now + parseDuration(strat.deadline) : undefined;
  await opts.schedStore.enqueue(opts.rule.name, keyId, runAt, payload, now, deadline);
  opts.emit('scheduled.enqueued', { ruleId: opts.rule.name, keyId, runAt });
  opts.emit('rule.skipped', {
    deliveryId: opts.deliveryId,
    ruleId: opts.rule.name,
    reason: 'scheduled-enqueued',
  });
  return false;
}
