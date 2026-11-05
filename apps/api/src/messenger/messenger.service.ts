import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  ChatMessage,
  ChatModerationEntry,
  ChatSearchHit,
  ChatSummary,
  ChatThreadView,
} from '@ufos/contracts';
import type { z } from 'zod';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { newId } from '../config';
import type { AuthenticatedUser } from '../common/authed-request';
import { DatabaseService } from '../db/database.service';
import { iso } from '../db/rows';
import { escapeLike } from '../common/like';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  toChatMessage,
  toChatMessageVersion,
  toChatSummary,
  type ChatAttachmentRow,
  type ChatMemberRow,
  type ChatMessageRow,
  type ChatReactionRow,
  type ChatRow,
} from '../stage-c/mappers';
import type {
  createChatSchema,
  messagesQuerySchema,
  moderationSchema,
  sendMessageSchema,
  updateChatSchema,
} from './dto';

type CreateChatInput = z.infer<typeof createChatSchema>;
type UpdateChatInput = z.infer<typeof updateChatSchema>;
type SendMessageInput = z.infer<typeof sendMessageSchema>;
type MessagesQuery = z.infer<typeof messagesQuerySchema>;
type ModerationInput = z.infer<typeof moderationSchema>;

const MESSAGE_SELECT = `
  SELECT m.*, u.display_name AS author_name, u.avatar_color AS author_avatar_color,
    (SELECT COUNT(*)::int FROM chat_messages r WHERE r.thread_root_id = m.id) AS reply_count,
    (SELECT COUNT(*)::int FROM chat_receipts d WHERE d.message_id = m.id AND d.delivered_at IS NOT NULL) AS delivered_count,
    (SELECT COUNT(*)::int FROM chat_receipts d WHERE d.message_id = m.id AND d.read_at IS NOT NULL) AS read_count
  FROM chat_messages m
  LEFT JOIN users u ON u.id = m.author_user_id
`;

