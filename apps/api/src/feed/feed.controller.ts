import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../common/authed-request';
import { CurrentUser } from '../common/current-user.decorator';
import {
  autoEventSchema,
  commentSchema,
  feedPostSchema,
  feedQuerySchema,
  feedSourcesSchema,
  feedUpdateSchema,
  reactionSchema,
} from './dto';
import { FeedService } from './feed.service';

function spaceFrom(body: unknown): string {
  const spaceId = (body as { spaceId?: string } | null)?.spaceId;
  if (!spaceId) throw new BadRequestException('spaceId_required');
  return spaceId;
}

function querySpace(spaceId?: string): string {
  if (!spaceId) throw new BadRequestException('spaceId_required');
  return spaceId;
}

@Controller('feed')
export class FeedController {
  constructor(private readonly feed: FeedService) {}

  @Get('posts')
  posts(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, string | undefined>,
  ) {
    return this.feed.list(user, querySpace(query.spaceId), feedQuerySchema.parse(query));
  }

  @Post('posts')
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.feed.create(user, spaceFrom(body), feedPostSchema.parse(body));
  }

  @Get('posts/:id')
  post(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.feed.get(user, querySpace(spaceId), id);
  }

  @Patch('posts/:id')
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.feed.update(user, spaceFrom(body), id, feedUpdateSchema.parse(body));
  }

  @Delete('posts/:id')
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.feed.remove(user, querySpace(spaceId), id);
  }

  @Post('posts/:id/comments')
  comment(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    const input = commentSchema.parse(body);
    return this.feed.comment(user, spaceFrom(body), id, input.body);
  }

  @Post('posts/:id/reactions')
  react(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    const input = reactionSchema.parse(body);
    return this.feed.react(user, spaceFrom(body), id, input.emoji);
  }

  @Post('auto-events')
  autoEvents(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.feed.autoEvents(user, spaceFrom(body), autoEventSchema.parse(body));
  }

  @Get('sources')
  sources(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.feed.eventSources(user, querySpace(spaceId));
  }

  @Patch('sources')
  setSources(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = feedSourcesSchema.parse(body);
    return this.feed.setEventSources(user, spaceFrom(body), input.sources);
  }
}
