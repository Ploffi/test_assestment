import type { Registry } from '../internal/registry.js';
import type {
  AnyEventPayload,
  BaseCtx,
  CheckCtx,
  Logger,
  RegisteredRule,
  ScheduledCheck,
  ScheduledView,
  WebhookEventName,
} from '../public/index.js';
import { bindIntegrations, makeBaseCtx } from './context.js';

export type ScheduledPlainActionCtx = BaseCtx<AnyEventPayload, unknown> & {
  scheduled: ScheduledView;
};

export interface MakeRuleBaseCtxOptions {
  rule: RegisteredRule<string, WebhookEventName, any>;
  envelope: { name: WebhookEventName; payload: AnyEventPayload; deliveryId: string };
  deliveryId: string;
  startedAt: number;
  signal: AbortSignal;
  registry: Registry;
  logger: Logger;
}

export function makeRuleBaseCtx(opts: MakeRuleBaseCtxOptions): BaseCtx<AnyEventPayload, any> {
  return makeBaseCtx({
    envelope: opts.envelope,
    deliveryId: opts.deliveryId,
    startedAt: opts.startedAt,
    signal: opts.signal,
    registry: opts.registry,
    args: opts.rule.pinnedArgs ?? {},
    logger: opts.logger,
    ruleId: opts.rule.name,
  });
}

export interface MakeScheduledCheckCtxOptions {
  rec: ScheduledCheck;
  rule: RegisteredRule<string, WebhookEventName, any>;
  registry: Registry;
  signal: AbortSignal;
  ranAt: number;
  logger: Logger;
}

export function makeScheduledCheckCtx(opts: MakeScheduledCheckCtxOptions): CheckCtx {
  const deliveryId = scheduledDeliveryId(opts.rec);
  return {
    args: opts.rule.pinnedArgs,
    payload: opts.rec.payload,
    scheduledAt: opts.rec.scheduledAt,
    signal: opts.signal,
    deliveryId,
    now: opts.ranAt,
    logger: opts.logger.child({ deliveryId, ruleId: opts.rec.ruleId }),
    integrations: bindIntegrations(opts.registry, deliveryId),
  };
}

export interface MakeScheduledBaseCtxOptions {
  rec: ScheduledCheck;
  rule: RegisteredRule<string, WebhookEventName, any>;
  registry: Registry;
  signal: AbortSignal;
  ranAt: number;
  logger: Logger;
}

export function makeScheduledBaseCtx(opts: MakeScheduledBaseCtxOptions): BaseCtx<AnyEventPayload, any> {
  const emptyEventPayload = {} as AnyEventPayload;
  const deliveryId = scheduledDeliveryId(opts.rec);
  return makeRuleBaseCtx({
    rule: opts.rule,
    envelope: { name: opts.rule.eventName, payload: emptyEventPayload, deliveryId },
    deliveryId,
    startedAt: opts.ranAt,
    signal: opts.signal,
    registry: opts.registry,
    logger: opts.logger,
  });
}

export function makeScheduledView(rec: ScheduledCheck, ranAt: number): ScheduledView {
  return {
    payload: rec.payload,
    scheduledAt: rec.scheduledAt,
    ranAt,
    keyId: rec.keyId,
  };
}

export function scheduledDeliveryId(rec: ScheduledCheck): string {
  return `scheduler:${rec.ruleId}:${rec.keyId}`;
}
