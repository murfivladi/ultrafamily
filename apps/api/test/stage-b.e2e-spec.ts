import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, householdSpaces, login, type TestAccount } from './test-app';

let app: INestApplication;
let owner: TestAccount;
let adult: TestAccount;
let child: TestAccount;
let guest: TestAccount;
let ownerSpace = '';
let adultSpace = '';
let calendarId = '';
let eventId = '';
let taskId = '';
let shoppingItemId = '';
let draftId = '';
let caldavToken = '';
let caldavUid = '';

const stamp = (date: Date): string =>
  date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

beforeAll(async () => {
  app = await createTestApp();
  owner = await login(app, 'owner@ultra.family');
  adult = await login(app, 'adult@ultra.family');
  child = await login(app, 'child@ultra.family');
  guest = await login(app, 'guest@ultra.family');
  ownerSpace = householdSpaces(owner)[0]!.id;
  adultSpace = householdSpaces(adult)[0]!.id;
});

afterAll(async () => {
  await app?.close();
});

describe('Stage B smart dashboard and isolation', () => {
  it('builds a permission-filtered feed without another household data', async () => {
    const response = await owner.agent.get('/api/dashboard').expect(200);
    expect(response.body.feedSources).toEqual(
      expect.arrayContaining([
        'calendar',
        'tasks',
        'notifications',
        'shopping',
        'family',
        'security',
      ]),
    );
    expect(Array.isArray(response.body.feed)).toBe(true);
    expect(
      response.body.events.some(
        (event: { title: string }) => event.title === 'Собрание второго дома',
      ),
    ).toBe(false);
    expect(
      response.body.tasks.some(
        (task: { title: string }) => task.title === 'Купить продукты в Катании',
      ),
    ).toBe(false);
    expect(response.body.feed.every((item: { reason: string }) => Boolean(item.reason))).toBe(true);
  });

  it('keeps Stage B modules inside the active household and protects child/guest rails', async () => {
    await adult.agent.get(`/api/calendar/calendars?spaceId=${ownerSpace}`).expect(403);
    await adult.agent.get(`/api/tasks/board?spaceId=${ownerSpace}`).expect(403);
    await adult.agent.get(`/api/shopping/lists?spaceId=${ownerSpace}`).expect(403);
    await adult.agent.get(`/api/calendar/calendars?spaceId=${adultSpace}`).expect(200);
    await child.agent.get(`/api/tasks/board?spaceId=${ownerSpace}`).expect(200);
    await child.agent.get(`/api/publishing?spaceId=${ownerSpace}`).expect(403);
    await guest.agent.get(`/api/calendar/calendars?spaceId=${ownerSpace}`).expect(403);
    await request(app.getHttpServer())
      .get(`/api/realtime/stream?spaceId=${ownerSpace}`)
      .expect(401);
  });
});

