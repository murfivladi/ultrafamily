'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DocumentComment,
  DocumentDetail,
  DocumentVersion,
  DocumentSummary,
} from '@ufos/contracts';
import * as Lucide from 'lucide-react';
import { useApp } from '@/components/app-provider';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorPanel,
  Field,
  PageHeader,
} from '@/components/ui';
import { apiFetch, apiPath } from '@/lib/api';
import { useCollaborativeDocument } from '@/lib/collaboration';
import { useRealtimeReload } from '@/lib/use-realtime';

const TEMPLATES = ['blank', 'minutes', 'checklist', 'table', 'presentation'] as const;

export default function DocumentsPage() {
  const { t, notify, online } = useApp();
  const spaceId = useApp().snapshot?.activeSpace?.id;
  const { reload, refresh } = useRealtimeReload(spaceId, ['documents']);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [comments, setComments] = useState<DocumentComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [template, setTemplate] = useState<(typeof TEMPLATES)[number]>('blank');
  const [kind, setKind] = useState<'note' | 'document' | 'table' | 'presentation'>('note');
  const [commentDraft, setCommentDraft] = useState('');
  const [showVersions, setShowVersions] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  const canEdit = detail?.myPermission === 'edit';
  const canComment = detail?.myPermission === 'edit' || detail?.myPermission === 'comment';
  const collab = useCollaborativeDocument(spaceId, selectedId || null, {
    canEdit: Boolean(canEdit),
    onRemoteChange: () => refresh(),
  });

  const loadDocuments = useCallback(async () => {
    if (!spaceId) {
      setLoading(false);
      return;
    }
    setError(false);
    try {
      const rows = await apiFetch<DocumentSummary[]>(apiPath('/documents', { spaceId }));
      setDocuments(rows);
      setSelectedId((current) => current || rows[0]?.id || '');
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  const loadDetail = useCallback(async () => {
    if (!spaceId || !selectedId) {
      setDetail(null);
      return;
    }
    try {
      const [document, versionRows, commentRows] = await Promise.all([
        apiFetch<DocumentDetail>(
          apiPath(`/documents/${encodeURIComponent(selectedId)}`, { spaceId }),
        ),
        apiFetch<DocumentVersion[]>(
          apiPath(`/documents/${encodeURIComponent(selectedId)}/versions`, { spaceId }),
        ),
        apiFetch<DocumentComment[]>(
          apiPath(`/documents/${encodeURIComponent(selectedId)}/comments`, { spaceId }),
        ),
      ]);
      setDetail(document);
      setVersions(versionRows);
      setComments(commentRows);
    } catch {
      notify(t('common.error'), 'error');
    }
  }, [notify, selectedId, spaceId, t]);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments, reload]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail, reload]);

  const remoteEditors = useMemo(
    () => Object.values(collab.remoteCursors).filter((cursor) => cursor.editing),
    [collab.remoteCursors],
  );

  // The server text is the starting point; once Yjs is synced the collaborative
  // text wins, so two tabs never disagree about the document body.
  const editorValue = collab.synced ? collab.text : (detail?.content ?? '');

  const createDocument = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!spaceId || !title.trim()) return;
    setBusy(true);
    try {
      const created = await apiFetch<DocumentSummary>('/documents', {
        method: 'POST',
        body: { spaceId, title: title.trim(), template, kind },
      });
      setTitle('');
      await loadDocuments();
      setSelectedId(created.id);
    } catch {
      notify(t('common.error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveContent = async () => {
    if (!spaceId || !detail) return;
    if (!online) {
      notify(t('error.offlineSave'), 'error');
      return;
    }
    setBusy(true);
    try {
      await apiFetch(`/documents/${encodeURIComponent(detail.id)}/content`, {
        method: 'POST',
        body: { spaceId, content: editorValue, expectedVersion: detail.version },
      });
      notify(t('stageC.documents.saved'), 'success');
      await loadDetail();
    } catch {
      notify(t('common.error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const addComment = async () => {
    if (!spaceId || !detail || !commentDraft.trim()) return;
    try {
      await apiFetch(`/documents/${encodeURIComponent(detail.id)}/comments`, {
        method: 'POST',
        body: { spaceId, body: commentDraft.trim(), anchor: null },
      });
      setCommentDraft('');
      await loadDetail();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const resolveComment = async (comment: DocumentComment) => {
    if (!spaceId || !detail) return;
    try {
      await apiFetch(
        `/documents/${encodeURIComponent(detail.id)}/comments/${encodeURIComponent(comment.id)}/resolve`,
        { method: 'POST', body: { spaceId, resolved: !comment.resolvedAt } },
      );
      await loadDetail();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const restoreVersion = async (version: DocumentVersion) => {
    if (!spaceId || !detail) return;
    try {
      await apiFetch(`/documents/${encodeURIComponent(detail.id)}/restore`, {
        method: 'POST',
        body: { spaceId, version: version.version },
      });
      collab.replaceAll(version.content);
      await loadDetail();
      notify(t('common.saved'), 'success');
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const connectionTone =
    collab.status === 'connected' ? 'success' : collab.status === 'offline' ? 'danger' : 'warning';

  return (
    <>
      <PageHeader
        eyebrow={t('stageC.badge')}
        title={t('modules.documents')}
        description={t('stageC.documents.subtitle')}
        action={
          <div className="uf-pill-row">
            <Badge tone={connectionTone}>
              <Lucide.Radio className="h-3.5 w-3.5" aria-hidden="true" />
              {collab.status === 'connected'
                ? t('stageC.calls.connected')
                : t('stageC.calls.reconnecting')}
            </Badge>
            {detail ? (
              <Badge tone="accent">
                v{detail.version}
                {collab.synced ? ' · Yjs' : ''}
              </Badge>
            ) : null}
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
        <div className="uf-skeleton h-96" />
      ) : (
        <div className="uf-split uf-split-aside">
          <aside className="space-y-4">
            <Card className="p-4">
              <h2 className="mb-3 text-sm font-bold">{t('stageC.documents.new')}</h2>
              <form onSubmit={createDocument} className="space-y-3">
                <Field label={t('stageC.documents.title')} htmlFor="document-title">
                  <input
                    id="document-title"
                    className="uf-input"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    maxLength={240}
                    required
                  />
                </Field>
                <Field label={t('common.kind')} htmlFor="document-kind">
                  <select
                    id="document-kind"
                    className="uf-select"
                    value={kind}
                    onChange={(event) => setKind(event.target.value as typeof kind)}
                  >
                    {(['note', 'document', 'table', 'presentation'] as const).map((entry) => (
                      <option key={entry} value={entry}>
                        {t(`stageC.documents.kind.${entry}`)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('stageC.documents.template.blank')} htmlFor="document-template">
                  <select
                    id="document-template"
                    className="uf-select"
                    value={template}
                    onChange={(event) => setTemplate(event.target.value as typeof template)}
                  >
                    {TEMPLATES.map((entry) => (
                      <option key={entry} value={entry}>
                        {t(`stageC.documents.template.${entry}`)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Button type="submit" variant="primary" loading={busy} disabled={!online}>
                  <Lucide.FilePlus className="h-4 w-4" aria-hidden="true" />
                  {t('common.create')}
                </Button>
              </form>
            </Card>

            <Card className="p-4">
              <h2 className="mb-2 text-sm font-bold">{t('common.all')}</h2>
              <ul className="space-y-1">
                {documents.length === 0 ? (
                  <li className="p-2 text-sm text-[var(--muted)]">
                    {t('stageC.documents.noDocuments')}
                  </li>
                ) : null}
                {documents.map((document) => (
                  <li key={document.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(document.id)}
                      aria-current={document.id === selectedId ? 'true' : undefined}
                      className={`w-full rounded-xl border p-2.5 text-left text-sm transition ${
                        document.id === selectedId
                          ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                          : 'border-transparent hover:border-[var(--border)]'
                      }`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate font-bold">
                          {document.title || t('stageC.messenger.deleted')}
                        </span>
                        {document.openCommentCount > 0 ? (
                          <Badge tone="warning">{document.openCommentCount}</Badge>
                        ) : null}
                      </span>
                      <span className="mt-1 block text-[0.68rem] text-[var(--muted)]">
                        {t(`stageC.documents.kind.${document.kind}`)} · v{document.version} ·{' '}
                        {new Date(document.updatedAt).toLocaleDateString()}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          </aside>

          <div className="space-y-5">
            {!detail ? (
              <EmptyState icon="FileText" title={t('stageC.documents.noDocuments')} />
            ) : (
              <>
                <Card className="p-5">
                  <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-xl font-bold">{detail.title}</h2>
                      <p className="text-xs text-[var(--muted)]">
                        {detail.createdByName} · {t(`stageC.documents.kind.${detail.kind}`)} ·{' '}
                        {detail.myPermission
                          ? t(`stageC.documents.permission.${detail.myPermission}`)
                          : t('common.readOnly')}
                      </p>
                    </div>
                    <div className="uf-pill-row">
                      <Button onClick={() => setShowVersions((value) => !value)}>
                        <Lucide.History className="h-4 w-4" aria-hidden="true" />
                        {t('stageC.documents.versions')}
                      </Button>
                      <Button
                        variant="primary"
                        onClick={() => void saveContent()}
                        loading={busy}
                        disabled={!canEdit || !online}
                      >
                        <Lucide.Save className="h-4 w-4" aria-hidden="true" />
                        {t('stageC.documents.save')}
                      </Button>
                    </div>
                  </header>

                  <div className="uf-pill-row mb-3 text-xs text-[var(--muted)]">
                    <span>
                      {t('stageC.documents.online')}:{' '}
                      {detail.presence.map((entry) => entry.displayName).join(', ') || '—'}
                    </span>
                    {remoteEditors.length > 0 ? (
                      <Badge tone="accent">
                        <Lucide.PenLine className="h-3 w-3" aria-hidden="true" />
                        {remoteEditors.map((cursor) => cursor.displayName).join(', ')}{' '}
                        {t('stageC.documents.editing')}
                      </Badge>
                    ) : null}
                  </div>

                  {collab.rejected ? (
                    <p className="mb-2 rounded-xl bg-[var(--warning-soft,#fef3c7)] p-3 text-sm">
                      {collab.rejected}
                    </p>
                  ) : null}
                  {collab.status !== 'connected' ? (
                    <p className="mb-2 rounded-xl border border-[var(--border)] p-3 text-xs text-[var(--muted)]">
                      {t('stageC.documents.offline')}
                    </p>
                  ) : null}

                  <label className="block">
                    <span className="uf-label">{t('stageC.documents.content')}</span>
                    <textarea
                      ref={editorRef}
                      className="uf-doc-editor"
                      value={editorValue}
                      readOnly={!canEdit}
                      spellCheck={canEdit}
                      onChange={(event) => {
                        if (!canEdit) return;
                        collab.replaceAll(event.target.value);
                        collab.reportCursor(
                          event.target.selectionStart,
                          event.target.selectionEnd,
                          true,
                        );
                      }}
                      onSelect={(event) => {
                        const target = event.currentTarget;
                        collab.reportCursor(target.selectionStart, target.selectionEnd, false);
                      }}
                      aria-label={t('stageC.documents.content')}
                    />
                  </label>
                  <p className="mt-2 text-[0.68rem] text-[var(--muted)]">
                    {t('stageC.messenger.clientKey')} · Yjs · v{detail.version}
                  </p>
                </Card>

                {showVersions ? (
                  <Card className="p-5">
                    <h3 className="mb-3 text-lg font-bold">{t('stageC.documents.versions')}</h3>
                    <ul className="space-y-2">
                      {versions.map((version) => (
                        <li
                          key={version.id}
                          className="uf-card-soft flex flex-wrap items-center justify-between gap-2 p-3"
                        >
                          <div>
                            <p className="text-sm font-bold">
                              v{version.version} · {version.createdByName || '—'}
                            </p>
                            <p className="text-xs text-[var(--muted)]">
                              {new Date(version.createdAt).toLocaleString()} · {version.note}
                            </p>
                          </div>
                          <Button onClick={() => void restoreVersion(version)} disabled={!canEdit}>
                            <Lucide.RotateCcw className="h-4 w-4" aria-hidden="true" />
                            {t('stageC.documents.restore')}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </Card>
                ) : null}

                <Card className="p-5">
                  <h3 className="mb-3 text-lg font-bold">{t('stageC.documents.comments')}</h3>
                  <ul className="space-y-2">
                    {comments.map((comment) => (
                      <li key={comment.id} className="uf-card-soft p-3">
                        <div className="flex items-start gap-2">
                          <Avatar
                            name={comment.authorName || '—'}
                            color={comment.authorAvatarColor}
                            size="sm"
                          />
                          <div className="flex-1">
                            <p className="text-sm">
                              <span className="font-bold">{comment.authorName || '—'}: </span>
                              {comment.body}
                            </p>
                            {comment.anchor?.quote ? (
                              <p className="mt-1 text-xs italic text-[var(--muted)]">
                                «{comment.anchor.quote}»
                              </p>
                            ) : null}
                            <div className="mt-2 flex items-center gap-2">
                              <Button
                                onClick={() => void resolveComment(comment)}
                                disabled={!canComment}
                              >
                                {comment.resolvedAt
                                  ? t('stageC.documents.resolved')
                                  : t('stageC.documents.resolve')}
                              </Button>
                              {comment.resolvedAt ? (
                                <Badge tone="success">{t('stageC.documents.resolved')}</Badge>
                              ) : (
                                <Badge tone="warning">{t('stageC.feed.comments')}</Badge>
                              )}
                            </div>
                          </div>
                        </div>
                      </li>
                    ))}
                    {comments.length === 0 ? (
                      <li className="text-sm text-[var(--muted)]">{t('common.noData')}</li>
                    ) : null}
                  </ul>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <label className="min-w-48 flex-1">
                      <span className="sr-only">{t('stageC.documents.addComment')}</span>
                      <input
                        className="uf-input"
                        placeholder={t('stageC.documents.addComment')}
                        value={commentDraft}
                        onChange={(event) => setCommentDraft(event.target.value)}
                        maxLength={4000}
                      />
                    </label>
                    <Button onClick={() => void addComment()} disabled={!canComment || !online}>
                      <Lucide.MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
                      {t('stageC.documents.addComment')}
                    </Button>
                  </div>
                </Card>

                <Card className="p-5">
                  <h3 className="mb-3 text-lg font-bold">{t('stageC.documents.collaborators')}</h3>
                  <ul className="space-y-2">
                    {detail.collaborators.map((collaborator) => (
                      <li
                        key={collaborator.userId}
                        className="flex items-center justify-between gap-2 text-sm"
                      >
                        <span className="flex items-center gap-2">
                          <Avatar
                            name={collaborator.displayName}
                            color={collaborator.avatarColor}
                            size="sm"
                          />
                          {collaborator.displayName}
                        </span>
                        <Badge>{t(`stageC.documents.permission.${collaborator.permission}`)}</Badge>
                      </li>
                    ))}
                  </ul>
                </Card>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