@Injectable()
export class MessengerService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  // -------------------------------------------------------------------------
  // Chats
  // -------------------------------------------------------------------------

  async listChats(user: AuthenticatedUser, spaceId: string): Promise<ChatSummary[]> {
    await this.access.assert(user.id, spaceId, 'messenger', 'read');
    const rows = await this.db.query<ChatRow>(
      `SELECT c.* FROM chats c
       WHERE c.space_id = $1
         AND (c.visibility = 'space'
              OR EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = c.id AND m.user_id = $2))
       ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
      [spaceId, user.id],
    );
    return Promise.all(rows.map((row) => this.buildChat(user, row)));
  }

  async getChat(user: AuthenticatedUser, spaceId: string, chatId: string): Promise<ChatSummary> {
    await this.access.assert(user.id, spaceId, 'messenger', 'read');
    const row = await this.requireChat(spaceId, chatId);
    await this.assertChatReadable(user, row);
    return this.buildChat(user, row);
  }

  async createChat(
    user: AuthenticatedUser,
    spaceId: string,
    input: CreateChatInput,
  ): Promise<ChatSummary> {
    await this.access.assert(user.id, spaceId, 'messenger', 'create');
    const memberIds = [...new Set([user.id, ...input.memberIds])].filter(
      (id) => id !== user.id || input.kind !== 'direct',
    );
    const included = memberIds.includes(user.id) ? memberIds : [user.id, ...memberIds];
    await this.assertMembers(spaceId, included);

    if (input.kind === 'direct') {
      const other = included.find((id) => id !== user.id);
      if (!other) throw new BadRequestException('direct_chat_requires_another_member');
      const directKey = [user.id, other].sort().join(':');
      const existing = await this.db.queryOne<ChatRow>(
        'SELECT * FROM chats WHERE space_id = $1 AND direct_key = $2',
        [spaceId, directKey],
      );
      if (existing) {
        await this.assertChatReadable(user, existing);
        return this.buildChat(user, existing);
      }
      const created = await this.db.queryOne<ChatRow>(
        `INSERT INTO chats (id, space_id, kind, name, direct_key, created_by)
         VALUES ($1,$2,'direct','',$3,$4) RETURNING *`,
        [newId('cht'), spaceId, directKey, user.id],
      );
      if (!created) throw new NotFoundException('chat_not_created');
      await this.addMembers(created.id, included, user.id);
      await this.audit.record({
        actorUserId: user.id,
        actorEmail: user.email,
        spaceId,
        action: 'messenger.chat.create',
        entity: 'chat',
        entityId: created.id,
        metadata: { kind: 'direct', members: included.length },
      });
      this.realtime.publish(spaceId, 'messenger', user.id, {
        action: 'chat.create',
        chatId: created.id,
      });
      return this.buildChat(user, created);
    }

    const created = await this.db.queryOne<ChatRow>(
      `INSERT INTO chats (id, space_id, kind, name, topic, description, visibility, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        newId('cht'),
        spaceId,
        input.kind,
        input.name,
        input.topic,
        input.description,
        input.visibility,
        user.id,
      ],
    );
    if (!created) throw new NotFoundException('chat_not_created');
    await this.addMembers(created.id, included, user.id);
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'messenger.chat.create',
      entity: 'chat',
      entityId: created.id,
      metadata: { kind: input.kind, name: input.name, members: included.length },
    });
    this.realtime.publish(spaceId, 'messenger', user.id, {
      action: 'chat.create',
      chatId: created.id,
    });
    return this.buildChat(user, created);
  }

  async updateChat(
    user: AuthenticatedUser,
    spaceId: string,
    chatId: string,
    patch: UpdateChatInput,
  ): Promise<ChatSummary> {
    await this.access.assert(user.id, spaceId, 'messenger', 'update');
    const chat = await this.requireChat(spaceId, chatId);
    const member = await this.memberRow(chat.id, user.id);
    await this.assertModerator(user, chat, member);
    const fields: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown) => {
      params.push(value);
      fields.push(`${column} = $${params.length}`);
    };
    if (patch.name !== undefined) push('name', patch.name);
    if (patch.topic !== undefined) push('topic', patch.topic);
    if (patch.description !== undefined) push('description', patch.description);
    if (patch.visibility !== undefined) {
      if (chat.kind === 'direct' && patch.visibility !== 'members') {
        throw new BadRequestException('direct_chat_visibility_fixed');
      }
      push('visibility', patch.visibility);
    }
    if (patch.archived !== undefined) push('archived', patch.archived);
    if (fields.length === 0) return this.buildChat(user, chat);
    params.push(chat.id);
    await this.db.query(
      `UPDATE chats SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $${params.length}`,
      params,
    );
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'messenger.chat.update',
      entity: 'chat',
      entityId: chat.id,
      metadata: { fields: Object.keys(patch) },
    });
    this.realtime.publish(spaceId, 'messenger', user.id, { action: 'chat.update', chatId: chat.id });
    const refreshed = await this.requireChat(spaceId, chatId);
    return this.buildChat(user, refreshed);
  }

  async addChatMembers(
    user: AuthenticatedUser,
    spaceId: string,
    chatId: string,
    memberIds: string[],
  ) {
    await this.access.assert(user.id, spaceId, 'messenger', 'manage_access');
    const chat = await this.requireChat(spaceId, chatId);
    if (chat.kind === 'direct') throw new BadRequestException('direct_chat_members_fixed');
    const member = await this.memberRow(chat.id, user.id);
    await this.assertModerator(user, chat, member);
    await this.assertMembers(spaceId, memberIds);
    await this.addMembers(chat.id, memberIds, user.id);
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'messenger.chat.members.add',
      entity: 'chat',
      entityId: chat.id,
      metadata: { memberIds },
    });
    this.realtime.publish(spaceId, 'messenger', user.id, {
      action: 'chat.members',
      chatId: chat.id,
    });
    return this.buildChat(user, chat);
  }

  async removeChatMember(user: AuthenticatedUser, spaceId: string, chatId: string, memberId: string) {
    await this.access.assert(user.id, spaceId, 'messenger', 'manage_access');
    const chat = await this.requireChat(spaceId, chatId);
    if (chat.kind === 'direct') throw new BadRequestException('direct_chat_members_fixed');
    if (memberId === chat.created_by) throw new BadRequestException('chat_creator_cannot_be_removed');
    const me = await this.memberRow(chat.id, user.id);
    if (memberId !== user.id) await this.assertModerator(user, chat, me);
    await this.db.query('DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2', [
      chat.id,
      memberId,
    ]);
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'messenger.chat.members.remove',
      entity: 'chat',
      entityId: chat.id,
      metadata: { memberId },
    });
    this.realtime.publish(spaceId, 'messenger', user.id, {
      action: 'chat.members',
      chatId: chat.id,
    });
    return { removed: true };
  }

  async setMemberRole(
    user: AuthenticatedUser,
    spaceId: string,
    chatId: string,
    memberId: string,
    role: 'owner' | 'moderator' | 'member',
  ) {
    await this.access.assert(user.id, spaceId, 'messenger', 'manage_access');
    const chat = await this.requireChat(spaceId, chatId);
    const me = await this.memberRow(chat.id, user.id);
    await this.assertModerator(user, chat, me);
    if (role === 'owner' && me?.role !== 'owner' && chat.created_by !== user.id) {
      throw new ForbiddenException('chat_owner_required');
    }
    const updated = await this.db.queryOne<ChatMemberRow>(
      `UPDATE chat_members SET role = $3 WHERE chat_id = $1 AND user_id = $2 RETURNING *`,
      [chat.id, memberId, role],
    );
    if (!updated) throw new NotFoundException('chat_member_not_found');
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'messenger.chat.role',
      entity: 'chat',
      entityId: chat.id,
      metadata: { memberId, role },
    });
    this.realtime.publish(spaceId, 'messenger', user.id, {
      action: 'chat.members',
      chatId: chat.id,
    });
    return { userId: memberId, role };
  }

  async setNotificationLevel(
    user: AuthenticatedUser,
    spaceId: string,
    chatId: string,
    level: 'all' | 'mentions' | 'muted',
  ) {
    await this.access.assert(user.id, spaceId, 'messenger', 'read');
    const chat = await this.requireChat(spaceId, chatId);
    await this.assertChatReadable(user, chat);
    const row = await this.db.queryOne<ChatMemberRow>(
      `INSERT INTO chat_members (chat_id, user_id, notification_level)
       VALUES ($1,$2,$3)
       ON CONFLICT (chat_id, user_id)
       DO UPDATE SET notification_level = EXCLUDED.notification_level
       RETURNING *`,
      [chat.id, user.id, level],
    );
    return { chatId: chat.id, level: row?.notification_level ?? level };
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  async messages(
    user: AuthenticatedUser,
    spaceId: string,
    chatId: string,
    query: MessagesQuery,
  ): Promise<ChatMessage[]> {
    await this.access.assert(user.id, spaceId, 'messenger', 'read');
    const chat = await this.requireChat(spaceId, chatId);
    await this.assertChatReadable(user, chat);
    const conditions = ['m.chat_id = $1'];
    const params: unknown[] = [chat.id];
    if (query.threadRootId) {
      params.push(query.threadRootId);
      conditions.push(`(m.id = $${params.length} OR m.thread_root_id = $${params.length})`);
    } else {
      conditions.push('m.thread_root_id IS NULL');
    }
    if (query.before) {
      params.push(query.before);
      conditions.push(`m.created_at < $${params.length}`);
    }
    if (query.q) {
      params.push(`%${escapeLike(query.q)}%`);
      conditions.push(`m.body ILIKE $${params.length}`);
    }
    params.push(query.limit);
    const rows = await this.db.query<ChatMessageRow>(
      `${MESSAGE_SELECT}
       WHERE ${conditions.join(' AND ')}
       ORDER BY m.created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    const messages = await this.hydrate(rows);
    return messages.reverse();
  }

  async sendMessage(
    user: AuthenticatedUser,
    spaceId: string,
    chatId: string,
    input: SendMessageInput,
  ): Promise<ChatMessage> {
    await this.access.assert(user.id, spaceId, 'messenger', 'create');
    const chat = await this.requireChat(spaceId, chatId);
    await this.assertChatReadable(user, chat);
    const member = await this.memberRow(chat.id, user.id);
    await this.assertNotRestricted(member);

    const body = input.body.trim();
    if (!body && input.attachments.length === 0) {
      throw new BadRequestException('message_body_required');
    }

    // Idempotency: a retried send after a dropped connection returns the
    // original message instead of creating a duplicate.
    if (input.clientKey) {
      const existing = await this.db.queryOne<ChatMessageRow>(
        `${MESSAGE_SELECT} WHERE m.chat_id = $1 AND m.author_user_id = $2 AND m.client_key = $3`,
        [chat.id, user.id, input.clientKey],
      );
      if (existing) {
        return this.firstHydrated([existing]);
      }
    }

    if (input.threadRootId) {
      const root = await this.db.queryOne<{ id: string; thread_root_id: string | null }>(
        'SELECT id, thread_root_id FROM chat_messages WHERE id = $1 AND chat_id = $2',
        [input.threadRootId, chat.id],
      );
      if (!root) throw new NotFoundException('thread_root_not_found');
      if (root.thread_root_id) throw new BadRequestException('nested_threads_not_supported');
    }

    const mentions = [...new Set(input.mentions.filter(Boolean))].slice(0, 30);
    if (mentions.length > 0) await this.assertMembers(spaceId, mentions);

    const id = newId('msg');
    const createdAt = new Date().toISOString();
    const row = await this.db.queryOne<ChatMessageRow>(
      `INSERT INTO chat_messages
         (id, chat_id, space_id, thread_root_id, author_user_id, body, mentions, client_key, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
       RETURNING *`,
      [
        id,
        chat.id,
        spaceId,
        input.threadRootId,
        user.id,
        body,
        JSON.stringify(mentions),
        input.clientKey,
        createdAt,
      ],
    );
    if (!row) throw new NotFoundException('message_not_created');
    for (const attachment of input.attachments) {
      await this.db.query(
        `INSERT INTO chat_attachments (id, message_id, name, kind, url, size_bytes)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [newId('att'), id, attachment.name, attachment.kind, attachment.url, attachment.sizeBytes],
      );
    }
    await this.db.query(
      `INSERT INTO chat_message_versions (id, message_id, version, body, edited_by, created_at)
       VALUES ($1,$2,1,$3,$4,$5)`,
      [newId('mvr'), id, body, user.id, createdAt],
    );
    await this.receipts(user.id, chat, id);
    await this.touchChat(chat.id, id, createdAt);
    if (!input.threadRootId) {
      await this.db.query('UPDATE chat_members SET last_read_at = $3 WHERE chat_id = $1 AND user_id = $2', [
        chat.id,
        user.id,
        createdAt,
      ]);
    }

    this.realtime.publish(spaceId, 'messenger', user.id, {
      action: 'message.create',
      chatId: chat.id,
      messageId: id,
      threadRootId: input.threadRootId,
    });
    await this.notifyMentions(user, chat, mentions, body, id);
    return this.firstHydrated([
      { ...row, author_name: user.displayName, author_avatar_color: user.avatarColor },
    ]);
  }

  async editMessage(
    user: AuthenticatedUser,
    spaceId: string,
    chatId: string,
    messageId: string,
    body: string,
  ): Promise<ChatMessage> {
    await this.access.assert(user.id, spaceId, 'messenger', 'update');
    const chat = await this.requireChat(spaceId, chatId);
    await this.assertChatReadable(user, chat);
    const existing = await this.requireMessage(chat.id, messageId);
    if (existing.deleted_at) throw new BadRequestException('message_deleted');
    const member = await this.memberRow(chat.id, user.id);
    const isModerator = await this.isModerator(user, chat, member);
    if (existing.author_user_id !== user.id && !isModerator) {
      throw new ForbiddenException('message_author_or_moderator_required');
    }
    const version = Number(existing.version ?? 1) + 1;
    await this.db.query(
      `UPDATE chat_messages
       SET body = $2, version = $3, edited_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
         mentions = $4
       WHERE id = $1`,
      [messageId, body, version, existing.mentions ?? JSON.stringify([])],
    );
    await this.db.query(
      `INSERT INTO chat_message_versions (id, message_id, version, body, edited_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (message_id, version) DO UPDATE SET body = EXCLUDED.body`,
      [newId('mvr'), messageId, version, body, user.id],
    );
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'messenger.message.edit',
      entity: 'chat_message',
      entityId: messageId,
      metadata: { version, byModerator: existing.author_user_id !== user.id },
    });
    this.realtime.publish(spaceId, 'messenger', user.id, {
      action: 'message.update',
      chatId: chat.id,
      messageId,
    });
    return this.firstHydrated([await this.requireMessage(chat.id, messageId)]);
  }

  async messageHistory(user: AuthenticatedUser, spaceId: string, chatId: string, messageId: string) {
    await this.access.assert(user.id, spaceId, 'messenger', 'read');
    const chat = await this.requireChat(spaceId, chatId);
    await this.assertChatReadable(user, chat);
    const rows = await this.db.query<{
      version: number | string;
      body: string;
      edited_by: string | null;
      created_at: Date | string;
    }>(
      `SELECT version, body, edited_by, created_at FROM chat_message_versions
       WHERE message_id = $1 ORDER BY version ASC`,
      [messageId],
    );
    return rows.map(toChatMessageVersion);
  }

  async deleteMessage(
    user: AuthenticatedUser,
    spaceId: string,
    chatId: string,
    messageId: string,
    reason: string,
  ) {
    await this.access.assert(user.id, spaceId, 'messenger', 'update');
    const chat = await this.requireChat(spaceId, chatId);
    await this.assertChatReadable(user, chat);
    const existing = await this.requireMessage(chat.id, messageId);
    const member = await this.memberRow(chat.id, user.id);
    const isModerator = await this.isModerator(user, chat, member);
    const isAuthor = existing.author_user_id === user.id;
    if (!isAuthor && !isModerator) throw new ForbiddenException('message_author_or_moderator_required');
    if (isAuthor && !isModerator) {
      // Authors can only withdraw a message inside the retention window; the
      // moderation trail (versions + audit) still records the action.
      await this.access.assert(user.id, spaceId, 'messenger', 'delete');
    }
    await this.db.query(
      `UPDATE chat_messages
       SET deleted_at = CURRENT_TIMESTAMP, deleted_by = $2, updated_at = CURRENT_TIMESTAMP,
         version = version + 1
       WHERE id = $1`,
      [messageId, user.id],
    );
    await this.db.query('DELETE FROM chat_attachments WHERE message_id = $1', [messageId]);
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: isModerator && !isAuthor ? 'messenger.message.moderate_delete' : 'messenger.message.delete',
      entity: 'chat_message',
      entityId: messageId,
      metadata: { chatId: chat.id, reason, byModerator: isModerator },
    });
    if (isModerator && !isAuthor) {
      await this.logModeration(spaceId, chat.id, user.id, 'remove_message', {
        targetUserId: existing.author_user_id,
        targetMessageId: messageId,
        reason,
      });
    }
    this.realtime.publish(spaceId, 'messenger', user.id, {
      action: 'message.delete',
      chatId: chat.id,
      messageId,
    });
    return { deleted: true, moderation: isModerator && !isAuthor };
  }

  async react(
    user: AuthenticatedUser,
    spaceId: string,
    chatId: string,
    messageId: string,
    emoji: string,
  ) {
    await this.access.assert(user.id, spaceId, 'messenger', 'read');
    const chat = await this.requireChat(spaceId, chatId);
    await this.assertChatReadable(user, chat);
    const message = await this.requireMessage(chat.id, messageId);
    if (message.deleted_at) throw new BadRequestException('message_deleted');
    const existing = await this.db.queryOne<{ emoji: string }>(
      'SELECT emoji FROM chat_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
      [messageId, user.id, emoji],
    );
    if (existing) {
      await this.db.query(
        'DELETE FROM chat_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
        [messageId, user.id, emoji],
      );
    } else {
      await this.db.query(
        'INSERT INTO chat_reactions (message_id, user_id, emoji) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [messageId, user.id, emoji],
      );
    }
    this.realtime.publish(spaceId, 'messenger', user.id, {
      action: 'message.reaction',
      chatId: chat.id,
      messageId,
    });
    const [hydrated] = await this.hydrate([message]);
    return { active: !existing, reactions: hydrated?.reactions ?? [] };
  }

  async pin(
    user: AuthenticatedUser,
    spaceId: string,
    chatId: string,
    messageId: string,
    pinned: boolean,
  ) {
    await this.access.assert(user.id, spaceId, 'messenger', 'update');
    const chat = await this.requireChat(spaceId, chatId);
    await this.assertChatReadable(user, chat);
    await this.requireMessage(chat.id, messageId);
    await this.db.query('UPDATE chat_messages SET pinned = $2 WHERE id = $1', [messageId, pinned]);
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: pinned ? 'messenger.message.pin' : 'messenger.message.unpin',
      entity: 'chat_message',
      entityId: messageId,
      metadata: { chatId: chat.id },
    });
    this.realtime.publish(spaceId, 'messenger', user.id, {
      action: 'message.pin',
      chatId: chat.id,
      messageId,
    });
    return { pinned };
  }

  async pinnedMessages(user: AuthenticatedUser, spaceId: string, chatId: string) {
    await this.access.assert(user.id, spaceId, 'messenger', 'read');
    const chat = await this.requireChat(spaceId, chatId);
    await this.assertChatReadable(user, chat);
    const rows = await this.db.query<ChatMessageRow>(
      `${MESSAGE_SELECT} WHERE m.chat_id = $1 AND m.pinned = TRUE AND m.deleted_at IS NULL
       ORDER BY m.created_at DESC LIMIT 50`,
      [chat.id],
    );
    return this.hydrate(rows);
  }

  async thread(user: AuthenticatedUser, spaceId: string, chatId: string, rootId: string): Promise<ChatThreadView> {
    await this.access.assert(user.id, spaceId, 'messenger', 'read');
    const chat = await this.requireChat(spaceId, chatId);
    await this.assertChatReadable(user, chat);
    const rows = await this.db.query<ChatMessageRow>(
      `${MESSAGE_SELECT}
       WHERE m.chat_id = $1 AND (m.id = $2 OR m.thread_root_id = $2)
       ORDER BY m.created_at ASC`,
      [chat.id, rootId],
    );
    const hydrated = await this.hydrate(rows);
    const root = hydrated.find((message) => message.id === rootId) ?? null;
    return { root, replies: hydrated.filter((message) => message.id !== rootId) };
  }

  async markRead(user: AuthenticatedUser, spaceId: string, chatId: string, messageId?: string) {
    await this.access.assert(user.id, spaceId, 'messenger', 'read');
    const chat = await this.requireChat(spaceId, chatId);
    await this.assertChatReadable(user, chat);
    const target = messageId
      ? await this.db.queryOne<{ created_at: Date | string }>(
          'SELECT created_at FROM chat_messages WHERE id = $1 AND chat_id = $2',
          [messageId, chat.id],
        )
      : await this.db.queryOne<{ created_at: Date | string }>(
          'SELECT MAX(created_at) AS created_at FROM chat_messages WHERE chat_id = $1',
          [chat.id],
        );
    const readAt = iso(target?.created_at) ?? new Date().toISOString();
    await this.db.query(
      `INSERT INTO chat_members (chat_id, user_id, last_read_at)
       VALUES ($1,$2,$3)
       ON CONFLICT (chat_id, user_id) DO UPDATE SET last_read_at = EXCLUDED.last_read_at`,
      [chat.id, user.id, readAt],
    );
    await this.db.query(
      `UPDATE chat_receipts SET read_at = COALESCE(read_at, $3), delivered_at = COALESCE(delivered_at, $3)
       WHERE user_id = $1 AND message_id IN (SELECT id FROM chat_messages WHERE chat_id = $2)`,
      [user.id, chat.id, readAt],
    );
    this.realtime.publish(spaceId, 'messenger.receipts', user.id, {
      action: 'chat.read',
      chatId: chat.id,
      userId: user.id,
      readAt,
    });
    return { chatId: chat.id, readAt };
  }

  async search(user: AuthenticatedUser, spaceId: string, query: string): Promise<ChatSearchHit[]> {
    await this.access.assert(user.id, spaceId, 'messenger', 'read');
    const term = query.trim();
    if (!term) return [];
    const rows = await this.db.query<{
      id: string;
      chat_id: string;
      chat_name: string;
      author_name: string | null;
      body: string;
      created_at: Date | string;
    }>(
      `SELECT m.id, m.chat_id, c.name AS chat_name, u.display_name AS author_name, m.body, m.created_at
       FROM chat_messages m
       JOIN chats c ON c.id = m.chat_id
       LEFT JOIN users u ON u.id = m.author_user_id
       WHERE c.space_id = $1
         AND m.deleted_at IS NULL
         AND m.body ILIKE $2
         AND (c.visibility = 'space'
              OR EXISTS (SELECT 1 FROM chat_members cm WHERE cm.chat_id = c.id AND cm.user_id = $3))
       ORDER BY m.created_at DESC
       LIMIT 50`,
      [spaceId, `%${escapeLike(term)}%`, user.id],
    );
    return rows.map((row) => ({
      messageId: row.id,
      chatId: row.chat_id,
      chatName: row.chat_name,
      authorName: row.author_name ?? '',
      body: row.body.slice(0, 300),
      createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    }));
  }

  // -------------------------------------------------------------------------
  // Moderation
  // -------------------------------------------------------------------------

  async moderate(
    user: AuthenticatedUser,
    spaceId: string,
    chatId: string,
    input: ModerationInput,
  ) {
    await this.access.assert(user.id, spaceId, 'messenger', 'update');
    const chat = await this.requireChat(spaceId, chatId);
    const member = await this.memberRow(chat.id, user.id);
    await this.assertModerator(user, chat, member);

    if (input.action === 'remove_message' || input.action === 'restore_message') {
      if (!input.messageId) throw new BadRequestException('message_id_required');
      const message = await this.requireMessage(chat.id, input.messageId);
      if (input.action === 'remove_message') {
        await this.db.query(
          `UPDATE chat_messages SET deleted_at = CURRENT_TIMESTAMP, deleted_by = $2,
             updated_at = CURRENT_TIMESTAMP, version = version + 1
           WHERE id = $1`,
          [message.id, user.id],
        );
        await this.db.query('DELETE FROM chat_attachments WHERE message_id = $1', [message.id]);
      } else {
        const [latest] = await this.db.query<{ body: string }>(
          'SELECT body FROM chat_message_versions WHERE message_id = $1 ORDER BY version DESC LIMIT 1',
          [message.id],
        );
        await this.db.query(
          `UPDATE chat_messages SET deleted_at = NULL, deleted_by = NULL, body = $2,
             updated_at = CURRENT_TIMESTAMP, version = version + 1
           WHERE id = $1`,
          [message.id, latest?.body ?? ''],
        );
      }
      this.realtime.publish(spaceId, 'messenger', user.id, {
        action: 'message.moderate',
        chatId: chat.id,
        messageId: message.id,
      });
    }

    if (input.action === 'pin' || input.action === 'unpin') {
      if (!input.messageId) throw new BadRequestException('message_id_required');
      await this.requireMessage(chat.id, input.messageId);
      await this.db.query('UPDATE chat_messages SET pinned = $2 WHERE id = $1', [
        input.messageId,
        input.action === 'pin',
      ]);
    }

    if (input.action === 'restrict_member') {
      if (!input.targetUserId) throw new BadRequestException('target_user_required');
      if (input.targetUserId === chat.created_by) {
        throw new BadRequestException('chat_creator_cannot_be_restricted');
      }
      await this.db.query(
        `INSERT INTO chat_members (chat_id, user_id, restricted_until)
         VALUES ($1,$2,$3)
         ON CONFLICT (chat_id, user_id)
         DO UPDATE SET restricted_until = EXCLUDED.restricted_until`,
        [chat.id, input.targetUserId, new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()],
      );
    }

    const entry = await this.logModeration(spaceId, chat.id, user.id, input.action, {
      targetUserId: input.targetUserId ?? null,
      targetMessageId: input.messageId ?? null,
      reason: input.reason,
    });
    this.realtime.publish(spaceId, 'messenger', user.id, {
      action: 'chat.moderate',
      chatId: chat.id,
    });
    return entry;
  }

  async moderationLog(user: AuthenticatedUser, spaceId: string, chatId: string): Promise<ChatModerationEntry[]> {
    await this.access.assert(user.id, spaceId, 'messenger', 'read');
    const chat = await this.requireChat(spaceId, chatId);
    const member = await this.memberRow(chat.id, user.id);
    if (!(await this.isModerator(user, chat, member))) {
      throw new ForbiddenException('chat_moderator_required');
    }
    const rows = await this.db.query<{
      id: string;
      chat_id: string;
      actor_user_id: string | null;
      action: string;
      target_user_id: string | null;
      target_message_id: string | null;
      reason: string;
      created_at: Date | string;
    }>('SELECT * FROM chat_moderation_log WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 200', [
      chat.id,
    ]);
    return rows.map((row) => ({
      id: row.id,
      chatId: row.chat_id,
      actorUserId: row.actor_user_id,
      action: row.action,
      targetUserId: row.target_user_id,
      targetMessageId: row.target_message_id,
      reason: row.reason,
      createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    }));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async buildChat(user: AuthenticatedUser, row: ChatRow): Promise<ChatSummary> {
    const members = await this.db.query<ChatMemberRow>(
      `SELECT m.chat_id, m.user_id, m.role, m.notification_level, m.last_read_at,
              u.display_name, u.avatar_color, u.is_child
       FROM chat_members m JOIN users u ON u.id = m.user_id
       WHERE m.chat_id = $1
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END,
                u.display_name ASC`,
      [row.id],
    );
    const me = members.find((member) => member.user_id === user.id) ?? null;
    const unread = await this.db.queryOne<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count FROM chat_messages
       WHERE chat_id = $1 AND deleted_at IS NULL
         AND ($2::timestamptz IS NULL OR created_at > $2)
         AND author_user_id IS NOT NULL AND author_user_id <> $3`,
      [row.id, me?.last_read_at ? iso(me.last_read_at) : null, user.id],
    );
    const mentions = await this.db.queryOne<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count FROM chat_messages
       WHERE chat_id = $1 AND deleted_at IS NULL
         AND mentions @> $2::jsonb
         AND ($3::timestamptz IS NULL OR created_at > $3)`,
      [row.id, JSON.stringify([user.id]), me?.last_read_at ? iso(me.last_read_at) : null],
    );
    const last = await this.db.queryOne<{ body: string; author_name: string | null }>(
      `SELECT m.body, u.display_name AS author_name FROM chat_messages m
       LEFT JOIN users u ON u.id = m.author_user_id
       WHERE m.chat_id = $1 AND m.deleted_at IS NULL
       ORDER BY m.created_at DESC LIMIT 1`,
      [row.id],
    );
    return toChatSummary(row, members, {
      unreadCount: Number(unread?.count ?? 0),
      mentionCount: Number(mentions?.count ?? 0),
      lastMessagePreview: last ? `${last.author_name ?? ''}: ${last.body.slice(0, 120)}`.trim() : '',
      myRole: me?.role ?? null,
      myNotificationLevel: me?.notification_level ?? 'all',
    });
  }

  private async hydrate(rows: ChatMessageRow[]): Promise<ChatMessage[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map((_, index) => `$${index + 1}`).join(',');
    const [reactions, attachments] = await Promise.all([
      this.db.query<ChatReactionRow>(
        `SELECT message_id, emoji, user_id FROM chat_reactions WHERE message_id IN (${placeholders})`,
        ids,
      ),
      this.db.query<ChatAttachmentRow>(
        `SELECT id, message_id, name, kind, url, size_bytes FROM chat_attachments
         WHERE message_id IN (${placeholders})`,
        ids,
      ),
    ]);
    return rows.map((row) =>
      toChatMessage(
        row,
        reactions.filter((reaction) => reaction.message_id === row.id),
        attachments.filter((attachment) => attachment.message_id === row.id),
      ),
    );
  }

  private async firstHydrated(rows: ChatMessageRow[]): Promise<ChatMessage> {
    const [message] = await this.hydrate(rows);
    if (!message) throw new NotFoundException('message_not_found');
    return message;
  }

  private async requireChat(spaceId: string, chatId: string): Promise<ChatRow> {
    const row = await this.db.queryOne<ChatRow>('SELECT * FROM chats WHERE id = $1 AND space_id = $2', [
      chatId,
      spaceId,
    ]);
    if (!row) throw new NotFoundException('chat_not_found');
    return row;
  }

  private async requireMessage(chatId: string, messageId: string): Promise<ChatMessageRow> {
    const row = await this.db.queryOne<ChatMessageRow>(
      'SELECT * FROM chat_messages WHERE id = $1 AND chat_id = $2',
      [messageId, chatId],
    );
    if (!row) throw new NotFoundException('message_not_found');
    return row;
  }

  private async memberRow(chatId: string, userId: string): Promise<ChatMemberRow | null> {
    return this.db.queryOne<ChatMemberRow>(
      'SELECT * FROM chat_members WHERE chat_id = $1 AND user_id = $2',
      [chatId, userId],
    );
  }

  private async assertChatReadable(user: AuthenticatedUser, chat: ChatRow): Promise<void> {
    // Guests never get messenger access (permission matrix), children only see
    // chats they are members of, and private chats stay invisible to the space.
    if (chat.visibility === 'space') return;
    const member = await this.memberRow(chat.id, user.id);
    if (!member) throw new ForbiddenException('chat_member_required');
  }

  private async isModerator(
    user: AuthenticatedUser,
    chat: ChatRow,
    member: ChatMemberRow | null,
  ): Promise<boolean> {
    if (chat.created_by === user.id) return true;
    return member?.role === 'owner' || member?.role === 'moderator';
  }

  private async assertModerator(
    user: AuthenticatedUser,
    chat: ChatRow,
    member: ChatMemberRow | null,
  ): Promise<void> {
    if (!(await this.isModerator(user, chat, member))) {
      throw new ForbiddenException('chat_moderator_required');
    }
  }

  private async assertNotRestricted(member: ChatMemberRow | null): Promise<void> {
    if (!member) return;
    const row = await this.db.queryOne<{ restricted_until: Date | string | null }>(
      'SELECT restricted_until FROM chat_members WHERE chat_id = $1 AND user_id = $2',
      [member.chat_id, member.user_id],
    );
    const until = iso(row?.restricted_until ?? null);
    if (until && new Date(until).getTime() > Date.now()) {
      throw new ForbiddenException('chat_member_restricted');
    }
  }

  private async assertMembers(spaceId: string, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    const placeholders = userIds.map((_, index) => `$${index + 2}`).join(',');
    const rows = await this.db.query<{ user_id: string }>(
      `SELECT user_id FROM memberships WHERE space_id = $1 AND user_id IN (${placeholders})`,
      [spaceId, ...userIds],
    );
    const found = new Set(rows.map((row) => row.user_id));
    const missing = userIds.filter((id) => !found.has(id));
    if (missing.length > 0) throw new BadRequestException('chat_member_not_in_space');
  }

  private async addMembers(chatId: string, userIds: string[], ownerId: string): Promise<void> {
    for (const userId of userIds) {
      await this.db.query(
        `INSERT INTO chat_members (chat_id, user_id, role)
         VALUES ($1,$2,$3)
         ON CONFLICT (chat_id, user_id) DO NOTHING`,
        [chatId, userId, userId === ownerId ? 'owner' : 'member'],
      );
    }
  }

  private async receipts(authorId: string, chat: ChatRow, messageId: string): Promise<void> {
    const members = await this.db.query<{ user_id: string }>(
      'SELECT user_id FROM chat_members WHERE chat_id = $1',
      [chat.id],
    );
    for (const member of members) {
      if (member.user_id === authorId) continue;
      await this.db.query(
        `INSERT INTO chat_receipts (message_id, user_id, delivered_at)
         VALUES ($1,$2,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`,
        [messageId, member.user_id],
      );
    }
  }

  private async touchChat(chatId: string, messageId: string, createdAt: string): Promise<void> {
    await this.db.query(
      `UPDATE chats SET last_message_at = $2, message_count = message_count + 1,
         updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [chatId, createdAt],
    );
    void messageId;
  }

  private async notifyMentions(
    user: AuthenticatedUser,
    chat: ChatRow,
    mentions: string[],
    body: string,
    messageId: string,
  ): Promise<void> {
    if (mentions.length === 0) return;
    const members = await this.db.query<ChatMemberRow>(
      'SELECT * FROM chat_members WHERE chat_id = $1',
      [chat.id],
    );
    const membersById = new Map(members.map((member) => [member.user_id, member]));
    for (const mentionId of mentions) {
      if (mentionId === user.id) continue;
      const member = membersById.get(mentionId);
      if (!member || member.notification_level === 'muted') continue;
      try {
        await this.notifications.notifyUser(mentionId, {
          spaceId: chat.space_id,
          category: 'messenger',
          severity: 'important',
          title: chat.name || user.displayName,
          body: `${user.displayName}: ${body.slice(0, 160)}`,
          sourceModule: 'messenger',
          sourceId: messageId,
          actionUrl: chat.kind === 'direct' ? '/messages' : `/messages?chat=${chat.id}`,
          dedupeKey: `messenger:${chat.id}:${messageId}`,
        });
      } catch {
        // A member may have disabled the category; delivery is best effort.
      }
    }
  }

  private async logModeration(
    spaceId: string,
    chatId: string,
    actorUserId: string,
    action: string,
    input: { targetUserId: string | null; targetMessageId: string | null; reason: string },
  ): Promise<ChatModerationEntry> {
    const id = newId('mod');
    const row = await this.db.queryOne<{
      id: string;
      chat_id: string;
      actor_user_id: string | null;
      action: string;
      target_user_id: string | null;
      target_message_id: string | null;
      reason: string;
      created_at: Date | string;
    }>(
      `INSERT INTO chat_moderation_log
         (id, chat_id, space_id, actor_user_id, action, target_user_id, target_message_id, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        id,
        chatId,
        spaceId,
        actorUserId,
        action,
        input.targetUserId,
        input.targetMessageId,
        input.reason,
      ],
    );
    await this.audit.record({
      actorUserId,
      spaceId,
      action: `messenger.moderation.${action}`,
      entity: 'chat',
      entityId: chatId,
      metadata: { ...input },
    });
    return {
      id: row?.id ?? id,
      chatId,
      actorUserId,
      action,
      targetUserId: input.targetUserId,
      targetMessageId: input.targetMessageId,
      reason: input.reason,
      createdAt: iso(row?.created_at ?? null) ?? new Date().toISOString(),
    };
  }
}
