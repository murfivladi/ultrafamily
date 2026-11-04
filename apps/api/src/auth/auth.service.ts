import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { UserProfile } from '@ufos/contracts';
import { AuditService } from '../audit/audit.service';
import type { AuthedRequest } from '../common/authed-request';
import { PasswordService } from '../common/password.service';
import { config, hmac, newId, randomToken, sha256 } from '../config';
import { DatabaseService } from '../db/database.service';
import { iso, toUser, type UserRow } from '../db/rows';
import { LoginThrottleService } from './login-throttle.service';
import { SessionService, type CreatedSession } from './session.service';

interface InvitationRow {
  id: string;
  space_id: string;
  email: string | null;
  role: string;
  max_uses: number;
  use_count: number;
}

interface EmailTokenRow {
  id: string;
  user_id: string;
  purpose: string;
  expires_at: Date | string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly throttle: LoginThrottleService,
    private readonly audit: AuditService,
  ) {}

  private throttleKey(email: string, request: AuthedRequest): string {
    const forwarded = request.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
    return `${email}:${hmac((first || request.ip || 'unknown').trim())}`;
  }

  async register(input: {
    inviteToken: string;
    email: string;
    displayName: string;
    password: string;
    language: 'ru' | 'it';
  }): Promise<{ user: UserProfile; verificationToken?: string }> {
    try {
      this.passwords.assertStrength(input.password);
    } catch {
      throw new BadRequestException('weak_password');
    }
    const inviteHash = sha256(input.inviteToken);
    const passwordHash = await this.passwords.hash(input.password);
    const verificationToken = randomToken();
    const now = new Date().toISOString();
    const emailTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const result = await this.db.transaction(async (tx) => {
      const duplicate = await tx.queryOne<{ id: string }>('SELECT id FROM users WHERE email = $1', [
        input.email,
      ]);
      if (duplicate) throw new ConflictException('email_already_registered');

      const invitation = await tx.queryOne<InvitationRow>(
        `SELECT * FROM invitations
         WHERE token_hash = $1
           AND used_at IS NULL
           AND expires_at > CURRENT_TIMESTAMP
           AND use_count < max_uses
           AND (email IS NULL OR email = $2)`,
        [inviteHash, input.email],
      );
      if (!invitation) throw new BadRequestException('invitation_invalid');

      const userId = newId('usr');
      const user = await tx.queryOne<UserRow>(
        `INSERT INTO users
          (id, email, display_name, password_hash, avatar_color, language,
           email_verified_at, is_child, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'#0EA5E9',$5,NULL,FALSE,$6,$6)
         RETURNING *`,
        [userId, input.email, input.displayName, passwordHash, input.language, now],
      );
      if (!user) throw new Error('User insert failed');

      await tx.query(
        `INSERT INTO user_preferences
          (user_id, active_space_id, theme, color_mode, updated_at)
         VALUES ($1,$2,'family','light',$3)`,
        [userId, invitation.space_id, now],
      );
      await tx.query(
        `INSERT INTO memberships
          (space_id, user_id, role, overrides, sensitive_grants, joined_at)
         VALUES ($1,$2,$3,'{}'::jsonb,'[]'::jsonb,$4)`,
        [invitation.space_id, userId, invitation.role, now],
      );
      const nextUseCount = Number(invitation.use_count) + 1;
      await tx.query(
        `UPDATE invitations
         SET use_count = $2,
             used_at = CASE WHEN $2 >= max_uses THEN CURRENT_TIMESTAMP ELSE used_at END
         WHERE id = $1`,
        [invitation.id, nextUseCount],
      );
      await tx.query(
        `INSERT INTO email_tokens
          (id, user_id, token_hash, purpose, expires_at, created_at)
         VALUES ($1,$2,$3,'verify_email',$4,$5)`,
        [newId('emt'), userId, sha256(verificationToken), emailTokenExpires, now],
      );
      await this.audit.record(
        {
          actorUserId: userId,
          actorEmail: input.email,
          spaceId: invitation.space_id,
          action: 'auth.register',
          entity: 'user',
          entityId: userId,
          metadata: { invitation: true, language: input.language },
        },
        tx,
      );
      return user;
    });

    return {
      user: toUser(result),
      ...(config.isProduction ? {} : { verificationToken }),
    };
  }

  async login(
    input: { email: string; password: string },
    request: AuthedRequest,
  ): Promise<CreatedSession> {
    const throttleKey = this.throttleKey(input.email, request);
    this.throttle.assertAllowed(throttleKey);
    const user = await this.db.queryOne<UserRow>('SELECT * FROM users WHERE email = $1', [
      input.email,
    ]);
    const genericFailure = new UnauthorizedException('invalid_credentials');

    if (!user) {
      this.throttle.recordFailure(throttleKey);
      throw genericFailure;
    }
    const lockedUntil = iso(user.locked_until);
    if (lockedUntil && new Date(lockedUntil).getTime() > Date.now()) {
      await this.audit.record({
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'auth.login.blocked',
        entity: 'session',
        metadata: { reason: 'account_locked' },
      });
      throw new UnauthorizedException('account_temporarily_locked');
    }

    const passwordMatches = await this.passwords.verify(input.password, user.password_hash);
    if (!passwordMatches) {
      this.throttle.recordFailure(throttleKey);
      const failures = Number(user.failed_login_count ?? 0) + 1;
      const lockUntil = failures >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
      await this.db.query(
        `UPDATE users
         SET failed_login_count = $2, locked_until = $3, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [user.id, failures, lockUntil],
      );
      await this.audit.record({
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'auth.login.failed',
        entity: 'session',
        metadata: { failures },
      });
      throw genericFailure;
    }

    await this.db.query(
      `UPDATE users
       SET failed_login_count = 0, locked_until = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [user.id],
    );
    this.throttle.clear(throttleKey);
    const session = await this.sessions.create(user, request);
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'auth.login.success',
      entity: 'session',
      entityId: session.row.id,
      metadata: { newDevice: !session.row.trusted },
    });
    return session;
  }

  async verifyEmail(token: string): Promise<{ ok: true }> {
    const row = await this.db.queryOne<EmailTokenRow>(
      `SELECT * FROM email_tokens
       WHERE token_hash = $1 AND purpose = 'verify_email'
         AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP`,
      [sha256(token)],
    );
    if (!row) throw new BadRequestException('verification_token_invalid');
    await this.db.transaction(async (tx) => {
      await tx.query('UPDATE users SET email_verified_at = CURRENT_TIMESTAMP WHERE id = $1', [
        row.user_id,
      ]);
      await tx.query('UPDATE email_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE id = $1', [
        row.id,
      ]);
      await this.audit.record(
        {
          actorUserId: row.user_id,
          action: 'auth.email.verified',
          entity: 'user',
          entityId: row.user_id,
        },
        tx,
      );
    });
    return { ok: true };
  }

  async requestPasswordReset(email: string): Promise<{ ok: true; devToken?: string }> {
    const user = await this.db.queryOne<UserRow>('SELECT * FROM users WHERE email = $1', [email]);
    if (!user) return { ok: true };
    const token = randomToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await this.db.query(
      `INSERT INTO email_tokens
        (id, user_id, token_hash, purpose, expires_at, created_at)
       VALUES ($1,$2,$3,'password_reset',$4,CURRENT_TIMESTAMP)`,
      [newId('emt'), user.id, sha256(token), expiresAt],
    );
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'auth.password_reset.requested',
      entity: 'user',
      entityId: user.id,
    });
    return { ok: true, ...(config.isProduction ? {} : { devToken: token }) };
  }

  async resetPassword(token: string, newPassword: string): Promise<{ ok: true }> {
    try {
      this.passwords.assertStrength(newPassword);
    } catch {
      throw new BadRequestException('weak_password');
    }
    const passwordHash = await this.passwords.hash(newPassword);
    await this.db.transaction(async (tx) => {
      const row = await tx.queryOne<EmailTokenRow>(
        `SELECT * FROM email_tokens
         WHERE token_hash = $1 AND purpose = 'password_reset'
           AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP
         FOR UPDATE`,
        [sha256(token)],
      );
      if (!row) throw new BadRequestException('reset_token_invalid');
      await tx.query(
        `UPDATE users
         SET password_hash = $2, failed_login_count = 0, locked_until = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [row.user_id, passwordHash],
      );
      await tx.query('UPDATE email_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE id = $1', [
        row.id,
      ]);
      await tx.query(
        'UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND revoked_at IS NULL',
        [row.user_id],
      );
      await this.audit.record(
        {
          actorUserId: row.user_id,
          action: 'auth.password_reset.completed',
          entity: 'user',
          entityId: row.user_id,
          metadata: { sessionsRevoked: true },
        },
        tx,
      );
    });
    return { ok: true };
  }
}
