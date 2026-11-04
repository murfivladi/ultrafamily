import { z } from 'zod';

const channel = z.enum(['in_app', 'push', 'email', 'telegram', 'webhook']);

export const preferencesSchema = z.object({
  channels: z.record(z.string(), z.array(channel)).optional(),
  quietHours: z
    .object({
      enabled: z.boolean(),
      from: z.string().regex(/^\d{2}:\d{2}$/),
      to: z.string().regex(/^\d{2}:\d{2}$/),
      timezone: z.string().min(1).max(80),
    })
    .optional(),
  dailyDigest: z.boolean().optional(),
  weeklyDigest: z.boolean().optional(),
  urgentOverride: z.boolean().optional(),
  categories: z.record(z.string(), z.boolean()).optional(),
});

export const testNotificationSchema = z.object({
  severity: z.enum(['info', 'important', 'urgent']).default('info'),
});

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.record(z.string(), z.string()).default({}),
});

export const webhookSchema = z.object({
  url: z.string().url().max(1000),
  secret: z.string().min(12).max(300),
  events: z.array(z.string().max(60)).max(30).default([]),
  enabled: z.boolean().default(false),
});
