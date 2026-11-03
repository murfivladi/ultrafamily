import { Injectable } from '@nestjs/common';
import type { Session } from '@ufos/contracts';
import { config, hmac, newId, randomToken, sha256 } from '../config';
import type { AuthedRequest, AuthenticatedUser } from '../common/authed-request';
import { DatabaseService } from '../db/database.service';
import { iso, toUser, type SessionRow, type UserRow } from '../db/rows';

export interface CreatedSession {
  token: string;
  row: SessionRow;
  maxAgeMs: number;
}

function ipFingerprint(request: AuthedRequest): string | null {
  const forwarded = request.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
  const raw = (first || request.ip || '').trim();
  return raw ? hmac(raw).slice(0, 16) : null;
}

export function toAuthenticatedUser(row: UserRow): AuthenticatedUser {
  return {
    ...toUser(row),
    passwordHash: row.password_hash,
    failedLoginCount: Number(row.failed_login_count ?? 0),
    lockedUntil: iso(row.locked_until),
  };
}

export function toSession(row: SessionRow, currentSessionId?: string): Session {
  return {
    id: row.id,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    lastSeenAt: iso(row.last_seen_at) ?? new Date(0).toISOString(),
    expiresAt: iso(row.expires_at) ?? new Date(0).toISOString(),
    userAgent: row.user_agent,
    ipPrefix: row.ip_prefix,
    trusted: row.trusted,
    current: row.id === currentSessionId,
  };
}

@Injectable()
export class SessionService {
  constructor(private readonly db: DatabaseService) {}

  csrfToken(sessionId: string): string {
    return hmac(sessionId);
  }

  async create(user: UserRow, request: AuthedRequest): Promise<CreatedSession> {
    const days = user.is_child ? 7 : user.platform_role ? 3 : 14;
    const maxAgeMs = days * 24 * 60 * 60 * 1000;
    const token = randomToken();
    const id = newId('ses');
    const expiresAt = new Date(Date.now() + maxAgeMs).toISOString();
    const row = await this.db.queryOne<SessionRow>(
      `INSERT INTO sessions
        (id, user_id, token_hash, expires_at, user_agent, ip_prefix, trusted)
       VALUES ($1,$2,$3,$4,$5,$6,FALSE)
       RETURNING *`,
      [
        id,
        user.id,
        sha256(token),
        expiresAt,
        (request.headers['user-agent'] || '').toString().slice(0, 240) || null,
        ipFingerprint(request),
      ],
    );
    if (!row) throw new Error('Could not create session');
    return { token, row, maxAgeMs };
  }

  async resolve(token: string): Promise<{ user: AuthenticatedUser; session: SessionRow } | null> {
    if (!token || token.length > 512) return null;
    const session = await this.db.queryOne<SessionRow>(
      `SELECT * FROM sessions
       WHERE token_hash = $1
         AND revoked_at IS NULL
         AND expires_at > CURRENT_TIMESTAMP`,
      [sha256(token)],
    );
    if (!session) return null;
    const user = await this.db.queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [
      session.user_id,
    ]);
    if (!user) return null;

    const lastSeen = new Date(iso(session.last_seen_at) ?? 0).getTime();
    if (Date.now() - lastSeen > 60_000) {
      await this.db.query('UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = $1', [
        session.id,
      ]);
      session.last_seen_at = new Date().toISOString();
    }
    return { user: toAuthenticatedUser(user), session };
  }

  async list(userId: string, currentSessionId?: string): Promise<Session[]> {
    const rows = await this.db.query<SessionRow>(
      `SELECT * FROM sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
       ORDER BY last_seen_at DESC`,
      [userId],
    );
    return rows.map((row) => toSession(row, currentSessionId));
  }

  async revoke(userId: string, sessionId: string): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      `UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
       RETURNING id`,
      [sessionId, userId],
    );
    return result.length > 0;
  }

  async revokeAll(userId: string, exceptSessionId?: string): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2
       RETURNING id`,
      [userId, exceptSessionId ?? ''],
    );
    return rows.length;
  }

  cookieOptions(maxAgeMs?: number): {
    httpOnly: true;
    secure: boolean;
    sameSite: 'lax';
    path: '/';
    maxAge?: number;
  } {
    return {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'lax',
      path: '/',
      ...(maxAgeMs ? { maxAge: maxAgeMs } : {}),
    };
  }
}
