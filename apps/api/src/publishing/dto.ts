import { z } from 'zod';

const language = z.enum(['ru', 'it']);
const visibility = z.enum(['public', 'network', 'household']);

export const createDraftSchema = z.object({
  title: z.string().trim().min(1).max(200),
  excerpt: z.string().max(600).default(''),
  body: z.string().max(30_000).default(''),
  language: language.default('ru'),
  visibility: visibility.default('household'),
  audienceSpaceIds: z.array(z.string()).max(50).default([]),
  guestShared: z.boolean().default(false),
  slug: z.string().trim().min(1).max(160).optional(),
});

export const updatePostSchema = createDraftSchema.partial();

export const publishSchema = z.object({
  visibility: visibility.optional(),
  audienceSpaceIds: z.array(z.string()).max(50).optional(),
  guestShared: z.boolean().optional(),
});

export const unpublishSchema = z.object({
  reason: z.string().max(300).optional(),
});
