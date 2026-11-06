import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  FaceRecognitionStatus,
  MediaComment,
  MediaItem,
  PhotoAlbum,
  PublicShareView,
  ShareLink,
  TimelineBucket,
} from '@ufos/contracts';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../common/authed-request';
import { PasswordService } from '../common/password.service';
import { hmac, newId, randomToken, sha256 } from '../config';
import { DatabaseService } from '../db/database.service';
import { parseJson } from '../db/rows';
import { FilesService } from '../files/files.service';
import { MediaQueueService } from '../files/media-queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  toAlbum,
  toFileItem,
  toMediaComment,
  toShareLink,
  type AlbumRow,
  type FileRow,
  type ShareRow,
} from '../stage-d/mappers';

const MEDIA_SELECT = `SELECT f.*, u.display_name AS created_by_name FROM files f
  LEFT JOIN users u ON u.id = f.created_by`;

export interface GalleryFilter {
  albumId?: string;
  favorites?: boolean;
  personId?: string;
  period?: string; // YYYY or YYYY-MM
  q?: string;
  limit?: number;
}

const GRANT_TTL_MS = 60 * 60 * 1000;

@Injectable()
export class PhotosService {
  private readonly unlockFailures = new Map<string, { count: number; until: number }>();

  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly files: FilesService,
    private readonly queue: MediaQueueService,
    private readonly passwords: PasswordService,
  ) {}

  private async log(
    user: AuthenticatedUser,
    spaceId: string,
    action: string,
    entity: string,
    entityId: string,
    metadata: Record<string, unknown> = {},
  ) {
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action,
      entity,
      entityId,
      metadata,
    });
    this.realtime.publish(spaceId, 'photos', user.id, { action, id: entityId });
  }

  private async requireMedia(
    user: AuthenticatedUser,
    spaceId: string,
    fileId: string,
  ): Promise<FileRow> {
    const file = await this.files.requireFile(spaceId, fileId);
    if (!['image', 'video', 'audio'].includes(file.kind))
      throw new NotFoundException('media_not_found');
    if (file.visibility === 'private' && file.created_by !== user.id) {
      throw new NotFoundException('media_not_found');
    }
    return file;
  }

  // -------------------------------------------------------------------------
  // Gallery feed and timeline
  // -------------------------------------------------------------------------

  async list(
    user: AuthenticatedUser,
    spaceId: string,
    filter: GalleryFilter,
  ): Promise<MediaItem[]> {
    await this.access.assert(user.id, spaceId, 'photos', 'read');
    const params: unknown[] = [spaceId, user.id];
    const where = [
      `f.space_id = $1`,
      `f.deleted_at IS NULL`,
      `f.kind IN ('image','video','audio')`,
      `f.scan_status <> 'blocked'`,
      `(f.visibility = 'space' OR f.created_by = $2)`,
    ];
    if (filter.albumId) {
      params.push(filter.albumId);
      where.push(
        `EXISTS (SELECT 1 FROM photo_album_items i WHERE i.file_id = f.id AND i.album_id = $${params.length})`,
      );
    }
    if (filter.favorites) {
      where.push(
        `EXISTS (SELECT 1 FROM media_favorites m WHERE m.file_id = f.id AND m.user_id = $2)`,
      );
    }
    if (filter.personId) {
      params.push(filter.personId);
      where.push(
        `EXISTS (SELECT 1 FROM media_people_tags t WHERE t.file_id = f.id
           AND (t.person_id = $${params.length} OR t.user_id = $${params.length}))`,
      );
    }
    if (filter.period && /^\d{4}(-\d{2})?$/.test(filter.period)) {
      params.push(filter.period);
      where.push(
        `to_char(COALESCE(f.taken_at, f.created_at), ${filter.period.length === 4 ? "'YYYY'" : "'YYYY-MM'"}) = $${params.length}`,
      );
    }
    if (filter.q) {
      params.push(`%${filter.q.replace(/[%_\\]/g, (match) => `\\${match}`)}%`);
      const index = params.length;
      where.push(
        `(f.name ILIKE $${index} OR f.description ILIKE $${index} OR f.place ILIKE $${index}
          OR f.tags::text ILIKE $${index} OR f.visual_labels::text ILIKE $${index}
          OR EXISTS (SELECT 1 FROM media_people_tags t WHERE t.file_id = f.id AND t.label ILIKE $${index}))`,
      );
    }
    params.push(Math.min(Math.max(filter.limit ?? 200, 1), 500));
    const rows = await this.db.query<FileRow>(
      `${MEDIA_SELECT} WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(f.taken_at, f.created_at) DESC LIMIT $${params.length}`,
      params,
    );
    return this.decorate(user, rows);
  }

  private async decorate(user: AuthenticatedUser, rows: FileRow[]): Promise<MediaItem[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map((_, index) => `$${index + 2}`).join(',');
    const [favorites, comments, reactions, people, albums] = await Promise.all([
      this.db.query<{ file_id: string }>(
        `SELECT file_id FROM media_favorites WHERE user_id = $1 AND file_id IN (${placeholders})`,
        [user.id, ...ids],
      ),
      this.db.query<{ file_id: string; count: number | string }>(
        `SELECT file_id, COUNT(*)::int AS count FROM media_comments
         WHERE deleted_at IS NULL AND file_id IN (${placeholders}) AND $1::text IS NOT NULL GROUP BY file_id`,
        [user.id, ...ids],
      ),
      this.db.query<{ file_id: string; emoji: string; count: number | string; mine: boolean }>(
        `SELECT file_id, emoji, COUNT(*)::int AS count, BOOL_OR(user_id = $1) AS mine
         FROM media_reactions WHERE file_id IN (${placeholders}) GROUP BY file_id, emoji`,
        [user.id, ...ids],
      ),
      this.db.query<{
        id: string;
        file_id: string;
        person_id: string | null;
        user_id: string | null;
        label: string;
        box: unknown;
      }>(
        `SELECT t.*, COALESCE(NULLIF(t.label, ''), p.full_name, u.display_name, '') AS label
         FROM media_people_tags t
         LEFT JOIN family_people p ON p.id = t.person_id
         LEFT JOIN users u ON u.id = t.user_id
         WHERE t.file_id IN (${placeholders}) AND $1::text IS NOT NULL`,
        [user.id, ...ids],
      ),
      this.db.query<{ file_id: string; album_id: string }>(
        `SELECT i.file_id, i.album_id FROM photo_album_items i
         JOIN photo_albums a ON a.id = i.album_id AND a.deleted_at IS NULL
         WHERE i.file_id IN (${placeholders}) AND $1::text IS NOT NULL`,
        [user.id, ...ids],
      ),
    ]);
    const favoriteSet = new Set(favorites.map((row) => row.file_id));
    return rows.map((row) => ({
      ...toFileItem(row),
      favorite: favoriteSet.has(row.id),
      commentCount: Number(comments.find((entry) => entry.file_id === row.id)?.count ?? 0),
      reactions: reactions
        .filter((entry) => entry.file_id === row.id)
        .map((entry) => ({
          emoji: entry.emoji,
          count: Number(entry.count),
          mine: Boolean(entry.mine),
        })),
      people: people
        .filter((entry) => entry.file_id === row.id)
        .map((entry) => ({
          id: entry.id,
          personId: entry.person_id,
          userId: entry.user_id,
          label: entry.label,
          box: parseJson<MediaItem['people'][number]['box']>(entry.box, null),
        })),
      albumIds: albums.filter((entry) => entry.file_id === row.id).map((entry) => entry.album_id),
    }));
  }

  async item(user: AuthenticatedUser, spaceId: string, fileId: string): Promise<MediaItem> {
    await this.access.assert(user.id, spaceId, 'photos', 'read');
    const file = await this.requireMedia(user, spaceId, fileId);
    const [decorated] = await this.decorate(user, [file]);
    return decorated!;
  }

  async timeline(user: AuthenticatedUser, spaceId: string): Promise<TimelineBucket[]> {
    await this.access.assert(user.id, spaceId, 'photos', 'read');
    const rows = await this.db.query<{
      period: string;
      count: number | string;
      cover: string | null;
    }>(
      `SELECT to_char(COALESCE(taken_at, created_at), 'YYYY-MM') AS period, COUNT(*)::int AS count,
         MIN(id) FILTER (WHERE kind = 'image') AS cover
       FROM files WHERE space_id = $1 AND deleted_at IS NULL AND kind IN ('image','video','audio')
         AND scan_status <> 'blocked' AND (visibility = 'space' OR created_by = $2)
       GROUP BY 1 ORDER BY 1 DESC`,
      [spaceId, user.id],
    );
    return rows.map((row) => ({
      period: row.period,
      count: Number(row.count),
      coverFileId: row.cover,
    }));
  }

  async updateMeta(
    user: AuthenticatedUser,
    spaceId: string,
    fileId: string,
    patch: { takenAt?: string | null; place?: string; description?: string; tags?: string[] },
  ) {
    await this.requireMedia(user, spaceId, fileId);
    await this.files.update(user, spaceId, fileId, patch);
    return this.item(user, spaceId, fileId);
  }

  // -------------------------------------------------------------------------
  // Albums
  // -------------------------------------------------------------------------

  async albums(user: AuthenticatedUser, spaceId: string): Promise<PhotoAlbum[]> {
    await this.access.assert(user.id, spaceId, 'photos', 'read');
    const rows = await this.db.query<AlbumRow>(
      `SELECT a.*, (SELECT COUNT(*)::int FROM photo_album_items i JOIN files f ON f.id = i.file_id
          WHERE i.album_id = a.id AND f.deleted_at IS NULL) AS item_count
       FROM photo_albums a WHERE a.space_id = $1 AND a.deleted_at IS NULL ORDER BY a.updated_at DESC`,
      [spaceId],
    );
    return rows.map(toAlbum);
  }

  private async requireAlbum(spaceId: string, id: string): Promise<AlbumRow> {
    const row = await this.db.queryOne<AlbumRow>(
      'SELECT * FROM photo_albums WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL',
      [id, spaceId],
    );
    if (!row) throw new NotFoundException('album_not_found');
    return row;
  }

  async createAlbum(
    user: AuthenticatedUser,
    spaceId: string,
    input: { title: string; description: string; fileIds: string[] },
  ): Promise<PhotoAlbum> {
    await this.access.assert(user.id, spaceId, 'photos', 'create');
    const id = newId('alb');
    await this.db.query(
      `INSERT INTO photo_albums (id, space_id, title, description, created_by) VALUES ($1,$2,$3,$4,$5)`,
      [id, spaceId, input.title, input.description, user.id],
    );
    if (input.fileIds.length > 0) await this.addItems(user, spaceId, id, input.fileIds);
    await this.log(user, spaceId, 'photos.album.create', 'photo_album', id, { title: input.title });
    const albums = await this.albums(user, spaceId);
    return albums.find((album) => album.id === id)!;
  }

  async updateAlbum(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    patch: { title?: string; description?: string; coverFileId?: string | null },
  ): Promise<PhotoAlbum> {
    const album = await this.requireAlbum(spaceId, id);
    await this.assertAlbumWrite(user, spaceId, album);
    if (patch.coverFileId) await this.requireMedia(user, spaceId, patch.coverFileId);
    await this.db.query(
      `UPDATE photo_albums SET title = $3, description = $4, cover_file_id = $5, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND space_id = $2`,
      [
        id,
        spaceId,
        patch.title ?? album.title,
        patch.description ?? album.description,
        patch.coverFileId !== undefined ? patch.coverFileId : album.cover_file_id,
      ],
    );
    await this.log(user, spaceId, 'photos.album.update', 'photo_album', id, {
      fields: Object.keys(patch),
    });
    const albums = await this.albums(user, spaceId);
    return albums.find((entry) => entry.id === id)!;
  }

  async deleteAlbum(user: AuthenticatedUser, spaceId: string, id: string) {
    const album = await this.requireAlbum(spaceId, id);
    await this.assertAlbumWrite(user, spaceId, album, 'delete');
    await this.db.query('UPDATE photo_albums SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1', [
      id,
    ]);
    await this.db.query(
      `UPDATE share_links SET revoked_at = CURRENT_TIMESTAMP, revoked_by = $2
       WHERE target_kind = 'album' AND target_id = $1 AND revoked_at IS NULL`,
      [id, user.id],
    );
    await this.log(user, spaceId, 'photos.album.delete', 'photo_album', id);
    return { deleted: true };
  }

  private async assertAlbumWrite(
    user: AuthenticatedUser,
    spaceId: string,
    album: AlbumRow,
    action: 'update' | 'delete' = 'update',
  ) {
    if (album.created_by === user.id) {
      await this.access.assert(user.id, spaceId, 'photos', 'create');
      return;
    }
    await this.access.assert(user.id, spaceId, 'photos', action);
  }

  async addItems(user: AuthenticatedUser, spaceId: string, albumId: string, fileIds: string[]) {
    const album = await this.requireAlbum(spaceId, albumId);
    await this.assertAlbumWrite(user, spaceId, album);
    const position = await this.db.queryOne<{ max: number | null }>(
      'SELECT MAX(position) AS max FROM photo_album_items WHERE album_id = $1',
      [albumId],
    );
    let next = Number(position?.max ?? 0) + 1;
    for (const fileId of fileIds) {
      await this.requireMedia(user, spaceId, fileId);
      await this.db.query(
        `INSERT INTO photo_album_items (album_id, file_id, position, added_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (album_id, file_id) DO NOTHING`,
        [albumId, fileId, next, user.id],
      );
      next += 1;
    }
    if (!album.cover_file_id && fileIds[0]) {
      await this.db.query('UPDATE photo_albums SET cover_file_id = $2 WHERE id = $1', [
        albumId,
        fileIds[0],
      ]);
    }
    await this.db.query('UPDATE photo_albums SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [
      albumId,
    ]);
    await this.log(user, spaceId, 'photos.album.items.add', 'photo_album', albumId, {
      count: fileIds.length,
    });
    return { added: fileIds.length };
  }

  async removeItem(user: AuthenticatedUser, spaceId: string, albumId: string, fileId: string) {
    const album = await this.requireAlbum(spaceId, albumId);
    await this.assertAlbumWrite(user, spaceId, album);
    await this.db.query('DELETE FROM photo_album_items WHERE album_id = $1 AND file_id = $2', [
      albumId,
      fileId,
    ]);
    if (album.cover_file_id === fileId) {
      await this.db.query('UPDATE photo_albums SET cover_file_id = NULL WHERE id = $1', [albumId]);
    }
    await this.log(user, spaceId, 'photos.album.items.remove', 'photo_album', albumId, { fileId });
    return { removed: true };
  }

  // -------------------------------------------------------------------------
  // Comments, reactions, favorites, people tags
  // -------------------------------------------------------------------------

  async comments(
    user: AuthenticatedUser,
    spaceId: string,
    fileId: string,
  ): Promise<MediaComment[]> {
    await this.access.assert(user.id, spaceId, 'photos', 'read');
    await this.requireMedia(user, spaceId, fileId);
    const rows = await this.db.query<Parameters<typeof toMediaComment>[0]>(
      `SELECT c.*, u.display_name AS author_name FROM media_comments c
       LEFT JOIN users u ON u.id = c.author_user_id
       WHERE c.file_id = $1 AND c.deleted_at IS NULL ORDER BY c.created_at ASC`,
      [fileId],
    );
    return rows.map(toMediaComment);
  }

  /** Commenting and reacting is participation, allowed with read access (incl. children). */
  async addComment(user: AuthenticatedUser, spaceId: string, fileId: string, body: string) {
    await this.access.assert(user.id, spaceId, 'photos', 'read');
    await this.requireMedia(user, spaceId, fileId);
    const id = newId('mcm');
    await this.db.query(
      `INSERT INTO media_comments (id, space_id, file_id, author_user_id, body) VALUES ($1,$2,$3,$4,$5)`,
      [id, spaceId, fileId, user.id, body],
    );
    await this.log(user, spaceId, 'photos.comment', 'file', fileId, { commentId: id });
    return (await this.comments(user, spaceId, fileId)).find((comment) => comment.id === id)!;
  }

  async deleteComment(user: AuthenticatedUser, spaceId: string, fileId: string, commentId: string) {
    const row = await this.db.queryOne<{ author_user_id: string | null }>(
      'SELECT author_user_id FROM media_comments WHERE id = $1 AND file_id = $2 AND space_id = $3',
      [commentId, fileId, spaceId],
    );
    if (!row) throw new NotFoundException('comment_not_found');
    if (row.author_user_id !== user.id)
      await this.access.assert(user.id, spaceId, 'photos', 'delete');
    await this.db.query('UPDATE media_comments SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1', [
      commentId,
    ]);
    await this.log(user, spaceId, 'photos.comment.delete', 'file', fileId, { commentId });
    return { deleted: true };
  }

  async react(
    user: AuthenticatedUser,
    spaceId: string,
    fileId: string,
    emoji: string,
    on: boolean,
  ) {
    await this.access.assert(user.id, spaceId, 'photos', 'read');
    await this.requireMedia(user, spaceId, fileId);
    if (on) {
      await this.db.query(
        `INSERT INTO media_reactions (file_id, user_id, emoji) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [fileId, user.id, emoji],
      );
    } else {
      await this.db.query(
        'DELETE FROM media_reactions WHERE file_id = $1 AND user_id = $2 AND emoji = $3',
        [fileId, user.id, emoji],
      );
    }
    this.realtime.publish(spaceId, 'photos', user.id, { action: 'photos.reaction', id: fileId });
    return this.item(user, spaceId, fileId);
  }

  async favorite(user: AuthenticatedUser, spaceId: string, fileId: string, on: boolean) {
    await this.access.assert(user.id, spaceId, 'photos', 'read');
    await this.requireMedia(user, spaceId, fileId);
    if (on) {
      await this.db.query(
        'INSERT INTO media_favorites (file_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [fileId, user.id],
      );
    } else {
      await this.db.query('DELETE FROM media_favorites WHERE file_id = $1 AND user_id = $2', [
        fileId,
        user.id,
      ]);
    }
    return this.item(user, spaceId, fileId);
  }

  async tagPerson(
    user: AuthenticatedUser,
    spaceId: string,
    fileId: string,
    input: {
      personId: string | null;
      userId: string | null;
      label: string;
      box: { x: number; y: number; w: number; h: number } | null;
    },
  ) {
    await this.access.assert(user.id, spaceId, 'photos', 'update').catch(async () => {
      const file = await this.requireMedia(user, spaceId, fileId);
      if (file.created_by !== user.id)
        throw new ForbiddenException('access_denied:role_not_permitted');
    });
    await this.requireMedia(user, spaceId, fileId);
    if (!input.personId && !input.userId && !input.label)
      throw new BadRequestException('tag_target_required');
    if (input.personId) {
      const person = await this.db.queryOne<{ id: string }>(
        'SELECT id FROM family_people WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL',
        [input.personId, spaceId],
      );
      if (!person) throw new BadRequestException('person_not_in_space');
    }
    if (input.userId) {
      const member = await this.db.queryOne<{ user_id: string }>(
        'SELECT user_id FROM memberships WHERE space_id = $1 AND user_id = $2',
        [spaceId, input.userId],
      );
      if (!member) throw new BadRequestException('user_not_in_space');
    }
    const id = newId('mpt');
    await this.db.query(
      `INSERT INTO media_people_tags (id, space_id, file_id, person_id, user_id, label, box, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        spaceId,
        fileId,
        input.personId,
        input.userId,
        input.label,
        input.box ? JSON.stringify(input.box) : null,
        user.id,
      ],
    );
    await this.log(user, spaceId, 'photos.people.tag', 'file', fileId, { tagId: id, manual: true });
    return this.item(user, spaceId, fileId);
  }

  async untagPerson(user: AuthenticatedUser, spaceId: string, fileId: string, tagId: string) {
    const tag = await this.db.queryOne<{ created_by: string | null; user_id: string | null }>(
      'SELECT created_by, user_id FROM media_people_tags WHERE id = $1 AND file_id = $2 AND space_id = $3',
      [tagId, fileId, spaceId],
    );
    if (!tag) throw new NotFoundException('tag_not_found');
    // The tagger, the tagged person and editors may remove a tag.
    if (tag.created_by !== user.id && tag.user_id !== user.id) {
      await this.access.assert(user.id, spaceId, 'photos', 'update');
    }
    await this.db.query('DELETE FROM media_people_tags WHERE id = $1', [tagId]);
    await this.log(user, spaceId, 'photos.people.untag', 'file', fileId, { tagId });
    return this.item(user, spaceId, fileId);
  }

  // -------------------------------------------------------------------------
  // Face recognition: opt-in, local only, children disabled by default
  // -------------------------------------------------------------------------

  async faceStatus(
    user: AuthenticatedUser,
    spaceId: string,
    userId?: string,
  ): Promise<FaceRecognitionStatus> {
    await this.access.assert(user.id, spaceId, 'photos', 'read');
    const subjectId = userId ?? user.id;
    if (subjectId !== user.id) await this.assertGuardian(user, spaceId);
    const subject = await this.db.queryOne<{ is_child: boolean }>(
      `SELECT u.is_child FROM users u JOIN memberships m ON m.user_id = u.id AND m.space_id = $2
       WHERE u.id = $1`,
      [subjectId, spaceId],
    );
    if (!subject) throw new NotFoundException('member_not_found');
    const [setting, stored] = await Promise.all([
      this.db.queryOne<{
        enabled: boolean;
        consent_by: string | null;
        consent_at: Date | string | null;
      }>('SELECT * FROM face_recognition_settings WHERE space_id = $1 AND user_id = $2', [
        spaceId,
        subjectId,
      ]),
      this.db.queryOne<{ count: number | string }>(
        'SELECT COUNT(*)::int AS count FROM face_embeddings WHERE space_id = $1 AND user_id = $2',
        [spaceId, subjectId],
      ),
    ]);
    const engineAvailable = this.queue.engines().faces.available;
    return {
      userId: subjectId,
      enabled: Boolean(setting?.enabled),
      isChild: subject.is_child,
      consentBy: setting?.consent_by ?? null,
      consentAt: setting?.consent_at ? new Date(setting.consent_at).toISOString() : null,
      engineAvailable,
      storedRepresentations: Number(stored?.count ?? 0),
      note: engineAvailable ? 'local_engine_only' : 'face_engine_not_configured_manual_tags_only',
    };
  }

  private async assertGuardian(user: AuthenticatedUser, spaceId: string) {
    const context = await this.access.assert(user.id, spaceId, 'photos', 'manage_access');
    if (context.role !== 'space_owner' && context.role !== 'space_admin') {
      throw new ForbiddenException('guardian_required');
    }
  }

  async setFace(
    user: AuthenticatedUser,
    spaceId: string,
    input: { userId?: string; enabled: boolean; consent: boolean },
  ): Promise<FaceRecognitionStatus> {
    const subjectId = input.userId ?? user.id;
    const status = await this.faceStatus(user, spaceId, subjectId);
    if (input.enabled) {
      if (!input.consent) throw new BadRequestException('face_consent_required');
      // A child's own account can never switch recognition on; a guardian must.
      if (status.isChild && (subjectId === user.id || user.isChild)) {
        throw new ForbiddenException('face_recognition_child_requires_guardian');
      }
      if (subjectId !== user.id) await this.assertGuardian(user, spaceId);
    }
    await this.db.query(
      `INSERT INTO face_recognition_settings (space_id, user_id, enabled, consent_by, consent_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)
       ON CONFLICT (space_id, user_id) DO UPDATE SET enabled = EXCLUDED.enabled,
         consent_by = EXCLUDED.consent_by, consent_at = EXCLUDED.consent_at, updated_at = CURRENT_TIMESTAMP`,
      [
        spaceId,
        subjectId,
        input.enabled,
        input.enabled ? user.id : null,
        input.enabled ? new Date().toISOString() : null,
      ],
    );
    if (!input.enabled) {
      // Turning it off also deletes stored biometric representations.
      await this.db.query('DELETE FROM face_embeddings WHERE space_id = $1 AND user_id = $2', [
        spaceId,
        subjectId,
      ]);
    }
    await this.log(
      user,
      spaceId,
      input.enabled ? 'photos.faces.enable' : 'photos.faces.disable',
      'user',
      subjectId,
      {
        guardian: subjectId !== user.id,
      },
    );
    return this.faceStatus(user, spaceId, subjectId);
  }

  async deleteFaceData(user: AuthenticatedUser, spaceId: string, userId?: string) {
    const subjectId = userId ?? user.id;
    if (subjectId !== user.id) await this.assertGuardian(user, spaceId);
    else await this.access.assert(user.id, spaceId, 'photos', 'read');
    const rows = await this.db.query<{ id: string }>(
      'DELETE FROM face_embeddings WHERE space_id = $1 AND user_id = $2 RETURNING id',
      [spaceId, subjectId],
    );
    await this.log(user, spaceId, 'photos.faces.data.delete', 'user', subjectId, {
      deleted: rows.length,
    });
    return { deleted: rows.length };
  }

  // -------------------------------------------------------------------------
  // Protected share links
  // -------------------------------------------------------------------------

  async shares(user: AuthenticatedUser, spaceId: string, targetId?: string): Promise<ShareLink[]> {
    await this.access.assert(user.id, spaceId, 'photos', 'read');
    const rows = await this.db.query<ShareRow>(
      `SELECT * FROM share_links WHERE space_id = $1 ${targetId ? 'AND target_id = $2' : ''}
       ORDER BY created_at DESC LIMIT 200`,
      targetId ? [spaceId, targetId] : [spaceId],
    );
    return rows.map(toShareLink);
  }

  async createShare(
    user: AuthenticatedUser,
    spaceId: string,
    input: {
      targetKind: 'file' | 'album';
      targetId: string;
      label: string;
      expiresInHours: number;
      password: string | null;
      allowDownload: boolean;
    },
  ): Promise<ShareLink> {
    // Sharing outside the family is publishing; children never get it.
    await this.access.assert(user.id, spaceId, 'photos', 'publish');
    if (input.targetKind === 'file') {
      const file = await this.files.requireFile(spaceId, input.targetId);
      await this.files.assertFileAccess(user, spaceId, file, 'read');
      if (file.visibility === 'private')
        throw new ForbiddenException('private_file_cannot_be_shared');
    } else {
      await this.requireAlbum(spaceId, input.targetId);
    }
    const token = randomToken(24);
    const id = newId('shr');
    const passwordHash = input.password ? await this.passwords.hash(input.password) : null;
    const row = await this.db.queryOne<ShareRow>(
      `INSERT INTO share_links (id, space_id, target_kind, target_id, label, token_hash, password_hash,
         allow_download, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CURRENT_TIMESTAMP + (INTERVAL '1 hour' * $9), $10) RETURNING *`,
      [
        id,
        spaceId,
        input.targetKind,
        input.targetId,
        input.label,
        sha256(token),
        passwordHash,
        input.allowDownload,
        input.expiresInHours,
        user.id,
      ],
    );
    await this.log(user, spaceId, 'photos.share.create', 'share_link', id, {
      targetKind: input.targetKind,
      targetId: input.targetId,
      expiresInHours: input.expiresInHours,
      passwordProtected: Boolean(passwordHash),
      allowDownload: input.allowDownload,
    });
    return { ...toShareLink(row!), url: `/share/${token}` };
  }

  async revokeShare(user: AuthenticatedUser, spaceId: string, id: string) {
    const row = await this.db.queryOne<ShareRow>(
      'SELECT * FROM share_links WHERE id = $1 AND space_id = $2',
      [id, spaceId],
    );
    if (!row) throw new NotFoundException('share_not_found');
    if (row.created_by !== user.id)
      await this.access.assert(user.id, spaceId, 'photos', 'manage_access');
    else await this.access.assert(user.id, spaceId, 'photos', 'read');
    await this.db.query(
      'UPDATE share_links SET revoked_at = CURRENT_TIMESTAMP, revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL',
      [id, user.id],
    );
    await this.log(user, spaceId, 'photos.share.revoke', 'share_link', id);
    return { revoked: true };
  }

  // Public side (no session) -----------------------------------------------

  private async activeShare(token: string): Promise<ShareRow> {
    const row = await this.db.queryOne<ShareRow>(
      'SELECT * FROM share_links WHERE token_hash = $1',
      [sha256(token)],
    );
    if (!row) throw new NotFoundException('share_not_found');
    if (row.revoked_at) throw new GoneException('share_revoked');
    if (new Date(row.expires_at).getTime() <= Date.now()) throw new GoneException('share_expired');
    return row;
  }

  private grantFor(share: ShareRow, expires: number): string {
    return `${expires}.${hmac(`share:${share.id}:${expires}`)}`;
  }

  private checkGrant(share: ShareRow, grant: string | undefined): boolean {
    if (!share.password_hash) return true;
    if (!grant) return false;
    const [expiresRaw, signature] = grant.split('.');
    const expires = Number(expiresRaw);
    if (!expires || expires < Date.now() || !signature) return false;
    return hmac(`share:${share.id}:${expires}`) === signature;
  }

  async publicView(token: string, grant?: string): Promise<PublicShareView> {
    const share = await this.activeShare(token);
    const base = {
      label: share.label,
      targetKind: share.target_kind,
      allowDownload: share.allow_download,
      expiresAt: new Date(share.expires_at).toISOString(),
    };
    if (!this.checkGrant(share, grant)) return { ...base, passwordRequired: true, items: [] };
    const items = await this.shareItems(share);
    await this.db.query(
      'UPDATE share_links SET access_count = access_count + 1, last_access_at = CURRENT_TIMESTAMP WHERE id = $1',
      [share.id],
    );
    const suffix = grant ? `?grant=${encodeURIComponent(grant)}` : '';
    return {
      ...base,
      passwordRequired: false,
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        kind: item.kind,
        mimeType: item.mime_type,
        sizeBytes: Number(item.size_bytes),
        contentUrl: `/api/public/shares/${encodeURIComponent(token)}/items/${encodeURIComponent(item.id)}${suffix}`,
      })),
    };
  }

  async unlock(token: string, password: string): Promise<PublicShareView> {
    const share = await this.activeShare(token);
    const failures = this.unlockFailures.get(share.id);
    if (failures && failures.until > Date.now() && failures.count >= 5) {
      throw new UnauthorizedException('share_unlock_throttled');
    }
    if (!share.password_hash) return this.publicView(token);
    const ok = await this.passwords.verify(password, share.password_hash);
    if (!ok) {
      const current = failures && failures.until > Date.now() ? failures.count + 1 : 1;
      this.unlockFailures.set(share.id, { count: current, until: Date.now() + 15 * 60 * 1000 });
      throw new UnauthorizedException('share_password_invalid');
    }
    this.unlockFailures.delete(share.id);
    const grant = this.grantFor(share, Date.now() + GRANT_TTL_MS);
    return { ...(await this.publicView(token, grant)), grant };
  }

  async publicItem(token: string, fileId: string, grant?: string) {
    const share = await this.activeShare(token);
    if (!this.checkGrant(share, grant)) throw new UnauthorizedException('share_password_required');
    const items = await this.shareItems(share);
    const file = items.find((item) => item.id === fileId);
    if (!file) throw new NotFoundException('share_item_not_found');
    const content = await this.files.contentFor(file);
    // Without download permission only inline-safe media is shown, never saved
    // as an attachment. This is a deterrent, not DRM: screenshots stay possible.
    if (!share.allow_download && !content.inline)
      throw new ForbiddenException('share_download_disabled');
    return { ...content, allowDownload: share.allow_download };
  }

  private async shareItems(share: ShareRow): Promise<FileRow[]> {
    if (share.target_kind === 'file') {
      const file = await this.db.queryOne<FileRow>(
        `SELECT * FROM files WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL
           AND visibility = 'space' AND scan_status <> 'blocked'`,
        [share.target_id, share.space_id],
      );
      return file ? [file] : [];
    }
    return this.db.query<FileRow>(
      `SELECT f.* FROM photo_album_items i
       JOIN photo_albums a ON a.id = i.album_id AND a.deleted_at IS NULL
       JOIN files f ON f.id = i.file_id
       WHERE i.album_id = $1 AND a.space_id = $2 AND f.deleted_at IS NULL
         AND f.visibility = 'space' AND f.scan_status <> 'blocked'
       ORDER BY i.position ASC LIMIT 500`,
      [share.target_id, share.space_id],
    );
  }
}
