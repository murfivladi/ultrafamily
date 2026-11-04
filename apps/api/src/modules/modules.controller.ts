import { BadRequestException, Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../common/current-user.decorator';
import type { AuthenticatedUser } from '../common/authed-request';
import { ModulesService } from './modules.service';

const toggleSchema = z.object({ enabled: z.boolean() }).strict();

@Controller('modules')
export class ModulesController {
  constructor(private readonly modules: ModulesService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.modules.list(user);
  }

  @Patch(':moduleId')
  setEnabled(
    @CurrentUser() user: AuthenticatedUser,
    @Param('moduleId') moduleId: string,
    @Body() body: unknown,
  ) {
    const result = toggleSchema.safeParse(body);
    if (!result.success) throw new BadRequestException('invalid_request');
    return this.modules.setEnabled(user, moduleId, result.data.enabled);
  }
}
