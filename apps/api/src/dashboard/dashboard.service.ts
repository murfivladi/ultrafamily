import { ForbiddenException, Injectable } from '@nestjs/common';
import { MODULE_IDS, type DashboardSnapshot } from '@ufos/contracts';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../common/authed-request';
import { DatabaseService } from '../db/database.service';
import { toPublicPost, type PublicPostRow } from '../db/rows';
import { SessionService } from '../auth/session.service';

@Injectable()
export class DashboardService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  async snapshot(user: AuthenticatedUser, sessionId: string): Promise<DashboardSnapshot> {
    const space = await this.access.activeSpace(user.id);
    if (!space) throw new ForbiddenException('no_active_space');
    await this.access.assert(user.id, space.id, 'dashboard', 'read');

    const [memberCount, enabledModules, recentAudit, recentSessions, posts] = await Promise.all([
      this.db.queryOne<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM memberships WHERE space_id = $1',
        [space.id],
      ),
      this.db.queryOne<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM module_toggles WHERE space_id = $1 AND enabled = TRUE',
        [space.id],
      ),
      this.audit.list(space.id, 6),
      this.sessions.list(user.id, sessionId),
      this.db.query<PublicPostRow>(
        `SELECT p.id, p.slug, p.language, p.title, p.excerpt, p.body,
                p.published_at, s.name AS space_name
         FROM public_posts p JOIN spaces s ON s.id = p.space_id
         WHERE p.space_id = $1 AND p.unpublished_at IS NULL
           AND p.published_at <= CURRENT_TIMESTAMP
         ORDER BY p.published_at DESC LIMIT 3`,
        [space.id],
      ),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      activeSpaceName: space.name,
      memberCount: Number(memberCount?.count ?? 0),
      enabledModules: Number(enabledModules?.count ?? 0),
      totalModules: MODULE_IDS.length,
      recentAudit,
      recentSessions: recentSessions.slice(0, 4),
      publicPosts: posts.map(toPublicPost),
    };
  }
}
