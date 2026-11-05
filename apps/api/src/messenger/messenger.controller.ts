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
  chatMemberRoleSchema,
  chatMembersSchema,
  chatNotificationSchema,
  createChatSchema,
  deleteMessageSchema,
  editMessageSchema,
  messagesQuerySchema,
  moderationSchema,
  pinSchema,
  reactionSchema,
  sendMessageSchema,
  updateChatSchema,
} from './dto';
import { MessengerService } from './messenger.service';

function spaceFrom(body: unknown): string {
  const spaceId = (body as { spaceId?: string } | null)?.spaceId;
  if (!spaceId) throw new BadRequestException('spaceId_required');
  return spaceId;
}

function querySpace(spaceId?: string): string {
  if (!spaceId) throw new BadRequestException('spaceId_required');
  return spaceId;
}

@Controller('messenger')
export class MessengerController {
  constructor(private readonly messenger: MessengerService) {}

  @Get('chats')
  chats(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.messenger.listChats(user, querySpace(spaceId));
  }

  @Post('chats')
  createChat(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.messenger.createChat(user, spaceFrom(body), createChatSchema.parse(body));
  }

  @Get('chats/:id')
  chat(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.messenger.getChat(user, querySpace(spaceId), id);
  }

  @Patch('chats/:id')
  updateChat(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.messenger.updateChat(user, spaceFrom(body), id, updateChatSchema.parse(body));
  }

  @Post('chats/:id/members')
  addMembers(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = chatMembersSchema.parse(body);
    return this.messenger.addChatMembers(user, spaceFrom(body), id, input.memberIds);
  }

  @Delete('chats/:id/members/:memberId')
  removeMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.messenger.removeChatMember(user, querySpace(spaceId), id, memberId);
  }

  @Patch('chats/:id/members/:memberId/role')
  setRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Body() body: unknown,
  ) {
    const input = chatMemberRoleSchema.parse(body);
    return this.messenger.setMemberRole(user, spaceFrom(body), id, memberId, input.role);
  }

  @Patch('chats/:id/notifications')
  notifications(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = chatNotificationSchema.parse(body);
    return this.messenger.setNotificationLevel(user, spaceFrom(body), id, input.level);
  }

  @Get('chats/:id/messages')
  messages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query() query: Record<string, string | undefined>,
  ) {
    return this.messenger.messages(user, querySpace(query.spaceId), id, messagesQuerySchema.parse(query));
  }

  @Post('chats/:id/messages')
  send(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.messenger.sendMessage(user, spaceFrom(body), id, sendMessageSchema.parse(body));
  }

  @Patch('messages/:id')
  edit(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    const input = editMessageSchema.parse(body);
    const chatId = (body as { chatId?: string }).chatId;
    if (!chatId) throw new BadRequestException('chatId_required');
    return this.messenger.editMessage(user, spaceFrom(body), chatId, id, input.body);
  }

  @Get('messages/:id/versions')
  versions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
    @Query('chatId') chatId?: string,
  ) {
    if (!chatId) throw new BadRequestException('chatId_required');
    return this.messenger.messageHistory(user, querySpace(spaceId), chatId, id);
  }

  @Delete('messages/:id')
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
    @Query('chatId') chatId?: string,
    @Query('reason') reason = '',
  ) {
    if (!chatId) throw new BadRequestException('chatId_required');
    return this.messenger.deleteMessage(
      user,
      querySpace(spaceId),
      chatId,
      id,
      deleteMessageSchema.parse({ reason }).reason,
    );
  }

  @Post('messages/:id/reactions')
  react(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    const input = reactionSchema.parse(body);
    const chatId = (body as { chatId?: string }).chatId;
    if (!chatId) throw new BadRequestException('chatId_required');
    return this.messenger.react(user, spaceFrom(body), chatId, id, input.emoji);
  }

  @Post('messages/:id/pin')
  pin(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    const input = pinSchema.parse(body);
    const chatId = (body as { chatId?: string }).chatId;
    if (!chatId) throw new BadRequestException('chatId_required');
    return this.messenger.pin(user, spaceFrom(body), chatId, id, input.pinned);
  }

  @Get('chats/:id/pinned')
  pinned(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Query('spaceId') spaceId?: string) {
    return this.messenger.pinnedMessages(user, querySpace(spaceId), id);
  }

  @Get('chats/:id/threads/:rootId')
  thread(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('rootId') rootId: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.messenger.thread(user, querySpace(spaceId), id, rootId);
  }

  @Post('chats/:id/read')
  read(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    const messageId = (body as { messageId?: string } | null)?.messageId;
    return this.messenger.markRead(user, spaceFrom(body), id, messageId);
  }

  @Get('search')
  search(
    @CurrentUser() user: AuthenticatedUser,
    @Query('spaceId') spaceId?: string,
    @Query('q') q = '',
  ) {
    return this.messenger.search(user, querySpace(spaceId), q);
  }

  @Post('chats/:id/moderation')
  moderate(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.messenger.moderate(user, spaceFrom(body), id, moderationSchema.parse(body));
  }

  @Get('chats/:id/moderation')
  moderation(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Query('spaceId') spaceId?: string) {
    return this.messenger.moderationLog(user, querySpace(spaceId), id);
  }
}
