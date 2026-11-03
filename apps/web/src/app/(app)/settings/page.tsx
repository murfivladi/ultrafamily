'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import * as Lucide from 'lucide-react';
import {
  MODULES,
  type ColorMode,
  type Density,
  type Language,
  type ThemeName,
} from '@ufos/contracts';
import { useApp } from '@/components/app-provider';
import {
  Badge,
  Button,
  Card,
  DynamicIcon,
  Field,
  LanguageSelect,
  PageHeader,
  Toggle,
} from '@/components/ui';
import { apiFetch } from '@/lib/api';

const THEMES: Array<{ id: ThemeName; labelKey: string; colors: [string, string] }> = [
  { id: 'family', labelKey: 'common.themeFamily', colors: ['#5B7CFA', '#3455D1'] },
  { id: 'sage', labelKey: 'common.themeSage', colors: ['#16866C', '#52D3AE'] },
  { id: 'twilight', labelKey: 'common.themeTwilight', colors: ['#7C5BD6', '#B79AFF'] },
];

export default function SettingsPage() {
  const { language, t, snapshot, preferences, updatePreferences, refresh, notify, online } =
    useApp();
  const [displayName, setDisplayName] = useState('');
  const [avatarColor, setAvatarColor] = useState('#5B7CFA');
  const [profileLanguage, setProfileLanguage] = useState<Language>('ru');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!snapshot) return;
    setDisplayName(snapshot.user.displayName);
    setAvatarColor(snapshot.user.avatarColor);
    setProfileLanguage(snapshot.user.language);
  }, [snapshot?.user.displayName, snapshot?.user.avatarColor, snapshot?.user.language]);

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!online) {
      notify(t('error.offlineSave'), 'error');
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await apiFetch('/profile', {
        method: 'PATCH',
        body: { displayName, avatarColor, language: profileLanguage },
      });
      await refresh();
      setMessage(t('settings.preferencesSaved'));
      notify(t('common.saved'), 'success');
    } catch {
      notify(t('common.error'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const accessibilityRows: Array<{ key: keyof typeof preferences; label: string; icon: string }> = [
    { key: 'highContrast', label: t('common.highContrast'), icon: 'Contrast' },
    { key: 'largeText', label: t('common.largeText'), icon: 'Type' },
    { key: 'reduceMotion', label: t('common.reduceMotion'), icon: 'Waves' },
    { key: 'economyMode', label: t('common.economyMode'), icon: 'Gauge' },
    { key: 'simplifiedUi', label: t('common.simplifiedUi'), icon: 'Smile' },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Stage A · Foundation"
        title={t('settings.title')}
        description={t('settings.subtitle')}
        action={
          <Badge tone="success">
            <Lucide.CloudCheck className="h-3.5 w-3.5" />
            {t('settings.serverSync')}
          </Badge>
        }
      />

      <div className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
        <Card className="p-6">
          <div className="mb-5 flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent-strong)]">
              <Lucide.CircleUserRound className="h-5 w-5" />
            </span>
            <h2 className="text-lg font-bold">{t('settings.profileSection')}</h2>
          </div>
          <form onSubmit={saveProfile} className="space-y-4">
            <Field label={t('common.displayName')} htmlFor="settings-name">
              <input
                id="settings-name"
                className="uf-input"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                required
                minLength={1}
                maxLength={80}
              />
            </Field>
            <Field label={t('common.email')} htmlFor="settings-email">
              <input
                id="settings-email"
                className="uf-input"
                value={snapshot?.user.email ?? ''}
                disabled
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('common.language')} htmlFor="settings-language">
                <LanguageSelect
                  value={profileLanguage}
                  onChange={setProfileLanguage}
                  ariaLabel={t('common.language')}
                  className="w-full"
                />
              </Field>
              <Field label={t('common.avatarColor')} htmlFor="settings-color">
                <input
                  id="settings-color"
                  type="color"
                  className="h-11 w-full cursor-pointer rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1"
                  value={avatarColor}
                  onChange={(event) => setAvatarColor(event.target.value)}
                />
              </Field>
            </div>
            {message ? (
              <p className="text-sm font-semibold text-[var(--success)]">{message}</p>
            ) : null}
            <Button type="submit" variant="primary" loading={saving}>
              <Lucide.Save className="h-4 w-4" />
              {t('settings.saveProfile')}
            </Button>
          </form>
        </Card>

        <div className="space-y-5">
          <Card className="p-6">
            <div className="mb-5 flex items-center gap-3">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent-strong)]">
                <Lucide.Palette className="h-5 w-5" />
              </span>
              <h2 className="text-lg font-bold">{t('settings.appearanceSection')}</h2>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {THEMES.map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  aria-pressed={preferences.theme === theme.id}
                  onClick={() => void updatePreferences({ theme: theme.id })}
                  className={`rounded-2xl border p-3 text-left transition ${preferences.theme === theme.id ? 'border-[var(--accent)] ring-2 ring-[var(--accent-soft)]' : 'border-[var(--border)]'}`}
                >
                  <span className="flex gap-1">
                    {theme.colors.map((color) => (
                      <span
                        key={color}
                        className="h-7 w-7 rounded-full"
                        style={{ background: color }}
                      />
                    ))}
                  </span>
                  <span className="mt-3 block text-sm font-bold">{t(theme.labelKey)}</span>
                </button>
              ))}
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="uf-label" htmlFor="settings-mode">
                  {t('common.theme')}
                </label>
                <select
                  id="settings-mode"
                  className="uf-select"
                  value={preferences.colorMode}
                  onChange={(event) =>
                    void updatePreferences({ colorMode: event.target.value as ColorMode })
                  }
                >
                  <option value="light">{t('common.light')}</option>
                  <option value="dark">{t('common.dark')}</option>
                </select>
              </div>
              <div>
                <label className="uf-label" htmlFor="settings-density">
                  {t('common.density')}
                </label>
                <select
                  id="settings-density"
                  className="uf-select"
                  value={preferences.density}
                  onChange={(event) =>
                    void updatePreferences({ density: event.target.value as Density })
                  }
                >
                  <option value="comfortable">{t('common.comfortable')}</option>
                  <option value="compact">{t('common.compact')}</option>
                </select>
              </div>
            </div>
          </Card>

          <Card className="p-6">
            <div className="mb-4 flex items-center gap-3">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent-strong)]">
                <Lucide.Accessibility className="h-5 w-5" />
              </span>
              <h2 className="text-lg font-bold">{t('settings.accessibilitySection')}</h2>
            </div>
            <div className="divide-y divide-[var(--border)]">
              {accessibilityRows.map((row) => (
                <div key={row.key} className="flex items-center justify-between gap-4 py-3">
                  <span className="flex items-center gap-3 text-sm font-semibold">
                    <DynamicIcon name={row.icon} className="h-4 w-4 text-[var(--muted)]" />
                    {row.label}
                  </span>
                  <Toggle
                    checked={Boolean(preferences[row.key])}
                    onChange={(value) => void updatePreferences({ [row.key]: value })}
                    label={row.label}
                  />
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <Card className="mt-5 p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">{t('settings.widgetsSection')}</h2>
            <p className="text-xs text-[var(--muted)]">{t('nav.widgetOrder')}</p>
          </div>
          <Link href="/catalog" className="uf-button">
            <Lucide.Grid2X2 className="h-4 w-4" />
            {t('common.catalog')}
          </Link>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <p className="mb-2 text-xs font-extrabold uppercase tracking-wider text-[var(--muted)]">
              {t('common.favorites')}
            </p>
            <div className="flex flex-wrap gap-2">
              {preferences.favorites.map((id) => {
                const module = MODULES.find((item) => item.id === id);
                return (
                  <button
                    key={id}
                    type="button"
                    className="uf-badge hover:border-rose-400"
                    onClick={() =>
                      void updatePreferences({
                        favorites: preferences.favorites.filter((item) => item !== id),
                      })
                    }
                    aria-label={`${t('catalog.unfavorite')} ${module ? t(`modules.${module.id}`) : id}`}
                  >
                    {module ? <DynamicIcon name={module.icon} className="h-3.5 w-3.5" /> : null}
                    {module ? t(`modules.${module.id}`) : id}
                    <Lucide.X className="h-3 w-3" />
                  </button>
                );
              })}
              {preferences.favorites.length === 0 ? (
                <span className="text-sm text-[var(--muted)]">{t('common.noData')}</span>
              ) : null}
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs font-extrabold uppercase tracking-wider text-[var(--muted)]">
              {t('common.quickActions')}
            </p>
            <div className="flex flex-wrap gap-2">
              {preferences.quickActions.map((action) => (
                <Badge key={action} tone="accent">
                  {action}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      </Card>
    </>
  );
}
