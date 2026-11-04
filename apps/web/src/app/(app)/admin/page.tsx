'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import * as Lucide from 'lucide-react';
import { MODULES, type AdminSnapshot } from '@ufos/contracts';
import { useApp } from '@/components/app-provider';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorPanel,
  PageHeader,
  ProgressBar,
  StatCard,
} from '@/components/ui';
import { apiFetch } from '@/lib/api';
import { formatDateTime, truncate } from '@/lib/format';

interface ChainResult {
  valid: boolean;
  checked: number;
  brokenAt: string | null;
}

export default function AdminPage() {
  const { language, t, snapshot, notify } = useApp();
  const [data, setData] = useState<AdminSnapshot | null>(null);
  const [chain, setChain] = useState<ChainResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const hasAccess = Boolean(snapshot?.platformRole);

  const load = useCallback(async () => {
    if (!hasAccess) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(false);
    try {
      const [snapshotData, chainData] = await Promise.all([
        apiFetch<AdminSnapshot>('/admin'),
        apiFetch<ChainResult>('/admin/audit/verify'),
      ]);
      setData(snapshotData);
      setChain(chainData);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [hasAccess]);

  useEffect(() => {
    void load();
  }, [load]);

  const verify = async () => {
    try {
      const result = await apiFetch<ChainResult>('/admin/audit/verify');
      setChain(result);
      notify(
        result.valid ? t('admin.chainValid') : t('admin.chainInvalid'),
        result.valid ? 'success' : 'error',
      );
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Platform administration"
        title={t('admin.title')}
        description={t('admin.subtitle')}
        action={
          hasAccess ? (
            <Button variant="primary" onClick={() => void verify()}>
              <Lucide.ShieldCheck className="h-4 w-4" />
              {t('admin.verify')}
            </Button>
          ) : undefined
        }
      />

      <Card className="mb-5 flex flex-wrap items-center justify-between gap-4 border-[var(--accent)] p-5">
        <p className="flex items-center gap-3 text-sm font-semibold">
          <Lucide.Info className="h-5 w-5 text-[var(--accent-strong)]" />
          {t('admin.platformNotice')}
        </p>
        <Badge tone={chain?.valid ? 'success' : chain ? 'danger' : 'warning'}>
          {chain
            ? chain.valid
              ? t('admin.chainValid')
              : t('admin.chainInvalid')
            : t('common.loading')}
          {chain ? ` · ${chain.checked}` : ''}
        </Badge>
      </Card>

      {!hasAccess ? (
        <EmptyState
          icon="LockKeyhole"
          title={t('error.403')}
          description={t('admin.noAccess')}
          action={
            <Link href="/dashboard" className="uf-button uf-button-primary">
              {t('common.dashboard')}
            </Link>
          }
        />
      ) : error ? (
        <ErrorPanel message={t('common.error')} onRetry={() => void load()} />
      ) : loading ? (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="uf-skeleton h-72" />
          <div className="uf-skeleton h-72" />
        </div>
      ) : data ? (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard icon="UsersRound" label={t('admin.usersCard')} value={data.users.length} />
            <StatCard
              icon="Users"
              label={t('admin.spacesCard')}
              value={data.spaces.length}
              tone="success"
            />
            <StatCard
              icon="ScrollText"
              label={t('admin.auditCard')}
              value={data.audit.length}
              tone="warning"
            />
            <StatCard
              icon="Blocks"
              label={t('admin.moduleCard')}
              value={data.modules.filter((module) => module.enabled).length}
              hint={`${MODULES.length} ${t('common.totalModules').toLowerCase()}`}
              tone="accent"
            />
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <Card className="p-6">
              <h2 className="mb-4 text-lg font-bold">{t('admin.usersCard')}</h2>
              <div className="overflow-x-auto">
                <table className="uf-table">
                  <thead>
                    <tr>
                      <th>{t('common.users')}</th>
                      <th>{t('common.role')}</th>
                      <th>{t('common.spaces')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.users.map((user) => (
                      <tr key={user.id}>
                        <td>
                          <div className="flex items-center gap-3">
                            <Avatar name={user.displayName} color={user.avatarColor} size="sm" />
                            <div>
                              <p className="font-bold">{user.displayName}</p>
                              <p className="text-xs text-[var(--muted)]">{user.email}</p>
                            </div>
                          </div>
                        </td>
                        <td>
                          {user.platformRole ? (
                            <Badge tone="accent">{t(`roles.${user.platformRole}`)}</Badge>
                          ) : (
                            <span className="text-xs text-[var(--muted)]">—</span>
                          )}
                          {user.isChild ? (
                            <Badge tone="warning" className="ml-1">
                              {t('roles.child')}
                            </Badge>
                          ) : null}
                        </td>
                        <td>{user.spaceCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card className="p-6">
              <h2 className="mb-4 text-lg font-bold">{t('admin.spacesCard')}</h2>
              <div className="space-y-3">
                {data.spaces.map((space) => (
                  <div
                    key={space.id}
                    className="uf-card-soft flex items-center justify-between gap-3 p-3"
                  >
                    <div>
                      <p className="text-sm font-bold">{space.name}</p>
                      <p className="text-xs text-[var(--muted)]">{t(`spaceKind.${space.kind}`)}</p>
                    </div>
                    <Badge tone="accent">
                      {space.memberCount} {t('common.memberCount').toLowerCase()}
                    </Badge>
                  </div>
                ))}
              </div>
              <div className="mt-5">
                <div className="mb-2 flex justify-between text-xs font-bold">
                  <span>{t('admin.moduleCard')}</span>
                  <span className="text-[var(--muted)]">
                    {data.modules.filter((module) => module.enabled).length} / {data.modules.length}
                  </span>
                </div>
                <ProgressBar
                  value={data.modules.filter((module) => module.enabled).length}
                  max={data.modules.length}
                />
                <div className="mt-3 flex flex-wrap gap-1">
                  {MODULES.filter((module) => module.status === 'foundation').map((module) => (
                    <Badge key={module.id} tone="success">
                      {t(`modules.${module.id}`)}
                    </Badge>
                  ))}
                </div>
              </div>
            </Card>
          </div>

          <Card id="audit" className="p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold">{t('common.audit')}</h2>
                <p className="text-xs text-[var(--muted)]">
                  {chain?.valid ? t('admin.chainValid') : t('admin.chainInvalid')}
                </p>
              </div>
              <Badge tone="accent">
                <Lucide.Hash className="h-3 w-3" />
                Hash chain
              </Badge>
            </div>
            <div className="overflow-x-auto">
              <table className="uf-table">
                <thead>
                  <tr>
                    <th>{t('common.recentActivity')}</th>
                    <th>{t('common.account')}</th>
                    <th>{t('common.space')}</th>
                    <th>{t('common.created')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.audit.slice(0, 20).map((event) => (
                    <tr key={event.id}>
                      <td>
                        <span className="uf-mono text-xs font-bold">{event.action}</span>
                        <p className="text-xs text-[var(--muted)]">{event.entity}</p>
                      </td>
                      <td className="text-xs">{truncate(event.actorEmail ?? 'system', 28)}</td>
                      <td className="uf-mono text-xs text-[var(--muted)]">
                        {event.spaceId ? event.spaceId.slice(0, 12) : '—'}
                      </td>
                      <td className="text-xs text-[var(--muted)]">
                        {formatDateTime(language, event.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : null}
    </>
  );
}
