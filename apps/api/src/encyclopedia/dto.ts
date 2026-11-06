import { z } from 'zod';

const id = z.string().min(1).max(120);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const contacts = z
  .object({
    phone: z.string().max(60).optional(),
    email: z.string().max(200).optional(),
    address: z.string().max(400).optional(),
  })
  .default({});

export const personSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  birthName: z.string().trim().max(200).default(''),
  birthDate: day.nullable().default(null),
  deathDate: day.nullable().default(null),
  birthPlace: z.string().trim().max(200).default(''),
  biography: z.string().max(50_000).default(''),
  contacts,
  contactVisibility: z.enum(['owner', 'adults', 'family']).default('adults'),
  visibility: z.enum(['private', 'family']).default('family'),
  linkedUserId: id.nullable().default(null),
});

export const personPatchSchema = z.object({
  fullName: z.string().trim().min(1).max(200).optional(),
  birthName: z.string().trim().max(200).optional(),
  birthDate: day.nullable().optional(),
  deathDate: day.nullable().optional(),
  birthPlace: z.string().trim().max(200).optional(),
  biography: z.string().max(50_000).optional(),
  contacts: contacts.optional(),
  contactVisibility: z.enum(['owner', 'adults', 'family']).optional(),
  visibility: z.enum(['private', 'family']).optional(),
  linkedUserId: id.nullable().optional(),
});

export const relationSchema = z.object({
  personId: id,
  relatedPersonId: id,
  kind: z.enum(['parent', 'spouse', 'sibling']),
  sinceDate: day.nullable().default(null),
  note: z.string().max(500).default(''),
});

export const linkSchema = z.object({
  targetKind: z.enum(['journal', 'file', 'document', 'album']),
  targetId: id,
});

export const publicationSchema = z.object({
  publish: z.boolean(),
  livingConsent: z.boolean().default(false),
  consentNote: z.string().max(1000).default(''),
});
