import { createHmac } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  NotificationChannel,
  NotificationItem,
  NotificationPreferences,
  NotificationSeverity,
} from '@ufos/contracts';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { newId, sha256 } from '../config';
import type { AuthenticatedUser } from '../common/authed-request';
import { DatabaseService } from '../db/database.service';
import { iso, parseJson } from '../db/rows';
import { RealtimeService } from '../realtime/realtime.service';
import {
  toNotificationItem,
  toNotificationPreferences,
  type NotificationPreferencesRow,
  type NotificationRow,
} from '../stage-b/mappers';

export interface NotifyInput {
  spaceId?: string | null;
  category: string;
  severity: NotificationSeverity;
  title: string;
  body?: string;
  sourceModule: string;
  sourceId?: string | null;
  actionUrl?: string | null;
  dedupeKey?: string | null;
  expiresAt?: string | null;
}

interface DeliveryRow {
  id: string;
  notification_id: string;
  channel: NotificationChannel;
  status: string;
  attempts: number | string;
  last_error: string | null;
  next_retry_at: Date | string | null;
  delivered_at: Date | string | null;
  created_at: Date | string;
  space_id: string | null;
  title: string;
  body: string;
  source_module: string;
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(
    user: AuthenticatedUser,
    filters: { spaceId?: string; unreadOnly?: boolean; limit?: number } = {},
  ): Promise<NotificationItem[]> {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    if (filters.spaceId) {
      await this.access.assert(user.id, filters.spaceId, 'notifications', 'read');
    }
    const conditions = ['user_id = $1', 'expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP'];
    const params: unknown[] = [user.id];
    if (filters.spaceId) {
      params.push(filters.spaceId);
      conditions.push(`space_id = $${params.length}`);
    }
    if (filters.unreadOnly) conditions.push('read_at IS NULL');
    params.push(limit);
    const rows = await this.db.query<NotificationRow>(
      `SELECT * FROM notifications WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(toNotificationItem);
  }

  async unreadCount(userId: string): Promise<number> {
    const row = await this.db.queryOne<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count FROM notifications
       WHERE user_id = $1 AND read_at IS NULL
         AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`,
      [userId],
    );
    return Number(row?.count ?? 0);
  }

  async markRead(userId: string, id: string): Promise<NotificationItem> {
    const row = await this.db.queryOne<NotificationRow>(
      'UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2 RETURNING *',
      [id, userId],
    );
    if (!row) throw new NotFoundException('notification_not_found');
    return toNotificationItem(row);
  }

  async markAllRead(userId: string, spaceId?: string): Promise<{ updated: number }> {
    const result = await this.db.query<{ id: string }>(
      `UPDATE notifications SET read_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND read_at IS NULL
         AND ($2::text IS NULL OR space_id = $2)
       RETURNING id`,
      [userId, spaceId ?? null],
    );
    return { updated: result.length };
  }

  async getPreferences(userId: string): Promise<NotificationPreferences> {
    let row = await this.db.queryOne<NotificationPreferencesRow>(
      'SELECT * FROM notification_preferences WHERE user_id = $1',
      [userId],
    );
    if (!row) {
      row = await this.db.queryOne<NotificationPreferencesRow>(
        'INSERT INTO notification_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING *',
        [userId],
      );
    }
    if (!row) throw new NotFoundException('notification_preferences_not_found');
    return toNotificationPreferences(row);
  }

