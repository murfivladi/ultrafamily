'use client';

import { useEffect, useState } from 'react';

export interface RealtimeMessage {
  id: string;
  spaceId: string;
  topic: string;
  actorUserId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export function useRealtime(spaceId: string | undefined, topics: string[]) {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<RealtimeMessage | null>(null);
  const topicsKey = topics.join(',');

  useEffect(() => {
    if (!spaceId || typeof window === 'undefined' || typeof EventSource === 'undefined') {
      setConnected(false);
      return;
    }
    const params = new URLSearchParams({ spaceId });
    if (topicsKey) params.set('topics', topicsKey);
    const source = new EventSource(`/api/realtime/stream?${params.toString()}`, {
      withCredentials: true,
    });
    const handler = (event: MessageEvent<string>) => {
      if (!event.data) return;
      try {
        setLastEvent(JSON.parse(event.data) as RealtimeMessage);
      } catch {
        // Ignore malformed or heartbeat frames.
      }
    };
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener('message', handler as EventListener);
    for (const topic of topicsKey.split(',').filter(Boolean)) {
      source.addEventListener(topic, handler as EventListener);
    }
    return () => {
      source.removeEventListener('message', handler as EventListener);
      for (const topic of topicsKey.split(',').filter(Boolean)) {
        source.removeEventListener(topic, handler as EventListener);
      }
      source.close();
      setConnected(false);
    };
  }, [spaceId, topicsKey]);

  return { connected, lastEvent };
}

export function useRealtimeReload(spaceId: string | undefined, topics: string[]) {
  const { connected, lastEvent } = useRealtime(spaceId, topics);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (lastEvent) setReload((value) => value + 1);
  }, [lastEvent?.id]);
  return {
    connected,
    lastEvent,
    reload,
    refresh: () => setReload((value) => value + 1),
  };
}
