import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { execFile } from 'node:child_process';
import type { MediaEngineStatus, MediaJobSummary } from '@ufos/contracts';
import { AppLogger } from '../common/app-logger.service';
import { config, newId } from '../config';
import { DatabaseService } from '../db/database.service';
import { iso, parseJson } from '../db/rows';
import { RealtimeService } from '../realtime/realtime.service';
import type { FileRow } from '../stage-d/mappers';
import { StorageService } from '../storage/storage.service';
import { mediaMetadata } from './media-meta';
import { extractText, MAX_EXTRACTED_CHARS } from './text-extract';

export type MediaJobKind = 'scan' | 'metadata' | 'ocr' | 'video' | 'faces';

interface JobRow {
  id: string;
  space_id: string;
  file_id: string;
  kind: MediaJobKind;
  status: MediaJobSummary['status'];
  attempts: number;
  last_error: string;
  updated_at: Date | string;
}

const MAX_ATTEMPTS = 3;
const MAX_TEXT_SOURCE_BYTES = 32 * 1024 * 1024;

/** Runs a configured local engine without a shell; `{input}` is the file path. */
export function runEngine(
  command: string,
  input: string,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const parts = command.split(/\s+/).filter(Boolean);
  const [binary, ...args] = parts;
  if (!binary) return Promise.reject(new Error('engine_not_configured'));
  const finalArgs = args.some((arg) => arg.includes('{input}'))
    ? args.map((arg) => arg.replace('{input}', input))
    : [...args, input];
  return new Promise((resolve) => {
    execFile(
      binary,
      finalArgs,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
            ? Number((error as unknown as { code: number }).code)
            : error
              ? -1
              : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr || error?.message || '') });
      },
    );
  });
}

/**
 * Persistent, bounded media queue. On a small VPS it runs in-process with a
 * concurrency of 1; heavy engines (OCR, antivirus, video probing, faces) are
 * optional local commands and can live on a separate worker host that runs
 * the same API image with only the queue enabled.
 */
