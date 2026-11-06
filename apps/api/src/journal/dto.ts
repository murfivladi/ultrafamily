import { z } from 'zod';

const id = z.string().min(1).max(120);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const journalSchema = z.object({
  kind: z.enum(['diary', 'story']).default('diary'),
  title: z.string().trim().max(240).default(''),
  body: z.string().max(200_000).default(''),
  visibility: z.enum(['private', 'family']).default('private'),
  mood: z.string().max(40).default(''),
  entryDate: day.default(() => new Date().toISOString().slice(0, 10)),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  fileIds: z.array(id).max(50).default([]),
  eventIds: z.array(id).max(20).default([]),
  personIds: z.array(id).max(50).default([]),
});

export const journalPatchSchema = z.object({
  kind: z.enum(['diary', 'story']).optional(),
  title: z.string().trim().max(240).optional(),
  body: z.string().max(200_000).optional(),
  visibility: z.enum(['private', 'family']).optional(),
  mood: z.string().max(40).optional(),
  entryDate: day.optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  fileIds: z.array(id).max(50).optional(),
  eventIds: z.array(id).max(20).optional(),
  personIds: z.array(id).max(50).optional(),
});
