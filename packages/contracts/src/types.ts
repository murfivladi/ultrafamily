export type Language = 'ru' | 'it';
export type ColorMode = 'light' | 'dark';
export type ThemeName = 'family' | 'sage' | 'twilight';
export type Density = 'comfortable' | 'compact';

export type PlatformRole = 'platform_owner' | 'platform_admin';
export type SpaceRole = 'space_owner' | 'space_admin' | 'adult' | 'child' | 'guest';

export type SpaceKind = 'family_network' | 'household' | 'personal';
export type Action =
  'read' | 'create' | 'update' | 'delete' | 'publish' | 'export' | 'manage_access';

export type OverrideDecision = 'allow' | 'deny';
export type ModuleStatus = 'foundation' | 'planned' | 'available';

export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  avatarColor: string;
  language: Language;
  platformRole: PlatformRole | null;
  emailVerifiedAt: string | null;
  isChild: boolean;
  createdAt: string;
}

export interface UserPreferences {
  theme: ThemeName;
  colorMode: ColorMode;
  density: Density;
  highContrast: boolean;
  largeText: boolean;
  reduceMotion: boolean;
  economyMode: boolean;
  simplifiedUi: boolean;
  widgets: string[];
  favorites: string[];
  quickActions: string[];
}

export interface Space {
  id: string;
  name: string;
  kind: SpaceKind;
  networkId: string | null;
  parentSpaceId: string | null;
  ownerUserId: string | null;
  createdAt: string;
}

export interface Membership {
  spaceId: string;
  userId: string;
  role: SpaceRole;
  overrides: Record<string, OverrideDecision>;
  sensitiveGrants: string[];
  joinedAt: string;
}

export interface Session {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  ipPrefix: string | null;
  trusted: boolean;
  current: boolean;
}

export interface AuditEvent {
  id: string;
  createdAt: string;
  actorUserId: string | null;
  actorEmail: string | null;
  spaceId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  metadata: Record<string, unknown>;
  chainHash: string;
}

export interface PublicPost {
  id: string;
  slug: string;
  language: Language;
  title: string;
  excerpt: string;
  body: string;
  publishedAt: string;
  spaceName: string;
}

export interface ModuleToggle {
  moduleId: string;
  enabled: boolean;
  updatedAt: string;
}

export interface AuthSnapshot {
  user: UserProfile;
  preferences: UserPreferences;
  activeSpace: Space | null;
  spaces: Array<Space & { role: SpaceRole }>;
  platformRole: PlatformRole | null;
  permissions: string[];
  csrfToken: string;
}

export interface DashboardSnapshot {
  generatedAt: string;
  activeSpaceName: string;
  memberCount: number;
  enabledModules: number;
  totalModules: number;
  recentAudit: AuditEvent[];
  recentSessions: Session[];
  publicPosts: PublicPost[];
}

export interface AdminSnapshot {
  users: Array<UserProfile & { spaceCount: number }>;
  spaces: Array<Space & { memberCount: number }>;
  audit: AuditEvent[];
  modules: ModuleToggle[];
}
