'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import type { CollaborationClientMessage, CollaborationServerMessage } from '@ufos/contracts';
import { getCsrfToken } from '@/lib/api';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline';

type Handler = (message: CollaborationServerMessage) => void;

const HANDSHAKE_TIMEOUT_MS = 10_000;

interface SocketOptions {
  spaceId: string;
  topics: string[];
  onMessage?: Handler;
  onStatus?: (status: ConnectionStatus) => void;
}

/**
 * Thin client for the Stage C collaboration gateway (`/ws`).
 *
 * - the browser connects to the same origin it was served from, so the Next.js
 *   proxy / reverse proxy decides how to reach NestJS;
 * - reconnects use bounded exponential backoff and re-send `hello` (the session
 *   can have been revoked while the tab was asleep);
 * - every outbound message is a plain JSON frame, so a failed send is visible
 *   instead of silently dropped.
 */
class CollaborationSocket {
  private socket: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private handlers = new Set<Handler>();
  private statusHandlers = new Set<(status: ConnectionStatus) => void>();
  private status: ConnectionStatus = 'idle';
  private queue: CollaborationClientMessage[] = [];

  constructor(private options: SocketOptions) {}

  connect(): void {
    if (this.closed || typeof window === 'undefined') return;
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${protocol}://${window.location.host}/ws`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    // A proxy that accepts the TCP connection but never answers the upgrade
    // would otherwise keep the socket in CONNECTING forever. Give up after a
    // bounded handshake window and go through the normal reconnect path.
    if (this.openTimer) clearTimeout(this.openTimer);
    this.openTimer = setTimeout(() => {
      if (socket.readyState === WebSocket.CONNECTING) socket.close();
    }, HANDSHAKE_TIMEOUT_MS);
    socket.onopen = () => {
      if (this.openTimer) clearTimeout(this.openTimer);
      this.openTimer = null;
      this.attempt = 0;
      this.setStatus('connected');
      this.sendRaw({
        type: 'hello',
        spaceId: this.options.spaceId,
        csrfToken: getCsrfToken() ?? '',
      });
      if (this.options.topics.length > 0) {
        this.sendRaw({ type: 'subscribe', topics: this.options.topics });
      }
      for (const message of this.queue.splice(0)) this.sendRaw(message);
      this.startPing();
    };
    socket.onmessage = (event) => {
      let message: CollaborationServerMessage;
      try {
        message = JSON.parse(event.data as string) as CollaborationServerMessage;
      } catch {
        return;
      }
      if (message.type === 'error') return;
      for (const handler of this.handlers) handler(message);
    };
    socket.onclose = () => {
      if (this.openTimer) clearTimeout(this.openTimer);
      this.openTimer = null;
      this.stopPing();
      this.socket = null;
      if (this.closed) return;
      this.setStatus(navigator.onLine === false ? 'offline' : 'reconnecting');
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      socket.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.attempt = Math.min(this.attempt + 1, 6);
    const delay = Math.min(500 * 2 ** (this.attempt - 1), 15_000);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.sendRaw({ type: 'ping' }), 25_000);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  send(message: CollaborationClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      // Only idempotent-safe frames are queued; document updates are re-sent
      // from the local Y.Doc on reconnect, so they are not buffered twice.
      if (message.type !== 'doc:sync') this.queue.push(message);
      return false;
    }
    return this.sendRaw(message);
  }

  private sendRaw(message: CollaborationClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  onMessage(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onStatus(handler: (status: ConnectionStatus) => void): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    for (const handler of this.statusHandlers) handler(status);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.openTimer) clearTimeout(this.openTimer);
    this.stopPing();
    this.socket?.close(1000, 'client_close');
    this.socket = null;
  }
}

export function useCollaboration(spaceId: string | undefined, topics: string[]) {
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const clientRef = useRef<CollaborationSocket | null>(null);
  const handlerRef = useRef<Handler | null>(null);
  const topicsKey = topics.join(',');

  useEffect(() => {
    if (!spaceId) return;
    const client = new CollaborationSocket({
      spaceId,
      topics: topicsKey.split(',').filter(Boolean),
    });
    clientRef.current = client;
    const unsubscribeStatus = client.onStatus(setStatus);
    const unsubscribeMessage = client.onMessage((message) => handlerRef.current?.(message));
    client.connect();
    const onOnline = () => client.connect();
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('online', onOnline);
      unsubscribeStatus();
      unsubscribeMessage();
      client.close();
      clientRef.current = null;
    };
  }, [spaceId, topicsKey]);

  const send = useCallback((message: CollaborationClientMessage) => {
    return clientRef.current?.send(message) ?? false;
  }, []);

  const onMessage = useCallback((handler: Handler) => {
    handlerRef.current = handler;
    return () => {
      handlerRef.current = null;
    };
  }, []);

  return { status, send, onMessage };
}

