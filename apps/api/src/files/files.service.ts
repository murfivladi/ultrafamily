import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import crypto from 'node:crypto';
import type {
  ArchiveListing,
  DuplicateGroup,
  FileActivityEntry,
  FileFolder,
  FileItem,
  FileListing,
  FilePreview,
  FileVersionEntry,
  FileVisibility,
  StorageUsage,
  UploadSession,
  WebDavToken,
} from '@ufos/contracts';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { toAuthenticatedUser } from '../auth/session.service';
import type { AuthenticatedUser } from '../common/authed-request';
import { config, newId, randomToken, sha256 } from '../config';
import { DatabaseService } from '../db/database.service';
import { parseJson, type UserRow } from '../db/rows';
import { RealtimeService } from '../realtime/realtime.service';
import {
  toActivity,
  toFileItem,
  toFileVersion,
  toFolder,
  type ActivityRow,
  type FileRow,
  type FileVersionRow,
  type FolderRow,
  type UploadSessionRow,
} from '../stage-d/mappers';
import { StorageService } from '../storage/storage.service';
import { readZipDirectory } from './archive';
import { classify, isInlineSafe, sanitizeFileName, type FileClassification } from './file-types';
import { MediaQueueService, type MediaJobKind } from './media-queue.service';
import { extractText } from './text-extract';

export type FileModule = 'files' | 'photos';
export type ConflictMode = 'version' | 'rename' | 'fail';

export interface StoreInput {
  folderId: string | null;
  name: string;
  visibility: FileVisibility;
  onConflict: ConflictMode;
  module: FileModule;
  note?: string;
  takenAt?: string | null;
}

const FILE_SELECT = `SELECT f.*, u.display_name AS created_by_name FROM files f
  LEFT JOIN users u ON u.id = f.created_by`;

const MEDIA_KINDS = new Set(['image', 'video', 'audio']);

