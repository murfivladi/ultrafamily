import { z } from 'zod';

const date = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'invalid_date');
const status = z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled']);
const priority = z.enum(['low', 'normal', 'high', 'urgent']);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const listSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['list', 'board', 'project', 'household', 'shopping']).default('list'),
  color: color.default('#14B8A6'),
});

export const taskSchema = z.object({
  listId: z.string().min(1).optional(),
  parentTaskId: z.string().nullable().optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).default(''),
  status: status.default('todo'),
  priority: priority.default('normal'),
  category: z.string().max(60).default('home'),
  assigneeUserId: z.string().nullable().default(null),
  dueAt: date.nullable().default(null),
  estimateMinutes: z.number().int().min(0).max(1440).default(30),
  complexity: z.number().int().min(1).max(5).default(2),
  recurrenceRule: z.string().max(300).nullable().default(null),
  links: z
    .array(z.object({ module: z.string().max(60), targetId: z.string().max(200) }))
    .max(20)
    .default([]),
});

export const updateTaskSchema = taskSchema.partial().extend({
  expectedVersion: z.number().int().nonnegative(),
});

export const commentSchema = z.object({
  body: z.string().trim().min(1).max(3000),
});

export const attachmentSchema = z.object({
  name: z.string().trim().min(1).max(200),
  url: z.string().url().max(1000),
  mimeType: z.string().max(120).nullable().optional(),
  sizeBytes: z.number().int().min(0).max(50_000_000).nullable().optional(),
});

export const dependencySchema = z.object({
  dependsOnTaskId: z.string().min(1),
});

export const linkSchema = z.object({
  module: z.string().min(1).max(60),
  targetId: z.string().min(1).max(200),
});

export const autoAssignSchema = z.object({
  taskIds: z.array(z.string()).min(1).max(100),
});

export const prioritizeSchema = z.object({
  apply: z.boolean().default(false),
});

export const splitSchema = z.object({
  count: z.number().int().min(2).max(5).default(3),
  apply: z.boolean().default(false),
});

export const templateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  fields: z.record(z.string(), z.unknown()).default({}),
});

export const applyTemplateSchema = z.object({
  templateId: z.string().min(1),
  overrides: z.record(z.string(), z.unknown()).default({}),
});
