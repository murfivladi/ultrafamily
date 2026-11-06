import { Controller, Get, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/authed-request';
import { CurrentUser } from '../common/current-user.decorator';
import { querySpace } from '../common/space-param';
import { MemoriesService } from './memories.service';

@Controller('memories')
export class MemoriesController {
  constructor(private readonly memories: MemoriesService) {}

  @Get('timeline')
  timeline(
    @CurrentUser() user: AuthenticatedUser,
    @Query('spaceId') spaceId?: string,
    @Query('year') year?: string,
  ) {
    return this.memories.timeline(
      user,
      querySpace(spaceId),
      year && /^\d{4}$/.test(year) ? Number(year) : undefined,
    );
  }

  @Get('collections')
  collections(
    @CurrentUser() user: AuthenticatedUser,
    @Query('spaceId') spaceId?: string,
    @Query('date') date?: string,
  ) {
    return this.memories.collections(user, querySpace(spaceId), date ?? '');
  }
}
