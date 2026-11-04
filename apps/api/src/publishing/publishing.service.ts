import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Language, PublicPost, PublicationVisibility } from '@ufos/contracts';
import type { z } from 'zod';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { newId } from '../config';
import type { AuthenticatedUser } from '../common/authed-request';
import { DatabaseService } from '../db/database.service';
import { parseJson, toPublicPost, type PublicPostRow } from '../db/rows';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import type { createDraftSchema, publishSchema, unpublishSchema, updatePostSchema } from './dto';

type DraftInput = z.infer<typeof createDraftSchema>;
type UpdateInput = z.infer<typeof updatePostSchema>;
type PublishInput = z.infer<typeof publishSchema>;
type UnpublishInput = z.infer<typeof unpublishSchema>;

const TRANSLIT: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

function slugify(value: string): string {
  const slug = value
    .toLocaleLowerCase('ru')
    .split('')
    .map((char) => TRANSLIT[char] ?? (/[a-z0-9]/.test(char) ? char : '-'))
    .join('')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90);
  return slug || 'post';
}

@Injectable()
export class PublishingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(user: AuthenticatedUser, spaceId: string): Promise<PublicPost[]> {
    await this.access.assert(user.id, spaceId, 'public_site', 'read');
    const rows = await this.db.query<PublicPostRow>(
      `SELECT p.*, s.name AS space_name FROM public_posts p
       JOIN spaces s ON s.id = p.space_id
       WHERE p.space_id = $1 ORDER BY p.updated_at DESC LIMIT 100`,
      [spaceId],
    );
    return rows.map(toPublicPost);
  }

  async stats(user: AuthenticatedUser, spaceId: string) {
    await this.access.assert(user.id, spaceId, 'public_site', 'read');
    const rows = await this.db.query<{ status: string; count: number | string }>(
      'SELECT status, COUNT(*)::int AS count FROM public_posts WHERE space_id = $1 GROUP BY status',
      [spaceId],
    );
    return {
      total: rows.reduce((sum, row) => sum + Number(row.count ?? 0), 0),
      byStatus: Object.fromEntries(rows.map((row) => [row.status, Number(row.count ?? 0)])),
      explicitPublishOnly: true,
    };
  }

  async createDraft(
    user: AuthenticatedUser,
    spaceId: string,
    input: DraftInput,
  ): Promise<PublicPost> {
    await this.access.assert(user.id, spaceId, 'public_site', 'create');
    const visibility = input.visibility;
    const audience = await this.validateAudience(spaceId, visibility, input.audienceSpaceIds);
    const slug = await this.uniqueSlug(input.slug ?? slugify(input.title));
    const inserted = await this.db.queryOne<{ id: string }>(
      `INSERT INTO public_posts
         (id, space_id, slug, language, title, excerpt, body, status, visibility,
          audience_space_ids, guest_shared, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10,$11)
       RETURNING id`,
      [
        newId('pub'),
        spaceId,
        slug,
        input.language,
        input.title,
        input.excerpt,
        input.body,
        visibility,
        JSON.stringify(audience),
        input.guestShared,
        user.id,
      ],
    );
    if (!inserted) throw new NotFoundException('public_post_not_created');
    const post = await this.getRow(spaceId, inserted.id);
    await this.saveVersion(post.id, input.title, input.excerpt, input.body, user.id);
    await this.record(user, spaceId, 'public_site.draft.create', post.id, {
      slug,
      language: input.language,
      visibility,
    });
    this.realtime.publish(spaceId, 'public_site', user.id, { action: 'draft.create', id: post.id });
    return toPublicPost(post);
  }

  async updateDraft(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    patch: UpdateInput,
  ): Promise<PublicPost> {
    await this.access.assert(user.id, spaceId, 'public_site', 'update');
    const existing = await this.getRow(spaceId, id);
    const visibility =
      patch.visibility ?? (existing.visibility as PublicationVisibility) ?? 'household';
    const audience = await this.validateAudience(
      spaceId,
      visibility,
      patch.audienceSpaceIds ?? parseJson<string[]>(existing.audience_space_ids, []),
    );
    const updated = await this.db.queryOne<{ id: string }>(
      `UPDATE public_posts SET
         slug = $2, language = $3, title = $4, excerpt = $5, body = $6,
         visibility = $7, audience_space_ids = $8, guest_shared = $9,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND space_id = $10 RETURNING id`,
      [
        id,
        patch.slug ?? existing.slug,
        patch.language ?? (existing.language as Language),
        patch.title ?? existing.title,
        patch.excerpt ?? existing.excerpt,
        patch.body ?? existing.body,
        visibility,
        JSON.stringify(audience),
        patch.guestShared ?? existing.guest_shared ?? false,
        spaceId,
      ],
    );
    if (!updated) throw new NotFoundException('public_post_not_found');
    const post = await this.getRow(spaceId, id);
    await this.saveVersion(id, post.title, post.excerpt, post.body, user.id);
    await this.record(user, spaceId, 'public_site.draft.update', id, {
      fields: Object.keys(patch),
      visibility,
    });
    this.realtime.publish(spaceId, 'public_site', user.id, { action: 'draft.update', id });
    return toPublicPost(post);
  }

  async preview(user: AuthenticatedUser, spaceId: string, id: string): Promise<PublicPost> {
    await this.access.assert(user.id, spaceId, 'public_site', 'read');
    return toPublicPost(await this.getRow(spaceId, id));
  }

  async publish(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    input: PublishInput,
  ): Promise<PublicPost> {
    await this.access.assert(user.id, spaceId, 'public_site', 'publish');
    const existing = await this.getRow(spaceId, id);
    const visibility =
      input.visibility ?? (existing.visibility as PublicationVisibility) ?? 'household';
    const audience = await this.validateAudience(
      spaceId,
      visibility,
      input.audienceSpaceIds ?? parseJson<string[]>(existing.audience_space_ids, []),
    );
    const guestShared = input.guestShared ?? existing.guest_shared ?? false;
    const updated = await this.db.queryOne<{ id: string }>(
      `UPDATE public_posts SET
         status = 'published', visibility = $2, audience_space_ids = $3,
         guest_shared = $4, published_by = $5, unpublished_at = NULL,
         published_at = CASE WHEN status = 'published' THEN published_at ELSE CURRENT_TIMESTAMP END,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND space_id = $6 RETURNING id`,
      [id, visibility, JSON.stringify(audience), guestShared, user.id, spaceId],
    );
    if (!updated) throw new NotFoundException('public_post_not_found');
    const post = await this.getRow(spaceId, id);
    await this.saveVersion(id, post.title, post.excerpt, post.body, user.id);
    await this.record(user, spaceId, 'public_site.publish', id, {
      slug: post.slug,
      language: post.language,
      visibility,
      guestShared,
      audienceCount: audience.length,
    });
    this.realtime.publish(spaceId, 'public_site', user.id, { action: 'publish', id, visibility });
    await this.notifyActor(user, spaceId, `Опубликовано: ${post.title}`);
    return toPublicPost(post);
  }

  async unpublish(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    input: UnpublishInput,
  ): Promise<PublicPost> {
    await this.access.assert(user.id, spaceId, 'public_site', 'publish');
    await this.getRow(spaceId, id);
    const updated = await this.db.queryOne<{ id: string }>(
      `UPDATE public_posts SET status = 'unpublished', unpublished_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND space_id = $2 RETURNING id`,
      [id, spaceId],
    );
    if (!updated) throw new NotFoundException('public_post_not_found');
    const post = await this.getRow(spaceId, id);
    await this.record(user, spaceId, 'public_site.unpublish', id, {
      slug: post.slug,
      reason: input.reason ?? null,
    });
    this.realtime.publish(spaceId, 'public_site', user.id, { action: 'unpublish', id });
    await this.notifyActor(user, spaceId, `Снято с публикации: ${post.title}`);
    return toPublicPost(post);
  }

  async shared(user: AuthenticatedUser, spaceId: string): Promise<PublicPost[]> {
    await this.access.assert(user.id, spaceId, 'public_site', 'read', { explicitlyShared: true });
    const rows = await this.db.query<PublicPostRow & { p_space_id: string }>(
      `SELECT p.*, p.space_id AS p_space_id, s.name AS space_name
       FROM public_posts p
       JOIN spaces s ON s.id = p.space_id
       JOIN memberships m ON m.space_id = p.space_id
       WHERE m.user_id = $1 AND p.status = 'published' AND p.guest_shared = TRUE
       ORDER BY p.published_at DESC LIMIT 50`,
      [user.id],
    );
    return rows
      .filter((row) => {
        const audience = parseJson<string[]>(row.audience_space_ids, []);
        return (
          row.visibility === 'public' || audience.includes(spaceId) || row.p_space_id === spaceId
        );
      })
      .map((row) => ({
        id: row.id,
        slug: row.slug,
        language: row.language,
        title: row.title,
        excerpt: row.excerpt,
        body: row.body,
        publishedAt: new Date(row.published_at).toISOString(),
        spaceName: row.space_name,
      }));
  }

  private async getRow(spaceId: string, id: string): Promise<PublicPostRow> {
    const row = await this.db.queryOne<PublicPostRow>(
      `SELECT p.*, s.name AS space_name FROM public_posts p
       JOIN spaces s ON s.id = p.space_id
       WHERE p.id = $1 AND p.space_id = $2`,
      [id, spaceId],
    );
    if (!row) throw new NotFoundException('public_post_not_found');
    return row;
  }

  private async uniqueSlug(base: string): Promise<string> {
    const normalized = slugify(base);
    const existing = await this.db.queryOne<{ id: string }>(
      'SELECT id FROM public_posts WHERE slug = $1',
      [normalized],
    );
    return existing ? `${normalized}-${Date.now().toString(36)}` : normalized;
  }

  private async validateAudience(
    spaceId: string,
    visibility: PublicationVisibility,
    requested: string[],
  ): Promise<string[]> {
    const rows = await this.db.query<{ id: string; network_id: string | null }>(
      'SELECT id, network_id FROM spaces',
    );
    const spaces = new Map(rows.map((row) => [row.id, row.network_id]));
    const sourceNetwork = spaces.get(spaceId);
    if (!spaces.has(spaceId)) throw new NotFoundException('space_not_found');
    if (visibility === 'household') {
      if (requested.length > 0 && (requested.length !== 1 || requested[0] !== spaceId)) {
        throw new BadRequestException('household_audience_must_be_current_space');
      }
      return [spaceId];
    }
    const ids = [...new Set(requested)];
    for (const id of ids) {
      const network = spaces.get(id);
      if (network === undefined) throw new BadRequestException('audience_space_not_found');
      if (network !== sourceNetwork && id !== spaceId) {
        throw new BadRequestException('cross_network_publication_denied');
      }
    }
    if (visibility === 'network' && ids.length === 0) {
      throw new BadRequestException('network_audience_required');
    }
    return ids;
  }

  private async saveVersion(
    postId: string,
    title: string,
    excerpt: string,
    body: string,
    userId: string,
  ) {
    const row = await this.db.queryOne<{ next: number | string }>(
      'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM public_post_versions WHERE post_id = $1',
      [postId],
    );
    await this.db.query(
      `INSERT INTO public_post_versions
         (id, post_id, version, title, excerpt, body, changed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [newId('ppv'), postId, Number(row?.next ?? 1), title, excerpt, body, userId],
    );
  }

  private async notifyActor(user: AuthenticatedUser, spaceId: string, title: string) {
    try {
      await this.notifications.notifyUser(user.id, {
        spaceId,
        category: 'public_site',
        severity: 'info',
        title,
        body: 'Публикация изменена явно; автоматической публикации внутренних данных нет.',
        sourceModule: 'public_site',
        actionUrl: '/publishing',
      });
    } catch {
      // The publisher may have disabled this category.
    }
  }

  private async record(
    user: AuthenticatedUser,
    spaceId: string,
    action: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ) {
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action,
      entity: 'public_post',
      entityId,
      metadata,
    });
  }
}
