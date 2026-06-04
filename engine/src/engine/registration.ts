import type { z } from 'zod';
import type { RegisterBatch } from '../public/engine.js';
import type { Registry } from '../internal/registry.js';
import type {
  RegisteredAggregatedAction,
  RegisteredIntegration,
  AnyRegisteredAction,
  WebhookEventName,
  Clock,
  WhenNode,
  AllNode,
  AnyNode,
  NotNode,
  UseRef,
  IntegrationMethods,
} from '../public/index.js';
import type { ExternalCallEvent } from '../public/emitter.js';
import {
  RegistrationError,
  type RegistrationIssue,
} from '../public/register.js';
import { buildAdapter } from './adapter.js';

export interface BuildRegistryOptions {
  clock: Clock;
  emitExternalCall(event: ExternalCallEvent): void;
}

export function buildRegistry(batch: RegisterBatch, opts: BuildRegistryOptions): Registry {
  const issues: RegistrationIssue[] = [];
  const reg: Registry = {
    predicates: new Map(),
    actions: new Map(),
    aggregatedActions: new Map(),
    scheduledActions: new Map(),
    integrations: new Map(),
    rules: new Map(),
    actionByName: new Map(),
    dispatch: new Map(),
    adapters: {},
  };

  const addUnique = <T extends { name: string }>(
    map: Map<string, T>,
    entity: T,
    kind: RegistrationIssue['entity']['kind'],
  ) => {
    if (map.has(entity.name)) {
      issues.push({
        code: 'duplicate-name',
        entity: { kind, name: entity.name },
        message: `duplicate ${kind} name: ${entity.name}`,
      });
      return;
    }
    map.set(entity.name, entity);
  };

  for (const p of batch.predicates ?? []) addUnique(reg.predicates, p, 'predicate');
  for (const a of batch.actions ?? []) addUnique(reg.actions, a, 'action');
  for (const a of batch.aggregatedActions ?? []) addUnique(reg.aggregatedActions, a, 'aggregatedAction');
  for (const a of batch.scheduledActions ?? []) addUnique(reg.scheduledActions, a, 'scheduledAction');
  for (const i of batch.integrations ?? []) addUnique(reg.integrations, i, 'integration');
  for (const r of batch.rules ?? []) addUnique(reg.rules, r, 'rule');

  // Build unified action lookup. Rule attachments are by name only, so names
  // must be globally unique across the three action kinds.
  const addActionLookup = (a: AnyRegisteredAction): void => {
    if (reg.actionByName.has(a.name)) {
      issues.push({
        code: 'duplicate-name',
        entity: { kind: a.kind, name: a.name },
        message: `duplicate action name across action kinds: ${a.name}`,
      });
      return;
    }
    reg.actionByName.set(a.name, a);
  };
  for (const a of reg.actions.values()) addActionLookup(a);
  for (const a of reg.aggregatedActions.values()) addActionLookup(a);
  for (const a of reg.scheduledActions.values()) addActionLookup(a);

  // Pass 1: dependency graph + cross-references
  for (const r of reg.rules.values()) {
    // Walk when tree for use(name)
    const checkUse = (n: WhenNode<any, any>) => {
      if (typeof n === 'function') return;
      if ('kind' in n) {
        if (n.kind === 'use') {
          const useRef = n as UseRef;
          if (!reg.predicates.has(useRef.name)) {
            issues.push({
              code: 'unknown-predicate',
              entity: { kind: 'rule', name: r.name },
              message: `rule "${r.name}" uses unknown predicate "${useRef.name}"`,
              related: { kind: 'predicate', name: useRef.name },
            });
          }
        } else if (n.kind === 'all' || n.kind === 'any') {
          for (const c of (n as AllNode<any, any> | AnyNode<any, any>).children) checkUse(c);
        } else if (n.kind === 'not') {
          checkUse((n as NotNode<any, any>).child);
        }
      }
    };
    if (r.when) checkUse(r.when);

    // Check action attachments
    const strat = r.strategy;
    let hasAggregatedActionAttached = false;
    let hasScheduledActionAttached = false;
    for (const att of r.actions) {
      const found = reg.actionByName.get(att.name);
      if (!found) {
        issues.push({
          code: 'unknown-action',
          entity: { kind: 'rule', name: r.name },
          message: `rule "${r.name}" references unknown action "${att.name}"`,
          related: { kind: 'action', name: att.name },
        });
        continue;
      }
      if (found.kind === 'aggregatedAction') {
        hasAggregatedActionAttached = true;
        const agg = found as RegisteredAggregatedAction<string, WebhookEventName, any, any>;
        if (strat.kind !== 'aggregate') {
          issues.push({
            code: 'kind-mismatch',
            entity: { kind: 'rule', name: r.name },
            message: `aggregatedAction "${agg.name}" attached to non-aggregating rule "${r.name}"`,
            related: { kind: 'aggregatedAction', name: agg.name },
          });
        }
        if (agg.eventName !== r.eventName) {
          issues.push({
            code: 'on-mismatch',
            entity: { kind: 'rule', name: r.name },
            message: `aggregatedAction "${agg.name}" .on(${agg.eventName}) does not match rule "${r.name}" .on(${r.eventName})`,
            related: { kind: 'aggregatedAction', name: agg.name },
          });
        }
      } else if (found.kind === 'scheduledAction') {
        hasScheduledActionAttached = true;
        if (strat.kind !== 'schedule') {
          issues.push({
            code: 'kind-mismatch',
            entity: { kind: 'rule', name: r.name },
            message: `scheduledAction "${found.name}" attached to non-scheduled rule "${r.name}"`,
            related: { kind: 'scheduledAction', name: found.name },
          });
        }
      }
    }

    if (strat.kind === 'aggregate' && !hasAggregatedActionAttached) {
      issues.push({
        code: 'missing-aggregated-action',
        entity: { kind: 'rule', name: r.name },
        message: `aggregating rule "${r.name}" has no aggregatedAction attached`,
      });
    }
    if (strat.kind === 'schedule' && !hasScheduledActionAttached) {
      issues.push({
        code: 'missing-scheduled-action',
        entity: { kind: 'rule', name: r.name },
        message: `scheduled rule "${r.name}" has no scheduledAction attached`,
      });
    }
  }

  // Pass 2: schema validation on pinned args
  const validateArgs = (
    schema: z.ZodType<any> | undefined,
    pinned: unknown,
    entity: RegistrationIssue['entity'],
    partial: boolean,
  ) => {
    if (!schema || typeof (schema as any).safeParse !== 'function') return;
    // Predicate/action pinned args are Partial<Args>; rule args have no
    // use-site merge later and must be complete at registration time.
    const partialed = partial && typeof (schema as any).partial === 'function'
      ? (schema as any).partial()
      : schema;
    const result = (partialed as any).safeParse(pinned ?? {});
    if (!result.success) {
      const zerr = result.error;
      const zissues = zerr?.issues ?? zerr?.errors ?? [];
      for (const zi of zissues) {
        issues.push({
          code: 'invalid-args',
          entity,
          path: zi.path ?? [],
          message: zi.message ?? 'invalid args',
        });
      }
    }
  };

  for (const p of reg.predicates.values()) {
    validateArgs(p.argsSchema, p.pinnedArgs, { kind: 'predicate', name: p.name }, true);
  }
  for (const a of reg.actions.values()) {
    validateArgs(a.argsSchema, a.pinnedArgs, { kind: 'action', name: a.name }, true);
  }
  for (const a of reg.aggregatedActions.values()) {
    validateArgs(a.argsSchema, a.pinnedArgs, { kind: 'aggregatedAction', name: a.name }, true);
  }
  for (const a of reg.scheduledActions.values()) {
    validateArgs(a.argsSchema, a.pinnedArgs, { kind: 'scheduledAction', name: a.name }, true);
  }
  for (const r of reg.rules.values()) {
    if (r.argsSchema) validateArgs(r.argsSchema, r.pinnedArgs, { kind: 'rule', name: r.name }, false);
  }

  if (issues.length) throw new RegistrationError(issues);

  // Build dispatch index
  for (const r of reg.rules.values()) {
    let list = reg.dispatch.get(r.eventName);
    if (!list) {
      list = [];
      reg.dispatch.set(r.eventName, list);
    }
    list.push(r);
  }

  // Build adapters
  for (const i of reg.integrations.values()) {
    reg.adapters[i.name] = buildAdapter(i as RegisteredIntegration<string, IntegrationMethods>, {
      clock: opts.clock,
      emit: opts.emitExternalCall,
    });
  }

  return reg;
}
