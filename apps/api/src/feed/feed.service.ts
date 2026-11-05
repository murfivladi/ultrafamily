import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { FeedPost } from '@ufos/contracts';
import type { z } from 'zod';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { newId } from '../config';
import type { AuthenticatedUser } from '../common/authed-request';
import { DatabaseService } from '../db/database.service';
import { iso, parseJson } from '../db/rows';
import { escapeLike } from '../common/like';
import { RealtimeService } from '../realtime/realtime.service';
import {
  toFeedPost,
  type ChatReactionRow,
  type FeedCommentRow,
  type FeedPostRow,
} from '../stage-c/mappers';
import type { autoEventSchema, feedPostSchema, feedQuerySchema, feedUpdateSchema } from './dto';

type PostInput = z.infer<typeof feedPostSchema>;
type PostPatch = z.infer<typeof feedUpdateSchema>;
type FeedQuery = z.infer<typeof feedQuerySchema>;
type AutoEventInput = z.infer<typeof autoEventSchema>;

const POST_SELECT = `
  SELECT p.*, u.display_name AS author_name, u.avatar_color AS author_avatar_color,
    (SELECT COUNT(*)::int FROM feed_comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL)
      AS comment_count
  FROM feed_posts p
  LEFT JOIN users u ON u.id = p.author_user_id
`;

