import { Controller, Get, Query } from '@nestjs/common';
import type { SearchModule } from '@ufos/contracts';
import type { AuthenticatedUser } from '../common/authed-request';
import { CurrentUser } from '../common/current-user.decorator';
import { querySpace } from '../common/space-param';
import { SearchService } from './search.service';

const MODULES: SearchModule[] = [
  'files',
  'photos',
  'documents',
  'journal',
  'encyclopedia',
  'messenger',
  'feed',
  'tasks',
  'calendar',
];
const day = /^\d{4}-\d{2}-\d{2}$/;

@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  query(
    @CurrentUser() user: AuthenticatedUser,
    @Query('q') q?: string,
    @Query('spaceId') spaceId?: string,
    @Query('modules') modules?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('personId') personId?: string,
  ) {
    const selected = (modules ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value): value is SearchModule => (MODULES as string[]).includes(value));
    return this.search.search(user, {
      q: (q ?? '').slice(0, 200),
      spaceId: spaceId === 'all' ? 'all' : querySpace(spaceId),
      modules: selected,
      from: from && day.test(from) ? from : undefined,
      to: to && day.test(to) ? to : undefined,
      personId: personId || undefined,
    });
  }
}
