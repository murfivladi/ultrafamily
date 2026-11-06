'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { SearchModule, SearchResponse } from '@ufos/contracts';
import * as Lucide from 'lucide-react';
import { useApp } from '@/components/app-provider';
import { Badge, Button, Card, EmptyState, Field, PageHeader } from '@/components/ui';
import { apiFetch, apiPath } from '@/lib/api';
import { describeError } from '@/lib/uploads';

const MODULES: SearchModule[] = [
  'files',
  'photos',
  'documents',
  'journal',
  'encyclopedia',
  'messenger',
  'feed',
  'tasks',
  'calendar',
];

interface Member {
  userId: string;
  displayName: string;
}

export default function SearchPage() {
  const { t, notify, snapshot } = useApp();
  const spaceId = snapshot?.activeSpace?.id;
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'current' | 'all'>('current');
  const [modules, setModules] = useState<Set<SearchModule>>(new Set());
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [personId, setPersonId] = useState('');
  const [members, setMembers] = useState<Member[]>([]);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const [autoRun, setAutoRun] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const initial = new URLSearchParams(window.location.search).get('q');
    if (initial) {
      setQ(initial);
      setAutoRun(true);
    }
  }, []);

  useEffect(() => {
    if (!spaceId) return;
    void apiFetch<Member[]>(`/spaces/${encodeURIComponent(spaceId)}/members`)
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [spaceId]);

  const run = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!spaceId || q.trim().length < 2) return;
    setBusy(true);
    try {
      const result = await apiFetch<SearchResponse>(
        apiPath('/search', {
          q: q.trim(),
          spaceId: scope === 'all' ? 'all' : spaceId,
          modules: modules.size > 0 ? [...modules].join(',') : undefined,
          from: from || undefined,
          to: to || undefined,
          personId: personId || undefined,
        }),
      );
      setResponse(result);
    } catch (cause) {
      notify(describeError(t, cause), 'error');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (autoRun && spaceId && q.trim().length >= 2) {
      setAutoRun(false);
      void run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun, spaceId]);

  return (
    <>
      <PageHeader
        eyebrow={t('stageD.badge')}
        title={t('modules.search')}
        description={t('stageD.search.subtitle')}
      />
      <Card className="mb-5 p-4">
        <form onSubmit={run} className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field
              label={t('common.search')}
              htmlFor="search-query"
              className="min-w-[16rem] flex-1"
            >
              <input
                id="search-query"
                type="search"
                className="uf-input"
                value={q}
                minLength={2}
                maxLength={200}
                autoFocus
                onChange={(event) => setQ(event.target.value)}
              />
            </Field>
            <Button type="submit" variant="primary" loading={busy} disabled={q.trim().length < 2}>
              <Lucide.Search className="h-4 w-4" aria-hidden="true" />
              {t('common.search')}
            </Button>
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            <Field label={t('stageD.search.scope')} htmlFor="search-scope">
              <select
                id="search-scope"
                className="uf-select"
                value={scope}
                onChange={(event) => setScope(event.target.value as 'current' | 'all')}
              >
                <option value="current">{snapshot?.activeSpace?.name ?? t('common.space')}</option>
                <option value="all">{t('stageD.search.allSpaces')}</option>
              </select>
            </Field>
            <Field label={t('stageD.search.from')} htmlFor="search-from">
              <input
                id="search-from"
                type="date"
                className="uf-input"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </Field>
            <Field label={t('stageD.search.to')} htmlFor="search-to">
              <input
                id="search-to"
                type="date"
                className="uf-input"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>
            <Field label={t('stageD.search.person')} htmlFor="search-person">
              <select
                id="search-person"
                className="uf-select"
                value={personId}
                onChange={(e) => setPersonId(e.target.value)}
              >
                <option value="">{t('common.all')}</option>
                {members.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.displayName}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <fieldset className="uf-pill-row">
            <legend className="uf-label">{t('stageD.search.modules')}</legend>
            {MODULES.map((module) => (
              <label key={module} className="uf-badge cursor-pointer gap-1">
                <input
                  type="checkbox"
                  checked={modules.has(module)}
                  onChange={(event) =>
                    setModules((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(module);
                      else next.delete(module);
                      return next;
                    })
                  }
                />
                {t(`modules.${module === 'messenger' ? 'messenger' : module}`)}
              </label>
            ))}
          </fieldset>
        </form>
      </Card>

      {!response ? (
        <EmptyState
          icon="Search"
          title={t('stageD.search.start')}
          description={t('stageD.search.privacy')}
        />
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-[var(--muted)]" aria-live="polite">
            {t('stageD.search.count', { count: response.results.length, ms: response.tookMs })}
          </p>
          {response.skippedModules.length > 0 ? (
            <p className="text-xs text-[var(--muted)]">
              {t('stageD.search.skipped')}:{' '}
              {response.skippedModules.map((entry) => t(`modules.${entry.module}`)).join(', ')}
            </p>
          ) : null}
          {response.results.length === 0 ? (
            <EmptyState icon="SearchX" title={t('stageD.search.nothing')} />
          ) : (
            <ul className="space-y-2">
              {response.results.map((result) => (
                <li key={`${result.module}-${result.id}`}>
                  <Card className="p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="accent">{t(`modules.${result.module}`)}</Badge>
                      {scope === 'all' ? <Badge>{result.spaceName}</Badge> : null}
                      {result.matchedIn.map((field) => (
                        <Badge key={field}>{t(`stageD.search.in.${field}`)}</Badge>
                      ))}
                      {result.date ? (
                        <span className="ml-auto text-xs text-[var(--muted)]">
                          {new Date(result.date).toLocaleDateString()}
                        </span>
                      ) : null}
                    </div>
                    <Link href={result.href} className="mt-2 block font-bold hover:underline">
                      {result.title}
                    </Link>
                    {result.snippet ? (
                      <p className="mt-1 text-sm text-[var(--muted)]">{result.snippet}</p>
                    ) : null}
                    {result.personName ? (
                      <p className="mt-1 text-xs text-[var(--muted)]">{result.personName}</p>
                    ) : null}
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
