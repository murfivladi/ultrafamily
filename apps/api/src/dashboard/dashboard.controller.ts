import { Controller, Get } from '@nestjs/common';
import { CurrentRequest, CurrentUser } from '../common/current-user.decorator';
import type { AuthenticatedUser, AuthedRequest } from '../common/authed-request';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  snapshot(@CurrentUser() user: AuthenticatedUser, @CurrentRequest() request: AuthedRequest) {
    if (!request.authSession) throw new Error('Session missing');
    return this.dashboard.snapshot(user, request.authSession.id);
  }
}
