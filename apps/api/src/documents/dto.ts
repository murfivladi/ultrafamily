import { z } from 'zod';

export const documentKindSchema = z.enum(['note', 'document', 'table', 'presentation']);

export const documentSchema = z.object({
  title: z.string().trim().min(1).max(240),
  kind: documentKindSchema.default('note'),
  format: z.enum(['text', 'markdown', 'csv', 'slides']).default('markdown'),
  parentId: z.string().min(1).nullable().default(null),
  content: z.string().max(500_000).default(''),
  template: z.enum(['blank', 'minutes', 'checklist', 'table', 'presentation']).default('blank'),
});

export const documentPatchSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  kind: documentKindSchema.optional(),
  format: z.enum(['text', 'markdown', 'csv', 'slides']).optional(),
  parentId: z.string().min(1).nullable().optional(),
  archived: z.boolean().optional(),
  note: z.string().trim().max(500).optional(),
});

export const documentContentSchema = z.object({
  content: z.string().max(500_000),
  expectedVersion: z.number().int().nonnegative(),
  note: z.string().trim().max(500).default(''),
});

export const collaboratorSchema = z.object({
  userId: z.string().min(1),
  permission: z.enum(['read', 'comment', 'edit']),
});

export const commentSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  anchor: z
    .object({
      from: z.number().int().min(0),
      to: z.number().int().min(0),
      quote: z.string().max(500).default(''),
    })
    .nullable()
    .default(null),
});

export const cursorSchema = z.object({
  anchor: z.number().int().min(0),
  head: z.number().int().min(0),
  editing: z.boolean().default(false),
});

export const restoreSchema = z.object({
  version: z.number().int().min(1),
});
