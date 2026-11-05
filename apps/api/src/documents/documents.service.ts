import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  DocumentComment,
  DocumentDetail,
  DocumentPermission,
  DocumentSummary,
  DocumentVersion,
} from '@ufos/contracts';
import type { z } from 'zod';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { newId } from '../config';
import type { AuthenticatedUser } from '../common/authed-request';
import { escapeLike } from '../common/like';
import { DatabaseService } from '../db/database.service';
import { iso, parseJson } from '../db/rows';
import { RealtimeService } from '../realtime/realtime.service';
import {
  toDocumentCollaborator,
  toDocumentComment,
  toDocumentSummary,
  toDocumentVersion,
  type DocumentCollaboratorRow,
  type DocumentCommentRow,
  type DocumentRow,
  type DocumentVersionRow,
} from '../stage-c/mappers';
import type {
  commentSchema,
  documentContentSchema,
  documentPatchSchema,
  documentSchema,
} from './dto';

type DocumentInput = z.infer<typeof documentSchema>;
type DocumentPatch = z.infer<typeof documentPatchSchema>;
type ContentInput = z.infer<typeof documentContentSchema>;
type CommentInput = z.infer<typeof commentSchema>;

const TEMPLATES: Record<
  string,
  { content: string; format: 'text' | 'markdown' | 'csv' | 'slides' }
> = {
  blank: { content: '', format: 'markdown' },
  minutes: {
    content: '# Протокол встречи\n\n## Участники\n\n## Повестка\n\n1. \n\n## Решения\n\n- \n',
    format: 'markdown',
  },
  checklist: { content: '# Чек-лист\n\n- [ ] \n- [ ] \n', format: 'markdown' },
  table: { content: 'Задача,Ответственный,Срок,Статус\n,,\n', format: 'csv' },
  presentation: { content: '# Слайд 1\n\n---\n\n# Слайд 2\n', format: 'slides' },
};

const DOCUMENT_SELECT = `
  SELECT d.*, creator.display_name AS created_by_name, editor.display_name AS updated_by_name,
    (SELECT COUNT(*)::int FROM document_comments c WHERE c.document_id = d.id) AS comment_count,
    (SELECT COUNT(*)::int FROM document_comments c WHERE c.document_id = d.id AND c.resolved_at IS NULL)
      AS open_comment_count
  FROM documents d
  LEFT JOIN users creator ON creator.id = d.created_by
  LEFT JOIN users editor ON editor.id = d.updated_by
`;

