import type { z } from 'zod';
import type {
  AggregatedActionBuilder,
  AggregatedActionBuilderWithOn,
  AggregatedActionBuilderWithArgs,
  AggregatedActionBuilderWithTransform,
  AggregatedActionFactory,
  RegisteredAggregatedAction,
  AggregatedActionImpl,
  TransformFn,
} from '../../public/action.js';
import type { WebhookEventName } from '../../public/webhook.js';

export function aggregatedAction<Name extends string>(name: Name): AggregatedActionBuilder<Name> {
  const state: {
    eventName?: WebhookEventName;
    argsSchema?: z.ZodType<any>;
    transformFn?: TransformFn<any, any, any>;
    impl?: AggregatedActionImpl<any, any>;
  } = {};

  const builder = ((registrationArgs?: Partial<any>): RegisteredAggregatedAction<Name, any, any, any> => {
    if (!state.eventName) throw new Error(`aggregatedAction "${name}" is missing event name`);
    if (!state.argsSchema) throw new Error(`aggregatedAction "${name}" is missing args schema`);
    if (!state.transformFn) throw new Error(`aggregatedAction "${name}" is missing transform`);
    if (!state.impl) throw new Error(`aggregatedAction "${name}" is missing implementation`);
    return {
      kind: 'aggregatedAction',
      name,
      eventName: state.eventName,
      argsSchema: state.argsSchema,
      pinnedArgs: registrationArgs ?? {},
      transform(ctx) {
        return state.transformFn!(ctx);
      },
      fn(ctx) {
        return state.impl!(ctx);
      },
    };
  }) as AggregatedActionFactory<Name, any, any, any>;

  builder.on = <N extends WebhookEventName>(eventName: N): AggregatedActionBuilderWithOn<Name, N> => {
    state.eventName = eventName;
    return builder as AggregatedActionBuilderWithOn<Name, N>;
  };
  builder.args = <S extends z.ZodType>(schema: S): AggregatedActionBuilderWithArgs<Name, any, z.infer<S>> => {
    state.argsSchema = schema as unknown as z.ZodType<any>;
    return builder as AggregatedActionBuilderWithArgs<Name, any, z.infer<S>>;
  };
  builder.transform = <N extends WebhookEventName, Args, Payload>(
    transformFn: TransformFn<N, Args, Payload>,
  ): AggregatedActionBuilderWithTransform<Name, N, Args, Payload> => {
    state.transformFn = transformFn as TransformFn<any, any, any>;
    return builder as AggregatedActionBuilderWithTransform<Name, N, Args, Payload>;
  };
  builder.fn = <N extends WebhookEventName, Args, Payload>(
    impl: AggregatedActionImpl<N, Args>,
  ): AggregatedActionFactory<Name, N, Args, Payload> => {
    state.impl = impl as AggregatedActionImpl<any, any>;
    return builder as AggregatedActionFactory<Name, N, Args, Payload>;
  };

  return builder as AggregatedActionBuilder<Name>;
}
