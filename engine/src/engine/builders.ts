import type { z } from 'zod';
import type {
  PredicateBuilder,
  PredicateBuilderWithArgs,
  PredicateFactory,
  RegisteredPredicate,
  PredicateImpl,
} from '../public/predicate.js';
import type {
  ActionBuilder,
  ActionBuilderWithArgs,
  ActionFactory,
  RegisteredAction,
  ActionImpl,
  AggregatedActionBuilder,
  AggregatedActionBuilderWithOn,
  AggregatedActionBuilderWithArgs,
  AggregatedActionBuilderWithTransform,
  AggregatedActionFactory,
  RegisteredAggregatedAction,
  AggregatedActionImpl,
  TransformFn,
  ScheduledActionBuilder,
  ScheduledActionBuilderWithArgs,
  ScheduledActionFactory,
  RegisteredScheduledAction,
  ScheduledActionImpl,
} from '../public/action.js';
import type {
  RuleBuilder,
  RuleBuilderWithArgs,
  RuleBuilderWithOn,
  RuleBuilderWithWhen,
  RuleBuilderAggregating,
  RuleBuilderScheduling,
  RuleBuilderTerminal,
  RegisteredRule,
  AggregateConfig,
  ScheduleConfig,
  RuleStrategy,
  ActionAttachment,
} from '../public/rule.js';
import type {
  IntegrationBuilder,
  RegisteredIntegration,
  IntegrationMethods,
  CacheConfig,
  BreakerConfig,
  RetryConfig,
} from '../public/integration.js';
import type { WebhookEventName } from '../public/webhook.js';
import type { WhenNode } from '../public/combinators.js';

/* ============================================================ *
 * predicate(name).args(schema).fn(impl)
 * ============================================================ */

export function predicate<Name extends string>(name: Name): PredicateBuilder<Name> {
  return {
    args<S extends z.ZodType>(schema: S): PredicateBuilderWithArgs<Name, z.infer<S>> {
      type Args = z.infer<S>;
      const withArgs: PredicateBuilderWithArgs<Name, Args> = {
        fn(impl: PredicateImpl<Args>): PredicateFactory<Name, Args> {
          const factory: PredicateFactory<Name, Args> = ((registrationArgs?: Partial<Args>): RegisteredPredicate<Name, Args> => ({
            kind: 'predicate',
            name,
            argsSchema: schema as unknown as z.ZodType<Args>,
            pinnedArgs: (registrationArgs ?? {}) as Partial<Args>,
            fn(ctx) {
              return impl(ctx);
            },
          })) as PredicateFactory<Name, Args>;
          return factory;
        },
      };
      return withArgs;
    },
  };
}

/* ============================================================ *
 * action(name).args(schema).fn(impl)
 * ============================================================ */

export function action<Name extends string>(name: Name): ActionBuilder<Name> {
  return {
    args<S extends z.ZodType>(schema: S): ActionBuilderWithArgs<Name, z.infer<S>> {
      type Args = z.infer<S>;
      const withArgs: ActionBuilderWithArgs<Name, Args> = {
        fn(impl: ActionImpl<Args>): ActionFactory<Name, Args> {
          const factory: ActionFactory<Name, Args> = (registrationArgs?: Partial<Args>): RegisteredAction<Name, Args> => ({
            kind: 'action',
            name,
            argsSchema: schema as unknown as z.ZodType<Args>,
            pinnedArgs: (registrationArgs ?? {}) as Partial<Args>,
            fn(ctx) {
              return impl(ctx);
            },
          });
          return factory;
        },
      };
      return withArgs;
    },
  };
}

/* ============================================================ *
 * aggregatedAction(name).on(event).args(schema).transform(fn).fn(impl)
 * ============================================================ */