@Injectable()
export class FilesService {
  private readonly chunkLocks = new Set<string>();

  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly storage: StorageService,
    private readonly queue: MediaQueueService,
  ) {}

  // -------------------------------------------------------------------------
  // Access helpers
  // -------------------------------------------------------------------------

  async can(
    userId: string,
    spaceId: string,
    module: FileModule,
    action: Parameters<AccessService['assert']>[3],
  ) {
    return this.access
      .assert(userId, spaceId, module, action)
      .then(() => true)
      .catch(() => false);
  }

  /** Files are reachable through `files`, media additionally through `photos`. */
  async assertFileAccess(
    user: AuthenticatedUser,
    spaceId: string,
    file: FileRow,
    action: 'read' | 'update' | 'delete',
  ): Promise<void> {
    if (file.visibility === 'private' && file.created_by !== user.id) {
      throw new NotFoundException('file_not_found');
    }
    if (await this.can(user.id, spaceId, 'files', action)) return;
    if (MEDIA_KINDS.has(file.kind) && (await this.can(user.id, spaceId, 'photos', action))) return;
    // Authors may edit and trash their own uploads with create rights.
    if (
      action !== 'read' &&
      file.created_by === user.id &&
      ((await this.can(user.id, spaceId, 'files', 'create')) ||
        (MEDIA_KINDS.has(file.kind) && (await this.can(user.id, spaceId, 'photos', 'create'))))
    ) {
      return;
    }
    await this.access.assert(user.id, spaceId, 'files', action);
  }

  async requireFile(spaceId: string, id: string, includeDeleted = false): Promise<FileRow> {
    const row = await this.db.queryOne<FileRow>(
      `${FILE_SELECT} WHERE f.id = $1 AND f.space_id = $2 ${includeDeleted ? '' : 'AND f.deleted_at IS NULL'}`,
      [id, spaceId],
    );
    if (!row) throw new NotFoundException('file_not_found');
    return row;
  }

  async readableFile(user: AuthenticatedUser, spaceId: string, id: string): Promise<FileRow> {
    const row = await this.requireFile(spaceId, id);
    await this.assertFileAccess(user, spaceId, row, 'read');
    return row;
  }

  private async requireFolder(
    spaceId: string,
    id: string,
    includeDeleted = false,
  ): Promise<FolderRow> {
    const row = await this.db.queryOne<FolderRow>(
      `SELECT * FROM file_folders WHERE id = $1 AND space_id = $2 ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`,
      [id, spaceId],
    );
    if (!row) throw new NotFoundException('folder_not_found');
    return row;
  }

  private async activity(
    spaceId: string,
    userId: string | null,
    action: string,
    target: { fileId?: string | null; folderId?: string | null },
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO file_activity (id, space_id, file_id, folder_id, user_id, action, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        newId('fac'),
        spaceId,
        target.fileId ?? null,
        target.folderId ?? null,
        userId,
        action,
        JSON.stringify(detail),
      ],
    );
  }

  private async record(
    user: AuthenticatedUser,
    spaceId: string,
    action: string,
    entity: string,
    entityId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action,
      entity,
      entityId,
      metadata,
    });
    this.realtime.publish(spaceId, 'files', user.id, { action, id: entityId });
  }

  // -------------------------------------------------------------------------
  // Listing and folders
  // -------------------------------------------------------------------------

  async list(
    user: AuthenticatedUser,
    spaceId: string,
    folderId: string | null,
  ): Promise<FileListing> {
    await this.access.assert(user.id, spaceId, 'files', 'read');
    const folder = folderId ? await this.requireFolder(spaceId, folderId) : null;
    const [folders, files] = await Promise.all([
      this.db.query<FolderRow>(
        `SELECT * FROM file_folders WHERE space_id = $1 AND deleted_at IS NULL
           AND parent_id IS NOT DISTINCT FROM $2 ORDER BY LOWER(name)`,
        [spaceId, folderId],
      ),
      this.db.query<FileRow>(
        `${FILE_SELECT} WHERE f.space_id = $1 AND f.deleted_at IS NULL
           AND f.folder_id IS NOT DISTINCT FROM $2
           AND (f.visibility = 'space' OR f.created_by = $3)
         ORDER BY LOWER(f.name) LIMIT 1000`,
        [spaceId, folderId, user.id],
      ),
    ]);
    return {
      folder: folder ? toFolder(folder) : null,
      breadcrumbs: await this.breadcrumbs(spaceId, folderId),
      folders: folders.map(toFolder),
      files: files.map(toFileItem),
    };
  }

  private async breadcrumbs(spaceId: string, folderId: string | null) {
    const trail: Array<{ id: string | null; name: string }> = [];
    let current = folderId;
    for (let depth = 0; current && depth < 32; depth += 1) {
      const row = await this.db.queryOne<FolderRow>(
        'SELECT * FROM file_folders WHERE id = $1 AND space_id = $2',
        [current, spaceId],
      );
      if (!row) break;
      trail.unshift({ id: row.id, name: row.name });
      current = row.parent_id;
    }
    trail.unshift({ id: null, name: '/' });
    return trail;
  }

  async createFolder(
    user: AuthenticatedUser,
    spaceId: string,
    input: { name: string; parentId: string | null },
    module: FileModule = 'files',
  ): Promise<FileFolder> {
    await this.access.assert(user.id, spaceId, module, 'create');
    if (input.parentId) await this.requireFolder(spaceId, input.parentId);
    const name = sanitizeFileName(input.name);
    await this.assertNameFree(spaceId, input.parentId, name);
    const row = await this.db.queryOne<FolderRow>(
      `INSERT INTO file_folders (id, space_id, parent_id, name, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [newId('fld'), spaceId, input.parentId, name, user.id],
    );
    if (!row) throw new ConflictException('folder_not_created');
    await this.activity(spaceId, user.id, 'folder.create', { folderId: row.id }, { name });
    await this.record(user, spaceId, 'files.folder.create', 'file_folder', row.id, { name });
    return toFolder(row);
  }

  /** Finds or creates a folder path (used by the gallery and WebDAV). */
  async ensureFolderPath(
    user: AuthenticatedUser,
    spaceId: string,
    names: string[],
    module: FileModule,
  ) {
    let parentId: string | null = null;
    for (const raw of names) {
      const name = sanitizeFileName(raw);
      const existing: FolderRow | null = await this.db.queryOne<FolderRow>(
        `SELECT * FROM file_folders WHERE space_id = $1 AND parent_id IS NOT DISTINCT FROM $2
           AND LOWER(name) = LOWER($3) AND deleted_at IS NULL`,
        [spaceId, parentId, name],
      );
      parentId = existing
        ? existing.id
        : (await this.createFolder(user, spaceId, { name, parentId }, module)).id;
    }
    return parentId;
  }

  async updateFolder(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    patch: { name?: string; parentId?: string | null },
  ): Promise<FileFolder> {
    await this.access.assert(user.id, spaceId, 'files', 'update');
    const folder = await this.requireFolder(spaceId, id);
    const name = patch.name !== undefined ? sanitizeFileName(patch.name) : folder.name;
    const parentId = patch.parentId !== undefined ? patch.parentId : folder.parent_id;
    if (parentId) {
      await this.requireFolder(spaceId, parentId);
      // Refuse cycles: the new parent must not be this folder or a descendant.
      let cursor: string | null = parentId;
      for (let depth = 0; cursor && depth < 64; depth += 1) {
        if (cursor === id) throw new BadRequestException('folder_cycle');
        const parent: FolderRow | null = await this.db.queryOne<FolderRow>(
          'SELECT * FROM file_folders WHERE id = $1',
          [cursor],
        );
        cursor = parent?.parent_id ?? null;
      }
    }
    if (name.toLowerCase() !== folder.name.toLowerCase() || parentId !== folder.parent_id) {
      await this.assertNameFree(spaceId, parentId, name, id);
    }
    const row = await this.db.queryOne<FolderRow>(
      `UPDATE file_folders SET name = $3, parent_id = $4, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND space_id = $2 RETURNING *`,
      [id, spaceId, name, parentId],
    );
    await this.activity(spaceId, user.id, 'folder.update', { folderId: id }, { name, parentId });
    await this.record(user, spaceId, 'files.folder.update', 'file_folder', id, { name });
    return toFolder(row!);
  }

  private async assertNameFree(
    spaceId: string,
    folderId: string | null,
    name: string,
    exceptId?: string,
  ) {
    const [folder, file] = await Promise.all([
      this.db.queryOne<{ id: string }>(
        `SELECT id FROM file_folders WHERE space_id = $1 AND parent_id IS NOT DISTINCT FROM $2
           AND LOWER(name) = LOWER($3) AND deleted_at IS NULL AND id <> $4`,
        [spaceId, folderId, name, exceptId ?? ''],
      ),
      this.db.queryOne<{ id: string }>(
        `SELECT id FROM files WHERE space_id = $1 AND folder_id IS NOT DISTINCT FROM $2
           AND LOWER(name) = LOWER($3) AND deleted_at IS NULL AND id <> $4`,
        [spaceId, folderId, name, exceptId ?? ''],
      ),
    ]);
    if (folder || file) throw new ConflictException('name_already_exists');
  }

  // -------------------------------------------------------------------------
  // Upload sessions (chunked, resumable)
  // -------------------------------------------------------------------------

  async usage(user: AuthenticatedUser, spaceId: string): Promise<StorageUsage> {
    await this.access.assert(user.id, spaceId, 'files', 'read').catch(async () => {
      await this.access.assert(user.id, spaceId, 'photos', 'read');
    });
    const settings = await this.settings(spaceId);
    const [space, mine, trash, count] = await Promise.all([
      this.db.queryOne<{ total: string | number }>(
        'SELECT COALESCE(SUM(size_bytes),0) AS total FROM file_versions WHERE space_id = $1',
        [spaceId],
      ),
      this.db.queryOne<{ total: string | number }>(
        'SELECT COALESCE(SUM(size_bytes),0) AS total FROM file_versions WHERE space_id = $1 AND created_by = $2',
        [spaceId, user.id],
      ),
      this.db.queryOne<{ total: string | number }>(
        `SELECT COALESCE(SUM(v.size_bytes),0) AS total FROM file_versions v
         JOIN files f ON f.id = v.file_id WHERE v.space_id = $1 AND f.deleted_at IS NOT NULL`,
        [spaceId],
      ),
      this.db.queryOne<{ total: string | number }>(
        'SELECT COUNT(*) AS total FROM files WHERE space_id = $1 AND deleted_at IS NULL',
        [spaceId],
      ),
    ]);
    return {
      spaceId,
      usedBytes: Number(space?.total ?? 0),
      quotaBytes: settings.quotaBytes,
      userUsedBytes: Number(mine?.total ?? 0),
      userQuotaBytes: settings.userQuotaBytes,
      trashBytes: Number(trash?.total ?? 0),
      fileCount: Number(count?.total ?? 0),
      trashRetentionDays: settings.trashRetentionDays,
      disk: await this.storage.adapter.diskStatus(),
    };
  }

  private async settings(spaceId: string) {
    const row = await this.db.queryOne<{
      quota_bytes: string | number;
      user_quota_bytes: string | number;
      trash_retention_days: number;
    }>('SELECT * FROM space_storage_settings WHERE space_id = $1', [spaceId]);
    return {
      quotaBytes: Number(row?.quota_bytes ?? config.storage.spaceQuotaBytes),
      userQuotaBytes: Number(row?.user_quota_bytes ?? config.storage.userQuotaBytes),
      trashRetentionDays: Number(row?.trash_retention_days ?? config.storage.trashRetentionDays),
    };
  }

  async setQuota(
    user: AuthenticatedUser,
    spaceId: string,
    input: { quotaBytes: number; userQuotaBytes: number; trashRetentionDays: number },
  ): Promise<StorageUsage> {
    await this.access.assert(user.id, spaceId, 'files', 'manage_access');
    await this.db.query(
      `INSERT INTO space_storage_settings
         (space_id, quota_bytes, user_quota_bytes, trash_retention_days, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)
       ON CONFLICT (space_id) DO UPDATE SET quota_bytes = EXCLUDED.quota_bytes,
         user_quota_bytes = EXCLUDED.user_quota_bytes,
         trash_retention_days = EXCLUDED.trash_retention_days,
         updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
      [spaceId, input.quotaBytes, input.userQuotaBytes, input.trashRetentionDays, user.id],
    );
    await this.record(user, spaceId, 'files.quota.update', 'space', spaceId, input);
    return this.usage(user, spaceId);
  }

  private async assertQuota(
    user: AuthenticatedUser,
    spaceId: string,
    bytes: number,
  ): Promise<void> {
    if (bytes > config.storage.maxFileBytes) throw new PayloadTooLargeException('file_too_large');
    const usage = await this.usage(user, spaceId);
    if (usage.usedBytes + bytes > usage.quotaBytes) {
      throw new PayloadTooLargeException('space_quota_exceeded');
    }
    if (usage.userUsedBytes + bytes > usage.userQuotaBytes) {
      throw new PayloadTooLargeException('user_quota_exceeded');
    }
    if (
      usage.disk.freeBytes !== null &&
      usage.disk.freeBytes - bytes < config.storage.minFreeBytes / 4
    ) {
      throw new PayloadTooLargeException('server_disk_full');
    }
  }

  async createUpload(
    user: AuthenticatedUser,
    spaceId: string,
    input: {
      folderId: string | null;
      name: string;
      mimeType: string;
      size: number;
      visibility: FileVisibility;
      targetFileId: string | null;
      module: FileModule;
    },
  ): Promise<UploadSession> {
    await this.access.assert(user.id, spaceId, input.module, 'create');
    if (input.folderId) await this.requireFolder(spaceId, input.folderId);
    if (input.targetFileId) {
      const target = await this.requireFile(spaceId, input.targetFileId);
      await this.assertFileAccess(user, spaceId, target, 'update');
    }
    const name = sanitizeFileName(input.name);
    const early = classify(name, Buffer.alloc(0));
    if (early.blocked === 'blocked_extension') {
      throw new UnsupportedMediaTypeException('file_blocked:blocked_extension');
    }
    await this.assertQuota(user, spaceId, input.size);
    const id = newId('upl');
    const row = await this.db.queryOne<UploadSessionRow>(
      `INSERT INTO file_upload_sessions
        (id, space_id, user_id, folder_id, target_file_id, name, mime_type, visibility,
         total_bytes, chunk_bytes, temp_key, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CURRENT_TIMESTAMP + INTERVAL '24 hours')
       RETURNING *`,
      [
        id,
        spaceId,
        user.id,
        input.folderId,
        input.targetFileId,
        name,
        input.mimeType.slice(0, 200),
        input.visibility,
        input.size,
        config.storage.chunkBytes,
        `tmp/${id}`,
      ],
    );
    await this.storage.adapter.put(`tmp/${id}`, Buffer.alloc(0));
    return this.toUploadSession(row!);
  }

  private toUploadSession(row: UploadSessionRow): UploadSession {
    const total = Number(row.total_bytes);
    const chunk = Number(row.chunk_bytes);
    return {
      id: row.id,
      name: row.name,
      totalBytes: total,
      chunkBytes: chunk,
      totalChunks: Math.max(1, Math.ceil(total / chunk)),
      receivedBytes: Number(row.received_bytes),
      nextIndex: Number(row.next_index),
      status: row.status,
      expiresAt: new Date(row.expires_at).toISOString(),
      resultFileId: row.result_file_id,
    };
  }

  private async requireUpload(user: AuthenticatedUser, spaceId: string, id: string) {
    const row = await this.db.queryOne<UploadSessionRow>(
      `SELECT * FROM file_upload_sessions WHERE id = $1 AND space_id = $2 AND user_id = $3`,
      [id, spaceId, user.id],
    );
    if (!row) throw new NotFoundException('upload_not_found');
    if (row.status === 'open' && new Date(row.expires_at).getTime() < Date.now()) {
      throw new ConflictException('upload_expired');
    }
    return row;
  }

  async uploadStatus(user: AuthenticatedUser, spaceId: string, id: string) {
    return this.toUploadSession(await this.requireUpload(user, spaceId, id));
  }

  async putChunk(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    index: number,
    data: Buffer,
  ): Promise<UploadSession> {
    if (this.chunkLocks.has(id)) throw new ConflictException('upload_chunk_in_progress');
    this.chunkLocks.add(id);
    try {
      const row = await this.requireUpload(user, spaceId, id);
      if (row.status !== 'open') throw new ConflictException('upload_not_open');
      const next = Number(row.next_index);
      const received = Number(row.received_bytes);
      const total = Number(row.total_bytes);
      const chunk = Number(row.chunk_bytes);
      // A retried chunk that was already stored is acknowledged idempotently.
      if (index < next) return this.toUploadSession(row);
      if (index > next) throw new ConflictException('upload_chunk_out_of_order');
      const expected = Math.min(chunk, total - received);
      if (data.length !== expected) throw new BadRequestException('upload_chunk_size_mismatch');
      // Drop bytes of an interrupted earlier write before appending.
      const onDisk = await this.storage.adapter.size(row.temp_key);
      if (onDisk !== null && onDisk > received)
        await this.storage.adapter.truncate(row.temp_key, received);
      await this.storage.adapter.append(row.temp_key, data);
      const updated = await this.db.queryOne<UploadSessionRow>(
        `UPDATE file_upload_sessions SET received_bytes = received_bytes + $3, next_index = next_index + 1
         WHERE id = $1 AND next_index = $2 RETURNING *`,
        [id, index, data.length],
      );
      if (!updated) throw new ConflictException('upload_chunk_conflict');
      return this.toUploadSession(updated);
    } finally {
      this.chunkLocks.delete(id);
    }
  }

  async abortUpload(user: AuthenticatedUser, spaceId: string, id: string) {
    const row = await this.requireUpload(user, spaceId, id);
    if (row.status === 'open') {
      await this.db.query(`UPDATE file_upload_sessions SET status = 'aborted' WHERE id = $1`, [id]);
      await this.storage.adapter.delete(row.temp_key);
    }
    return { aborted: true };
  }

  async completeUpload(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    options: { onConflict: ConflictMode; module: FileModule; takenAt?: string | null },
  ): Promise<FileItem> {
    const row = await this.requireUpload(user, spaceId, id);
    if (row.status === 'complete' && row.result_file_id) {
      return toFileItem(await this.requireFile(spaceId, row.result_file_id));
    }
    if (row.status !== 'open') throw new ConflictException('upload_not_open');
    if (Number(row.received_bytes) !== Number(row.total_bytes)) {
      throw new ConflictException('upload_incomplete');
    }
    const size = await this.storage.adapter.size(row.temp_key);
    if (size !== Number(row.total_bytes)) throw new ConflictException('upload_size_mismatch');
    let file: FileItem;
    try {
      file = await this.storeFromKey(user, spaceId, row.temp_key, size, {
        folderId: row.folder_id,
        name: row.name,
        visibility: row.visibility,
        onConflict: row.target_file_id ? 'version' : options.onConflict,
        module: options.module,
        takenAt: options.takenAt ?? null,
        targetFileId: row.target_file_id,
      });
    } catch (error) {
      if (error instanceof UnsupportedMediaTypeException) {
        await this.db.query(`UPDATE file_upload_sessions SET status = 'aborted' WHERE id = $1`, [
          id,
        ]);
      }
      throw error;
    }
    await this.db.query(
      `UPDATE file_upload_sessions SET status = 'complete', result_file_id = $2 WHERE id = $1`,
      [id, file.id],
    );
    return file;
  }

  /** Stores an in-memory buffer (WebDAV PUT, seeds, small uploads). */
  async storeBuffer(
    user: AuthenticatedUser,
    spaceId: string,
    data: Buffer,
    input: StoreInput & { targetFileId?: string | null },
  ): Promise<FileItem> {
    await this.access.assert(user.id, spaceId, input.module, 'create');
    const tempKey = `tmp/${newId('buf')}`;
    await this.storage.adapter.put(tempKey, data);
    return this.storeFromKey(user, spaceId, tempKey, data.length, input);
  }

  /** Stores content already written to a temporary storage key (WebDAV, copies). */
  async storeTempKey(
    user: AuthenticatedUser,
    spaceId: string,
    tempKey: string,
    size: number,
    input: StoreInput & { targetFileId?: string | null },
  ): Promise<FileItem> {
    await this.access.assert(user.id, spaceId, input.module, 'create').catch(async (error) => {
      // Updating an existing file only needs update rights on that file.
      if (!input.targetFileId) {
        await this.storage.adapter.delete(tempKey);
        throw error;
      }
    });
    return this.storeFromKey(user, spaceId, tempKey, size, input);
  }

  private async hashKey(key: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      const stream = this.storage.adapter.read(key);
      stream.on('data', (chunk) => hash.update(chunk as Buffer));
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    return hash.digest('hex');
  }

  private async storeFromKey(
    user: AuthenticatedUser,
    spaceId: string,
    tempKey: string,
    size: number,
    input: StoreInput & { targetFileId?: string | null },
  ): Promise<FileItem> {
    const name = sanitizeFileName(input.name);
    const head = await this.storage.adapter.readBuffer(tempKey, 64 * 1024);
    const kind = classify(name, head);
    if (kind.blocked) {
      await this.storage.adapter.delete(tempKey);
      await this.activity(
        spaceId,
        user.id,
        'upload.blocked',
        { folderId: input.folderId },
        {
          name,
          reason: kind.blocked,
        },
      );
      await this.audit.record({
        actorUserId: user.id,
        actorEmail: user.email,
        spaceId,
        action: 'files.upload.blocked',
        entity: 'file',
        entityId: null,
        metadata: { name, reason: kind.blocked },
      });
      throw new UnsupportedMediaTypeException(`file_blocked:${kind.blocked}`);
    }
    if (input.module === 'photos' && !['image', 'video', 'audio'].includes(kind.kind)) {
      await this.storage.adapter.delete(tempKey);
      throw new UnsupportedMediaTypeException('file_blocked:not_media');
    }
    await this.assertQuota(user, spaceId, size);
    const digest = await this.hashKey(tempKey);

    let target: FileRow | null = null;
    if (input.targetFileId) {
      target = await this.requireFile(spaceId, input.targetFileId);
    } else {
      const existing = await this.db.queryOne<FileRow>(
        `${FILE_SELECT} WHERE f.space_id = $1 AND f.folder_id IS NOT DISTINCT FROM $2
           AND LOWER(f.name) = LOWER($3) AND f.deleted_at IS NULL`,
        [spaceId, input.folderId, name],
      );
      const folderClash = await this.db.queryOne<{ id: string }>(
        `SELECT id FROM file_folders WHERE space_id = $1 AND parent_id IS NOT DISTINCT FROM $2
           AND LOWER(name) = LOWER($3) AND deleted_at IS NULL`,
        [spaceId, input.folderId, name],
      );
      if (existing && input.onConflict === 'version') {
        target = existing;
      } else if (existing || folderClash) {
        if (input.onConflict === 'fail') {
          await this.storage.adapter.delete(tempKey);
          throw new ConflictException('name_already_exists');
        }
        input = { ...input, name: await this.freeName(spaceId, input.folderId, name) };
      }
    }

    if (target) {
      await this.assertFileAccess(user, spaceId, target, 'update');
      return this.writeVersion(
        user,
        spaceId,
        target,
        tempKey,
        size,
        digest,
        kind,
        input.note ?? 'upload',
      );
    }

    const id = newId('fil');
    const key = `${spaceId}/${id}/v1-${randomToken(6).replace(/[^A-Za-z0-9]/g, '')}`;
    await this.storage.adapter.move(tempKey, key);
    const finalName = sanitizeFileName(input.name);
    const row = await this.db.queryOne<FileRow>(
      `INSERT INTO files
        (id, space_id, folder_id, name, extension, mime_type, kind, visibility, size_bytes, sha256,
         storage_key, scan_status, ocr_status, taken_at, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15) RETURNING *`,
      [
        id,
        spaceId,
        input.folderId,
        finalName,
        classify(finalName, Buffer.alloc(0)).extension,
        kind.mimeType,
        kind.kind,
        input.visibility,
        size,
        digest,
        key,
        config.media.antivirusCommand ? 'pending' : 'unscanned',
        this.textCapable(kind) ? 'pending' : 'none',
        input.takenAt ?? null,
        user.id,
      ],
    );
    await this.db.query(
      `INSERT INTO file_versions (id, file_id, space_id, version, size_bytes, sha256, mime_type,
         storage_key, note, created_by) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9)`,
      [
        newId('fvr'),
        id,
        spaceId,
        size,
        digest,
        kind.mimeType,
        key,
        input.note ?? 'upload',
        user.id,
      ],
    );
    await this.enqueueFor(spaceId, id, kind);
    await this.activity(
      spaceId,
      user.id,
      'file.upload',
      { fileId: id, folderId: input.folderId },
      {
        name: finalName,
        size,
      },
    );
    await this.record(user, spaceId, 'files.upload', 'file', id, {
      name: finalName,
      size,
      kind: kind.kind,
    });
    return toFileItem({ ...row!, created_by_name: user.displayName });
  }

  private textCapable(kind: FileClassification): boolean {
    return ['text', 'pdf', 'office', 'image'].includes(kind.kind);
  }

  private async enqueueFor(spaceId: string, fileId: string, kind: FileClassification) {
    const jobs: MediaJobKind[] = ['scan'];
    if (kind.kind === 'image') jobs.push('metadata');
    if (this.textCapable(kind)) jobs.push('ocr');
    if (kind.kind === 'video') jobs.push('video');
    await this.queue.enqueue(spaceId, fileId, jobs);
  }

  private async freeName(spaceId: string, folderId: string | null, name: string): Promise<string> {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    for (let counter = 2; counter < 1000; counter += 1) {
      const candidate = `${base} (${counter})${extension}`;
      const taken = await this.db.queryOne<{ id: string }>(
        `SELECT id FROM files WHERE space_id = $1 AND folder_id IS NOT DISTINCT FROM $2
           AND LOWER(name) = LOWER($3) AND deleted_at IS NULL
         UNION ALL
         SELECT id FROM file_folders WHERE space_id = $1 AND parent_id IS NOT DISTINCT FROM $2
           AND LOWER(name) = LOWER($3) AND deleted_at IS NULL`,
        [spaceId, folderId, candidate],
      );
      if (!taken) return candidate;
    }
    return `${base} (${Date.now()})${extension}`;
  }

  private async writeVersion(
    user: AuthenticatedUser,
    spaceId: string,
    target: FileRow,
    tempKey: string,
    size: number,
    digest: string,
    kind: FileClassification,
    note: string,
  ): Promise<FileItem> {
    const version = Number(target.version) + 1;
    const key = `${spaceId}/${target.id}/v${version}-${randomToken(6).replace(/[^A-Za-z0-9]/g, '')}`;
    await this.storage.adapter.move(tempKey, key);
    await this.db.query(
      `INSERT INTO file_versions (id, file_id, space_id, version, size_bytes, sha256, mime_type,
         storage_key, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [newId('fvr'), target.id, spaceId, version, size, digest, kind.mimeType, key, note, user.id],
    );
    const row = await this.db.queryOne<FileRow>(
      `UPDATE files SET version = $2, storage_key = $3, size_bytes = $4, sha256 = $5, mime_type = $6,
         kind = $7, scan_status = $8, scan_detail = '', ocr_status = $9, ocr_text = '',
         updated_by = $10, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *`,
      [
        target.id,
        version,
        key,
        size,
        digest,
        kind.mimeType,
        kind.kind,
        config.media.antivirusCommand ? 'pending' : 'unscanned',
        this.textCapable(kind) ? 'pending' : 'none',
        user.id,
      ],
    );
    await this.enqueueFor(spaceId, target.id, kind);
    await this.activity(
      spaceId,
      user.id,
      'file.version',
      { fileId: target.id },
      { version, size, note },
    );
    await this.record(user, spaceId, 'files.version', 'file', target.id, { version, size });
    return toFileItem({ ...row!, created_by_name: target.created_by_name ?? null });
  }

  // -------------------------------------------------------------------------
  // File operations
  // -------------------------------------------------------------------------

  async get(user: AuthenticatedUser, spaceId: string, id: string): Promise<FileItem> {
    return toFileItem(await this.readableFile(user, spaceId, id));
  }

  async update(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    patch: {
      name?: string;
      folderId?: string | null;
      tags?: string[];
      description?: string;
      takenAt?: string | null;
      place?: string;
      visibility?: FileVisibility;
    },
  ): Promise<FileItem> {
    const file = await this.requireFile(spaceId, id);
    await this.assertFileAccess(user, spaceId, file, 'update');
    if (patch.visibility !== undefined && file.created_by !== user.id) {
      throw new ForbiddenException('only_author_changes_visibility');
    }
    const name = patch.name !== undefined ? sanitizeFileName(patch.name) : file.name;
    const folderId = patch.folderId !== undefined ? patch.folderId : file.folder_id;
    if (folderId) await this.requireFolder(spaceId, folderId);
    if (name.toLowerCase() !== file.name.toLowerCase() || folderId !== file.folder_id) {
      await this.assertNameFree(spaceId, folderId, name, id);
    }
    const row = await this.db.queryOne<FileRow>(
      `UPDATE files SET name = $3, folder_id = $4, tags = $5, description = $6,
         taken_at = $7, place = $8, visibility = $9, extension = $10,
         updated_by = $11, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND space_id = $2 RETURNING *`,
      [
        id,
        spaceId,
        name,
        folderId,
        JSON.stringify(patch.tags ?? parseJson<string[]>(file.tags, [])),
        patch.description ?? file.description,
        patch.takenAt !== undefined ? patch.takenAt : file.taken_at,
        patch.place ?? file.place,
        patch.visibility ?? file.visibility,
        classify(name, Buffer.alloc(0)).extension,
        user.id,
      ],
    );
    await this.activity(
      spaceId,
      user.id,
      'file.update',
      { fileId: id },
      { fields: Object.keys(patch) },
    );
    await this.record(user, spaceId, 'files.update', 'file', id, { fields: Object.keys(patch) });
    return toFileItem({ ...row!, created_by_name: file.created_by_name ?? null });
  }

  async trashFile(user: AuthenticatedUser, spaceId: string, id: string) {
    const file = await this.requireFile(spaceId, id);
    await this.assertFileAccess(user, spaceId, file, 'delete');
    const batch = newId('trb');
    await this.db.query(
      `UPDATE files SET deleted_at = CURRENT_TIMESTAMP, deleted_by = $3, trash_batch = $4
       WHERE id = $1 AND space_id = $2`,
      [id, spaceId, user.id, batch],
    );
    await this.activity(spaceId, user.id, 'file.trash', { fileId: id }, { name: file.name });
    await this.record(user, spaceId, 'files.trash', 'file', id, { name: file.name });
    return { trashed: true, batch };
  }

  async trashFolder(user: AuthenticatedUser, spaceId: string, id: string) {
    await this.access.assert(user.id, spaceId, 'files', 'update');
    const folder = await this.requireFolder(spaceId, id);
    const ids = await this.descendantFolderIds(spaceId, id);
    const batch = newId('trb');
    const placeholders = ids.map((_, index) => `$${index + 4}`).join(',');
    await this.db.query(
      `UPDATE file_folders SET deleted_at = CURRENT_TIMESTAMP, deleted_by = $2, trash_batch = $3
       WHERE space_id = $1 AND deleted_at IS NULL AND id IN (${placeholders})`,
      [spaceId, user.id, batch, ...ids],
    );
    await this.db.query(
      `UPDATE files SET deleted_at = CURRENT_TIMESTAMP, deleted_by = $2, trash_batch = $3
       WHERE space_id = $1 AND deleted_at IS NULL AND folder_id IN (${placeholders})`,
      [spaceId, user.id, batch, ...ids],
    );
    await this.activity(spaceId, user.id, 'folder.trash', { folderId: id }, { name: folder.name });
    await this.record(user, spaceId, 'files.folder.trash', 'file_folder', id, {
      name: folder.name,
    });
    return { trashed: true, batch };
  }

  private async descendantFolderIds(spaceId: string, rootId: string): Promise<string[]> {
    const ids = [rootId];
    for (let index = 0; index < ids.length && ids.length < 5000; index += 1) {
      const children = await this.db.query<{ id: string }>(
        'SELECT id FROM file_folders WHERE space_id = $1 AND parent_id = $2 AND deleted_at IS NULL',
        [spaceId, ids[index]],
      );
      ids.push(...children.map((child) => child.id));
    }
    return ids;
  }

  async trash(user: AuthenticatedUser, spaceId: string) {
    await this.access.assert(user.id, spaceId, 'files', 'read');
    const [folders, files] = await Promise.all([
      this.db.query<FolderRow>(
        `SELECT f.* FROM file_folders f WHERE f.space_id = $1 AND f.deleted_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM file_folders p WHERE p.id = f.parent_id AND p.trash_batch = f.trash_batch)
         ORDER BY f.deleted_at DESC LIMIT 500`,
        [spaceId],
      ),
      this.db.query<FileRow>(
        `${FILE_SELECT} WHERE f.space_id = $1 AND f.deleted_at IS NOT NULL
           AND (f.visibility = 'space' OR f.created_by = $2)
           AND NOT EXISTS (SELECT 1 FROM file_folders p WHERE p.id = f.folder_id AND p.trash_batch = f.trash_batch)
         ORDER BY f.deleted_at DESC LIMIT 500`,
        [spaceId, user.id],
      ),
    ]);
    return { folders: folders.map(toFolder), files: files.map(toFileItem) };
  }

  async restore(
    user: AuthenticatedUser,
    spaceId: string,
    target: { fileId?: string; folderId?: string },
  ) {
    let batch: string | null = null;
    if (target.fileId) {
      const file = await this.requireFile(spaceId, target.fileId, true);
      if (!file.deleted_at) return { restored: 0 };
      await this.assertFileAccess(user, spaceId, file, 'update');
      batch = file.trash_batch ?? null;
      if (!batch) {
        await this.restoreFileRow(spaceId, file);
        return { restored: 1 };
      }
    } else if (target.folderId) {
      await this.access.assert(user.id, spaceId, 'files', 'update');
      const folder = await this.requireFolder(spaceId, target.folderId, true);
      batch = folder.trash_batch ?? null;
    }
    if (!batch) throw new BadRequestException('nothing_to_restore');
    const folders = await this.db.query<FolderRow>(
      'SELECT * FROM file_folders WHERE space_id = $1 AND trash_batch = $2 ORDER BY created_at',
      [spaceId, batch],
    );
    for (const folder of folders) {
      // A parent that is still in the trash (or gone) means restore to root.
      const parentAlive = folder.parent_id
        ? await this.db.queryOne<{ id: string }>(
            `SELECT id FROM file_folders WHERE id = $1 AND (deleted_at IS NULL OR trash_batch = $2)`,
            [folder.parent_id, batch],
          )
        : null;
      let name = folder.name;
      const parentId = parentAlive ? folder.parent_id : null;
      const clash = await this.db.queryOne<{ id: string }>(
        `SELECT id FROM file_folders WHERE space_id = $1 AND parent_id IS NOT DISTINCT FROM $2
           AND LOWER(name) = LOWER($3) AND deleted_at IS NULL AND id <> $4`,
        [spaceId, parentId, name, folder.id],
      );
      if (clash) name = `${name} (${new Date().toISOString().slice(0, 10)})`;
      await this.db.query(
        `UPDATE file_folders SET deleted_at = NULL, deleted_by = NULL, trash_batch = NULL,
           parent_id = $2, name = $3 WHERE id = $1`,
        [folder.id, parentId, name],
      );
    }
    const files = await this.db.query<FileRow>(
      'SELECT * FROM files WHERE space_id = $1 AND trash_batch = $2',
      [spaceId, batch],
    );
    for (const file of files) await this.restoreFileRow(spaceId, file);
    await this.activity(spaceId, user.id, 'trash.restore', target, { batch, count: files.length });
    await this.record(
      user,
      spaceId,
      'files.restore',
      'file',
      target.fileId ?? target.folderId ?? batch,
      {
        count: files.length + folders.length,
      },
    );
    return { restored: files.length + folders.length };
  }

  private async restoreFileRow(spaceId: string, file: FileRow) {
    const folderAlive = file.folder_id
      ? await this.db.queryOne<{ id: string }>(
          'SELECT id FROM file_folders WHERE id = $1 AND deleted_at IS NULL',
          [file.folder_id],
        )
      : null;
    const folderId = folderAlive ? file.folder_id : null;
    const name = await this.freeNameIfTaken(spaceId, folderId, file.name, file.id);
    await this.db.query(
      `UPDATE files SET deleted_at = NULL, deleted_by = NULL, trash_batch = NULL, folder_id = $2, name = $3
       WHERE id = $1`,
      [file.id, folderId, name],
    );
  }

  private async freeNameIfTaken(
    spaceId: string,
    folderId: string | null,
    name: string,
    selfId: string,
  ) {
    const taken = await this.db.queryOne<{ id: string }>(
      `SELECT id FROM files WHERE space_id = $1 AND folder_id IS NOT DISTINCT FROM $2
         AND LOWER(name) = LOWER($3) AND deleted_at IS NULL AND id <> $4`,
      [spaceId, folderId, name, selfId],
    );
    return taken ? this.freeName(spaceId, folderId, name) : name;
  }

  async purge(user: AuthenticatedUser, spaceId: string, fileId: string) {
    await this.access.assert(user.id, spaceId, 'files', 'delete');
    const file = await this.requireFile(spaceId, fileId, true);
    if (!file.deleted_at) throw new BadRequestException('file_not_in_trash');
    await this.queue.purgeFile(fileId);
    await this.activity(spaceId, user.id, 'file.purge', { fileId }, { name: file.name });
    await this.record(user, spaceId, 'files.purge', 'file', fileId, { name: file.name });
    return { purged: true };
  }

  async emptyTrash(user: AuthenticatedUser, spaceId: string) {
    await this.access.assert(user.id, spaceId, 'files', 'delete');
    const rows = await this.db.query<{ id: string }>(
      'SELECT id FROM files WHERE space_id = $1 AND deleted_at IS NOT NULL',
      [spaceId],
    );
    for (const row of rows) await this.queue.purgeFile(row.id);
    await this.db.query(`DELETE FROM file_folders WHERE space_id = $1 AND deleted_at IS NOT NULL`, [
      spaceId,
    ]);
    await this.activity(spaceId, user.id, 'trash.empty', {}, { count: rows.length });
    await this.record(user, spaceId, 'files.trash.empty', 'space', spaceId, { count: rows.length });
    return { purged: rows.length };
  }

  async bulk(
    user: AuthenticatedUser,
    spaceId: string,
    input: {
      action: 'move' | 'trash' | 'tag';
      fileIds: string[];
      folderId?: string | null;
      tags?: string[];
    },
  ) {
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const id of input.fileIds) {
      try {
        if (input.action === 'trash') await this.trashFile(user, spaceId, id);
        if (input.action === 'move') {
          await this.update(user, spaceId, id, { folderId: input.folderId ?? null });
        }
        if (input.action === 'tag') {
          const file = await this.requireFile(spaceId, id);
          const merged = Array.from(
            new Set([...parseJson<string[]>(file.tags, []), ...(input.tags ?? [])]),
          ).slice(0, 30);
          await this.update(user, spaceId, id, { tags: merged });
        }
        results.push({ id, ok: true });
      } catch (error) {
        results.push({ id, ok: false, error: error instanceof Error ? error.message : 'failed' });
      }
    }
    return { results };
  }

  async versions(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
  ): Promise<FileVersionEntry[]> {
    await this.readableFile(user, spaceId, id);
    const rows = await this.db.query<FileVersionRow>(
      `SELECT v.*, u.display_name AS created_by_name FROM file_versions v
       LEFT JOIN users u ON u.id = v.created_by WHERE v.file_id = $1 ORDER BY v.version DESC`,
      [id],
    );
    return rows.map(toFileVersion);
  }

  async restoreVersion(user: AuthenticatedUser, spaceId: string, id: string, version: number) {
    const file = await this.requireFile(spaceId, id);
    await this.assertFileAccess(user, spaceId, file, 'update');
    const source = await this.db.queryOne<FileVersionRow>(
      'SELECT * FROM file_versions WHERE file_id = $1 AND version = $2',
      [id, version],
    );
    if (!source) throw new NotFoundException('file_version_not_found');
    const tempKey = `tmp/${newId('rst')}`;
    await this.storage.adapter.copy(source.storage_key, tempKey);
    const head = await this.storage.adapter.readBuffer(tempKey, 64 * 1024);
    return this.writeVersion(
      user,
      spaceId,
      file,
      tempKey,
      Number(source.size_bytes),
      source.sha256,
      classify(file.name, head),
      `restore:${version}`,
    );
  }

  async history(
    user: AuthenticatedUser,
    spaceId: string,
    fileId?: string,
  ): Promise<FileActivityEntry[]> {
    if (fileId) await this.readableFile(user, spaceId, fileId);
    else await this.access.assert(user.id, spaceId, 'files', 'read');
    const rows = await this.db.query<ActivityRow>(
      `SELECT a.*, u.display_name AS user_name FROM file_activity a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN files f ON f.id = a.file_id
       WHERE a.space_id = $1 ${fileId ? 'AND a.file_id = $3' : ''}
         AND (f.id IS NULL OR f.visibility = 'space' OR f.created_by = $2)
       ORDER BY a.created_at DESC LIMIT 200`,
      fileId ? [spaceId, user.id, fileId] : [spaceId, user.id],
    );
    return rows.map(toActivity);
  }

  async duplicates(
    user: AuthenticatedUser,
    spaceId: string,
    module: FileModule = 'files',
  ): Promise<DuplicateGroup[]> {
    await this.access.assert(user.id, spaceId, module, 'read');
    const rows = await this.db.query<FileRow>(
      `${FILE_SELECT} WHERE f.space_id = $1 AND f.deleted_at IS NULL
         AND (f.visibility = 'space' OR f.created_by = $2)
         ${module === 'photos' ? `AND f.kind IN ('image','video')` : ''}
         AND f.sha256 IN (
           SELECT sha256 FROM files WHERE space_id = $1 AND deleted_at IS NULL AND sha256 <> ''
           GROUP BY sha256 HAVING COUNT(*) > 1)
       ORDER BY f.sha256, f.created_at`,
      [spaceId, user.id],
    );
    const groups = new Map<string, DuplicateGroup>();
    for (const row of rows) {
      const group = groups.get(row.sha256) ?? {
        sha256: row.sha256,
        sizeBytes: Number(row.size_bytes),
        files: [],
      };
      group.files.push({
        id: row.id,
        name: row.name,
        folderId: row.folder_id,
        createdAt: new Date(row.created_at).toISOString(),
        kind: row.kind,
      });
      groups.set(row.sha256, group);
    }
    return [...groups.values()].filter((group) => group.files.length > 1);
  }

  // -------------------------------------------------------------------------
  // Content, previews and archives
  // -------------------------------------------------------------------------

  async content(user: AuthenticatedUser, spaceId: string, id: string, version?: number) {
    const file = await this.readableFile(user, spaceId, id);
    return this.contentFor(file, version);
  }

  async contentFor(file: FileRow, version?: number) {
    if (file.scan_status === 'blocked') throw new ForbiddenException('file_blocked_by_scan');
    let key = file.storage_key;
    let mime = file.mime_type;
    let size = Number(file.size_bytes);
    if (version && version !== Number(file.version)) {
      const row = await this.db.queryOne<FileVersionRow>(
        'SELECT * FROM file_versions WHERE file_id = $1 AND version = $2',
        [file.id, version],
      );
      if (!row) throw new NotFoundException('file_version_not_found');
      key = row.storage_key;
      mime = row.mime_type;
      size = Number(row.size_bytes);
    }
    return { file, key, mime, size, inline: isInlineSafe(mime) };
  }

  async preview(user: AuthenticatedUser, spaceId: string, id: string): Promise<FilePreview> {
    const file = await this.readableFile(user, spaceId, id);
    const contentUrl = `/api/files/${encodeURIComponent(id)}/content?spaceId=${encodeURIComponent(spaceId)}`;
    const base = { fileId: id, contentUrl: null, text: null, truncated: false, reason: null };
    if (file.scan_status === 'blocked') return { ...base, mode: 'none', reason: 'blocked' };
    if (file.kind === 'archive') return { ...base, mode: 'archive' };
    if (isInlineSafe(file.mime_type)) {
      const mode =
        file.kind === 'pdf'
          ? 'pdf'
          : file.kind === 'text'
            ? 'text'
            : (file.kind as 'image' | 'video' | 'audio');
      if (mode !== 'text') return { ...base, mode, contentUrl };
    }
    if (file.kind === 'text' || file.kind === 'office') {
      const limit = 512 * 1024;
      let text = file.ocr_text;
      if (!text && Number(file.size_bytes) <= 32 * 1024 * 1024) {
        const buffer = await this.storage.adapter.readBuffer(
          file.storage_key,
          file.kind === 'text' ? limit : undefined,
        );
        text = extractText(file.kind, file.extension, buffer) ?? '';
      }
      if (text) {
        return {
          ...base,
          mode: 'text',
          text: text.slice(0, 100_000),
          truncated: text.length > 100_000,
        };
      }
    }
    return { ...base, mode: 'none', reason: 'preview_not_supported' };
  }

  async archive(user: AuthenticatedUser, spaceId: string, id: string): Promise<ArchiveListing> {
    const file = await this.readableFile(user, spaceId, id);
    const result: ArchiveListing = {
      fileId: id,
      format: 'unsupported',
      entries: [],
      totalUncompressedBytes: 0,
      truncated: false,
      warnings: [],
      extracted: false,
    };
    if (file.mime_type !== 'application/zip' && file.kind !== 'office') {
      result.warnings.push('only_zip_listing_supported');
      return result;
    }
    if (Number(file.size_bytes) > 512 * 1024 * 1024) {
      result.warnings.push('archive_too_large_to_inspect');
      return result;
    }
    const buffer = await this.storage.adapter.readBuffer(file.storage_key);
    const directory = readZipDirectory(buffer);
    if (!directory) {
      result.warnings.push('zip_directory_not_found');
      return result;
    }
    result.format = 'zip';
    result.truncated = directory.truncated;
    if (directory.zip64) result.warnings.push('zip64_not_inspected');
    result.entries = directory.entries.map(
      ({ name, sizeBytes, compressedBytes, directory: dir, flags }) => ({
        name,
        sizeBytes,
        compressedBytes,
        directory: dir,
        flags,
      }),
    );
    result.totalUncompressedBytes = result.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    const flagged = new Set(result.entries.flatMap((entry) => entry.flags));
    for (const flag of flagged) result.warnings.push(flag);
    if (result.totalUncompressedBytes > 10 * Number(file.size_bytes) + 50 * 1024 * 1024) {
      result.warnings.push('possible_zip_bomb');
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // WebDAV tokens
  // -------------------------------------------------------------------------

  async webdavTokens(user: AuthenticatedUser, spaceId: string): Promise<WebDavToken[]> {
    await this.access.assert(user.id, spaceId, 'files', 'read');
    const rows = await this.db.query<{
      id: string;
      name: string;
      read_only: boolean;
      created_at: Date | string;
      last_used_at: Date | string | null;
      revoked_at: Date | string | null;
    }>(
      `SELECT * FROM webdav_tokens WHERE space_id = $1 AND user_id = $2 ORDER BY created_at DESC`,
      [spaceId, user.id],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      readOnly: row.read_only,
      createdAt: new Date(row.created_at).toISOString(),
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
      revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
      url: `/api/webdav/${spaceId}/`,
    }));
  }

  async createWebdavToken(
    user: AuthenticatedUser,
    spaceId: string,
    input: { name: string; readOnly: boolean },
  ): Promise<WebDavToken> {
    await this.access.assert(user.id, spaceId, 'files', 'read');
    const token = `ufdav_${randomToken(24)}`;
    const id = newId('wdt');
    await this.db.query(
      `INSERT INTO webdav_tokens (id, space_id, user_id, name, token_hash, read_only)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, spaceId, user.id, input.name, sha256(token), input.readOnly],
    );
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'files.webdav.token.create',
      entity: 'webdav_token',
      entityId: id,
      metadata: { name: input.name, readOnly: input.readOnly },
    });
    return {
      id,
      name: input.name,
      readOnly: input.readOnly,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
      url: `/api/webdav/${spaceId}/`,
      token,
    };
  }

  async revokeWebdavToken(user: AuthenticatedUser, spaceId: string, id: string) {
    await this.db.query(
      `UPDATE webdav_tokens SET revoked_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND space_id = $2 AND user_id = $3 AND revoked_at IS NULL`,
      [id, spaceId, user.id],
    );
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'files.webdav.token.revoke',
      entity: 'webdav_token',
      entityId: id,
    });
    return { revoked: true };
  }

  async webdavContext(token: string, spaceId: string) {
    const row = await this.db.queryOne<{ user_id: string; read_only: boolean; id: string }>(
      `SELECT id, user_id, read_only FROM webdav_tokens
       WHERE token_hash = $1 AND space_id = $2 AND revoked_at IS NULL`,
      [sha256(token), spaceId],
    );
    if (!row) throw new UnauthorizedException('webdav_token_invalid');
    const userRow = await this.db.queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [
      row.user_id,
    ]);
    if (!userRow) throw new UnauthorizedException('webdav_token_invalid');
    // Permissions are always evaluated live: revoked membership or a disabled
    // module immediately closes the WebDAV mount as well.
    await this.access.assert(row.user_id, spaceId, 'files', 'read');
    void this.db
      .query('UPDATE webdav_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1', [row.id])
      .catch(() => undefined);
    return { user: toAuthenticatedUser(userRow), readOnly: row.read_only };
  }

  /** Resolves a WebDAV path (already split into decoded segments). */
  async resolvePath(user: AuthenticatedUser, spaceId: string, segments: string[]) {
    let parentId: string | null = null;
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index]!;
      const last = index === segments.length - 1;
      const folder: FolderRow | null = await this.db.queryOne<FolderRow>(
        `SELECT * FROM file_folders WHERE space_id = $1 AND parent_id IS NOT DISTINCT FROM $2
           AND LOWER(name) = LOWER($3) AND deleted_at IS NULL`,
        [spaceId, parentId, name],
      );
      if (folder) {
        if (last) return { type: 'folder' as const, folder, parentId };
        parentId = folder.id;
        continue;
      }
      if (!last) return { type: 'missing' as const, parentId: null, parentMissing: true, name };
      const file = await this.db.queryOne<FileRow>(
        `${FILE_SELECT} WHERE f.space_id = $1 AND f.folder_id IS NOT DISTINCT FROM $2
           AND LOWER(f.name) = LOWER($3) AND f.deleted_at IS NULL
           AND (f.visibility = 'space' OR f.created_by = $4)`,
        [spaceId, parentId, name, user.id],
      );
      if (file) return { type: 'file' as const, file, parentId };
      return { type: 'missing' as const, parentId, parentMissing: false, name };
    }
    return { type: 'root' as const, parentId: null };
  }

  async folderChildren(user: AuthenticatedUser, spaceId: string, folderId: string | null) {
    const [folders, files] = await Promise.all([
      this.db.query<FolderRow>(
        `SELECT * FROM file_folders WHERE space_id = $1 AND parent_id IS NOT DISTINCT FROM $2
           AND deleted_at IS NULL ORDER BY name`,
        [spaceId, folderId],
      ),
      this.db.query<FileRow>(
        `${FILE_SELECT} WHERE f.space_id = $1 AND f.folder_id IS NOT DISTINCT FROM $2
           AND f.deleted_at IS NULL AND (f.visibility = 'space' OR f.created_by = $3) ORDER BY f.name`,
        [spaceId, folderId, user.id],
      ),
    ]);
    return { folders, files };
  }
}