describe('Stage B calendar, ICS and recurrence', () => {
  it('creates, version-updates, RSVPs and exports calendar events', async () => {
    const calendars = await owner.agent
      .get(`/api/calendar/calendars?spaceId=${ownerSpace}`)
      .expect(200);
    expect(calendars.body.length).toBeGreaterThan(0);
    calendarId = (calendars.body[0] as { id: string }).id;

    const startsAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const endsAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const created = await owner.agent
      .post('/api/calendar/events')
      .set('x-csrf-token', owner.csrfToken)
      .send({
        spaceId: ownerSpace,
        calendarId,
        title: 'Тест календаря Stage B',
        description: 'Проверка версий, RSVP и ICS',
        location: 'Рим',
        startsAt,
        endsAt,
        participantIds: [owner.userId, child.userId],
        status: 'confirmed',
      })
      .expect(201);
    eventId = (created.body as { id: string }).id;
    expect(created.body).toMatchObject({ title: 'Тест календаря Stage B', version: 1 });

    const updated = await owner.agent
      .patch(`/api/calendar/events/${eventId}`)
      .set('x-csrf-token', owner.csrfToken)
      .send({
        spaceId: ownerSpace,
        expectedVersion: 1,
        title: 'Тест календаря Stage B — обновлено',
      })
      .expect(200);
    expect(updated.body.version).toBe(2);

    await owner.agent
      .patch(`/api/calendar/events/${eventId}`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, expectedVersion: 1, title: 'Устаревшая версия' })
      .expect(409);

    const rsvp = await owner.agent
      .post(`/api/calendar/events/${eventId}/rsvp`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, rsvp: 'accepted' })
      .expect(201);
    expect(
      rsvp.body.participants.some(
        (item: { userId: string; rsvp: string }) =>
          item.userId === owner.userId && item.rsvp === 'accepted',
      ),
    ).toBe(true);

    const ics = await owner.agent
      .get(`/api/calendar/export.ics?spaceId=${ownerSpace}&calendarId=${calendarId}`)
      .expect(200);
    expect(ics.headers['content-type']).toContain('text/calendar');
    expect(ics.text).toContain('BEGIN:VCALENDAR');
    expect(ics.text).toContain('Тест календаря Stage B');
  });

  it('imports ICS and expands recurring events', async () => {
    const start = new Date(Date.now() + 24 * 3_600_000);
    const end = new Date(start.getTime() + 3_600_000);
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Stage B test//EN',
      'BEGIN:VEVENT',
      'UID:stage-b-import-test@ultra.family',
      `DTSTAMP:${stamp(new Date())}`,
      `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(end)}`,
      'SUMMARY:Importato dal calendario',
      'DESCRIPTION:Verifica import ICS',
      'STATUS:CONFIRMED',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const imported = await owner.agent
      .post('/api/calendar/import')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, calendarId, ics })
      .expect(201);
    expect(imported.body.imported).toBe(1);

    const events = await owner.agent
      .get(`/api/calendar/events?spaceId=${ownerSpace}&view=agenda`)
      .expect(200);
    expect(
      events.body.some((event: { title: string }) => event.title === 'Importato dal calendario'),
    ).toBe(true);
    expect(
      events.body.some((event: { isOccurrence?: boolean }) => event.isOccurrence === true),
    ).toBe(true);
  });

  it('provides free/busy, time suggestions and overload warnings', async () => {
    const freeBusy = await owner.agent
      .post('/api/calendar/free-busy')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, participantIds: [owner.userId] })
      .expect(201);
    expect(Array.isArray(freeBusy.body.busy)).toBe(true);

    const suggestion = await owner.agent
      .post('/api/calendar/suggest-time')
      .set('x-csrf-token', owner.csrfToken)
      .send({
        spaceId: ownerSpace,
        participantIds: [owner.userId],
        durationMinutes: 60,
        from: new Date(Date.now() + 8 * 3_600_000).toISOString(),
        to: new Date(Date.now() + 72 * 3_600_000).toISOString(),
      })
      .expect(201);
    expect(Array.isArray(suggestion.body.candidates)).toBe(true);
    expect(
      suggestion.body.candidates.every((item: { reason: string }) => Boolean(item.reason)),
    ).toBe(true);

    const overload = await owner.agent
      .get(`/api/calendar/overload?spaceId=${ownerSpace}`)
      .expect(200);
    expect(Array.isArray(overload.body.warnings)).toBe(true);
  });
});

