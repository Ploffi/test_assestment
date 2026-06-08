import pino from 'pino';
import type { Logger as EngineLogger } from '@air/engine';
import type { Logger as PinoLogger, LoggerOptions } from 'pino';

export function createDemoLogger(): PinoLogger {
  return pino(createPinoOptions());
}

export function asEngineLogger(logger: PinoLogger): EngineLogger {
  return logger as unknown as EngineLogger;
}

function createPinoOptions(): LoggerOptions {
  return {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        ignore: 'pid,hostname',
        translateTime: 'SYS:standard',
      },
    },
  };
}
