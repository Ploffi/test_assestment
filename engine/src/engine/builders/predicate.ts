import type { z } from 'zod';
import type {
  PredicateBuilder,
  PredicateBuilderWithArgs,
  PredicateFactory,
  RegisteredPredicate,
  PredicateImpl,
} from '../../public/predicate.js';

export function predicate<Name extends string>(name: Name): PredicateBuilder<Name> {
  const state: {
    argsSchema?: z.ZodType<any>;
    impl?: PredicateImpl<any>;
  } = {};

  const builder = ((registrationArgs?: Partial<any>): RegisteredPredicate<Name, any> => {
    if (!state.argsSchema) throw new Error(`predicate "${name}" is missing args schema`);
    if (!state.impl) throw new Error(`predicate "${name}" is missing implementation`);
    return {
      kind: 'predicate',
      name,
      argsSchema: state.argsSchema,
      pinnedArgs: registrationArgs ?? {},
      fn(ctx) {
        return state.impl!(ctx);
      },
    };
  }) as PredicateFactory<Name, any>;

  builder.args = <S extends z.ZodType>(schema: S): PredicateBuilderWithArgs<Name, z.infer<S>> => {
    state.argsSchema = schema as unknown as z.ZodType<any>;
    return builder as PredicateBuilderWithArgs<Name, z.infer<S>>;
  };
  builder.fn = <Args>(impl: PredicateImpl<Args>): PredicateFactory<Name, Args> => {
    state.impl = impl as PredicateImpl<any>;
    return builder as PredicateFactory<Name, Args>;
  };

  return builder as PredicateBuilder<Name>;
}
