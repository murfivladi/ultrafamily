'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import * as Lucide from 'lucide-react';
import type { DashboardSnapshot } from '@ufos/contracts';
import { useApp } from '@/components/app-provider';
import {
  Badge,
  Button,
  Card,
  DynamicIcon,
  EmptyState,
  ErrorPanel,
  IconButton,
  PageHeader,
  ProgressBar,
  StatCard,
} from '@/components/ui';
import { apiFetch } from '@/lib/api';
import { formatDate, formatDateTime, truncate } from '@/lib/format';

const WIDGET_IDS = [
  'feed',
  'overview',
  'important',
  'security',
  'activity',
  'sessions',
  'public',
] as const;
type WidgetId = (typeof WIDGET_IDS)[number];

function isWidgetId(value: string): value is WidgetId {
  return (WIDGET_IDS as readonly string[]).includes(value);
}

function WidgetFrame({
  id,
  title,
  icon,
  widgets,
  onChange,
  children,
}: {
  id: WidgetId;
  title: string;
  icon: string;
  widgets: WidgetId[];
  onChange: (widgets: WidgetId[]) => void;
  children: React.ReactNode;
}) {
  const index = widgets.indexOf(id);
  const move = (direction: -1 | 1) => {
    if (index < 0) return;
    const target = index + direction;
    if (target < 0 || target >= widgets.length) return;
    const next = [...widgets];
    [next[index], next[target]] = [next[target] ?? '', next[index] ?? ''];
    onChange(next);
  };
  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent-strong)]">
            <DynamicIcon name={icon} />
          </span>
          <h2 className="text-lg font-bold">{title}</h2>
        </div>
        <div className="flex items-center gap-1">
          <IconButton label="↑" onClick={() => move(-1)} disabled={index <= 0} className="h-8 w-8">
            <Lucide.ArrowUp className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            label="↓"
            onClick={() => move(1)}
            disabled={index >= widgets.length - 1}
            className="h-8 w-8"
          >
            <Lucide.ArrowDown className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            label="×"
            onClick={() => onChange(widgets.filter((item) => item !== id))}
            className="h-8 w-8"
          >
            <Lucide.X className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>
      {children}
    </Card>
  );
}

