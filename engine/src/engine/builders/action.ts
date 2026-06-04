import type { z } from 'zod';
import type {
  ActionBuilder,
  ActionBuilderWithArgs,
  ActionFactory,
  RegisteredAction,
  ActionImpl,
} from '../../public/action.js';

export function action<Name extends string>(name: Name): ActionBuilder<Name> {
  const state: {
    argsSchema?: z.ZodType<any>;
    impl?: ActionImpl<any>;
  } = {};

  const builder = ((registrationArgs?: Partial<any>): RegisteredAction<Name, any> => {
    if (!state.argsSchema) throw new Error(`action "${name}" is missing args schema`);
    if (!state.impl) throw new Error(`action "${name}" is missing implementation`);
    return {
      kind: 'action',
      name,
      argsSchema: state.argsSchema,
      pinnedArgs: registrationArgs ?? {},
      fn(ctx) {
        return state.impl!(ctx);
      },
    };
  }) as ActionFactory<Name, any>;

  builder.args = <S extends z.ZodType>(schema: S): ActionBuilderWithArgs<Name, z.infer<S>> => {
    state.argsSchema = schema as unknown as z.ZodType<any>;
    return builder as ActionBuilderWithArgs<Name, z.infer<S>>;
  };
  builder.fn = <Args>(impl: ActionImpl<Args>): ActionFactory<Name, Args> => {
    state.impl = impl as ActionImpl<any>;
    return builder as ActionFactory<Name, Args>;
  };

  return builder as ActionBuilder<Name>;
}
