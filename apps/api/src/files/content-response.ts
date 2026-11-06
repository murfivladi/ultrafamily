import type { Request, Response } from 'express';
import type { StorageAdapter } from '../storage/storage.service';
import { contentDisposition } from './file-types';

export interface ContentTarget {
  key: string;
  size: number;
  mime: string;
  name: string;
  sha256?: string;
  /** Inline rendering is allowed (safe type and the caller asked for it). */
  inline: boolean;
}

/**
 * Streams stored content with HTTP Range support (video seeking, resumable
 * downloads). Inline responses carry a sandboxing CSP so even a mislabelled
 * file cannot run scripts in the family origin.
 */
export function sendContent(
  request: Request,
  response: Response,
  storage: StorageAdapter,
  target: ContentTarget,
): void {
  const mime = target.inline ? target.mime : 'application/octet-stream';
  response.setHeader('Content-Type', mime);
  response.setHeader(
    'Content-Disposition',
    contentDisposition(target.inline ? 'inline' : 'attachment', target.name),
  );
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
  );
  // PDFs are previewed in a same-origin frame by the family UI.
  response.setHeader('X-Frame-Options', 'SAMEORIGIN');
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('Accept-Ranges', 'bytes');
  if (target.sha256) response.setHeader('ETag', `"${target.sha256}"`);

  const range = request.headers.range;
  if (range && target.size > 0) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      let start = match[1] ? Number(match[1]) : NaN;
      let end = match[2] ? Number(match[2]) : NaN;
      if (Number.isNaN(start)) {
        start = Math.max(0, target.size - end);
        end = target.size - 1;
      }
      if (Number.isNaN(end) || end >= target.size) end = target.size - 1;
      if (start <= end && start < target.size) {
        response.status(206);
        response.setHeader('Content-Range', `bytes ${start}-${end}/${target.size}`);
        response.setHeader('Content-Length', String(end - start + 1));
        if (request.method === 'HEAD') {
          response.end();
          return;
        }
        storage.read(target.key, { start, end }).pipe(response);
        return;
      }
      response.status(416).setHeader('Content-Range', `bytes */${target.size}`);
      response.end();
      return;
    }
  }
  response.status(200);
  response.setHeader('Content-Length', String(target.size));
  if (request.method === 'HEAD' || target.size === 0) {
    response.end();
    return;
  }
  const stream = storage.read(target.key);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}
