/** @type {import('next').NextConfig} */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function loadEnvFile(filename) {
  if (!existsSync(filename)) return;
  for (const line of readFileSync(filename, 'utf8').split(/\r?\n/)) {
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

const cwd = process.cwd();
loadEnvFile(path.join(cwd, '.env'));
let parent = path.dirname(cwd);
for (let level = 0; level < 3; level += 1) {
  loadEnvFile(path.join(parent, '.env'));
  parent = path.dirname(parent);
}
const configuredApiOrigin = process.env.API_PROXY_ORIGIN || 'http://127.0.0.1:25031';
if (configuredApiOrigin === 'https://api.family.vladislavb.qzz.io') {
  throw new Error(
    'API_PROXY_ORIGIN must use the internal backend http://127.0.0.1:25031; the public HTTPS domain caused EPROTO SSL alert 40 in the Next.js proxy.',
  );
}

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // CalDAV clients use collection URLs with a trailing slash; preserve PROPFIND
  // methods and bodies instead of answering with Next.js' 308 redirect.
  skipTrailingSlashRedirect: true,
  allowedDevOrigins: ['*.e2b.app'],
  // Yjs is compiled for both the client and the server graph so exactly one
  // module instance exists (see the webpack alias below).
  transpilePackages: ['@ufos/contracts', 'yjs'],
  // Yjs ships both CJS and ESM builds. Without a single resolution path the
  // SSR and client graph can load two copies, which breaks `instanceof` checks
  // ("Yjs was already imported"). Pin one module and ask Next to compile it.
  webpack: (webpackConfig) => {
    webpackConfig.resolve.alias = {
      ...webpackConfig.resolve.alias,
      yjs$: path.resolve(cwd, '../../node_modules/yjs/dist/yjs.mjs'),
    };
    return webpackConfig;
  },
  // The Stage C collaboration gateway lives at /ws on the API process. HTTP
  // rewrites cannot upgrade a connection, so the WebSocket path is proxied by
  // the small server in scripts/ws-proxy.mjs during development and by the
  // reverse proxy in production (see docs/STAGE-C.md).
  async rewrites() {
    const apiOrigin = configuredApiOrigin;
    return [
      {
        source: '/caldav/:path*',
        destination: `${apiOrigin}/api/caldav/:path*`,
      },
      {
        source: '/api/:path*',
        destination: `${apiOrigin}/api/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(self), microphone=(self), geolocation=(), payment=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
