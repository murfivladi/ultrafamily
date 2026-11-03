'use client';

import { useCallback, useEffect, useState } from 'react';
import * as Lucide from 'lucide-react';
import type { Session } from '@ufos/contracts';
import { useApp } from '@/components/app-provider';
import { Badge, Button, Card, EmptyState, ErrorPanel, PageHeader } from '@/components/ui';
import { apiFetch } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

export default function SessionsPage() {
  const { language, t, notify, signOut } = useApp();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      setSessions(await apiFetch<Session[]>('/auth/sessions'));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (id: string) => {
    setBusy(id);
    try {
      await apiFetch(`/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      notify(t('common.saved'), 'success');
      await load();
    } catch {
      notify(t('common.error'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const revokeAll = async () => {
    setBusy('all');
    try {
      await apiFetch('/auth/sessions/revoke-all', { method: 'POST', body: {} });
      notify(t('common.saved'), 'success');
      await load();
    } catch {
      notify(t('common.error'), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Security · Sessions"
        title={t('sessions.title')}
        description={t('sessions.subtitle')}
        action={
          <Button variant="danger" onClick={() => void revokeAll()} disabled={busy === 'all'}>
            <Lucide.LogOut className="h-4 w-4" />
            {t('sessions.revokeAll')}
          </Button>
        }
      />

      {error ? (
        <ErrorPanel message={t('common.error')} onRetry={() => void load()} />
      ) : loading ? (
        <div className="space-y-3">
          <div className="uf-skeleton h-24" />
          <div className="uf-skeleton h-24" />
        </div>
      ) : sessions.length === 0 ? (
        <EmptyState icon="ShieldCheck" title={t('common.noData')} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {sessions.map((session) => (
            <Card key={session.id} className="p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent-strong)]">
                    <Lucide.Laptop className="h-5 w-5" />
                  </span>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-bold">
                        {session.current ? t('sessions.current') : t('common.sessions')}
                      </h2>
                      {session.current ? (
                        <Badge tone="success">
                          <Lucide.Check className="h-3 w-3" />
                          Active
                        </Badge>
                      ) : null}
                      {session.trusted ? (
                        <Badge tone="accent">{t('sessions.trusted')}</Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 max-w-md truncate text-xs text-[var(--muted)]">
                      {session.userAgent || 'Unknown device'}
                    </p>
                  </div>
                </div>
                {!session.current ? (
                  <Button
                    variant="danger"
                    className="px-3 py-1 text-xs"
                    disabled={busy === session.id}
                    onClick={() => void revoke(session.id)}
                  >
                    {t('sessions.revoke')}
                  </Button>
                ) : null}
              </div>
              <div className="mt-5 grid gap-2 border-t border-[var(--border)] pt-4 text-xs text-[var(--muted)] sm:grid-cols-2">
                <p>
                  {t('sessions.lastSeen', { date: formatDateTime(language, session.lastSeenAt) })}
                </p>
                <p>
                  {t('sessions.expires', { date: formatDateTime(language, session.expiresAt) })}
                </p>
                <p className="uf-mono">ID: {session.id.slice(0, 16)}…</p>
                <p className="uf-mono">IP: {session.ipPrefix ?? '—'}</p>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Card className="mt-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-sm font-semibold text-[var(--muted)]">
            <Lucide.LockKeyhole className="h-4 w-4" />
            {t('login.secureNote')}
          </p>
          <Button onClick={() => void signOut()}>
            <Lucide.LogOut className="h-4 w-4" />
            {t('common.signOut')}
          </Button>
        </div>
      </Card>
    </>
  );
}
