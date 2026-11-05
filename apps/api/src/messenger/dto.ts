import { z } from 'zod';

const isoDate = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'invalid_date');

export const chatKindSchema = z.enum(['direct', 'group', 'channel']);

export const createChatSchema = z
  .object({
    kind: chatKindSchema.default('group'),
    name: z.string().trim().max(120).default(''),
    topic: z.string().trim().max(200).default(''),
    description: z.string().max(4000).default(''),
    visibility: z.enum(['members', 'space']).default('members'),
    memberIds: z.array(z.string().min(1)).max(50).default([]),
  })
  .refine((value) => value.kind !== 'direct' || value.memberIds.length === 1, {
    message: 'direct_chat_requires_exactly_one_member',
    path: ['memberIds'],
  })
  .refine((value) => value.kind === 'direct' || value.name.length > 0, {
    message: 'chat_name_required',
    path: ['name'],
  });

export const updateChatSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  topic: z.string().trim().max(200).optional(),
  description: z.string().max(4000).optional(),
  visibility: z.enum(['members', 'space']).optional(),
  archived: z.boolean().optional(),
});

export const chatMembersSchema = z.object({
  memberIds: z.array(z.string().min(1)).min(1).max(50),
});

export const chatMemberRoleSchema = z.object({
  role: z.enum(['owner', 'moderator', 'member']),
});

export const chatNotificationSchema = z.object({
  level: z.enum(['all', 'mentions', 'muted']),
});

export const sendMessageSchema = z.object({
  body: z.string().max(8000).default(''),
  threadRootId: z.string().min(1).nullable().default(null),
  mentions: z.array(z.string().min(1)).max(30).default([]),
  attachments: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(240),
        kind: z.enum(['file', 'photo', 'link']).default('file'),
        url: z.string().trim().min(1).max(2000),
        sizeBytes: z.number().int().nonnegative().max(2_000_000_000).default(0),
      }),
    )
    .max(10)
    .default([]),
  clientKey: z.string().trim().min(1).max(120).nullable().default(null),
});

export const editMessageSchema = z.object({
  body: z.string().trim().min(1).max(8000),
});

export const deleteMessageSchema = z.object({
  reason: z.string().trim().max(500).default(''),
});

export const reactionSchema = z.object({
  emoji: z.string().trim().min(1).max(16),
});

export const pinSchema = z.object({
  pinned: z.boolean(),
});

export const messagesQuerySchema = z.object({
  before: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  threadRootId: z.string().min(1).optional(),
  q: z.string().trim().max(200).optional(),
});

export const readSchema = z.object({
  messageId: z.string().min(1).optional(),
});

export const moderationSchema = z.object({
  action: z.enum(['remove_message', 'restrict_member', 'restore_message', 'pin', 'unpin']),
  messageId: z.string().min(1).optional(),
  targetUserId: z.string().min(1).optional(),
  reason: z.string().trim().max(500).default(''),
});
