import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { CalendarEvent, CalendarSummary, RsvpStatus } from '@ufos/contracts';
import type { z } from 'zod';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { newId, randomToken, sha256 } from '../config';
import type { AuthenticatedUser } from '../common/authed-request';
import { DatabaseService } from '../db/database.service';
import { iso } from '../db/rows';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  toCalendarEvent,
  toCalendarSummary,
  type CalendarEventRow,
  type CalendarLinkRow,
  type CalendarParticipantRow,
  type CalendarRow,
} from '../stage-b/mappers';
import type {
  calendarSchema,
  eventSchema,
  exceptionSchema,
  suggestTimeSchema,
  updateEventSchema,
} from './dto';
import { IcsService, type IcsEventInput } from './ics.service';

type CalendarInput = z.infer<typeof calendarSchema>;
type EventInput = z.infer<typeof eventSchema>;
type EventPatch = z.infer<typeof updateEventSchema>;
type ExceptionInput = z.infer<typeof exceptionSchema>;
type SuggestInput = z.infer<typeof suggestTimeSchema>;

interface ExceptionRow {
  occurrence_start: Date | string;
  action: string;
  override_starts_at: Date | string | null;
  override_ends_at: Date | string | null;
  override_title: string | null;
}

interface DateRange {
  from: Date;
  to: Date;
}

