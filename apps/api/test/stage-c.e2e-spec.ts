import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DatabaseService } from '../src/db/database.service';
import { createTestApp, householdSpaces, login, type TestAccount } from './test-app';

let app: INestApplication;
let owner: TestAccount;
let adult: TestAccount;
let child: TestAccount;
let guest: TestAccount;
let ownerSpace = '';
let adultSpace = '';
let chatId = '';
let messageId = '';

beforeAll(async () => {
  app = await createTestApp();
  owner = await login(app, 'owner@ultra.family');
  adult = await login(app, 'adult@ultra.family');
  child = await login(app, 'child@ultra.family');
  guest = await login(app, 'guest@ultra.family');
  ownerSpace = householdSpaces(owner).find((space) => space.name === 'Дом Палермо')!.id;
  adultSpace = householdSpaces(adult).find((space) => space.name === 'Дом Катании')!.id;
});

afterAll(async () => {
  await app?.close();
});

describe('Stage C messenger', () => {
  it('creates chats, enforces membership and keeps direct chats unique', async () => {
    const created = await owner.agent
      .post('/api/messenger/chats')
      .set('x-csrf-token', owner.csrfToken)
      .send({
        spaceId: ownerSpace,
        kind: 'group',
        name: 'Семейный чат',
        topic: 'Новости дома',
        memberIds: [child.userId],
      })
      .expect(201);
    chatId = (created.body as { id: string }).id;
    expect(created.body).toMatchObject({ kind: 'group', name: 'Семейный чат' });
    expect((created.body as { members: unknown[] }).members).toHaveLength(2);

    const first = await owner.agent
      .post('/api/messenger/chats')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, kind: 'direct', memberIds: [child.userId] })
      .expect(201);
    const second = await owner.agent
      .post('/api/messenger/chats')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, kind: 'direct', memberIds: [child.userId] })
      .expect(201);
    expect((second.body as { id: string }).id).toBe((first.body as { id: string }).id);

    await adult.agent.get(`/api/messenger/chats?spaceId=${adultSpace}`).expect(200);
    await adult.agent
      .get(`/api/messenger/chats/${chatId}/messages?spaceId=${adultSpace}`)
      .expect(404);
  });

  it('sends idempotent messages with threads, reactions, pins and receipts', async () => {
    const payload = {
      spaceId: ownerSpace,
      body: 'Привет, семья!',
      clientKey: 'client-key-1',
    };
    const sent = await owner.agent
      .post(`/api/messenger/chats/${chatId}/messages`)
      .set('x-csrf-token', owner.csrfToken)
      .send(payload)
      .expect(201);
    messageId = (sent.body as { id: string }).id;

    const retried = await owner.agent
      .post(`/api/messenger/chats/${chatId}/messages`)
      .set('x-csrf-token', owner.csrfToken)
      .send(payload)
      .expect(201);
    expect((retried.body as { id: string }).id).toBe(messageId);

    const reply = await owner.agent
      .post(`/api/messenger/chats/${chatId}/messages`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, body: 'Ответ в теме', threadRootId: messageId })
      .expect(201);
    const replyId = (reply.body as { id: string }).id;

    const reaction = await owner.agent
      .post(`/api/messenger/messages/${messageId}/reactions`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, chatId, emoji: '👍' })
      .expect(201);
    expect(reaction.body.active).toBe(true);

    await owner.agent
      .post(`/api/messenger/messages/${messageId}/pin`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, chatId, pinned: true })
      .expect(201);
    const pinned = await owner.agent
      .get(`/api/messenger/chats/${chatId}/pinned?spaceId=${ownerSpace}`)
      .expect(200);
    expect(pinned.body).toHaveLength(1);

    const thread = await owner.agent
      .get(`/api/messenger/chats/${chatId}/threads/${messageId}?spaceId=${ownerSpace}`)
      .expect(200);
    expect(thread.body.root.id).toBe(messageId);
    expect(thread.body.replies).toHaveLength(1);
    expect(thread.body.replies[0].id).toBe(replyId);

    const edited = await owner.agent
      .patch(`/api/messenger/messages/${messageId}`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, chatId, body: 'Привет, семья! (изменено)' })
      .expect(200);
    expect(edited.body.version).toBe(2);

    const versions = await owner.agent
      .get(`/api/messenger/messages/${messageId}/versions?spaceId=${ownerSpace}&chatId=${chatId}`)
      .expect(200);
    expect(versions.body).toHaveLength(2);

    const read = await owner.agent
      .post(`/api/messenger/chats/${chatId}/read`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace })
      .expect(201);
    expect(read.body).toHaveProperty('readAt');

    const search = await owner.agent
      .get(`/api/messenger/search?spaceId=${ownerSpace}&q=семья`)
      .expect(200);
    expect(search.body.length).toBeGreaterThan(0);
  });

  it('denies the messenger to guests and keeps children inside their chats', async () => {
    await guest.agent.get(`/api/messenger/chats?spaceId=${ownerSpace}`).expect(403);

    const childChats = await child.agent
      .get(`/api/messenger/chats?spaceId=${ownerSpace}`)
      .expect(200);
    expect(childChats.body.length).toBeGreaterThan(0);

    const deleted = await child.agent
      .delete(`/api/messenger/messages/${messageId}?spaceId=${ownerSpace}&chatId=${chatId}`)
      .set('x-csrf-token', child.csrfToken)
      .expect(403);
    expect(deleted.body.message).toContain('access_denied');
  });
});

