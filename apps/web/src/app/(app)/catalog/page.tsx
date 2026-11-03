'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import * as Lucide from 'lucide-react';
import { MODULES, type ModuleDefinition, type ModuleToggle } from '@ufos/contracts';
import { useApp } from '@/components/app-provider';
import {
  Badge,
  Button,
  Card,
  DynamicIcon,
  EmptyState,
  ErrorPanel,
  PageHeader,
  Toggle,
} from '@/components/ui';
import { apiFetch } from '@/lib/api';

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

const STAGES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;

export default function CatalogPage() {
  const { t, snapshot, preferences, updatePreferences, notify } = useApp();
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('all');
  const [stage, setStage] = useState('all');
  const [toggles, setToggles] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const activeSpaceId = snapshot?.activeSpace?.id;
  const canManage = Boolean(snapshot?.permissions.includes('spaces:manage_access'));

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q');
    const requestedGroup = params.get('group');
    const module = params.get('module');
    if (q) setQuery(q);
    if (requestedGroup && GROUPS.includes(requestedGroup as ModuleDefinition['group'])) {
      setGroup(requestedGroup);
    }
    if (module) setQuery(module);
  }, []);

  useEffect(() => {
    if (!activeSpaceId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(false);
    void apiFetch<{ toggles: ModuleToggle[] }>('/modules')
      .then((result) => {
        if (!cancelled) {
          setToggles(
            Object.fromEntries(result.toggles.map((toggle) => [toggle.moduleId, toggle.enabled])),
          );
        }
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
  }, [activeSpaceId, reload]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return MODULES.filter((module) => {
      const label = t(`modules.${module.id}`).toLowerCase();
      if (needle && !label.includes(needle) && !module.id.includes(needle)) return false;
      if (group !== 'all' && module.group !== group) return false;
      if (stage !== 'all' && module.stage !== stage) return false;
      return true;
    });
  }, [group, query, stage, t]);

  const toggleModule = async (moduleId: string, enabled: boolean) => {
    setBusyId(moduleId);
    try {
      const result = await apiFetch<ModuleToggle>(`/modules/${moduleId}`, {
        method: 'PATCH',
        body: { enabled },
      });
      setToggles((current) => ({ ...current, [moduleId]: result.enabled }));
      notify(t('common.saved'), 'success');
    } catch {
      notify(t('common.error'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const toggleFavorite = (moduleId: string) => {
    const exists = preferences.favorites.includes(moduleId);
    void updatePreferences({
      favorites: exists
        ? preferences.favorites.filter((id) => id !== moduleId)
        : [...preferences.favorites, moduleId].slice(-12),
    });
  };

  return (
    <>
      <PageHeader
        eyebrow={t('stage.label', { stage: 'A–H' })}
        title={t('catalog.title')}
        description={t('catalog.subtitle')}
        action={
          <Link href="/settings" className="uf-button">
            <Lucide.SlidersHorizontal className="h-4 w-4" />
            {t('common.settings')}
          </Link>
        }
      />

      <Card className="mb-6 grid gap-3 p-4 md:grid-cols-[minmax(0,1.6fr)_repeat(2,minmax(0,0.7fr))_auto] md:items-end">
        <div>
          <label className="uf-label" htmlFor="catalog-search">
            {t('catalog.searchPlaceholder')}
          </label>
          <div className="relative">
            <Lucide.Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted)]" />
            <input
              id="catalog-search"
              className="uf-input pl-9"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('catalog.searchPlaceholder')}
            />
          </div>
        </div>
        <div>
          <label className="uf-label" htmlFor="catalog-group">
            {t('catalog.filterGroup')}
          </label>
          <select
            id="catalog-group"
            className="uf-select"
            value={group}
            onChange={(event) => setGroup(event.target.value)}
          >
            <option value="all">{t('common.all')}</option>
            {GROUPS.map((item) => (
              <option key={item} value={item}>
                {t(`nav.group.${item}`)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="uf-label" htmlFor="catalog-stage">
            {t('catalog.filterStage')}
          </label>
          <select
            id="catalog-stage"
            className="uf-select"
            value={stage}
            onChange={(event) => setStage(event.target.value)}
          >
            <option value="all">{t('common.all')}</option>
            {STAGES.map((item) => (
              <option key={item} value={item}>
                {t('stage.label', { stage: item })}
              </option>
            ))}
          </select>
        </div>
        <div className="text-sm font-bold text-[var(--muted)]">
          {t('catalog.resultCount', { count: filtered.length })}
        </div>
      </Card>

      {!activeSpaceId ? (
        <EmptyState
          icon="Blocks"
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
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="uf-skeleton h-48" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((module) => {
            const foundation = module.status === 'foundation';
            const enabled = toggles[module.id] ?? false;
            const favorite = preferences.favorites.includes(module.id);
            return (
              <Card key={module.id} className="flex h-full flex-col p-5">
                <div className="flex items-start justify-between gap-3">
                  <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent-strong)]">
                    <DynamicIcon name={module.icon} />
                  </span>
                  <div className="flex flex-wrap justify-end gap-1">
                    <Badge tone={foundation ? 'success' : 'warning'}>
                      {foundation ? t('catalog.foundationNote') : t('catalog.plannedNote')}
                    </Badge>
                    <Badge tone="accent">{t('stage.label', { stage: module.stage })}</Badge>
                  </div>
                </div>
                <h2 className="mt-4 text-lg font-bold">{t(`modules.${module.id}`)}</h2>
                <p className="uf-mono mt-1 text-xs text-[var(--muted)]">{module.id}</p>
                <p className="mt-2 text-xs leading-5 text-[var(--muted)]">
                  {t(`nav.group.${module.group}`)}
                </p>
                <div className="mt-3 flex flex-wrap gap-1">
                  {module.sensitive ? (
                    <Badge tone="danger">
                      <Lucide.LockKeyhole className="h-3 w-3" />
                      {t('catalog.sensitive')}
                    </Badge>
                  ) : null}
                  {module.childRestricted ? (
                    <Badge tone="warning">
                      <Lucide.Baby className="h-3 w-3" />
                      {t('catalog.childRestricted')}
                    </Badge>
                  ) : null}
                </div>
                <div className="mt-auto flex items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
                  <button
                    type="button"
                    onClick={() => toggleFavorite(module.id)}
                    aria-label={favorite ? t('catalog.unfavorite') : t('catalog.favorite')}
                    className="inline-flex items-center gap-1 text-xs font-bold text-[var(--muted)] hover:text-[var(--accent-strong)]"
                  >
                    <Lucide.Star
                      className={`h-4 w-4 ${favorite ? 'fill-amber-400 text-amber-500' : ''}`}
                    />
                    {t('common.favorites')}
                  </button>
                  {foundation ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-[var(--muted)]">
                        {enabled ? t('common.enabled') : t('common.disabled')}
                      </span>
                      <Toggle
                        checked={enabled}
                        disabled={!canManage || busyId === module.id}
                        onChange={(value) => void toggleModule(module.id, value)}
                        label={t('catalog.toggle')}
                      />
                    </div>
                  ) : (
                    <Badge>{t('common.readOnly')}</Badge>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {!loading && filtered.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon="SearchX"
            title={t('common.noData')}
            action={
              <Button
                onClick={() => {
                  setQuery('');
                  setGroup('all');
                  setStage('all');
                }}
              >
                {t('common.refresh')}
              </Button>
            }
          />
        </div>
      ) : null}
    </>
  );
}