export interface RemoteCursor {
  userId: string;
  displayName: string;
  anchor: number;
  head: number;
  editing: boolean;
  at: string;
}

/**
 * Binds a Y.Doc to a document over the collaboration socket.
 *
 * Local edits are sent as Yjs updates; remote updates and the authoritative
 * state are applied back. On reconnect the client re-sends its full state so
 * nothing is lost when the network drops mid-edit. `version` comes from the
 * server and is used only for display — never to overwrite newer text.
 */
export function useCollaborativeDocument(
  spaceId: string | undefined,
  documentId: string | null,
  options: { canEdit: boolean; onRemoteChange?: () => void } = { canEdit: false },
) {
  const docRef = useRef<Y.Doc | null>(null);
  if (!docRef.current) docRef.current = new Y.Doc();
  const doc = docRef.current;
  const [text, setText] = useState('');
  const [remoteCursors, setRemoteCursors] = useState<Record<string, RemoteCursor>>({});
  const [version, setVersion] = useState(0);
  const [rejected, setRejected] = useState<string | null>(null);
  const [synced, setSynced] = useState(false);
  const { status, send, onMessage } = useCollaboration(spaceId, ['documents']);
  const applyingRemote = useRef(false);
  const ytext = doc.getText('content');

  useEffect(() => {
    const observer = () => {
      setText(ytext.toString());
      if (applyingRemote.current) return;
      if (!documentId || !options.canEdit) return;
      send({
        type: 'doc:sync',
        documentId,
        update: bytesToBase64(Y.encodeStateAsUpdate(doc)),
      });
    };
    ytext.observe(observer);
    setText(ytext.toString());
    return () => ytext.unobserve(observer);
  }, [doc, documentId, options.canEdit, send, ytext]);

  useEffect(() => {
    if (!documentId) return;
    return onMessage((message) => {
      if (!('documentId' in message) || message.documentId !== documentId) return;
      if (message.type === 'doc:state') {
        applyingRemote.current = true;
        try {
          Y.applyUpdate(doc, base64ToBytes(message.update), 'remote');
        } finally {
          applyingRemote.current = false;
        }
        setSynced(true);
        setVersion(message.version);
        options.onRemoteChange?.();
      }
      if (message.type === 'doc:update') {
        applyingRemote.current = true;
        try {
          Y.applyUpdate(doc, base64ToBytes(message.update), 'remote');
        } finally {
          applyingRemote.current = false;
        }
        options.onRemoteChange?.();
      }
      if (message.type === 'doc:rejected') {
        setRejected(message.reason);
      }
      if (message.type === 'cursor') {
        setRemoteCursors((current) => ({
          ...current,
          [message.userId]: {
            userId: message.userId,
            displayName: message.displayName,
            anchor: message.anchor,
            head: message.head,
            editing: message.editing,
            at: message.at,
          },
        }));
      }
    });
  }, [doc, documentId, onMessage, options]);

  // Ask for the authoritative state whenever a (re)connection is established.
  useEffect(() => {
    if (!documentId || status !== 'connected') return;
    send({ type: 'doc:request-state', documentId });
    if (options.canEdit) {
      send({ type: 'doc:sync', documentId, update: bytesToBase64(Y.encodeStateAsUpdate(doc)) });
    }
  }, [doc, documentId, options.canEdit, send, status]);

  // Presence is refreshed periodically so "editing" indicators expire.
  useEffect(() => {
    if (!documentId || status !== 'connected') return;
    const timer = setInterval(() => {
      send({ type: 'cursor', documentId, anchor: 0, head: 0, editing: false });
    }, 20_000);
    return () => clearInterval(timer);
  }, [documentId, send, status]);

  const insertText = useCallback(
    (value: string, index?: number) => {
      if (!options.canEdit) return;
      ytext.insert(index ?? ytext.length, value);
    },
    [options.canEdit, ytext],
  );

  const replaceAll = useCallback(
    (value: string) => {
      if (!options.canEdit) return;
      doc.transact(() => {
        ytext.delete(0, ytext.length);
        ytext.insert(0, value);
      });
    },
    [doc, options.canEdit, ytext],
  );

  return {
    text,
    version,
    synced,
    rejected,
    remoteCursors,
    status,
    insertText,
    replaceAll,
    reportCursor: (anchor: number, head: number, editing: boolean) => {
      if (!documentId) return;
      send({ type: 'cursor', documentId, anchor, head, editing });
    },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
