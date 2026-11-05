import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { AuthenticatedUser } from '../common/authed-request';
import { CurrentUser } from '../common/current-user.decorator';
import { CallsService } from './calls.service';

function spaceFrom(body: unknown): string {
  const spaceId = (body as { spaceId?: string } | null)?.spaceId;
  if (!spaceId) throw new BadRequestException('spaceId_required');
  return spaceId;
}

function querySpace(spaceId?: string): string {
  if (!spaceId) throw new BadRequestException('spaceId_required');
  return spaceId;
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['audio', 'video']).default('video'),
  inviteUserIds: z.array(z.string().min(1)).max(20).default([]),
});

const joinSchema = z.object({
  audio: z.boolean().optional(),
  video: z.boolean().optional(),
});

const stateSchema = z.object({
  audio: z.boolean().optional(),
  video: z.boolean().optional(),
  screen: z.boolean().optional(),
  connectionState: z.enum(['new', 'connecting', 'connected', 'disconnected', 'failed']).optional(),
  quality: z
    .object({
      rttMs: z.number().nullable().optional(),
      packetsLost: z.number().nullable().optional(),
      bitrateKbps: z.number().nullable().optional(),
    })
    .optional(),
});

@Controller('calls')
export class CallsController {
  constructor(private readonly calls: CallsService) {}

  @Get('rooms')
  rooms(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.calls.rooms(user, querySpace(spaceId));
  }

  @Post('rooms')
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.calls.createRoom(user, spaceFrom(body), createSchema.parse(body));
  }

  @Get('rooms/:id')
  room(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.calls.room(user, querySpace(spaceId), id);
  }

  @Post('rooms/:id/join')
  join(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.calls.join(user, spaceFrom(body), id, joinSchema.parse(body));
  }

  @Post('rooms/:id/leave')
  leave(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.calls.leave(user, spaceFrom(body), id);
  }

  @Post('rooms/:id/close')
  close(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.calls.close(user, spaceFrom(body), id);
  }

  @Post('rooms/:id/state')
  state(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.calls.updateState(user, spaceFrom(body), id, stateSchema.parse(body));
  }

  @Get('rooms/:id/signals')
  signals(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.calls.pendingSignals(user, querySpace(spaceId), id);
  }

  @Get('rooms/:id/diagnostics')
  diagnostics(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.calls.diagnostics(user, querySpace(spaceId), id);
  }

  @Get('ice-servers')
  ice(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.calls.rooms(user, querySpace(spaceId)).then(() => ({
      turnConfigured: Boolean(process.env.WEBRTC_TURN_URLS),
    }));
  }
}
