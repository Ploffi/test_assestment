/**
 * Pino-compatible logger contract (ADR-011).
 *
 * Object-first, optional message, `child(bindings)` for scoped loggers.
 * Pino and Bunyan satisfy this directly; Winston/log4js users wrap once
 * with a thin adapter.
 *
 * The engine ships a console-backed default and threads scoped child loggers
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

export type ConsoleLoggerTarget = Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;

type LogLevel = keyof ConsoleLoggerTarget;

function writeConsoleLog(
  target: ConsoleLoggerTarget,
  level: LogLevel,
  bindings: object,
  obj: object,
  msg?: string,
): void {
  const payload = Object.keys(bindings).length === 0 ? obj : { ...bindings, ...obj };
  if (msg === undefined) {
    target[level](payload);
    return;
  }
  target[level](payload, msg);
}

export function createConsoleLogger(
  target: ConsoleLoggerTarget = console,
  bindings: object = {},
): Logger {
  return {
    debug(obj: object, msg?: string): void {
      writeConsoleLog(target, 'debug', bindings, obj, msg);
    },
    info(obj: object, msg?: string): void {
      writeConsoleLog(target, 'info', bindings, obj, msg);
    },
    warn(obj: object, msg?: string): void {
      writeConsoleLog(target, 'warn', bindings, obj, msg);
    },
    error(obj: object, msg?: string): void {
      writeConsoleLog(target, 'error', bindings, obj, msg);
    },
    child(childBindings: object): Logger {
      return createConsoleLogger(target, { ...bindings, ...childBindings });
    },
  };
}
