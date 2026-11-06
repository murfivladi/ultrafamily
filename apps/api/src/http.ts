import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { config } from './config';

// WebDAV streams request bodies itself (PUT of arbitrary files), so the
// generic body parsers must not consume them.
function skipWebDav(parser: RequestHandler): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    if (request.path.startsWith('/api/webdav/')) {
      next();
      return;
    }
    parser(request, response, next);
  };
}

/** HTTP middleware shared by the production bootstrap and the test app. */
export function configureHttp(app: NestExpressApplication): void {
  app.use(skipWebDav(express.json({ limit: '1mb' })));
  app.use(skipWebDav(express.urlencoded({ extended: false, limit: '64kb' })));
  app.use(
    skipWebDav(
      express.text({
        type: [
          'text/calendar',
          'application/calendar+xml',
          'text/xml',
          'application/xml',
          'text/plain',
        ],
        limit: '1mb',
      }),
    ),
  );
  // Chunked file uploads (Stage D): one chunk per request, bounded size.
  app.use(
    skipWebDav(
      express.raw({
        type: 'application/octet-stream',
        limit: config.storage.chunkBytes + 64 * 1024,
      }),
    ),
  );
  app.use(cookieParser());
}