describe('Stage C family feed, polls and decisions', () => {
  it('publishes feed posts with comments and reactions', async () => {
    const created = await owner.agent
      .post('/api/feed/posts')
      .set('x-csrf-token', owner.csrfToken)
      .send({
        spaceId: ownerSpace,
        kind: 'news',
        title: 'Новости дома',
        body: 'Все здоровы.',
        tags: ['дом'],
      })
      .expect(201);
    const postId = (created.body as { id: string }).id;

    await owner.agent
      .post(`/api/feed/posts/${postId}/comments`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, body: 'Отлично!' })
      .expect(201);
    await owner.agent
      .post(`/api/feed/posts/${postId}/reactions`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, emoji: '❤️' })
      .expect(201);

    const posts = await owner.agent.get(`/api/feed/posts?spaceId=${ownerSpace}`).expect(200);
    const post = posts.body.find((entry: { id: string }) => entry.id === postId);
    expect(post.comments).toHaveLength(1);
    expect(post.reactions).toHaveLength(1);

    const searched = await owner.agent
      .get(`/api/feed/posts?spaceId=${ownerSpace}&q=здоровы`)
      .expect(200);
    expect(searched.body.length).toBe(1);

    const adultPosts = await adult.agent.get(`/api/feed/posts?spaceId=${adultSpace}`).expect(200);
    expect(adultPosts.body.some((entry: { id: string }) => entry.id === postId)).toBe(false);
  });

  it('collects poll votes, enforces quorum and writes decision history', async () => {
    const poll = await owner.agent
      .post('/api/decisions/polls')
      .set('x-csrf-token', owner.csrfToken)
      .send({
        spaceId: ownerSpace,
        kind: 'simple',
        question: 'Куда поедем летом?',
        options: [
          { key: 'sea', label: 'Море' },
          { key: 'mountains', label: 'Горы' },
        ],
        quorumPercent: 50,
        votingRule: 'majority',
      })
      .expect(201);
    const pollId = (poll.body as { id: string }).id;
    expect(poll.body.status).toBe('open');

    await owner.agent
      .post(`/api/decisions/polls/${pollId}/votes`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, optionKeys: ['sea'] })
      .expect(201);

    await child.agent
      .post(`/api/decisions/polls/${pollId}/votes`)
      .set('x-csrf-token', child.csrfToken)
      .send({ spaceId: ownerSpace, optionKeys: ['mountains'] })
      .expect(201);

    await owner.agent
      .post(`/api/decisions/polls/${pollId}/votes`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, optionKeys: ['unknown'] })
      .expect(400);

    // One vote per option means a tie: the poll must not invent a winner.
    const tied = await owner.agent
      .post(`/api/decisions/polls/${pollId}/close`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, reason: 'e2e' })
      .expect(201);
    expect(tied.body.status).toBe('closed');
    expect(tied.body.winningOptionKey).toBeNull();

    await owner.agent
      .post(`/api/decisions/polls/${pollId}/votes`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, optionKeys: ['sea'] })
      .expect(400);

    const proposal = await owner.agent
      .post('/api/decisions/proposals')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, title: 'Купить велосипед', body: 'Обсуждение' })
      .expect(201);
    const proposalId = (proposal.body as { id: string }).id;

    await owner.agent
      .post(`/api/decisions/proposals/${proposalId}/votes`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, choice: 'yes' })
      .expect(400);

    await owner.agent
      .post(`/api/decisions/proposals/${proposalId}/status`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, status: 'voting' })
      .expect(201);
    await owner.agent
      .post(`/api/decisions/proposals/${proposalId}/votes`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, choice: 'yes', comment: 'Согласен' })
      .expect(201);

    const decided = await owner.agent
      .post(`/api/decisions/proposals/${proposalId}/decide`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace })
      .expect(201);
    expect(['accepted', 'rejected']).toContain(decided.body.status);

    const history = await owner.agent
      .get(`/api/decisions/history?spaceId=${ownerSpace}`)
      .expect(200);
    expect(history.body.length).toBeGreaterThan(2);

    const governance = await owner.agent
      .patch('/api/decisions/governance')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, quorumPercent: 60, votingRule: 'two_thirds' })
      .expect(200);
    expect(governance.body).toMatchObject({ quorumPercent: 60, votingRule: 'two_thirds' });

    await child.agent
      .patch('/api/decisions/governance')
      .set('x-csrf-token', child.csrfToken)
      .send({ spaceId: ownerSpace, quorumPercent: 10 })
      .expect(403);
  });

  it('hides gift reservations from the wishlist owner', async () => {
    const wishlist = await owner.agent
      .post('/api/decisions/wishlists')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, title: 'День рождения', ownerUserId: owner.userId })
      .expect(201);
    const wishlistId = (wishlist.body as { id: string }).id;

    const item = await owner.agent
      .post(`/api/decisions/wishlists/${wishlistId}/items`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, title: 'Наушники', priceCents: 9900 })
      .expect(201);
    const itemId = (item.body as { id: string }).id;

    await owner.agent
      .patch(`/api/decisions/wishlists/${wishlistId}/items/${itemId}`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, reserved: true })
      .expect(403);

    const lists = await owner.agent
      .get(`/api/decisions/wishlists?spaceId=${ownerSpace}`)
      .expect(200);
    const list = lists.body.find((entry: { id: string }) => entry.id === wishlistId);
    expect(list.items).toHaveLength(1);
  });
});

