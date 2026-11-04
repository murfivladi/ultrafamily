import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  MODULE_IDS,
  type DashboardSnapshot,
  type FeedItem,
  type NotificationSeverity,
} from '@ufos/contracts';
import { SessionService } from '../auth/session.service';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../common/authed-request';
import { DatabaseService } from '../db/database.service';
import { toPreferences, toPublicPost, type PreferencesRow, type PublicPostRow } from '../db/rows';
import {
  toCalendarEvent,
  toNotificationItem,
  toShoppingList,
  toTaskItem,
  type CalendarEventRow,
  type NotificationRow,
  type ShoppingItemRow,
  type ShoppingListRow,
  type ShoppingPresenceRow,
  type TaskRow,
} from '../stage-b/mappers';

const DEFAULT_FEED_SOURCES = [
  'calendar',
  'tasks',
  'notifications',
  'shopping',
  'family',
  'security',
];

interface PresenceWithList extends ShoppingPresenceRow {
  list_id: string;
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  async snapshot(user: AuthenticatedUser, sessionId: string): Promise<DashboardSnapshot> {
    const space = await this.access.activeSpace(user.id);
    if (!space) throw new ForbiddenException('no_active_space');
    await this.access.assert(user.id, space.id, 'dashboard', 'read');

    const permissions = new Set(await this.access.permissionsForActiveSpace(user.id, space.id));
    const preferencesRow = await this.db.queryOne<PreferencesRow>(
      'SELECT * FROM user_preferences WHERE user_id = $1',
      [user.id],
    );
    const feedSources = preferencesRow
      ? toPreferences(preferencesRow).feedSources
      : DEFAULT_FEED_SOURCES;
    const sourceEnabled = (source: string, module?: string) =>
      feedSources.includes(source) && (!module || permissions.has(`${module}:read`));

    const [memberCount, enabledModules, recentAudit, recentSessions, posts] = await Promise.all([
      this.db.queryOne<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM memberships WHERE space_id = $1',
        [space.id],
      ),
      this.db.queryOne<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM module_toggles WHERE space_id = $1 AND enabled = TRUE',
        [space.id],
      ),
      this.audit.list(space.id, 8),
      this.sessions.list(user.id, sessionId),
      this.db.query<PublicPostRow>(
        `SELECT p.id, p.slug, p.language, p.title, p.excerpt, p.body,
                p.published_at, s.name AS space_name
         FROM public_posts p JOIN spaces s ON s.id = p.space_id
         WHERE p.space_id = $1 AND p.status = 'published' AND p.visibility = 'public'
           AND p.unpublished_at IS NULL AND p.published_at <= CURRENT_TIMESTAMP
         ORDER BY p.published_at DESC LIMIT 3`,
        [space.id],
      ),
    ]);

    const [eventRows, taskRows, notificationRows, listRows, itemRows, presenceRows] =
      await Promise.all([
        sourceEnabled('calendar', 'calendar')
          ? this.db.query<CalendarEventRow>(
              `SELECT * FROM calendar_events WHERE space_id = $1 AND status <> 'cancelled'
               AND starts_at BETWEEN CURRENT_TIMESTAMP AND CURRENT_TIMESTAMP + INTERVAL '14 days'
               ORDER BY starts_at ASC LIMIT 5`,
              [space.id],
            )
          : Promise.resolve([] as CalendarEventRow[]),
        sourceEnabled('tasks', 'tasks')
          ? this.db.query<TaskRow>(
              `SELECT t.*,
                 (SELECT COUNT(*)::int FROM tasks s WHERE s.parent_task_id = t.id) AS subtask_count,
                 (SELECT COUNT(*)::int FROM task_dependencies d WHERE d.task_id = t.id) AS dependency_count
               FROM tasks t WHERE t.space_id = $1 AND t.status NOT IN ('done','cancelled')
               ORDER BY COALESCE(t.due_at, '9999-12-31'::timestamptz) ASC, t.priority DESC
               LIMIT 5`,
              [space.id],
            )
          : Promise.resolve([] as TaskRow[]),
        sourceEnabled('notifications', 'notifications')
          ? this.db.query<NotificationRow>(
              `SELECT * FROM notifications WHERE user_id = $1 AND (space_id = $2 OR space_id IS NULL)
               AND read_at IS NULL AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
               ORDER BY created_at DESC LIMIT 5`,
              [user.id, space.id],
            )
          : Promise.resolve([] as NotificationRow[]),
        sourceEnabled('shopping', 'shopping')
          ? this.db.query<ShoppingListRow>(
              `SELECT id, space_id, name, kind, status, version, updated_at
               FROM shopping_lists WHERE space_id = $1 AND status = 'active'
               ORDER BY created_at ASC LIMIT 3`,
              [space.id],
            )
          : Promise.resolve([] as ShoppingListRow[]),
        sourceEnabled('shopping', 'shopping')
          ? this.db.query<ShoppingItemRow>(
              'SELECT * FROM shopping_items WHERE space_id = $1 ORDER BY position ASC LIMIT 100',
              [space.id],
            )
          : Promise.resolve([] as ShoppingItemRow[]),
        sourceEnabled('shopping', 'shopping')
          ? this.db.query<PresenceWithList>(
              `SELECT p.list_id, p.user_id, p.status, p.last_seen_at
               FROM shopping_presence p JOIN shopping_lists l ON l.id = p.list_id
               WHERE l.space_id = $1 AND p.last_seen_at > CURRENT_TIMESTAMP - INTERVAL '5 minutes'`,
              [space.id],
            )
          : Promise.resolve([] as PresenceWithList[]),
      ]);

    const events = eventRows.map((row) => toCalendarEvent(row, [], []));
    const tasks = taskRows.map(toTaskItem);
    const notifications = notificationRows.map(toNotificationItem);
    const shopping = listRows.map((row) =>
      toShoppingList(
        row,
        itemRows.filter((item) => item.list_id === row.id),
        presenceRows.filter((entry) => entry.list_id === row.id),
      ),
    );
    const publicPosts = posts.map(toPublicPost);
    const feed = this.buildFeed({
      feedSources,
      permissions,
      events,
      tasks,
      notifications,
      shopping,
      publicPosts,
      recentAudit,
    });

    return {
      generatedAt: new Date().toISOString(),
      activeSpaceName: space.name,
      memberCount: Number(memberCount?.count ?? 0),
      enabledModules: Number(enabledModules?.count ?? 0),
      totalModules: MODULE_IDS.length,
      recentAudit,
      recentSessions: recentSessions.slice(0, 4),
      publicPosts,
      feed,
      feedSources,
      events,
      tasks,
      notifications,
      shopping,
    };
  }

  private buildFeed(input: {
    feedSources: string[];
    permissions: Set<string>;
    events: DashboardSnapshot['events'];
    tasks: DashboardSnapshot['tasks'];
    notifications: DashboardSnapshot['notifications'];
    shopping: DashboardSnapshot['shopping'];
    publicPosts: DashboardSnapshot['publicPosts'];
    recentAudit: DashboardSnapshot['recentAudit'];
  }): FeedItem[] {
    const feed: FeedItem[] = [];
    const enabled = (source: string) => input.feedSources.includes(source);
    for (const event of input.events) {
      if (!enabled('calendar')) continue;
      const hours = (new Date(event.startsAt).getTime() - Date.now()) / 3_600_000;
      feed.push({
        id: `feed-calendar-${event.id}`,
        source: 'calendar',
        severity: hours <= 24 ? 'important' : 'info',
        title: event.title,
        detail: `${new Date(event.startsAt).toLocaleString('ru-RU', { timeZone: 'Europe/Rome' })}${event.location ? ` · ${event.location}` : ''}`,
        reason: hours <= 24 ? 'Событие в ближайшие сутки' : 'Ближайшее семейное событие',
        dueAt: event.startsAt,
        href: '/calendar',
      });
    }
    for (const task of input.tasks) {
      if (!enabled('tasks')) continue;
      const hours = task.dueAt
        ? (new Date(task.dueAt).getTime() - Date.now()) / 3_600_000
        : Infinity;
      const severity: NotificationSeverity =
        task.priority === 'urgent' || hours <= 24
          ? 'urgent'
          : task.priority === 'high' || hours <= 72
            ? 'important'
            : 'info';
      feed.push({
        id: `feed-task-${task.id}`,
        source: 'tasks',
        severity,
        title: task.title,
        detail: `${task.status} · приоритет ${task.priority}${task.estimateMinutes ? ` · ~${task.estimateMinutes} мин` : ''}`,
        reason:
          hours <= 24
            ? 'Срок задачи менее суток'
            : task.dependencyCount > 0
              ? 'Задача имеет зависимости'
              : 'Открытая задача в активном пространстве',
        dueAt: task.dueAt,
        href: '/tasks',
      });
    }
    for (const notification of input.notifications) {
      if (!enabled('notifications')) continue;
      feed.push({
        id: `feed-notification-${notification.id}`,
        source: 'notifications',
        severity: notification.severity,
        title: notification.title,
        detail: notification.body,
        reason:
          notification.groupedCount > 1
            ? 'Похожие уведомления сгруппированы'
            : 'Непрочитанное уведомление',
        dueAt: notification.createdAt,
        href: notification.actionUrl ?? '/notifications',
      });
    }
    for (const list of input.shopping) {
      if (!enabled('shopping')) continue;
      const open = list.items.filter((item) => !item.checked).length;
      feed.push({
        id: `feed-shopping-${list.id}`,
        source: 'shopping',
        severity: 'info',
        title: list.name,
        detail: `${open} неотмеченных позиций · ${list.presence.length} участников онлайн`,
        reason: 'Активный совместный список покупок',
        dueAt: null,
        href: '/shopping',
      });
    }
    if (enabled('family') && input.permissions.has('public_site:read')) {
      for (const post of input.publicPosts) {
        feed.push({
          id: `feed-family-${post.id}`,
          source: 'family',
          severity: 'info',
          title: post.title,
          detail: post.excerpt,
          reason: 'Явно опубликовано на семейном сайте',
          dueAt: post.publishedAt,
          href: `/p/${post.slug}`,
        });
      }
    }
    if (enabled('security')) {
      for (const event of input.recentAudit) {
        if (!/auth|session|permission|security|access/i.test(event.action)) continue;
        feed.push({
          id: `feed-security-${event.id}`,
          source: 'security',
          severity: 'info',
          title: 'Событие безопасности',
          detail: event.action,
          reason: 'Журнал аудита активного пространства',
          dueAt: event.createdAt,
          href: '/settings',
        });
      }
    }
    const rank: Record<NotificationSeverity, number> = { urgent: 3, important: 2, info: 1 };
    return feed
      .sort((left, right) => {
        const severity = rank[right.severity] - rank[left.severity];
        if (severity !== 0) return severity;
        return (left.dueAt ?? '9999').localeCompare(right.dueAt ?? '9999');
      })
      .slice(0, 12);
  }
}
