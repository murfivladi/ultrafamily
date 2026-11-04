import { z } from 'zod';

const date = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'invalid_date');

export const listSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['grocery', 'household', 'trip', 'gifts', 'other']).default('grocery'),
});

export const itemSchema = z.object({
  listId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  quantity: z.number().min(0.01).max(100000).default(1),
  unit: z.string().max(30).default('pcs'),
  category: z.string().max(60).default('other'),
  assignedUserId: z.string().nullable().default(null),
  sourceModule: z.string().max(60).nullable().default(null),
  sourceId: z.string().max(200).nullable().default(null),
  notes: z.string().max(1000).default(''),
});

export const updateItemSchema = itemSchema
  .partial()
  .omit({ listId: true })
  .extend({
    listId: z.string().min(1),
    expectedVersion: z.number().int().nonnegative(),
    checked: z.boolean().optional(),
  });

export const mergeSchema = z.object({
  listId: z.string().min(1),
});

export const generateSchema = z.object({
  listId: z.string().min(1),
  from: date.optional(),
  to: date.optional(),
});

export const claimSchema = z.object({
  listId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
});

export const acceptSuggestionSchema = z.object({
  listId: z.string().min(1),
});
