'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CallRoom, IceServerConfig } from '@ufos/contracts';
import * as Lucide from 'lucide-react';
import { useApp } from '@/components/app-provider';
import { Badge, Button, Card, EmptyState, ErrorPanel, Field, PageHeader } from '@/components/ui';
import { apiFetch, apiPath } from '@/lib/api';
import { useCollaboration } from '@/lib/collaboration';
import { useRealtimeReload } from '@/lib/use-realtime';

interface RemotePeer {
  userId: string;
  stream: MediaStream | null;
  connectionState: RTCPeerConnectionState;
  rttMs: number | null;
}

/**
 * Deterministic offerer: the peer with the lexicographically smaller user id
 * always creates the offer. That removes glare (two simultaneous offers) without
 * needing a perfect-negotiation state machine in the browser.
 */
function isOfferer(selfId: string, remoteId: string): boolean {
  return selfId < remoteId;
}

export default function CallsPage() {
  const { t, snapshot, notify, online } = useApp();
  const spaceId = snapshot?.activeSpace?.id;
  const selfId = snapshot?.user.id ?? '';
  const { reload, refresh } = useRealtimeReload(spaceId, ['calls']);
  const collaboration = useCollaboration(spaceId, ['calls']);
  const [rooms, setRooms] = useState<CallRoom[]>([]);
  const [activeRoomId, setActiveRoomId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [roomKind, setRoomKind] = useState<'audio' | 'video'>('video');
  const [peers, setPeers] = useState<Record<string, RemotePeer>>({});
  const [iceServers, setIceServers] = useState<IceServerConfig[]>([]);
  const [turnConfigured, setTurnConfigured] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [screenOn, setScreenOn] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);

  const localStream = useRef<MediaStream | null>(null);
  const screenStream = useRef<MediaStream | null>(null);
  const localVideo = useRef<HTMLVideoElement | null>(null);
  const connections = useRef<Map<string, RTCPeerConnection>>(new Map());
  const pendingIce = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const activeRoomRef = useRef<string>('');
  const iceServersRef = useRef<IceServerConfig[]>([]);

  const activeRoom = useMemo(
    () => rooms.find((room) => room.id === activeRoomId) ?? null,
    [activeRoomId, rooms],
  );

  const load = useCallback(async () => {
    if (!spaceId) {
      setLoading(false);
      return;
    }
    setError(false);
    try {
      const rows = await apiFetch<CallRoom[]>(apiPath('/calls/rooms', { spaceId }));
      setRooms(rows);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  useEffect(() => {
    void load();
  }, [load, reload]);

  useEffect(() => {
    activeRoomRef.current = activeRoomId;
  }, [activeRoomId]);

  const loadIceServers = useCallback(async () => {
    if (!spaceId || !activeRoomId) return;
    try {
      const diagnostics = await apiFetch<{
        iceServers: IceServerConfig[];
        turnConfigured: boolean;
      }>(apiPath(`/calls/rooms/${encodeURIComponent(activeRoomId)}/diagnostics`, { spaceId }));
      setIceServers(diagnostics.iceServers);
      iceServersRef.current = diagnostics.iceServers;
      setTurnConfigured(diagnostics.turnConfigured);
    } catch {
      notify(t('common.error'), 'error');
    }
  }, [activeRoomId, notify, spaceId, t]);

  useEffect(() => {
    void loadIceServers();
  }, [loadIceServers]);

  const sendSignal = useCallback(
    (to: string, kind: 'offer' | 'answer' | 'ice' | 'renegotiate' | 'bye', payload: unknown) => {
      if (!activeRoomRef.current) return;
      collaboration.send({
        type: 'call:signal',
        roomId: activeRoomRef.current,
        to,
        kind,
        payload: payload as Record<string, unknown>,
      });
    },
    [collaboration],
  );

  const ensurePeer = useCallback(
    async (remoteId: string): Promise<RTCPeerConnection | null> => {
      const existing = connections.current.get(remoteId);
      if (existing) return existing;
      const configuration: RTCConfiguration = {
        iceServers: iceServersRef.current.map((server) => ({
          urls: server.urls,
          username: server.username,
          credential: server.credential,
        })),
      };
      const pc = new RTCPeerConnection(configuration);
      connections.current.set(remoteId, pc);
      localStream.current?.getTracks().forEach((track) => {
        pc.addTrack(track, localStream.current as MediaStream);
      });
      pc.onicecandidate = (event) => {
        if (event.candidate) sendSignal(remoteId, 'ice', event.candidate.toJSON());
      };
      pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (!stream) return;
        setPeers((current) => ({
          ...current,
          [remoteId]: {
            userId: remoteId,
            stream,
            connectionState: current[remoteId]?.connectionState ?? 'connecting',
            rttMs: current[remoteId]?.rttMs ?? null,
          },
        }));
      };
      pc.onconnectionstatechange = () => {
        setPeers((current) => ({
          ...current,
          [remoteId]: {
            userId: remoteId,
            stream: current[remoteId]?.stream ?? null,
            connectionState: pc.connectionState,
            rttMs: current[remoteId]?.rttMs ?? null,
          },
        }));
        collaboration.send({
          type: 'call:state',
          roomId: activeRoomRef.current,
          connectionState:
            pc.connectionState === 'connected'
              ? 'connected'
              : pc.connectionState === 'failed'
                ? 'failed'
                : pc.connectionState === 'disconnected'
                  ? 'disconnected'
                  : 'connecting',
        });
      };
      return pc;
    },
    [collaboration, sendSignal],
  );

  const makeOffer = useCallback(
    async (remoteId: string) => {
      const pc = await ensurePeer(remoteId);
      if (!pc) return;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal(remoteId, 'offer', { sdp: offer.sdp, type: offer.type });
    },
    [ensurePeer, sendSignal],
  );

  useEffect(() => {
    return collaboration.onMessage((message) => {
      if (message.type === 'call:signal') {
        const remoteId = message.from;
        if (message.kind === 'offer') {
          void (async () => {
            const pc = await ensurePeer(remoteId);
            if (!pc) return;
            await pc.setRemoteDescription({
              type: 'offer',
              sdp: String((message.payload as { sdp?: string }).sdp ?? ''),
            });
            for (const candidate of pendingIce.current.get(remoteId) ?? []) {
              await pc.addIceCandidate(candidate).catch(() => undefined);
            }
            pendingIce.current.delete(remoteId);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendSignal(remoteId, 'answer', { sdp: answer.sdp, type: answer.type });
          })();
        }
        if (message.kind === 'answer') {
          void (async () => {
            const pc = connections.current.get(remoteId);
            if (!pc) return;
            await pc.setRemoteDescription({
              type: 'answer',
              sdp: String((message.payload as { sdp?: string }).sdp ?? ''),
            });
            for (const candidate of pendingIce.current.get(remoteId) ?? []) {
              await pc.addIceCandidate(candidate).catch(() => undefined);
            }
            pendingIce.current.delete(remoteId);
          })();
        }
        if (message.kind === 'ice') {
          void (async () => {
            const pc = connections.current.get(remoteId);
            const candidate = message.payload as RTCIceCandidateInit;
            if (pc?.remoteDescription) {
              await pc.addIceCandidate(candidate).catch(() => undefined);
            } else {
              const queue = pendingIce.current.get(remoteId) ?? [];
              queue.push(candidate);
              pendingIce.current.set(remoteId, queue);
            }
          })();
        }
        if (message.kind === 'bye') {
          const pc = connections.current.get(remoteId);
          pc?.close();
          connections.current.delete(remoteId);
          setPeers((current) => {
            const next = { ...current };
            delete next[remoteId];
            return next;
          });
        }
      }
      if (message.type === 'call:state') {
        setPeers((current) => ({
          ...current,
          [message.userId]: {
            userId: message.userId,
            stream: current[message.userId]?.stream ?? null,
            connectionState:
              message.connectionState === 'connected'
                ? 'connected'
                : message.connectionState === 'failed'
                  ? 'failed'
                  : (current[message.userId]?.connectionState ?? 'connecting'),
            rttMs: current[message.userId]?.rttMs ?? null,
          },
        }));
      }
    });
  }, [collaboration, ensurePeer, sendSignal]);

  useEffect(() => {
    if (!activeRoomId || collaboration.status !== 'connected') return;
    for (const participant of activeRoom?.participants ?? []) {
      if (participant.userId === selfId) continue;
      if (participant.state !== 'joined') continue;
      if (!isOfferer(selfId, participant.userId)) continue;
      if (connections.current.has(participant.userId)) continue;
      void makeOffer(participant.userId);
    }
  }, [activeRoom, activeRoomId, collaboration.status, makeOffer, selfId]);

  useEffect(() => {
    if (!activeRoomId) return;
    const timer = setInterval(() => {
      const roomId = activeRoomRef.current;
      for (const pc of connections.current.values()) {
        void pc.getStats().then((stats) => {
          stats.forEach((report) => {
            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
              collaboration.send({
                type: 'call:state',
                roomId,
                quality: { rttMs: Math.round((report.currentRoundTripTime ?? 0) * 1000) },
              });
            }
          });
        });
      }
    }, 15_000);
    return () => clearInterval(timer);
  }, [activeRoomId, collaboration]);

  useEffect(() => {
    if (localVideo.current && localStream.current) {
      localVideo.current.srcObject = localStream.current;
    }
  }, [activeRoomId, cameraOn]);

  const stopMedia = useCallback(() => {
    localStream.current?.getTracks().forEach((track) => track.stop());
    screenStream.current?.getTracks().forEach((track) => track.stop());
    localStream.current = null;
    screenStream.current = null;
  }, []);

  useEffect(() => {
    return () => {
      for (const pc of connections.current.values()) pc.close();
      connections.current.clear();
      stopMedia();
    };
  }, [stopMedia]);

  const acquireMedia = async (kind: 'audio' | 'video') => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setMediaError('media_devices_unavailable');
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: kind === 'video',
      });
      localStream.current = stream;
      setMicOn(true);
      setCameraOn(kind === 'video');
      setMediaError(null);
      for (const [remoteId, pc] of connections.current) {
        for (const track of stream.getTracks()) {
          const sender = pc.getSenders().find((entry) => entry.track?.kind === track.kind);
          if (sender) await sender.replaceTrack(track);
          else pc.addTrack(track, stream);
        }
        if (isOfferer(selfId, remoteId)) void makeOffer(remoteId);
      }
      return true;
    } catch (cause) {
      setMediaError(cause instanceof Error ? cause.name : 'media_error');
      return false;
    }
  };

  const joinRoom = async (room: CallRoom) => {
    if (!spaceId) return;
    setBusy(true);
    try {
      const mediaOk = await acquireMedia(room.kind);
      await apiFetch(`/calls/rooms/${encodeURIComponent(room.id)}/join`, {
        method: 'POST',
        body: { spaceId, audio: mediaOk, video: mediaOk && room.kind === 'video' },
      });
      setActiveRoomId(room.id);
      activeRoomRef.current = room.id;
      await refresh();
      await load();
      if (!mediaOk) notify(t('stageC.calls.failed'), 'error');
    } catch {
      notify(t('common.error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const leaveRoom = async () => {
    if (!spaceId || !activeRoomId) return;
    try {
      await apiFetch(`/calls/rooms/${encodeURIComponent(activeRoomId)}/leave`, {
        method: 'POST',
        body: { spaceId },
      });
    } catch {
      // Leaving is best effort; local media is always released below.
    }
    for (const pc of connections.current.values()) pc.close();
    connections.current.clear();
    setPeers({});
    stopMedia();
    setActiveRoomId('');
    activeRoomRef.current = '';
    await load();
  };

  const createRoom = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!spaceId || !roomName.trim()) return;
    setBusy(true);
    try {
      const created = await apiFetch<CallRoom>('/calls/rooms', {
        method: 'POST',
        body: { spaceId, name: roomName.trim(), kind: roomKind, inviteUserIds: [] },
      });
      setRoomName('');
      await load();
      await joinRoom(created);
    } catch {
      notify(t('common.error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggleMic = async () => {
    const track = localStream.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMicOn(track.enabled);
    collaboration.send({ type: 'call:state', roomId: activeRoomId, audio: track.enabled });
  };

  const toggleCamera = async () => {
    const track = localStream.current?.getVideoTracks()[0];
    if (!track) {
      const stream = await acquireMedia('video');
      if (stream) setCameraOn(true);
      return;
    }
    track.enabled = !track.enabled;
    setCameraOn(track.enabled);
    collaboration.send({ type: 'call:state', roomId: activeRoomId, video: track.enabled });
  };

  const toggleScreen = async () => {
    if (screenOn) {
      screenStream.current?.getTracks().forEach((track) => track.stop());
      screenStream.current = null;
      setScreenOn(false);
      const camera = localStream.current?.getVideoTracks()[0];
      for (const pc of connections.current.values()) {
        const sender = pc.getSenders().find((entry) => entry.track?.kind === 'video');
        if (sender && camera) await sender.replaceTrack(camera);
      }
      collaboration.send({ type: 'call:state', roomId: activeRoomId, screen: false });
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
      setMediaError('screen_share_unavailable');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      screenStream.current = stream;
      const [track] = stream.getVideoTracks();
      for (const pc of connections.current.values()) {
        const sender = pc.getSenders().find((entry) => entry.track?.kind === 'video');
        if (sender && track) await sender.replaceTrack(track);
      }
      setScreenOn(true);
      track?.addEventListener('ended', () => void toggleScreen());
      collaboration.send({ type: 'call:state', roomId: activeRoomId, screen: true });
    } catch {
      setMediaError('screen_share_cancelled');
    }
  };

  return (
    <>
      <PageHeader
        eyebrow={t('stageC.badge')}
        title={t('modules.calls')}
        description={t('stageC.calls.subtitle')}
        action={
          <div className="uf-pill-row">
            <Badge tone={collaboration.status === 'connected' ? 'success' : 'warning'}>
              <Lucide.Radio className="h-3.5 w-3.5" aria-hidden="true" />
              {t('stageC.calls.signaling')}: WebSocket
            </Badge>
            <Badge tone={turnConfigured ? 'success' : 'danger'}>
              <Lucide.ServerCog className="h-3.5 w-3.5" aria-hidden="true" />
              {t('stageC.calls.turn')}: {turnConfigured ? 'TURN' : '—'}
            </Badge>
          </div>
        }
      />

      {!spaceId ? (
        <EmptyState
          icon="UsersRound"
          title={t('common.noData')}
          description={t('admin.noAccess')}
        />
      ) : error ? (
        <ErrorPanel message={t('common.error')} onRetry={refresh} />
      ) : loading ? (
        <div className="uf-skeleton h-80" />
      ) : (
        <div className="space-y-5">
          <Card className="p-4">
            <p className="text-xs leading-5 text-[var(--muted)]">{t('stageC.calls.mediaNote')}</p>
            {!turnConfigured ? (
              <p className="mt-2 rounded-xl border border-[var(--warning,#f59e0b)] p-3 text-xs">
                {t('stageC.calls.turnMissing')}
              </p>
            ) : null}
            {mediaError ? (
              <p
                role="alert"
                className="mt-2 rounded-xl border border-[var(--danger,#e11d48)] p-3 text-xs"
              >
                {mediaError}
              </p>
            ) : null}
          </Card>

          {!activeRoom ? (
            <div className="uf-split uf-split-main">
              <div className="space-y-3">
                {rooms.length === 0 ? (
                  <EmptyState icon="Video" title={t('stageC.calls.noRooms')} />
                ) : null}
                {rooms.map((room) => (
                  <Card key={room.id} className="p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h2 className="font-bold">{room.name}</h2>
                        <p className="text-xs text-[var(--muted)]">
                          {t(`stageC.calls.kind.${room.kind}`)} ·{' '}
                          {room.participants.filter((entry) => entry.state === 'joined').length}{' '}
                          {t('stageC.calls.participants').toLocaleLowerCase()}
                        </p>
                      </div>
                      <Button variant="primary" onClick={() => void joinRoom(room)} loading={busy}>
                        <Lucide.PhoneCall className="h-4 w-4" aria-hidden="true" />
                        {t('stageC.calls.join')}
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
              <aside>
                <Card className="p-5">
                  <h2 className="mb-3 text-lg font-bold">{t('stageC.calls.new')}</h2>
                  <form onSubmit={createRoom} className="space-y-3">
                    <Field label={t('stageC.calls.name')} htmlFor="call-room-name">
                      <input
                        id="call-room-name"
                        className="uf-input"
                        value={roomName}
                        onChange={(event) => setRoomName(event.target.value)}
                        maxLength={120}
                        required
                      />
                    </Field>
                    <Field label={t('common.kind')} htmlFor="call-room-kind">
                      <select
                        id="call-room-kind"
                        className="uf-select"
                        value={roomKind}
                        onChange={(event) => setRoomKind(event.target.value as 'audio' | 'video')}
                      >
                        <option value="video">{t('stageC.calls.kind.video')}</option>
                        <option value="audio">{t('stageC.calls.kind.audio')}</option>
                      </select>
                    </Field>
                    <Button type="submit" variant="primary" loading={busy} disabled={!online}>
                      {t('common.create')}
                    </Button>
                  </form>
                </Card>
              </aside>
            </div>
          ) : (
            <div className="space-y-4">
              <Card className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-lg font-bold">{activeRoom.name}</h2>
                  <div className="uf-pill-row">
                    <Button
                      variant={micOn ? 'default' : 'danger'}
                      onClick={() => void toggleMic()}
                      aria-pressed={micOn}
                    >
                      {micOn ? (
                        <Lucide.Mic className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <Lucide.MicOff className="h-4 w-4" aria-hidden="true" />
                      )}
                      {t('stageC.calls.mic')}
                    </Button>
                    <Button
                      variant={cameraOn ? 'default' : 'danger'}
                      onClick={() => void toggleCamera()}
                      aria-pressed={cameraOn}
                    >
                      {cameraOn ? (
                        <Lucide.Video className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <Lucide.VideoOff className="h-4 w-4" aria-hidden="true" />
                      )}
                      {t('stageC.calls.camera')}
                    </Button>
                    <Button
                      variant={screenOn ? 'primary' : 'default'}
                      onClick={() => void toggleScreen()}
                      aria-pressed={screenOn}
                    >
                      <Lucide.MonitorUp className="h-4 w-4" aria-hidden="true" />
                      {t('stageC.calls.screen')}
                    </Button>
                    <Button variant="danger" onClick={() => void leaveRoom()}>
                      <Lucide.PhoneOff className="h-4 w-4" aria-hidden="true" />
                      {t('stageC.calls.leave')}
                    </Button>
                  </div>
                </div>
              </Card>

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                <div className="uf-video-tile">
                  <video
                    ref={localVideo}
                    autoPlay
                    muted
                    playsInline
                    aria-label={t('common.profile')}
                    className={cameraOn ? '' : 'hidden'}
                  />
                  {!cameraOn ? (
                    <Lucide.VideoOff className="h-8 w-8 text-[var(--muted)]" aria-hidden="true" />
                  ) : null}
                  <span className="uf-video-label">
                    <span>{snapshot?.user.displayName ?? ''}</span>
                    <span>{screenOn ? t('stageC.calls.screen') : t('stageC.calls.connected')}</span>
                  </span>
                </div>

                {Object.values(peers).map((peer) => {
                  const participant = activeRoom.participants.find(
                    (entry) => entry.userId === peer.userId,
                  );
                  return (
                    <div key={peer.userId} className="uf-video-tile">
                      <RemoteVideo stream={peer.stream} label={participant?.displayName ?? ''} />
                      <span className="uf-video-label">
                        <span>{participant?.displayName ?? peer.userId.slice(-6)}</span>
                        <span>
                          {t(
                            `stageC.calls.${peer.connectionState === 'connected' ? 'connected' : peer.connectionState === 'failed' ? 'failed' : 'reconnecting'}`,
                          )}
                          {peer.rttMs !== null ? ` · ${peer.rttMs} ms` : ''}
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>

              <Card className="p-4">
                <h3 className="mb-2 text-sm font-bold">{t('stageC.calls.participants')}</h3>
                <ul className="space-y-2">
                  {activeRoom.participants.map((participant) => (
                    <li
                      key={participant.userId}
                      className="flex flex-wrap items-center justify-between gap-2 text-sm"
                    >
                      <span className="flex items-center gap-2">
                        {participant.role === 'host' ? (
                          <Badge tone="accent">{t('stageC.calls.host')}</Badge>
                        ) : null}
                        {participant.displayName}
                        {participant.userId === selfId ? ` (${t('common.profile')})` : ''}
                      </span>
                      <span className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
                        <Badge
                          tone={
                            participant.state === 'joined'
                              ? 'success'
                              : participant.state === 'left'
                                ? 'default'
                                : 'warning'
                          }
                        >
                          {t(`stageC.calls.${participant.state}`)}
                        </Badge>
                        {participant.audio ? (
                          <Lucide.Mic className="h-3.5 w-3.5" aria-hidden="true" />
                        ) : (
                          <Lucide.MicOff className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        {participant.video ? (
                          <Lucide.Video className="h-3.5 w-3.5" aria-hidden="true" />
                        ) : (
                          <Lucide.VideoOff className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        {participant.screen ? (
                          <Lucide.MonitorUp className="h-3.5 w-3.5" aria-hidden="true" />
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>

              <Card className="p-4">
                <h3 className="mb-2 text-sm font-bold">{t('stageC.calls.diagnostics')}</h3>
                <dl className="grid gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="text-[var(--muted)]">{t('stageC.calls.signaling')}</dt>
                    <dd className="font-bold">WebSocket · {collaboration.status}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--muted)]">{t('stageC.calls.turn')}</dt>
                    <dd className="font-bold">
                      {turnConfigured ? 'configured' : t('stageC.calls.turnMissing')}
                    </dd>
                  </div>
                  {iceServers.map((server, index) => (
                    <div key={index}>
                      <dt className="text-[var(--muted)]">ICE {index + 1}</dt>
                      <dd className="font-bold break-all">{server.urls.join(', ')}</dd>
                    </div>
                  ))}
                </dl>
              </Card>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function RemoteVideo({ stream, label }: { stream: MediaStream | null; label: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current && stream) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <>
      <video ref={ref} autoPlay playsInline aria-label={label} className={stream ? '' : 'hidden'} />
      {!stream ? <Lucide.LoaderCircle className="h-8 w-8 animate-spin" aria-hidden="true" /> : null}
    </>
  );
}
