'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as Lucide from 'lucide-react';
import { useApp } from '@/components/app-provider';
import { Badge, Brand, Button, Card, Field, LanguageSelect, Toggle } from '@/components/ui';
import { ApiError, apiFetch } from '@/lib/api';
import { errorMessage } from '@/lib/i18n';

const DEMO_PASSWORD = process.env.NEXT_PUBLIC_DEMO_PASSWORD || 'FamilyOS!2026';
const DEMO_ACCOUNTS = [
  { key: 'login.demoOwner', email: 'owner@ultra.family', icon: 'Crown' },
  { key: 'login.demoAdult', email: 'adult@ultra.family', icon: 'UsersRound' },
  { key: 'login.demoChild', email: 'child@ultra.family', icon: 'Smile' },
  { key: 'login.demoAdmin', email: 'admin@ultra.family', icon: 'ServerCog' },
];

interface RegisterResult {
  user: { id: string };
  verificationToken?: string;
}

export default function LoginPage() {
  const router = useRouter();
  const {
    language,
    t,
    selectLanguage,
    signIn,
    authStatus,
    preferences,
    updatePreferences,
    online,
  } = useApp();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('owner@ultra.family');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [inviteToken, setInviteToken] = useState('WELCOME-UFOS-2026');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);
  const [demoMode, setDemoMode] = useState(false);

  useEffect(() => {
    if (authStatus === 'authenticated') router.replace('/dashboard');
  }, [authStatus, router]);

  useEffect(() => {
    void apiFetch<{ demoMode?: boolean }>('/health')
      .then((data) => setDemoMode(Boolean(data.demoMode)))
      .catch(() => setDemoMode(false));
  }, []);

  const showError = (error: unknown) => {
    if (error instanceof ApiError) {
      setMessage({
        text: `${errorMessage(language, error.status)} · ${error.code}`,
        tone: 'error',
      });
    } else {
      setMessage({ text: t('common.error'), tone: 'error' });
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!online) {
      setMessage({ text: t('error.offlineSave'), tone: 'error' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      if (mode === 'register') {
        const registered = await apiFetch<RegisterResult>('/auth/register', {
          method: 'POST',
          body: { inviteToken, email, displayName, password, language },
        });
        if (registered.verificationToken) {
          await apiFetch('/auth/verify-email', {
            method: 'POST',
            body: { token: registered.verificationToken },
          });
        }
        await signIn(email, password);
      } else {
        await signIn(email, password);
      }
      router.replace('/dashboard');
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-[var(--surface)] focus:p-3"
      >
        {t('common.skip')}
      </a>
      <header className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-6 md:px-8">
        <Link href="/" aria-label="Ultra Family OS">
          <Brand />
        </Link>
        <div className="flex items-center gap-2">
          <LanguageSelect
            value={language}
            onChange={(next) => void selectLanguage(next)}
            ariaLabel={t('common.language')}
          />
          <Link href="/" className="uf-button uf-button-ghost hidden sm:inline-flex">
            <Lucide.ArrowLeft className="h-4 w-4" />
            {t('common.backToSite')}
          </Link>
        </div>
      </header>

      <main
        id="main-content"
        className="mx-auto grid max-w-7xl gap-8 px-5 pb-14 pt-4 md:px-8 lg:grid-cols-[1.05fr_0.95fr] lg:items-center"
      >
        <section className="uf-hero relative overflow-hidden p-8 md:p-12">
          <span className="uf-hero-glow uf-decor" aria-hidden="true" />
          <div className="relative">
            <Badge tone="accent">{t('stage.current')}</Badge>
            <h1 className="mt-6 max-w-xl text-4xl font-black leading-tight tracking-tight md:text-5xl">
              {t('login.title')}
            </h1>
            <p className="mt-4 max-w-xl text-base leading-7 text-[var(--muted)]">
              {t('login.subtitle')}
            </p>
            <div className="mt-8 grid gap-3 sm:grid-cols-2">
              {[
                {
                  icon: 'ShieldCheck',
                  title: t('public.featurePrivacy'),
                  text: t('public.featurePrivacyText'),
                },
                {
                  icon: 'Globe2',
                  title: t('public.featureLanguages'),
                  text: t('public.featureLanguagesText'),
                },
              ].map((item) => (
                <div key={item.icon} className="uf-card-soft p-4">
                  <Lucide.ShieldCheck
                    className="h-5 w-5 text-[var(--accent-strong)]"
                    aria-hidden="true"
                  />
                  <h2 className="mt-3 text-sm font-bold">{item.title}</h2>
                  <p className="mt-1 text-xs leading-5 text-[var(--muted)]">{item.text}</p>
                </div>
              ))}
            </div>
            <p className="mt-8 flex items-start gap-2 text-xs leading-5 text-[var(--muted)]">
              <Lucide.LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {t('login.secureNote')}
            </p>
          </div>
        </section>

        <section className="mx-auto w-full max-w-lg">
          <Card className="p-6 md:p-8">
            <div className="mb-6 grid grid-cols-2 gap-2 rounded-full bg-[var(--surface-soft)] p-1">
              {(['login', 'register'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => {
                    setMode(tab);
                    setMessage(null);
                  }}
                  aria-pressed={mode === tab}
                  className={`rounded-full px-4 py-2 text-sm font-bold transition ${
                    mode === tab
                      ? 'bg-[var(--surface)] text-[var(--accent-strong)] shadow-sm'
                      : 'text-[var(--muted)]'
                  }`}
                >
                  {tab === 'login' ? t('login.signInTab') : t('login.registerTab')}
                </button>
              ))}
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {mode === 'register' ? (
                <>
                  <Field label={t('login.inviteToken')} htmlFor="invite">
                    <input
                      id="invite"
                      className="uf-input uf-mono"
                      value={inviteToken}
                      onChange={(event) => setInviteToken(event.target.value)}
                      required
                    />
                  </Field>
                  <Field label={t('common.displayName')} htmlFor="name">
                    <input
                      id="name"
                      className="uf-input"
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      required
                      minLength={2}
                    />
                  </Field>
                </>
              ) : null}
              <Field label={t('common.email')} htmlFor="email">
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  className="uf-input"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </Field>
              <Field label={t('common.password')} htmlFor="password">
                <input
                  id="password"
                  type="password"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  className="uf-input"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={mode === 'register' ? 12 : 1}
                />
              </Field>

              <div className="flex items-center justify-between gap-3 rounded-2xl bg-[var(--surface-soft)] p-3">
                <div>
                  <p className="text-sm font-bold">
                    {t('common.light')} / {t('common.dark')}
                  </p>
                  <p className="text-xs text-[var(--muted)]">{t('common.appearance')}</p>
                </div>
                <Toggle
                  checked={preferences.colorMode === 'dark'}
                  onChange={(value) =>
                    void updatePreferences({ colorMode: value ? 'dark' : 'light' })
                  }
                  label={t('common.theme')}
                />
              </div>

              {message ? (
                <div
                  role="alert"
                  className={`rounded-2xl border p-3 text-sm font-semibold ${message.tone === 'error' ? 'border-rose-300 text-rose-600' : 'border-emerald-300 text-emerald-600'}`}
                >
                  {message.text}
                </div>
              ) : null}

              <Button type="submit" variant="primary" loading={busy} className="w-full">
                {mode === 'login' ? (
                  <Lucide.LogIn className="h-4 w-4" />
                ) : (
                  <Lucide.UserPlus className="h-4 w-4" />
                )}
                {mode === 'login' ? t('common.signIn') : t('login.register')}
              </Button>
            </form>

            {demoMode ? (
              <div className="mt-7 border-t border-[var(--border)] pt-6">
                <div className="flex items-center gap-2">
                  <Lucide.FlaskConical
                    className="h-4 w-4 text-[var(--accent-strong)]"
                    aria-hidden="true"
                  />
                  <h2 className="text-sm font-extrabold">{t('login.demoTitle')}</h2>
                </div>
                <p className="mt-2 text-xs leading-5 text-[var(--muted)]">{t('login.demoText')}</p>
                <p className="uf-mono mt-2 inline-block rounded-lg bg-[var(--surface-soft)] px-2 py-1 text-xs">
                  {DEMO_PASSWORD}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {DEMO_ACCOUNTS.map((account) => (
                    <button
                      key={account.email}
                      type="button"
                      className="uf-badge hover:border-[var(--accent)]"
                      onClick={() => {
                        setMode('login');
                        setEmail(account.email);
                        setPassword(DEMO_PASSWORD);
                        setMessage(null);
                      }}
                    >
                      {t(account.key)}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </Card>
        </section>
      </main>
    </div>
  );
}
