import type {
  IntegrationBuilder,
  RegisteredIntegration,
  IntegrationMethods,
  CacheConfig,
  BreakerConfig,
  RetryConfig,
} from '../../public/integration.js';

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