@Injectable()
export class MediaQueueService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = 0;
  private lastPurge = 0;

  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly realtime: RealtimeService,
    private readonly logger: AppLogger,
  ) {}

  onModuleInit(): void {
    if (config.media.queueIntervalMs > 0) {
      this.timer = setInterval(() => {
        void this.tick();
      }, config.media.queueIntervalMs);
      this.timer.unref?.();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  engines(): Omit<MediaEngineStatus, 'queue'> {
    const engine = (command: string) => ({
      available: Boolean(command),
      engine: command ? (command.split(/\s+/)[0] ?? '') : 'not_configured',
    });
    return {
      ocr: engine(config.media.ocrCommand),
      antivirus: engine(config.media.antivirusCommand),
      video: engine(config.media.videoProbeCommand),
      faces: engine(config.media.faceEngineCommand),
    };
  }

  async status(spaceId: string): Promise<MediaEngineStatus> {
    const rows = await this.db.query<{ status: string; count: number | string }>(
      `SELECT status, COUNT(*)::int AS count FROM media_jobs WHERE space_id = $1 GROUP BY status`,
      [spaceId],
    );
    const count = (status: string) => Number(rows.find((row) => row.status === status)?.count ?? 0);
    return {
      ...this.engines(),
      queue: {
        queued: count('queued'),
        running: count('running'),
        failed: count('failed'),
        concurrency: config.media.queueConcurrency,
      },
    };
  }

  async jobs(spaceId: string, fileId?: string): Promise<MediaJobSummary[]> {
    const rows = await this.db.query<JobRow>(
      `SELECT * FROM media_jobs WHERE space_id = $1 ${fileId ? 'AND file_id = $2' : ''}
       ORDER BY created_at DESC LIMIT 100`,
      fileId ? [spaceId, fileId] : [spaceId],
    );
    return rows.map((row) => ({
      id: row.id,
      fileId: row.file_id,
      kind: row.kind,
      status: row.status,
      attempts: Number(row.attempts),
      lastError: row.last_error,
      updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
    }));
  }

  async enqueue(spaceId: string, fileId: string, kinds: MediaJobKind[]): Promise<void> {
    for (const kind of kinds) {
      await this.db.query(
        `INSERT INTO media_jobs (id, space_id, file_id, kind) VALUES ($1,$2,$3,$4)`,
        [newId('mjb'), spaceId, fileId, kind],
      );
    }
  }

  private async tick(): Promise<void> {
    if (this.running >= config.media.queueConcurrency) return;
    try {
      await this.runOnce(config.media.queueConcurrency - this.running);
      if (Date.now() - this.lastPurge > 60 * 60 * 1000) {
        this.lastPurge = Date.now();
        await this.purgeExpiredTrash();
      }
    } catch (error) {
      this.logger.warn('media_queue_tick_failed', {
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  /** Processes up to `limit` queued jobs; returns how many were handled. */
  async runOnce(limit = 10, spaceId?: string): Promise<number> {
    let handled = 0;
    while (handled < limit) {
      const job = await this.claim(spaceId);
      if (!job) break;
      handled += 1;
      this.running += 1;
      try {
        await this.process(job);
      } finally {
        this.running -= 1;
      }
    }
    return handled;
  }

  private async claim(spaceId?: string): Promise<JobRow | null> {
    return this.db.queryOne<JobRow>(
      `UPDATE media_jobs SET status = 'running', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = (
         SELECT id FROM media_jobs
         WHERE status = 'queued' AND run_after <= CURRENT_TIMESTAMP ${spaceId ? 'AND space_id = $1' : ''}
         ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
       ) RETURNING *`,
      spaceId ? [spaceId] : [],
    );
  }

  private async finish(job: JobRow, status: MediaJobSummary['status'], error = ''): Promise<void> {
    if (status === 'failed' && job.attempts < MAX_ATTEMPTS) {
      await this.db.query(
        `UPDATE media_jobs SET status = 'queued', last_error = $2,
           run_after = CURRENT_TIMESTAMP + (INTERVAL '30 seconds' * attempts), updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [job.id, error.slice(0, 500)],
      );
      return;
    }
    await this.db.query(
      `UPDATE media_jobs SET status = $2, last_error = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [job.id, status, error.slice(0, 500)],
    );
  }

  private async process(job: JobRow): Promise<void> {
    const file = await this.db.queryOne<FileRow>('SELECT * FROM files WHERE id = $1', [
      job.file_id,
    ]);
    if (!file) {
      await this.finish(job, 'skipped', 'file_missing');
      return;
    }
    try {
      const outcome = await this.handlers[job.kind](file);
      await this.finish(job, outcome.status, outcome.detail ?? '');
      this.realtime.publish(file.space_id, 'files', null, {
        action: 'file.processed',
        fileId: file.id,
        job: job.kind,
      });
    } catch (error) {
      await this.finish(job, 'failed', error instanceof Error ? error.message : 'unknown');
    }
  }

  private readonly handlers: Record<
    MediaJobKind,
    (file: FileRow) => Promise<{ status: MediaJobSummary['status']; detail?: string }>
  > = {
    scan: async (file) => {
      const command = config.media.antivirusCommand;
      if (!command) {
        await this.db.query(
          `UPDATE files SET scan_status = 'unscanned', scan_detail = 'antivirus_not_configured'
           WHERE id = $1 AND scan_status = 'pending'`,
          [file.id],
        );
        return { status: 'skipped', detail: 'antivirus_not_configured' };
      }
      const local = this.storage.adapter.localPath(file.storage_key);
      if (!local) return { status: 'skipped', detail: 'remote_storage' };
      const result = await runEngine(command, local, config.media.commandTimeoutMs);
      // ClamAV convention: 0 clean, 1 infected, anything else is an error.
      if (result.code === 0) {
        await this.db.query(
          `UPDATE files SET scan_status = 'clean', scan_detail = '' WHERE id = $1`,
          [file.id],
        );
        return { status: 'done' };
      }
      if (result.code === 1) {
        await this.db.query(
          `UPDATE files SET scan_status = 'blocked', scan_detail = $2 WHERE id = $1`,
          [file.id, `malware_detected:${result.stdout.trim().slice(-200)}`],
        );
        return { status: 'done', detail: 'infected' };
      }
      return { status: 'failed', detail: `antivirus_error:${result.stderr.slice(0, 200)}` };
    },
    metadata: async (file) => {
      const head = await this.storage.adapter.readBuffer(file.storage_key, 512 * 1024);
      const meta = mediaMetadata(file.mime_type, head);
      const merged = { ...parseJson<Record<string, unknown>>(file.metadata, {}), ...meta };
      await this.db.query(
        `UPDATE files SET metadata = $2,
           taken_at = COALESCE(taken_at, $3::timestamptz)
         WHERE id = $1`,
        [file.id, JSON.stringify(merged), meta.takenAt ?? null],
      );
      return { status: 'done' };
    },
    ocr: async (file) => {
      if (Number(file.size_bytes) > MAX_TEXT_SOURCE_BYTES && file.kind !== 'image') {
        await this.setText(file.id, 'unavailable', '');
        return { status: 'skipped', detail: 'too_large_for_text_extraction' };
      }
      if (file.kind === 'image') {
        const command = config.media.ocrCommand;
        const local = this.storage.adapter.localPath(file.storage_key);
        if (!command || !local) {
          await this.setText(file.id, 'unavailable', '');
          return { status: 'skipped', detail: 'ocr_engine_not_configured' };
        }
        const result = await runEngine(command, local, config.media.commandTimeoutMs);
        if (result.code !== 0) {
          await this.setText(file.id, 'failed', '');
          return { status: 'failed', detail: `ocr_error:${result.stderr.slice(0, 200)}` };
        }
        await this.setText(file.id, 'done', result.stdout.trim().slice(0, MAX_EXTRACTED_CHARS));
        return { status: 'done' };
      }
      const buffer = await this.storage.adapter.readBuffer(file.storage_key);
      const text = extractText(file.kind, file.extension, buffer);
      if (text === null) {
        await this.setText(file.id, 'unavailable', '');
        return { status: 'skipped', detail: 'no_text_layer' };
      }
      await this.setText(file.id, 'done', text);
      return { status: 'done' };
    },
    video: async (file) => {
      const command = config.media.videoProbeCommand;
      const local = this.storage.adapter.localPath(file.storage_key);
      if (!command || !local) return { status: 'skipped', detail: 'video_probe_not_configured' };
      const result = await runEngine(command, local, config.media.commandTimeoutMs);
      if (result.code !== 0) return { status: 'failed', detail: result.stderr.slice(0, 200) };
      let duration: number | undefined;
      try {
        const parsed = JSON.parse(result.stdout) as { format?: { duration?: string } };
        duration = parsed.format?.duration ? Number(parsed.format.duration) : undefined;
      } catch {
        duration = Number.parseFloat(result.stdout) || undefined;
      }
      const merged = {
        ...parseJson<Record<string, unknown>>(file.metadata, {}),
        ...(duration ? { durationSeconds: Math.round(duration) } : {}),
      };
      await this.db.query('UPDATE files SET metadata = $2 WHERE id = $1', [
        file.id,
        JSON.stringify(merged),
      ]);
      return { status: 'done' };
    },
    faces: async () => {
      // Biometric processing happens only with a local engine and explicit
      // consent; without an engine the job is a documented no-op.
      if (!config.media.faceEngineCommand) {
        return { status: 'skipped', detail: 'face_engine_not_configured' };
      }
      return { status: 'skipped', detail: 'face_engine_adapter_pending' };
    },
  };

  private async setText(fileId: string, status: string, text: string): Promise<void> {
    await this.db.query(`UPDATE files SET ocr_status = $2, ocr_text = $3 WHERE id = $1`, [
      fileId,
      status,
      text,
    ]);
  }

  /** Permanently removes trash older than each space's retention period. */
  async purgeExpiredTrash(): Promise<number> {
    const expired = await this.db.query<{ id: string }>(
      `SELECT f.id FROM files f
       LEFT JOIN space_storage_settings s ON s.space_id = f.space_id
       WHERE f.deleted_at IS NOT NULL
         AND f.deleted_at < CURRENT_TIMESTAMP - (INTERVAL '1 day' * COALESCE(s.trash_retention_days, $1))
       LIMIT 500`,
      [config.storage.trashRetentionDays],
    );
    for (const row of expired) await this.purgeFile(row.id);
    await this.db.query(
      `DELETE FROM file_folders f
       WHERE f.deleted_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM files x WHERE x.folder_id = f.id)
         AND f.deleted_at < CURRENT_TIMESTAMP - (INTERVAL '1 day' * $1)`,
      [config.storage.trashRetentionDays],
    );
    return expired.length;
  }

  async purgeFile(fileId: string): Promise<void> {
    const keys = await this.db.query<{ storage_key: string }>(
      'SELECT storage_key FROM file_versions WHERE file_id = $1',
      [fileId],
    );
    await this.db.query('DELETE FROM files WHERE id = $1', [fileId]);
    for (const key of keys)
      await this.storage.adapter.delete(key.storage_key).catch(() => undefined);
  }
}
