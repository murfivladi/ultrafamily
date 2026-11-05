import { z } from 'zod';

const isoDate = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'invalid_date');

export const feedPostSchema = z
  .object({
    kind: z.enum(['news', 'announcement', 'photo', 'moment']).default('news'),
    title: z.string().trim().max(200).default(''),
    body: z.string().trim().max(20000).default(''),
    visibility: z.enum(['household', 'network']).default('household'),
    audienceSpaceIds: z.array(z.string().min(1)).max(20).default([]),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    media: z
      .array(
        z.object({
          id: z.string().min(1).max(120),
          name: z.string().trim().min(1).max(240),
          url: z.string().trim().min(1).max(2000),
          kind: z.enum(['photo', 'file']).default('photo'),
        }),
      )
      .max(20)
      .default([]),
    pinned: z.boolean().default(false),
    publishedAt: isoDate.optional(),
  })
  .refine((value) => value.title.length > 0 || value.body.length > 0, {
    message: 'post_body_required',
    path: ['body'],
  });

export const feedUpdateSchema = z.object({
  kind: z.enum(['news', 'announcement', 'photo', 'moment']).optional(),
  title: z.string().trim().max(200).optional(),
  body: z.string().trim().max(20000).optional(),
  visibility: z.enum(['household', 'network']).optional(),
  audienceSpaceIds: z.array(z.string().min(1)).max(20).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  media: z
    .array(
      z.object({
        id: z.string().min(1).max(120),
        name: z.string().trim().min(1).max(240),
        url: z.string().trim().min(1).max(2000),
        kind: z.enum(['photo', 'file']).default('photo'),
      }),
    )
    .max(20)
    .optional(),
  pinned: z.boolean().optional(),
});

export const commentSchema = z.object({
  body: z.string().trim().min(1).max(4000),
});

export const reactionSchema = z.object({
  emoji: z.string().trim().min(1).max(16),
});

export const feedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: isoDate.optional(),
  kind: z.enum(['news', 'announcement', 'photo', 'moment', 'system']).optional(),
  q: z.string().trim().max(200).optional(),
  tag: z.string().trim().max(40).optional(),
});

export const autoEventSchema = z.object({
  kinds: z
    .array(z.enum(['birthdays', 'plans', 'photos', 'announcements']))
    .min(1)
    .max(4)
    .default(['birthdays', 'plans', 'photos', 'announcements']),
});

export const feedSourcesSchema = z.object({
  sources: z.array(z.enum(['birthdays', 'plans', 'photos', 'announcements'])).max(4),
});
