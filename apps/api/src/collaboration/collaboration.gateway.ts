import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { CollaborationClientMessage, CollaborationServerMessage } from '@ufos/contracts';
import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import * as Y from 'yjs';
import { AccessService } from '../access/access.service';
import { config } from '../config';
import type { AuthenticatedUser } from '../common/authed-request';
import { DatabaseService } from '../db/database.service';
import { DocumentsService } from '../documents/documents.service';
import { RealtimeService } from '../realtime/realtime.service';
import type { SessionRow } from '../db/rows';
import { SessionService } from '../auth/session.service';

interface ClientState {
  id: string;
  socket: WebSocket;
  user: AuthenticatedUser;
  session: SessionRow;
  spaceId: string;
  topics: Set<string>;
  documentId: string | null;
  /** Documents this client proved read access to (cursor/update fan-out). */
  readDocuments: Set<string>;
  alive: boolean;
  presenceStatus: 'active' | 'away';
}

interface DocumentRoom {
  documentId: string;
  spaceId: string;
  doc: Y.Doc;
  clients: Set<string>;
  saveTimer: NodeJS.Timeout | null;
  version: number;
}

const DOCUMENT_ORIGIN = 'server-hydration';
const MAX_FRAME_BYTES = 512 * 1024;
const SAVE_DEBOUNCE_MS = 1200;

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

function sameOrigin(request: IncomingMessage): boolean {
  if (config.appOrigins.length === 0) return true;
  const origin = request.headers.origin;
  return typeof origin === 'string' && config.appOrigins.includes(origin);
}

