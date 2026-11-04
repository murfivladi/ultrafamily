'use client';

import { useCallback, useEffect, useState } from 'react';
import type { TaskBoard, TaskItem, TaskPriority, TaskStatus } from '@ufos/contracts';
import * as Lucide from 'lucide-react';
import { useApp } from '@/components/app-provider';
import { Badge, Button, Card, EmptyState, ErrorPanel, Field, PageHeader } from '@/components/ui';
import { apiFetch, apiPath } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useRealtimeReload } from '@/lib/use-realtime';

interface TemplateItem {
  id: string;
  name: string;
  fields: Record<string, unknown>;
  createdAt: string | null;
}

const STATUSES: TaskStatus[] = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'];
const PRIORITIES: TaskPriority[] = ['low', 'normal', 'high', 'urgent'];

function localDateTime(offsetHours = 24): string {
  const date = new Date(Date.now() + offsetHours * 3_600_000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export default function TasksPage() {
  const { language, t, snapshot, notify, online } = useApp();
  const spaceId = snapshot?.activeSpace?.id;
  const { connected, reload, refresh } = useRealtimeReload(spaceId, ['tasks']);
  const [board, setBoard] = useState<TaskBoard | null>(null);
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [dueAt, setDueAt] = useState(() => localDateTime());
  const [estimate, setEstimate] = useState('30');
  const [complexity, setComplexity] = useState('2');
  const [listId, setListId] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [actionBusy, setActionBusy] = useState(false);

  const load = useCallback(async () => {
    if (!spaceId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(false);
    try {
      const [boardResult, templateResult] = await Promise.all([
        apiFetch<TaskBoard>(apiPath('/tasks/board', { spaceId })),
        apiFetch<TemplateItem[]>(apiPath('/tasks/templates', { spaceId })),
      ]);
      setBoard(boardResult);
      setTemplates(templateResult);
      setListId((current) => current || boardResult.lists[0]?.id || '');
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  useEffect(() => {
    void load();
  }, [load, reload]);

  const createTask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!spaceId || !title.trim()) return;
    if (!online) {
      notify(t('error.offlineSave'), 'error');
      return;
    }
    try {
      await apiFetch('/tasks', {
        method: 'POST',
        body: {
          spaceId,
          listId: listId || undefined,
          title: title.trim(),
          description,
          status: 'todo',
          priority,
          category: 'home',
          assigneeUserId: null,
          dueAt: dueAt ? new Date(dueAt).toISOString() : null,
          estimateMinutes: Number(estimate),
          complexity: Number(complexity),
          recurrenceRule: null,
          links: [],
        },
      });
      setTitle('');
      setDescription('');
      notify(t('common.saved'), 'success');
      refresh();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const patchTask = async (task: TaskItem, patch: Record<string, unknown>) => {
    if (!spaceId) return;
    try {
      await apiFetch(`/tasks/${encodeURIComponent(task.id)}`, {
        method: 'PATCH',
        body: { spaceId, expectedVersion: task.version, ...patch },
      });
      refresh();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const smartAction = async (task: TaskItem, kind: 'claim' | 'prioritize' | 'split') => {
    if (!spaceId) return;
    setActionBusy(true);
    try {
      if (kind === 'claim') {
        await apiFetch(`/tasks/${encodeURIComponent(task.id)}/claim`, {
          method: 'POST',
          body: { spaceId },
        });
      } else if (kind === 'prioritize') {
        const result = await apiFetch<{ suggested: string; explanation: string }>(
          `/tasks/${encodeURIComponent(task.id)}/prioritize`,
          { method: 'POST', body: { spaceId, apply: true } },
        );
        notify(result.suggested, 'success');
      } else {
        const result = await apiFetch<{ created: TaskItem[] }>(
          `/tasks/${encodeURIComponent(task.id)}/split`,
          { method: 'POST', body: { spaceId, count: 3, apply: true } },
        );
        notify(String(result.created.length), 'success');
      }
      refresh();
    } catch {
      notify(t('common.error'), 'error');
    } finally {
      setActionBusy(false);
    }
  };

  const autoAssign = async () => {
    if (!spaceId || !board) return;
    const ids = board.tasks
      .filter((task) => task.status !== 'done' && task.status !== 'cancelled')
      .slice(0, 5)
      .map((task) => task.id);
    if (ids.length === 0) return;
    setActionBusy(true);
    try {
      const result = await apiFetch<{ assignments: unknown[] }>('/tasks/auto-assign', {
        method: 'POST',
        body: { spaceId, taskIds: ids },
      });
      notify(String(result.assignments.length), 'success');
      refresh();
    } catch {
      notify(t('common.error'), 'error');
    } finally {
      setActionBusy(false);
    }
  };

  const deleteTask = async (task: TaskItem) => {
    if (!spaceId || !window.confirm(t('common.confirm'))) return;
    try {
      await apiFetch(apiPath(`/tasks/${encodeURIComponent(task.id)}`, { spaceId }), {
        method: 'DELETE',
      });
      refresh();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const createTemplate = async () => {
    if (!spaceId || !templateName.trim()) return;
    try {
      await apiFetch('/tasks/templates', {
        method: 'POST',
        body: {
          spaceId,
          name: templateName.trim(),
          fields: {
            title: templateName.trim(),
            category: 'home',
            estimateMinutes: 30,
            complexity: 2,
          },
        },
      });
      setTemplateName('');
      refresh();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const applyTemplate = async (templateId: string) => {
    if (!spaceId) return;
    try {
      await apiFetch('/tasks/templates/apply', {
        method: 'POST',
        body: { spaceId, templateId, overrides: {} },
      });
      refresh();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  return (
    <>
      <PageHeader
        eyebrow={t('stageB.badge')}
        title={t('modules.tasks')}
        description={t('stageB.tasks.subtitle')}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={connected ? 'success' : 'warning'}>
              <Lucide.Radio className="h-3.5 w-3.5" />
              {connected ? t('stageB.common.connected') : t('stageB.common.disconnected')}
            </Badge>
            <Button variant="primary" onClick={() => void autoAssign()} loading={actionBusy}>
              <Lucide.UserRoundCheck className="h-4 w-4" />
              {t('stageB.tasks.autoAssign')}
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
          <div className="uf-skeleton h-80" />
          <div className="uf-skeleton h-80" />
        </div>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[0.8fr_1.2fr]">
          <div className="space-y-5">
            <Card className="p-6" id="new-task">
              <h2 className="mb-4 text-lg font-bold">{t('stageB.tasks.new')}</h2>
              <form onSubmit={createTask} className="space-y-4">
                <Field label={t('common.name')} htmlFor="task-title">
                  <input
                    id="task-title"
                    className="uf-input"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    required
                    maxLength={200}
                  />
                </Field>
                <Field label={t('common.description')} htmlFor="task-description">
                  <textarea
                    id="task-description"
                    className="uf-input min-h-20"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    maxLength={5000}
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t('stageB.common.priority')} htmlFor="task-priority">
                    <select
                      id="task-priority"
                      className="uf-select"
                      value={priority}
                      onChange={(event) => setPriority(event.target.value as TaskPriority)}
                    >
                      {PRIORITIES.map((value) => (
                        <option key={value} value={value}>
                          {t(`stageB.priority.${value}`)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('stageB.common.due')} htmlFor="task-due">
                    <input
                      id="task-due"
                      type="datetime-local"
                      className="uf-input"
                      value={dueAt}
                      onChange={(event) => setDueAt(event.target.value)}
                    />
                  </Field>
                  <Field label={t('stageB.common.estimate')} htmlFor="task-estimate">
                    <input
                      id="task-estimate"
                      type="number"
                      min={0}
                      max={1440}
                      className="uf-input"
                      value={estimate}
                      onChange={(event) => setEstimate(event.target.value)}
                    />
                  </Field>
                  <Field label={t('stageB.common.complexity')} htmlFor="task-complexity">
                    <input
                      id="task-complexity"
                      type="number"
                      min={1}
                      max={5}
                      className="uf-input"
                      value={complexity}
                      onChange={(event) => setComplexity(event.target.value)}
                    />
                  </Field>
                </div>
                <Field label={t('stageB.common.list')} htmlFor="task-list">
                  <select
                    id="task-list"
                    className="uf-select"
                    value={listId}
                    onChange={(event) => setListId(event.target.value)}
                  >
                    {(board?.lists ?? []).map((list) => (
                      <option key={list.id} value={list.id}>
                        {list.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Button type="submit" variant="primary">
                  <Lucide.ListPlus className="h-4 w-4" />
                  {t('common.create')}
                </Button>
              </form>
            </Card>

            <Card className="p-6">
              <h2 className="mb-4 text-lg font-bold">{t('stageB.common.workload')}</h2>
              {(board?.workload ?? []).length === 0 ? (
                <p className="text-sm text-[var(--muted)]">{t('stageB.common.noData')}</p>
              ) : (
                <div className="space-y-2">
                  {(board?.workload ?? []).map((row) => (
                    <div
                      key={row.userId}
                      className="uf-card-soft flex justify-between gap-3 p-3 text-sm"
                    >
                      <span className="uf-mono text-xs">{row.userId.slice(-8)}</span>
                      <span>
                        {row.openTasks} · {row.minutes} {t('stageB.common.minutes')}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card className="p-6">
              <h2 className="mb-4 text-lg font-bold">{t('stageB.common.templates')}</h2>
              <div className="flex flex-wrap gap-2">
                <input
                  className="uf-input max-w-56"
                  aria-label={t('common.name')}
                  value={templateName}
                  onChange={(event) => setTemplateName(event.target.value)}
                  placeholder={t('common.name')}
                />
                <Button onClick={() => void createTemplate()}>{t('common.create')}</Button>
              </div>
              <div className="mt-4 space-y-2">
                {templates.map((template) => (
                  <div
                    key={template.id}
                    className="uf-card-soft flex items-center justify-between gap-3 p-3"
                  >
                    <span className="text-sm font-bold">{template.name}</span>
                    <Button onClick={() => void applyTemplate(template.id)}>
                      {t('stageB.common.apply')}
                    </Button>
                  </div>
                ))}
                {templates.length === 0 ? (
                  <p className="text-sm text-[var(--muted)]">{t('stageB.common.noData')}</p>
                ) : null}
              </div>
            </Card>
          </div>

          <Card className="p-6">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-lg font-bold">{t('stageB.tasks.board')}</h2>
              <Badge tone="accent">{board?.tasks.length ?? 0}</Badge>
            </div>
            {(board?.tasks ?? []).length === 0 ? (
              <EmptyState icon="ListTodo" title={t('stageB.common.noData')} />
            ) : (
              <div className="space-y-3">
                {(board?.tasks ?? []).map((task) => (
                  <article key={task.id} className="uf-card-soft p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="font-bold">{task.title}</h3>
                        <p className="mt-1 text-xs text-[var(--muted)]">
                          {task.dueAt
                            ? formatDateTime(language, task.dueAt)
                            : t('stageB.common.noData')}
                          {task.estimateMinutes
                            ? ` · ${task.estimateMinutes} ${t('stageB.common.minutes')}`
                            : ''}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Badge
                          tone={
                            task.priority === 'urgent'
                              ? 'danger'
                              : task.priority === 'high'
                                ? 'warning'
                                : 'accent'
                          }
                        >
                          {t(`stageB.priority.${task.priority}`)}
                        </Badge>
                        <Badge
                          tone={
                            task.status === 'done'
                              ? 'success'
                              : task.status === 'blocked'
                                ? 'danger'
                                : 'default'
                          }
                        >
                          {t(`stageB.status.${task.status}`)}
                        </Badge>
                      </div>
                    </div>
                    {task.description ? (
                      <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                        {task.description}
                      </p>
                    ) : null}
                    <p className="mt-2 text-xs text-[var(--muted)]">
                      {t('stageB.common.subtasks')}: {task.subtaskCount} ·{' '}
                      {t('stageB.common.dependencies')}: {task.dependencyCount} · v{task.version}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <select
                        aria-label={t('common.status')}
                        className="uf-select max-w-44 py-1.5 text-xs"
                        value={task.status}
                        onChange={(event) =>
                          void patchTask(task, { status: event.target.value as TaskStatus })
                        }
                      >
                        {STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {t(`stageB.status.${status}`)}
                          </option>
                        ))}
                      </select>
                      <Button onClick={() => void smartAction(task, 'claim')} loading={actionBusy}>
                        {t('stageB.common.claim')}
                      </Button>
                      <Button
                        onClick={() => void smartAction(task, 'prioritize')}
                        loading={actionBusy}
                      >
                        {t('stageB.tasks.prioritize')}
                      </Button>
                      <Button onClick={() => void smartAction(task, 'split')} loading={actionBusy}>
                        {t('stageB.tasks.split')}
                      </Button>
                      <Button variant="danger" onClick={() => void deleteTask(task)}>
                        <Lucide.Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
