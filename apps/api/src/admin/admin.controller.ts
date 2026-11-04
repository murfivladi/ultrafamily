import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../common/current-user.decorator';
import type { AuthenticatedUser } from '../common/authed-request';
import { AdminService } from './admin.service';

@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get()
  snapshot(@CurrentUser() user: AuthenticatedUser) {
    return this.admin.snapshot(user.id);
  }

  @Get('audit/verify')
  verifyAudit(@CurrentUser() user: AuthenticatedUser) {
    return this.admin.verifyAudit(user.id);
  }
}
