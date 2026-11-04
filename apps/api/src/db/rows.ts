import type {
  AuditEvent,
  ColorMode,
  Density,
  Language,
  PlatformRole,
  PublicPost,
  PublicationStatus,
  PublicationVisibility,
  Space,
  SpaceKind,
  SpaceRole,
  ThemeName,
  UserPreferences,
  UserProfile,
} from '@ufos/contracts';

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  avatar_color: string;
  language: Language;
  platform_role: PlatformRole | null;
  email_verified_at: Date | string | null;
  is_child: boolean;
  failed_login_count: number;
  locked_until: Date | string | null;
  created_at: Date | string;
}

export interface PreferencesRow {
  user_id: string;
  active_space_id: string | null;
  theme: ThemeName;
  color_mode: ColorMode;
  density: Density;
  high_contrast: boolean;
  large_text: boolean;
  reduce_motion: boolean;
  economy_mode: boolean;
  simplified_ui: boolean;
  widgets: unknown;
  favorites: unknown;
  quick_actions: unknown;
  feed_sources: unknown;
}

export interface SpaceRow {
  id: string;
  name: string;
  kind: SpaceKind;
  network_id: string | null;
  parent_space_id: string | null;
  owner_user_id: string | null;
  created_at: Date | string;
}

export interface MembershipRow {
  space_id: string;
  user_id: string;
  role: SpaceRole;
  overrides: unknown;
  sensitive_grants: unknown;
  joined_at: Date | string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: Date | string;
  last_seen_at: Date | string;
  expires_at: Date | string;
  user_agent: string | null;
  ip_prefix: string | null;
  trusted: boolean;
  revoked_at: Date | string | null;
}

export interface AuditRow {
  sequence: number | string;
  id: string;
  created_at: Date | string;
  actor_user_id: string | null;
  actor_email: string | null;
  space_id: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  metadata: unknown;
  canonical_payload: string;
  previous_hash: string;
  chain_hash: string;
}

export interface PublicPostRow {
  id: string;
  slug: string;
  language: Language;
  title: string;
  excerpt: string;
  body: string;
  published_at: Date | string;
  space_name: string;
  status?: PublicationStatus;
  visibility?: PublicationVisibility;
  updated_at?: Date | string | null;
  audience_space_ids?: unknown;
  guest_shared?: boolean;
}

export function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? new Date(0).toISOString() : date.toISOString();
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  if (typeof value === 'object') return value as T;
  return fallback;
}

export function toUser(row: UserRow): UserProfile {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    avatarColor: row.avatar_color,
    language: row.language,
    platformRole: row.platform_role,
    emailVerifiedAt: iso(row.email_verified_at),
    isChild: row.is_child,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
  };
}

export function toPreferences(row: PreferencesRow): UserPreferences {
  return {
    theme: row.theme,
    colorMode: row.color_mode,
    density: row.density,
    highContrast: row.high_contrast,
    largeText: row.large_text,
    reduceMotion: row.reduce_motion,
    economyMode: row.economy_mode,
    simplifiedUi: row.simplified_ui,
    widgets: parseJson<string[]>(row.widgets, []),
    favorites: parseJson<string[]>(row.favorites, []),
    quickActions: parseJson<string[]>(row.quick_actions, []),
    feedSources: parseJson<string[]>(row.feed_sources, [
      'calendar',
      'tasks',
      'notifications',
      'shopping',
      'family',
      'security',
    ]),
  };
}

export function toSpace(row: SpaceRow): Space {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    networkId: row.network_id,
    parentSpaceId: row.parent_space_id,
    ownerUserId: row.owner_user_id,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
  };
}

export function toAuditEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    actorUserId: row.actor_user_id,
    actorEmail: row.actor_email,
    spaceId: row.space_id,
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id,
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    chainHash: row.chain_hash,
  };
}

export function toPublicPost(row: PublicPostRow): PublicPost {
  return {
    id: row.id,
    slug: row.slug,
    language: row.language,
    title: row.title,
    excerpt: row.excerpt,
    body: row.body,
    publishedAt: iso(row.published_at) ?? new Date(0).toISOString(),
    spaceName: row.space_name,
    ...(row.status ? { status: row.status } : {}),
    ...(row.visibility ? { visibility: row.visibility } : {}),
    ...(row.updated_at ? { updatedAt: iso(row.updated_at) ?? undefined } : {}),
    ...(row.audience_space_ids !== undefined
      ? { audienceSpaceIds: parseJson<string[]>(row.audience_space_ids, []) }
      : {}),
    ...(row.guest_shared !== undefined ? { guestShared: row.guest_shared } : {}),
  };
}
