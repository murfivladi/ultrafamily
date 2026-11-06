import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

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

// The FTP deployment keeps a single canonical .env at the release root. Look
// for it from the workspace directory and several parents so both
// `npm run start:prod -w @ufos/api` and a direct `node dist/main.js` work.
const cwd = process.cwd();
loadEnvFile(path.join(cwd, '.env'));
let parent = path.dirname(cwd);
for (let level = 0; level < 3; level += 1) {
  loadEnvFile(path.join(parent, '.env'));
  parent = path.dirname(parent);
}

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
  port: Number(process.env.API_PORT || 25031),
  isProduction,
  isTest,
  version: process.env.APP_VERSION || '0.1.0-stage-d',
  databaseUrl,
  driver,
  pgliteDataDir: process.env.PGLITE_DATA_DIR || path.join(process.cwd(), '.data', 'pglite'),
  sessionSecret: process.env.SESSION_SECRET || devSessionSecret,
  sessionCookieName: 'ufos_session',
  bootstrapOwnerEmail: (process.env.BOOTSTRAP_OWNER_EMAIL || 'owner@ultra.family').toLowerCase(),
  bootstrapOwnerPassword:
    process.env.BOOTSTRAP_OWNER_PASSWORD || (isProduction ? '' : 'FamilyOS!2026'),
  storage: {
    driver: (process.env.STORAGE_DRIVER || 'local') as 'local' | 's3',
    dir:
      process.env.STORAGE_DIR ||
      (isTest
        ? path.join(os.tmpdir(), `ufos-storage-test-${process.pid}-${Date.now()}`)
        : path.join(process.cwd(), '.data', 'storage')),
    spaceQuotaBytes: Number(process.env.STORAGE_SPACE_QUOTA_BYTES || 20 * 1024 ** 3),
    userQuotaBytes: Number(process.env.STORAGE_USER_QUOTA_BYTES || 10 * 1024 ** 3),
    maxFileBytes: Number(process.env.STORAGE_MAX_FILE_BYTES || 4 * 1024 ** 3),
    chunkBytes: Number(process.env.STORAGE_CHUNK_BYTES || 4 * 1024 ** 2),
    minFreeBytes: Number(process.env.STORAGE_MIN_FREE_BYTES || 2 * 1024 ** 3),
    trashRetentionDays: Number(process.env.STORAGE_TRASH_RETENTION_DAYS || 30),
  },
  media: {
    // Optional local engines. `{input}` is replaced by the file path; commands
    // are executed without a shell, with a timeout and bounded output.
    ocrCommand: process.env.OCR_COMMAND || '',
    antivirusCommand: process.env.ANTIVIRUS_COMMAND || '',
    videoProbeCommand: process.env.VIDEO_PROBE_COMMAND || '',
    faceEngineCommand: process.env.FACE_ENGINE_COMMAND || '',
    queueIntervalMs: Number(process.env.MEDIA_QUEUE_INTERVAL_MS || (isTest ? 0 : 5000)),
    queueConcurrency: Math.max(1, Number(process.env.MEDIA_QUEUE_CONCURRENCY || 1)),
    commandTimeoutMs: Number(process.env.MEDIA_COMMAND_TIMEOUT_MS || 120_000),
  },
  appOrigins: (process.env.APP_ORIGIN || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
} as const;

if (config.storage.driver !== 'local' && config.storage.driver !== 's3') {
  throw new Error('STORAGE_DRIVER must be local or s3');
}

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