export default function DashboardPage() {
  const { language, t, snapshot, preferences, updatePreferences, notify } = useApp();
  const [data, setData] = useState<DashboardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [chain, setChain] = useState<{ valid: boolean; checked: number } | null>(null);
  const activeSpaceId = snapshot?.activeSpace?.id;

  const widgets = useMemo(() => preferences.widgets.filter(isWidgetId), [preferences.widgets]);

  const load = useCallback(async () => {
    if (!activeSpaceId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(false);
    try {
      const result = await apiFetch<DashboardSnapshot>('/dashboard');
      setData(result);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [activeSpaceId]);

  useEffect(() => {
    void load();
  }, [load, reload]);

  useEffect(() => {
    if (!snapshot?.platformRole) return;
    void apiFetch<{ valid: boolean; checked: number }>('/admin/audit/verify')
      .then(setChain)
      .catch(() => setChain(null));
  }, [snapshot?.platformRole]);

  const changeWidgets = (next: WidgetId[]) => {
    void updatePreferences({ widgets: next });
  };

  const feed = [
    {
      icon: 'ShieldCheck',
      title: t('dashboard.feed.audit'),
      reason: t('dashboard.feed.reasonAudit'),
      value: data?.recentAudit[0]?.action ?? 'auth.login.success',
      href: '/admin#audit',
    },
    {
      icon: 'Blocks',
      title: t('dashboard.feed.modules'),
      reason: t('dashboard.feed.reasonModules'),
      value: `${data?.enabledModules ?? 0} / ${data?.totalModules ?? 0}`,
      href: '/catalog',
    },
    {
      icon: 'Globe2',
      title: t('dashboard.feed.privacy'),
      reason: t('dashboard.feed.reasonPrivacy'),
      value: String(data?.publicPosts.length ?? 0),
      href: '/',
    },
  ];

  const widgetContent: Record<WidgetId, React.ReactNode> = {
    feed: (
      <div className="space-y-3">
        <p className="text-xs leading-5 text-[var(--muted)]">{t('stageB.smartFeedText')}</p>
        {(data?.feed ?? []).length === 0 ? (
          <p className="text-sm text-[var(--muted)]">{t('stageB.common.noData')}</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {(data?.feed ?? []).slice(0, 8).map((item) => (
              <Link
                key={item.id}
                href={item.href}
                className="uf-card-soft flex h-full flex-col p-4 hover:border-[var(--accent)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <Badge
                    tone={
                      item.severity === 'urgent'
                        ? 'danger'
                        : item.severity === 'important'
                          ? 'warning'
                          : 'accent'
                    }
                  >
                    {t(`stageB.common.${item.severity}`)}
                  </Badge>
                  <span className="text-[0.65rem] font-bold uppercase tracking-wider text-[var(--muted)]">
                    {item.source}
                  </span>
                </div>
                <h3 className="mt-3 text-sm font-bold">{item.title}</h3>
                <p className="mt-1 text-xs leading-5 text-[var(--muted)]">{item.detail}</p>
                <p className="mt-3 text-[0.68rem] font-extrabold uppercase tracking-wider text-[var(--accent-strong)]">
                  {t('stageB.common.reason')}: {item.reason}
                </p>
                {item.dueAt ? (
                  <p className="mt-2 text-[0.68rem] text-[var(--muted)]">
                    {formatDateTime(language, item.dueAt)}
                  </p>
                ) : null}
              </Link>
            ))}
          </div>
        )}
      </div>
    ),
    overview: (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon="UsersRound"
          label={t('common.memberCount')}
          value={data?.memberCount ?? '—'}
        />
        <StatCard
          icon="Blocks"
          label={t('common.enabledModules')}
          value={data?.enabledModules ?? '—'}
          tone="success"
        />
        <StatCard
          icon="Layers3"
          label={t('common.totalModules')}
          value={data?.totalModules ?? '—'}
          tone="warning"
        />
        <StatCard
          icon="ShieldCheck"
          label={t('common.sessions')}
          value={data?.recentSessions.length ?? '—'}
          tone="accent"
        />
      </div>
    ),
    important: (
      <div className="grid gap-3 md:grid-cols-3">
        {feed.map((item) => (
          <Link
            key={item.title}
            href={item.href}
            className="uf-card-soft flex h-full flex-col p-4 hover:border-[var(--accent)]"
          >
            <div className="flex items-center justify-between gap-3">
              <DynamicIcon name={item.icon} className="h-5 w-5 text-[var(--accent-strong)]" />
              <Badge tone="accent">{item.value}</Badge>
            </div>
            <h3 className="mt-4 text-sm font-bold">{item.title}</h3>
            <p className="mt-2 text-xs leading-5 text-[var(--muted)]">{item.reason}</p>
            <span className="mt-3 text-[0.68rem] font-extrabold uppercase tracking-wider text-[var(--accent-strong)]">
              {t('common.reason')}
            </span>
          </Link>
        ))}
      </div>
    ),
    security: (
      <div className="grid gap-4 md:grid-cols-3">
        {[
          {
            icon: 'ShieldCheck',
            title: t('dashboard.securityCard'),
            text: t('dashboard.securityText'),
          },
          { icon: 'ScrollText', title: t('dashboard.auditCard'), text: t('dashboard.auditText') },
          {
            icon: 'Fence',
            title: t('dashboard.isolationCard'),
            text: t('dashboard.isolationText'),
          },
        ].map((item) => (
          <div key={item.title} className="uf-card-soft p-4">
            <DynamicIcon name={item.icon} className="h-5 w-5 text-[var(--success)]" />
            <h3 className="mt-3 text-sm font-bold">{item.title}</h3>
            <p className="mt-1 text-xs leading-5 text-[var(--muted)]">{item.text}</p>
          </div>
        ))}
        {chain ? (
          <div className="md:col-span-3">
            <div className="flex items-center justify-between gap-3 text-xs font-semibold">
              <span>{chain.valid ? t('admin.chainValid') : t('admin.chainInvalid')}</span>
              <span className="text-[var(--muted)]">{chain.checked} events</span>
            </div>
            <div className="mt-2">
              <ProgressBar value={chain.valid ? 100 : 35} />
            </div>
          </div>
        ) : null}
      </div>
    ),
    activity: (
      <div id="activity" className="grid gap-5 lg:grid-cols-[1.3fr_0.7fr]">
        <div className="overflow-x-auto">
          <table className="uf-table">
            <thead>
              <tr>
                <th>{t('common.recentActivity')}</th>
                <th>{t('common.space')}</th>
                <th>{t('common.created')}</th>
              </tr>
            </thead>
            <tbody>
              {(data?.recentAudit ?? []).slice(0, 5).map((event) => (
                <tr key={event.id}>
                  <td>
                    <span className="uf-mono text-xs font-bold">{event.action}</span>
                  </td>
                  <td className="text-[var(--muted)]">{event.entity}</td>
                  <td className="text-[var(--muted)]">
                    {formatDateTime(language, event.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="space-y-3">
          {(data?.publicPosts ?? []).slice(0, 2).map((post) => (
            <Link
              key={post.id}
              href={`/public/${post.slug}`}
              className="uf-card-soft block p-4 hover:border-[var(--accent)]"
            >
              <Badge tone="success">{post.spaceName}</Badge>
              <h3 className="mt-3 text-sm font-bold">{post.title}</h3>
              <p className="mt-1 text-xs leading-5 text-[var(--muted)]">
                {truncate(post.excerpt, 100)}
              </p>
              <p className="mt-2 text-[0.68rem] text-[var(--muted)]">
                {formatDate(language, post.publishedAt)}
              </p>
            </Link>
          ))}
          {!data?.publicPosts.length ? (
            <p className="text-sm text-[var(--muted)]">{t('common.noData')}</p>
          ) : null}
        </div>
      </div>
    ),
    sessions: (
      <div className="grid gap-3 md:grid-cols-2">
        {(data?.recentSessions ?? []).map((session) => (
          <div
            key={session.id}
            className="uf-card-soft flex items-center justify-between gap-3 p-4"
          >
            <div className="flex items-center gap-3">
              <DynamicIcon name={session.current ? 'Laptop' : 'Smartphone'} />
              <div>
                <p className="text-sm font-bold">
                  {session.current ? t('dashboard.currentDevice') : t('common.sessions')}
                </p>
                <p className="text-xs text-[var(--muted)]">
                  {formatDateTime(language, session.lastSeenAt)}
                </p>
              </div>
            </div>
            {session.current ? <Badge tone="success">{t('sessions.current')}</Badge> : null}
          </div>
        ))}
      </div>
    ),
    public: (
      <div className="grid gap-3 md:grid-cols-2">
        {(data?.publicPosts ?? []).map((post) => (
          <article key={post.id} className="uf-card-soft p-4">
            <Badge tone="accent">{post.language.toUpperCase()}</Badge>
            <h3 className="mt-3 font-bold">{post.title}</h3>
            <p className="mt-2 text-sm leading-6 text-[var(--muted)]">{post.excerpt}</p>
            <Link
              href={`/public/${post.slug}`}
              className="uf-link mt-3 inline-flex items-center gap-1 text-xs"
            >
              {t('public.readMore')}
              <Lucide.ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </article>
        ))}
      </div>
    ),
  };

  const widgetMeta: Record<WidgetId, { title: string; icon: string }> = {
    feed: { title: t('stageB.smartFeed'), icon: 'Sparkles' },
    overview: { title: t('dashboard.overview'), icon: 'LayoutDashboard' },
    important: { title: t('dashboard.important'), icon: 'Sparkles' },
    security: { title: t('dashboard.securityCard'), icon: 'ShieldCheck' },
    activity: { title: t('common.recentActivity'), icon: 'Activity' },
    sessions: { title: t('dashboard.recentSessions'), icon: 'Laptop' },
    public: { title: t('common.publicPosts'), icon: 'Globe2' },
  };

  return (
    <>
      <PageHeader
        eyebrow={t('stageB.badge')}
        title={t('dashboard.hello', { name: snapshot?.user.displayName ?? '' })}
        description={t('dashboard.subtitle')}
        action={
          <div className="flex flex-wrap gap-2">
            <Link href="/settings" className="uf-button">
              <Lucide.SlidersHorizontal className="h-4 w-4" />
              {t('nav.sourceSettings')}
            </Link>
            <Button variant="primary" onClick={() => setReload((value) => value + 1)}>
              <Lucide.RefreshCw className="h-4 w-4" />
              {t('common.refresh')}
            </Button>
          </div>
        }
      />

      {!activeSpaceId ? (
        <EmptyState
          icon="UsersRound"
          title={t('common.noData')}
          description={t('admin.noAccess')}
          action={
            <Link href="/admin" className="uf-button uf-button-primary">
              {t('common.admin')}
            </Link>
          }
        />
      ) : error ? (
        <ErrorPanel message={t('common.error')} onRetry={() => setReload((value) => value + 1)} />
      ) : loading ? (
        <div className="space-y-4">
          <div className="uf-skeleton h-36" />
          <div className="uf-skeleton h-56" />
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-extrabold">{t('dashboard.widgets')}</h2>
              <p className="text-xs text-[var(--muted)]">{t('nav.widgetOrder')}</p>
            </div>
            {widgets.length !== WIDGET_IDS.length ? (
              <Button
                onClick={() => {
                  changeWidgets([...WIDGET_IDS]);
                  notify(t('common.saved'), 'success');
                }}
              >
                <Lucide.RotateCcw className="h-4 w-4" />
                {t('common.refresh')}
              </Button>
            ) : null}
          </div>
          {widgets.map((id) => (
            <WidgetFrame
              key={id}
              id={id}
              title={widgetMeta[id].title}
              icon={widgetMeta[id].icon}
              widgets={widgets}
              onChange={changeWidgets}
            >
              {widgetContent[id]}
            </WidgetFrame>
          ))}
        </div>
      )}
    </>
  );
}
