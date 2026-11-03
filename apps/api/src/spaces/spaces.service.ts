import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { MODULE_IDS, STAGE_A_MODULE_IDS, type SpaceRole } from '@ufos/contracts';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../common/authed-request';
import { newId, randomToken, sha256 } from '../config';
import { DatabaseService } from '../db/database.service';
import { toSpace, type SpaceRow } from '../db/rows';
import { parseJson } from '../db/rows';
import type { Action, ModuleId, OverrideDecision, Space, SpaceKind } from '@ufos/contracts';

interface MembershipUserRow {
  user_id: string;
  role: SpaceRole;
  display_name: string;
  email: string;
  is_child: boolean;
  overrides: unknown;
  sensitive_grants: unknown;
  joined_at: Date | string;
}

@Injectable()
export class SpacesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async list(userId: string): Promise<Array<Space & { role: SpaceRole }>> {
    const rows = await this.access.listSpaces(userId);
    return rows.map((row) => ({ ...toSpace(row as SpaceRow), role: row.role }));
  }

  async create(
    user: AuthenticatedUser,
    input: { name: string; kind: SpaceKind; networkId?: string | null },
  ): Promise<Space & { role: SpaceRole }> {
    if (user.isChild) throw new ForbiddenException('children_cannot_create_spaces');
    const id = newId('spc');
    const personalId = newId('spc');
    const now = new Date().toISOString();
    const enabled = new Set<string>(STAGE_A_MODULE_IDS);
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO spaces (id,name,kind,network_id,parent_space_id,owner_user_id,created_at)
         VALUES ($1,$2,$3,$4,NULL,$5,$6)`,
        [id, input.name, input.kind, input.networkId ?? null, user.id, now],
      );
      await tx.query(
        `INSERT INTO spaces (id,name,kind,network_id,parent_space_id,owner_user_id,created_at)
         VALUES ($1,$2,'personal',$3,$4,$5,$6)`,
        [personalId, 'Личное пространство', input.networkId ?? null, id, user.id, now],
      );
      for (const spaceId of [id, personalId]) {
        await tx.query(
          `INSERT INTO memberships
            (space_id,user_id,role,overrides,sensitive_grants,joined_at)
           VALUES ($1,$2,'space_owner','{}'::jsonb,'[]'::jsonb,$3)`,
          [spaceId, user.id, now],
        );
        for (const moduleId of MODULE_IDS) {
          await tx.query(
            `INSERT INTO module_toggles (space_id,module_id,enabled,updated_at)
             VALUES ($1,$2,$3,$4)`,
            [spaceId, moduleId, enabled.has(moduleId), now],
          );
        }
      }
      await this.audit.record(
        {
          actorUserId: user.id,
          actorEmail: user.email,
          spaceId: id,
          action: 'space.created',
          entity: 'space',
          entityId: id,
          metadata: { kind: input.kind },
        },
        tx,
      );
    });
    const row = await this.db.queryOne<SpaceRow>('SELECT * FROM spaces WHERE id = $1', [id]);
    if (!row) throw new NotFoundException('space_not_found');
    return { ...toSpace(row), role: 'space_owner' };
  }

  async switchSpace(user: AuthenticatedUser, spaceId: string): Promise<{ ok: true }> {
    await this.access.assert(user.id, spaceId, 'spaces', 'read');
    await this.db.query(
      'UPDATE user_preferences SET active_space_id = $2, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1',
      [user.id, spaceId],
    );
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'space.switched',
      entity: 'space',
      entityId: spaceId,
    });
    return { ok: true };
  }

  async members(user: AuthenticatedUser, spaceId: string) {
    await this.access.assert(user.id, spaceId, 'spaces', 'read');
    const rows = await this.db.query<MembershipUserRow>(
      `SELECT m.user_id, m.role, m.overrides, m.sensitive_grants, m.joined_at,
              u.display_name, u.email, u.is_child
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.space_id = $1
       ORDER BY m.joined_at ASC`,
      [spaceId],
    );
    return rows.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      email: row.email,
      role: row.role,
      isChild: row.is_child,
      overrides: parseJson<Record<string, OverrideDecision>>(row.overrides, {}),
      sensitiveGrants: parseJson<string[]>(row.sensitive_grants, []),
      joinedAt: new Date(row.joined_at).toISOString(),
    }));
  }

  async createInvitation(
    user: AuthenticatedUser,
    spaceId: string,
    input: { role: SpaceRole; email?: string | null; expiresInDays?: number },
  ): Promise<{ token?: string; expiresAt: string; role: SpaceRole }> {
    await this.access.assert(user.id, spaceId, 'spaces', 'manage_access');
    if (input.role === 'space_owner') throw new ForbiddenException('owner_invites_are_not_allowed');
    const token = randomToken(24);
    const expiresAt = new Date(
      Date.now() + Math.min(Math.max(input.expiresInDays ?? 14, 1), 30) * 24 * 60 * 60 * 1000,
    ).toISOString();
    await this.db.query(
      `INSERT INTO invitations
        (id,space_id,email,role,token_hash,created_by,expires_at,max_uses)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1)`,
      [
        newId('inv'),
        spaceId,
        input.email?.toLowerCase() ?? null,
        input.role,
        sha256(token),
        user.id,
        expiresAt,
      ],
    );
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'space.invitation.created',
      entity: 'invitation',
      metadata: { role: input.role },
    });
    // In production the token is delivered by the configured mail adapter.
    return { expiresAt, role: input.role, token };
  }

  async setOverride(
    user: AuthenticatedUser,
    spaceId: string,
    input: {
      userId: string;
      moduleId: ModuleId;
      action: Action;
      decision: OverrideDecision | null;
    },
  ): Promise<{ ok: true }> {
    await this.access.assert(user.id, spaceId, 'spaces', 'manage_access');
    const row = await this.db.queryOne<{ overrides: unknown }>(
      'SELECT overrides FROM memberships WHERE space_id = $1 AND user_id = $2',
      [spaceId, input.userId],
    );
    if (!row) throw new NotFoundException('membership_not_found');
    const overrides = parseJson<Record<string, OverrideDecision>>(row.overrides, {});
    const key = `${input.moduleId}:${input.action}`;
    if (input.decision === null) delete overrides[key];
    else overrides[key] = input.decision;
    await this.db.query(
      'UPDATE memberships SET overrides = $3 WHERE space_id = $1 AND user_id = $2',
      [spaceId, input.userId, JSON.stringify(overrides)],
    );
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'space.permission_override.changed',
      entity: 'membership',
      entityId: input.userId,
      metadata: { moduleId: input.moduleId, action: input.action, decision: input.decision },
    });
    return { ok: true };
  }

  async setSensitiveGrant(
    user: AuthenticatedUser,
    spaceId: string,
    input: { userId: string; moduleId: ModuleId; granted: boolean },
  ): Promise<{ ok: true }> {
    await this.access.assert(user.id, spaceId, 'spaces', 'manage_access');
    const row = await this.db.queryOne<{ sensitive_grants: unknown }>(
      'SELECT sensitive_grants FROM memberships WHERE space_id = $1 AND user_id = $2',
      [spaceId, input.userId],
    );
    if (!row) throw new NotFoundException('membership_not_found');
    const grants = new Set(parseJson<string[]>(row.sensitive_grants, []));
    if (input.granted) grants.add(input.moduleId);
    else grants.delete(input.moduleId);
    await this.db.query(
      'UPDATE memberships SET sensitive_grants = $3 WHERE space_id = $1 AND user_id = $2',
      [spaceId, input.userId, JSON.stringify([...grants])],
    );
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'space.sensitive_grant.changed',
      entity: 'membership',
      entityId: input.userId,
      metadata: { moduleId: input.moduleId, granted: input.granted },
    });
    return { ok: true };
  }
}
