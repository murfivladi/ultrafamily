import type {
  CalendarEvent,
  CalendarSummary,
  NotificationChannel,
  NotificationItem,
  NotificationPreferences,
  NotificationSeverity,
  RsvpStatus,
  ShoppingItem,
  ShoppingList,
  TaskItem,
  TaskPriority,
  TaskStatus,
} from '@ufos/contracts';
import { iso, parseJson } from '../db/rows';

export interface CalendarRow {
  id: string;
  space_id: string;
  name: string;
  kind: string;
  color: string;
  ctag: string;
}

export interface CalendarEventRow {
  id: string;
  calendar_id: string;
  space_id: string;
  uid: string;
  title: string;
  description: string;
  location: string;
  starts_at: Date | string;
  ends_at: Date | string;
  all_day: boolean;
  timezone: string;
  category: string;
  color: string;
  recurrence_rule: string | null;
  status: 'confirmed' | 'tentative' | 'cancelled';
  updated_at: Date | string;
  version: number | string;
  etag: string;
}

export interface CalendarParticipantRow {
  user_id: string;
  rsvp: RsvpStatus;
}

export interface CalendarLinkRow {
  target_module: string;
  target_id: string;
}

export interface TaskRow {
  id: string;
  list_id: string;
  space_id: string;
  parent_task_id: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  category: string;
  assignee_user_id: string | null;
  due_at: Date | string | null;
  estimate_minutes: number | string;
  complexity: number | string;
  recurrence_rule: string | null;
  position: number | string;
  subtask_count: number | string;
  dependency_count: number | string;
  version: number | string;
  updated_at: Date | string;
}

export interface NotificationRow {
  id: string;
  space_id: string | null;
  category: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  source_module: string;
  source_id: string | null;
  action_url: string | null;
  grouped_count: number | string;
  created_at: Date | string;
  read_at: Date | string | null;
  expires_at: Date | string | null;
}

export interface NotificationPreferencesRow {
  user_id: string;
  channels: unknown;
  quiet_hours: unknown;
  daily_digest: boolean;
  weekly_digest: boolean;
  urgent_override: boolean;
  categories: unknown;
}

export interface ShoppingListRow {
  id: string;
  space_id: string;
  name: string;
  kind: string;
  status: 'active' | 'archived';
  version: number | string;
  updated_at: Date | string;
}

export interface ShoppingItemRow {
  id: string;
  list_id: string;
  name: string;
  quantity: number | string;
  unit: string;
  category: string;
  checked: boolean;
  assigned_user_id: string | null;
  source_module: string | null;
  source_id: string | null;
  notes: string;
  position: number | string;
}

export interface ShoppingPresenceRow {
  user_id: string;
  status: string;
  last_seen_at: Date | string;
}

export function toCalendarSummary(row: CalendarRow): CalendarSummary {
  return {
    id: row.id,
    spaceId: row.space_id,
    name: row.name,
    kind: row.kind as CalendarSummary['kind'],
    color: row.color,
    ctag: row.ctag,
  };
}

export function toCalendarEvent(
  row: CalendarEventRow,
  participants: CalendarParticipantRow[] = [],
  links: CalendarLinkRow[] = [],
): CalendarEvent {
  return {
    id: row.id,
    calendarId: row.calendar_id,
    spaceId: row.space_id,
    uid: row.uid,
    title: row.title,
    description: row.description,
    location: row.location,
    startsAt: iso(row.starts_at) ?? new Date(0).toISOString(),
    endsAt: iso(row.ends_at) ?? new Date(0).toISOString(),
    allDay: row.all_day,
    timezone: row.timezone,
    category: row.category,
    color: row.color,
    recurrenceRule: row.recurrence_rule,
    status: row.status,
    participants: participants.map((participant) => ({
      userId: participant.user_id,
      rsvp: participant.rsvp,
    })),
    links: links.map((link) => ({ module: link.target_module, targetId: link.target_id })),
    etag: row.etag,
    version: Number(row.version ?? 1),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

export function toTaskItem(row: TaskRow): TaskItem {
  return {
    id: row.id,
    listId: row.list_id,
    spaceId: row.space_id,
    parentTaskId: row.parent_task_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    category: row.category,
    assigneeUserId: row.assignee_user_id,
    dueAt: iso(row.due_at),
    estimateMinutes: Number(row.estimate_minutes ?? 0),
    complexity: Number(row.complexity ?? 2),
    recurrenceRule: row.recurrence_rule,
    position: Number(row.position ?? 0),
    subtaskCount: Number(row.subtask_count ?? 0),
    dependencyCount: Number(row.dependency_count ?? 0),
    version: Number(row.version ?? 1),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

export function toNotificationItem(row: NotificationRow): NotificationItem {
  return {
    id: row.id,
    spaceId: row.space_id,
    category: row.category,
    severity: row.severity,
    title: row.title,
    body: row.body,
    sourceModule: row.source_module,
    sourceId: row.source_id,
    actionUrl: row.action_url,
    groupedCount: Number(row.grouped_count ?? 1),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    readAt: iso(row.read_at),
    expiresAt: iso(row.expires_at),
  };
}

export function toNotificationPreferences(
  row: NotificationPreferencesRow,
): NotificationPreferences {
  const quietHours = parseJson<NotificationPreferences['quietHours']>(row.quiet_hours, {
    enabled: false,
    from: '22:00',
    to: '07:00',
    timezone: 'Europe/Rome',
  });
  return {
    channels: parseJson<Record<string, NotificationChannel[]>>(row.channels, {
      default: ['in_app'],
      urgent: ['in_app', 'push', 'email'],
    }),
    quietHours,
    dailyDigest: row.daily_digest,
    weeklyDigest: row.weekly_digest,
    urgentOverride: row.urgent_override,
    categories: parseJson<Record<string, boolean>>(row.categories, {}),
  };
}

export function toShoppingItem(row: ShoppingItemRow): ShoppingItem {
  return {
    id: row.id,
    listId: row.list_id,
    name: row.name,
    quantity: Number(row.quantity ?? 1),
    unit: row.unit,
    category: row.category,
    checked: row.checked,
    assignedUserId: row.assigned_user_id,
    sourceModule: row.source_module,
    sourceId: row.source_id,
    notes: row.notes,
    position: Number(row.position ?? 0),
  };
}

export function toShoppingList(
  row: ShoppingListRow,
  items: ShoppingItemRow[],
  presence: ShoppingPresenceRow[],
): ShoppingList {
  return {
    id: row.id,
    spaceId: row.space_id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    version: Number(row.version ?? 1),
    items: items.map(toShoppingItem),
    presence: presence.map((entry) => ({
      userId: entry.user_id,
      status: entry.status,
      lastSeenAt: iso(entry.last_seen_at) ?? new Date(0).toISOString(),
    })),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
  };
}
