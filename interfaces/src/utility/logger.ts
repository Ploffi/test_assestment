/**
 * No-op logger (ADR-011).
 *
 * The engine ships this as the default — `new RuleEngine()` without a
 * `logger` option works, with output simply discarded. Consumers who
 * want output pass their own Pino / Bunyan / wrapped-Winston instance.
 *
 * `child(bindings)` returns the same singleton — bindings are dropped on
 * the floor along with everything else. Implementations that *do* render
 * output (Pino) preserve bindings; the no-op variant has no concept of
 * them.
 */

import type { Logger } from '../public/logger.js';

const NOOP_LOGGER: Logger = {
  debug(_obj: object, _msg?: string): void {},
  info(_obj: object, _msg?: string): void {},
  warn(_obj: object, _msg?: string): void {},
  error(_obj: object, _msg?: string): void {},
  child(_bindings: object): Logger {
    return NOOP_LOGGER;
  },
};

export function createNoopLogger(): Logger {
  return NOOP_LOGGER;
}