describe('Stage B tasks without gamification', () => {
  it('supports board, claiming, deterministic priority, splitting and auto-assignment', async () => {
    const board = await owner.agent.get(`/api/tasks/board?spaceId=${ownerSpace}`).expect(200);
    expect(board.body.lists.length).toBeGreaterThan(0);
    expect(Array.isArray(board.body.workload)).toBe(true);

    const created = await owner.agent
      .post('/api/tasks')
      .set('x-csrf-token', owner.csrfToken)
      .send({
        spaceId: ownerSpace,
        title: 'Проверить организационное ядро',
        description: 'Без баллов, уровней и публичных рейтингов',
        priority: 'normal',
        estimateMinutes: 60,
        complexity: 3,
      })
      .expect(201);
    taskId = (created.body as { id: string }).id;
    expect(created.body).toMatchObject({ status: 'todo', version: 1 });

    const claimed = await owner.agent
      .post(`/api/tasks/${taskId}/claim`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace })
      .expect(201);
    expect(claimed.body.assigneeUserId).toBe(owner.userId);

    const priority = await owner.agent
      .post(`/api/tasks/${taskId}/prioritize`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, apply: true })
      .expect(201);
    expect(priority.body.explanation).toContain('ИИ');

    const split = await owner.agent
      .post(`/api/tasks/${taskId}/split`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, count: 3, apply: true })
      .expect(201);
    expect(split.body.created).toHaveLength(3);

    const autoAssign = await owner.agent
      .post('/api/tasks/auto-assign')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, taskIds: [taskId] })
      .expect(201);
    expect(autoAssign.body.assignments).toHaveLength(1);
    expect(autoAssign.body.assignments[0].reason).toContain('без баллов');

    await child.agent
      .delete(`/api/tasks/${taskId}?spaceId=${ownerSpace}`)
      .set('x-csrf-token', child.csrfToken)
      .expect(403);
  });
});

describe('Stage B notifications', () => {
  it('updates preferences, groups test notifications, runs reminders and dispatches deliveries', async () => {
    const preferences = await owner.agent.get('/api/notifications/preferences').expect(200);
    expect(preferences.body).toHaveProperty('quietHours');

    await owner.agent
      .patch('/api/notifications/preferences')
      .set('x-csrf-token', owner.csrfToken)
      .send({
        quietHours: {
          enabled: true,
          from: '22:00',
          to: '07:00',
          timezone: 'Europe/Rome',
        },
      })
      .expect(200);

    const test = await owner.agent
      .post('/api/notifications/test')
      .set('x-csrf-token', owner.csrfToken)
      .send({ severity: 'urgent' })
      .expect(201);
    const notificationId = (test.body as { id: string }).id;

    const list = await owner.agent.get('/api/notifications?unread=true').expect(200);
    expect(list.body.some((item: { id: string }) => item.id === notificationId)).toBe(true);

    await owner.agent
      .post(`/api/notifications/${notificationId}/read`)
      .set('x-csrf-token', owner.csrfToken)
      .send({})
      .expect(201);

    const digest = await owner.agent.get('/api/notifications/digest?period=daily').expect(200);
    expect(Array.isArray(digest.body.groups)).toBe(true);

    const sweep = await owner.agent
      .post('/api/notifications/reminders/sweep')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace })
      .expect(201);
    expect(sweep.body).toHaveProperty('events');

    const dispatch = await owner.agent
      .post('/api/notifications/dispatch')
      .set('x-csrf-token', owner.csrfToken)
      .send({})
      .expect(201);
    expect(dispatch.body).toHaveProperty('processed');

    const deliveries = await owner.agent
      .get(`/api/notifications/deliveries?spaceId=${ownerSpace}`)
      .expect(200);
    expect(Array.isArray(deliveries.body)).toBe(true);
  });
});

