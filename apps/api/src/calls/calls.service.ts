import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CallConnectionState,
  CallDiagnostics,
  CallKind,
  CallRoom,
  IceServerConfig,
} from '@ufos/contracts';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { newId } from '../config';
import type { AuthenticatedUser } from '../common/authed-request';
import { DatabaseService } from '../db/database.service';
import { iso, parseJson } from '../db/rows';
import { RealtimeService } from '../realtime/realtime.service';
import { toCallRoom, type CallParticipantRow, type CallRoomRow } from '../stage-c/mappers';

export function stunUrls(): string[] {
  return (
    process.env.WEBRTC_STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function turnConfigured(): boolean {
  return Boolean(process.env.WEBRTC_TURN_URLS && process.env.WEBRTC_TURN_USERNAME);
}

/**
 * Builds the ICE server list for the browser. TURN credentials are short-lived
 * so a leaked browser configuration cannot be used indefinitely. When no TURN
 * server is configured the diagnostics say so honestly instead of pretending
 * that symmetric-NAT calls will work.
 */
export function iceServers(): IceServerConfig[] {
  const servers: IceServerConfig[] = [{ urls: stunUrls() }];
  const turnUrls = (process.env.WEBRTC_TURN_URLS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (turnUrls.length > 0) {
    servers.push({
      urls: turnUrls,
      username: process.env.WEBRTC_TURN_USERNAME || '',
      credential: process.env.WEBRTC_TURN_CREDENTIAL || '',
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    });
  }
  return servers;
}

@Injectable()
export class CallsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  async rooms(user: AuthenticatedUser, spaceId: string): Promise<CallRoom[]> {
    await this.access.assert(user.id, spaceId, 'calls', 'read');
    const rows = await this.db.query<CallRoomRow>(
      `SELECT * FROM call_rooms WHERE space_id = $1 AND closed_at IS NULL
       ORDER BY created_at DESC LIMIT 50`,
      [spaceId],
    );
    return Promise.all(rows.map((row) => this.buildRoom(row)));
  }

  async createRoom(
    user: AuthenticatedUser,
    spaceId: string,
    input: { name: string; kind: CallKind; inviteUserIds: string[] },
  ): Promise<CallRoom> {
    await this.access.assert(user.id, spaceId, 'calls', 'create');
    if (input.name.trim().length === 0) throw new BadRequestException('call_name_required');
    for (const invitee of input.inviteUserIds) {
      const member = await this.db.queryOne<{ user_id: string }>(
        'SELECT user_id FROM memberships WHERE space_id = $1 AND user_id = $2',
        [spaceId, invitee],
      );
      if (!member) throw new BadRequestException('call_invitee_not_in_space');
    }
    const row = await this.db.queryOne<CallRoomRow>(
      `INSERT INTO call_rooms (id, space_id, name, kind, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [newId('cal'), spaceId, input.name.trim(), input.kind, user.id],
    );
    if (!row) throw new NotFoundException('call_not_created');
    await this.db.query(
      `INSERT INTO call_participants (room_id, user_id, role, state, audio, video, joined_at)
       VALUES ($1,$2,'host','joined',TRUE,$3,CURRENT_TIMESTAMP)`,
      [row.id, user.id, input.kind === 'video'],
    );
    for (const invitee of input.inviteUserIds) {
      await this.db.query(
        `INSERT INTO call_participants (room_id, user_id, role, state)
         VALUES ($1,$2,'participant','invited') ON CONFLICT DO NOTHING`,
        [row.id, invitee],
      );
    }
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'calls.room.create',
      entity: 'call_room',
      entityId: row.id,
      metadata: { kind: input.kind, invited: input.inviteUserIds.length },
    });
    await this.logEvent(row.id, user.id, 'room.created', { kind: input.kind });
    this.realtime.publish(spaceId, 'calls', user.id, { action: 'call.create', roomId: row.id });
    return this.buildRoom(row);
  }

  async room(user: AuthenticatedUser, spaceId: string, id: string): Promise<CallRoom> {
    await this.access.assert(user.id, spaceId, 'calls', 'read');
    return this.buildRoom(await this.requireRoom(spaceId, id));
  }

  async join(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    input: { audio?: boolean; video?: boolean },
  ) {
    await this.access.assert(user.id, spaceId, 'calls', 'read');
    const room = await this.requireRoom(spaceId, id);
    if (room.closed_at) throw new BadRequestException('call_closed');
    await this.db.query(
      `INSERT INTO call_participants (room_id, user_id, state, audio, video, joined_at, left_at)
       VALUES ($1,$2,'joined',$3,$4,CURRENT_TIMESTAMP,NULL)
       ON CONFLICT (room_id, user_id) DO UPDATE SET
         state = 'joined', audio = EXCLUDED.audio, video = EXCLUDED.video,
         joined_at = COALESCE(call_participants.joined_at, CURRENT_TIMESTAMP),
         left_at = NULL, last_seen_at = CURRENT_TIMESTAMP`,
      [id, user.id, input.audio ?? true, input.video ?? room.kind === 'video'],
    );
    await this.logEvent(id, user.id, 'participant.joined', {});
    this.realtime.publish(spaceId, 'calls', user.id, {
      action: 'call.join',
      roomId: id,
      userId: user.id,
    });
    return this.buildRoom(room);
  }

  async leave(user: AuthenticatedUser, spaceId: string, id: string) {
    await this.access.assert(user.id, spaceId, 'calls', 'read');
    await this.requireRoom(spaceId, id);
    await this.db.query(
      `UPDATE call_participants SET state = 'left', left_at = CURRENT_TIMESTAMP,
         last_seen_at = CURRENT_TIMESTAMP, screen = FALSE
       WHERE room_id = $1 AND user_id = $2`,
      [id, user.id],
    );
    await this.logEvent(id, user.id, 'participant.left', {});
    this.realtime.publish(spaceId, 'calls', user.id, {
      action: 'call.leave',
      roomId: id,
      userId: user.id,
    });
    return { left: true };
  }

  async close(user: AuthenticatedUser, spaceId: string, id: string) {
    await this.access.assert(user.id, spaceId, 'calls', 'update');
    const room = await this.requireRoom(spaceId, id);
    const host = await this.db.queryOne<{ role: string }>(
      'SELECT role FROM call_participants WHERE room_id = $1 AND user_id = $2',
      [id, user.id],
    );
    const canManage = await this.access
      .assert(user.id, spaceId, 'calls', 'manage_access')
      .then(() => true)
      .catch(() => false);
    if (!canManage && host?.role !== 'host') throw new ForbiddenException('call_host_required');
    await this.db.query('UPDATE call_rooms SET closed_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
    await this.db.query(
      `UPDATE call_participants SET state = 'left', left_at = CURRENT_TIMESTAMP WHERE room_id = $1`,
      [id],
    );
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'calls.room.close',
      entity: 'call_room',
      entityId: id,
    });
    await this.logEvent(id, user.id, 'room.closed', {});
    this.realtime.publish(spaceId, 'calls', user.id, { action: 'call.close', roomId: id });
    return { closed: true, roomId: room.id };
  }

  async updateState(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    input: {
      audio?: boolean;
      video?: boolean;
      screen?: boolean;
      connectionState?: CallConnectionState;
      quality?: { rttMs?: number | null; packetsLost?: number | null; bitrateKbps?: number | null };
    },
  ) {
    await this.access.assert(user.id, spaceId, 'calls', 'read');
    await this.requireRoom(spaceId, id);
    const fields: string[] = [];
    const params: unknown[] = [id, user.id];
    const push = (column: string, value: unknown) => {
      params.push(value);
      fields.push(`${column} = $${params.length}`);
    };
    if (input.audio !== undefined) push('audio', input.audio);
    if (input.video !== undefined) push('video', input.video);
    if (input.screen !== undefined) push('screen', input.screen);
    if (input.connectionState !== undefined) push('connection_state', input.connectionState);
    if (input.quality !== undefined) push('quality', JSON.stringify(input.quality));
    fields.push('last_seen_at = CURRENT_TIMESTAMP');
    await this.db.query(
      `UPDATE call_participants SET ${fields.join(', ')} WHERE room_id = $1 AND user_id = $2`,
      params,
    );
    this.realtime.publish(spaceId, 'calls', user.id, {
      action: 'call.state',
      roomId: id,
      userId: user.id,
    });
    return { updated: true };
  }

  /**
   * Persists a signaling frame for the HTTP fallback. WebSocket delivery is the
   * primary path; the poll endpoint below replays what a client missed.
   */
  async storeSignal(
    spaceId: string,
    roomId: string,
    fromUserId: string,
    toUserId: string,
    kind: 'offer' | 'answer' | 'ice' | 'renegotiate' | 'bye',
    payload: Record<string, unknown>,
  ) {
    await this.db.query(
      `INSERT INTO call_signals (id, room_id, from_user_id, to_user_id, kind, payload)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [newId('sig'), roomId, fromUserId, toUserId, kind, JSON.stringify(payload)],
    );
    this.realtime.publish(spaceId, 'calls.signal', fromUserId, {
      action: 'signal',
      roomId,
      from: fromUserId,
      to: toUserId,
      kind,
    });
  }

  async pendingSignals(user: AuthenticatedUser, spaceId: string, roomId: string) {
    await this.access.assert(user.id, spaceId, 'calls', 'read');
    await this.requireRoom(spaceId, roomId);
    const rows = await this.db.query<{
      id: string;
      from_user_id: string;
      kind: string;
      payload: unknown;
      created_at: Date | string;
    }>(
      `SELECT id, from_user_id, kind, payload, created_at FROM call_signals
       WHERE room_id = $1 AND to_user_id = $2 AND consumed_at IS NULL
       ORDER BY created_at ASC LIMIT 200`,
      [roomId, user.id],
    );
    if (rows.length > 0) {
      const placeholders = rows.map((_, index) => `$${index + 1}`).join(',');
      await this.db.query(
        `UPDATE call_signals SET consumed_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
        rows.map((row) => row.id),
      );
    }
    return rows.map((row) => ({
      id: row.id,
      from: row.from_user_id,
      kind: row.kind,
      payload: parseJson<Record<string, unknown>>(row.payload, {}),
      createdAt: iso(row.created_at),
    }));
  }

  async diagnostics(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
  ): Promise<CallDiagnostics> {
    await this.access.assert(user.id, spaceId, 'calls', 'read');
    await this.requireRoom(spaceId, id);
    const participants = await this.db.queryOne<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count FROM call_participants WHERE room_id = $1 AND state = 'joined'`,
      [id],
    );
    const warnings: string[] = [];
    if (!turnConfigured()) {
      warnings.push('turn_not_configured');
    }
    if (participants && Number(participants.count) > 8) {
      warnings.push('large_room_may_exceed_vps_capacity');
    }
    return {
      roomId: id,
      signaling: 'websocket',
      turnConfigured: turnConfigured(),
      iceServers: iceServers(),
      participants: Number(participants?.count ?? 0),
      warnings,
    };
  }

  private async buildRoom(row: CallRoomRow): Promise<CallRoom> {
    const participants = await this.db.query<CallParticipantRow>(
      `SELECT p.*, u.display_name, u.avatar_color FROM call_participants p
       JOIN users u ON u.id = p.user_id
       WHERE p.room_id = $1 ORDER BY p.role ASC, p.joined_at ASC NULLS LAST`,
      [row.id],
    );
    return toCallRoom(row, participants, {
      stunUrls: stunUrls(),
      turnConfigured: turnConfigured(),
    });
  }

  private async requireRoom(spaceId: string, id: string): Promise<CallRoomRow> {
    const row = await this.db.queryOne<CallRoomRow>(
      'SELECT * FROM call_rooms WHERE id = $1 AND space_id = $2',
      [id, spaceId],
    );
    if (!row) throw new NotFoundException('call_not_found');
    return row;
  }

  private async logEvent(
    roomId: string,
    userId: string | null,
    event: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO call_events (id, room_id, user_id, event, detail) VALUES ($1,$2,$3,$4,$5)`,
      [newId('cev'), roomId, userId, event, JSON.stringify(detail)],
    );
  }
}