@Injectable()
export class CalendarService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
    private readonly ics: IcsService,
  ) {}

  async calendars(user: AuthenticatedUser, spaceId: string): Promise<CalendarSummary[]> {
    await this.access.assert(user.id, spaceId, 'calendar', 'read');
    const rows = await this.db.query<CalendarRow>(
      'SELECT id, space_id, name, kind, color, ctag FROM calendars WHERE space_id = $1 ORDER BY name ASC',
      [spaceId],
    );
    return rows.map(toCalendarSummary);
  }

  async createCalendar(user: AuthenticatedUser, spaceId: string, input: CalendarInput) {
    await this.access.assert(user.id, spaceId, 'calendar', 'create');
    const row = await this.db.queryOne<CalendarRow>(
      `INSERT INTO calendars (id, space_id, owner_user_id, name, kind, color, visibility, ctag)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'1') RETURNING id, space_id, name, kind, color, ctag`,
      [newId('cal'), spaceId, user.id, input.name, input.kind, input.color, input.visibility],
    );
    if (!row) throw new NotFoundException('calendar_not_created');
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'calendar.create',
      entity: 'calendar',
      entityId: row.id,
      metadata: { name: input.name, kind: input.kind },
    });
    this.realtime.publish(spaceId, 'calendar', user.id, { action: 'calendar.create', id: row.id });
    return toCalendarSummary(row);
  }

  async events(
    user: AuthenticatedUser,
    spaceId: string,
    query: { from?: string; to?: string; view?: string; calendarId?: string } = {},
  ): Promise<CalendarEvent[]> {
    await this.access.assert(user.id, spaceId, 'calendar', 'read');
    const range = this.range(query.view ?? 'month', query.from, query.to);
    return this.loadEvents(spaceId, range, query.calendarId);
  }

  async event(user: AuthenticatedUser, spaceId: string, id: string): Promise<CalendarEvent> {
    await this.access.assert(user.id, spaceId, 'calendar', 'read');
    const row = await this.db.queryOne<CalendarEventRow>(
      'SELECT * FROM calendar_events WHERE id = $1 AND space_id = $2',
      [id, spaceId],
    );
    if (!row) throw new NotFoundException('event_not_found');
    return this.mapEvent(row);
  }

  async createEvent(
    user: AuthenticatedUser,
    spaceId: string,
    input: EventInput,
  ): Promise<CalendarEvent> {
    await this.access.assert(user.id, spaceId, 'calendar', 'create');
    const calendar = await this.resolveCalendar(spaceId, input.calendarId, user.id);
    this.validateRange(input.startsAt, input.endsAt, input.allDay);
    const uid = `${newId('evt')}@ultra.family`;
    const etag = sha256(`${uid}:1:${Date.now()}`);
    const row = await this.db.queryOne<CalendarEventRow>(
      `INSERT INTO calendar_events
         (id, calendar_id, space_id, uid, title, description, location, starts_at, ends_at,
          all_day, timezone, category, color, recurrence_rule, status, created_by, etag, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'api')
       RETURNING *`,
      [
        newId('evt'),
        calendar.id,
        spaceId,
        uid,
        input.title,
        input.description,
        input.location,
        input.startsAt,
        input.endsAt,
        input.allDay,
        input.timezone,
        input.category,
        input.color,
        input.recurrenceRule,
        input.status,
        user.id,
        etag,
      ],
    );
    if (!row) throw new NotFoundException('event_not_created');
    const participants = await this.spaceMembers(spaceId, input.participantIds);
    await this.replaceParticipants(row.id, participants);
    await this.replaceLinks(row.id, input.links);
    await this.touchCalendar(calendar.id);
    await this.history(user.id, row.id, 'create', {}, await this.snapshot(row));
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'calendar.event.create',
      entity: 'calendar_event',
      entityId: row.id,
      metadata: {
        title: input.title,
        startsAt: input.startsAt,
        recurring: Boolean(input.recurrenceRule),
      },
    });
    this.realtime.publish(spaceId, 'calendar', user.id, { action: 'event.create', id: row.id });
    await this.notifyParticipants(spaceId, row.id, participants, input.title, input.startsAt);
    return this.mapEvent(row);
  }

  async updateEvent(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    patch: EventPatch,
  ): Promise<CalendarEvent> {
    await this.access.assert(user.id, spaceId, 'calendar', 'update');
    const existing = await this.db.queryOne<CalendarEventRow>(
      'SELECT * FROM calendar_events WHERE id = $1 AND space_id = $2',
      [id, spaceId],
    );
    if (!existing) throw new NotFoundException('event_not_found');
    if (Number(existing.version) !== patch.expectedVersion) {
      throw new ConflictException('calendar_event_version_conflict');
    }
    const before = await this.snapshot(existing);
    const current = await this.mapEvent(existing);
    const merged: EventInput = {
      calendarId: patch.calendarId ?? current.calendarId,
      title: patch.title ?? current.title,
      description: patch.description ?? current.description,
      location: patch.location ?? current.location,
      startsAt: patch.startsAt ?? current.startsAt,
      endsAt: patch.endsAt ?? current.endsAt,
      allDay: patch.allDay ?? current.allDay,
      timezone: patch.timezone ?? current.timezone,
      category: patch.category ?? current.category,
      color: patch.color ?? current.color,
      recurrenceRule:
        patch.recurrenceRule === undefined ? current.recurrenceRule : patch.recurrenceRule,
      status: patch.status ?? current.status,
      participantIds: patch.participantIds ?? current.participants.map((item) => item.userId),
      links: patch.links ?? current.links,
    };
    this.validateRange(merged.startsAt, merged.endsAt, merged.allDay);
    const calendar = await this.resolveCalendar(spaceId, merged.calendarId, user.id);
    const version = Number(existing.version) + 1;
    const etag = sha256(`${existing.uid}:${version}:${Date.now()}`);
    const row = await this.db.queryOne<CalendarEventRow>(
      `UPDATE calendar_events SET
         calendar_id = $2, title = $3, description = $4, location = $5,
         starts_at = $6, ends_at = $7, all_day = $8, timezone = $9,
         category = $10, color = $11, recurrence_rule = $12, status = $13,
         version = $14, etag = $15, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *`,
      [
        id,
        calendar.id,
        merged.title,
        merged.description,
        merged.location,
        merged.startsAt,
        merged.endsAt,
        merged.allDay,
        merged.timezone,
        merged.category,
        merged.color,
        merged.recurrenceRule,
        merged.status,
        version,
        etag,
      ],
    );
    if (!row) throw new NotFoundException('event_not_found');
    const participants = await this.spaceMembers(spaceId, merged.participantIds);
    await this.replaceParticipants(id, participants);
    await this.replaceLinks(id, merged.links);
    await this.touchCalendar(calendar.id);
    await this.history(user.id, id, 'update', before, await this.snapshot(row));
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'calendar.event.update',
      entity: 'calendar_event',
      entityId: id,
      metadata: { version, fields: Object.keys(patch).filter((key) => key !== 'expectedVersion') },
    });
    this.realtime.publish(spaceId, 'calendar', user.id, { action: 'event.update', id, version });
    await this.notifyParticipants(
      spaceId,
      id,
      participants,
      merged.title,
      merged.startsAt,
      'изменено',
    );
    return this.mapEvent(row);
  }

  async deleteEvent(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
  ): Promise<{ deleted: boolean }> {
    await this.access.assert(user.id, spaceId, 'calendar', 'delete');
    const existing = await this.db.queryOne<CalendarEventRow>(
      'SELECT * FROM calendar_events WHERE id = $1 AND space_id = $2',
      [id, spaceId],
    );
    if (!existing) throw new NotFoundException('event_not_found');
    await this.history(user.id, id, 'delete', await this.snapshot(existing), {});
    await this.db.query('DELETE FROM calendar_events WHERE id = $1', [id]);
    await this.touchCalendar(existing.calendar_id);
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'calendar.event.delete',
      entity: 'calendar_event',
      entityId: id,
      metadata: { title: existing.title },
    });
    this.realtime.publish(spaceId, 'calendar', user.id, { action: 'event.delete', id });
    return { deleted: true };
  }

  async rsvp(user: AuthenticatedUser, spaceId: string, id: string, rsvp: RsvpStatus) {
    await this.access.assert(user.id, spaceId, 'calendar', 'update');
    const row = await this.db.queryOne<CalendarEventRow>(
      'SELECT * FROM calendar_events WHERE id = $1 AND space_id = $2',
      [id, spaceId],
    );
    if (!row) throw new NotFoundException('event_not_found');
    await this.db.query(
      `INSERT INTO calendar_event_participants (event_id, user_id, rsvp, responded_at)
       VALUES ($1,$2,$3,CURRENT_TIMESTAMP)
       ON CONFLICT (event_id, user_id) DO UPDATE SET rsvp = EXCLUDED.rsvp, responded_at = CURRENT_TIMESTAMP`,
      [id, user.id, rsvp],
    );
    this.realtime.publish(spaceId, 'calendar', user.id, { action: 'event.rsvp', id, rsvp });
    return this.mapEvent(row);
  }

  async addLink(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    link: { module: string; targetId: string },
  ) {
    await this.access.assert(user.id, spaceId, 'calendar', 'update');
    await this.assertEventInSpace(id, spaceId);
    await this.db.query(
      'INSERT INTO calendar_event_links (id, event_id, target_module, target_id) VALUES ($1,$2,$3,$4)',
      [newId('lnk'), id, link.module, link.targetId],
    );
    this.realtime.publish(spaceId, 'calendar', user.id, { action: 'event.link', id });
    return { created: true };
  }

  async addException(user: AuthenticatedUser, spaceId: string, id: string, input: ExceptionInput) {
    await this.access.assert(user.id, spaceId, 'calendar', 'update');
    await this.assertEventInSpace(id, spaceId);
    await this.db.query(
      `INSERT INTO calendar_event_exceptions
         (id, event_id, occurrence_start, action, override_starts_at, override_ends_at, override_title)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (event_id, occurrence_start) DO UPDATE SET
         action = EXCLUDED.action,
         override_starts_at = EXCLUDED.override_starts_at,
         override_ends_at = EXCLUDED.override_ends_at,
         override_title = EXCLUDED.override_title`,
      [
        newId('exc'),
        id,
        input.occurrenceStart,
        input.action,
        input.overrideStartsAt ?? null,
        input.overrideEndsAt ?? null,
        input.overrideTitle ?? null,
      ],
    );
    await this.touchCalendar(
      (
        await this.db.queryOne<{ calendar_id: string }>(
          'SELECT calendar_id FROM calendar_events WHERE id = $1',
          [id],
        )
      )?.calendar_id ?? '',
    );
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'calendar.event.exception',
      entity: 'calendar_event',
      entityId: id,
      metadata: { occurrenceStart: input.occurrenceStart, action: input.action },
    });
    this.realtime.publish(spaceId, 'calendar', user.id, { action: 'event.exception', id });
    return { created: true };
  }

  async freeBusy(
    user: AuthenticatedUser,
    spaceId: string,
    input: { from?: string; to?: string; participantIds: string[] },
  ) {
    await this.access.assert(user.id, spaceId, 'calendar', 'read');
    const range = this.range('week', input.from, input.to);
    const events = await this.loadEvents(spaceId, range);
    const selected = new Set(input.participantIds);
    const intervals = events
      .filter(
        (event) =>
          selected.size === 0 ||
          event.participants.some((participant) => selected.has(participant.userId)),
      )
      .map((event) => ({ start: new Date(event.startsAt), end: new Date(event.endsAt) }))
      .sort((left, right) => left.start.getTime() - right.start.getTime());
    const merged: Array<{ start: string; end: string }> = [];
    for (const interval of intervals) {
      const last = merged[merged.length - 1];
      if (last && interval.start.getTime() <= new Date(last.end).getTime()) {
        if (interval.end.getTime() > new Date(last.end).getTime())
          last.end = interval.end.toISOString();
      } else {
        merged.push({ start: interval.start.toISOString(), end: interval.end.toISOString() });
      }
    }
    return { from: range.from.toISOString(), to: range.to.toISOString(), busy: merged };
  }

  async suggestTime(user: AuthenticatedUser, spaceId: string, input: SuggestInput) {
    await this.access.assert(user.id, spaceId, 'calendar', 'read');
    const range = this.range('week', input.from, input.to);
    const busy = await this.freeBusy(user, spaceId, {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      participantIds: input.participantIds,
    });
    const durationMs = input.durationMinutes * 60_000;
    const stepMs = 30 * 60_000;
    const candidates: Array<{ startsAt: string; endsAt: string; score: number; reason: string }> =
      [];
    for (
      let time = Math.ceil(range.from.getTime() / stepMs) * stepMs;
      time + durationMs <= range.to.getTime() && candidates.length < 5;
      time += stepMs
    ) {
      const start = new Date(time);
      const hour = this.hourInTimezone(start, 'Europe/Rome');
      if (hour < 8 || hour >= 20) continue;
      const end = new Date(time + durationMs);
      const conflict = busy.busy.find(
        (interval) =>
          start.getTime() < new Date(interval.end).getTime() &&
          end.getTime() > new Date(interval.start).getTime(),
      );
      if (conflict) continue;
      const score = 100 - Math.abs(hour - 11) * 5 - Math.floor(candidates.length / 2);
      candidates.push({
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        score,
        reason: 'Свободно у выбранных участников, дневное время, без пересечений',
      });
    }
    return {
      durationMinutes: input.durationMinutes,
      participants: input.participantIds,
      candidates,
    };
  }

  async overload(user: AuthenticatedUser, spaceId: string, from?: string, to?: string) {
    await this.access.assert(user.id, spaceId, 'calendar', 'read');
    const range = this.range('month', from, to);
    const events = await this.loadEvents(spaceId, range);
    const byDay = new Map<string, number>();
    for (const event of events) {
      const key = event.startsAt.slice(0, 10);
      byDay.set(key, (byDay.get(key) ?? 0) + 1);
    }
    const warnings = [...byDay.entries()]
      .filter(([, count]) => count >= 3)
      .map(([day, count]) => ({
        day,
        count,
        severity: count >= 5 ? 'urgent' : 'important',
        message: `${count} событий в один день — проверьте нагрузку семьи`,
      }));
    return { from: range.from.toISOString(), to: range.to.toISOString(), warnings };
  }

  async exportIcs(user: AuthenticatedUser, spaceId: string, calendarId?: string) {
    await this.access.assert(user.id, spaceId, 'calendar', 'export');
    const events = await this.loadEvents(
      spaceId,
      { from: new Date('2020-01-01'), to: new Date('2035-01-01') },
      calendarId,
      500,
    );
    const calendar = calendarId
      ? await this.db.queryOne<{ name: string }>(
          'SELECT name FROM calendars WHERE id = $1 AND space_id = $2',
          [calendarId, spaceId],
        )
      : null;
    return this.ics.generate(events, calendar?.name ?? 'Ultra Family OS');
  }

  async importIcs(user: AuthenticatedUser, spaceId: string, icsText: string, calendarId?: string) {
    await this.access.assert(user.id, spaceId, 'calendar', 'create');
    const calendar = await this.resolveCalendar(spaceId, calendarId, user.id);
    const document = this.ics.parse(icsText);
    const result = { imported: 0, skipped: 0, errors: [] as string[] };
    for (const event of document.events) {
      try {
        await this.upsertEvent(user.id, spaceId, calendar.id, event, 'import');
        result.imported += 1;
      } catch (error) {
        result.skipped += 1;
        result.errors.push(error instanceof Error ? error.message : 'import_failed');
      }
    }
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'calendar.import_ics',
      entity: 'calendar',
      entityId: calendar.id,
      metadata: { found: document.events.length, ...result },
    });
    try {
      await this.notifications.notifyUser(user.id, {
        spaceId,
        category: 'calendar',
        severity: 'info',
        title: 'Импорт календаря завершён',
        body: `Импортировано событий: ${result.imported}. Пропущено: ${result.skipped}.`,
        sourceModule: 'calendar',
        actionUrl: '/calendar',
      });
    } catch {
      // The user may have disabled calendar notifications.
    }
    return result;
  }

  async createToken(
    user: AuthenticatedUser,
    spaceId: string,
    input: { calendarId: string; name: string; expiresInDays: number },
  ) {
    await this.access.assert(user.id, spaceId, 'calendar', 'update');
    const calendar = await this.db.queryOne<{ id: string }>(
      'SELECT id FROM calendars WHERE id = $1 AND space_id = $2',
      [input.calendarId, spaceId],
    );
    if (!calendar) throw new NotFoundException('calendar_not_found');
    const token = randomToken(24);
    const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString();
    const row = await this.db.queryOne<{ id: string; created_at: Date | string }>(
      `INSERT INTO calendar_tokens (id, user_id, calendar_id, name, token_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
      [newId('cdt'), user.id, input.calendarId, input.name, sha256(token), expiresAt],
    );
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'calendar.caldav_token.create',
      entity: 'calendar_token',
      entityId: row?.id ?? null,
      metadata: { name: input.name, expiresAt },
    });
    return {
      id: row?.id ?? null,
      name: input.name,
      token,
      expiresAt,
      createdAt: iso(row?.created_at),
    };
  }

  async listTokens(user: AuthenticatedUser, spaceId: string) {
    await this.access.assert(user.id, spaceId, 'calendar', 'read');
    const rows = await this.db.query<{
      id: string;
      calendar_id: string;
      name: string;
      expires_at: Date | string;
      revoked_at: Date | string | null;
      last_used_at: Date | string | null;
      created_at: Date | string;
    }>(
      `SELECT t.id, t.calendar_id, t.name, t.expires_at, t.revoked_at, t.last_used_at, t.created_at
       FROM calendar_tokens t JOIN calendars c ON c.id = t.calendar_id
       WHERE c.space_id = $1 AND t.user_id = $2 ORDER BY t.created_at DESC`,
      [spaceId, user.id],
    );
    return rows.map((row) => ({
      id: row.id,
      calendarId: row.calendar_id,
      name: row.name,
      expiresAt: iso(row.expires_at),
      revokedAt: iso(row.revoked_at),
      lastUsedAt: iso(row.last_used_at),
      createdAt: iso(row.created_at),
    }));
  }

  async revokeToken(user: AuthenticatedUser, spaceId: string, id: string) {
    await this.access.assert(user.id, spaceId, 'calendar', 'update');
    const row = await this.db.queryOne<{ id: string }>(
      `UPDATE calendar_tokens t SET revoked_at = CURRENT_TIMESTAMP
       FROM calendars c WHERE c.id = t.calendar_id AND c.space_id = $1 AND t.id = $2 AND t.user_id = $3
       RETURNING t.id`,
      [spaceId, id, user.id],
    );
    if (!row) throw new NotFoundException('calendar_token_not_found');
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'calendar.caldav_token.revoke',
      entity: 'calendar_token',
      entityId: id,
    });
    return { revoked: true };
  }

  async calDavContext(token: string, calendarId: string) {
    const auth = await this.authenticateCalDavToken(token, calendarId);
    const calendar = await this.db.queryOne<CalendarRow>(
      'SELECT id, space_id, name, kind, color, ctag FROM calendars WHERE id = $1',
      [calendarId],
    );
    if (!calendar) throw new NotFoundException('calendar_not_found');
    return { ...auth, calendar };
  }

  async calDavEvents(token: string, calendarId: string, from: Date, to: Date) {
    const context = await this.calDavContext(token, calendarId);
    const rows = await this.db.query<CalendarEventRow>(
      `SELECT * FROM calendar_events
       WHERE calendar_id = $1 AND space_id = $2 AND status <> 'cancelled'
         AND ((starts_at <= $4 AND ends_at >= $3) OR recurrence_rule IS NOT NULL)
       ORDER BY starts_at ASC LIMIT 500`,
      [calendarId, context.calendar.space_id, from.toISOString(), to.toISOString()],
    );
    const events = await Promise.all(rows.map((row) => this.mapEvent(row)));
    return { calendar: context.calendar, events };
  }

  async calDavPut(
    token: string,
    calendarId: string,
    uid: string,
    icsText: string,
    ifMatch?: string,
    ifNoneMatch?: string,
  ) {
    const context = await this.calDavContext(token, calendarId);
    const document = this.ics.parse(icsText);
    if (document.events.length !== 1) throw new BadRequestException('caldav_requires_one_vevent');
    const input = { ...document.events[0]!, uid };
    const event = await this.upsertEvent(
      context.userId,
      context.calendar.space_id,
      calendarId,
      input,
      'caldav',
      ifMatch,
      ifNoneMatch,
    );
    return event;
  }

  async calDavDelete(token: string, calendarId: string, uid: string, ifMatch?: string) {
    const context = await this.calDavContext(token, calendarId);
    const existing = await this.db.queryOne<CalendarEventRow>(
      'SELECT * FROM calendar_events WHERE calendar_id = $1 AND uid = $2',
      [calendarId, uid],
    );
    if (!existing) throw new NotFoundException('event_not_found');
    if (ifMatch && existing.etag !== ifMatch)
      throw new ConflictException('calendar_event_version_conflict');
    await this.history(
      context.userId,
      existing.id,
      'delete',
      await this.snapshot(existing),
      {},
      'caldav',
    );
    await this.db.query('DELETE FROM calendar_events WHERE id = $1', [existing.id]);
    await this.touchCalendar(calendarId);
    this.realtime.publish(context.calendar.space_id, 'calendar', context.userId, {
      action: 'event.delete',
      id: existing.id,
      source: 'caldav',
    });
    return { deleted: true };
  }

  private async authenticateCalDavToken(token: string, calendarId: string) {
    const row = await this.db.queryOne<{ user_id: string; calendar_id: string }>(
      `SELECT user_id, calendar_id FROM calendar_tokens
       WHERE token_hash = $1 AND calendar_id = $2 AND revoked_at IS NULL
         AND expires_at > CURRENT_TIMESTAMP`,
      [sha256(token), calendarId],
    );
    if (!row) throw new UnauthorizedException('caldav_token_invalid');
    await this.db.query(
      'UPDATE calendar_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE token_hash = $1',
      [sha256(token)],
    );
    return { userId: row.user_id, calendarId: row.calendar_id };
  }

  private async upsertEvent(
    actorUserId: string,
    spaceId: string,
    calendarId: string,
    input: IcsEventInput,
    source: string,
    ifMatch?: string,
    ifNoneMatch?: string,
  ): Promise<CalendarEvent> {
    const existing = await this.db.queryOne<CalendarEventRow>(
      'SELECT * FROM calendar_events WHERE calendar_id = $1 AND uid = $2',
      [calendarId, input.uid],
    );
    if (existing && ifNoneMatch === '*') throw new ConflictException('event_already_exists');
    if (ifMatch && existing && existing.etag !== ifMatch) {
      throw new ConflictException('calendar_event_version_conflict');
    }
    if (ifMatch && !existing) throw new NotFoundException('event_not_found');
    this.validateRange(input.startsAt, input.endsAt, input.allDay);
    const version = existing ? Number(existing.version) + 1 : 1;
    const etag = sha256(`${input.uid}:${version}:${Date.now()}`);
    let row: CalendarEventRow | null;
    if (existing) {
      row = await this.db.queryOne<CalendarEventRow>(
        `UPDATE calendar_events SET title = $2, description = $3, location = $4,
           starts_at = $5, ends_at = $6, all_day = $7, timezone = $8, category = $9,
           recurrence_rule = $10, status = $11, version = $12, etag = $13,
           source = $14, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 RETURNING *`,
        [
          existing.id,
          input.title,
          input.description,
          input.location,
          input.startsAt,
          input.endsAt,
          input.allDay,
          input.timezone,
          input.category,
          input.recurrenceRule,
          input.status,
          version,
          etag,
          source,
        ],
      );
    } else {
      row = await this.db.queryOne<CalendarEventRow>(
        `INSERT INTO calendar_events
           (id, calendar_id, space_id, uid, title, description, location, starts_at, ends_at,
            all_day, timezone, category, color, recurrence_rule, status, created_by, etag, version, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         RETURNING *`,
        [
          newId('evt'),
          calendarId,
          spaceId,
          input.uid,
          input.title,
          input.description,
          input.location,
          input.startsAt,
          input.endsAt,
          input.allDay,
          input.timezone,
          input.category,
          '#5B7CFA',
          input.recurrenceRule,
          input.status,
          actorUserId,
          etag,
          version,
          source,
        ],
      );
    }
    if (!row) throw new NotFoundException('event_not_saved');
    for (const exception of input.exceptions) {
      await this.db.query(
        `INSERT INTO calendar_event_exceptions (id, event_id, occurrence_start, action)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (event_id, occurrence_start) DO UPDATE SET action = EXCLUDED.action`,
        [newId('exc'), row.id, exception.occurrenceStart, exception.action],
      );
    }
    await this.touchCalendar(calendarId);
    await this.history(
      actorUserId,
      row.id,
      existing ? 'update' : 'create',
      existing ? await this.snapshot(existing) : {},
      await this.snapshot(row),
      source,
    );
    this.realtime.publish(spaceId, 'calendar', actorUserId, {
      action: existing ? 'event.update' : 'event.create',
      id: row.id,
      source,
    });
    return this.mapEvent(row);
  }

  private async loadEvents(
    spaceId: string,
    range: DateRange,
    calendarId?: string,
    limit = 300,
  ): Promise<CalendarEvent[]> {
    const params: unknown[] = [spaceId, range.from.toISOString(), range.to.toISOString()];
    if (calendarId) params.push(calendarId);
    const rows = await this.db.query<CalendarEventRow>(
      `SELECT * FROM calendar_events
       WHERE space_id = $1 AND status <> 'cancelled'
         AND ($4::text IS NULL OR calendar_id = $4)
         AND ((starts_at <= $3 AND ends_at >= $2) OR recurrence_rule IS NOT NULL)
       ORDER BY starts_at ASC LIMIT ${limit}`,
      calendarId ? params : [...params, null],
    );
    const output: CalendarEvent[] = [];
    for (const row of rows) {
      const base = await this.mapEvent(row);
      if (!row.recurrence_rule) {
        output.push(base);
        continue;
      }
      const exceptions = await this.db.query<ExceptionRow>(
        `SELECT occurrence_start, action, override_starts_at, override_ends_at, override_title
         FROM calendar_event_exceptions WHERE event_id = $1`,
        [row.id],
      );
      const exceptionMap = new Map(
        exceptions.map((item) => [iso(item.occurrence_start) ?? '', item]),
      );
      const duration = new Date(base.endsAt).getTime() - new Date(base.startsAt).getTime();
      for (const occurrence of this.ics.occurrences(
        row.recurrence_rule,
        base.startsAt,
        range.from,
        range.to,
      )) {
        const occurrenceStart = occurrence.toISOString();
        const exception = exceptionMap.get(occurrenceStart);
        if (exception?.action === 'cancelled') continue;
        const start = new Date(iso(exception?.override_starts_at) ?? occurrenceStart);
        const end = new Date(iso(exception?.override_ends_at) ?? start.getTime() + duration);
        if (end < range.from || start > range.to) continue;
        output.push({
          ...base,
          title: exception?.override_title ?? base.title,
          startsAt: start.toISOString(),
          endsAt: end.toISOString(),
          isOccurrence: true,
          occurrenceStart,
        });
        if (output.length >= limit) break;
      }
      if (output.length >= limit) break;
    }
    return output
      .sort((left, right) => left.startsAt.localeCompare(right.startsAt))
      .slice(0, limit);
  }

  private async mapEvent(row: CalendarEventRow): Promise<CalendarEvent> {
    const [participants, links] = await Promise.all([
      this.db.query<CalendarParticipantRow>(
        'SELECT user_id, rsvp FROM calendar_event_participants WHERE event_id = $1',
        [row.id],
      ),
      this.db.query<CalendarLinkRow>(
        'SELECT target_module, target_id FROM calendar_event_links WHERE event_id = $1',
        [row.id],
      ),
    ]);
    return toCalendarEvent(row, participants, links);
  }

  private async snapshot(row: CalendarEventRow) {
    return {
      title: row.title,
      startsAt: iso(row.starts_at),
      endsAt: iso(row.ends_at),
      status: row.status,
      version: Number(row.version),
      etag: row.etag,
      recurrenceRule: row.recurrence_rule,
    };
  }

  private async history(
    actorUserId: string,
    eventId: string,
    action: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    source = 'api',
  ) {
    await this.db.query(
      `INSERT INTO calendar_event_history
         (id, event_id, actor_user_id, action, before, after, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        newId('ceh'),
        eventId,
        actorUserId,
        action,
        JSON.stringify(before),
        JSON.stringify(after),
        source,
      ],
    );
  }

  private async replaceParticipants(eventId: string, userIds: string[]) {
    await this.db.query('DELETE FROM calendar_event_participants WHERE event_id = $1', [eventId]);
    for (const userId of userIds) {
      await this.db.query(
        'INSERT INTO calendar_event_participants (event_id, user_id, rsvp) VALUES ($1,$2,$3)',
        [eventId, userId, 'pending'],
      );
    }
  }

  private async replaceLinks(eventId: string, links: Array<{ module: string; targetId: string }>) {
    await this.db.query('DELETE FROM calendar_event_links WHERE event_id = $1', [eventId]);
    for (const link of links) {
      await this.db.query(
        'INSERT INTO calendar_event_links (id, event_id, target_module, target_id) VALUES ($1,$2,$3,$4)',
        [newId('lnk'), eventId, link.module, link.targetId],
      );
    }
  }

  private async spaceMembers(spaceId: string, requested: string[]): Promise<string[]> {
    const members = await this.db.query<{ user_id: string }>(
      'SELECT user_id FROM memberships WHERE space_id = $1',
      [spaceId],
    );
    const allowed = new Set(members.map((member) => member.user_id));
    return [...new Set(requested)].filter((id) => allowed.has(id));
  }

  private async resolveCalendar(
    spaceId: string,
    calendarId: string | undefined,
    userId: string,
    kind = 'family',
  ): Promise<CalendarRow> {
    if (calendarId) {
      const row = await this.db.queryOne<CalendarRow>(
        'SELECT id, space_id, name, kind, color, ctag FROM calendars WHERE id = $1 AND space_id = $2',
        [calendarId, spaceId],
      );
      if (!row) throw new NotFoundException('calendar_not_found');
      return row;
    }
    const existing = await this.db.queryOne<CalendarRow>(
      'SELECT id, space_id, name, kind, color, ctag FROM calendars WHERE space_id = $1 ORDER BY created_at ASC LIMIT 1',
      [spaceId],
    );
    if (existing) return existing;
    const row = await this.db.queryOne<CalendarRow>(
      `INSERT INTO calendars (id, space_id, owner_user_id, name, kind, color, visibility, ctag)
       VALUES ($1,$2,$3,$4,$5,'#5B7CFA','household','1')
       RETURNING id, space_id, name, kind, color, ctag`,
      [newId('cal'), spaceId, userId, kind === 'personal' ? 'Личный' : 'Семейный'],
    );
    if (!row) throw new NotFoundException('calendar_not_created');
    return row;
  }

  private async touchCalendar(calendarId: string) {
    if (!calendarId) return;
    const ctag = String(Date.now());
    await this.db.query(
      'UPDATE calendars SET ctag = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [calendarId, ctag],
    );
    await this.db.query(
      `INSERT INTO calendar_sync_state (calendar_id, sync_token, ctag)
       VALUES ($1,$2,$3)
       ON CONFLICT (calendar_id) DO UPDATE SET sync_token = EXCLUDED.sync_token, ctag = EXCLUDED.ctag, updated_at = CURRENT_TIMESTAMP`,
      [calendarId, newId('sync'), ctag],
    );
  }

  private async assertEventInSpace(id: string, spaceId: string) {
    const row = await this.db.queryOne<{ id: string }>(
      'SELECT id FROM calendar_events WHERE id = $1 AND space_id = $2',
      [id, spaceId],
    );
    if (!row) throw new NotFoundException('event_not_found');
  }

  private async notifyParticipants(
    spaceId: string,
    eventId: string,
    userIds: string[],
    title: string,
    startsAt: string,
    verb = 'создано',
  ) {
    for (const userId of userIds) {
      try {
        await this.notifications.notifyUser(userId, {
          spaceId,
          category: 'calendar',
          severity: 'info',
          title: `Событие ${verb}: ${title}`,
          body: `Начало: ${new Date(startsAt).toLocaleString('ru-RU', { timeZone: 'Europe/Rome' })}`,
          sourceModule: 'calendar',
          sourceId: eventId,
          actionUrl: '/calendar',
          dedupeKey: `calendar:${eventId}:${verb}:${userId}`,
        });
      } catch {
        // User preferences may disable this category.
      }
    }
  }

  private range(view: string, from?: string, to?: string): DateRange {
    const now = from ? new Date(from) : new Date();
    if (Number.isNaN(now.getTime())) throw new BadRequestException('invalid_from_date');
    let end = to ? new Date(to) : new Date(now.getTime());
    if (Number.isNaN(end.getTime())) throw new BadRequestException('invalid_to_date');
    if (!to) {
      if (view === 'day') end = new Date(now.getTime() + 86_400_000);
      else if (view === 'week') end = new Date(now.getTime() + 7 * 86_400_000);
      else if (view === 'agenda') end = new Date(now.getTime() + 14 * 86_400_000);
      else end = new Date(now.getTime() + 31 * 86_400_000);
    }
    if (end <= now) throw new BadRequestException('invalid_date_range');
    return { from: now, to: end };
  }

  private validateRange(startsAt: string, endsAt: string, allDay: boolean): void {
    const start = new Date(startsAt).getTime();
    const end = new Date(endsAt).getTime();
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
      throw new BadRequestException('invalid_event_range');
    }
    if (!allDay && end - start > 14 * 86_400_000) {
      throw new BadRequestException('event_too_long');
    }
  }

  private hourInTimezone(date: Date, timezone: string): number {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        hour12: false,
      }).formatToParts(date);
      return Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
    } catch {
      return date.getUTCHours();
    }
  }
}
