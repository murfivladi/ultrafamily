import { ForbiddenException, Injectable } from '@nestjs/common';
import { MODULES, isModuleId, type ModuleId, type ModuleToggle } from '@ufos/contracts';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../common/authed-request';
import { DatabaseService } from '../db/database.service';
import { iso } from '../db/rows';

interface ToggleRow {
  module_id: string;
  enabled: boolean;
  updated_at: Date | string;
}

@Injectable()
export class ModulesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  private async requireSpace(user: AuthenticatedUser): Promise<string> {
    const space = await this.access.activeSpace(user.id);
    if (!space) throw new ForbiddenException('no_active_space');
    return space.id;
  }

  async list(user: AuthenticatedUser): Promise<{
    definitions: typeof MODULES;
    toggles: ModuleToggle[];
    spaceId: string;
  }> {
    const spaceId = await this.requireSpace(user);
    await this.access.assert(user.id, spaceId, 'catalog', 'read');
    const rows = await this.db.query<ToggleRow>(
      'SELECT module_id, enabled, updated_at FROM module_toggles WHERE space_id = $1',
      [spaceId],
    );
    const byId = new Map(rows.map((row) => [row.module_id, row]));
    const toggles = MODULES.map((definition) => ({
      moduleId: definition.id,
      enabled: byId.get(definition.id)?.enabled ?? false,
      updatedAt: iso(byId.get(definition.id)?.updated_at) ?? new Date(0).toISOString(),
    }));
    return { definitions: MODULES, toggles, spaceId };
  }

  async setEnabled(
    user: AuthenticatedUser,
    moduleId: string,
    enabled: boolean,
  ): Promise<ModuleToggle> {
    if (!isModuleId(moduleId)) throw new ForbiddenException('unknown_module');
    const spaceId = await this.requireSpace(user);
    await this.access.assert(user.id, spaceId, 'spaces', 'manage_access');
    const row = await this.db.queryOne<ToggleRow>(
      `INSERT INTO module_toggles (space_id, module_id, enabled, updated_at)
       VALUES ($1,$2,$3,CURRENT_TIMESTAMP)
       ON CONFLICT (space_id, module_id)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = CURRENT_TIMESTAMP
       RETURNING module_id, enabled, updated_at`,
      [spaceId, moduleId as ModuleId, enabled],
    );
    if (!row) throw new Error('Module toggle update failed');
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: enabled ? 'module.enabled' : 'module.disabled',
      entity: 'module_toggle',
      entityId: moduleId,
    });
    return {
      moduleId,
      enabled: row.enabled,
      updatedAt: iso(row.updated_at) ?? new Date().toISOString(),
    };
  }
}
