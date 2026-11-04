import type { ModuleStatus } from './types';

export const MODULE_IDS = [
  'dashboard',
  'catalog',
  'profile',
  'spaces',
  'settings',
  'sessions',
  'admin',
  'public_site',
  'calendar',
  'tasks',
  'notifications',
  'shopping',
  'files',
  'photos',
  'documents',
  'search',
  'messenger',
  'calls',
  'feed',
  'decisions',
  'recipes',
  'menu',
  'pantry',
  'finances',
  'home_inventory',
  'maintenance',
  'vault',
  'school',
  'health',
  'journal',
  'memories',
  'encyclopedia',
  'travel',
  'energy',
  'weather',
  'places',
  'automations',
  'assistant',
  'api',
  'analytics',
  'export',
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];
export type InternalStage = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';

export interface ModuleDefinition {
  id: ModuleId;
  stage: InternalStage;
  status: ModuleStatus;
  sensitive: boolean;
  childRestricted: boolean;
  icon: string;
  group:
    | 'core'
    | 'organize'
    | 'communicate'
    | 'memory'
    | 'everyday'
    | 'private'
    | 'intelligence'
    | 'system';
}

// Modules available in the current internal foundation. Stage B extends the
// Stage A base with the organizational core; "planned" modules remain roadmap.
const foundationModules = new Set<ModuleId>([
  'dashboard',
  'catalog',
  'profile',
  'spaces',
  'settings',
  'sessions',
  'admin',
  'public_site',
  'calendar',
  'tasks',
  'notifications',
  'shopping',
]);

const sensitiveModules = new Set<ModuleId>([
  'finances',
  'vault',
  'school',
  'health',
  'places',
  'assistant',
]);

const childRestrictedModules = new Set<ModuleId>([
  'admin',
  'public_site',
  'finances',
  'vault',
  'health',
  'places',
  'automations',
  'api',
  'analytics',
  'export',
  'calls',
  'assistant',
]);

const icons: Record<ModuleId, string> = {
  dashboard: 'LayoutDashboard',
  catalog: 'Grid2X2',
  profile: 'CircleUserRound',
  spaces: 'UsersRound',
  settings: 'Settings2',
  sessions: 'ShieldCheck',
  admin: 'ServerCog',
  public_site: 'Globe2',
  calendar: 'CalendarDays',
  tasks: 'ListTodo',
  notifications: 'BellRing',
  shopping: 'ShoppingBasket',
  files: 'FolderOpen',
  photos: 'Images',
  documents: 'FileText',
  search: 'Search',
  messenger: 'MessagesSquare',
  calls: 'Video',
  feed: 'Newspaper',
  decisions: 'Vote',
  recipes: 'ChefHat',
  menu: 'Utensils',
  pantry: 'Refrigerator',
  finances: 'Wallet',
  home_inventory: 'Boxes',
  maintenance: 'Wrench',
  vault: 'LockKeyhole',
  school: 'GraduationCap',
  health: 'HeartPulse',
  journal: 'BookHeart',
  memories: 'Sparkles',
  encyclopedia: 'Network',
  travel: 'Map',
  energy: 'Zap',
  weather: 'CloudSun',
  places: 'MapPin',
  automations: 'Workflow',
  assistant: 'Bot',
  api: 'Braces',
  analytics: 'ChartNoAxesCombined',
  export: 'PackageOpen',
};

const groups: Record<ModuleId, ModuleDefinition['group']> = {
  dashboard: 'core',
  catalog: 'core',
  profile: 'core',
  spaces: 'core',
  settings: 'core',
  sessions: 'core',
  admin: 'system',
  public_site: 'core',
  calendar: 'organize',
  tasks: 'organize',
  notifications: 'organize',
  shopping: 'organize',
  files: 'memory',
  photos: 'memory',
  documents: 'communicate',
  search: 'memory',
  messenger: 'communicate',
  calls: 'communicate',
  feed: 'communicate',
  decisions: 'communicate',
  recipes: 'everyday',
  menu: 'everyday',
  pantry: 'everyday',
  finances: 'private',
  home_inventory: 'everyday',
  maintenance: 'everyday',
  vault: 'private',
  school: 'private',
  health: 'private',
  journal: 'memory',
  memories: 'memory',
  encyclopedia: 'memory',
  travel: 'everyday',
  energy: 'everyday',
  weather: 'everyday',
  places: 'private',
  automations: 'intelligence',
  assistant: 'intelligence',
  api: 'system',
  analytics: 'system',
  export: 'system',
};

const stages: Record<ModuleId, InternalStage> = {
  dashboard: 'A',
  catalog: 'A',
  profile: 'A',
  spaces: 'A',
  settings: 'A',
  sessions: 'A',
  admin: 'A',
  public_site: 'B',
  calendar: 'B',
  tasks: 'B',
  notifications: 'B',
  shopping: 'B',
  files: 'D',
  photos: 'D',
  documents: 'C',
  search: 'D',
  messenger: 'C',
  calls: 'C',
  feed: 'C',
  decisions: 'C',
  recipes: 'E',
  menu: 'E',
  pantry: 'E',
  finances: 'E',
  home_inventory: 'E',
  maintenance: 'E',
  vault: 'F',
  school: 'F',
  health: 'F',
  journal: 'D',
  memories: 'D',
  encyclopedia: 'D',
  travel: 'E',
  energy: 'E',
  weather: 'E',
  places: 'E',
  automations: 'G',
  assistant: 'G',
  api: 'H',
  analytics: 'H',
  export: 'H',
};

export const MODULES: readonly ModuleDefinition[] = MODULE_IDS.map((id) => ({
  id,
  icon: icons[id],
  group: groups[id],
  stage: stages[id],
  sensitive: sensitiveModules.has(id),
  childRestricted: childRestrictedModules.has(id),
  status: foundationModules.has(id) ? 'foundation' : 'planned',
}));

export const MODULES_BY_ID: Record<ModuleId, ModuleDefinition> = Object.fromEntries(
  MODULES.map((module) => [module.id, module]),
) as Record<ModuleId, ModuleDefinition>;

export const SENSITIVE_MODULE_IDS: readonly ModuleId[] = [...sensitiveModules];
export const CHILD_RESTRICTED_MODULE_IDS: readonly ModuleId[] = [...childRestrictedModules];
export const FOUNDATION_MODULE_IDS: readonly ModuleId[] = [...foundationModules];
/** @deprecated Use FOUNDATION_MODULE_IDS; kept for Stage A callers. */
export const STAGE_A_MODULE_IDS: readonly ModuleId[] = FOUNDATION_MODULE_IDS;
export const STAGE_B_MODULE_IDS: readonly ModuleId[] = [
  'dashboard',
  'calendar',
  'tasks',
  'notifications',
  'shopping',
  'public_site',
];

export function isModuleId(value: string): value is ModuleId {
  return (MODULE_IDS as readonly string[]).includes(value);
}
