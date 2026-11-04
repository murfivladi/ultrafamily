'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { AuthSnapshot, Language, UserPreferences } from '@ufos/contracts';
import { apiFetch, setCsrfToken } from '@/lib/api';
import { translate } from '@/lib/i18n';
import {
  applyDocumentSettings,
  DEFAULT_PREFERENCES,
  readLocalSettings,
  writeLocalSettings,
} from '@/lib/preferences';

type AuthStatus = 'loading' | 'authenticated' | 'anonymous';
type ToastTone = 'info' | 'success' | 'error';

interface ToastState {
  id: number;
  message: string;
  tone: ToastTone;
}

interface AppContextValue {
  language: Language;
  t: (key: string, variables?: Record<string, string | number>) => string;
  selectLanguage: (language: Language) => Promise<void>;
  preferences: UserPreferences;
  updatePreferences: (patch: Partial<UserPreferences>) => Promise<void>;
  snapshot: AuthSnapshot | null;
  authStatus: AuthStatus;
  refresh: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<AuthSnapshot>;
  signOut: () => Promise<void>;
  notify: (message: string, tone?: ToastTone) => void;
  online: boolean;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>('ru');
  const [preferences, setPreferences] = useState<UserPreferences>(DEFAULT_PREFERENCES);
  const [snapshot, setSnapshot] = useState<AuthSnapshot | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>('loading');
  const [hydrated, setHydrated] = useState(false);
  const [online, setOnline] = useState(true);
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const t = useCallback(
    (key: string, variables: Record<string, string | number> = {}) =>
      translate(language, key, variables),
    [language],
  );

  const notify = useCallback((message: string, tone: ToastTone = 'info') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    const id = Date.now();
    setToast({ id, message, tone });
    toastTimer.current = setTimeout(() => setToast(null), 3800);
  }, []);

  const applySnapshot = useCallback((next: AuthSnapshot) => {
    setCsrfToken(next.csrfToken);
    setSnapshot(next);
    setPreferences(next.preferences);
    setLanguageState(next.user.language);
    setAuthStatus('authenticated');
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await apiFetch<AuthSnapshot>('/auth/me');
      applySnapshot(next);
    } catch {
      setCsrfToken(null);
      setSnapshot(null);
      setAuthStatus('anonymous');
    }
  }, [applySnapshot]);

  useEffect(() => {
    const local = readLocalSettings();
    setLanguageState(local.language);
    setPreferences(local.preferences);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    applyDocumentSettings(language, preferences);
    writeLocalSettings(language, preferences);
  }, [hydrated, language, preferences]);

  useEffect(() => {
    setOnline(typeof navigator === 'undefined' ? true : navigator.onLine);
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    void refresh();
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
      void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }
  }, [hydrated, refresh]);

  const selectLanguage = useCallback(
    async (next: Language) => {
      setLanguageState(next);
      if (!snapshot) return;
      try {
        await apiFetch('/profile', { method: 'PATCH', body: { language: next } });
        setSnapshot((current) =>
          current ? { ...current, user: { ...current.user, language: next } } : current,
        );
      } catch {
        notify(translate(next, 'error.offlineSave'), 'error');
      }
    },
    [notify, snapshot],
  );

  const updatePreferences = useCallback(
    async (patch: Partial<UserPreferences>) => {
      if (!navigator.onLine) {
        notify(translate(language, 'error.offlineSave'), 'error');
        return;
      }
      setPreferences((current) => ({ ...current, ...patch }));
      if (!snapshot) return;
      try {
        await apiFetch('/profile/preferences', { method: 'PATCH', body: patch });
      } catch {
        notify(translate(language, 'common.error'), 'error');
      }
    },
    [language, notify, snapshot],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      const next = await apiFetch<AuthSnapshot>('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      applySnapshot(next);
      return next;
    },
    [applySnapshot],
  );

  const signOut = useCallback(async () => {
    try {
      await apiFetch('/auth/logout', { method: 'POST', body: {} });
    } finally {
      setCsrfToken(null);
      setSnapshot(null);
      setAuthStatus('anonymous');
    }
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({
      language,
      t,
      selectLanguage,
      preferences,
      updatePreferences,
      snapshot,
      authStatus,
      refresh,
      signIn,
      signOut,
      notify,
      online,
    }),
    [
      language,
      t,
      selectLanguage,
      preferences,
      updatePreferences,
      snapshot,
      authStatus,
      refresh,
      signIn,
      signOut,
      notify,
      online,
    ],
  );

  return (
    <AppContext.Provider value={value}>
      {children}
      {toast ? (
        <div
          key={toast.id}
          className={`uf-toast uf-toast-${toast.tone}`}
          role="status"
          aria-live="polite"
        >
          {toast.message}
        </div>
      ) : null}
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used inside AppProvider');
  return context;
}