export function aggregatedAction<Name extends string>(name: Name): AggregatedActionBuilder<Name> {
  return {
    on<N extends WebhookEventName>(eventName: N): AggregatedActionBuilderWithOn<Name, N> {
      const withOn: AggregatedActionBuilderWithOn<Name, N> = {
        args<S extends z.ZodType>(schema: S): AggregatedActionBuilderWithArgs<Name, N, z.infer<S>> {
          type Args = z.infer<S>;
          const withArgs: AggregatedActionBuilderWithArgs<Name, N, Args> = {
            transform<Payload>(
              transformFn: TransformFn<N, Args, Payload>,
            ): AggregatedActionBuilderWithTransform<Name, N, Args, Payload> {
              const withTransform: AggregatedActionBuilderWithTransform<Name, N, Args, Payload> = {
                fn(impl: AggregatedActionImpl<N, Args>): AggregatedActionFactory<Name, N, Args, Payload> {
                  const factory: AggregatedActionFactory<Name, N, Args, Payload> = (
                    registrationArgs?: Partial<Args>,
                  ): RegisteredAggregatedAction<Name, N, Args, Payload> => ({
                    kind: 'aggregatedAction',
                    name,
                    eventName,
                    argsSchema: schema as unknown as z.ZodType<Args>,
                    pinnedArgs: (registrationArgs ?? {}) as Partial<Args>,
                    transform(ctx) {
                      return transformFn(ctx);
                    },
                    fn(ctx) {
                      return impl(ctx);
                    },
                  });
                  return factory;
                },
              };
              return withTransform;
            },
          };
          return withArgs;
        },
      };
      return withOn;
    },
  };
}

/* ============================================================ *
 * scheduledAction(name).args(schema).fn(impl)
 * ============================================================ */

export function scheduledAction<Name extends string>(name: Name): ScheduledActionBuilder<Name> {
  return {
    args<S extends z.ZodType>(schema: S): ScheduledActionBuilderWithArgs<Name, z.infer<S>> {
      type Args = z.infer<S>;
      const withArgs: ScheduledActionBuilderWithArgs<Name, Args> = {
        fn(impl: ScheduledActionImpl<Args>): ScheduledActionFactory<Name, Args> {
          const factory: ScheduledActionFactory<Name, Args> = (
            registrationArgs?: Partial<Args>,
          ): RegisteredScheduledAction<Name, Args> => ({
            kind: 'scheduledAction',
            name,
            argsSchema: schema as unknown as z.ZodType<Args>,
            pinnedArgs: (registrationArgs ?? {}) as Partial<Args>,
            fn(ctx) {
              return impl(ctx);
            },
          });
          return factory;
        },
      };
      return withArgs;
    },
  };
}

/* ============================================================ *
 * rule(name)[.args(schema)].on(event).when(node)[.aggregate|.schedule].action(...)+
 * ============================================================ */

interface RuleState {
  name: string;
  argsSchema?: z.ZodType<any>;
  eventName?: WebhookEventName;
  when?: WhenNode<any, any>;
  strategy: RuleStrategy;
  actions: ActionAttachment[];
}

function makeRuleTerminal<Name extends string, N extends WebhookEventName, Args>(
  state: RuleState,
): RuleBuilderTerminal<Name, N, Args> {
  const fn: any = (registrationArgs?: Partial<Args>): RegisteredRule<Name, N, Args> => ({
    kind: 'rule',
    name: state.name as Name,
    eventName: state.eventName as N,
    argsSchema: (state.argsSchema ?? undefined) as unknown as z.ZodType<Args>,
    pinnedArgs: (registrationArgs ?? {}) as Partial<Args>,
    when: state.when as WhenNode<any, any>,
    strategy: state.strategy,
    actions: state.actions.slice(),
  });
  fn.action = (name: string, args?: Record<string, unknown>): RuleBuilderTerminal<Name, N, Args> => {
    state.actions.push({ name, args });
    return makeRuleTerminal<Name, N, Args>(state);
  };
  return fn as RuleBuilderTerminal<Name, N, Args>;
}

