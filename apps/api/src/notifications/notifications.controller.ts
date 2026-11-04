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
  preferencesSchema,
  pushSubscriptionSchema,
  testNotificationSchema,
  webhookSchema,
} from './dto';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('spaceId') spaceId?: string,
    @Query('unread') unread?: string,
    @Query('limit') limit?: string,
  ) {
    return this.notifications.list(user, {
      spaceId,
      unreadOnly: unread === 'true',
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('unread-count')
  async unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return { count: await this.notifications.unreadCount(user.id) };
  }

  @Get('preferences')
  preferences(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.getPreferences(user.id);
  }

  @Patch('preferences')
  updatePreferences(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.notifications.updatePreferences(user, preferencesSchema.parse(body));
  }

  @Get('digest')
  digest(@CurrentUser() user: AuthenticatedUser, @Query('period') period = 'daily') {
    return this.notifications.digest(user, period === 'weekly' ? 'weekly' : 'daily');
  }

  @Get('deliveries')
  deliveries(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.notifications.deliveryLog(user, spaceId);
  }

  @Post('dispatch')
  dispatch(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.dispatch(user);
  }

  @Post('test')
  test(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = testNotificationSchema.parse(body ?? {});
    return this.notifications.test(user, input.severity);
  }

  @Post('read-all')
  readAll(@CurrentUser() user: AuthenticatedUser, @Body() body: { spaceId?: string } = {}) {
    return this.notifications.markAllRead(user.id, body.spaceId);
  }

  @Post(':id/read')
  read(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.notifications.markRead(user.id, id);
  }

  @Post('push')
  subscribePush(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = pushSubscriptionSchema.parse(body);
    return this.notifications.subscribePush(user, input.endpoint, input.keys);
  }

  @Delete('push/:id')
  deletePush(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.notifications.deletePush(user, id);
  }

  @Get('webhooks')
  webhooks(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    if (!spaceId) throw new BadRequestException('spaceId_required');
    return this.notifications.listWebhooks(user, spaceId);
  }

  @Post('webhooks')
  createWebhook(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = webhookSchema.parse(body);
    const spaceId = (body as { spaceId?: string }).spaceId;
    if (!spaceId) throw new BadRequestException('spaceId_required');
    return this.notifications.createWebhook(user, spaceId, input);
  }

  @Post('reminders/sweep')
  reminderSweep(@CurrentUser() user: AuthenticatedUser, @Body() body: { spaceId?: string }) {
    if (!body.spaceId) throw new BadRequestException('spaceId_required');
    return this.notifications.reminderSweep(user, body.spaceId);
  }
}
