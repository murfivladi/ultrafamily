import { randomBytes } from 'node:crypto';

const target = process.env.FTP_TARGET ?? '';
if (target !== 'backend' && target !== 'frontend') {
  console.error('FTP_TARGET must be backend or frontend.');
  process.exit(1);
}

const clean = (value) =>
  String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
const version =
  clean(process.env.RELEASE_VERSION || '0.1.0-stage-d').replace(/[^A-Za-z0-9._-]+/g, '-') ||
  '0.1.0-stage-d';
const appOrigin = clean(process.env.APP_ORIGIN);
const apiProxyOrigin = clean(process.env.API_PROXY_ORIGIN || 'http://127.0.0.1:25031');
const bootstrapOwnerEmail = clean(process.env.BOOTSTRAP_OWNER_EMAIL || 'owner@ultra.family');

const lines = ['NODE_ENV=production', `APP_VERSION=${version}`];
if (appOrigin) lines.push(`APP_ORIGIN=${appOrigin}`);

if (target === 'backend') {
  lines.push(
    `SESSION_SECRET=${randomBytes(48).toString('base64url')}`,
    `BOOTSTRAP_OWNER_PASSWORD=Ufos-${randomBytes(18).toString('base64url')}!`,
    `BOOTSTRAP_OWNER_EMAIL=${bootstrapOwnerEmail}`,
    'API_PORT=25031',
    'DB_DRIVER=postgres',
    'DATABASE_SSL=false',
    'DB_POOL_SIZE=8',
    'PGLITE_DATA_DIR=.data/pglite',
    'SEED_DEMO_DATA=false',
  );
} else {
  lines.push(
    'PORT=26287',
    'WEB_PORT=26287',
    'NEXT_PUBLIC_DEMO_PASSWORD=',
    `API_PROXY_ORIGIN=${apiProxyOrigin}`,
  );
}

process.stdout.write(`${lines.join('\n')}\n`);