  async updatePreferences(
    user: AuthenticatedUser,
    patch: Partial<NotificationPreferences>,
  ): Promise<NotificationPreferences> {
    const current = await this.getPreferences(user.id);
    const merged: NotificationPreferences = { ...current, ...patch };
    const row = await this.db.queryOne<NotificationPreferencesRow>(
      `INSERT INTO notification_preferences
         (user_id, channels, quiet_hours, daily_digest, weekly_digest, urgent_override, categories)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id) DO UPDATE SET
         channels = EXCLUDED.channels,
         quiet_hours = EXCLUDED.quiet_hours,
         daily_digest = EXCLUDED.daily_digest,
         weekly_digest = EXCLUDED.weekly_digest,
         urgent_override = EXCLUDED.urgent_override,
         categories = EXCLUDED.categories,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        user.id,
        JSON.stringify(merged.channels),
        JSON.stringify(merged.quietHours),
        merged.dailyDigest,
        merged.weeklyDigest,
        merged.urgentOverride,
        JSON.stringify(merged.categories),
      ],
    );
    if (!row) throw new NotFoundException('notification_preferences_not_found');
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'notification.preferences.update',
      entity: 'notification_preferences',
      entityId: user.id,
      metadata: { categories: Object.keys(merged.categories).length },
    });
    return toNotificationPreferences(row);
  }

  async test(user: AuthenticatedUser, severity: NotificationSeverity): Promise<NotificationItem> {
    return this.notifyUser(user.id, {
      category: 'test',
      severity,
      title: severity === 'urgent' ? 'Срочное тестовое уведомление' : 'Тестовое уведомление',
      body: 'Проверка центра уведомлений Ultra Family OS.',
      sourceModule: 'notifications',
      actionUrl: '/notifications',
    });
  }

  async subscribePush(user: AuthenticatedUser, endpoint: string, keys: Record<string, string>) {
    const row = await this.db.queryOne<{ id: string; endpoint: string; created_at: Date | string }>(
      `INSERT INTO web_push_subscriptions (id, user_id, endpoint, keys)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, keys = EXCLUDED.keys
       RETURNING id, endpoint, created_at`,
      [newId('push'), user.id, endpoint, JSON.stringify(keys)],
    );
    return {
      id: row?.id ?? null,
      endpoint: row?.endpoint ?? endpoint,
      createdAt: iso(row?.created_at),
    };
  }

  async deletePush(user: AuthenticatedUser, id: string): Promise<{ deleted: boolean }> {
    const row = await this.db.queryOne<{ id: string }>(
      'DELETE FROM web_push_subscriptions WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, user.id],
    );
    return { deleted: Boolean(row) };
  }

  async createWebhook(
    user: AuthenticatedUser,
    spaceId: string,
    input: {
      url: string;
      secret: string;
      events: string[];
      enabled: boolean;
    },
  ) {
    await this.access.assert(user.id, spaceId, 'notifications', 'manage_access');
    const row = await this.db.queryOne<{
      id: string;
      url: string;
      events: unknown;
      enabled: boolean;
    }>(
      `INSERT INTO webhook_endpoints (id, space_id, url, secret_hash, events, enabled)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, url, events, enabled`,
      [
        newId('hook'),
        spaceId,
        input.url,
        sha256(input.secret),
        JSON.stringify(input.events),
        input.enabled,
      ],
    );
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'notification.webhook.create',
      entity: 'webhook_endpoint',
      entityId: row?.id ?? null,
      metadata: { urlHost: safeHost(input.url), enabled: input.enabled },
    });
    return {
      id: row?.id ?? null,
      url: row?.url ?? input.url,
      events: parseJson<string[]>(row?.events, input.events),
      enabled: row?.enabled ?? input.enabled,
    };
  }

  async listWebhooks(user: AuthenticatedUser, spaceId: string) {
    await this.access.assert(user.id, spaceId, 'notifications', 'manage_access');
    const rows = await this.db.query<{
      id: string;
      url: string;
      events: unknown;
      enabled: boolean;
      created_at: Date | string;
    }>(
      'SELECT id, url, events, enabled, created_at FROM webhook_endpoints WHERE space_id = $1 ORDER BY created_at DESC',
      [spaceId],
    );
    return rows.map((row) => ({
      id: row.id,
      url: row.url,
      events: parseJson<string[]>(row.events, []),
      enabled: row.enabled,
      createdAt: iso(row.created_at),
    }));
  }

  async deliveryLog(user: AuthenticatedUser, spaceId?: string) {
    if (spaceId) await this.access.assert(user.id, spaceId, 'notifications', 'read');
    const rows = await this.db.query<DeliveryRow>(
      `SELECT d.*, n.space_id, n.title, n.body, n.source_module
       FROM notification_deliveries d
       JOIN notifications n ON n.id = d.notification_id
       WHERE n.user_id = $1 AND ($2::text IS NULL OR n.space_id = $2)
       ORDER BY d.created_at DESC LIMIT 100`,
      [user.id, spaceId ?? null],
    );
    return rows.map((row) => ({
      id: row.id,
      notificationId: row.notification_id,
      channel: row.channel,
      status: row.status,
      attempts: Number(row.attempts ?? 0),
      lastError: row.last_error,
      nextRetryAt: iso(row.next_retry_at),
      deliveredAt: iso(row.delivered_at),
      createdAt: iso(row.created_at),
      sourceModule: row.source_module,
    }));
  }

  async digest(user: AuthenticatedUser, period: 'daily' | 'weekly') {
    const interval = period === 'daily' ? '1 day' : '7 days';
    const rows = await this.db.query<NotificationRow>(
      `SELECT * FROM notifications
       WHERE user_id = $1 AND created_at > CURRENT_TIMESTAMP - $2::interval
         AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
       ORDER BY created_at DESC LIMIT 200`,
      [user.id, interval],
    );
    const grouped = new Map<string, { category: string; unread: number; latest: string }>();
    for (const row of rows) {
      const entry = grouped.get(row.category) ?? {
        category: row.category,
        unread: 0,
        latest: iso(row.created_at) ?? '',
      };
      if (!row.read_at) entry.unread += 1;
      grouped.set(row.category, entry);
    }
    return { period, generatedAt: new Date().toISOString(), groups: [...grouped.values()] };
  }

  async dispatch(
    user: AuthenticatedUser,
  ): Promise<{ processed: number; delivered: number; skipped: number }> {
    const rows = await this.db.query<DeliveryRow>(
      `SELECT d.*, n.space_id, n.title, n.body, n.source_module
       FROM notification_deliveries d
       JOIN notifications n ON n.id = d.notification_id
       WHERE n.user_id = $1 AND d.status IN ('pending','deferred','retry')
         AND (d.next_retry_at IS NULL OR d.next_retry_at <= CURRENT_TIMESTAMP)
       ORDER BY d.created_at ASC LIMIT 50`,
      [user.id],
    );
    let delivered = 0;
    let skipped = 0;
    for (const row of rows) {
      if (row.channel === 'in_app') {
        await this.db.query(
          `UPDATE notification_deliveries SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP,
             attempts = attempts + 1 WHERE id = $1`,
          [row.id],
        );
        delivered += 1;
        continue;
      }
      if (row.channel === 'webhook') {
        const sent = await this.sendWebhook(user.id, row);
        if (sent) {
          delivered += 1;
          continue;
        }
      }
      await this.db.query(
        `UPDATE notification_deliveries SET status = 'skipped', attempts = attempts + 1,
           last_error = CASE WHEN $2::text = 'webhook' THEN 'no_matching_endpoint' ELSE 'adapter_not_configured' END
         WHERE id = $1`,
        [row.id, row.channel],
      );
      skipped += 1;
    }
    return { processed: rows.length, delivered, skipped };
  }

  async reminderSweep(user: AuthenticatedUser, spaceId: string) {
    await this.access.assert(user.id, spaceId, 'notifications', 'create');
    const events = await this.db.query<{
      id: string;
      title: string;
      starts_at: Date | string;
      user_id: string;
    }>(
      `SELECT e.id, e.title, e.starts_at, p.user_id
       FROM calendar_events e
       JOIN calendar_event_participants p ON p.event_id = e.id
       WHERE e.space_id = $1 AND e.status <> 'cancelled'
         AND e.starts_at BETWEEN CURRENT_TIMESTAMP AND CURRENT_TIMESTAMP + INTERVAL '24 hours'`,
      [spaceId],
    );
    const tasks = await this.db.query<{
      id: string;
      title: string;
      due_at: Date | string;
      assignee_user_id: string;
    }>(
      `SELECT id, title, due_at, assignee_user_id FROM tasks
       WHERE space_id = $1 AND status NOT IN ('done','cancelled') AND assignee_user_id IS NOT NULL
         AND due_at BETWEEN CURRENT_TIMESTAMP AND CURRENT_TIMESTAMP + INTERVAL '24 hours'`,
      [spaceId],
    );
    for (const event of events) {
      await this.notifyUser(event.user_id, {
        spaceId,
        category: 'calendar',
        severity: 'important',
        title: `Скоро: ${event.title}`,
        body: 'Событие начинается в течение суток.',
        sourceModule: 'calendar',
        sourceId: event.id,
        actionUrl: '/calendar',
        dedupeKey: `calendar:${event.id}:${event.user_id}`,
      });
    }
    for (const task of tasks) {
      await this.notifyUser(task.assignee_user_id, {
        spaceId,
        category: 'tasks',
        severity: 'important',
        title: `Срок задачи: ${task.title}`,
        body: 'Задача должна быть выполнена в течение суток.',
        sourceModule: 'tasks',
        sourceId: task.id,
        actionUrl: '/tasks',
        dedupeKey: `task:${task.id}:${task.assignee_user_id}:${iso(task.due_at)}`,
      });
    }
    return { events: events.length, tasks: tasks.length };
  }

  async notifyUser(userId: string, input: NotifyInput): Promise<NotificationItem> {
    const preferences = await this.getPreferences(userId);
    if (preferences.categories[input.category] === false) {
      throw new BadRequestException('notification_category_disabled');
    }
    const channels = this.channelsFor(preferences, input.category, input.severity);
    const quiet = this.isQuiet(preferences, input.severity);
    const dedupeKey = input.dedupeKey ? `${input.dedupeKey}:${userId}` : null;
    const existing = dedupeKey
      ? await this.db.queryOne<NotificationRow>(
          `SELECT * FROM notifications
           WHERE user_id = $1 AND dedupe_key = $2 AND read_at IS NULL LIMIT 1`,
          [userId, dedupeKey],
        )
      : null;
    let row: NotificationRow | null;
    if (existing) {
      row = await this.db.queryOne<NotificationRow>(
        `UPDATE notifications SET grouped_count = grouped_count + 1,
           title = $2, body = $3, created_at = CURRENT_TIMESTAMP
         WHERE id = $1 RETURNING *`,
        [existing.id, input.title, input.body ?? ''],
      );
    } else {
      row = await this.db.queryOne<NotificationRow>(
        `INSERT INTO notifications
           (id, user_id, space_id, category, severity, title, body, source_module,
            source_id, action_url, dedupe_key, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          newId('ntf'),
          userId,
          input.spaceId ?? null,
          input.category,
          input.severity,
          input.title,
          input.body ?? '',
          input.sourceModule,
          input.sourceId ?? null,
          input.actionUrl ?? null,
          dedupeKey,
          input.expiresAt ?? null,
        ],
      );
    }
    if (!row) throw new NotFoundException('notification_not_created');
    for (const channel of channels) {
      const status = channel === 'in_app' ? 'delivered' : quiet ? 'deferred' : 'pending';
      await this.db.query(
        `INSERT INTO notification_deliveries
           (id, notification_id, channel, status, delivered_at, next_retry_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          newId('dlv'),
          row.id,
          channel,
          status,
          status === 'delivered' ? new Date().toISOString() : null,
          quiet ? this.quietEnd(preferences) : null,
        ],
      );
    }
    if (input.spaceId) {
      this.realtime.publish(input.spaceId, 'notifications', null, {
        notificationId: row.id,
        userId,
        severity: input.severity,
        title: input.title,
      });
    }
    return toNotificationItem(row);
  }

  async notifySpaceMembers(spaceId: string, input: Omit<NotifyInput, 'spaceId'>) {
    const members = await this.db.query<{ user_id: string }>(
      'SELECT user_id FROM memberships WHERE space_id = $1',
      [spaceId],
    );
    const results: NotificationItem[] = [];
    for (const member of members) {
      try {
        results.push(await this.notifyUser(member.user_id, { ...input, spaceId }));
      } catch {
        // A user may have disabled the category; other members still receive it.
      }
    }
    this.realtime.publish(spaceId, 'notifications', null, {
      category: input.category,
      recipients: results.length,
    });
    return results;
  }

  private channelsFor(
    preferences: NotificationPreferences,
    category: string,
    severity: NotificationSeverity,
  ): NotificationChannel[] {
    const configured = preferences.channels[category] ??
      preferences.channels[severity] ??
      preferences.channels.default ?? ['in_app'];
    const channels = new Set<NotificationChannel>(configured);
    channels.add('in_app');
    if (severity === 'urgent' && preferences.urgentOverride) {
      for (const channel of preferences.channels.urgent ?? ['push', 'email']) channels.add(channel);
    }
    return [...channels];
  }

  private isQuiet(preferences: NotificationPreferences, severity: NotificationSeverity): boolean {
    const quiet = preferences.quietHours;
    if (!quiet.enabled) return false;
    if (severity === 'urgent' && preferences.urgentOverride) return false;
    const now = this.minutesInTimezone(new Date(), quiet.timezone);
    const from = minutes(quiet.from);
    const to = minutes(quiet.to);
    return from === to ? true : from < to ? now >= from && now < to : now >= from || now < to;
  }

  private quietEnd(preferences: NotificationPreferences): string {
    const quiet = preferences.quietHours;
    const now = new Date();
    const current = this.minutesInTimezone(now, quiet.timezone);
    const to = minutes(quiet.to);
    const delta = (to - current + 1440) % 1440 || 1440;
    return new Date(now.getTime() + delta * 60_000).toISOString();
  }

  private minutesInTimezone(date: Date, timezone: string): number {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(date);
      const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
      const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
      return hour * 60 + minute;
    } catch {
      return date.getUTCHours() * 60 + date.getUTCMinutes();
    }
  }

  private async sendWebhook(userId: string, row: DeliveryRow): Promise<boolean> {
    const endpoints = await this.db.query<{
      id: string;
      url: string;
      secret_hash: string;
      events: unknown;
      enabled: boolean;
    }>(
      `SELECT id, url, secret_hash, events, enabled FROM webhook_endpoints
       WHERE space_id = $1 AND enabled = TRUE`,
      [row.space_id],
    );
    const endpoint = endpoints.find((candidate) => {
      const events = parseJson<string[]>(candidate.events, []);
      return events.length === 0 || events.includes(row.source_module) || events.includes('*');
    });
    if (!endpoint) return false;
    const payload = JSON.stringify({
      notificationId: row.notification_id,
      title: row.title,
      body: row.body,
      sourceModule: row.source_module,
      deliveredAt: new Date().toISOString(),
    });
    const signature = createHmac('sha256', endpoint.secret_hash).update(payload).digest('hex');
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ufos-signature': signature,
          'x-ufos-user': userId,
        },
        body: payload,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      await this.db.query(
        `UPDATE notification_deliveries SET status = $2, attempts = attempts + 1,
           delivered_at = CASE WHEN $2 = 'delivered' THEN CURRENT_TIMESTAMP ELSE NULL END,
           last_error = CASE WHEN $2 = 'delivered' THEN NULL ELSE 'webhook_http_error' END
         WHERE id = $1`,
        [row.id, response.ok ? 'delivered' : 'retry'],
      );
      return response.ok;
    } catch {
      await this.db.query(
        `UPDATE notification_deliveries SET status = 'retry', attempts = attempts + 1,
           next_retry_at = CURRENT_TIMESTAMP + INTERVAL '5 minutes',
           last_error = 'webhook_unreachable'
         WHERE id = $1`,
        [row.id],
      );
      return false;
    }
  }
}

function minutes(value: string): number {
  const [hour = '0', minute = '0'] = value.split(':');
  return Number(hour) * 60 + Number(minute);
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid';
  }
}
