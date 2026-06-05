import type { MemoSlot } from '../internal/eval-context.js';
import type { Registry } from '../internal/registry.js';
import type {
  AggregationStore,
  Clock,
  EventEnvelope,
  Logger,
  ScheduledStore,
} from '../public/index.js';
import type { EngineEmit } from './emitter.js';
import type { PendingAction } from './actions.js';
import { runPendingActions } from './action-executor.js';
import { throwIfAborted } from './cancellation.js';
import { makeRuleBaseCtx } from './context-factories.js';
import { evaluateWhen } from './predicates.js';
import { handleRuleStrategy } from './strategy-handlers.js';

export interface EventEvaluationRunnerOptions {
  clock: Clock;
  aggStore: AggregationStore;
  schedStore: ScheduledStore;
  logger: Logger;
  emit: EngineEmit;
}

export interface RunEvaluationOptions {
  envelope: EventEnvelope;
  deliveryId: string;
  startedAt: number;
  signal: AbortSignal;
  registry: Registry;
}

export class EventEvaluationRunner {
  constructor(private readonly opts: EventEvaluationRunnerOptions) {}

  async run(opts: RunEvaluationOptions): Promise<{ matchedCount: number }> {
    const rules = opts.registry.dispatch.get(opts.envelope.name) ?? [];
    const memo = new Map<string, MemoSlot>();
    const pending: PendingAction[] = [];
    let matchedCount = 0;

    for (const rule of rules) {
      throwIfAborted(opts.signal);
      const ruleStartedAt = this.opts.clock.now();
      const baseCtx = makeRuleBaseCtx({
        rule,
        envelope: opts.envelope,
        deliveryId: opts.deliveryId,
        startedAt: opts.startedAt,
        signal: opts.signal,
        registry: opts.registry,
        logger: this.opts.logger,
      });

      let whenResult = true;
      if (rule.when !== undefined) {
        whenResult = await evaluateWhen({
          node: rule.when,
          ctx: baseCtx,
          memo,
          registry: opts.registry,
          deliveryId: opts.deliveryId,
          clock: this.opts.clock,
          emitPredicateEvaluated: (event) => this.opts.emit('predicate.evaluated', event),
        });
        throwIfAborted(opts.signal);
      }
      if (!whenResult) {
        this.opts.emit('rule.skipped', {
          deliveryId: opts.deliveryId,
          ruleId: rule.name,
          reason: 'when-false',
        });
        continue;
      }

      const matched = await handleRuleStrategy({
        rule,
        baseCtx,
        pending,
        registry: opts.registry,
        deliveryId: opts.deliveryId,
        ruleStartedAt,
        signal: opts.signal,
        clock: this.opts.clock,
        aggStore: this.opts.aggStore,
        schedStore: this.opts.schedStore,
        emit: this.opts.emit,
      });
      if (matched) matchedCount++;
    }

    if (pending.length > 0) {
      throwIfAborted(opts.signal);
      await runPendingActions(pending, 'multiple actions failed');
    }

    return { matchedCount };
  }
}
