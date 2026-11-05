import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { createTestApp, householdSpaces, login, type TestAccount } from './test-app';

let app: INestApplication;
let port = 0;
let owner: TestAccount;
let child: TestAccount;
let ownerSpace = '';

interface Frame {
  type: string;
  [key: string]: unknown;
}

class TestSocket {
  readonly socket: WebSocket;
  private readonly queue: Frame[] = [];
  private readonly waiters: Array<(frame: Frame) => void> = [];

  constructor(url: string, cookie: string) {
    this.socket = new WebSocket(url, { headers: { cookie } });
    this.socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.queue.push(frame);
    });
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
  }

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  next(timeoutMs = 4000): Promise<Frame> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for frame')), timeoutMs);
      this.waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }

  /** Waits for the first frame of a type, ignoring unrelated broadcasts. */
  async nextOfType(type: string, timeoutMs = 4000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    const skipped: string[] = [];
    while (Date.now() < deadline) {
      const frame = await this.next(Math.max(deadline - Date.now(), 200)).catch(() => null);
      if (!frame) break;
      if (frame.type === type) return frame;
      skipped.push(JSON.stringify(frame).slice(0, 200));
    }
    throw new Error(`no ${type} frame received; saw: ${skipped.join(' | ')}`);
  }

  closed(): Promise<number> {
    return new Promise((resolve) => {
      if (this.socket.readyState === WebSocket.CLOSED) {
        resolve(this.socket.readyState);
        return;
      }
      this.socket.once('close', (code) => resolve(code));
    });
  }

  close(): void {
    this.socket.close();
  }
}

async function loginCookie(account: string): Promise<{ cookie: string; csrfToken: string; userId: string }> {
  const response = await request(app.getHttpServer())
    .post('/api/auth/login')
    .send({ email: account, password: 'FamilyOS!2026' })
    .expect(200);
  const raw = response.headers['set-cookie'] as unknown as string[];
  const cookie = raw.map((entry) => entry.split(';')[0]).join('; ');
  return { cookie, csrfToken: response.body.csrfToken as string, userId: response.body.user.id as string };
}

beforeAll(async () => {
  app = await createTestApp();
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  port = typeof address === 'object' && address ? address.port : 0;
  owner = await login(app, 'owner@ultra.family');
  child = await login(app, 'child@ultra.family');
  ownerSpace = householdSpaces(owner).find((space) => space.name === 'Дом Палермо')!.id;
});

afterAll(async () => {
  await app?.close();
});