@Injectable()
export class FeedService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(user: AuthenticatedUser, spaceId: string, query: FeedQuery): Promise<FeedPost[]> {
    await this.access.assert(user.id, spaceId, 'feed', 'read');
    const conditions = [
      'p.deleted_at IS NULL',
      "(p.space_id = $1 OR (p.visibility = 'network' AND $2::text IS NOT NULL AND p.audience_space_ids @> to_jsonb(ARRAY[$2::text])))",
      'p.published_at <= CURRENT_TIMESTAMP',
    ];
    const params: unknown[] = [spaceId, await this.networkScopeId(spaceId)];
    if (query.before) {
      params.push(query.before);
      conditions.push(`p.published_at < $${params.length}`);
    }
    if (query.kind) {
      params.push(query.kind);
      conditions.push(`p.kind = $${params.length}`);
    }
    if (query.q) {
      params.push(`%${escapeLike(query.q)}%`);
      conditions.push(`(p.title ILIKE $${params.length} OR p.body ILIKE $${params.length})`);
    }
    if (query.tag) {
      params.push(JSON.stringify([query.tag]));
      conditions.push(`p.tags @> $${params.length}::jsonb`);
    }
    params.push(query.limit);
    const rows = await this.db.query<FeedPostRow>(
      `${POST_SELECT} WHERE ${conditions.join(' AND ')}
       ORDER BY p.pinned DESC, p.published_at DESC LIMIT $${params.length}`,
      params,
    );
    return this.hydrate(rows);
  }

  async get(user: AuthenticatedUser, spaceId: string, id: string): Promise<FeedPost> {
    await this.access.assert(user.id, spaceId, 'feed', 'read');
    const row = await this.requirePost(spaceId, id);
    const [post] = await this.hydrate([row]);
    if (!post) throw new NotFoundException('feed_post_not_found');
    return post;
  }

  async create(user: AuthenticatedUser, spaceId: string, input: PostInput): Promise<FeedPost> {
    await this.access.assert(user.id, spaceId, 'feed', 'create');
    if (input.visibility === 'network') {
      await this.access.assert(user.id, spaceId, 'feed', 'publish');
      const networkId = await this.networkScopeId(spaceId);
      if (!networkId) throw new ForbiddenException('space_has_no_family_network');
      if (
        input.audienceSpaceIds.length > 0 &&
        !input.audienceSpaceIds.includes(networkId)
      ) {
        throw new ForbiddenException('network_audience_must_include_family_network');
      }
    }
    const row = await this.db.queryOne<FeedPostRow>(
      `INSERT INTO feed_posts
        (id, space_id, kind, title, body, visibility, audience_space_ids, tags, media, pinned,
         author_user_id, published_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        newId('fpo'),
        spaceId,
        input.kind,
        input.title,
        input.body,
        input.visibility,
        JSON.stringify(input.audienceSpaceIds),
        JSON.stringify(input.tags),
        JSON.stringify(input.media),
        input.pinned,
        user.id,
        input.publishedAt ?? new Date().toISOString(),
      ],
    );
    if (!row) throw new NotFoundException('feed_post_not_created');
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'feed.post.create',
      entity: 'feed_post',
      entityId: row.id,
      metadata: { kind: input.kind, visibility: input.visibility },
    });
    this.realtime.publish(spaceId, 'feed', user.id, { action: 'post.create', postId: row.id });
    return this.withAuthor(row, user);
  }

  async update(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    patch: PostPatch,
  ): Promise<FeedPost> {
    await this.access.assert(user.id, spaceId, 'feed', 'update');
    const existing = await this.requirePost(spaceId, id);
    const canModerate = await this.access
      .assert(user.id, spaceId, 'feed', 'publish')
      .then(() => true)
      .catch(() => false);
    if (existing.author_user_id !== user.id && !canModerate) {
      throw new ForbiddenException('feed_post_author_or_moderator_required');
    }
    const fields: string[] = [];
    const params: unknown[] = [id];
    const push = (column: string, value: unknown) => {
      params.push(value);
      fields.push(`${column} = $${params.length}`);
    };
    if (patch.kind !== undefined) push('kind', patch.kind);
    if (patch.title !== undefined) push('title', patch.title);
    if (patch.body !== undefined) push('body', patch.body);
    if (patch.visibility !== undefined) {
      if (patch.visibility === 'network') await this.access.assert(user.id, spaceId, 'feed', 'publish');
      push('visibility', patch.visibility);
    }
    if (patch.audienceSpaceIds !== undefined) {
      push('audience_space_ids', JSON.stringify(patch.audienceSpaceIds));
    }
    if (patch.tags !== undefined) push('tags', JSON.stringify(patch.tags));
    if (patch.media !== undefined) push('media', JSON.stringify(patch.media));
    if (patch.pinned !== undefined) {
      if (!canModerate) throw new ForbiddenException('feed_pin_requires_moderator');
      push('pinned', patch.pinned);
    }
    if (fields.length === 0) return this.get(user, spaceId, id);
    await this.db.query(
      `UPDATE feed_posts SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      params,
    );
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'feed.post.update',
      entity: 'feed_post',
      entityId: id,
      metadata: { fields: Object.keys(patch) },
    });
    this.realtime.publish(spaceId, 'feed', user.id, { action: 'post.update', postId: id });
    return this.get(user, spaceId, id);
  }

  async remove(user: AuthenticatedUser, spaceId: string, id: string) {
    await this.access.assert(user.id, spaceId, 'feed', 'delete');
    const existing = await this.requirePost(spaceId, id);
    const canModerate = await this.access
      .assert(user.id, spaceId, 'feed', 'publish')
      .then(() => true)
      .catch(() => false);
    if (existing.author_user_id !== user.id && !canModerate) {
      throw new ForbiddenException('feed_post_author_or_moderator_required');
    }
    await this.db.query(
      `UPDATE feed_posts SET deleted_at = CURRENT_TIMESTAMP, deleted_by = $2
       WHERE id = $1`,
      [id, user.id],
    );
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'feed.post.delete',
      entity: 'feed_post',
      entityId: id,
      metadata: { autoEvent: Boolean(existing.auto_event_key) },
    });
    this.realtime.publish(spaceId, 'feed', user.id, { action: 'post.delete', postId: id });
    return { deleted: true };
  }

  async comment(user: AuthenticatedUser, spaceId: string, id: string, body: string) {
    await this.access.assert(user.id, spaceId, 'feed', 'create');
    const post = await this.requirePost(spaceId, id);
    if (post.deleted_at) throw new NotFoundException('feed_post_not_found');
    const row = await this.db.queryOne<FeedCommentRow>(
      `INSERT INTO feed_comments (id, post_id, space_id, author_user_id, body)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [newId('fcm'), id, post.space_id, user.id, body],
    );
    this.realtime.publish(spaceId, 'feed', user.id, { action: 'post.comment', postId: id });
    return {
      id: row?.id ?? null,
      authorUserId: user.id,
      authorName: user.displayName,
      authorAvatarColor: user.avatarColor,
      body,
      createdAt: iso(row?.created_at ?? null),
    };
  }

  async react(user: AuthenticatedUser, spaceId: string, id: string, emoji: string) {
    await this.access.assert(user.id, spaceId, 'feed', 'read');
    await this.requirePost(spaceId, id);
    const existing = await this.db.queryOne<{ emoji: string }>(
      'SELECT emoji FROM feed_reactions WHERE post_id = $1 AND user_id = $2 AND emoji = $3',
      [id, user.id, emoji],
    );
    if (existing) {
      await this.db.query(
        'DELETE FROM feed_reactions WHERE post_id = $1 AND user_id = $2 AND emoji = $3',
        [id, user.id, emoji],
      );
    } else {
      await this.db.query(
        'INSERT INTO feed_reactions (post_id, user_id, emoji) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [id, user.id, emoji],
      );
    }
    this.realtime.publish(spaceId, 'feed', user.id, { action: 'post.reaction', postId: id });
    return { active: !existing };
  }

  async autoEvents(user: AuthenticatedUser, spaceId: string, input: AutoEventInput) {
    // Automatic entries are generated from real modules only: calendar events
    // (birthdays / plans) and explicit photos. Nothing is invented and nothing
    // private is pushed into the feed without a source record.
    await this.access.assert(user.id, spaceId, 'feed', 'create');
    const created: string[] = [];
    const kinds = new Set(input.kinds);

    if (kinds.has('birthdays') || kinds.has('plans')) {
      const events = await this.db.query<{
        id: string;
        title: string;
        description: string;
        starts_at: Date | string;
        category: string;
      }>(
        `SELECT id, title, description, starts_at, category FROM calendar_events
         WHERE space_id = $1 AND status <> 'cancelled'
           AND starts_at BETWEEN CURRENT_TIMESTAMP AND CURRENT_TIMESTAMP + INTERVAL '14 days'
         ORDER BY starts_at ASC LIMIT 20`,
        [spaceId],
      );
      for (const event of events) {
        const isBirthday = /compleann|birthday|день рожд/i.test(
          `${event.title} ${event.category}`,
        );
        if (isBirthday && !kinds.has('birthdays')) continue;
        if (!isBirthday && !kinds.has('plans')) continue;
        const key = `calendar:${event.id}`;
        const id = await this.upsertAutoPost(user, spaceId, key, {
          kind: 'system',
          title: event.title,
          body: event.description,
          publishedAt: iso(event.starts_at),
        });
        if (id) created.push(id);
      }
    }

    if (kinds.has('announcements')) {
      const posts = await this.db.query<{ id: string; title: string; body: string }>(
        `SELECT id, title, body FROM public_posts
         WHERE space_id = $1 AND status = 'published' AND unpublished_at IS NULL
           AND published_at > CURRENT_TIMESTAMP - INTERVAL '30 days'
         ORDER BY published_at DESC LIMIT 10`,
        [spaceId],
      );
      for (const post of posts) {
        const key = `publishing:${post.id}`;
        const id = await this.upsertAutoPost(user, spaceId, key, {
          kind: 'system',
          title: post.title,
          body: post.body.slice(0, 400),
          publishedAt: null,
        });
        if (id) created.push(id);
      }
    }

    if (created.length > 0) {
      this.realtime.publish(spaceId, 'feed', user.id, {
        action: 'post.auto',
        count: created.length,
      });
    }
    return { generated: created.length, kinds: [...kinds] };
  }

  async eventSources(user: AuthenticatedUser, spaceId: string) {
    await this.access.assert(user.id, spaceId, 'feed', 'read');
    const row = await this.db.queryOne<{ feed_event_sources: unknown }>(
      'SELECT feed_event_sources FROM user_preferences WHERE user_id = $1',
      [user.id],
    );
    return {
      sources: parseJson<string[]>(row?.feed_event_sources, [
        'birthdays',
        'plans',
        'photos',
        'announcements',
      ]),
    };
  }

  async setEventSources(user: AuthenticatedUser, spaceId: string, sources: string[]) {
    await this.access.assert(user.id, spaceId, 'feed', 'read');
    await this.db.query(
      `INSERT INTO user_preferences (user_id, feed_event_sources)
       VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET feed_event_sources = EXCLUDED.feed_event_sources`,
      [user.id, JSON.stringify(sources)],
    );
    return { sources };
  }

  private async upsertAutoPost(
    user: AuthenticatedUser,
    spaceId: string,
    key: string,
    input: { kind: 'system'; title: string; body: string; publishedAt: string | null },
  ): Promise<string | null> {
    const existing = await this.db.queryOne<{ id: string }>(
      'SELECT id FROM feed_posts WHERE space_id = $1 AND auto_event_key = $2',
      [spaceId, key],
    );
    if (existing) return null;
    const row = await this.db.queryOne<{ id: string }>(
      `INSERT INTO feed_posts
        (id, space_id, kind, title, body, visibility, audience_space_ids, tags, media,
         auto_event_key, author_user_id, published_at)
       VALUES ($1,$2,$3,$4,$5,'household','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,$6,$7,$8)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        newId('fpo'),
        spaceId,
        input.kind,
        input.title.slice(0, 200),
        input.body.slice(0, 2000),
        key,
        user.id,
        input.publishedAt ?? new Date().toISOString(),
      ],
    );
    return row?.id ?? null;
  }

  private async withAuthor(row: FeedPostRow, user: AuthenticatedUser): Promise<FeedPost> {
    return toFeedPost(
      { ...row, author_name: user.displayName, author_avatar_color: user.avatarColor },
      [],
      [],
    );
  }

  private async hydrate(rows: FeedPostRow[]): Promise<FeedPost[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map((_, index) => `$${index + 1}`).join(',');
    const [comments, reactions] = await Promise.all([
      this.db.query<FeedCommentRow>(
        `SELECT c.*, u.display_name AS author_name, u.avatar_color AS author_avatar_color
         FROM feed_comments c LEFT JOIN users u ON u.id = c.author_user_id
         WHERE c.post_id IN (${placeholders}) ORDER BY c.created_at ASC`,
        ids,
      ),
      this.db.query<{ post_id: string; emoji: string; user_id: string }>(
        `SELECT post_id, emoji, user_id FROM feed_reactions WHERE post_id IN (${placeholders})`,
        ids,
      ),
    ]);
    return rows.map((row) =>
      toFeedPost(
        row,
        comments.filter((comment) => comment.post_id === row.id),
        reactions
          .filter((reaction) => reaction.post_id === row.id)
          .map((reaction) => ({
            message_id: reaction.post_id,
            emoji: reaction.emoji,
            user_id: reaction.user_id,
          })),
      ),
    );
  }

  private async requirePost(spaceId: string, id: string): Promise<FeedPostRow> {
    const row = await this.db.queryOne<FeedPostRow>(
      `${POST_SELECT} WHERE p.id = $1 AND (p.space_id = $2 OR p.visibility = 'network')`,
      [id, spaceId],
    );
    if (!row) throw new NotFoundException('feed_post_not_found');
    return row;
  }

  private async networkScopeId(spaceId: string): Promise<string | null> {
    const row = await this.db.queryOne<{ scope_id: string | null }>(
      `SELECT CASE
         WHEN kind = 'family_network' THEN id
         WHEN network_id IS NOT NULL THEN network_id
         ELSE (SELECT id FROM spaces WHERE kind = 'family_network' LIMIT 1)
       END AS scope_id
       FROM spaces WHERE id = $1`,
      [spaceId],
    );
    return row?.scope_id ?? null;
  }
}
