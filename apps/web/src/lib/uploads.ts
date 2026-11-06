'use client';

import type { FileItem, UploadSession } from '@ufos/contracts';
import { ApiError, apiFetch, getCsrfToken } from '@/lib/api';

export interface UploadOptions {
  spaceId: string;
  file: File;
  folderId?: string | null;
  module?: 'files' | 'photos';
  visibility?: 'space' | 'private';
  onConflict?: 'version' | 'rename' | 'fail';
  takenAt?: string | null;
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
}

const MAX_RETRIES = 4;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function putChunk(path: string, data: Blob, signal?: AbortSignal): Promise<UploadSession> {
  const headers = new Headers({ 'Content-Type': 'application/octet-stream' });
  const csrf = getCsrfToken();
  if (csrf) headers.set('x-csrf-token', csrf);
  const response = await fetch(`/api${path}`, {
    method: 'PUT',
    body: data,
    headers,
    credentials: 'same-origin',
    signal,
  });
  const payload = (await response.json().catch(() => null)) as
    (UploadSession & { code?: string; message?: string }) | null;
  if (!response.ok) {
    throw new ApiError(response.status, payload?.message ?? payload?.code ?? 'upload_failed');
  }
  return payload as UploadSession;
}

/**
 * Chunked, resumable upload: each chunk is retried with backoff and the
 * server acknowledges already-stored chunks idempotently, so a flaky mobile
 * connection only re-sends the chunk that failed.
 */
export async function uploadFile(options: UploadOptions): Promise<FileItem> {
  const { spaceId, file } = options;
  const session = await apiFetch<UploadSession>('/files/uploads', {
    method: 'POST',
    body: {
      spaceId,
      name: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      folderId: options.folderId ?? null,
      module: options.module ?? 'files',
      visibility: options.visibility ?? 'space',
    },
  });
  let index = session.nextIndex;
  let sent = session.receivedBytes;
  options.onProgress?.(sent, file.size);
  while (index < session.totalChunks) {
    const start = index * session.chunkBytes;
    const blob = file.slice(start, Math.min(file.size, start + session.chunkBytes));
    let attempt = 0;
    for (;;) {
      try {
        const status = await putChunk(
          `/files/uploads/${encodeURIComponent(session.id)}/chunks/${index}?spaceId=${encodeURIComponent(spaceId)}`,
          blob,
          options.signal,
        );
        index = status.nextIndex;
        sent = status.receivedBytes;
        break;
      } catch (error) {
        attempt += 1;
        const status = error instanceof ApiError ? error.status : 0;
        if (
          options.signal?.aborted ||
          attempt > MAX_RETRIES ||
          (status >= 400 && status < 500 && status !== 409)
        ) {
          throw error;
        }
        await wait(500 * 2 ** attempt);
        // Ask the server where to resume (a chunk may have landed before the error).
        const current = await apiFetch<UploadSession>(
          `/files/uploads/${encodeURIComponent(session.id)}?spaceId=${encodeURIComponent(spaceId)}`,
        );
        index = current.nextIndex;
        sent = current.receivedBytes;
        if (index >= session.totalChunks) break;
      }
    }
    options.onProgress?.(sent, file.size);
  }
  return apiFetch<FileItem>(`/files/uploads/${encodeURIComponent(session.id)}/complete`, {
    method: 'POST',
    body: {
      spaceId,
      module: options.module ?? 'files',
      onConflict: options.onConflict ?? 'version',
      takenAt: options.takenAt ?? null,
    },
  });
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / 1024 ** exponent;
  return `${amount >= 10 || exponent === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[exponent]}`;
}

export function contentUrl(spaceId: string, fileId: string, download = false): string {
  const params = new URLSearchParams({ spaceId });
  if (download) params.set('download', '1');
  return `/api/files/${encodeURIComponent(fileId)}/content?${params.toString()}`;
}

/** Turns API error codes like `file_blocked:type_mismatch` into a translation key. */
export function errorKey(error: unknown): string {
  const message = error instanceof ApiError ? error.message : '';
  const code = message.split(':')[1] ?? message;
  return code ? `stageD.error.${code}` : 'common.error';
}

export function describeError(t: (key: string) => string, error: unknown): string {
  const key = errorKey(error);
  const text = t(key);
  return text === key ? t('common.error') : text;
}
