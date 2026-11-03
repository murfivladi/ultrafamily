import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { CurrentRequest, CurrentUser } from '../common/current-user.decorator';
import type { AuthenticatedUser, AuthedRequest } from '../common/authed-request';
import { Public } from '../common/public.decorator';
import { config } from '../config';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import {
  emailSchema,
  loginSchema,
  parseBody,
  registerSchema,
  resetSchema,
  tokenSchema,
} from './dto';
import { SessionService } from './session.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @Post('register')
  async register(@Body() body: unknown) {
    return this.auth.register(parseBody(registerSchema, body));
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: unknown,
    @Req() request: AuthedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const input = parseBody(loginSchema, body);
    const created = await this.auth.login(input, request);
    response.setHeader('Cache-Control', 'no-store');
    response.cookie(
      config.sessionCookieName,
      created.token,
      this.sessions.cookieOptions(created.maxAgeMs),
    );
    return this.users.snapshot(created.row.user_id, created.row.id);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  verifyEmail(@Body() body: unknown) {
    return this.auth.verifyEmail(parseBody(tokenSchema, body).token);
  }

  @Public()
  @Post('password-reset/request')
  @HttpCode(HttpStatus.OK)
  requestPasswordReset(@Body() body: unknown) {
    return this.auth.requestPasswordReset(parseBody(emailSchema, body).email);
  }

  @Public()
  @Post('password-reset/confirm')
  @HttpCode(HttpStatus.OK)
  resetPassword(@Body() body: unknown) {
    const input = parseBody(resetSchema, body);
    return this.auth.resetPassword(input.token, input.password);
  }

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser, @CurrentRequest() request: AuthedRequest) {
    if (!request.authSession) throw new Error('Session missing');
    return this.users.snapshot(user.id, request.authSession.id);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequest() request: AuthedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const sessionId = request.authSession?.id;
    if (sessionId) await this.sessions.revoke(user.id, sessionId);
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'auth.logout',
      entity: 'session',
      entityId: sessionId ?? null,
    });
    response.clearCookie(config.sessionCookieName, this.sessions.cookieOptions());
    return { ok: true };
  }

  @Get('sessions')
  async listSessions(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequest() request: AuthedRequest,
  ) {
    return this.sessions.list(user.id, request.authSession?.id);
  }

  @Delete('sessions/:id')
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') sessionId: string,
    @CurrentRequest() request: AuthedRequest,
  ) {
    const revoked = await this.sessions.revoke(user.id, sessionId);
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      action: revoked ? 'auth.session.revoked' : 'auth.session.revoke_ignored',
      entity: 'session',
      entityId: sessionId,
    });
    return { ok: revoked, csrfToken: this.sessions.csrfToken(request.authSession?.id ?? '') };
  }

  @Post('sessions/revoke-all')
  @HttpCode(HttpStatus.OK)
  async revokeAllSessions(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequest() request: AuthedRequest,
  ) {
    const count = await this.sessions.revokeAll(user.id, request.authSession?.id);
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'auth.sessions.revoke_all',
      entity: 'session',
      metadata: { count },
    });
    return { ok: true, count, csrfToken: this.sessions.csrfToken(request.authSession?.id ?? '') };
  }
}
