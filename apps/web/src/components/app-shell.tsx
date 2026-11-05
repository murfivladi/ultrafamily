'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import * as Lucide from 'lucide-react';
import { MODULES, type ModuleDefinition } from '@ufos/contracts';
import { useApp } from './app-provider';
import { Avatar, Badge, Brand, Card, DynamicIcon, IconButton, LanguageSelect } from './ui';
import { apiFetch } from '@/lib/api';

interface NavItem {
  id: string;
  href: string;
  icon: string;
  label: string;
  module?: string;
}

const GROUPS: Array<ModuleDefinition['group']> = [
  'core',
  'organize',
  'communicate',
  'memory',
  'everyday',
  'private',
  'intelligence',
  'system',
];

function LoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <Card className="flex items-center gap-3 p-6">
        <Lucide.LoaderCircle
          className="h-5 w-5 animate-spin text-[var(--accent)]"
          aria-hidden="true"
        />
        <span className="font-bold">Ultra Family OS</span>
      </Card>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const {
    language,
    t,
    selectLanguage,
    preferences,
    updatePreferences,
    snapshot,
    authStatus,
    refresh,
    signOut,
    notify,
    online,
  } = useApp();
  const router = useRouter();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (authStatus === 'anonymous') router.replace('/login');
  }, [authStatus, router]);

  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  const navItems = useMemo<NavItem[]>(() => {
    const coreItems: NavItem[] = [
      {
        id: 'dashboard',
        href: '/dashboard',
        icon: 'LayoutDashboard',
        label: t('common.dashboard'),
      },
      { id: 'catalog', href: '/catalog', icon: 'Grid2X2', label: t('common.catalog') },
      { id: 'spaces', href: '/spaces', icon: 'UsersRound', label: t('common.spaces') },
      { id: 'settings', href: '/settings', icon: 'Settings2', label: t('common.settings') },
      { id: 'sessions', href: '/sessions', icon: 'ShieldCheck', label: t('common.sessions') },
    ];
    const stageBItems: NavItem[] = [
      {
        id: 'calendar',
        href: '/calendar',
        icon: 'CalendarDays',
        label: t('modules.calendar'),
        module: 'calendar',
      },
      { id: 'tasks', href: '/tasks', icon: 'ListTodo', label: t('modules.tasks'), module: 'tasks' },
      {
        id: 'notifications',
        href: '/notifications',
        icon: 'BellRing',
        label: t('modules.notifications'),
        module: 'notifications',
      },
      {
        id: 'shopping',
        href: '/shopping',
        icon: 'ShoppingBasket',
        label: t('modules.shopping'),
        module: 'shopping',
      },
      {
        id: 'publishing',
        href: '/publishing',
        icon: 'Globe2',
        label: t('modules.public_site'),
        module: 'public_site',
      },
    ];
    const stageCItems: NavItem[] = [
      {
        id: 'messenger',
        href: '/messages',
        icon: 'MessagesSquare',
        label: t('modules.messenger'),
        module: 'messenger',
      },
      { id: 'feed', href: '/feed', icon: 'Newspaper', label: t('modules.feed'), module: 'feed' },
      {
        id: 'decisions',
        href: '/decisions',
        icon: 'Vote',
        label: t('modules.decisions'),
        module: 'decisions',
      },
      {
        id: 'documents',
        href: '/documents',
        icon: 'FileText',
        label: t('modules.documents'),
        module: 'documents',
      },
      { id: 'calls', href: '/calls', icon: 'Video', label: t('modules.calls'), module: 'calls' },
    ];
    const permissions = new Set(snapshot?.permissions ?? []);
    const allowedStageB = [...stageBItems, ...stageCItems].filter((item) =>
      permissions.has(`${item.module}:read`),
    );
    const simplified = preferences.simplifiedUi || snapshot?.user.isChild;
    const visibleStageB = simplified
      ? allowedStageB.filter((item) =>
          ['calendar', 'tasks', 'shopping', 'messenger', 'feed'].includes(item.id),
        )
      : allowedStageB;
    const items = [...coreItems, ...visibleStageB];
    if (snapshot?.platformRole && !simplified) {
      items.push({ id: 'admin', href: '/admin', icon: 'ServerCog', label: t('common.admin') });
    }
    return simplified
      ? items.filter((item) =>
          [
            'dashboard',
            'catalog',
            'spaces',
            'settings',
            'calendar',
            'tasks',
            'shopping',
            'messenger',
            'feed',
          ].includes(item.id),
        )
      : items;
  }, [
    preferences.simplifiedUi,
    snapshot?.permissions,
    snapshot?.platformRole,
    snapshot?.user.isChild,
    t,
  ]);

  if (authStatus === 'loading') return <LoadingScreen />;
  if (!snapshot) return null;

  const activeSpace = snapshot.activeSpace;
  const activeMembership = snapshot.spaces.find((space) => space.id === activeSpace?.id);
  const favorites = preferences.favorites
    .map((id) => MODULES.find((module) => module.id === id))
    .filter((module): module is ModuleDefinition => Boolean(module));
  const quickActions = [
    { id: 'new-task', module: 'tasks', icon: 'ListPlus', href: '/tasks#new-task' },
    { id: 'new-event', module: 'calendar', icon: 'CalendarPlus', href: '/calendar#new-event' },
    { id: 'invite', module: 'spaces', icon: 'UserPlus', href: '/spaces#invite' },
  ];

  const handleSpaceSwitch = async (spaceId: string) => {
    if (!spaceId || spaceId === activeSpace?.id) return;
    setSwitching(true);
    try {
      await apiFetch(`/spaces/${encodeURIComponent(spaceId)}/switch`, {
        method: 'POST',
        body: {},
      });
      await refresh();
      notify(t('common.saved'), 'success');
    } catch {
      notify(t('common.error'), 'error');
    } finally {
      setSwitching(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut();
      router.push('/');
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  return (
    <div className="uf-shell">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-full focus:bg-[var(--surface)] focus:p-3"
      >
        {t('common.skip')}
      </a>

      {sidebarOpen ? (
        <button
          type="button"
          aria-label={t('common.close')}
          className="fixed inset-0 z-30 bg-black/35 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}

      <aside
        className="uf-sidebar uf-scrollbar"
        data-open={sidebarOpen}
        aria-label={t('common.menu')}
      >
        <div className="mb-6 flex items-center justify-between">
          <Link href="/dashboard" aria-label="Ultra Family OS">
            <Brand />
          </Link>
          <IconButton
            label={t('common.close')}
            className="lg:hidden"
            onClick={() => setSidebarOpen(false)}
          >
            <Lucide.X className="h-4 w-4" />
          </IconButton>
        </div>

        <div className="mb-5 rounded-2xl border border-[var(--border)] bg-[var(--surface-soft)] p-3">
          <p className="mb-1 text-[0.68rem] font-extrabold uppercase tracking-widest text-[var(--muted)]">
            {t('common.space')}
          </p>
          <select
            aria-label={t('spaces.active')}
            className="uf-select py-2 text-sm font-bold"
            value={activeSpace?.id ?? ''}
            disabled={switching || snapshot.spaces.length === 0}
            onChange={(event) => void handleSpaceSwitch(event.target.value)}
          >
            {snapshot.spaces.length === 0 ? <option value="">{t('common.noData')}</option> : null}
            {snapshot.spaces.map((space) => (
              <option key={space.id} value={space.id}>
                {space.name} · {t(`spaceKind.${space.kind}`)}
              </option>
            ))}
          </select>
          {activeMembership ? (
            <div className="mt-2 flex items-center justify-between gap-2">
              <Badge tone="accent">{t(`roles.${activeMembership.role}`)}</Badge>
              <Badge tone="success">
                <Lucide.LockKeyhole className="h-3 w-3" />
                {t('common.private')}
              </Badge>
            </div>
          ) : null}
        </div>

        <form
          className="relative mb-5"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            router.push(`/catalog?q=${encodeURIComponent(search)}`);
          }}
        >
          <Lucide.Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted)]" />
          <input
            className="uf-input pl-9"
            aria-label={t('nav.search')}
            placeholder={t('nav.search')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </form>

        <nav aria-label={t('common.menu')} className="space-y-1">
          {navItems.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.id}
                href={item.href}
                className="uf-nav-link"
                data-active={active}
                aria-current={active ? 'page' : undefined}
              >
                <DynamicIcon name={item.icon} className="h-4.5 w-4.5" />
                <span>{item.label}</span>
                {active ? <Lucide.ChevronRight className="ml-auto h-4 w-4" /> : null}
              </Link>
            );
          })}
        </nav>

        <div className="mt-7">
          <p className="mb-2 text-[0.68rem] font-extrabold uppercase tracking-widest text-[var(--muted)]">
            {t('common.favorites')}
          </p>
          <div className="flex flex-wrap gap-2">
            {favorites.length ? (
              favorites.map((module) => (
                <Link
                  key={module.id}
                  href={`/catalog?module=${module.id}`}
                  className="uf-badge hover:border-[var(--accent)]"
                >
                  <DynamicIcon name={module.icon} className="h-3.5 w-3.5" />
                  {t(`modules.${module.id}`)}
                </Link>
              ))
            ) : (
              <span className="text-xs text-[var(--muted)]">{t('common.noData')}</span>
            )}
          </div>
        </div>

        <div className="mt-7 uf-advanced">
          <p className="mb-2 text-[0.68rem] font-extrabold uppercase tracking-widest text-[var(--muted)]">
            {t('common.quickActions')}
          </p>
          <div className="grid grid-cols-3 gap-2">
            {quickActions.map((action) => (
              <Link
                key={action.id}
                href={action.href}
                className="uf-card-soft flex flex-col items-center gap-1 p-2 text-center text-[0.68rem] font-bold hover:border-[var(--accent)]"
              >
                <DynamicIcon name={action.icon} className="h-4 w-4 text-[var(--accent-strong)]" />
                <span className="truncate">{t(`modules.${action.module}`)}</span>
              </Link>
            ))}
          </div>
        </div>

        <div className="mt-7 uf-advanced">
          <p className="mb-2 text-[0.68rem] font-extrabold uppercase tracking-widest text-[var(--muted)]">
            {t('common.catalog')}
          </p>
          <div className="space-y-1">
            {GROUPS.map((group) => (
              <Link
                key={group}
                href={`/catalog?group=${group}`}
                className="uf-nav-link py-2 text-xs"
              >
                <span className="h-2 w-2 rounded-full bg-[var(--accent)]" />
                {t(`nav.group.${group}`)}
                <span className="ml-auto text-[var(--muted)]">
                  {MODULES.filter((module) => module.group === group).length}
                </span>
              </Link>
            ))}
          </div>
        </div>

        <div className="mt-8 border-t border-[var(--border)] pt-5 text-xs leading-5 text-[var(--muted)]">
          <p className="font-semibold">{t('stageB.badge')}</p>
          <p className="mt-1">{t('common.private')}</p>
        </div>
      </aside>

      <div className="uf-main">
        {!online ? (
          <div
            role="status"
            className="border-b border-amber-300 bg-amber-50 px-5 py-2 text-center text-sm font-bold text-amber-800"
          >
            <Lucide.WifiOff className="mr-2 inline h-4 w-4" />
            {t('common.offline')}
          </div>
        ) : null}

        <header className="uf-topbar">
          <IconButton
            label={t('common.menu')}
            className="lg:hidden"
            onClick={() => setSidebarOpen(true)}
          >
            <Lucide.Menu className="h-5 w-5" />
          </IconButton>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-extrabold">
              {activeSpace?.name ?? t('common.noData')}
            </p>
            <p className="truncate text-xs text-[var(--muted)]">
              {activeMembership ? t(`roles.${activeMembership.role}`) : snapshot.user.displayName}
            </p>
          </div>

          <div className="hidden items-center gap-2 md:flex">
            <Badge tone="accent">
              <Lucide.Layers3 className="h-3.5 w-3.5" />
              {t('stageB.badge')}
            </Badge>
          </div>

          <LanguageSelect
            value={language}
            onChange={(next) => void selectLanguage(next)}
            ariaLabel={t('common.language')}
            className="hidden sm:block"
          />
          <IconButton
            label={preferences.colorMode === 'dark' ? t('common.light') : t('common.dark')}
            onClick={() =>
              void updatePreferences({
                colorMode: preferences.colorMode === 'dark' ? 'light' : 'dark',
              })
            }
          >
            {preferences.colorMode === 'dark' ? (
              <Lucide.Sun className="h-5 w-5" />
            ) : (
              <Lucide.Moon className="h-5 w-5" />
            )}
          </IconButton>
          <Link href="/dashboard#activity" className="hidden sm:block">
            <IconButton label={t('common.recentActivity')}>
              <Lucide.Bell className="h-5 w-5" />
            </IconButton>
          </Link>

          <details className="relative">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] py-1 pl-1 pr-3">
              <Avatar
                name={snapshot.user.displayName}
                color={snapshot.user.avatarColor}
                size="sm"
              />
              <span className="hidden max-w-[8rem] truncate text-sm font-bold sm:block">
                {snapshot.user.displayName}
              </span>
              <Lucide.ChevronDown className="h-4 w-4 text-[var(--muted)]" />
            </summary>
            <div className="absolute right-0 top-[calc(100%+0.6rem)] z-40 w-56 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-2 shadow-xl">
              <div className="border-b border-[var(--border)] px-3 py-2">
                <p className="truncate text-sm font-bold">{snapshot.user.displayName}</p>
                <p className="truncate text-xs text-[var(--muted)]">{snapshot.user.email}</p>
              </div>
              <Link href="/settings" className="uf-nav-link py-2 text-sm">
                <Lucide.Settings2 className="h-4 w-4" />
                {t('common.settings')}
              </Link>
              <Link href="/sessions" className="uf-nav-link py-2 text-sm">
                <Lucide.ShieldCheck className="h-4 w-4" />
                {t('common.security')}
              </Link>
              <Link href="/" className="uf-nav-link py-2 text-sm">
                <Lucide.Globe2 className="h-4 w-4" />
                {t('common.backToSite')}
              </Link>
              <button
                type="button"
                onClick={() => void handleSignOut()}
                className="uf-nav-link w-full py-2 text-left text-sm text-rose-500"
              >
                <Lucide.LogOut className="h-4 w-4" />
                {t('common.signOut')}
              </button>
            </div>
          </details>
        </header>

        <main id="main-content" className="uf-content">
          {children}
        </main>
      </div>
    </div>
  );
}
