import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  AuthSnapshot,
  ColorMode,
  Density,
  Language,
  ThemeName,
  UserPreferences,
} from '@ufos/contracts';
import { AccessService } from '../access/access.service';
import { hmac } from '../config';
import { DatabaseService } from '../db/database.service';
import {
  toPreferences,
  toSpace,
  toUser,
  type PreferencesRow,
  type SpaceRow,
  type UserRow,
} from '../db/rows';

export interface ProfilePatch {
  displayName?: string;
  language?: Language;
  avatarColor?: string;
}

export interface PreferencesPatch extends Partial<UserPreferences> {}

@Injectable()
export class UsersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
  ) {}

  async findById(userId: string): Promise<UserRow | null> {
    return this.db.queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
  }

  async snapshot(userId: string, sessionId: string): Promise<AuthSnapshot> {
    const user = await this.findById(userId);
    const preferences = await this.db.queryOne<PreferencesRow>(
      'SELECT * FROM user_preferences WHERE user_id = $1',
      [userId],
    );
    if (!user || !preferences) throw new NotFoundException('account_not_found');

    const spaceRows = await this.access.listSpaces(userId);
    const activeRow = await this.access.activeSpace(userId);
    const activeSpace = activeRow ? toSpace(activeRow) : null;
    const permissions = activeRow
      ? await this.access.permissionsForActiveSpace(userId, activeRow.id)
      : [];

    return {
      user: toUser(user),
      preferences: toPreferences(preferences),
      activeSpace,
      spaces: spaceRows.map((row) => ({ ...toSpace(row as SpaceRow), role: row.role })),
      platformRole: user.platform_role,
      permissions,
      csrfToken: hmac(sessionId),
    };
  }

  async updateProfile(userId: string, patch: ProfilePatch): Promise<AuthSnapshot['user']> {
    const current = await this.findById(userId);
    if (!current) throw new NotFoundException('account_not_found');
    const updated = await this.db.queryOne<UserRow>(
      `UPDATE users SET
         display_name = COALESCE($2, display_name),
         language = COALESCE($3, language),
         avatar_color = COALESCE($4, avatar_color),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *`,
      [userId, patch.displayName ?? null, patch.language ?? null, patch.avatarColor ?? null],
    );
    if (!updated) throw new NotFoundException('account_not_found');
    return toUser(updated);
  }

  async updatePreferences(userId: string, patch: PreferencesPatch): Promise<UserPreferences> {
    const current = await this.db.queryOne<PreferencesRow>(
      'SELECT * FROM user_preferences WHERE user_id = $1',
      [userId],
    );
    if (!current) throw new NotFoundException('preferences_not_found');
    const merged: UserPreferences = {
      ...toPreferences(current),
      ...patch,
    };
    const allowedThemes: ThemeName[] = ['family', 'sage', 'twilight'];
    const allowedModes: ColorMode[] = ['light', 'dark'];
    const allowedDensities: Density[] = ['comfortable', 'compact'];
    if (!allowedThemes.includes(merged.theme)) merged.theme = 'family';
    if (!allowedModes.includes(merged.colorMode)) merged.colorMode = 'light';
    if (!allowedDensities.includes(merged.density)) merged.density = 'comfortable';
    const stringArray = (value: unknown, fallback: string[]) =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string').slice(0, 30)
        : fallback;
    const widgets = stringArray(merged.widgets, []);
    const favorites = stringArray(merged.favorites, []);
    const quickActions = stringArray(merged.quickActions, []);
    const updated = await this.db.queryOne<PreferencesRow>(
      `UPDATE user_preferences SET
         theme = $2, color_mode = $3, density = $4,
         high_contrast = $5, large_text = $6, reduce_motion = $7,
         economy_mode = $8, simplified_ui = $9,
         widgets = $10, favorites = $11, quick_actions = $12,
         updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 RETURNING *`,
      [
        userId,
        merged.theme,
        merged.colorMode,
        merged.density,
        merged.highContrast,
        merged.largeText,
        merged.reduceMotion,
        merged.economyMode,
        merged.simplifiedUi,
        JSON.stringify(widgets),
        JSON.stringify(favorites),
        JSON.stringify(quickActions),
      ],
    );
    if (!updated) throw new NotFoundException('preferences_not_found');
    return toPreferences(updated);
  }

  async adminUsers() {
    const rows = await this.db.query<UserRow & { space_count: number | string }>(
      `SELECT u.*, COUNT(m.space_id)::int AS space_count
       FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id
       GROUP BY u.id
       ORDER BY u.created_at ASC`,
    );
    return rows.map((row) => ({ ...toUser(row), spaceCount: Number(row.space_count ?? 0) }));
  }
}