describe('Stage C realtime gateway', () => {
  it('rejects anonymous WebSocket clients', async () => {
    const socket = new TestSocket(`ws://127.0.0.1:${port}/ws`, 'ufos_session=invalid');
    await socket.open();
    const error = await socket.next();
    expect(error).toMatchObject({ type: 'error', code: 'authentication_required' });
    expect(await socket.closed()).toBe(4401);
  });

  it('requires the CSRF handshake token before subscribing', async () => {
    const ownerLogin = await loginCookie('owner@ultra.family');
    const socket = new TestSocket(`ws://127.0.0.1:${port}/ws`, ownerLogin.cookie);
    await socket.open();
    socket.send({ type: 'hello', spaceId: ownerSpace, csrfToken: 'wrong-token' });
    const error = await socket.nextOfType('error');
    expect(error.code).toBe('csrf_token_invalid');
    expect(await socket.closed()).toBe(4403);
  });

  it('accepts a valid hello, filters topics by permission and reports presence', async () => {
    const ownerLogin = await loginCookie('owner@ultra.family');
    const socket = new TestSocket(`ws://127.0.0.1:${port}/ws`, ownerLogin.cookie);
    await socket.open();
    socket.send({ type: 'hello', spaceId: ownerSpace, csrfToken: ownerLogin.csrfToken });
    const ready = await socket.nextOfType('ready');
    expect(ready.spaceId).toBe(ownerSpace);

    socket.send({ type: 'subscribe', topics: ['messenger', 'documents', 'vault', 'calls'] });
    const subscribed = await socket.nextOfType('ready');
    expect(subscribed.topics).toEqual(expect.arrayContaining(['messenger', 'documents', 'calls']));
    expect(subscribed.topics).not.toContain('vault');

    socket.send({ type: 'ping' });
    const pong = await socket.nextOfType('pong');
    expect(typeof pong.at).toBe('string');

    socket.send({ type: 'presence', status: 'away' });
    const presence = await socket.nextOfType('presence:list');
    expect(Array.isArray(presence.users)).toBe(true);
    expect(
      (presence.users as Array<{ userId: string; status: string }>).some(
        (entry) => entry.userId === owner.userId && entry.status === 'away',
      ),
    ).toBe(true);
    socket.close();
    await socket.closed();
  });

  it('synchronises Yjs document updates, persists them and broadcasts cursors', async () => {
    const created = await owner.agent
      .post('/api/documents')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, title: 'Совместная заметка', content: '' })
      .expect(201);
    const documentId = (created.body as { id: string }).id;

    const ownerLogin = await loginCookie('owner@ultra.family');
    const adultLike = await loginCookie('child@ultra.family');

    const writer = new TestSocket(`ws://127.0.0.1:${port}/ws`, ownerLogin.cookie);
    await writer.open();
    writer.send({ type: 'hello', spaceId: ownerSpace, csrfToken: ownerLogin.csrfToken });
    await writer.nextOfType('ready');

    const reader = new TestSocket(`ws://127.0.0.1:${port}/ws`, adultLike.cookie);
    await reader.open();
    reader.send({ type: 'hello', spaceId: ownerSpace, csrfToken: adultLike.csrfToken });
    await reader.nextOfType('ready');

    // The child has no edit grant on this document, so updates are refused.
    const clientDoc = new Y.Doc();
    clientDoc.getText('content').insert(0, 'Текст от ребёнка');
    reader.send({
      type: 'doc:sync',
      documentId,
      update: Buffer.from(Y.encodeStateAsUpdate(clientDoc)).toString('base64'),
    });
    const rejected = await reader.nextOfType('doc:rejected');
    expect(rejected.reason).toBe('document_write_denied');

    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'Семейный план');
    writer.send({
      type: 'doc:sync',
      documentId,
      update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
      syncId: 'sync-1',
    });

    const joinState = await writer.nextOfType('doc:state');
    expect(joinState.reason).toBe('join');
    const state = await writer.nextOfType('doc:state');
    expect(state.reason).toBe('ack');
    const hydrated = new Y.Doc();
    Y.applyUpdate(hydrated, new Uint8Array(Buffer.from(state.update as string, 'base64')));
    expect(hydrated.getText('content').toString()).toContain('Семейный план');

    reader.send({ type: 'cursor', documentId, anchor: 3, head: 7, editing: true });

    writer.send({ type: 'cursor', documentId, anchor: 1, head: 2, editing: true });
    // Reader has read access, so it receives the writer's cursor.
    const receivedCursor = await reader.nextOfType('cursor');
    expect(receivedCursor).toMatchObject({ documentId, anchor: 1, head: 2, editing: true });

    // Debounced persistence writes the collaborative text into the document.
    let persisted = '';
    for (let attempt = 0; attempt < 20 && !persisted.includes('Семейный план'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const detail = await owner.agent
        .get(`/api/documents/${documentId}?spaceId=${ownerSpace}`)
        .expect(200);
      persisted = detail.body.content as string;
    }
    expect(persisted).toContain('Семейный план');

    const versions = await owner.agent
      .get(`/api/documents/${documentId}/versions?spaceId=${ownerSpace}`)
      .expect(200);
    expect(versions.body.length).toBeGreaterThanOrEqual(1);

    writer.close();
    reader.close();
  });

  it('relays WebRTC signaling between participants and records call state', async () => {
    const room = await owner.agent
      .post('/api/calls/rooms')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, name: 'Тестовый звонок', kind: 'audio', inviteUserIds: [child.userId] })
      .expect(201);
    const roomId = (room.body as { id: string }).id;

    const ownerLogin = await loginCookie('owner@ultra.family');
    const childLogin = await loginCookie('child@ultra.family');
    const host = new TestSocket(`ws://127.0.0.1:${port}/ws`, ownerLogin.cookie);
    await host.open();
    host.send({ type: 'hello', spaceId: ownerSpace, csrfToken: ownerLogin.csrfToken });
    await host.nextOfType('ready');

    const peer = new TestSocket(`ws://127.0.0.1:${port}/ws`, childLogin.cookie);
    await peer.open();
    peer.send({ type: 'hello', spaceId: ownerSpace, csrfToken: childLogin.csrfToken });
    await peer.nextOfType('ready');

    host.send({
      type: 'call:signal',
      roomId,
      to: childLogin.userId,
      kind: 'offer',
      payload: { sdp: 'v=0', type: 'offer' },
    });
    const offer = await peer.nextOfType('call:signal');
    expect(offer).toMatchObject({ roomId, from: ownerLogin.userId, kind: 'offer' });
    expect(offer.payload).toMatchObject({ sdp: 'v=0' });

    host.send({
      type: 'call:state',
      roomId,
      audio: false,
      video: false,
      screen: false,
      connectionState: 'connected',
    });
    const state = await peer.nextOfType('call:state');
    expect(state).toMatchObject({ roomId, userId: ownerLogin.userId, connectionState: 'connected' });

    const pending = await owner.agent
      .get(`/api/calls/rooms/${roomId}/signals?spaceId=${ownerSpace}`)
      .expect(200);
    expect(Array.isArray(pending.body)).toBe(true);

    host.close();
    peer.close();
  });
});
