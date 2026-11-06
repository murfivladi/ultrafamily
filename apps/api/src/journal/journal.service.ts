import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { FileItem, JournalEntry, JournalKind, JournalVisibility } from '@ufos/contracts';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../common/authed-request';
import { newId } from '../config';
import { DatabaseService } from '../db/database.service';
import { parseJson } from '../db/rows';
import { FilesService } from '../files/files.service';
import { RealtimeService } from '../realtime/realtime.service';
import { toFileItem, toJournalEntry, type FileRow, type JournalRow } from '../stage-d/mappers';

export interface JournalInput {
  kind: JournalKind;
  title: string;
  body: string;
  visibility: JournalVisibility;
  mood: string;
  entryDate: string;
  tags: string[];
  fileIds: string[];
  eventIds: string[];
  personIds: string[];
}

const ENTRY_SELECT = `SELECT j.*, u.display_name AS author_name FROM journal_entries j
  LEFT JOIN users u ON u.id = j.author_user_id`;

/**
 * Diaries are private to their author — including from space owners and
 * administrators. An author may make an entry "family"; attachments then
 * inherit the entry's visibility for readers of that entry.
 */
@Injectable()
export class JournalService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly files: FilesService,
  ) {}

  async list(
    user: AuthenticatedUser,
    spaceId: string,
    filter: { scope?: 'mine' | 'family' | 'all'; kind?: JournalKind; year?: number; q?: string },
  ): Promise<JournalEntry[]> {
    await this.access.assert(user.id, spaceId, 'journal', 'read');
    const params: unknown[] = [spaceId, user.id];
    const where = [
      'j.space_id = $1',
      'j.deleted_at IS NULL',
      `(j.author_user_id = $2 OR j.visibility = 'family')`,
    ];
    if (filter.scope === 'mine') where.push('j.author_user_id = $2');
    if (filter.scope === 'family') where.push(`j.visibility = 'family'`);
    if (filter.kind) {
      params.push(filter.kind);
      where.push(`j.kind = $${params.length}`);
    }
    if (filter.year) {
      params.push(filter.year);
      where.push(`EXTRACT(YEAR FROM j.entry_date) = $${params.length}`);
    }
    if (filter.q) {
      params.push(`%${filter.q.replace(/[%_\\]/g, (match) => `\\${match}`)}%`);
      where.push(
        `(j.title ILIKE $${params.length} OR j.body ILIKE $${params.length} OR j.tags::text ILIKE $${params.length})`,
      );
    }
    const rows = await this.db.query<JournalRow>(
      `${ENTRY_SELECT} WHERE ${where.join(' AND ')} ORDER BY j.entry_date DESC, j.created_at DESC LIMIT 500`,
      params,
    );
    return rows.map((row) => toJournalEntry(row, user.id));
  }

  private async requireVisible(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
  ): Promise<JournalRow> {
    await this.access.assert(user.id, spaceId, 'journal', 'read');
    const row = await this.db.queryOne<JournalRow>(
      `${ENTRY_SELECT} WHERE j.id = $1 AND j.space_id = $2 AND j.deleted_at IS NULL`,
      [id, spaceId],
    );
    // A private entry of someone else does not exist for the viewer.
    if (!row || (row.author_user_id !== user.id && row.visibility !== 'family')) {
      throw new NotFoundException('journal_entry_not_found');
    }
    return row;
  }

  private async requireOwn(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
  ): Promise<JournalRow> {
    const row = await this.requireVisible(user, spaceId, id);
    if (row.author_user_id !== user.id) throw new ForbiddenException('journal_author_only');
    return row;
  }

  async get(user: AuthenticatedUser, spaceId: string, id: string): Promise<JournalEntry> {
    return toJournalEntry(await this.requireVisible(user, spaceId, id), user.id);
  }

  private async validateLinks(
    user: AuthenticatedUser,
    spaceId: string,
    input: Partial<JournalInput>,
  ) {
    for (const fileId of input.fileIds ?? []) {
      const file = await this.files.requireFile(spaceId, fileId);
      // Only the author's own uploads or family-visible files can be attached.
      if (file.visibility === 'private' && file.created_by !== user.id) {
        throw new BadRequestException('attachment_not_accessible');
      }
    }
    for (const personId of input.personIds ?? []) {
      const person = await this.db.queryOne<{ id: string }>(
        'SELECT id FROM family_people WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL',
        [personId, spaceId],
      );
      if (!person) throw new BadRequestException('person_not_in_space');
    }
    for (const eventId of input.eventIds ?? []) {
      const event = await this.db.queryOne<{ id: string }>(
        'SELECT id FROM calendar_events WHERE id = $1 AND space_id = $2',
        [eventId, spaceId],
      );
      if (!event) throw new BadRequestException('event_not_in_space');
    }
  }

  async create(
    user: AuthenticatedUser,
    spaceId: string,
    input: JournalInput,
  ): Promise<JournalEntry> {
    await this.access.assert(user.id, spaceId, 'journal', 'create');
    await this.validateLinks(user, spaceId, input);
    const id = newId('jrn');
    await this.db.query(
      `INSERT INTO journal_entries (id, space_id, author_user_id, kind, title, body, visibility, mood,
         entry_date, tags, file_ids, event_ids, person_ids, shared_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        id,
        spaceId,
        user.id,
        input.kind,
        input.title,
        input.body,
        input.visibility,
        input.mood,
        input.entryDate,
        JSON.stringify(input.tags),
        JSON.stringify(input.fileIds),
        JSON.stringify(input.eventIds),
        JSON.stringify(input.personIds),
        input.visibility === 'family' ? new Date().toISOString() : null,
      ],
    );
    await this.log(user, spaceId, 'journal.create', id, input.visibility, { kind: input.kind });
    return this.get(user, spaceId, id);
  }

  async update(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    patch: Partial<JournalInput>,
  ): Promise<JournalEntry> {
    const row = await this.requireOwn(user, spaceId, id);
    await this.access.assert(user.id, spaceId, 'journal', 'create');
    await this.validateLinks(user, spaceId, patch);
    const visibility = patch.visibility ?? row.visibility;
    const sharedAt = visibility === 'family' ? (row.shared_at ?? new Date().toISOString()) : null;
    await this.db.query(
      `UPDATE journal_entries SET kind = $3, title = $4, body = $5, visibility = $6, mood = $7,
         entry_date = $8, tags = $9, file_ids = $10, event_ids = $11, person_ids = $12,
         shared_at = $13, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND space_id = $2`,
      [
        id,
        spaceId,
        patch.kind ?? row.kind,
        patch.title ?? row.title,
        patch.body ?? row.body,
        visibility,
        patch.mood ?? row.mood,
        patch.entryDate ?? row.entry_date,
        JSON.stringify(patch.tags ?? parseJson<string[]>(row.tags, [])),
        JSON.stringify(patch.fileIds ?? parseJson<string[]>(row.file_ids, [])),
        JSON.stringify(patch.eventIds ?? parseJson<string[]>(row.event_ids, [])),
        JSON.stringify(patch.personIds ?? parseJson<string[]>(row.person_ids, [])),
        sharedAt,
      ],
    );
    await this.log(user, spaceId, 'journal.update', id, visibility, {
      fields: Object.keys(patch),
      visibilityChanged: visibility !== row.visibility,
    });
    return this.get(user, spaceId, id);
  }

  /**
   * Authors can always delete their own entries (a personal-data right), even
   * accounts whose role cannot delete shared family content.
   */
  async remove(user: AuthenticatedUser, spaceId: string, id: string) {
    const row = await this.requireOwn(user, spaceId, id);
    await this.db.query('DELETE FROM journal_entries WHERE id = $1', [id]);
    await this.log(user, spaceId, 'journal.delete', id, row.visibility);
    return { deleted: true };
  }

  async exportMine(user: AuthenticatedUser, spaceId: string) {
    await this.access.assert(user.id, spaceId, 'journal', 'read');
    const rows = await this.db.query<JournalRow>(
      `${ENTRY_SELECT} WHERE j.space_id = $1 AND j.author_user_id = $2 AND j.deleted_at IS NULL
       ORDER BY j.entry_date ASC`,
      [spaceId, user.id],
    );
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'journal.export',
      entity: 'journal',
      entityId: user.id,
      metadata: { count: rows.length },
    });
    return {
      format: 'ultra-family-os.journal.v1',
      exportedAt: new Date().toISOString(),
      author: { id: user.id, displayName: user.displayName },
      spaceId,
      entries: rows.map((row) => toJournalEntry(row, user.id)),
    };
  }

  async deleteMine(user: AuthenticatedUser, spaceId: string, confirm: string) {
    if (confirm !== 'DELETE') throw new BadRequestException('confirmation_required');
    await this.access.assert(user.id, spaceId, 'journal', 'read');
    const rows = await this.db.query<{ id: string }>(
      'DELETE FROM journal_entries WHERE space_id = $1 AND author_user_id = $2 RETURNING id',
      [spaceId, user.id],
    );
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'journal.delete_all_mine',
      entity: 'journal',
      entityId: user.id,
      metadata: { count: rows.length },
    });
    this.realtime.publish(spaceId, 'journal', user.id, { action: 'journal.purge' });
    return { deleted: rows.length };
  }

  /** Attachments of an entry, visible with the entry's own permissions. */
  async attachments(user: AuthenticatedUser, spaceId: string, id: string): Promise<FileItem[]> {
    const row = await this.requireVisible(user, spaceId, id);
    const ids = parseJson<string[]>(row.file_ids, []);
    if (ids.length === 0) return [];
    const placeholders = ids.map((_, index) => `$${index + 2}`).join(',');
    const files = await this.db.query<FileRow>(
      `SELECT * FROM files WHERE space_id = $1 AND deleted_at IS NULL AND id IN (${placeholders})`,
      [spaceId, ...ids],
    );
    return files
      .filter((file) => this.inherits(row, file))
      .map((file) => ({ ...toFileItem(file), previewable: toFileItem(file).previewable }));
  }

  async attachmentContent(user: AuthenticatedUser, spaceId: string, id: string, fileId: string) {
    const row = await this.requireVisible(user, spaceId, id);
    if (!parseJson<string[]>(row.file_ids, []).includes(fileId)) {
      throw new NotFoundException('attachment_not_found');
    }
    const file = await this.files.requireFile(spaceId, fileId);
    if (!this.inherits(row, file)) throw new NotFoundException('attachment_not_found');
    return this.files.contentFor(file);
  }

  /** Attachments inherit access when they are family files or the author's own. */
  private inherits(entry: JournalRow, file: FileRow): boolean {
    return file.visibility === 'space' || file.created_by === entry.author_user_id;
  }

  private async log(
    user: AuthenticatedUser,
    spaceId: string,
    action: string,
    id: string,
    visibility: JournalVisibility,
    metadata: Record<string, unknown> = {},
  ) {
    // Private diary text never reaches the audit log or realtime payloads.
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action,
      entity: 'journal_entry',
      entityId: id,
      metadata: { ...metadata, visibility },
    });
    if (visibility === 'family') {
      this.realtime.publish(spaceId, 'journal', user.id, { action, id });
    }
  }
}
