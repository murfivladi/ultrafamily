'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import * as Lucide from 'lucide-react';
import {
  ALL_ACTIONS,
  MODULES,
  resolvePermission,
  type Action,
  type ModuleId,
  type OverrideDecision,
  type Space,
  type SpaceRole,
} from '@ufos/contracts';
import { useApp } from '@/components/app-provider';
import {
  Badge,
  Button,
  Card,
  DynamicIcon,
  EmptyState,
  ErrorPanel,
  Field,
  PageHeader,
} from '@/components/ui';
import { apiFetch } from '@/lib/api';
import { formatDate } from '@/lib/format';

interface SpaceWithRole extends Space {
  role: SpaceRole;
}

interface SpaceMember {
  userId: string;
  displayName: string;
  email: string;
  role: SpaceRole;
  isChild: boolean;
  overrides: Record<string, OverrideDecision>;
  sensitiveGrants: string[];
  joinedAt: string;
}

const ROLES: SpaceRole[] = ['space_owner', 'space_admin', 'adult', 'child', 'guest'];
const SENSITIVE_MODULES = MODULES.filter((module) => module.sensitive);

export default function SpacesPage() {
  const { language, t, snapshot, refresh, notify } = useApp();
  const [spaces, setSpaces] = useState<SpaceWithRole[]>([]);
  const [members, setMembers] = useState<SpaceMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [createName, setCreateName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<SpaceRole>('adult');
  const [inviteToken, setInviteToken] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedMember, setSelectedMember] = useState('');
  const [selectedModule, setSelectedModule] = useState<ModuleId>('calendar');
  const [selectedAction, setSelectedAction] = useState<Action>('read');
  const [decision, setDecision] = useState<'' | OverrideDecision>('');
  const [grantModule, setGrantModule] = useState<ModuleId>('health');
  const activeSpaceId = snapshot?.activeSpace?.id;
  const canManage = Boolean(snapshot?.permissions.includes('spaces:manage_access'));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    const load = async () => {
      try {
        const spaceRows = await apiFetch<SpaceWithRole[]>('/spaces');
        if (cancelled) return;
        setSpaces(spaceRows);
        if (activeSpaceId) {
          try {
            const memberRows = await apiFetch<SpaceMember[]>(`/spaces/${activeSpaceId}/members`);
            if (!cancelled) setMembers(memberRows);
          } catch {
            if (!cancelled) setMembers([]);
          }
        } else {
          setMembers([]);
        }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [activeSpaceId, reload]);

  useEffect(() => {
    if (members.length && !members.some((member) => member.userId === selectedMember)) {
      setSelectedMember(members[0]?.userId ?? '');
    }
  }, [members, selectedMember]);

  const matrix = useMemo(
    () =>
      ROLES.map((role) => ({
        role,
        allowed: resolvePermission({
          role,
          moduleId: selectedModule,
          action: selectedAction,
          moduleEnabled: true,
        }).allowed,
      })),
    [selectedAction, selectedModule],
  );

  const reloadData = async (switchSpace = false) => {
    if (switchSpace) await refresh();
    setReload((value) => value + 1);
  };

  const createSpace = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy('create');
    try {
      await apiFetch('/spaces', { method: 'POST', body: { name: createName, kind: 'household' } });
      setCreateName('');
      notify(t('common.saved'), 'success');
      await reloadData();
    } catch {
      notify(t('common.error'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const createInvite = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!activeSpaceId) return;
    setBusy('invite');
    try {
      const result = await apiFetch<{ token?: string }>(`/spaces/${activeSpaceId}/invitations`, {
        method: 'POST',
        body: { role: inviteRole, email: inviteEmail || null, expiresInDays: 14 },
      });
      setInviteToken(result.token ?? '');
      notify(t('spaces.inviteCreated'), 'success');
    } catch {
      notify(t('common.error'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const switchSpace = async (spaceId: string) => {
    setBusy(spaceId);
    try {
      await apiFetch(`/spaces/${spaceId}/switch`, { method: 'POST', body: {} });
      await reloadData(true);
      notify(t('common.saved'), 'success');
    } catch {
      notify(t('common.error'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const applyOverride = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!activeSpaceId || !selectedMember) return;
    setBusy('override');
    try {
      await apiFetch(`/spaces/${activeSpaceId}/permissions`, {
        method: 'PATCH',
        body: {
          userId: selectedMember,
          moduleId: selectedModule,
          action: selectedAction,
          decision: decision || null,
        },
      });
      notify(t('common.saved'), 'success');
      await reloadData();
    } catch {
      notify(t('common.error'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const applyGrant = async (granted: boolean) => {
    if (!activeSpaceId || !selectedMember) return;
    setBusy('grant');
    try {
      await apiFetch(`/spaces/${activeSpaceId}/sensitive-grants`, {
        method: 'PATCH',
        body: { userId: selectedMember, moduleId: grantModule, granted },
      });
      notify(t('common.saved'), 'success');
      await reloadData();
    } catch {
      notify(t('common.error'), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Tenant isolation · RBAC + overrides"
        title={t('spaces.title')}
        description={t('spaces.subtitle')}
        action={
          <Badge tone="accent">
            <Lucide.Fence className="h-3.5 w-3.5" />
            {t('common.private')}
          </Badge>
        }
      />

      {error ? (
        <ErrorPanel message={t('common.error')} onRetry={() => setReload((value) => value + 1)} />
      ) : loading ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="uf-skeleton h-80" />
          <div className="uf-skeleton h-80" />
        </div>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
          <div className="space-y-5">
            <Card className="p-6">
              <h2 className="text-lg font-bold">{t('common.spaces')}</h2>
              <div className="mt-4 space-y-3">
                {spaces.map((space) => {
                  const active = space.id === activeSpaceId;
                  return (
                    <div
                      key={space.id}
                      className={`uf-card-soft flex flex-wrap items-center justify-between gap-3 p-4 ${active ? 'border-[var(--accent)]' : ''}`}
                    >
                      <div className="flex items-center gap-3">
                        <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent-strong)]">
                          <DynamicIcon
                            name={
                              space.kind === 'personal'
                                ? 'LockKeyhole'
                                : space.kind === 'family_network'
                                  ? 'Network'
                                  : 'House'
                            }
                          />
                        </span>
                        <div>
                          <p className="text-sm font-bold">{space.name}</p>
                          <p className="text-xs text-[var(--muted)]">
                            {t(`spaceKind.${space.kind}`)} · {t(`roles.${space.role}`)}
                          </p>
                        </div>
                      </div>
                      {active ? (
                        <Badge tone="success">{t('spaces.active')}</Badge>
                      ) : (
                        <Button
                          className="px-3 py-1 text-xs"
                          disabled={busy === space.id}
                          onClick={() => void switchSpace(space.id)}
                        >
                          {t('spaces.switchSpace')}
                        </Button>
                      )}
                    </div>
                  );
                })}
                {spaces.length === 0 ? (
                  <EmptyState
                    icon="UsersRound"
                    title={t('common.noData')}
                    description={t('admin.platformNotice')}
                  />
                ) : null}
              </div>
            </Card>

            <Card className="p-6">
              <h2 className="text-lg font-bold">{t('spaces.createTitle')}</h2>
              <form onSubmit={createSpace} className="mt-4 space-y-3">
                <Field label={t('spaces.createPlaceholder')} htmlFor="space-name">
                  <input
                    id="space-name"
                    className="uf-input"
                    value={createName}
                    onChange={(event) => setCreateName(event.target.value)}
                    placeholder={t('spaces.createPlaceholder')}
                    required
                    minLength={2}
                  />
                </Field>
                <Button type="submit" variant="primary" loading={busy === 'create'}>
                  <Lucide.Plus className="h-4 w-4" />
                  {t('common.create')}
                </Button>
              </form>
            </Card>

            {canManage ? (
              <Card className="p-6">
                <h2 className="text-lg font-bold">{t('spaces.inviteTitle')}</h2>
                <form onSubmit={createInvite} className="mt-4 grid gap-3 sm:grid-cols-2">
                  <Field label={t('spaces.inviteEmail')} htmlFor="invite-email">
                    <input
                      id="invite-email"
                      type="email"
                      className="uf-input"
                      value={inviteEmail}
                      onChange={(event) => setInviteEmail(event.target.value)}
                    />
                  </Field>
                  <Field label={t('spaces.inviteRole')} htmlFor="invite-role">
                    <select
                      id="invite-role"
                      className="uf-select"
                      value={inviteRole}
                      onChange={(event) => setInviteRole(event.target.value as SpaceRole)}
                    >
                      {(['space_admin', 'adult', 'child', 'guest'] as SpaceRole[]).map((role) => (
                        <option key={role} value={role}>
                          {t(`roles.${role}`)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="sm:col-span-2">
                    <Button type="submit" variant="primary" loading={busy === 'invite'}>
                      <Lucide.UserPlus className="h-4 w-4" />
                      {t('common.invite')}
                    </Button>
                  </div>
                </form>
                {inviteToken ? (
                  <div className="mt-4 rounded-2xl bg-[var(--surface-soft)] p-3">
                    <p className="text-xs font-bold text-[var(--muted)]">
                      {t('spaces.inviteToken')}
                    </p>
                    <code className="uf-mono mt-1 block break-all text-sm">{inviteToken}</code>
                  </div>
                ) : null}
              </Card>
            ) : null}
          </div>

          <div className="space-y-5">
            {!activeSpaceId ? (
              <EmptyState
                icon="ServerCog"
                title={t('common.noData')}
                description={t('admin.platformNotice')}
                action={
                  <Link href="/admin" className="uf-button uf-button-primary">
                    {t('common.admin')}
                  </Link>
                }
              />
            ) : (
              <>
                <Card className="p-6">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <h2 className="text-lg font-bold">{t('spaces.members')}</h2>
                    <Badge tone="accent">
                      {t('spaces.currentRole')}:{' '}
                      {snapshot?.activeSpace
                        ? t(
                            `roles.${spaces.find((space) => space.id === activeSpaceId)?.role ?? 'guest'}`,
                          )
                        : '—'}
                    </Badge>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="uf-table">
                      <thead>
                        <tr>
                          <th>{t('common.name')}</th>
                          <th>{t('common.role')}</th>
                          <th>{t('common.permissions')}</th>
                          <th>{t('common.created')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {members.map((member) => (
                          <tr key={member.userId}>
                            <td>
                              <p className="font-bold">{member.displayName}</p>
                              <p className="text-xs text-[var(--muted)]">{member.email}</p>
                            </td>
                            <td>
                              <Badge tone={member.role === 'guest' ? 'warning' : 'accent'}>
                                {t(`roles.${member.role}`)}
                              </Badge>
                            </td>
                            <td className="text-xs text-[var(--muted)]">
                              {Object.keys(member.overrides).length} overrides ·{' '}
                              {member.sensitiveGrants.length} grants
                            </td>
                            <td className="text-xs text-[var(--muted)]">
                              {formatDate(language, member.joinedAt)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {members.length === 0 ? (
                      <p className="py-5 text-center text-sm text-[var(--muted)]">
                        {t('common.noData')}
                      </p>
                    ) : null}
                  </div>
                </Card>

                <Card className="p-6">
                  <h2 className="text-lg font-bold">{t('spaces.permissionMatrix')}</h2>
                  <p className="mt-1 text-sm leading-6 text-[var(--muted)]">
                    {t('spaces.permissionText')}
                  </p>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <Field label={t('spaces.overrideModule')} htmlFor="matrix-module">
                      <select
                        id="matrix-module"
                        className="uf-select"
                        value={selectedModule}
                        onChange={(event) => setSelectedModule(event.target.value as ModuleId)}
                      >
                        {MODULES.map((module) => (
                          <option key={module.id} value={module.id}>
                            {t(`modules.${module.id}`)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={t('spaces.overrideAction')} htmlFor="matrix-action">
                      <select
                        id="matrix-action"
                        className="uf-select"
                        value={selectedAction}
                        onChange={(event) => setSelectedAction(event.target.value as Action)}
                      >
                        {ALL_ACTIONS.map((action) => (
                          <option key={action} value={action}>
                            {t(`actions.${action}`)}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {matrix.map((item) => (
                      <span
                        key={item.role}
                        className={`uf-badge ${item.allowed ? 'uf-badge-success' : 'uf-badge-danger'}`}
                      >
                        {item.allowed ? (
                          <Lucide.Check className="h-3 w-3" />
                        ) : (
                          <Lucide.X className="h-3 w-3" />
                        )}
                        {t(`roles.${item.role}`)}
                      </span>
                    ))}
                  </div>
                </Card>

                {canManage ? (
                  <Card className="p-6 uf-advanced">
                    <h2 className="text-lg font-bold">{t('spaces.overrideTitle')}</h2>
                    <form onSubmit={applyOverride} className="mt-4 grid gap-3 md:grid-cols-2">
                      <Field label={t('spaces.overrideMember')} htmlFor="override-member">
                        <select
                          id="override-member"
                          className="uf-select"
                          value={selectedMember}
                          onChange={(event) => setSelectedMember(event.target.value)}
                        >
                          {members.map((member) => (
                            <option key={member.userId} value={member.userId}>
                              {member.displayName}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label={t('spaces.overrideDecision')} htmlFor="override-decision">
                        <select
                          id="override-decision"
                          className="uf-select"
                          value={decision}
                          onChange={(event) =>
                            setDecision(event.target.value as '' | OverrideDecision)
                          }
                        >
                          <option value="">{t('spaces.inherit')}</option>
                          <option value="allow">{t('spaces.allow')}</option>
                          <option value="deny">{t('spaces.deny')}</option>
                        </select>
                      </Field>
                      <div className="md:col-span-2">
                        <Button type="submit" variant="primary" loading={busy === 'override'}>
                          <Lucide.ShieldCheck className="h-4 w-4" />
                          {t('spaces.applyOverride')}
                        </Button>
                      </div>
                    </form>
                    <div className="mt-5 border-t border-[var(--border)] pt-5">
                      <label className="uf-label" htmlFor="grant-module">
                        {t('catalog.sensitive')}
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <select
                          id="grant-module"
                          className="uf-select w-auto"
                          value={grantModule}
                          onChange={(event) => setGrantModule(event.target.value as ModuleId)}
                        >
                          {SENSITIVE_MODULES.map((module) => (
                            <option key={module.id} value={module.id}>
                              {t(`modules.${module.id}`)}
                            </option>
                          ))}
                        </select>
                        <Button onClick={() => void applyGrant(true)} disabled={busy === 'grant'}>
                          {t('spaces.allow')}
                        </Button>
                        <Button
                          variant="danger"
                          onClick={() => void applyGrant(false)}
                          disabled={busy === 'grant'}
                        >
                          {t('spaces.deny')}
                        </Button>
                      </div>
                    </div>
                  </Card>
                ) : null}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
