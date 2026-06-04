/**
 * Top-level builder factory type shapes.
 *
 * The engine package exposes these as values; this file pins their TYPE shapes
 * so consumer code (`import { predicate, action, rule, ... }`) typechecks.
 */

import type { PredicateBuilder } from './predicate.js';
import type {
  ActionBuilder,
  AggregatedActionBuilder,
  ScheduledActionBuilder,
} from './action.js';
import type { RuleBuilder } from './rule.js';
import type { IntegrationBuilder } from './integration.js';
import type {
  WhenNode,
  UseRef,
  AllNode,
  AnyNode,
  NotNode,
} from './combinators.js';
import type { AnyEventPayload } from './webhook.js';

export type DefinePredicate = <Name extends string>(name: Name) => PredicateBuilder<Name>;
export type DefineAction = <Name extends string>(name: Name) => ActionBuilder<Name>;
export type DefineAggregatedAction = <Name extends string>(
  name: Name,
) => AggregatedActionBuilder<Name>;
export type DefineScheduledAction = <Name extends string>(
  name: Name,
) => ScheduledActionBuilder<Name>;
export type DefineRule = <Name extends string>(name: Name) => RuleBuilder<Name>;
export type DefineIntegration = <Name extends string>(name: Name) => IntegrationBuilder<Name>;

/**
 * Combinator factories. Return the specific node type (not the union
 * `WhenNode`) so the rule's `.when(node: ...)` overload picks them up
 * without ambiguity against the inline-function overload.
 */
export type AllFactory = <E extends AnyEventPayload, RuleArgs>(
  ...children: ReadonlyArray<WhenNode<E, RuleArgs>>
) => AllNode<E, RuleArgs>;
export type AnyFactory = <E extends AnyEventPayload, RuleArgs>(
  ...children: ReadonlyArray<WhenNode<E, RuleArgs>>
) => AnyNode<E, RuleArgs>;
export type NotFactory = <E extends AnyEventPayload, RuleArgs>(
  child: WhenNode<E, RuleArgs>,
) => NotNode<E, RuleArgs>;

/**
 * `use(name, args?)` reference. Args values are either plain literals or
 * `(ctx) => value` callbacks that resolve per event (ADR-002, ADR-004).
 *
 * The args record is typed as `any` so use-site callbacks don't trip
 * `noImplicitAny`; TypeScript cannot propagate the surrounding rule's
 * `<E, RuleArgs>` down through this opaque factory, so authors who want
 * narrowed `ctx` annotate the callback explicitly. The runtime validates
 * the merged + resolved args against the referenced predicate's Zod
 * schema before passing to `.fn` (ADR-004).
 */
export type UseFactoryArgValue =
  | ((ctx: any) => unknown)
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | readonly unknown[]
  | { readonly [key: string]: unknown };

export type UseFactory = (
  name: string,
  args?: { readonly [key: string]: UseFactoryArgValue },
) => UseRef;
