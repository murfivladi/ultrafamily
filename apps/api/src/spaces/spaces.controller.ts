import { BadRequestException, Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  ALL_ACTIONS,
  isModuleId,
  type Action,
  type ModuleId,
  type OverrideDecision,
} from '@ufos/contracts';
import { z } from 'zod';
import { CurrentUser } from '../common/current-user.decorator';
import type { AuthenticatedUser } from '../common/authed-request';
import { SpacesService } from './spaces.service';

const createSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    kind: z.enum(['family_network', 'household']).default('household'),
    networkId: z.string().max(100).nullable().optional(),
  })
  .strict();

const inviteSchema = z
  .object({
    role: z.enum(['space_admin', 'adult', 'child', 'guest']),
    email: z.string().trim().toLowerCase().email().nullable().optional(),
    expiresInDays: z.number().int().min(1).max(30).optional(),
  })
  .strict();

const overrideSchema = z
  .object({
    userId: z.string().min(1),
    moduleId: z.string().min(1),
    action: z.string().min(1),
    decision: z.enum(['allow', 'deny']).nullable(),
  })
  .strict();

const grantSchema = z
  .object({
    userId: z.string().min(1),
    moduleId: z.string().min(1),
    granted: z.boolean(),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException('invalid_request');
  return result.data;
}

@Controller('spaces')
export class SpacesController {
  constructor(private readonly spaces: SpacesService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.spaces.list(user.id);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.spaces.create(user, parse(createSchema, body));
  }

  @Post(':id/switch')
  switchSpace(@CurrentUser() user: AuthenticatedUser, @Param('id') spaceId: string) {
    return this.spaces.switchSpace(user, spaceId);
  }

  @Get(':id/members')
  members(@CurrentUser() user: AuthenticatedUser, @Param('id') spaceId: string) {
    return this.spaces.members(user, spaceId);
  }

  @Post(':id/invitations')
  invite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') spaceId: string,
    @Body() body: unknown,
  ) {
    return this.spaces.createInvitation(user, spaceId, parse(inviteSchema, body));
  }

  @Patch(':id/permissions')
  setOverride(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') spaceId: string,
    @Body() body: unknown,
  ) {
    const input = parse(overrideSchema, body);
    if (!isModuleId(input.moduleId) || !ALL_ACTIONS.includes(input.action as Action)) {
      throw new BadRequestException('invalid_permission_key');
    }
    return this.spaces.setOverride(user, spaceId, {
      userId: input.userId,
      moduleId: input.moduleId as ModuleId,
      action: input.action as Action,
      decision: input.decision as OverrideDecision | null,
    });
  }

  @Patch(':id/sensitive-grants')
  setGrant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') spaceId: string,
    @Body() body: unknown,
  ) {
    const input = parse(grantSchema, body);
    if (!isModuleId(input.moduleId)) throw new BadRequestException('invalid_module');
    return this.spaces.setSensitiveGrant(user, spaceId, {
      userId: input.userId,
      moduleId: input.moduleId as ModuleId,
      granted: input.granted,
    });
  }
}
