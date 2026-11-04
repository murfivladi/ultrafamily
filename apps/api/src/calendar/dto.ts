import { z } from 'zod';

const date = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'invalid_date');
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const kind = z.enum(['personal', 'family', 'network', 'birthdays', 'holidays', 'trip']);
const status = z.enum(['confirmed', 'tentative', 'cancelled']);
const rsvp = z.enum(['pending', 'accepted', 'declined', 'tentative']);

export const calendarSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: kind.default('family'),
  color: color.default('#5B7CFA'),
  visibility: z.enum(['household', 'network', 'private']).default('household'),
});

export const eventSchema = z.object({
  calendarId: z.string().min(1).optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).default(''),
  location: z.string().max(300).default(''),
  startsAt: date,
  endsAt: date,
  allDay: z.boolean().default(false),
  timezone: z.string().max(80).default('Europe/Rome'),
  category: z.string().max(60).default('family'),
  color: color.default('#5B7CFA'),
  recurrenceRule: z.string().max(300).nullable().default(null),
  status: status.default('confirmed'),
  participantIds: z.array(z.string()).max(100).default([]),
  links: z
    .array(z.object({ module: z.string().max(60), targetId: z.string().max(200) }))
    .max(20)
    .default([]),
});

export const updateEventSchema = eventSchema.partial().extend({
  expectedVersion: z.number().int().nonnegative(),
});

export const exceptionSchema = z.object({
  occurrenceStart: date,
  action: z.enum(['cancelled', 'modified']),
  overrideStartsAt: date.nullable().optional(),
  overrideEndsAt: date.nullable().optional(),
  overrideTitle: z.string().max(200).nullable().optional(),
});

export const rsvpSchema = z.object({ rsvp });

export const linkSchema = z.object({
  module: z.string().min(1).max(60),
  targetId: z.string().min(1).max(200),
});

export const freeBusySchema = z.object({
  from: date.optional(),
  to: date.optional(),
  participantIds: z.array(z.string()).max(100).default([]),
});

export const suggestTimeSchema = z.object({
  from: date.optional(),
  to: date.optional(),
  participantIds: z.array(z.string()).max(100).default([]),
  durationMinutes: z.number().int().min(15).max(480).default(60),
});

export const importSchema = z.object({
  ics: z.string().min(20).max(900_000),
  calendarId: z.string().optional(),
});

export const tokenSchema = z.object({
  calendarId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  expiresInDays: z.number().int().min(1).max(365).default(90),
});
