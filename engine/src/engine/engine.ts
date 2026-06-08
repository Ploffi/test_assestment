import type {
  EngineOptions,
  RuleEngine,
  RegisterBatch,
  EvaluateOptions,
} from '../public/engine.js';
import { createConsoleLogger } from '../public/logger.js';
import type { Registry } from '../internal/registry.js';
import type {
  EngineEventName,
  EngineEventPayload,
} from '../public/emitter.js';
import { EngineNotReadyError } from '../public/register.js';
import type {
  AggregationStore,
  Clock,
  EventEnvelope,
  Logger,
  ScheduledStore,
} from '../public/index.js';

import { SystemClock } from '../utility/clock.js';
import { createInMemoryAggregationStore } from '../utility/aggregation-store.js';
import { createInMemoryScheduledStore } from '../utility/scheduled-store.js';
import { buildRegistry } from './registration.js';
import { EngineEmitter } from './utility/emitter.js';
import { CancellationScope } from './utility/cancellation.js';
import { EventEvaluationRunner } from './evaluation-runner.js';
import { ScheduledWorker } from './scheduled-worker.js';

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
  private evalScopes = new Set<CancellationScope>();
  private evaluationRunner: EventEvaluationRunner;
  private scheduledWorker: ScheduledWorker;

  constructor(opts: EngineOptions = {}) {
    this.clock = opts.clock ?? SystemClock;
    this.aggStore = opts.aggregationStore ?? createInMemoryAggregationStore({ clock: this.clock });
    this.schedStore = opts.scheduledStore ?? createInMemoryScheduledStore();
    this.logger = opts.logger ?? createConsoleLogger();
    this.evalTimeoutMs = opts.evaluationTimeoutMs ?? 15_000;
    const requestedPoll = opts.scheduledPollMs ?? 10_000;
    this.schedPollMs = Math.max(10_000, requestedPoll);
    this.evaluationRunner = new EventEvaluationRunner({
      clock: this.clock,
      aggStore: this.aggStore,
      schedStore: this.schedStore,
      logger: this.logger,
      emit: (eventName, payload) => this.emit(eventName, payload),
    });
    this.scheduledWorker = new ScheduledWorker({
      clock: this.clock,
      schedStore: this.schedStore,
      logger: this.logger,
      evalTimeoutMs: this.evalTimeoutMs,
      schedPollMs: this.schedPollMs,
      getRegistry: () => this.registry,
      emit: (eventName, payload) => this.emit(eventName, payload),
    });
  }

  register(batch: RegisterBatch): void {
    this.registry = buildRegistry(batch, {
      clock: this.clock,
      emitExternalCall: (event) => this.emit('external.call', event),
    });
  }

  on<N extends EngineEventName>(eventName: N, cb: (p: EngineEventPayload<N>) => void): void {
    this.events.on(eventName, cb);
  }

  off<N extends EngineEventName>(eventName: N, cb: (p: EngineEventPayload<N>) => void): void {
    this.events.off(eventName, cb);
  }

  private emit<N extends EngineEventName>(eventName: N, payload: EngineEventPayload<N>): void {
    this.events.emit(eventName, payload);
  }

  start(): void {
    this.scheduledWorker.start();
  }

  async stop(): Promise<void> {
    for (const scope of this.evalScopes) {
      scope.abort(new Error('engine stopped'));
    }
    await this.scheduledWorker.stop();
    await Promise.allSettled([...this.inflight]);
  }

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
    const scope = new CancellationScope({
      clock: this.clock,
      timeoutMs: this.evalTimeoutMs,
      signal: opts?.signal,
    });
    this.evalScopes.add(scope);

    try {
      const result = await scope.run((signal) => this.evaluationRunner.run({
        envelope,
        deliveryId,
        startedAt,
        signal,
        registry,
      }));
      this.emit('evaluation.completed', {
        deliveryId,
        matchedCount: result.matchedCount,
        totalElapsedMs: this.clock.now() - startedAt,
      });
    } catch (err) {
      this.emit('evaluation.failed', { deliveryId, error: err });
      throw err;
    } finally {
      this.evalScopes.delete(scope);
      scope.dispose();
    }
  }
}

export function createEngine(opts: EngineOptions = {}): RuleEngine {
  return new EngineImpl(opts);
}
