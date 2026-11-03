import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function loadEnvFile(filename: string): void {
  if (!existsSync(filename)) return;
  const contents = readFileSync(filename, 'utf8');
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const separator = trimmed.indexOf('=');
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const root = path.resolve(process.cwd(), '../..');
loadEnvFile(path.join(root, '.env'));
loadEnvFile(path.join(process.cwd(), '.env'));

export const isProduction = process.env.NODE_ENV === 'production';
export const isTest = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;

const devSessionSecret = 'ultra-family-os-development-only-secret';
const databaseUrl = process.env.DATABASE_URL || '';
const requestedDriver = process.env.DB_DRIVER || 'auto';
const driver: 'postgres' | 'pglite' =
  requestedDriver === 'postgres' || (requestedDriver === 'auto' && Boolean(databaseUrl))
    ? 'postgres'
    : 'pglite';

if (driver === 'postgres' && !databaseUrl) {
  throw new Error('DB_DRIVER=postgres requires DATABASE_URL');
}
if (isProduction && process.env.SESSION_SECRET === undefined) {
  throw new Error('SESSION_SECRET is required in production');
}
if (isProduction && !databaseUrl) {
  throw new Error('DATABASE_URL is required in production');
}

export const config = {
  port: Number(process.env.API_PORT || 3001),
  isProduction,
  isTest,
  version: process.env.APP_VERSION || '0.1.0-stage-a',
  databaseUrl,
  driver,
  pgliteDataDir: process.env.PGLITE_DATA_DIR || path.join(process.cwd(), '.data', 'pglite'),
  sessionSecret: process.env.SESSION_SECRET || devSessionSecret,
  sessionCookieName: 'ufos_session',
  bootstrapOwnerEmail: (process.env.BOOTSTRAP_OWNER_EMAIL || 'owner@ultra.family').toLowerCase(),
  bootstrapOwnerPassword:
    process.env.BOOTSTRAP_OWNER_PASSWORD || (isProduction ? '' : 'FamilyOS!2026'),
  appOrigins: (process.env.APP_ORIGIN || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
} as const;

if (isProduction && !config.bootstrapOwnerPassword) {
  throw new Error('BOOTSTRAP_OWNER_PASSWORD is required for first production bootstrap');
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hmac(value: string): string {
  return crypto.createHmac('sha256', config.sessionSecret).update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}
