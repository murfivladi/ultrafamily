import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DatabaseService } from '../src/db/database.service';
import { createTestApp, householdSpaces, login, type TestAccount } from './test-app';

let app: INestApplication;
let owner: TestAccount;
let adult: TestAccount;
let admin: TestAccount;
let child: TestAccount;
let guest: TestAccount;

beforeAll(async () => {
  app = await createTestApp();
  owner = await login(app, 'owner@ultra.family');
  adult = await login(app, 'adult@ultra.family');
  admin = await login(app, 'admin@ultra.family');
  child = await login(app, 'child@ultra.family');
  guest = await login(app, 'guest@ultra.family');
});

afterAll(async () => {
  await app?.close();
});

describe('Stage A public surface', () => {
  it('reports health without authentication', async () => {
    const response = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(response.body).toMatchObject({ status: 'ok', database: 'pglite' });
  });

  it('returns only explicitly published fields on the public site', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/public/posts?language=ru')
      .expect(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toMatchObject({ slug: 'welcome-ru', language: 'ru' });
    expect(response.body[0]).not.toHaveProperty('spaceId');
    expect(response.body[0]).not.toHaveProperty('createdBy');
    expect(response.body[0]).not.toHaveProperty('password');
  });
});

describe('accounts, sessions and CSRF', () => {
  it('protects every state-changing request with a per-session CSRF token', async () => {
    await owner.agent
      .post('/api/spaces')
      .send({ name: 'Не должен появиться', kind: 'household' })
      .expect(403);

    const response = await owner.agent
      .post('/api/spaces')
      .set('x-csrf-token', owner.csrfToken)
      .send({ name: 'Дом теста', kind: 'household' })
      .expect(201);
    expect(response.body).toMatchObject({ name: 'Дом теста', role: 'space_owner' });
  });

  it('lists sessions and revokes other sessions without ending the current one', async () => {
    const sessions = await owner.agent.get('/api/auth/sessions').expect(200);
    expect(sessions.body.some((session: { current: boolean }) => session.current)).toBe(true);

    const revoked = await owner.agent
      .post('/api/auth/sessions/revoke-all')
      .set('x-csrf-token', owner.csrfToken)
      .send({})
      .expect(200);
    expect(revoked.body).toMatchObject({ ok: true });

    const remaining = await owner.agent.get('/api/auth/sessions').expect(200);
    expect(remaining.body).toHaveLength(1);
    expect(remaining.body[0].current).toBe(true);
  });

  it('registers only with an invitation and verifies the email token', async () => {
    const agent = request.agent(app.getHttpServer());
    const registered = await agent
      .post('/api/auth/register')
      .send({
        inviteToken: 'WELCOME-UFOS-2026',
        email: 'new.member@example.test',
        displayName: 'Nuovo Membro',
        password: 'InvitedMember!2026',
        language: 'it',
      })
      .expect(201);
    expect(registered.body.user).toMatchObject({
      email: 'new.member@example.test',
      language: 'it',
      emailVerifiedAt: null,
    });
    expect(registered.body.verificationToken).toBeTruthy();

    await request(app.getHttpServer())
      .post('/api/auth/verify-email')
      .send({ token: registered.body.verificationToken })
      .expect(200);

    const signedIn = await agent
      .post('/api/auth/login')
      .send({ email: 'new.member@example.test', password: 'InvitedMember!2026' })
      .expect(200);
    expect(signedIn.body.user.emailVerifiedAt).toBeTruthy();
    expect(signedIn.body.spaces.length).toBeGreaterThan(0);
  });
});

