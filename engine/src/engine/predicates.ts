import type { MemoSlot } from '../internal/eval-context.js';
import type { Registry } from '../internal/registry.js';
import type {
  AllNode,
  AnyEventPayload,
  AnyNode,
  BaseCtx,
  Clock,
  NotNode,
  UseRef,
  WhenNode,
} from '../public/index.js';
import type { PredicateEvaluatedEvent } from '../public/emitter.js';
import { canonicalJson } from './utility/canonical.js';

export interface EvaluateWhenOptions {
  node: WhenNode<any, any>;
  ctx: BaseCtx<AnyEventPayload, any>;
  memo: Map<string, MemoSlot>;
  registry: Registry;
  deliveryId: string;
  clock: Clock;
  emitPredicateEvaluated(event: PredicateEvaluatedEvent): void;
}

export function evaluateWhen(opts: EvaluateWhenOptions): Promise<boolean> {
  return evaluateNode(opts.node, opts);
}

async function evaluateNode(
  node: WhenNode<any, any>,
  opts: EvaluateWhenOptions,
): Promise<boolean> {
  if (typeof node === 'function') {
    try {
      return !!(await (node as (c: any) => boolean | Promise<boolean>)(opts.ctx));
    } catch {
      return false;
    }
  }
  if ('kind' in node) {
    if (node.kind === 'all') {
      for (const c of (node as AllNode<any, any>).children) {
        const v = await evaluateNode(c, opts);
        if (!v) return false;
      }
      return true;
    }
    if (node.kind === 'any') {
      for (const c of (node as AnyNode<any, any>).children) {
        const v = await evaluateNode(c, opts);
        if (v) return true;
      }
      return false;
    }
    if (node.kind === 'not') {
      const v = await evaluateNode((node as NotNode<any, any>).child, opts);
      return !v;
    }
    if (node.kind === 'use') {
      return resolveUse(node as UseRef, opts);
    }
  }
  return false;
}

async function resolveUse(ref: UseRef, opts: EvaluateWhenOptions): Promise<boolean> {
  const pred = opts.registry.predicates.get(ref.name);
  if (!pred) return false;
  const startedAt = opts.clock.now();
  let merged: Record<string, unknown> = {};
  const pinnedFailOpen = (pred.pinnedArgs as any)?.failOpen === true;
  const useSiteFailOpen = (ref.args as any)?.failOpen === true;
  const fail = (err: unknown): boolean => {
    try {
      opts.ctx.logger.warn({ err, predicateName: ref.name }, 'predicate evaluated as false');
    } catch { /* logger failures must not break predicate isolation */ }
    return pinnedFailOpen || useSiteFailOpen || merged.failOpen === true;
  };

  try {
    // Resolve use-site args: evaluate (ctx)=>value callbacks against rule ctx.
    const useArgs: Record<string, unknown> = {};
    for (const k of Object.keys(ref.args ?? {})) {
      const v = (ref.args as any)[k];
      useArgs[k] = typeof v === 'function' ? v(opts.ctx) : v;
    }
    // Merge: registration > use-site
    merged = { ...useArgs };
    for (const k of Object.keys(pred.pinnedArgs ?? {})) {
      const v = (pred.pinnedArgs as any)[k];
      if (v !== undefined) merged[k] = v;
    }

    const hash = canonicalJson(merged);
    const key = `${ref.name}@${hash}`;
    const cached = opts.memo.get(key);
    if (cached) {
      const result = await cached.promise;
      opts.emitPredicateEvaluated({
        deliveryId: opts.deliveryId,
        predicateName: ref.name,
        result,
        elapsedMs: 0,
        cached: true,
      });
      return result;
    }

    const promise = (async (): Promise<boolean> => {
      let argsForFn: any = merged;
      if (pred.argsSchema && typeof (pred.argsSchema as any).safeParse === 'function') {
        const result = (pred.argsSchema as any).safeParse(merged);
        if (result.success) argsForFn = result.data;
        else return fail(result.error);
      }
      const predCtx: BaseCtx<AnyEventPayload, any> = {
        ...opts.ctx,
        args: argsForFn,
        logger: opts.ctx.logger.child({ predicateName: ref.name }),
      };
      try {
        return !!(await pred.fn(predCtx));
      } catch (err) {
        return fail(err);
      }
    })();

    const slot: MemoSlot = { promise };
    opts.memo.set(key, slot);

    const result = await promise;
    opts.emitPredicateEvaluated({
      deliveryId: opts.deliveryId,
      predicateName: ref.name,
      result,
      elapsedMs: opts.clock.now() - startedAt,
      cached: false,
    });
    return result;
  } catch (err) {
    const result = fail(err);
    opts.emitPredicateEvaluated({
      deliveryId: opts.deliveryId,
      predicateName: ref.name,
      result,
      elapsedMs: opts.clock.now() - startedAt,
      cached: false,
    });
    return result;
  }
}