describe('Stage C documents and collaboration', () => {
  it('versions documents, restores old text and keeps comments open/closed', async () => {
    const created = await owner.agent
      .post('/api/documents')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, title: 'План недели', template: 'checklist' })
      .expect(201);
    const documentId = (created.body as { id: string }).id;
    expect(created.body.myPermission).toBe('edit');

    const saved = await owner.agent
      .post(`/api/documents/${documentId}/content`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, content: 'Новый текст', expectedVersion: 1 })
      .expect(201);
    expect(saved.body.version).toBe(2);

    await owner.agent
      .post(`/api/documents/${documentId}/content`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, content: 'Устаревший текст', expectedVersion: 1 })
      .expect(409);

    const versions = await owner.agent
      .get(`/api/documents/${documentId}/versions?spaceId=${ownerSpace}`)
      .expect(200);
    expect(versions.body.length).toBeGreaterThanOrEqual(2);

    const restored = await owner.agent
      .post(`/api/documents/${documentId}/restore`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, version: 1 })
      .expect(201);
    expect(restored.body.version).toBe(3);

    const comment = await owner.agent
      .post(`/api/documents/${documentId}/comments`)
      .set('x-csrf-token', owner.csrfToken)
      .send({
        spaceId: ownerSpace,
        body: 'Проверить пункт',
        anchor: { from: 0, to: 5, quote: 'Новый' },
      })
      .expect(201);
    await owner.agent
      .post(`/api/documents/${documentId}/comments/${comment.body.id}/resolve`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, resolved: true })
      .expect(201);

    const detail = await owner.agent
      .get(`/api/documents/${documentId}?spaceId=${ownerSpace}`)
      .expect(200);
    expect(detail.body.openCommentCount).toBe(0);
    expect(detail.body.commentCount).toBe(1);

    await child.agent
      .patch(`/api/documents/${documentId}`)
      .set('x-csrf-token', child.csrfToken)
      .send({ spaceId: ownerSpace, title: 'Попытка ребёнка' })
      .expect(403);

    const list = await owner.agent.get(`/api/documents?spaceId=${ownerSpace}`).expect(200);
    expect(list.body.some((entry: { id: string }) => entry.id === documentId)).toBe(true);
  });

  it('creates call rooms, tracks participants and reports TURN diagnostics honestly', async () => {
    const room = await owner.agent
      .post('/api/calls/rooms')
      .set('x-csrf-token', owner.csrfToken)
      .send({
        spaceId: ownerSpace,
        name: 'Вечерний звонок',
        kind: 'video',
        inviteUserIds: [child.userId],
      })
      .expect(201);
    const roomId = (room.body as { id: string }).id;
    expect(room.body.participants.length).toBe(2);
    expect(room.body.turnConfigured).toBe(false);

    await owner.agent
      .post(`/api/calls/rooms/${roomId}/state`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, audio: false, video: false, connectionState: 'connected' })
      .expect(201);

    const diagnostics = await owner.agent
      .get(`/api/calls/rooms/${roomId}/diagnostics?spaceId=${ownerSpace}`)
      .expect(200);
    expect(diagnostics.body.warnings).toContain('turn_not_configured');
    expect(diagnostics.body.iceServers[0].urls.length).toBeGreaterThan(0);

    const signals = await owner.agent
      .get(`/api/calls/rooms/${roomId}/signals?spaceId=${ownerSpace}`)
      .expect(200);
    expect(Array.isArray(signals.body)).toBe(true);

    await guest.agent.get(`/api/calls/rooms/${roomId}?spaceId=${ownerSpace}`).expect(403);

    await owner.agent
      .post(`/api/calls/rooms/${roomId}/close`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace })
      .expect(201);
  });

  it('activates Stage C modules on upgraded databases only where the owner did not decide', async () => {
    const db = app.get(DatabaseService);
    const rows = await db.query<{ module_id: string; enabled: boolean }>(
      `SELECT module_id, enabled FROM module_toggles
       WHERE space_id = $1 AND module_id IN ('messenger','feed','decisions','documents','calls')
       ORDER BY module_id`,
      [ownerSpace],
    );
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.enabled)).toBe(true);
    const migrations = await db.query<{ version: string }>(
      `SELECT version FROM schema_migrations WHERE version = '005_stage_c'`,
    );
    expect(migrations).toHaveLength(1);
  });
});