describe('space isolation and hybrid permissions', () => {
  it('blocks access to a household the user does not belong to', async () => {
    const mainHousehold = householdSpaces(owner).find((space) => space.name === 'Дом Палермо');
    expect(mainHousehold).toBeDefined();
    const spaceId = mainHousehold!.id;

    await owner.agent.get(`/api/spaces/${spaceId}/members`).expect(200);
    await adult.agent.get(`/api/spaces/${spaceId}/members`).expect(403);
    await admin.agent.get(`/api/spaces/${spaceId}/members`).expect(403);
    await guest.agent.get(`/api/spaces/${spaceId}/members`).expect(403);

    const secondHousehold = householdSpaces(adult).find((space) => space.name === 'Дом Катании');
    expect(secondHousehold).toBeDefined();
    await owner.agent
      .post(`/api/spaces/${secondHousehold!.id}/switch`)
      .set('x-csrf-token', owner.csrfToken)
      .send({})
      .expect(403);
  });

  it('denies household data to a platform administrator even with a membership', async () => {
    const db = app.get(DatabaseService);
    const spaceId = householdSpaces(owner).find((space) => space.name === 'Дом Палермо')!.id;
    await db.query(
      `INSERT INTO memberships (space_id, user_id, role)
       VALUES ($1, $2, 'space_owner')
       ON CONFLICT (space_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [spaceId, admin.userId],
    );
    await db.query(
      `INSERT INTO user_preferences (user_id, active_space_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET active_space_id = EXCLUDED.active_space_id`,
      [admin.userId, spaceId],
    );

    const snapshot = await admin.agent.get('/api/auth/me').expect(200);
    expect(snapshot.body.permissions).toEqual([]);
    await admin.agent.get(`/api/calendar/calendars?spaceId=${spaceId}`).expect(403);
    await admin.agent.get('/api/dashboard').expect(403);
  });

  it('keeps child accounts from issuing invitations', async () => {
    const household = householdSpaces(child)[0];
    expect(household).toBeDefined();
    await child.agent
      .post(`/api/spaces/${household!.id}/invitations`)
      .set('x-csrf-token', child.csrfToken)
      .send({ role: 'adult' })
      .expect(403);
  });

  it('allows only a space owner to toggle modules', async () => {
    const modules = await owner.agent.get('/api/modules').expect(200);
    expect(modules.body.definitions.length).toBeGreaterThan(30);
    const dashboard = modules.body.toggles.find(
      (toggle: { moduleId: string }) => toggle.moduleId === 'dashboard',
    );
    expect(dashboard.enabled).toBe(true);

    await owner.agent
      .patch('/api/modules/calendar')
      .set('x-csrf-token', owner.csrfToken)
      .send({ enabled: true })
      .expect(200);
    await child.agent
      .patch('/api/modules/calendar')
      .set('x-csrf-token', child.csrfToken)
      .send({ enabled: false })
      .expect(403);
  });
});

describe('administration and audit', () => {
  it('keeps a verifiable append-only-style audit chain available only to platform admins', async () => {
    const verified = await owner.agent.get('/api/admin/audit/verify').expect(200);
    expect(verified.body).toMatchObject({ valid: true });
    expect(verified.body.checked).toBeGreaterThan(0);

    await adult.agent.get('/api/admin/audit/verify').expect(403);
    const snapshot = await owner.agent.get('/api/admin').expect(200);
    expect(snapshot.body.users.length).toBeGreaterThanOrEqual(5);
    expect(snapshot.body.spaces.length).toBeGreaterThanOrEqual(4);
  });
});

describe('password recovery', () => {
  it('rotates credentials and revokes existing sessions', async () => {
    const requested = await request(app.getHttpServer())
      .post('/api/auth/password-reset/request')
      .send({ email: 'guest@ultra.family' })
      .expect(200);
    expect(requested.body.devToken).toBeTruthy();

    await request(app.getHttpServer())
      .post('/api/auth/password-reset/confirm')
      .send({ token: requested.body.devToken, password: 'AnotherGuest!2026' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'guest@ultra.family', password: 'FamilyOS!2026' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'guest@ultra.family', password: 'AnotherGuest!2026' })
      .expect(200);
  });
});