export function rule<Name extends string>(name: Name): RuleBuilder<Name> {
  const state: RuleState = {
    name,
    strategy: { kind: 'plain' },
    actions: [],
  };

  const builder: RuleBuilder<Name> = {
    args<S extends z.ZodType>(schema: S): RuleBuilderWithArgs<Name, z.infer<S>> {
      state.argsSchema = schema as unknown as z.ZodType<any>;
      return makeWithArgs<Name, z.infer<S>>(state);
    },
    on<N extends WebhookEventName>(eventName: N): RuleBuilderWithOn<Name, N, unknown> {
      state.eventName = eventName;
      return makeWithOn<Name, N, unknown>(state);
    },
  };
  return builder;
}

function makeWithArgs<Name extends string, Args>(state: RuleState): RuleBuilderWithArgs<Name, Args> {
  return {
    on<N extends WebhookEventName>(eventName: N): RuleBuilderWithOn<Name, N, Args> {
      state.eventName = eventName;
      return makeWithOn<Name, N, Args>(state);
    },
  };
}

function makeWithOn<Name extends string, N extends WebhookEventName, Args>(
  state: RuleState,
): RuleBuilderWithOn<Name, N, Args> {
  return {
    when(node: any): RuleBuilderWithWhen<Name, N, Args> {
      // Inline functions are wrapped as-is; tree nodes pass through.
      state.when = node;
      return makeWithWhen<Name, N, Args>(state);
    },
  };
}

function makeWithWhen<Name extends string, N extends WebhookEventName, Args>(
  state: RuleState,
): RuleBuilderWithWhen<Name, N, Args> {
  return {
    aggregate(cfg: AggregateConfig<N, Args>): RuleBuilderAggregating<Name, N, Args> {
      state.strategy = {
        kind: 'aggregate',
        window: cfg.window,
        count: cfg.count,
        key: cfg.key as any,
        ...(cfg.at !== undefined ? { at: cfg.at as any } : {}),
      };
      return {
        action(actionName: string, args?: Record<string, unknown>): RuleBuilderTerminal<Name, N, Args> {
          state.actions.push({ name: actionName, args });
          return makeRuleTerminal<Name, N, Args>(state);
        },
      };
    },
    schedule(cfg: ScheduleConfig<N, Args>): RuleBuilderScheduling<Name, N, Args> {
      state.strategy = {
        kind: 'schedule',
        delay: cfg.delay,
        ...(cfg.deadline !== undefined ? { deadline: cfg.deadline } : {}),
        key: cfg.key as any,
        transform: cfg.transform as any,
        check: cfg.check,
      };
      return {
        action(actionName: string, args?: Record<string, unknown>): RuleBuilderTerminal<Name, N, Args> {
          state.actions.push({ name: actionName, args });
          return makeRuleTerminal<Name, N, Args>(state);
        },
      };
    },
    action(actionName: string, args?: Record<string, unknown>): RuleBuilderTerminal<Name, N, Args> {
      state.actions.push({ name: actionName, args });
      return makeRuleTerminal<Name, N, Args>(state);
    },
  };
}

/* ============================================================ *
 * integration(name).<cfg>...methods({...})
 * ============================================================ */

interface IntegState {
  name: string;
  cache?: CacheConfig;
  breaker?: BreakerConfig;
  concurrency?: number;
  retry?: RetryConfig;
}

export function integration<Name extends string>(name: Name): IntegrationBuilder<Name> {
  const state: IntegState = { name };
  const builder: IntegrationBuilder<Name> = {
    cache(cfg) { state.cache = cfg; return builder; },
    breaker(cfg) { state.breaker = cfg; return builder; },
    concurrency(limit) { state.concurrency = limit; return builder; },
    retry(cfg) { state.retry = cfg; return builder; },
    methods<M extends IntegrationMethods>(methods: M): RegisteredIntegration<Name, M> {
      return {
        kind: 'integration',
        name: name as Name,
        ...(state.cache ? { cache: state.cache } : {}),
        ...(state.breaker ? { breaker: state.breaker } : {}),
        ...(state.concurrency !== undefined ? { concurrency: state.concurrency } : {}),
        ...(state.retry ? { retry: state.retry } : {}),
        methods,
      };
    },
  };
  return builder;
}
