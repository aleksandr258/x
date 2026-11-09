import { createRequire } from 'node:module';
import pino, { type Logger as PinoInstance } from 'pino';
import type { Logger } from '../../application/ports/logger.js';

export interface PinoLoggerOptions {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly pretty: boolean;
}

export class PinoLoggerAdapter implements Logger {
  public constructor(private readonly instance: PinoInstance) {}

  public static create(options: PinoLoggerOptions): PinoLoggerAdapter {
    let usePretty = options.pretty;
    if (usePretty) {
      try {
        const req = createRequire(import.meta.url);
        req.resolve('pino-pretty');
      } catch {
        usePretty = false;
      }
    }

    const pinoInstance = pino({
      level: options.level,
      ...(usePretty
        ? {
            transport: {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname',
              },
            },
          }
        : {}),
    });

    return new PinoLoggerAdapter(pinoInstance);
  }

  public debug(msg: string, meta?: Record<string, unknown>): void {
    if (meta) {
      this.instance.debug(meta, msg);
    } else {
      this.instance.debug(msg);
    }
  }

  public info(msg: string, meta?: Record<string, unknown>): void {
    if (meta) {
      this.instance.info(meta, msg);
    } else {
      this.instance.info(msg);
    }
  }

  public warn(msg: string, meta?: Record<string, unknown>): void {
    if (meta) {
      this.instance.warn(meta, msg);
    } else {
      this.instance.warn(msg);
    }
  }

  public error(msg: string, meta?: Record<string, unknown>): void {
    if (meta) {
      this.instance.error(meta, msg);
    } else {
      this.instance.error(msg);
    }
  }

  public child(bindings: Record<string, unknown>): Logger {
    return new PinoLoggerAdapter(this.instance.child(bindings));
  }
}
