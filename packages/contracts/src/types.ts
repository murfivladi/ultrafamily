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
  feedSources: string[];
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

export type PublicationStatus = 'draft' | 'published' | 'unpublished';
export type PublicationVisibility = 'public' | 'network' | 'household';

export interface PublicPost {
  id: string;
  slug: string;
  language: Language;
  title: string;
  excerpt: string;
  body: string;
  publishedAt: string;
  spaceName: string;
  status?: PublicationStatus;
  visibility?: PublicationVisibility;
  updatedAt?: string;
  audienceSpaceIds?: string[];
  guestShared?: boolean;
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

export type CalendarView = 'day' | 'week' | 'month' | 'agenda';
export type CalendarKind = 'personal' | 'family' | 'network' | 'birthdays' | 'holidays' | 'trip';
export type RsvpStatus = 'pending' | 'accepted' | 'declined' | 'tentative';

export interface CalendarSummary {
  id: string;
  spaceId: string;
  name: string;
  kind: CalendarKind;
  color: string;
  ctag: string;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  spaceId: string;
  uid: string;
  title: string;
  description: string;
  location: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  timezone: string;
  category: string;
  color: string;
  recurrenceRule: string | null;
  status: 'confirmed' | 'tentative' | 'cancelled';
  participants: Array<{ userId: string; rsvp: RsvpStatus }>;
  links: Array<{ module: string; targetId: string }>;
  etag: string;
  version: number;
  isOccurrence?: boolean;
  occurrenceStart?: string;
  updatedAt: string;
}

export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface TaskItem {
  id: string;
  listId: string;
  spaceId: string;
  parentTaskId: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  category: string;
  assigneeUserId: string | null;
  dueAt: string | null;
  estimateMinutes: number;
  complexity: number;
  recurrenceRule: string | null;
  position: number;
  subtaskCount: number;
  dependencyCount: number;
  version: number;
  updatedAt: string;
}

export interface TaskBoard {
  lists: Array<{ id: string; name: string; color: string; kind: string }>;
  tasks: TaskItem[];
  workload: Array<{ userId: string; openTasks: number; minutes: number }>;
}

export type NotificationSeverity = 'info' | 'important' | 'urgent';
export type NotificationChannel = 'in_app' | 'push' | 'email' | 'telegram' | 'webhook';

export interface NotificationItem {
  id: string;
  spaceId: string | null;
  category: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  sourceModule: string;
  sourceId: string | null;
  actionUrl: string | null;
  groupedCount: number;
  createdAt: string;
  readAt: string | null;
  expiresAt: string | null;
}

export interface NotificationPreferences {
  channels: Record<string, NotificationChannel[]>;
  quietHours: { enabled: boolean; from: string; to: string; timezone: string };
  dailyDigest: boolean;
  weeklyDigest: boolean;
  urgentOverride: boolean;
  categories: Record<string, boolean>;
}

export interface ShoppingList {
  id: string;
  spaceId: string;
  name: string;
  kind: string;
  status: 'active' | 'archived';
  version: number;
  items: ShoppingItem[];
  presence: Array<{ userId: string; status: string; lastSeenAt: string }>;
  updatedAt: string;
}

export interface ShoppingItem {
  id: string;
  listId: string;
  name: string;
  quantity: number;
  unit: string;
  category: string;
  checked: boolean;
  assignedUserId: string | null;
  sourceModule: string | null;
  sourceId: string | null;
  notes: string;
  position: number;
}

export interface FeedItem {
  id: string;
  source: 'calendar' | 'tasks' | 'notifications' | 'shopping' | 'family' | 'security';
  severity: NotificationSeverity;
  title: string;
  detail: string;
  reason: string;
  dueAt: string | null;
  href: string;
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
  feed: FeedItem[];
  feedSources: string[];
  events: CalendarEvent[];
  tasks: TaskItem[];
  notifications: NotificationItem[];
  shopping: ShoppingList[];
}

export interface AdminSnapshot {
  users: Array<UserProfile & { spaceCount: number }>;
  spaces: Array<Space & { memberCount: number }>;
  audit: AuditEvent[];
  modules: ModuleToggle[];
}
