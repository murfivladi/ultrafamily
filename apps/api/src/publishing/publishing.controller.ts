import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../common/authed-request';
import { CurrentUser } from '../common/current-user.decorator';
import { createDraftSchema, publishSchema, unpublishSchema, updatePostSchema } from './dto';
import { PublishingService } from './publishing.service';

function spaceFrom(body: unknown): string {
  const spaceId = (body as { spaceId?: string } | null)?.spaceId;
  if (!spaceId) throw new BadRequestException('spaceId_required');
  return spaceId;
}

function querySpace(spaceId?: string): string {
  if (!spaceId) throw new BadRequestException('spaceId_required');
  return spaceId;
}

@Controller('publishing')
export class PublishingController {
  constructor(private readonly publishing: PublishingService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.publishing.list(user, querySpace(spaceId));
  }

  @Get('stats')
  stats(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.publishing.stats(user, querySpace(spaceId));
  }

  @Get('shared')
  shared(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.publishing.shared(user, querySpace(spaceId));
  }

  @Post('drafts')
  createDraft(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.publishing.createDraft(user, spaceFrom(body), createDraftSchema.parse(body));
  }

  @Patch(':id')
  updateDraft(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.publishing.updateDraft(user, spaceFrom(body), id, updatePostSchema.parse(body));
  }

  @Get(':id/preview')
  preview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.publishing.preview(user, querySpace(spaceId), id);
  }

  @Post(':id/publish')
  publish(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.publishing.publish(user, spaceFrom(body), id, publishSchema.parse(body ?? {}));
  }

  @Post(':id/unpublish')
  unpublish(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.publishing.unpublish(user, spaceFrom(body), id, unpublishSchema.parse(body ?? {}));
  }
}
