/**
 * Test harness — exports the runtime engine entry points the tests rely on.
 * Originally these were `declare`d (compile-time only); now they are real
 * imports from the engine package implementation under `../engine`.
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
  createManualClock,
  createSystemClock,
  createNoopLogger,
  fakeEnvelope,
} from '../engine/index.js';
