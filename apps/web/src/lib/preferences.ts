import type { Language, UserPreferences } from '@ufos/contracts';

export const DEFAULT_PREFERENCES: UserPreferences = {
  theme: 'family',
  colorMode: 'light',
  density: 'comfortable',
  highContrast: false,
  largeText: false,
  reduceMotion: false,
  economyMode: false,
  simplifiedUi: false,
  widgets: ['feed', 'overview', 'important', 'security', 'activity'],
  favorites: ['dashboard', 'calendar', 'tasks', 'notifications', 'shopping'],
  feedSources: ['calendar', 'tasks', 'notifications', 'shopping', 'family', 'security'],
  quickActions: ['new-task', 'new-event', 'invite'],
};

const LANGUAGE_KEY = 'ufos.language';
const PREFERENCES_KEY = 'ufos.preferences';

export function readLocalSettings(): { language: Language; preferences: UserPreferences } {
  if (typeof window === 'undefined') {
    return { language: 'ru', preferences: DEFAULT_PREFERENCES };
  }
  let language: Language = 'ru';
  let preferences: UserPreferences = DEFAULT_PREFERENCES;
  try {
    const storedLanguage = window.localStorage.getItem(LANGUAGE_KEY);
    if (storedLanguage === 'ru' || storedLanguage === 'it') language = storedLanguage;
    const storedPreferences = window.localStorage.getItem(PREFERENCES_KEY);
    if (storedPreferences) {
      preferences = {
        ...DEFAULT_PREFERENCES,
        ...(JSON.parse(storedPreferences) as Partial<UserPreferences>),
      };
    }
  } catch {
    // Corrupted local preferences should never prevent the interface from loading.
  }
  return { language, preferences };
}

export function writeLocalSettings(language: Language, preferences: UserPreferences): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LANGUAGE_KEY, language);
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Storage can be disabled in private browsing; server settings remain authoritative.
  }
}

export function applyDocumentSettings(language: Language, preferences: UserPreferences): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.lang = language;
  root.dataset.theme = preferences.theme;
  root.dataset.mode = preferences.colorMode;
  root.dataset.density = preferences.density;
  root.dataset.contrast = String(preferences.highContrast);
  root.dataset.largeText = String(preferences.largeText);
  root.dataset.reduceMotion = String(preferences.reduceMotion);
  root.dataset.economy = String(preferences.economyMode);
  root.dataset.simplified = String(preferences.simplifiedUi);
}
