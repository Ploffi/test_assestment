/* Runtime utility implementations of the public `src/public` shapes that
 * are NOT engine-coupled — system clock, logger, combinators, in-memory stores.
 * Engine builders (`predicate`, `action`, `rule`, ...) and `createEngine`
 * itself live elsewhere; they need real evaluation logic, not just data
 * factories. */

export * from './clock.js';
export * from './logger.js';
export * from './combinators.js';
export * from './aggregation-store.js';
export * from './scheduled-store.js';
