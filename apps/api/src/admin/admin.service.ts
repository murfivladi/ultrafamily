import { Injectable } from '@nestjs/common';
import { MODULES, type AdminSnapshot, type ModuleToggle, type Space } from '@ufos/contracts';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../db/database.service';
import { iso, toSpace, type SpaceRow } from '../db/rows';
import { UsersService } from '../users/users.service';

interface AdminSpaceRow extends SpaceRow {
  member_count: number | string;
}

interface AggregateToggleRow {
  module_id: string;
  enabled: boolean;
  updated_at: Date | string;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  async snapshot(userId: string): Promise<AdminSnapshot> {
    await this.access.requirePlatformAdmin(userId);
    const [users, spaceRows, audit, toggleRows] = await Promise.all([
      this.users.adminUsers(),
      this.db.query<AdminSpaceRow>(
        `SELECT s.*, COUNT(m.user_id)::int AS member_count
         FROM spaces s LEFT JOIN memberships m ON m.space_id = s.id
         GROUP BY s.id ORDER BY s.created_at ASC`,
      ),
      this.audit.list(null, 50),
      this.db.query<AggregateToggleRow>(
        `SELECT module_id, BOOL_OR(enabled) AS enabled, MAX(updated_at) AS updated_at
         FROM module_toggles GROUP BY module_id`,
      ),
    ]);
    const toggleMap = new Map(toggleRows.map((row) => [row.module_id, row]));
    const modules: ModuleToggle[] = MODULES.map((definition) => {
      const row = toggleMap.get(definition.id);
      return {
        moduleId: definition.id,
        enabled: row?.enabled ?? false,
        updatedAt: iso(row?.updated_at) ?? new Date(0).toISOString(),
      };
    });
    const spaces: Array<Space & { memberCount: number }> = spaceRows.map((row) => ({
      ...toSpace(row),
      memberCount: Number(row.member_count ?? 0),
    }));
    return { users, spaces, audit, modules };
  }

  async verifyAudit(userId: string) {
    await this.access.requirePlatformAdmin(userId);
    return this.audit.verifyChain();
  }
}
