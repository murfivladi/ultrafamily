'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  NotificationItem,
  NotificationPreferences,
  NotificationSeverity,
} from '@ufos/contracts';
import * as Lucide from 'lucide-react';
import { useApp } from '@/components/app-provider';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorPanel,
  Field,
  PageHeader,
  Toggle,
} from '@/components/ui';
import { apiFetch, apiPath } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useRealtimeReload } from '@/lib/use-realtime';

interface DeliveryItem {
  id: string;
  channel: string;
  status: string;
  attempts: number;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
  sourceModule: string;
}

interface WebhookItem {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  createdAt: string | null;
}

interface DigestGroup {
  category: string;
  unread: number;
  latest: string;
}

const CATEGORY_IDS = ['calendar', 'tasks', 'shopping', 'public_site', 'security', 'test'];

export default function NotificationsPage() {
  const { language, t, snapshot, notify, online } = useApp();
  const spaceId = snapshot?.activeSpace?.id;
  const { connected, reload, refresh } = useRealtimeReload(spaceId, ['notifications']);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [unread, setUnread] = useState(0);
  const [deliveries, setDeliveries] = useState<DeliveryItem[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookItem[]>([]);
  const [digest, setDigest] = useState<DigestGroup[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [severity, setSeverity] = useState<NotificationSeverity>('info');
  const [quietEnabled, setQuietEnabled] = useState(false);
  const [quietFrom, setQuietFrom] = useState('22:00');
  const [quietTo, setQuietTo] = useState('07:00');
  const [dailyDigest, setDailyDigest] = useState(true);
  const [weeklyDigest, setWeeklyDigest] = useState(false);
  const [urgentOverride, setUrgentOverride] = useState(true);
  const [categories, setCategories] = useState<Record<string, boolean>>({});
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [webhookEnabled, setWebhookEnabled] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [list, preferences, count, log, hooks] = await Promise.all([
        apiFetch<NotificationItem[]>('/notifications?limit=100'),
        apiFetch<NotificationPreferences>('/notifications/preferences'),
        apiFetch<{ count: number }>('/notifications/unread-count'),
        apiFetch<DeliveryItem[]>(apiPath('/notifications/deliveries', { spaceId })),
        spaceId
          ? apiFetch<WebhookItem[]>(apiPath('/notifications/webhooks', { spaceId }))
          : Promise.resolve([] as WebhookItem[]),
      ]);
      setItems(list);
      setPrefs(preferences);
      setUnread(count.count);
      setDeliveries(log);
      setWebhooks(hooks);
      setQuietEnabled(preferences.quietHours.enabled);
      setQuietFrom(preferences.quietHours.from);
      setQuietTo(preferences.quietHours.to);
      setDailyDigest(preferences.dailyDigest);
      setWeeklyDigest(preferences.weeklyDigest);
      setUrgentOverride(preferences.urgentOverride);
      setCategories(preferences.categories);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  useEffect(() => {
    void load();
  }, [load, reload]);

  const savePreferences = async () => {
    if (!prefs) return;
    try {
      const updated = await apiFetch<NotificationPreferences>('/notifications/preferences', {
        method: 'PATCH',
        body: {
          quietHours: {
            enabled: quietEnabled,
            from: quietFrom,
            to: quietTo,
            timezone: 'Europe/Rome',
          },
          dailyDigest,
          weeklyDigest,
          urgentOverride,
          categories,
        },
      });
      setPrefs(updated);
      notify(t('common.saved'), 'success');
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const markRead = async (id: string) => {
    try {
      await apiFetch(`/notifications/${encodeURIComponent(id)}/read`, {
        method: 'POST',
        body: {},
      });
      refresh();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const markAllRead = async () => {
    try {
      await apiFetch('/notifications/read-all', {
        method: 'POST',
        body: { spaceId },
      });
      refresh();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const testNotification = async () => {
    if (!online) {
      notify(t('error.offlineSave'), 'error');
      return;
    }
    try {
      await apiFetch('/notifications/test', { method: 'POST', body: { severity } });
      refresh();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const dispatchQueue = async () => {
    try {
      const result = await apiFetch<{ processed: number; delivered: number; skipped: number }>(
        '/notifications/dispatch',
        { method: 'POST', body: {} },
      );
      notify(`${result.delivered}/${result.processed}`, 'success');
      refresh();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const sweepReminders = async () => {
    if (!spaceId) return;
    try {
      const result = await apiFetch<{ events: number; tasks: number }>(
        '/notifications/reminders/sweep',
        { method: 'POST', body: { spaceId } },
      );
      notify(`${result.events}/${result.tasks}`, 'success');
      refresh();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const loadDigest = async () => {
    try {
      const result = await apiFetch<{ groups: DigestGroup[] }>(
        '/notifications/digest?period=daily',
      );
      setDigest(result.groups);
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const createWebhook = async () => {
    if (!spaceId || !webhookUrl.trim() || webhookSecret.length < 12) return;
    try {
      await apiFetch('/notifications/webhooks', {
        method: 'POST',
        body: {
          spaceId,
          url: webhookUrl.trim(),
          secret: webhookSecret,
          events: ['*'],
          enabled: webhookEnabled,
        },
      });
      setWebhookUrl('');
      setWebhookSecret('');
      setWebhookEnabled(false);
      refresh();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  return (
    <>
      <PageHeader
        eyebrow={t('stageB.badge')}
        title={t('modules.notifications')}
        description={t('stageB.notifications.subtitle')}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={connected ? 'success' : 'warning'}>
              <Lucide.Radio className="h-3.5 w-3.5" />
              {connected ? t('stageB.common.connected') : t('stageB.common.disconnected')}
            </Badge>
            <Badge tone="accent">
              <Lucide.BellRing className="h-3.5 w-3.5" />
              {unread}
            </Badge>
            <Button variant="primary" onClick={() => void dispatchQueue()}>
              {t('stageB.notifications.dispatch')}
            </Button>
          </div>
        }
      />

      {error ? (
        <ErrorPanel message={t('common.error')} onRetry={refresh} />
      ) : loading ? (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="uf-skeleton h-80" />
          <div className="uf-skeleton h-80" />
        </div>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[0.85fr_1.15fr]">
          <div className="space-y-5">
            <Card className="p-6">
              <h2 className="mb-4 text-lg font-bold">{t('stageB.notifications.preferences')}</h2>
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-bold">{t('stageB.notifications.quiet')}</span>
                  <Toggle
                    checked={quietEnabled}
                    onChange={setQuietEnabled}
                    label={t('stageB.notifications.quiet')}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t('common.from')} htmlFor="quiet-from">
                    <input
                      id="quiet-from"
                      type="time"
                      className="uf-input"
                      value={quietFrom}
                      onChange={(event) => setQuietFrom(event.target.value)}
                    />
                  </Field>
                  <Field label={t('common.to')} htmlFor="quiet-to">
                    <input
                      id="quiet-to"
                      type="time"
                      className="uf-input"
                      value={quietTo}
                      onChange={(event) => setQuietTo(event.target.value)}
                    />
                  </Field>
                </div>
                {[
                  { label: t('common.daily'), value: dailyDigest, onChange: setDailyDigest },
                  { label: t('common.weekly'), value: weeklyDigest, onChange: setWeeklyDigest },
                  {
                    label: t('common.urgentOverride'),
                    value: urgentOverride,
                    onChange: setUrgentOverride,
                  },
                ].map((row) => (
                  <div key={row.label} className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold">{row.label}</span>
                    <Toggle checked={row.value} onChange={row.onChange} label={row.label} />
                  </div>
                ))}
                <div>
                  <p className="mb-2 text-xs font-extrabold uppercase tracking-wider text-[var(--muted)]">
                    {t('common.categories')}
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {CATEGORY_IDS.map((category) => (
                      <div
                        key={category}
                        className="uf-card-soft flex items-center justify-between gap-2 p-2"
                      >
                        <span className="text-xs font-bold">{category}</span>
                        <Toggle
                          checked={categories[category] !== false}
                          onChange={(value) =>
                            setCategories((current) => ({ ...current, [category]: value }))
                          }
                          label={category}
                        />
                      </div>
                    ))}
                  </div>
                </div>
                <Button variant="primary" onClick={() => void savePreferences()}>
                  <Lucide.Save className="h-4 w-4" />
                  {t('common.save')}
                </Button>
              </div>
            </Card>

            <Card className="p-6">
              <h2 className="mb-4 text-lg font-bold">{t('stageB.notifications.webhook')}</h2>
              <p className="mb-4 text-xs leading-5 text-[var(--muted)]">
                {t('stageB.notifications.webhookHint')}
              </p>
              <div className="space-y-3">
                <Field label={t('common.url')} htmlFor="webhook-url">
                  <input
                    id="webhook-url"
                    type="url"
                    className="uf-input"
                    value={webhookUrl}
                    onChange={(event) => setWebhookUrl(event.target.value)}
                    placeholder="https://example.test/hook"
                  />
                </Field>
                <Field label={t('common.secret')} htmlFor="webhook-secret">
                  <input
                    id="webhook-secret"
                    type="password"
                    className="uf-input"
                    value={webhookSecret}
                    onChange={(event) => setWebhookSecret(event.target.value)}
                    minLength={12}
                  />
                </Field>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold">{t('common.enabled')}</span>
                  <Toggle
                    checked={webhookEnabled}
                    onChange={setWebhookEnabled}
                    label={t('common.enabled')}
                  />
                </div>
                <Button onClick={() => void createWebhook()}>{t('common.create')}</Button>
              </div>
              <div className="mt-4 space-y-2">
                {webhooks.map((hook) => (
                  <div key={hook.id} className="uf-card-soft p-3 text-xs">
                    <p className="break-all font-bold">{hook.url}</p>
                    <p className="mt-1 text-[var(--muted)]">
                      {hook.events.join(', ') || '*'} ·{' '}
                      {hook.enabled ? t('common.enabled') : t('common.disabled')}
                    </p>
                  </div>
                ))}
                {webhooks.length === 0 ? (
                  <p className="text-sm text-[var(--muted)]">{t('stageB.common.noData')}</p>
                ) : null}
              </div>
            </Card>
          </div>

          <div className="space-y-5">
            <Card className="p-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-bold">{t('modules.notifications')}</h2>
                <div className="flex flex-wrap gap-2">
                  <select
                    aria-label={t('common.severity')}
                    className="uf-select max-w-36 py-2 text-xs"
                    value={severity}
                    onChange={(event) => setSeverity(event.target.value as NotificationSeverity)}
                  >
                    <option value="info">{t('stageB.common.info')}</option>
                    <option value="important">{t('stageB.common.important')}</option>
                    <option value="urgent">{t('stageB.common.urgent')}</option>
                  </select>
                  <Button onClick={() => void testNotification()}>
                    {t('stageB.notifications.test')}
                  </Button>
                  <Button onClick={() => void sweepReminders()}>
                    {t('stageB.notifications.sweep')}
                  </Button>
                  <Button onClick={() => void loadDigest()}>
                    {t('stageB.notifications.digest')}
                  </Button>
                  <Button onClick={() => void markAllRead()}>{t('stageB.common.markRead')}</Button>
                </div>
              </div>
              {items.length === 0 ? (
                <EmptyState icon="BellRing" title={t('stageB.common.noData')} />
              ) : (
                <div className="space-y-3">
                  {items.map((item) => (
                    <article key={item.id} className="uf-card-soft p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h3 className="font-bold">{item.title}</h3>
                          <p className="mt-1 text-xs text-[var(--muted)]">
                            {formatDateTime(language, item.createdAt)} · {item.sourceModule}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
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
                          {item.readAt ? (
                            <Badge tone="success">{t('stageB.common.markRead')}</Badge>
                          ) : null}
                          {item.groupedCount > 1 ? (
                            <Badge tone="default">×{item.groupedCount}</Badge>
                          ) : null}
                        </div>
                      </div>
                      <p className="mt-2 text-sm leading-6 text-[var(--muted)]">{item.body}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {!item.readAt ? (
                          <Button onClick={() => void markRead(item.id)}>
                            {t('stageB.common.markRead')}
                          </Button>
                        ) : null}
                        {item.actionUrl ? (
                          <a href={item.actionUrl} className="uf-button">
                            <Lucide.ArrowUpRight className="h-4 w-4" />
                            {t('common.open')}
                          </a>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </Card>

            <Card className="p-6">
              <h2 className="mb-4 text-lg font-bold">{t('stageB.notifications.digest')}</h2>
              {!digest ? (
                <p className="text-sm text-[var(--muted)]">{t('stageB.common.noData')}</p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {digest.map((group) => (
                    <div key={group.category} className="uf-card-soft p-3 text-sm">
                      <p className="font-bold">{group.category}</p>
                      <p className="text-xs text-[var(--muted)]">
                        {t('stageB.common.unread')}: {group.unread}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card className="p-6">
              <h2 className="mb-4 text-lg font-bold">{t('stageB.notifications.deliveries')}</h2>
              {deliveries.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">{t('stageB.common.noData')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="uf-table">
                    <thead>
                      <tr>
                        <th>{t('common.channel')}</th>
                        <th>{t('common.status')}</th>
                        <th>{t('common.created')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deliveries.slice(0, 20).map((delivery) => (
                        <tr key={delivery.id}>
                          <td>{delivery.channel}</td>
                          <td>
                            <Badge tone={delivery.status === 'delivered' ? 'success' : 'warning'}>
                              {delivery.status}
                            </Badge>
                          </td>
                          <td className="text-[var(--muted)]">
                            {formatDateTime(language, delivery.createdAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
