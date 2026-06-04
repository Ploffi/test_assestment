import type { z } from 'zod';
import type { Registry } from '../internal/registry.js';
import type {
  ActionAttachment,
  AggregatedCtx,
  AggregationStore,
  AnyEventPayload,
  BaseCtx,
  RegisteredAction,
  RegisteredAggregatedAction,
  RegisteredRule,
  WebhookEventName,
} from '../public/index.js';

export interface PendingAction {
  fn: () => Promise<void>;
}

export function queuePlainAction(
  pending: PendingAction[],
  att: ActionAttachment,
  baseCtx: BaseCtx<AnyEventPayload, any>,
  registry: Registry,
): void {
  const action = registry.actionByName.get(att.name);
  if (!action) return;
  if (action.kind !== 'action') return;
  const plain = action as RegisteredAction<string, any>;
  pending.push({
    fn: async () => {
      const mergedArgs = mergeActionArgs(plain.pinnedArgs, att.args, baseCtx, plain.argsSchema);
      const ctx = {
        ...baseCtx,
        args: mergedArgs,
        logger: baseCtx.logger.child({ actionName: plain.name }),
      };
      await plain.fn(ctx);
    },
  });
}

export interface QueueAggregatedActionOptions {
  aggStore: AggregationStore;
  rule: RegisteredRule<string, WebhookEventName, any>;
  agg: RegisteredAggregatedAction<string, WebhookEventName, any, any>;
  att: ActionAttachment;
  baseCtx: BaseCtx<AnyEventPayload, any>;
  keyId: string;
  windowMs: number;
}

export function queueAggregatedAction(
  pending: PendingAction[],
  opts: QueueAggregatedActionOptions,
): void {
  pending.push({
    fn: async () => {
      const entries = await opts.aggStore.list(opts.rule.name, opts.agg.name, opts.keyId, opts.windowMs);
      const mergedArgs = mergeActionArgs(opts.agg.pinnedArgs, opts.att.args, opts.baseCtx, opts.agg.argsSchema);
      const aggCtx: AggregatedCtx<WebhookEventName, any> = {
        ...opts.baseCtx,
        args: mergedArgs,
        logger: opts.baseCtx.logger.child({ actionName: opts.agg.name }),
        aggregate: {
          entries: entries.map((e) => ({ at: e.at, deliveryId: e.deliveryId, payload: e.payload })),
          count: entries.length,
          windowMs: opts.windowMs,
          keyId: opts.keyId,
        },
      };
      await opts.agg.fn(aggCtx);
    },
  });
}

export function mergeActionArgs(
  pinned: any,
  useSite: any,
  baseCtx: BaseCtx<AnyEventPayload, any>,
  schema: z.ZodType<any> | undefined,
): any {
  const useArgs: Record<string, unknown> = {};
  for (const k of Object.keys(useSite ?? {})) {
    const v = (useSite as any)[k];
    useArgs[k] = typeof v === 'function' ? v(baseCtx) : v;
  }
  const merged = { ...useArgs };
  for (const k of Object.keys(pinned ?? {})) {
    const v = (pinned as any)[k];
    if (v !== undefined) merged[k] = v;
  }
  if (schema && typeof (schema as any).safeParse === 'function') {
    const r = (schema as any).safeParse(merged);
    if (r.success) return r.data;
    throw r.error;
  }
  return merged;
}