@Injectable()
export class CollaborationGateway implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CollaborationGateway.name);
  private server?: WebSocketServer;
  private heartbeat?: NodeJS.Timeout;
  private readonly clients = new Map<string, ClientState>();
  private readonly documents = new Map<string, DocumentRoom>();
  private readonly userSockets = new Map<string, Set<string>>();
  private counter = 0;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly sessions: SessionService,
    private readonly access: AccessService,
    private readonly documentsService: DocumentsService,
    private readonly realtime: RealtimeService,
    private readonly db: DatabaseService,
  ) {}

  onApplicationBootstrap(): void {
    const httpServer = this.adapterHost.httpAdapter?.getHttpServer() as
      (import('node:http').Server & { __ufosWsAttached?: boolean }) | undefined;
    if (!httpServer) return;
    this.server = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
    this.server.on('connection', (socket, request) => {
      void this.handleConnection(socket, request);
    });
    httpServer.on('upgrade', (request, socket, head) => {
      const url = request.url || '';
      if (!url.startsWith('/ws')) {
        socket.destroy();
        return;
      }
      if (!sameOrigin(request)) {
        socket.destroy();
        return;
      }
      this.server?.handleUpgrade(request, socket, head, (client) => {
        this.server?.emit('connection', client, request);
      });
    });
    this.heartbeat = setInterval(() => this.sweep(), 30_000);
    this.logger.log('Collaboration WebSocket gateway listening on /ws');
  }

  onModuleDestroy(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const room of this.documents.values()) {
      if (room.saveTimer) clearTimeout(room.saveTimer);
      room.doc.destroy();
    }
    this.documents.clear();
    this.clients.forEach((client) => client.socket.close(1001, 'shutdown'));
    this.server?.close();
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  private async handleConnection(socket: WebSocket, request: IncomingMessage): Promise<void> {
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies[config.sessionCookieName];
    const resolved = token ? await this.sessions.resolve(token) : null;
    if (!resolved) {
      this.send(socket, { type: 'error', code: 'authentication_required' });
      socket.close(4401, 'authentication_required');
      return;
    }
    const id = `ws_${++this.counter}`;
    const state: ClientState = {
      id,
      socket,
      user: resolved.user,
      session: resolved.session,
      spaceId: '',
      topics: new Set(),
      documentId: null,
      readDocuments: new Set<string>(),
      alive: true,
      presenceStatus: 'active',
    };
    this.clients.set(id, state);
    const sockets = this.userSockets.get(resolved.user.id) ?? new Set<string>();
    sockets.add(id);
    this.userSockets.set(resolved.user.id, sockets);

    // The client must still prove CSRF before subscribing: the cookie alone is
    // not enough for a state-changing realtime session.
    const query = new URL(request.url || '/ws', 'http://localhost').searchParams;
    const handshakeToken = query.get('csrfToken');
    if (handshakeToken && handshakeToken !== this.sessions.csrfToken(resolved.session.id)) {
      this.send(socket, { type: 'error', code: 'csrf_token_invalid' });
      socket.close(4403, 'csrf_token_invalid');
      return;
    }

    socket.on('message', (raw) => {
      void this.handleMessage(state, raw.toString());
    });
    socket.on('pong', () => {
      state.alive = true;
    });
    socket.on('close', () => {
      void this.handleClose(state);
    });
    socket.on('error', () => {
      void this.handleClose(state);
    });
    this.send(socket, { type: 'pong', at: new Date().toISOString() });
  }

  private async handleClose(state: ClientState): Promise<void> {
    this.clients.delete(state.id);
    const sockets = this.userSockets.get(state.user.id);
    sockets?.delete(state.id);
    if (sockets && sockets.size === 0) this.userSockets.delete(state.user.id);
    for (const room of this.documents.values()) {
      room.clients.delete(state.id);
      if (room.clients.size === 0) {
        await this.flushDocument(room);
        room.doc.destroy();
        this.documents.delete(room.documentId);
      }
    }
    if (state.spaceId) {
      this.realtime.publish(state.spaceId, 'collaboration', state.user.id, {
        action: 'presence.offline',
        userId: state.user.id,
      });
      await this.db
        .query('DELETE FROM collaboration_presence WHERE space_id = $1 AND user_id = $2', [
          state.spaceId,
          state.user.id,
        ])
        .catch(() => undefined);
    }
  }

  private sweep(): void {
    for (const client of this.clients.values()) {
      if (!client.alive) {
        client.socket.terminate();
        void this.handleClose(client);
        continue;
      }
      client.alive = false;
      try {
        client.socket.ping();
      } catch {
        client.socket.terminate();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Message dispatch
  // -------------------------------------------------------------------------

  private async handleMessage(state: ClientState, raw: string): Promise<void> {
    let message: CollaborationClientMessage;
    try {
      message = JSON.parse(raw) as CollaborationClientMessage;
    } catch {
      this.send(state.socket, { type: 'error', code: 'invalid_json' });
      return;
    }

    try {
      switch (message.type) {
        case 'ping':
          this.send(state.socket, { type: 'pong', at: new Date().toISOString() });
          return;
        case 'hello':
          await this.handleHello(state, message);
          return;
        case 'subscribe':
          await this.handleSubscribe(state, message.topics);
          return;
        case 'presence':
          await this.handlePresence(state, message);
          return;
        case 'cursor':
          await this.handleCursor(state, message);
          return;
        case 'doc:sync':
          await this.handleDocSync(state, message);
          return;
        case 'doc:request-state':
          await this.handleDocState(state, message.documentId);
          return;
        case 'call:signal':
          await this.handleSignal(state, message);
          return;
        case 'call:state':
          await this.handleCallState(state, message);
          return;
        default:
          this.send(state.socket, { type: 'error', code: 'unknown_message_type' });
      }
    } catch (error) {
      const code = error instanceof Error ? (error.message.split(':')[0] ?? 'error') : 'error';
      this.send(state.socket, { type: 'error', code });
    }
  }

  private async handleHello(
    state: ClientState,
    message: Extract<CollaborationClientMessage, { type: 'hello' }>,
  ): Promise<void> {
    if (message.csrfToken !== this.sessions.csrfToken(state.session.id)) {
      this.send(state.socket, { type: 'error', code: 'csrf_token_invalid' });
      state.socket.close(4403, 'csrf_token_invalid');
      return;
    }
    await this.access.assert(state.user.id, message.spaceId, 'dashboard', 'read');
    state.spaceId = message.spaceId;
    await this.db.query(
      `INSERT INTO collaboration_presence (space_id, user_id, status, last_seen_at)
       VALUES ($1,$2,'active',CURRENT_TIMESTAMP)
       ON CONFLICT (space_id, user_id) DO UPDATE SET
         status = 'active', last_seen_at = CURRENT_TIMESTAMP`,
      [message.spaceId, state.user.id],
    );
    this.send(state.socket, {
      type: 'ready',
      clientId: state.id,
      userId: state.user.id,
      spaceId: message.spaceId,
      topics: [...state.topics],
    });
    await this.broadcastPresence(state.spaceId);
    this.realtime.publish(state.spaceId, 'collaboration', state.user.id, {
      action: 'presence.online',
      userId: state.user.id,
    });
  }

  private async handleSubscribe(state: ClientState, topics: string[]): Promise<void> {
    if (!state.spaceId) throw new Error('hello_required');
    // A topic is only forwarded when the user can read the matching module.
    const allowed = new Set<string>();
    for (const topic of topics.slice(0, 20)) {
      const moduleId = topic.split('.')[0] ?? '';
      try {
        await this.access.assert(state.user.id, state.spaceId, moduleId, 'read');
        allowed.add(topic);
      } catch {
        // Silently drop topics the user has no access to.
      }
    }
    for (const topic of allowed) state.topics.add(topic);
    this.send(state.socket, {
      type: 'ready',
      clientId: state.id,
      userId: state.user.id,
      spaceId: state.spaceId,
      topics: [...state.topics],
    });
  }

  private async handlePresence(
    state: ClientState,
    message: Extract<CollaborationClientMessage, { type: 'presence' }>,
  ): Promise<void> {
    if (!state.spaceId) throw new Error('hello_required');
    state.presenceStatus = message.status;
    await this.db.query(
      `UPDATE collaboration_presence SET status = $3, last_seen_at = CURRENT_TIMESTAMP
       WHERE space_id = $1 AND user_id = $2`,
      [state.spaceId, state.user.id, message.status],
    );
    await this.broadcastPresence(state.spaceId);
  }

  private async broadcastPresence(spaceId: string): Promise<void> {
    const rows = await this.db.query<{
      user_id: string;
      display_name: string;
      status: string;
      last_seen_at: Date | string;
    }>(
      `SELECT p.user_id, u.display_name, p.status, p.last_seen_at
       FROM collaboration_presence p JOIN users u ON u.id = p.user_id
       WHERE p.space_id = $1 AND p.last_seen_at > CURRENT_TIMESTAMP - INTERVAL '2 minutes'`,
      [spaceId],
    );
    const users = rows.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      status: row.status,
      lastSeenAt:
        row.last_seen_at instanceof Date
          ? row.last_seen_at.toISOString()
          : String(row.last_seen_at),
    }));
    for (const client of this.clients.values()) {
      if (client.spaceId !== spaceId) continue;
      this.send(client.socket, { type: 'presence:list', spaceId, users });
    }
  }

  // -------------------------------------------------------------------------
  // Collaborative cursors
  // -------------------------------------------------------------------------

  private async handleCursor(
    state: ClientState,
    message: Extract<CollaborationClientMessage, { type: 'cursor' }>,
  ): Promise<void> {
    if (!state.spaceId) throw new Error('hello_required');
    await this.documentsService.checkReadAccess(state.user, state.spaceId, message.documentId);
    state.readDocuments.add(message.documentId);
    await this.documentsService.recordPresence(
      message.documentId,
      state.user.id,
      { anchor: message.anchor, head: message.head },
      message.editing ?? false,
    );
    for (const client of this.clients.values()) {
      if (client.id === state.id) continue;
      if (client.spaceId !== state.spaceId) continue;
      if (!client.readDocuments.has(message.documentId)) continue;
      this.send(client.socket, {
        type: 'cursor',
        documentId: message.documentId,
        userId: state.user.id,
        displayName: state.user.displayName,
        anchor: message.anchor,
        head: message.head,
        editing: message.editing ?? false,
        at: new Date().toISOString(),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Yjs document synchronisation
  // -------------------------------------------------------------------------

  private async handleDocState(state: ClientState, documentId: string): Promise<void> {
    if (!state.spaceId) throw new Error('hello_required');
    await this.documentsService.checkReadAccess(state.user, state.spaceId, documentId);
    state.readDocuments.add(documentId);
    const room = await this.ensureRoom(state.spaceId, documentId);
    this.send(state.socket, {
      type: 'doc:state',
      documentId,
      update: Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString('base64'),
      version: room.version,
      reason: 'request',
    });
  }

  private async handleDocSync(
    state: ClientState,
    message: Extract<CollaborationClientMessage, { type: 'doc:sync' }>,
  ): Promise<void> {
    if (!state.spaceId) throw new Error('hello_required');
    let room: DocumentRoom;
    try {
      const access = await this.documentsService.checkEditAccess(
        state.user,
        state.spaceId,
        message.documentId,
      );
      if (!access.permission) throw new Error('document_write_denied');
      room = await this.ensureRoom(state.spaceId, message.documentId);
      room.clients.add(state.id);
      state.documentId = message.documentId;
      state.readDocuments.add(message.documentId);
      // Send the authoritative state so the client converges on join/reconnect.
      this.send(state.socket, {
        type: 'doc:state',
        documentId: message.documentId,
        update: Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString('base64'),
        version: room.version,
        reason: 'join',
      });
    } catch {
      this.send(state.socket, {
        type: 'doc:rejected',
        documentId: message.documentId,
        reason: 'document_write_denied',
      });
      return;
    }

    let update: Uint8Array;
    try {
      update = new Uint8Array(Buffer.from(message.update, 'base64'));
    } catch {
      this.send(state.socket, {
        type: 'doc:rejected',
        documentId: message.documentId,
        reason: 'invalid_update',
      });
      return;
    }
    if (update.byteLength > MAX_FRAME_BYTES) {
      this.send(state.socket, {
        type: 'doc:rejected',
        documentId: message.documentId,
        reason: 'update_too_large',
      });
      return;
    }

    try {
      Y.applyUpdate(room.doc, update, state.user.id);
    } catch {
      this.send(state.socket, {
        type: 'doc:rejected',
        documentId: message.documentId,
        reason: 'malformed_update',
      });
      return;
    }

    // Acknowledge with the merged state so a reconnecting client converges and
    // the sender can confirm that its update was accepted.
    this.send(state.socket, {
      type: 'doc:state',
      documentId: message.documentId,
      update: Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString('base64'),
      version: room.version,
      reason: 'ack',
    });
    for (const client of this.clients.values()) {
      if (client.id === state.id) continue;
      if (client.spaceId !== room.spaceId) continue;
      if (!client.readDocuments.has(message.documentId)) continue;
      this.send(client.socket, {
        type: 'doc:update',
        documentId: message.documentId,
        update: message.update,
        actorUserId: state.user.id,
        syncId: message.syncId,
      });
    }
    this.scheduleSave(room);
  }

  private async ensureRoom(spaceId: string, documentId: string): Promise<DocumentRoom> {
    const existing = this.documents.get(documentId);
    if (existing) return existing;
    // Hydration is a server-side read of the stored snapshot; the acting user's
    // permission was already verified by the caller.
    const stored = await this.db.queryOne<{
      content: string;
      yjs_state: string | null;
      version: number | string;
    }>('SELECT content, yjs_state, version FROM documents WHERE id = $1 AND space_id = $2', [
      documentId,
      spaceId,
    ]);
    const doc = new Y.Doc();
    const room: DocumentRoom = {
      documentId,
      spaceId,
      doc,
      clients: new Set<string>(),
      saveTimer: null,
      version: Number(stored?.version ?? 1),
    };
    if (stored?.yjs_state) {
      try {
        Y.applyUpdate(
          doc,
          new Uint8Array(Buffer.from(stored.yjs_state, 'base64')),
          DOCUMENT_ORIGIN,
        );
      } catch {
        this.seedFromText(doc, stored.content);
      }
    } else {
      this.seedFromText(doc, stored?.content ?? '');
    }
    this.documents.set(documentId, room);
    return room;
  }

  private seedFromText(doc: Y.Doc, content: string): void {
    if (!content) return;
    doc.getText('content').insert(0, content, DOCUMENT_ORIGIN);
  }

  private scheduleSave(room: DocumentRoom): void {
    if (room.saveTimer) clearTimeout(room.saveTimer);
    room.saveTimer = setTimeout(() => {
      void this.flushDocument(room);
    }, SAVE_DEBOUNCE_MS);
  }

  private async flushDocument(room: DocumentRoom): Promise<void> {
    room.saveTimer = null;
    const text = room.doc.getText('content').toString();
    const state = Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString('base64');
    try {
      const stored = await this.db.queryOne<{ content: string; version: number | string }>(
        'SELECT content, version FROM documents WHERE id = $1',
        [room.documentId],
      );
      if (!stored) return;
      if (stored.content === text) {
        await this.db.query('UPDATE documents SET yjs_state = $2 WHERE id = $1', [
          room.documentId,
          state,
        ]);
        return;
      }
      const version = Number(stored.version ?? 1) + 1;
      await this.db.query(
        `UPDATE documents SET content = $2, yjs_state = $3, version = $4,
           updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [room.documentId, text, state, version],
      );
      await this.db.query(
        `INSERT INTO document_versions (id, document_id, version, title, content, note)
         SELECT $1, $2, $3, title, $4, 'collab'
         FROM documents WHERE id = $2
         ON CONFLICT (document_id, version) DO NOTHING`,
        [`dvr_${crypto.randomUUID()}`, room.documentId, version, text],
      );
      room.version = version;
      this.realtime.publish(room.spaceId, 'documents', null, {
        action: 'document.persisted',
        documentId: room.documentId,
        version,
      });
    } catch {
      // Persistence retries on the next edit; the in-memory doc stays alive.
    }
  }

  // -------------------------------------------------------------------------
  // WebRTC signaling
  // -------------------------------------------------------------------------

  private async handleSignal(
    state: ClientState,
    message: Extract<CollaborationClientMessage, { type: 'call:signal' }>,
  ): Promise<void> {
    if (!state.spaceId) throw new Error('hello_required');
    await this.access.assert(state.user.id, state.spaceId, 'calls', 'read');
    const payload = JSON.parse(JSON.stringify(message.payload ?? {})) as Record<string, unknown>;
    for (const clientId of this.userSockets.get(message.to) ?? []) {
      const target = this.clients.get(clientId);
      if (!target) continue;
      this.send(target.socket, {
        type: 'call:signal',
        roomId: message.roomId,
        from: state.user.id,
        kind: message.kind,
        payload,
      });
    }
    // Always persist the frame so a peer that reconnects or uses the HTTP
    // fallback still receives it exactly once.
    await this.db.query(
      `INSERT INTO call_signals (id, room_id, from_user_id, to_user_id, kind, payload)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        `sig_${crypto.randomUUID()}`,
        message.roomId,
        state.user.id,
        message.to,
        message.kind,
        JSON.stringify(payload),
      ],
    );
  }

  private async handleCallState(
    state: ClientState,
    message: Extract<CollaborationClientMessage, { type: 'call:state' }>,
  ): Promise<void> {
    if (!state.spaceId) throw new Error('hello_required');
    await this.access.assert(state.user.id, state.spaceId, 'calls', 'read');
    const fields: string[] = [];
    const params: unknown[] = [message.roomId, state.user.id];
    const push = (column: string, value: unknown) => {
      params.push(value);
      fields.push(`${column} = $${params.length}`);
    };
    if (message.audio !== undefined) push('audio', message.audio);
    if (message.video !== undefined) push('video', message.video);
    if (message.screen !== undefined) push('screen', message.screen);
    if (message.connectionState !== undefined) push('connection_state', message.connectionState);
    if (message.quality !== undefined) push('quality', JSON.stringify(message.quality));
    fields.push('last_seen_at = CURRENT_TIMESTAMP');
    await this.db.query(
      `UPDATE call_participants SET ${fields.join(', ')} WHERE room_id = $1 AND user_id = $2`,
      params,
    );
    const rows = await this.db.query<{ user_id: string }>(
      'SELECT user_id FROM call_participants WHERE room_id = $1',
      [message.roomId],
    );
    for (const row of rows) {
      if (row.user_id === state.user.id) continue;
      for (const clientId of this.userSockets.get(row.user_id) ?? []) {
        const client = this.clients.get(clientId);
        if (!client) continue;
        this.send(client.socket, {
          type: 'call:state',
          roomId: message.roomId,
          userId: state.user.id,
          audio: message.audio ?? true,
          video: message.video ?? false,
          screen: message.screen ?? false,
          connectionState: message.connectionState ?? 'connected',
        });
      }
    }
  }

  private send(socket: WebSocket, message: CollaborationServerMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }
}
