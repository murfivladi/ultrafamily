'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import * as Lucide from 'lucide-react';
import type { PublicPost } from '@ufos/contracts';
import { useApp } from '@/components/app-provider';
import { Badge, Brand, Button, Card, DynamicIcon, LanguageSelect } from '@/components/ui';
import { apiFetch, apiPath } from '@/lib/api';
import { formatDate } from '@/lib/format';

export default function PublicHomePage() {
  const { language, t, selectLanguage, online } = useApp();
  const [posts, setPosts] = useState<PublicPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [demoMode, setDemoMode] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    void apiFetch<PublicPost[]>(apiPath('/public/posts', { language }))
      .then((data) => {
        if (!cancelled) setPosts(data);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [language]);

  useEffect(() => {
    void apiFetch<{ demoMode?: boolean }>('/health')
      .then((data) => setDemoMode(Boolean(data.demoMode)))
      .catch(() => setDemoMode(false));
  }, []);

  const features = [
    {
      icon: 'ShieldCheck',
      title: t('public.featurePrivacy'),
      text: t('public.featurePrivacyText'),
      tone: 'success' as const,
    },
    {
      icon: 'Blocks',
      title: t('public.featureModules'),
      text: t('public.featureModulesText'),
      tone: 'accent' as const,
    },
    {
      icon: 'Languages',
      title: t('public.featureLanguages'),
      text: t('public.featureLanguagesText'),
      tone: 'warning' as const,
    },
  ];

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-6 md:px-8">
        <Link href="/" aria-label="Ultra Family OS">
          <Brand />
        </Link>
        <nav className="flex items-center gap-2" aria-label={t('common.menu')}>
          <LanguageSelect
            value={language}
            onChange={(next) => void selectLanguage(next)}
            ariaLabel={t('common.language')}
          />
          <Link href="/login" className="uf-button uf-button-primary hidden sm:inline-flex">
            <Lucide.LogIn className="h-4 w-4" aria-hidden="true" />
            {t('public.enter')}
          </Link>
        </nav>
      </header>

      {!online ? (
        <div className="mx-auto mb-4 max-w-7xl px-5 md:px-8">
          <div className="uf-card border-amber-300 p-3 text-sm font-semibold text-amber-700">
            {t('common.offline')}
          </div>
        </div>
      ) : null}

      <main id="main-content">
        <section className="mx-auto max-w-7xl px-5 pb-10 pt-8 md:px-8 md:pb-16 md:pt-14">
          <div className="uf-hero px-6 py-12 md:px-12 md:py-16">
            <span className="uf-hero-glow uf-decor" aria-hidden="true" />
            <div className="relative grid gap-10 lg:grid-cols-[1.35fr_0.65fr] lg:items-center">
              <div>
                <Badge tone="accent">
                  <Lucide.Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('public.eyebrow')}
                </Badge>
                <h1 className="mt-6 max-w-4xl text-4xl font-black leading-[1.05] tracking-tight md:text-6xl">
                  {t('public.heroTitle')}
                </h1>
                <p className="mt-5 max-w-2xl text-base leading-7 text-[var(--muted)] md:text-lg">
                  {t('public.heroText')}
                </p>
                <div className="mt-8 flex flex-wrap gap-3">
                  <Link href="/login" className="uf-button uf-button-primary">
                    <Lucide.LogIn className="h-4 w-4" aria-hidden="true" />
                    {t('public.enter')}
                  </Link>
                  <a href="#privacy" className="uf-button">
                    <Lucide.ShieldCheck className="h-4 w-4" aria-hidden="true" />
                    {t('public.learnMore')}
                  </a>
                </div>
                {demoMode ? (
                  <p className="mt-5 inline-flex items-center gap-2 text-xs font-semibold text-[var(--muted)]">
                    <Lucide.FlaskConical className="h-4 w-4" aria-hidden="true" />
                    {t('stage.current')}
                  </p>
                ) : null}
              </div>
              <Card className="relative overflow-hidden p-6">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-extrabold uppercase tracking-widest text-[var(--muted)]">
                    Privacy model
                  </span>
                  <Badge tone="success">
                    <Lucide.LockKeyhole className="h-3.5 w-3.5" /> Private
                  </Badge>
                </div>
                <div className="mt-7 space-y-3">
                  {[
                    {
                      label: language === 'ru' ? 'Личные данные' : 'Dati personali',
                      value: 100,
                      color: 'var(--accent)',
                    },
                    {
                      label: language === 'ru' ? 'Семейные записи' : 'Note di famiglia',
                      value: 100,
                      color: 'var(--success)',
                    },
                    {
                      label: language === 'ru' ? 'Явные публикации' : 'Pubblicazioni esplicite',
                      value: posts.length ? 35 : 8,
                      color: 'var(--warning)',
                    },
                  ].map((item) => (
                    <div key={item.label}>
                      <div className="mb-1 flex items-center justify-between text-xs font-semibold">
                        <span>{item.label}</span>
                        <span className="text-[var(--muted)]">{item.value}%</span>
                      </div>
                      <div className="h-2 rounded-full bg-[var(--surface-soft)]">
                        <div
                          className="h-2 rounded-full"
                          style={{ width: `${item.value}%`, background: item.color }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <p className="mt-6 text-xs leading-5 text-[var(--muted)]">
                  {t('common.privacyNote')}
                </p>
              </Card>
            </div>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {features.map((feature) => (
              <Card key={feature.icon} className="p-6">
                <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent-strong)]">
                  <DynamicIcon name={feature.icon} className="h-6 w-6" />
                </span>
                <h2 className="mt-5 text-lg font-bold">{feature.title}</h2>
                <p className="mt-2 text-sm leading-6 text-[var(--muted)]">{feature.text}</p>
                <Badge tone={feature.tone} className="mt-4">
                  {t('stage.current')}
                </Badge>
              </Card>
            ))}
          </div>
        </section>

        <section id="privacy" className="mx-auto max-w-7xl px-5 pb-16 md:px-8">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs font-extrabold uppercase tracking-[0.18em] text-[var(--accent-strong)]">
                Public feed
              </p>
              <h2 className="mt-2 text-2xl font-black tracking-tight md:text-3xl">
                {t('public.postsTitle')}
              </h2>
            </div>
            <Badge tone="accent">
              <Lucide.Eye className="h-3.5 w-3.5" />
              {t('common.readOnly')}
            </Badge>
          </div>

          {loading ? (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="uf-skeleton h-48" />
              <div className="uf-skeleton h-48" />
            </div>
          ) : error ? (
            <Card className="p-8 text-center text-sm font-semibold text-[var(--muted)]">
              {t('common.error')}
            </Card>
          ) : posts.length === 0 ? (
            <Card className="p-8 text-center text-sm font-semibold text-[var(--muted)]">
              {t('public.postsEmpty')}
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {posts.map((post) => (
                <article key={post.id} className="uf-card flex h-full flex-col p-6">
                  <div className="flex items-center justify-between gap-3">
                    <Badge tone="success">{post.spaceName}</Badge>
                    <span className="text-xs text-[var(--muted)]">
                      {t('public.published', { date: formatDate(language, post.publishedAt) })}
                    </span>
                  </div>
                  <h3 className="mt-5 text-xl font-bold tracking-tight">{post.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-[var(--muted)]">{post.excerpt}</p>
                  <div className="mt-auto pt-6">
                    <Link
                      href={`/public/${post.slug}`}
                      className="uf-link inline-flex items-center gap-2 text-sm"
                    >
                      {t('public.readMore')}
                      <Lucide.ArrowUpRight className="h-4 w-4" />
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>

      <footer className="border-t border-[var(--border)] py-8">
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-4 px-5 text-sm text-[var(--muted)] md:flex-row md:items-center md:px-8">
          <p>{t('public.footer')}</p>
          <div className="flex items-center gap-3">
            <Lucide.LockKeyhole className="h-4 w-4" aria-hidden="true" />
            <span>{t('common.private')}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
