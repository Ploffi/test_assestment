import type { z } from 'zod';
import type {
  ScheduledActionBuilder,
  ScheduledActionBuilderWithArgs,
  ScheduledActionFactory,
  RegisteredScheduledAction,
  ScheduledActionImpl,
} from '../../public/action.js';

export function scheduledAction<Name extends string>(name: Name): ScheduledActionBuilder<Name> {
  const state: {
    argsSchema?: z.ZodType<any>;
    impl?: ScheduledActionImpl<any>;
  } = {};

  const builder = ((registrationArgs?: Partial<any>): RegisteredScheduledAction<Name, any> => {
    if (!state.argsSchema) throw new Error(`scheduledAction "${name}" is missing args schema`);
    if (!state.impl) throw new Error(`scheduledAction "${name}" is missing implementation`);
    return {
      kind: 'scheduledAction',
      name,
      argsSchema: state.argsSchema,
      pinnedArgs: registrationArgs ?? {},
      fn(ctx) {
        return state.impl!(ctx);
      },
    };
  }) as ScheduledActionFactory<Name, any>;

  builder.args = <S extends z.ZodType>(schema: S): ScheduledActionBuilderWithArgs<Name, z.infer<S>> => {
    state.argsSchema = schema as unknown as z.ZodType<any>;
    return builder as ScheduledActionBuilderWithArgs<Name, z.infer<S>>;
  };
  builder.fn = <Args>(impl: ScheduledActionImpl<Args>): ScheduledActionFactory<Name, Args> => {
    state.impl = impl as ScheduledActionImpl<any>;
    return builder as ScheduledActionFactory<Name, Args>;
  };

  return builder as ScheduledActionBuilder<Name>;
}
