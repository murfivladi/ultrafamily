import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

interface AttemptWindow {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

@Injectable()
export class LoginThrottleService {
  private readonly windows = new Map<string, AttemptWindow>();

  assertAllowed(key: string): void {
    const now = Date.now();
    const window = this.windows.get(key);
    if (!window || window.resetAt <= now) return;
    if (window.count >= MAX_ATTEMPTS) {
      throw new HttpException('too_many_login_attempts', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  recordFailure(key: string): void {
    const now = Date.now();
    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    } else {
      current.count += 1;
    }
    if (this.windows.size > 1000) this.cleanup(now);
  }

  clear(key: string): void {
    this.windows.delete(key);
  }

  private cleanup(now: number): void {
    for (const [key, value] of this.windows) {
      if (value.resetAt <= now) this.windows.delete(key);
    }
  }
}
