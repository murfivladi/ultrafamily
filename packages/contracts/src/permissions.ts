import { MODULES_BY_ID, MODULE_IDS, type ModuleId } from './modules';
import type { Action, OverrideDecision, SpaceRole } from './types';

export const ALL_ACTIONS: readonly Action[] = [
  'read',
  'create',
  'update',
  'delete',
  'publish',
  'export',
  'manage_access',
];

export type PermissionReason =
  | 'allowed_by_role'
  | 'allowed_by_override'
  | 'allowed_by_explicit_share'
  | 'denied_by_override'
  | 'module_disabled'
  | 'guest_requires_explicit_share'
  | 'guest_read_only'
  | 'child_restricted_module'
  | 'child_restricted_action'
  | 'sensitive_grant_required'
  | 'platform_role_has_no_data_access'
  | 'role_not_permitted';

export interface PermissionQuery {
  role: SpaceRole;
  moduleId: ModuleId;
  action: Action;
  moduleEnabled?: boolean;
  override?: OverrideDecision;
  explicitlyShared?: boolean;
  sensitiveGrant?: boolean;
  isChild?: boolean;
  isPlatformAdmin?: boolean;
}

export interface PermissionResult {
  allowed: boolean;
  reason: PermissionReason;
}

type CapabilityMap = Partial<Record<ModuleId, readonly Action[]>>;

const coreRead = ['read'] as const;
const coreMember = ['read', 'create', 'update'] as const;
const coreEditor = ['read', 'create', 'update', 'delete'] as const;
const corePublisher = ['read', 'create', 'update', 'delete', 'publish', 'export'] as const;
const coreManager = [...ALL_ACTIONS] as Action[];

function capabilities(modules: readonly ModuleId[], actions: readonly Action[]): CapabilityMap {
  return Object.fromEntries(modules.map((id) => [id, actions])) as CapabilityMap;
}

const systemModules = ['admin', 'api', 'analytics', 'export', 'sessions'] as ModuleId[];
const everydayModules = [
  'calendar',
  'tasks',
  'notifications',
  'shopping',
  'recipes',
  'menu',
  'pantry',
  'home_inventory',
  'maintenance',
  'travel',
  'energy',
  'weather',
] as ModuleId[];
const communicationModules = ['messenger', 'calls', 'feed', 'decisions', 'documents'] as ModuleId[];
const memoryModules = [
  'files',
  'photos',
  'search',
  'journal',
  'memories',
  'encyclopedia',
] as ModuleId[];
const privateModules = [
  'finances',
  'vault',
  'school',
  'health',
  'places',
  'automations',
  'assistant',
] as ModuleId[];
const foundationModules = [
  'dashboard',
  'catalog',
  'profile',
  'spaces',
  'settings',
  'public_site',
] as ModuleId[];

// Platform administration is deliberately not a back door to family data.
export const PLATFORM_ROLE_CAPABILITIES: CapabilityMap = {
  admin: coreManager,
  api: coreEditor,
  analytics: corePublisher,
  export: corePublisher,
  sessions: coreRead,
};

const ownerMap: CapabilityMap = Object.fromEntries(
  MODULE_IDS.map((id) => [id, coreManager]),
) as CapabilityMap;

const adminMap: CapabilityMap = {
  ...capabilities(foundationModules, corePublisher),
  ...capabilities(everydayModules, corePublisher),
  ...capabilities(communicationModules, corePublisher),
  ...capabilities(memoryModules, corePublisher),
  ...capabilities(privateModules, coreEditor),
  ...capabilities(systemModules, coreRead),
};

const adultMap: CapabilityMap = {
  ...capabilities(foundationModules, coreMember),
  ...capabilities(everydayModules, coreEditor),
  ...capabilities(communicationModules, coreMember),
  ...capabilities(memoryModules, coreMember),
  ...capabilities(privateModules, coreRead),
};