describe('Stage B collaborative shopping', () => {
  it('supports versioned updates, history, merging, generation and presence', async () => {
    const lists = await owner.agent.get(`/api/shopping/lists?spaceId=${ownerSpace}`).expect(200);
    expect(lists.body.length).toBeGreaterThan(0);
    const list = lists.body[0] as { id: string; version: number };

    const created = await owner.agent
      .post('/api/shopping/items')
      .set('x-csrf-token', owner.csrfToken)
      .send({
        spaceId: ownerSpace,
        listId: list.id,
        name: 'Паста для теста',
        quantity: 2,
        unit: 'pcs',
        category: 'pantry',
      })
      .expect(201);
    shoppingItemId = (created.body as { id: string }).id;

    const refreshed = await owner.agent
      .get(`/api/shopping/lists?spaceId=${ownerSpace}`)
      .expect(200);
    const version = (refreshed.body[0] as { version: number }).version;

    const checked = await owner.agent
      .patch(`/api/shopping/items/${shoppingItemId}`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, listId: list.id, expectedVersion: version, checked: true })
      .expect(200);
    expect(checked.body.checked).toBe(true);

    await owner.agent
      .patch(`/api/shopping/items/${shoppingItemId}`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, listId: list.id, expectedVersion: version, checked: false })
      .expect(409);

    const merge = await owner.agent
      .post('/api/shopping/merge')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, listId: list.id })
      .expect(201);
    expect(merge.body).toHaveProperty('merged');

    const generated = await owner.agent
      .post('/api/shopping/generate')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, listId: list.id })
      .expect(201);
    expect(generated.body.autoOrdering).toBe(false);

    const history = await owner.agent
      .get(`/api/shopping/history?spaceId=${ownerSpace}`)
      .expect(200);
    expect(Array.isArray(history.body)).toBe(true);

    const suggestions = await owner.agent
      .get(`/api/shopping/suggestions?spaceId=${ownerSpace}`)
      .expect(200);
    expect(
      suggestions.body.every((item: { autoOrdering: boolean }) => item.autoOrdering === false),
    ).toBe(true);

    await owner.agent
      .post('/api/shopping/presence/join')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, listId: list.id })
      .expect(201);
  });
});

describe('Stage B explicit public publishing', () => {
  it('keeps drafts and guest materials off the public site until explicitly configured', async () => {
    const before = await request(app.getHttpServer())
      .get('/api/public/posts?language=ru')
      .expect(200);
    expect(before.body.some((post: { slug: string }) => post.slug === 'draft-ru')).toBe(false);
    expect(before.body.some((post: { slug: string }) => post.slug === 'guest-note-ru')).toBe(false);

    const news = await request(app.getHttpServer()).get('/api/public/news?language=ru').expect(200);
    expect(news.body).toHaveLength(1);

    const drafts = await owner.agent.get(`/api/publishing?spaceId=${ownerSpace}`).expect(200);
    expect(drafts.body.some((post: { status: string }) => post.status === 'draft')).toBe(true);

    const draft = await owner.agent
      .post('/api/publishing/drafts')
      .set('x-csrf-token', owner.csrfToken)
      .send({
        spaceId: ownerSpace,
        title: 'Notizia di prova Stage B',
        excerpt: 'Bozza esplicita',
        body: 'Solo dopo la pubblicazione esplicita.',
        language: 'it',
        visibility: 'public',
        audienceSpaceIds: [],
        guestShared: false,
      })
      .expect(201);
    draftId = (draft.body as { id: string }).id;
    expect(draft.body.status).toBe('draft');

    await owner.agent.get(`/api/publishing/${draftId}/preview?spaceId=${ownerSpace}`).expect(200);

    const published = await owner.agent
      .post(`/api/publishing/${draftId}/publish`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, visibility: 'public', audienceSpaceIds: [], guestShared: false })
      .expect(201);
    expect(published.body.status).toBe('published');

    const publicIt = await request(app.getHttpServer())
      .get('/api/public/posts?language=it')
      .expect(200);
    expect(publicIt.body.some((post: { slug: string }) => post.slug === published.body.slug)).toBe(
      true,
    );

    const unpublished = await owner.agent
      .post(`/api/publishing/${draftId}/unpublish`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, reason: 'e2e test' })
      .expect(201);
    expect(unpublished.body.status).toBe('unpublished');

    const after = await request(app.getHttpServer())
      .get('/api/public/posts?language=it')
      .expect(200);
    expect(after.body.some((post: { slug: string }) => post.slug === published.body.slug)).toBe(
      false,
    );

    const shared = await guest.agent
      .get(`/api/publishing/shared?spaceId=${ownerSpace}`)
      .expect(200);
    expect(shared.body.some((post: { slug: string }) => post.slug === 'guest-note-ru')).toBe(true);

    await guest.agent
      .post(`/api/publishing/${draftId}/publish`)
      .set('x-csrf-token', guest.csrfToken)
      .send({ spaceId: ownerSpace })
      .expect(403);
  });
});

