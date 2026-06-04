/**
 * Pino-compatible logger contract (ADR-011).
 *
 * Object-first, optional message, `child(bindings)` for scoped loggers.
 * Pino and Bunyan satisfy this directly; Winston/log4js users wrap once
 * with a thin adapter.
 *
 * The engine ships a no-op default and threads scoped child loggers
 * through `ctx.logger` with `deliveryId`, `ruleId`, and entity-name
 * bindings already attached.
 */
export interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  child(bindings: object): Logger;
}
