'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileItem, JournalEntry } from '@ufos/contracts';
import * as Lucide from 'lucide-react';
import { useApp } from '@/components/app-provider';
import { Badge, Button, Card, EmptyState, ErrorPanel, Field, PageHeader } from '@/components/ui';
import { apiFetch, apiPath } from '@/lib/api';
import { describeError, formatBytes, uploadFile } from '@/lib/uploads';
import { useRealtimeReload } from '@/lib/use-realtime';

type Scope = 'all' | 'mine' | 'family';

interface Draft {
  id: string | null;
  kind: 'diary' | 'story';
  title: string;
  body: string;
  visibility: 'private' | 'family';
  mood: string;
  entryDate: string;
  tags: string;
  fileIds: string[];
}

const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

const emptyDraft = (): Draft => ({
  id: null,
  kind: 'diary',
  title: '',
  body: '',
  visibility: 'private',
  mood: '',
  entryDate: today(),
  tags: '',
  fileIds: [],
});

export default function JournalPage() {
  const { t, notify, online, snapshot } = useApp();
  const spaceId = snapshot?.activeSpace?.id;
  const permissions = useMemo(() => new Set(snapshot?.permissions ?? []), [snapshot?.permissions]);
  const canWrite = permissions.has('journal:create');
  const canUploadFiles = permissions.has('files:create');
  const { reload, refresh } = useRealtimeReload(spaceId, ['journal']);
  const [scope, setScope] = useState<Scope>('all');
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [selected, setSelected] = useState<JournalEntry | null>(null);
  const [attachments, setAttachments] = useState<FileItem[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    if (!spaceId) return;
    setError(false);
    try {
      const rows = await apiFetch<JournalEntry[]>(apiPath('/journal', { spaceId, scope }));
      setEntries(rows);
      setSelected((current) =>
        current ? (rows.find((row) => row.id === current.id) ?? null) : null,
      );
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [scope, spaceId]);

  useEffect(() => {
    void load();
  }, [load, reload]);

  useEffect(() => {
    if (!spaceId || typeof window === 'undefined') return;
    const id = new URLSearchParams(window.location.search).get('entry');
    if (!id) return;
    void apiFetch<JournalEntry>(apiPath(`/journal/${encodeURIComponent(id)}`, { spaceId }))
      .then(setSelected)
      .catch(() => undefined);
  }, [spaceId]);

  useEffect(() => {
    if (!spaceId || !selected || selected.fileIds.length === 0) {
      setAttachments([]);
      return;
    }
    void apiFetch<FileItem[]>(
      apiPath(`/journal/${encodeURIComponent(selected.id)}/attachments`, { spaceId }),
    )
      .then(setAttachments)
      .catch(() => setAttachments([]));
  }, [selected, spaceId]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!spaceId || !draft) return;
    setBusy(true);
    const body = {
      spaceId,
      kind: draft.kind,
      title: draft.title.trim(),
      body: draft.body,
      visibility: draft.visibility,
      mood: draft.mood,
      entryDate: draft.entryDate,
      tags: draft.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      fileIds: draft.fileIds,
    };
    try {
      const saved = draft.id
        ? await apiFetch<JournalEntry>(`/journal/${encodeURIComponent(draft.id)}`, {
            method: 'PATCH',
            body,
          })
        : await apiFetch<JournalEntry>('/journal', { method: 'POST', body });
      setDraft(null);
      setSelected(saved);
      notify(t('common.saved'), 'success');
      await load();
    } catch (cause) {
      notify(describeError(t, cause), 'error');
    } finally {
      setBusy(false);
    }
  };

  const attach = async (files: FileList | null) => {
    if (!spaceId || !files || !draft) return;
    for (const file of Array.from(files)) {
      try {
        // Attachments of a private diary are uploaded as private files.
        const uploaded = await uploadFile({
          spaceId,
          file,
          onConflict: 'rename',
          visibility: draft.visibility === 'private' ? 'private' : 'space',
        });
        setDraft((current) =>
          current ? { ...current, fileIds: [...current.fileIds, uploaded.id] } : current,
        );
      } catch (cause) {
        notify(`${file.name}: ${describeError(t, cause)}`, 'error');
      }
    }
    if (fileInput.current) fileInput.current.value = '';
  };

  const exportMine = async () => {
    if (!spaceId) return;
    try {
      const data = await apiFetch<unknown>(apiPath('/journal/export', { spaceId }));
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `journal-${today()}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      notify(describeError(t, cause), 'error');
    }
  };

  const deleteMine = async () => {
    if (!spaceId) return;
    const answer = window.prompt(t('stageD.journal.deleteAllPrompt'));
    if (answer !== 'DELETE') return;
    try {
      const result = await apiFetch<{ deleted: number }>(
        apiPath('/journal/mine', { spaceId, confirm: 'DELETE' }),
        { method: 'DELETE' },
      );
      notify(t('stageD.journal.deletedCount', { count: result.deleted }), 'success');
      setSelected(null);
      await load();
    } catch (cause) {
      notify(describeError(t, cause), 'error');
    }
  };

  const edit = (entry: JournalEntry) =>
    setDraft({
      id: entry.id,
      kind: entry.kind,
      title: entry.title,
      body: entry.body,
      visibility: entry.visibility,
      mood: entry.mood,
      entryDate: entry.entryDate,
      tags: entry.tags.join(', '),
      fileIds: entry.fileIds,
    });

  return (
    <>
      <PageHeader
        eyebrow={t('stageD.badge')}
        title={t('modules.journal')}
        description={t('stageD.journal.subtitle')}
        action={
          <div className="uf-pill-row">
            {canWrite ? (
              <Button variant="primary" onClick={() => setDraft(emptyDraft())} disabled={!online}>
                <Lucide.PenLine className="h-4 w-4" aria-hidden="true" />
                {t('stageD.journal.new')}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => void exportMine()}>
              <Lucide.FileDown className="h-4 w-4" aria-hidden="true" />
              {t('stageD.journal.export')}
            </Button>
            <Button variant="ghost" onClick={() => void deleteMine()}>
              <Lucide.Trash2 className="h-4 w-4" aria-hidden="true" />
              {t('stageD.journal.deleteAll')}
            </Button>
          </div>
        }
      />
      {!spaceId ? (
        <EmptyState icon="UsersRound" title={t('common.noData')} />
      ) : error ? (
        <ErrorPanel message={t('common.error')} onRetry={refresh} />
      ) : loading ? (
        <div className="uf-skeleton h-96" />
      ) : (
        <div className="uf-split uf-split-aside">
          <aside className="space-y-3">
            <Card className="p-2">
              <div className="uf-pill-row" role="tablist">
                {(['all', 'mine', 'family'] as Scope[]).map((entry) => (
                  <button
                    key={entry}
                    type="button"
                    role="tab"
                    aria-selected={scope === entry}
                    className={`uf-button ${scope === entry ? 'uf-button-primary' : 'uf-button-ghost'} px-3 py-1.5 text-xs`}
                    onClick={() => setScope(entry)}
                  >
                    {t(`stageD.journal.scope.${entry}`)}
                  </button>
                ))}
              </div>
            </Card>
            <Card className="p-2">
              <ul className="space-y-1">
                {entries.length === 0 ? (
                  <li className="p-2 text-sm text-[var(--muted)]">{t('stageD.journal.empty')}</li>
                ) : null}
                {entries.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(entry);
                        setDraft(null);
                      }}
                      aria-current={selected?.id === entry.id ? 'true' : undefined}
                      className={`w-full rounded-xl border p-2.5 text-left text-sm ${
                        selected?.id === entry.id
                          ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                          : 'border-transparent hover:border-[var(--border)]'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        {entry.visibility === 'private' ? (
                          <Lucide.Lock className="h-3.5 w-3.5" aria-label={t('stageD.private')} />
                        ) : (
                          <Lucide.Users
                            className="h-3.5 w-3.5"
                            aria-label={t('stageD.journal.family')}
                          />
                        )}
                        <span className="truncate font-bold">
                          {entry.title || t(`stageD.journal.kind.${entry.kind}`)}
                        </span>
                      </span>
                      <span className="mt-1 block text-[0.7rem] text-[var(--muted)]">
                        {entry.entryDate} · {entry.authorName ?? '—'} ·{' '}
                        {t(`stageD.journal.kind.${entry.kind}`)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          </aside>

          <div>
            {draft ? (
              <Card className="p-5">
                <form onSubmit={save} className="space-y-3">
                  <div className="grid gap-3 md:grid-cols-4">
                    <Field label={t('common.kind')} htmlFor="entry-kind">
                      <select
                        id="entry-kind"
                        className="uf-select"
                        value={draft.kind}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            kind: event.target.value as Draft['kind'],
                            visibility:
                              event.target.value === 'story' ? 'family' : draft.visibility,
                          })
                        }
                      >
                        <option value="diary">{t('stageD.journal.kind.diary')}</option>
                        <option value="story">{t('stageD.journal.kind.story')}</option>
                      </select>
                    </Field>
                    <Field label={t('stageD.journal.visibility')} htmlFor="entry-visibility">
                      <select
                        id="entry-visibility"
                        className="uf-select"
                        value={draft.visibility}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            visibility: event.target.value as Draft['visibility'],
                          })
                        }
                      >
                        <option value="private">{t('stageD.journal.private')}</option>
                        <option value="family">{t('stageD.journal.family')}</option>
                      </select>
                    </Field>
                    <Field label={t('stageD.journal.date')} htmlFor="entry-date">
                      <input
                        id="entry-date"
                        type="date"
                        className="uf-input"
                        value={draft.entryDate}
                        onChange={(event) => setDraft({ ...draft, entryDate: event.target.value })}
                      />
                    </Field>
                    <Field label={t('stageD.journal.mood')} htmlFor="entry-mood">
                      <input
                        id="entry-mood"
                        className="uf-input"
                        maxLength={40}
                        value={draft.mood}
                        onChange={(event) => setDraft({ ...draft, mood: event.target.value })}
                      />
                    </Field>
                  </div>
                  <Field label={t('stageD.journal.title')} htmlFor="entry-title">
                    <input
                      id="entry-title"
                      className="uf-input"
                      maxLength={240}
                      value={draft.title}
                      onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                    />
                  </Field>
                  <Field label={t('stageD.journal.body')} htmlFor="entry-body">
                    <textarea
                      id="entry-body"
                      className="uf-doc-editor"
                      value={draft.body}
                      onChange={(event) => setDraft({ ...draft, body: event.target.value })}
                    />
                  </Field>
                  <Field
                    label={t('stageD.files.tags')}
                    htmlFor="entry-tags"
                    hint={t('stageD.files.tagsHint')}
                  >
                    <input
                      id="entry-tags"
                      className="uf-input"
                      value={draft.tags}
                      onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
                    />
                  </Field>
                  {draft.visibility === 'private' ? (
                    <p className="flex items-center gap-2 text-xs text-[var(--muted)]">
                      <Lucide.ShieldCheck className="h-4 w-4" aria-hidden="true" />
                      {t('stageD.journal.privateHint')}
                    </p>
                  ) : null}
                  <div className="uf-pill-row">
                    {canUploadFiles ? (
                      <>
                        <input
                          ref={fileInput}
                          type="file"
                          multiple
                          accept="image/*,audio/*,video/*,application/pdf"
                          className="sr-only"
                          onChange={(event) => void attach(event.target.files)}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => fileInput.current?.click()}
                        >
                          <Lucide.Paperclip className="h-4 w-4" aria-hidden="true" />
                          {t('stageD.journal.attach')}{' '}
                          {draft.fileIds.length > 0 ? `(${draft.fileIds.length})` : ''}
                        </Button>
                      </>
                    ) : null}
                    <Button type="submit" variant="primary" loading={busy}>
                      {t('common.save')}
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
                      {t('common.cancel')}
                    </Button>
                  </div>
                </form>
              </Card>
            ) : !selected ? (
              <EmptyState
                icon="BookHeart"
                title={t('stageD.journal.pick')}
                description={t('stageD.journal.privacy')}
              />
            ) : (
              <Card className="p-6">
                <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs text-[var(--muted)]">
                      {selected.entryDate} · {selected.authorName ?? '—'}
                      {selected.mood ? ` · ${selected.mood}` : ''}
                    </p>
                    <h2 className="text-2xl font-black">
                      {selected.title || t(`stageD.journal.kind.${selected.kind}`)}
                    </h2>
                    <div className="uf-pill-row mt-2">
                      <Badge tone={selected.visibility === 'private' ? 'warning' : 'success'}>
                        {selected.visibility === 'private'
                          ? t('stageD.journal.private')
                          : t('stageD.journal.family')}
                      </Badge>
                      {selected.tags.map((tag) => (
                        <Badge key={tag}>#{tag}</Badge>
                      ))}
                    </div>
                  </div>
                  {selected.mine ? (
                    <div className="uf-pill-row">
                      <Button onClick={() => edit(selected)}>
                        <Lucide.Pencil className="h-4 w-4" aria-hidden="true" />
                        {t('stageC.messenger.edit')}
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() => {
                          if (!spaceId || !window.confirm(t('stageD.journal.deleteConfirm')))
                            return;
                          void apiFetch(
                            apiPath(`/journal/${encodeURIComponent(selected.id)}`, { spaceId }),
                            {
                              method: 'DELETE',
                            },
                          )
                            .then(() => {
                              setSelected(null);
                              return load();
                            })
                            .catch((cause) => notify(describeError(t, cause), 'error'));
                        }}
                      >
                        <Lucide.Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  ) : null}
                </header>
                <article className="whitespace-pre-wrap leading-7">{selected.body}</article>
                {attachments.length > 0 ? (
                  <section className="mt-5">
                    <h3 className="mb-2 text-sm font-bold">{t('stageD.journal.attachments')}</h3>
                    <ul className="grid gap-3 sm:grid-cols-2">
                      {attachments.map((file) => {
                        const url = `/api/journal/${encodeURIComponent(selected.id)}/attachments/${encodeURIComponent(file.id)}/content?spaceId=${encodeURIComponent(spaceId ?? '')}`;
                        return (
                          <li key={file.id}>
                            <Card soft className="p-2">
                              {file.kind === 'image' ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={url}
                                  alt={file.name}
                                  className="max-h-60 w-full rounded-lg object-contain"
                                />
                              ) : file.kind === 'audio' ? (
                                <audio src={url} controls className="w-full" />
                              ) : file.kind === 'video' ? (
                                <video src={url} controls className="w-full rounded-lg" />
                              ) : null}
                              <a href={url} className="uf-link mt-1 block truncate text-xs">
                                {file.name} · {formatBytes(file.sizeBytes)}
                              </a>
                            </Card>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ) : null}
              </Card>
            )}
          </div>
        </div>
      )}
    </>
  );
}