describe('Stage B CalDAV', () => {
  it('authenticates scoped tokens and supports PROPFIND, REPORT, PUT, GET and DELETE', async () => {
    const tokens = await owner.agent
      .post('/api/calendar/tokens')
      .set('x-csrf-token', owner.csrfToken)
      .send({
        spaceId: ownerSpace,
        calendarId,
        name: 'CalDAV E2E',
        expiresInDays: 30,
      })
      .expect(201);
    caldavToken = (tokens.body as { token: string }).token;
    const authorization = `Basic ${Buffer.from(`caldav:${caldavToken}`).toString('base64')}`;
    const server = request(app.getHttpServer());

    await server
      .options(`/api/caldav/${calendarId}`)
      .set('authorization', authorization)
      .expect(204);

    const propfind = await server
      .propfind(`/api/caldav/${calendarId}`)
      .set('authorization', authorization)
      .expect(207);
    expect(propfind.text).toContain('<C:calendar/>');
    expect(propfind.text).toContain('getctag');

    const reportXml = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">
    <C:time-range start="${stamp(new Date(Date.now() - 86_400_000))}" end="${stamp(new Date(Date.now() + 30 * 86_400_000))}"/>
  </C:comp-filter></C:comp-filter></C:filter>
</C:calendar-query>`;
    const report = await server
      .report(`/api/caldav/${calendarId}`)
      .set('authorization', authorization)
      .set('Content-Type', 'application/xml')
      .send(reportXml)
      .expect(207);
    expect(report.text).toContain('multistatus');
    expect(report.text).toContain('calendar-data');

    caldavUid = `caldav-${Date.now()}@ultra.family`;
    const start = new Date(Date.now() + 48 * 3_600_000);
    const end = new Date(start.getTime() + 3_600_000);
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//CalDAV E2E//EN',
      'BEGIN:VEVENT',
      `UID:${caldavUid}`,
      `DTSTAMP:${stamp(new Date())}`,
      `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(end)}`,
      'SUMMARY:Evento CalDAV',
      'STATUS:CONFIRMED',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const encodedUid = encodeURIComponent(caldavUid);
    const put = await server
      .put(`/api/caldav/${calendarId}/${encodedUid}.ics`)
      .set('authorization', authorization)
      .set('Content-Type', 'text/calendar')
      .set('If-None-Match', '*')
      .send(ics)
      .expect(201);
    expect(put.headers.etag).toBeDefined();
    const etag = put.headers.etag as string;

    const fetched = await server
      .get(`/api/caldav/${calendarId}/${encodedUid}.ics`)
      .set('authorization', authorization)
      .expect(200);
    expect(fetched.text).toContain('Evento CalDAV');

    await server
      .delete(`/api/caldav/${calendarId}/${encodedUid}.ics`)
      .set('authorization', authorization)
      .set('If-Match', etag)
      .expect(204);

    await server
      .get(`/api/caldav/${calendarId}/${encodedUid}.ics`)
      .set('authorization', authorization)
      .expect(404);

    const invalid = `Basic ${Buffer.from('caldav:invalid-token').toString('base64')}`;
    await server.propfind(`/api/caldav/${calendarId}`).set('authorization', invalid).expect(401);
  });

  it('rejects token use on a different calendar', async () => {
    const other = await adult.agent
      .get(`/api/calendar/calendars?spaceId=${adultSpace}`)
      .expect(200);
    const otherCalendarId = (other.body[0] as { id: string }).id;
    const authorization = `Basic ${Buffer.from(`caldav:${caldavToken}`).toString('base64')}`;
    await request(app.getHttpServer())
      .propfind(`/api/caldav/${otherCalendarId}`)
      .set('authorization', authorization)
      .expect(401);
  });
});
