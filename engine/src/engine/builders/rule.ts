import type { z } from 'zod';
import type {
  RuleBuilder,
  RuleBuilderWithArgs,
  RuleBuilderWithOn,
  RuleBuilderWithWhen,
  RuleBuilderTerminal,
  RegisteredRule,
  AggregateConfig,
  ScheduleConfig,
  RuleStrategy,
  ActionAttachment,
} from '../../public/rule.js';
import type { WebhookEventName } from '../../public/webhook.js';
import type { WhenNode } from '../../public/combinators.js';

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
  const fn: any = (registrationArgs?: Partial<Args>): RegisteredRule<Name, N, Args> => {
    if (!state.eventName) throw new Error(`rule "${state.name}" is missing event name`);
    if (state.when === undefined) throw new Error(`rule "${state.name}" is missing when predicate`);
    if (state.actions.length === 0) throw new Error(`rule "${state.name}" is missing actions`);
    return {
      kind: 'rule',
      name: state.name as Name,
      eventName: state.eventName as N,
      argsSchema: (state.argsSchema ?? undefined) as unknown as z.ZodType<Args>,
      pinnedArgs: (registrationArgs ?? {}) as Partial<Args>,
      when: state.when as WhenNode<any, any>,
      strategy: state.strategy,
      actions: state.actions.slice(),
    };
  };
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

  const builder = makeRuleTerminal<Name, WebhookEventName, unknown>(state) as RuleBuilder<Name>;

  builder.args = <S extends z.ZodType>(schema: S): RuleBuilderWithArgs<Name, z.infer<S>> => {
    state.argsSchema = schema as unknown as z.ZodType<any>;
    return builder as RuleBuilderWithArgs<Name, z.infer<S>>;
  };
  builder.on = <N extends WebhookEventName>(eventName: N): RuleBuilderWithOn<Name, N, unknown> => {
    state.eventName = eventName;
    return builder as RuleBuilderWithOn<Name, N, unknown>;
  };
  builder.when = <N extends WebhookEventName, Args>(node: any): RuleBuilderWithWhen<Name, N, Args> => {
    // Inline functions are wrapped as-is; tree nodes pass through.
    state.when = node;
    return builder as RuleBuilderWithWhen<Name, N, Args>;
  };
  builder.aggregate = <N extends WebhookEventName, Args>(cfg: AggregateConfig<N, Args>): RuleBuilderTerminal<Name, N, Args> => {
    state.strategy = {
      kind: 'aggregate',
      window: cfg.window,
      count: cfg.count,
      key: cfg.key as any,
      ...(cfg.at !== undefined ? { at: cfg.at as any } : {}),
    };
    return builder as RuleBuilderTerminal<Name, N, Args>;
  };
  builder.schedule = <N extends WebhookEventName, Args>(cfg: ScheduleConfig<N, Args>): RuleBuilderTerminal<Name, N, Args> => {
    state.strategy = {
      kind: 'schedule',
      delay: cfg.delay,
      ...(cfg.deadline !== undefined ? { deadline: cfg.deadline } : {}),
      key: cfg.key as any,
      transform: cfg.transform as any,
      check: cfg.check,
    };
    return builder as RuleBuilderTerminal<Name, N, Args>;
  };
  builder.action = <N extends WebhookEventName, Args>(
    actionName: string,
    args?: Record<string, unknown>,
  ): RuleBuilderTerminal<Name, N, Args> => {
    state.actions.push({ name: actionName, args });
    return builder as RuleBuilderTerminal<Name, N, Args>;
  };

  return builder;
}
