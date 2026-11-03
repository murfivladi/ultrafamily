import { BadRequestException, Body, Controller, Get, Patch } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { CurrentRequest, CurrentUser } from '../common/current-user.decorator';
import type { AuthenticatedUser, AuthedRequest } from '../common/authed-request';
import { hmac } from '../config';
import { UsersService } from './users.service';

const profileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    language: z.enum(['ru', 'it']).optional(),
    avatarColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
  })
  .strict();

const preferencesSchema = z
  .object({
    theme: z.enum(['family', 'sage', 'twilight']).optional(),
    colorMode: z.enum(['light', 'dark']).optional(),
    density: z.enum(['comfortable', 'compact']).optional(),
    highContrast: z.boolean().optional(),
    largeText: z.boolean().optional(),
    reduceMotion: z.boolean().optional(),
    economyMode: z.boolean().optional(),
    simplifiedUi: z.boolean().optional(),
    widgets: z.array(z.string().max(60)).max(30).optional(),
    favorites: z.array(z.string().max(60)).max(30).optional(),
    quickActions: z.array(z.string().max(60)).max(30).optional(),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException('invalid_request');
  return result.data;
}

function requiredSessionId(request: AuthedRequest): string {
  if (!request.authSession) throw new BadRequestException('session_missing');
  return request.authSession.id;
}

@Controller('profile')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  snapshot(@CurrentUser() user: AuthenticatedUser, @CurrentRequest() request: AuthedRequest) {
    return this.users.snapshot(user.id, requiredSessionId(request));
  }

  @Patch()
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequest() request: AuthedRequest,
    @Body() body: unknown,
  ) {
    const patch = parse(profileSchema, body);
    const updated = await this.users.updateProfile(user.id, patch);
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'profile.update',
      entity: 'user',
      entityId: user.id,
      metadata: { fields: Object.keys(patch) },
    });
    return { ...updated, csrfToken: hmac(requiredSessionId(request)) };
  }

  @Patch('preferences')
  async updatePreferences(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequest() request: AuthedRequest,
    @Body() body: unknown,
  ) {
    const patch = parse(preferencesSchema, body);
    const preferences = await this.users.updatePreferences(user.id, patch);
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'preferences.update',
      entity: 'user_preferences',
      entityId: user.id,
      metadata: { fields: Object.keys(patch) },
    });
    return { preferences, csrfToken: hmac(requiredSessionId(request)) };
  }
}
