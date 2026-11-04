import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import { IS_PUBLIC_KEY } from '../common/public.decorator';
import type { AuthedRequest } from '../common/authed-request';
import { config } from '../config';
import { SessionService } from './session.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const isPublic = Boolean(
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]),
    );

    this.assertAllowedOrigin(request);
    const cookies = (request as AuthedRequest & { cookies?: Record<string, string> }).cookies;
    const token = cookies?.[config.sessionCookieName];
    const resolved = token ? await this.sessions.resolve(token) : null;

    if (resolved) {
      request.authUser = resolved.user;
      request.authSession = resolved.session;
    }

    if (isPublic) return true;
    if (!resolved) throw new UnauthorizedException('authentication_required');

    if (!SAFE_METHODS.has(request.method)) {
      const provided = request.headers['x-csrf-token'];
      const providedToken = Array.isArray(provided) ? provided[0] : provided;
      const expected = this.sessions.csrfToken(resolved.session.id);
      if (!providedToken || !constantTimeEquals(providedToken, expected)) {
        throw new ForbiddenException('csrf_token_invalid');
      }
    }
    return true;
  }

  private assertAllowedOrigin(request: AuthedRequest): void {
    if (config.appOrigins.length === 0) return;
    const origin = request.headers.origin;
    if (!origin || SAFE_METHODS.has(request.method)) return;
    const originValue = Array.isArray(origin) ? origin[0] : origin;
    if (!originValue || config.appOrigins.includes(originValue)) return;
    throw new ForbiddenException('origin_not_allowed');
  }
}
