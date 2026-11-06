import { z } from 'zod';

const id = z.string().min(1).max(120);
const isoDate = z
  .string()
  .datetime({ offset: true })
  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/));

export const albumSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).default(''),
  fileIds: z.array(id).max(500).default([]),
});

export const albumPatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  coverFileId: id.nullable().optional(),
});

export const albumItemsSchema = z.object({ fileIds: z.array(id).min(1).max(500) });

export const mediaMetaSchema = z.object({
  takenAt: isoDate.nullable().optional(),
  place: z.string().max(240).optional(),
  description: z.string().max(4000).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
});

export const commentSchema = z.object({ body: z.string().trim().min(1).max(2000) });

export const reactionSchema = z.object({
  emoji: z.string().min(1).max(16),
  on: z.boolean().default(true),
});

export const favoriteSchema = z.object({ on: z.boolean().default(true) });

export const peopleTagSchema = z.object({
  personId: id.nullable().default(null),
  userId: id.nullable().default(null),
  label: z.string().trim().max(120).default(''),
  box: z
    .object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      w: z.number().min(0).max(1),
      h: z.number().min(0).max(1),
    })
    .nullable()
    .default(null),
});

export const faceSchema = z.object({
  userId: id.optional(),
  enabled: z.boolean(),
  consent: z.boolean().default(false),
});

export const shareSchema = z.object({
  targetKind: z.enum(['file', 'album']),
  targetId: id,
  label: z.string().trim().max(200).default(''),
  expiresInHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 90),
  password: z.string().min(6).max(200).nullable().default(null),
  allowDownload: z.boolean().default(false),
});