@Injectable()
export class DocumentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(user: AuthenticatedUser, spaceId: string): Promise<DocumentSummary[]> {
    await this.access.assert(user.id, spaceId, 'documents', 'read');
    const rows = await this.db.query<DocumentRow>(
      `${DOCUMENT_SELECT} WHERE d.space_id = $1 AND d.deleted_at IS NULL
       ORDER BY d.archived_at NULLS FIRST, d.updated_at DESC LIMIT 300`,
      [spaceId],
    );
    const permissions = await this.permissionMap(
      user,
      spaceId,
      rows.map((row) => row.id),
    );
    return rows.map((row) => toDocumentSummary(row, permissions.get(row.id) ?? 'read'));
  }

  async get(user: AuthenticatedUser, spaceId: string, id: string): Promise<DocumentDetail> {
    const row = await this.requireDocument(spaceId, id);
    const permission = await this.requirePermission(user, spaceId, row, 'read');
    const [collaborators, presence, comments] = await Promise.all([
      this.db.query<DocumentCollaboratorRow>(
        `SELECT c.*, u.display_name, u.avatar_color FROM document_collaborators c
         JOIN users u ON u.id = c.user_id WHERE c.document_id = $1`,
        [id],
      ),
      this.db.query<{
        user_id: string;
        display_name: string;
        cursor: unknown;
        last_seen_at: Date | string;
      }>(
        `SELECT p.user_id, u.display_name, p.cursor, p.last_seen_at
         FROM document_presence p JOIN users u ON u.id = p.user_id
         WHERE p.document_id = $1 AND p.last_seen_at > CURRENT_TIMESTAMP - INTERVAL '2 minutes'`,
        [id],
      ),
      this.comments(user, spaceId, id),
    ]);
    void comments;
    return {
      ...toDocumentSummary(row, permission),
      content: row.deleted_at ? '' : row.content,
      collaborators: collaborators.map(toDocumentCollaborator),
      presence: presence.map((entry) => ({
        userId: entry.user_id,
        displayName: entry.display_name,
        cursor: entry.cursor
          ? parseJson<{ anchor: number; head: number } | null>(entry.cursor, null)
          : null,
        lastSeenAt: iso(entry.last_seen_at) ?? new Date(0).toISOString(),
      })),
    };
  }

  async create(
    user: AuthenticatedUser,
    spaceId: string,
    input: DocumentInput,
  ): Promise<DocumentSummary> {
    await this.access.assert(user.id, spaceId, 'documents', 'create');
    if (input.parentId) {
      const parent = await this.requireDocument(spaceId, input.parentId);
      await this.requirePermission(user, spaceId, parent, 'edit');
    }
    const template = TEMPLATES[input.template] ?? TEMPLATES.blank!;
    const content = input.content.length > 0 ? input.content : template.content;
    const format = input.template !== 'blank' ? template.format : input.format;
    const row = await this.db.queryOne<DocumentRow>(
      `INSERT INTO documents
        (id, space_id, parent_id, kind, title, format, content, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
      [newId('doc'), spaceId, input.parentId, input.kind, input.title, format, content, user.id],
    );
    if (!row) throw new NotFoundException('document_not_created');
    await this.writeVersion(row.id, 1, row.title, content, user.id, 'create');
    await this.setCollaborator(row.id, user.id, 'edit');
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'documents.create',
      entity: 'document',
      entityId: row.id,
      metadata: { title: row.title, kind: row.kind },
    });
    this.realtime.publish(spaceId, 'documents', user.id, {
      action: 'document.create',
      documentId: row.id,
    });
    return toDocumentSummary({ ...row, created_by_name: user.displayName }, 'edit');
  }

  async update(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    patch: DocumentPatch,
  ): Promise<DocumentSummary> {
    const row = await this.requireDocument(spaceId, id);
    const permission = await this.requirePermission(user, spaceId, row, 'edit');
    if (patch.archived !== undefined) {
      await this.access.assert(user.id, spaceId, 'documents', 'update');
    }
    const fields: string[] = [];
    const params: unknown[] = [id];
    const push = (column: string, value: unknown) => {
      params.push(value);
      fields.push(`${column} = $${params.length}`);
    };
    if (patch.title !== undefined) push('title', patch.title);
    if (patch.kind !== undefined) push('kind', patch.kind);
    if (patch.format !== undefined) push('format', patch.format);
    if (patch.parentId !== undefined) {
      if (patch.parentId === id) throw new BadRequestException('document_cannot_be_own_parent');
      if (patch.parentId) await this.requireDocument(spaceId, patch.parentId);
      push('parent_id', patch.parentId);
    }
    if (patch.archived !== undefined) {
      push('archived_at', patch.archived ? new Date().toISOString() : null);
    }
    if (fields.length > 0) {
      params.push(user.id);
      fields.push(`updated_by = $${params.length}`);
      await this.db.query(
        `UPDATE documents SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        params,
      );
    }
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'documents.update',
      entity: 'document',
      entityId: id,
      metadata: { fields: Object.keys(patch), note: patch.note },
    });
    this.realtime.publish(spaceId, 'documents', user.id, {
      action: 'document.update',
      documentId: id,
    });
    const refreshed = await this.requireDocument(spaceId, id);
    return toDocumentSummary(refreshed, permission);
  }

  async saveContent(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    input: ContentInput,
  ): Promise<{ version: number; savedAt: string }> {
    const row = await this.requireDocument(spaceId, id);
    await this.requirePermission(user, spaceId, row, 'edit');
    if (Number(row.version) !== input.expectedVersion) {
      // The collaborative channel is authoritative; an HTTP save built on a
      // stale snapshot must never overwrite newer text.
      throw new ConflictException('document_version_conflict');
    }
    const version = Number(row.version) + 1;
    await this.db.query(
      `UPDATE documents SET content = $2, version = $3, updated_by = $4,
         updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [id, input.content, version, user.id],
    );
    await this.writeVersion(id, version, row.title, input.content, user.id, input.note || 'save');
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'documents.content.save',
      entity: 'document',
      entityId: id,
      metadata: { version, length: input.content.length },
    });
    this.realtime.publish(spaceId, 'documents', user.id, {
      action: 'document.content',
      documentId: id,
      version,
    });
    return { version, savedAt: new Date().toISOString() };
  }

  async versions(user: AuthenticatedUser, spaceId: string, id: string): Promise<DocumentVersion[]> {
    const row = await this.requireDocument(spaceId, id);
    await this.requirePermission(user, spaceId, row, 'read');
    const rows = await this.db.query<DocumentVersionRow>(
      `SELECT v.*, u.display_name AS created_by_name FROM document_versions v
       LEFT JOIN users u ON u.id = v.created_by
       WHERE v.document_id = $1 ORDER BY v.version DESC LIMIT 100`,
      [id],
    );
    return rows.map(toDocumentVersion);
  }

  async restore(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    version: number,
  ): Promise<DocumentSummary> {
    const row = await this.requireDocument(spaceId, id);
    await this.requirePermission(user, spaceId, row, 'edit');
    const target = await this.db.queryOne<DocumentVersionRow>(
      'SELECT * FROM document_versions WHERE document_id = $1 AND version = $2',
      [id, version],
    );
    if (!target) throw new NotFoundException('document_version_not_found');
    const next = Number(row.version) + 1;
    await this.db.query(
      `UPDATE documents SET content = $2, version = $3, updated_by = $4,
         updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [id, target.content, next, user.id],
    );
    await this.writeVersion(id, next, row.title, target.content, user.id, `restore:${version}`);
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'documents.version.restore',
      entity: 'document',
      entityId: id,
      metadata: { restoredVersion: version, newVersion: next },
    });
    this.realtime.publish(spaceId, 'documents', user.id, {
      action: 'document.restore',
      documentId: id,
      version: next,
    });
    const refreshed = await this.requireDocument(spaceId, id);
    return toDocumentSummary(refreshed, 'edit');
  }

  async remove(user: AuthenticatedUser, spaceId: string, id: string) {
    await this.access.assert(user.id, spaceId, 'documents', 'delete');
    await this.requireDocument(spaceId, id);
    await this.db.query(
      'UPDATE documents SET deleted_at = CURRENT_TIMESTAMP, archived_at = CURRENT_TIMESTAMP WHERE id = $1',
      [id],
    );
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'documents.delete',
      entity: 'document',
      entityId: id,
    });
    this.realtime.publish(spaceId, 'documents', user.id, {
      action: 'document.delete',
      documentId: id,
    });
    return { deleted: true };
  }

  async setCollaborators(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    input: Array<{ userId: string; permission: DocumentPermission }>,
  ) {
    const row = await this.requireDocument(spaceId, id);
    if (row.created_by !== user.id) {
      await this.access.assert(user.id, spaceId, 'documents', 'manage_access');
    }
    for (const collaborator of input) {
      const member = await this.db.queryOne<{ user_id: string }>(
        'SELECT user_id FROM memberships WHERE space_id = $1 AND user_id = $2',
        [spaceId, collaborator.userId],
      );
      if (!member) throw new BadRequestException('collaborator_not_in_space');
      await this.setCollaborator(id, collaborator.userId, collaborator.permission);
    }
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'documents.collaborators',
      entity: 'document',
      entityId: id,
      metadata: { collaborators: input.map((entry) => entry.userId) },
    });
    this.realtime.publish(spaceId, 'documents', user.id, {
      action: 'document.collaborators',
      documentId: id,
    });
    return this.collaborators(user, spaceId, id);
  }

  async collaborators(user: AuthenticatedUser, spaceId: string, id: string) {
    const row = await this.requireDocument(spaceId, id);
    await this.requirePermission(user, spaceId, row, 'read');
    const rows = await this.db.query<DocumentCollaboratorRow>(
      `SELECT c.*, u.display_name, u.avatar_color, p.cursor, p.editing, p.last_seen_at
       FROM document_collaborators c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN document_presence p ON p.document_id = c.document_id AND p.user_id = c.user_id
       WHERE c.document_id = $1`,
      [id],
    );
    return rows.map(toDocumentCollaborator);
  }

  async comments(user: AuthenticatedUser, spaceId: string, id: string): Promise<DocumentComment[]> {
    const row = await this.requireDocument(spaceId, id);
    await this.requirePermission(user, spaceId, row, 'read');
    const rows = await this.db.query<DocumentCommentRow>(
      `SELECT c.*, u.display_name AS author_name, u.avatar_color AS author_avatar_color
       FROM document_comments c LEFT JOIN users u ON u.id = c.author_user_id
       WHERE c.document_id = $1 ORDER BY c.created_at ASC`,
      [id],
    );
    return rows.map(toDocumentComment);
  }

  async addComment(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    input: CommentInput,
  ): Promise<DocumentComment> {
    const row = await this.requireDocument(spaceId, id);
    await this.requirePermission(user, spaceId, row, 'comment');
    const created = await this.db.queryOne<DocumentCommentRow>(
      `INSERT INTO document_comments (id, document_id, space_id, author_user_id, body, anchor)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        newId('dcm'),
        id,
        spaceId,
        user.id,
        input.body,
        input.anchor ? JSON.stringify(input.anchor) : null,
      ],
    );
    if (!created) throw new NotFoundException('document_comment_not_created');
    this.realtime.publish(spaceId, 'documents', user.id, {
      action: 'document.comment',
      documentId: id,
    });
    return toDocumentComment({
      ...created,
      author_name: user.displayName,
      author_avatar_color: user.avatarColor,
    });
  }

  async resolveComment(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    commentId: string,
    resolved: boolean,
  ) {
    const row = await this.requireDocument(spaceId, id);
    await this.requirePermission(user, spaceId, row, 'comment');
    await this.db.query(
      `UPDATE document_comments
       SET resolved_at = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE NULL END,
         resolved_by = CASE WHEN $3 THEN $4 ELSE NULL END
       WHERE id = $1 AND document_id = $2`,
      [commentId, id, resolved, user.id],
    );
    this.realtime.publish(spaceId, 'documents', user.id, {
      action: 'document.comment',
      documentId: id,
    });
    return { resolved };
  }

  /**
   * Resolves the effective document permission for a user. Space owners and
   * administrators can repair documents even when a collaborator row is
   * missing; everybody else needs an explicit grant or must have created it.
   */
  async resolvePermission(
    user: AuthenticatedUser,
    document: DocumentRow,
  ): Promise<DocumentPermission | null> {
    const collaboration = await this.access.assert(user.id, document.space_id, 'documents', 'read');
    const row = await this.db.queryOne<{ permission: DocumentPermission }>(
      'SELECT permission FROM document_collaborators WHERE document_id = $1 AND user_id = $2',
      [document.id, user.id],
    );
    const canManage = await this.access
      .assert(user.id, document.space_id, 'documents', 'update')
      .then(() => true)
      .catch(() => false);
    const isManager = collaboration.role === 'space_owner' || collaboration.role === 'space_admin';
    if (row) {
      if (row.permission === 'edit' && !canManage) return 'read';
      return row.permission;
    }
    if (document.created_by === user.id) return 'edit';
    if (isManager) return 'edit';
    // Family-wide documents stay readable by every member with module access,
    // but only explicit collaborators can change or comment on them.
    return canManage ? 'read' : 'read';
  }

  async requirePermission(
    user: AuthenticatedUser,
    spaceId: string,
    document: DocumentRow,
    needed: DocumentPermission,
  ): Promise<DocumentPermission> {
    void spaceId;
    const permission = await this.resolvePermission(user, document);
    if (!permission) throw new ForbiddenException('document_access_denied');
    const order: Record<DocumentPermission, number> = { read: 1, comment: 2, edit: 3 };
    if (order[permission] < order[needed]) {
      throw new ForbiddenException(`document_requires_${needed}`);
    }
    return permission;
  }

  /** Used by the WebSocket gateway before any collaborative update is applied. */
  async checkEditAccess(user: AuthenticatedUser, spaceId: string, id: string) {
    const row = await this.requireDocument(spaceId, id);
    const permission = await this.requirePermission(user, spaceId, row, 'edit');
    return { document: row, permission };
  }

  async checkReadAccess(user: AuthenticatedUser, spaceId: string, id: string) {
    const row = await this.requireDocument(spaceId, id);
    const permission = await this.requirePermission(user, spaceId, row, 'read');
    return { document: row, permission };
  }

  async touchDocument(spaceId: string, id: string, content: string, userId: string) {
    const row = await this.requireDocument(spaceId, id);
    const version = Number(row.version) + 1;
    await this.db.query(
      `UPDATE documents SET content = $2, version = $3, updated_by = $4,
         updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [id, content, version, userId],
    );
    await this.writeVersion(id, version, row.title, content, userId, 'collab');
    return version;
  }

  async recordPresence(
    id: string,
    userId: string,
    cursor: { anchor: number; head: number } | null,
    editing: boolean,
  ) {
    await this.db.query(
      `INSERT INTO document_presence (document_id, user_id, cursor, editing, last_seen_at)
       VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)
       ON CONFLICT (document_id, user_id) DO UPDATE SET
         cursor = EXCLUDED.cursor, editing = EXCLUDED.editing, last_seen_at = CURRENT_TIMESTAMP`,
      [id, userId, cursor ? JSON.stringify(cursor) : null, editing],
    );
  }

  private async requireDocument(spaceId: string, id: string): Promise<DocumentRow> {
    const row = await this.db.queryOne<DocumentRow>(
      `${DOCUMENT_SELECT} WHERE d.id = $1 AND d.space_id = $2 AND d.deleted_at IS NULL`,
      [id, spaceId],
    );
    if (!row) throw new NotFoundException('document_not_found');
    return row;
  }

  private async writeVersion(
    documentId: string,
    version: number,
    title: string,
    content: string,
    userId: string,
    note: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO document_versions (id, document_id, version, title, content, created_by, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (document_id, version) DO NOTHING`,
      [newId('dvr'), documentId, version, title, content, userId, note],
    );
  }

  private async setCollaborator(
    documentId: string,
    userId: string,
    permission: DocumentPermission,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO document_collaborators (document_id, user_id, permission, updated_at)
       VALUES ($1,$2,$3,CURRENT_TIMESTAMP)
       ON CONFLICT (document_id, user_id) DO UPDATE SET
         permission = EXCLUDED.permission, updated_at = CURRENT_TIMESTAMP`,
      [documentId, userId, permission],
    );
  }

  private async permissionMap(
    user: AuthenticatedUser,
    spaceId: string,
    documentIds: string[],
  ): Promise<Map<string, DocumentPermission>> {
    const map = new Map<string, DocumentPermission>();
    if (documentIds.length === 0) return map;
    const placeholders = documentIds.map((_, index) => `$${index + 2}`).join(',');
    const rows = await this.db.query<{ document_id: string; permission: DocumentPermission }>(
      `SELECT document_id, permission FROM document_collaborators
       WHERE user_id = $1 AND document_id IN (${placeholders})`,
      [user.id, ...documentIds],
    );
    const collaboration = await this.access.assert(user.id, spaceId, 'documents', 'read');
    const isManager = collaboration.role === 'space_owner' || collaboration.role === 'space_admin';
    for (const row of rows) map.set(row.document_id, row.permission);
    if (isManager) {
      for (const id of documentIds) if (!map.has(id)) map.set(id, 'edit');
    }
    return map;
  }
}

export { DOCUMENT_SELECT, TEMPLATES, escapeLike };
