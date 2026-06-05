/**
 * Test harness — exports the runtime engine entry points plus test-only
 * helpers from one seam.
 */

export {
  predicate,
  action,
  aggregatedAction,
  scheduledAction,
  rule,
  integration,
  all,
  any,
  not,
  use,
  createEngine,
  createInMemoryAggregationStore,
  createInMemoryScheduledStore,
  createSystemClock,
  createConsoleLogger,
} from '../index.js';

export { createManualClock, fakeEnvelope } from './_helpers.js';
export type { DeepPartial, RuleCtx } from './_helpers.js';
