import { Injectable } from '@nestjs/common';
import { redact } from './redact';

type Level = 'info' | 'warn' | 'error';

@Injectable()
export class AppLogger {
  private write(level: Level, message: string, context?: Record<string, unknown>): void {
    const record = {
      ts: new Date().toISOString(),
      level,
      service: 'api',
      message: message.slice(0, 300),
      ...(context ? { context: redact(context) } : {}),
    };
    const line = JSON.stringify(record);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  log(message: string, context?: Record<string, unknown>): void {
    this.write('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.write('warn', message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.write('error', message, context);
  }
}