const childMap: CapabilityMap = {
  ...capabilities(foundationModules, coreRead),
  ...capabilities(
    ['calendar', 'tasks', 'shopping', 'notifications', 'recipes', 'menu'],
    coreMember,
  ),
  ...capabilities(['feed', 'documents', 'journal', 'memories', 'school'], coreMember),
  // Children see family photos and can search what they already may read;
  // personal file storage and the encyclopedia stay with adults.
  ...capabilities(['photos', 'search'], coreRead),
  // Children talk to their family in chats they were added to and take part in
  // family decisions, but they cannot moderate, publish or create channels.
  ...capabilities(['messenger', 'decisions'], coreRead),
  settings: coreMember,
  dashboard: coreRead,
  catalog: coreRead,
  profile: coreMember,
};

const guestMap: CapabilityMap = {};

export const ROLE_CAPABILITIES: Record<SpaceRole, CapabilityMap> = {
  space_owner: ownerMap,
  space_admin: adminMap,
  adult: adultMap,
  child: childMap,
  guest: guestMap,
};

export const ROLE_LABEL_KEYS: Record<SpaceRole, string> = {
  space_owner: 'roles.spaceOwner',
  space_admin: 'roles.spaceAdmin',
  adult: 'roles.adult',
  child: 'roles.child',
  guest: 'roles.guest',
};

export function resolvePermission(query: PermissionQuery): PermissionResult {
  const {
    role,
    moduleId,
    action,
    moduleEnabled = true,
    override,
    explicitlyShared = false,
    sensitiveGrant = false,
    isChild = role === 'child',
    isPlatformAdmin = false,
  } = query;

  if (override === 'deny') {
    return { allowed: false, reason: 'denied_by_override' };
  }
  if (!moduleEnabled) {
    return { allowed: false, reason: 'module_disabled' };
  }
  if (isPlatformAdmin) {
    return { allowed: false, reason: 'platform_role_has_no_data_access' };
  }
  if (override === 'allow') {
    // An explicit allow never bypasses guest, child or sensitive-data safety rails.
    if (role !== 'guest' && !isChild && (!MODULES_BY_ID[moduleId].sensitive || sensitiveGrant)) {
      return { allowed: true, reason: 'allowed_by_override' };
    }
  }
  if (role === 'guest') {
    if (!explicitlyShared) {
      return { allowed: false, reason: 'guest_requires_explicit_share' };
    }
    if (action === 'read') {
      return { allowed: true, reason: 'allowed_by_explicit_share' };
    }
    return { allowed: false, reason: 'guest_read_only' };
  }
  if (isChild) {
    if (MODULES_BY_ID[moduleId].childRestricted) {
      return { allowed: false, reason: 'child_restricted_module' };
    }
    if (
      action === 'publish' ||
      action === 'export' ||
      action === 'manage_access' ||
      action === 'delete'
    ) {
      return { allowed: false, reason: 'child_restricted_action' };
    }
  }
  if (MODULES_BY_ID[moduleId].sensitive && role !== 'space_owner' && !sensitiveGrant) {
    return { allowed: false, reason: 'sensitive_grant_required' };
  }

  const granted = ROLE_CAPABILITIES[role][moduleId] ?? [];
  if (granted.includes(action)) {
    return { allowed: true, reason: 'allowed_by_role' };
  }
  return { allowed: false, reason: 'role_not_permitted' };
}

export function permissionKey(moduleId: ModuleId, action: Action): string {
  return `${moduleId}:${action}`;
}

export function permissionsForMembership(
  role: SpaceRole,
  overrides: Record<string, OverrideDecision> = {},
  enabledModuleIds: readonly ModuleId[] = MODULE_IDS,
  sensitiveGrants: readonly string[] = [],
  isPlatformAdmin = false,
): string[] {
  const enabled = new Set(enabledModuleIds);
  const grants = new Set(sensitiveGrants);
  const result: string[] = [];
  for (const moduleId of MODULE_IDS) {
    for (const action of ALL_ACTIONS) {
      const key = permissionKey(moduleId, action);
      const query: PermissionQuery = {
        role,
        moduleId,
        action,
        moduleEnabled: enabled.has(moduleId),
        override: overrides[key],
        sensitiveGrant: grants.has(moduleId),
        isPlatformAdmin,
      };
      if (resolvePermission(query).allowed) {
        result.push(key);
      }
    }
  }
  return result;
}
