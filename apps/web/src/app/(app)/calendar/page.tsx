'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CalendarEvent, CalendarSummary, CalendarView, RsvpStatus } from '@ufos/contracts';
import * as Lucide from 'lucide-react';
import { useApp } from '@/components/app-provider';
import { Badge, Button, Card, EmptyState, ErrorPanel, Field, PageHeader } from '@/components/ui';
import { apiFetch, apiPath } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useRealtimeReload } from '@/lib/use-realtime';

interface Suggestion {
  startsAt: string;
  endsAt: string;
  score: number;
  reason: string;
}

interface Warning {
  day: string;
  count: number;
  severity: string;
  message: string;
}

interface BusyInterval {
  start: string;
  end: string;
}

interface TokenResult {
  id: string | null;
  name: string;
  token: string;
  expiresAt: string;
}

function localDateTime(offsetHours = 1): string {
  const date = new Date(Date.now() + offsetHours * 3_600_000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export default function CalendarPage() {
  const { language, t, snapshot, notify, online } = useApp();
  const spaceId = snapshot?.activeSpace?.id;
  const { connected, reload, refresh } = useRealtimeReload(spaceId, ['calendar']);
  const [calendars, setCalendars] = useState<CalendarSummary[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [view, setView] = useState<CalendarView>('month');
  const [calendarId, setCalendarId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [startsAt, setStartsAt] = useState(() => localDateTime(2));
  const [endsAt, setEndsAt] = useState(() => localDateTime(3));
  const [ics, setIcs] = useState('');
  const [tokenName, setTokenName] = useState('CalDAV');
  const [tokenResult, setTokenResult] = useState<TokenResult | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [busy, setBusy] = useState<BusyInterval[]>([]);
  const [busyAction, setBusyAction] = useState(false);

  const load = useCallback(async () => {
    if (!spaceId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(false);
    try {
      const [calendarRows, eventRows] = await Promise.all([
        apiFetch<CalendarSummary[]>(apiPath('/calendar/calendars', { spaceId })),
        apiFetch<CalendarEvent[]>(apiPath('/calendar/events', { spaceId, view })),
      ]);
      setCalendars(calendarRows);
      setEvents(eventRows);
      setCalendarId((current) => current || calendarRows[0]?.id || '');
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [spaceId, view]);

  useEffect(() => {
    void load();
  }, [load, reload]);

  const createEvent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!spaceId || !calendarId || !title.trim()) return;
    if (!online) {
      notify(t('error.offlineSave'), 'error');
      return;
    }
    try {
      await apiFetch('/calendar/events', {
        method: 'POST',
        body: {
          spaceId,
          calendarId,
          title: title.trim(),
          description,
          location,
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(endsAt).toISOString(),
          participantIds: snapshot ? [snapshot.user.id] : [],
        },
      });
      setTitle('');
      setDescription('');
      setLocation('');
      notify(t('common.saved'), 'success');
      refresh();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const rsvp = async (id: string, status: RsvpStatus) => {
    if (!spaceId) return;
    try {
      await apiFetch(`/calendar/events/${encodeURIComponent(id)}/rsvp`, {
        method: 'POST',
        body: { spaceId, rsvp: status },
      });
      refresh();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const cancelEvent = async (eventItem: CalendarEvent) => {
    if (!spaceId) return;
    try {
      await apiFetch(`/calendar/events/${encodeURIComponent(eventItem.id)}`, {
        method: 'PATCH',
        body: {
          spaceId,
          expectedVersion: eventItem.version,
          status: 'cancelled',
        },
      });
      refresh();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const deleteEvent = async (eventItem: CalendarEvent) => {
    if (!spaceId || !window.confirm(t('common.confirm'))) return;
    try {
      await apiFetch(apiPath(`/calendar/events/${encodeURIComponent(eventItem.id)}`, { spaceId }), {
        method: 'DELETE',
      });
      refresh();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const importIcs = async () => {
    if (!spaceId || !calendarId || !ics.trim()) return;
    try {
      const result = await apiFetch<{ imported: number; skipped: number }>('/calendar/import', {
        method: 'POST',
        body: { spaceId, calendarId, ics },
      });
      notify(`${result.imported} / ${result.skipped}`, 'success');
      setIcs('');
      refresh();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const createToken = async () => {
    if (!spaceId || !calendarId) return;
    try {
      const result = await apiFetch<TokenResult>('/calendar/tokens', {
        method: 'POST',
        body: { spaceId, calendarId, name: tokenName, expiresInDays: 90 },
      });
      setTokenResult(result);
      notify(t('common.saved'), 'success');
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const suggestTime = async () => {
    if (!spaceId) return;
    setBusyAction(true);
    try {
      const [suggestionResult, overloadResult, freeBusyResult] = await Promise.all([
        apiFetch<{ candidates: Suggestion[] }>('/calendar/suggest-time', {
          method: 'POST',
          body: {
            spaceId,
            participantIds: snapshot ? [snapshot.user.id] : [],
            durationMinutes: 60,
            from: new Date(Date.now() + 3_600_000).toISOString(),
            to: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          },
        }),
        apiFetch<{ warnings: Warning[] }>(apiPath('/calendar/overload', { spaceId })),
        apiFetch<{ busy: BusyInterval[] }>('/calendar/free-busy', {
          method: 'POST',
          body: { spaceId, participantIds: snapshot ? [snapshot.user.id] : [] },
        }),
      ]);
      setSuggestions(suggestionResult.candidates);
      setWarnings(overloadResult.warnings);
      setBusy(freeBusyResult.busy);
    } catch {
      notify(t('common.error'), 'error');
    } finally {
      setBusyAction(false);
    }
  };

  const exportHref = `/api${apiPath('/calendar/export.ics', { spaceId, calendarId })}`;

  return (
    <>
      <PageHeader
        eyebrow={t('stage.current')}
        title={t('modules.calendar')}
        description={t('stageB.calendar.subtitle')}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={connected ? 'success' : 'warning'}>
              <Lucide.Radio className="h-3.5 w-3.5" />
              {connected ? t('stageB.common.connected') : t('stageB.common.disconnected')}
            </Badge>
            <a href={exportHref} className="uf-button" download>
              <Lucide.Download className="h-4 w-4" />
              {t('stageB.common.export')}
            </a>
            <Button variant="primary" onClick={() => void suggestTime()} loading={busyAction}>
              <Lucide.Sparkles className="h-4 w-4" />
              {t('stageB.calendar.suggest')}
            </Button>
          </div>
        }
      />

      {!spaceId ? (
        <EmptyState
          icon="UsersRound"
          title={t('common.noData')}
          description={t('admin.noAccess')}
        />
      ) : error ? (
        <ErrorPanel message={t('common.error')} onRetry={refresh} />
      ) : loading ? (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="uf-skeleton h-72" />
          <div className="uf-skeleton h-72" />
        </div>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
          <div className="space-y-5">
            <Card className="p-6" id="new-event">
              <h2 className="mb-4 text-lg font-bold">{t('stageB.calendar.newEvent')}</h2>
              <form onSubmit={createEvent} className="space-y-4">
                <Field label={t('common.name')} htmlFor="calendar-title">
                  <input
                    id="calendar-title"
                    className="uf-input"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    required
                    maxLength={200}
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t('stageB.common.starts')} htmlFor="calendar-start">
                    <input
                      id="calendar-start"
                      type="datetime-local"
                      className="uf-input"
                      value={startsAt}
                      onChange={(event) => setStartsAt(event.target.value)}
                      required
                    />
                  </Field>
                  <Field label={t('stageB.common.ends')} htmlFor="calendar-end">
                    <input
                      id="calendar-end"
                      type="datetime-local"
                      className="uf-input"
                      value={endsAt}
                      onChange={(event) => setEndsAt(event.target.value)}
                      required
                    />
                  </Field>
                </div>
                <Field label={t('common.description')} htmlFor="calendar-description">
                  <textarea
                    id="calendar-description"
                    className="uf-input min-h-20"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    maxLength={5000}
                  />
                </Field>
                <Field label={t('common.location')} htmlFor="calendar-location">
                  <input
                    id="calendar-location"
                    className="uf-input"
                    value={location}
                    onChange={(event) => setLocation(event.target.value)}
                    maxLength={300}
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t('modules.calendar')} htmlFor="calendar-id">
                    <select
                      id="calendar-id"
                      className="uf-select"
                      value={calendarId}
                      onChange={(event) => setCalendarId(event.target.value)}
                    >
                      {calendars.map((calendar) => (
                        <option key={calendar.id} value={calendar.id}>
                          {calendar.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('common.view')} htmlFor="calendar-view">
                    <select
                      id="calendar-view"
                      className="uf-select"
                      value={view}
                      onChange={(event) => setView(event.target.value as CalendarView)}
                    >
                      <option value="day">{t('common.day')}</option>
                      <option value="week">{t('common.week')}</option>
                      <option value="month">{t('common.month')}</option>
                      <option value="agenda">{t('common.agenda')}</option>
                    </select>
                  </Field>
                </div>
                <Button type="submit" variant="primary">
                  <Lucide.CalendarPlus className="h-4 w-4" />
                  {t('common.create')}
                </Button>
              </form>
            </Card>

            <Card className="p-6">
              <h2 className="mb-4 text-lg font-bold">{t('stageB.common.import')}</h2>
              <Field label="ICS" htmlFor="calendar-ics" hint={t('stageB.calendar.importHint')}>
                <textarea
                  id="calendar-ics"
                  className="uf-input min-h-32 uf-mono text-xs"
                  value={ics}
                  onChange={(event) => setIcs(event.target.value)}
                  placeholder="BEGIN:VCALENDAR"
                />
              </Field>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button onClick={() => void importIcs()}>
                  <Lucide.Upload className="h-4 w-4" />
                  {t('stageB.common.import')}
                </Button>
              </div>
            </Card>

            <Card className="p-6">
              <h2 className="mb-4 text-lg font-bold">{t('stageB.common.token')}</h2>
              <p className="mb-4 text-xs leading-5 text-[var(--muted)]">
                {t('stageB.calendar.tokenHint')}
              </p>
              <div className="flex flex-wrap gap-2">
                <input
                  className="uf-input max-w-56"
                  aria-label={t('common.name')}
                  value={tokenName}
                  onChange={(event) => setTokenName(event.target.value)}
                />
                <Button onClick={() => void createToken()}>{t('common.create')}</Button>
              </div>
              {tokenResult ? (
                <div className="mt-4 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm">
                  <p className="font-bold">{t('stageB.common.token')}</p>
                  <p className="mt-2 break-all uf-mono text-xs">{tokenResult.token}</p>
                  <p className="mt-2 text-xs text-amber-900">
                    {formatDateTime(language, tokenResult.expiresAt)}
                  </p>
                </div>
              ) : null}
            </Card>
          </div>

          <div className="space-y-5">
            <Card className="p-6">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-lg font-bold">{t('stageB.calendar.events')}</h2>
                <Badge tone="accent">{events.length}</Badge>
              </div>
              {events.length === 0 ? (
                <EmptyState icon="CalendarDays" title={t('stageB.common.noData')} />
              ) : (
                <div className="space-y-3">
                  {events.slice(0, 20).map((eventItem) => (
                    <article
                      key={`${eventItem.id}-${eventItem.startsAt}`}
                      className="uf-card-soft p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h3 className="font-bold">{eventItem.title}</h3>
                          <p className="mt-1 text-xs text-[var(--muted)]">
                            {formatDateTime(language, eventItem.startsAt)}
                            {eventItem.location ? ` · ${eventItem.location}` : ''}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Badge tone={eventItem.status === 'cancelled' ? 'danger' : 'success'}>
                            {eventItem.status}
                          </Badge>
                          {eventItem.recurrenceRule ? (
                            <Badge tone="accent">
                              <Lucide.Repeat className="h-3 w-3" />
                              RRULE
                            </Badge>
                          ) : null}
                          {eventItem.isOccurrence ? <Badge tone="warning">occurrence</Badge> : null}
                        </div>
                      </div>
                      {eventItem.description ? (
                        <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                          {eventItem.description}
                        </p>
                      ) : null}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button onClick={() => void rsvp(eventItem.id, 'accepted')}>
                          {t('common.accept')}
                        </Button>
                        <Button onClick={() => void rsvp(eventItem.id, 'declined')}>
                          {t('common.decline')}
                        </Button>
                        <Button onClick={() => void cancelEvent(eventItem)}>
                          {t('common.cancel')}
                        </Button>
                        <Button variant="danger" onClick={() => void deleteEvent(eventItem)}>
                          <Lucide.Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </Card>

            <Card className="p-6">
              <h2 className="mb-4 text-lg font-bold">{t('stageB.calendar.overload')}</h2>
              {suggestions.length === 0 && warnings.length === 0 && busy.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">{t('stageB.common.noData')}</p>
              ) : (
                <div className="space-y-4">
                  {suggestions.slice(0, 3).map((item) => (
                    <div key={item.startsAt} className="uf-card-soft p-3">
                      <p className="text-sm font-bold">{formatDateTime(language, item.startsAt)}</p>
                      <p className="mt-1 text-xs text-[var(--muted)]">{item.reason}</p>
                    </div>
                  ))}
                  {warnings.map((warning) => (
                    <p key={warning.day} className="text-sm text-amber-700">
                      {warning.message}
                    </p>
                  ))}
                  {busy.length > 0 ? (
                    <p className="text-xs text-[var(--muted)]">
                      Free/busy: {busy.length} {t('common.intervals')}
                    </p>
                  ) : null}
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
