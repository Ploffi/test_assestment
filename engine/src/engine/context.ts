import type { Registry } from '../internal/registry.js';
import type {
  AnyEventPayload,
  BaseCtx,
  EventEnvelope,
  IntegrationAdapter,
  IntegrationMethods,
  Logger,
} from '../public/index.js';
import { attachIntegrationCallContext } from './adapter.js';

export function bindIntegrations(
  registry: Registry,
  deliveryId: string,
): Record<string, IntegrationAdapter<IntegrationMethods>> {
  const out: Record<string, IntegrationAdapter<IntegrationMethods>> = {};
  for (const [integrationName, adapter] of Object.entries(registry.adapters)) {
    const methods: Record<string, (input: any) => Promise<any>> = {};
    for (const [methodName, fn] of Object.entries(adapter)) {
      methods[methodName] = (input: any) =>
        fn(attachIntegrationCallContext(input, { deliveryId }));
    }
    out[integrationName] = methods as IntegrationAdapter<IntegrationMethods>;
  }
  return out;
}

export interface MakeBaseCtxOptions {
  envelope: EventEnvelope;
  deliveryId: string;
  startedAt: number;
  signal: AbortSignal;
  registry: Registry;
  args: any;
  logger: Logger;
  ruleId?: string;
}

export function makeBaseCtx(opts: MakeBaseCtxOptions): BaseCtx<AnyEventPayload, any> {
  const payload: any = opts.envelope.payload ?? {};
  const loggerBindings: Record<string, unknown> = { deliveryId: opts.deliveryId };
  if (opts.ruleId !== undefined) loggerBindings.ruleId = opts.ruleId;
  if (payload?.installation?.id !== undefined) loggerBindings.installation = { id: payload.installation.id };
  if (payload?.repository) {
    loggerBindings.repo = {
      id: payload.repository.id ?? 0,
      fullName: payload.repository.full_name ?? '',
    };
  }
  const ctx: BaseCtx<AnyEventPayload, any> = {
    event: payload,
    args: opts.args,
    signal: opts.signal,
    deliveryId: opts.deliveryId,
    now: opts.startedAt,
    logger: opts.logger.child(loggerBindings),
    integrations: bindIntegrations(opts.registry, opts.deliveryId),
  };
  if (payload?.installation?.id !== undefined) {
    ctx.installation = { id: payload.installation.id };
  }
  if (payload?.repository) {
    ctx.repo = {
      id: payload.repository.id ?? 0,
      fullName: payload.repository.full_name ?? '',
    };
  }
  return ctx;
}
