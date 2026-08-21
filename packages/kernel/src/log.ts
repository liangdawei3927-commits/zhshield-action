export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export class Logger {
  private level: LogLevel;
  private prefix: string;

  constructor(context: string, level: LogLevel = 'info') {
    this.level = level;
    this.prefix = `[${context}]`;
  }

  debug(message: string, ...args: unknown[]): void {
    if (LEVEL_ORDER[this.level] <= LEVEL_ORDER.debug) {
      console.debug(this.timestamp(), this.prefix, message, ...args);
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (LEVEL_ORDER[this.level] <= LEVEL_ORDER.info) {
      console.info(this.timestamp(), this.prefix, message, ...args);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (LEVEL_ORDER[this.level] <= LEVEL_ORDER.warn) {
      console.warn(this.timestamp(), this.prefix, message, ...args);
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (LEVEL_ORDER[this.level] <= LEVEL_ORDER.error) {
      console.error(this.timestamp(), this.prefix, message, ...args);
    }
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private timestamp(): string {
    return new Date().toISOString();
  }
}
