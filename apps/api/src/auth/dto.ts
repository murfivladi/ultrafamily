import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

const password = z
  .string()
  .min(12)
  .max(128)
  .regex(/[a-zа-яё]/, 'password_needs_lowercase')
  .regex(/[A-ZА-ЯЁ]/, 'password_needs_uppercase')
  .regex(/\d/, 'password_needs_digit');

export const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(1).max(200),
  })
  .strict();

export const registerSchema = z
  .object({
    inviteToken: z.string().trim().min(8).max(200),
    email: z.string().trim().toLowerCase().email(),
    displayName: z.string().trim().min(1).max(80),
    password,
    language: z.enum(['ru', 'it']).default('ru'),
  })
  .strict();

export const tokenSchema = z.object({ token: z.string().min(10).max(500) }).strict();
export const emailSchema = z.object({ email: z.string().trim().toLowerCase().email() }).strict();
export const resetSchema = z.object({ token: z.string().min(10).max(500), password }).strict();

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException('invalid_request');
  return result.data;
}
