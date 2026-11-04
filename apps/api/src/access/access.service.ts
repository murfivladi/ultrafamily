import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import {
  isModuleId,
  permissionKey,
  permissionsForMembership,
  resolvePermission,
  type Action,
  type ModuleId,
  type OverrideDecision,
  type SpaceRole,
} from '@ufos/contracts';
import { DatabaseService } from '../db/database.service';
import { parseJson, type MembershipRow, type SpaceRow, type UserRow } from '../db/rows';

export interface AccessContext {
  userId: string;
  spaceId: string;
  role: SpaceRole;
  membership: MembershipRow;
}

@Injectable()
export class AccessService {
  constructor(private readonly db: DatabaseService) {}

  async requirePlatformAdmin(userId: string): Promise<UserRow> {
    const user = await this.db.queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
    if (!user) throw new UnauthorizedException('account_not_found');
    if (user.platform_role !== 'platform_owner' && user.platform_role !== 'platform_admin') {
      throw new ForbiddenException('platform_admin_required');
    }
    return user;
  }

  async listSpaces(userId: string): Promise<Array<SpaceRow & { role: SpaceRole }>> {
    const rows = await this.db.query<SpaceRow & { role: SpaceRole }>(
      `SELECT s.*, m.role
       FROM spaces s
       JOIN memberships m ON m.space_id = s.id
       WHERE m.user_id = $1
       ORDER BY s.created_at ASC, s.name ASC`,
      [userId],
    );
    return rows;
  }

  async activeSpace(userId: string): Promise<SpaceRow | null> {
    const row = await this.db.queryOne<SpaceRow>(
      `SELECT s.* FROM spaces s
       JOIN user_preferences p ON p.active_space_id = s.id
       JOIN memberships m ON m.space_id = s.id AND m.user_id = $1
       WHERE p.user_id = $1`,
      [userId],
    );
    return row;
  }

  async assert(
    userId: string,
    spaceId: string,
    module: string,
    action: Action,
    options: { explicitlyShared?: boolean } = {},
  ): Promise<AccessContext> {
    if (!isModuleId(module)) throw new ForbiddenException('unknown_module');
    const moduleId = module as ModuleId;
    const user = await this.db.queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
    if (!user) throw new UnauthorizedException('account_not_found');
    const membership = await this.db.queryOne<MembershipRow>(
      'SELECT * FROM memberships WHERE space_id = $1 AND user_id = $2',
      [spaceId, userId],
    );
    if (!membership) {
      if (user.platform_role) {
        throw new ForbiddenException('platform_role_has_no_data_access');
      }
      throw new ForbiddenException('not_a_space_member');
    }
    const toggle = await this.db.queryOne<{ enabled: boolean }>(
      'SELECT enabled FROM module_toggles WHERE space_id = $1 AND module_id = $2',
      [spaceId, moduleId],
    );
    const overrides = parseJson<Record<string, OverrideDecision>>(membership.overrides, {});
    const sensitiveGrants = parseJson<string[]>(membership.sensitive_grants, []);
    const result = resolvePermission({
      role: membership.role,
      moduleId,
      action,
      moduleEnabled: toggle?.enabled ?? false,
      override: overrides[permissionKey(moduleId, action)],
      sensitiveGrant: sensitiveGrants.includes(moduleId),
      isChild: user.is_child,
      isPlatformAdmin: user.platform_role === 'platform_admin',
      explicitlyShared: options.explicitlyShared ?? false,
    });
    if (!result.allowed) throw new ForbiddenException(`access_denied:${result.reason}`);
    return { userId, spaceId, role: membership.role, membership };
  }

  async permissionsForActiveSpace(userId: string, spaceId: string): Promise<string[]> {
    const [membership, user] = await Promise.all([
      this.db.queryOne<MembershipRow>(
        'SELECT * FROM memberships WHERE space_id = $1 AND user_id = $2',
        [spaceId, userId],
      ),
      this.db.queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [userId]),
    ]);
    if (!membership || !user) return [];
    const enabledRows = await this.db.query<{ module_id: string }>(
      'SELECT module_id FROM module_toggles WHERE space_id = $1 AND enabled = TRUE',
      [spaceId],
    );
    const enabled = enabledRows.map((row) => row.module_id).filter(isModuleId) as ModuleId[];
    return permissionsForMembership(
      membership.role,
      parseJson<Record<string, OverrideDecision>>(membership.overrides, {}),
      enabled,
      parseJson<string[]>(membership.sensitive_grants, []),
      user.platform_role === 'platform_admin',
    );
  }
}
