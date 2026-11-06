'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ArchiveListing,
  FileActivityEntry,
  FileFolder,
  FileItem,
  FileListing,
  FilePreview,
  FileVersionEntry,
  MediaEngineStatus,
  StorageUsage,
  WebDavToken,
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
  ProgressBar,
} from '@/components/ui';
import { apiFetch, apiPath } from '@/lib/api';
import { FilePreviewView } from '@/components/file-preview';
import { contentUrl, describeError, formatBytes, uploadFile } from '@/lib/uploads';
import { useRealtimeReload } from '@/lib/use-realtime';

type Panel = 'details' | 'versions' | 'activity' | 'trash' | 'sync';

const KIND_ICON: Record<string, string> = {
  image: 'Image',
  video: 'Film',
  audio: 'Music',
  pdf: 'FileText',
  text: 'FileType',
  office: 'FileSpreadsheet',
  archive: 'FileArchive',
  other: 'File',
};

function Icon({ name, className = 'h-4 w-4' }: { name: string; className?: string }) {
  const icons = Lucide as unknown as Record<string, Lucide.LucideIcon>;
  const Component = icons[name] ?? Lucide.File;
  return <Component className={className} aria-hidden="true" />;
}

export default function FilesPage() {
  const { t, notify, online, snapshot } = useApp();
  const spaceId = snapshot?.activeSpace?.id;
  const permissions = useMemo(() => new Set(snapshot?.permissions ?? []), [snapshot?.permissions]);
  const canCreate = permissions.has('files:create');
  const canDelete = permissions.has('files:delete');
  const canManage = permissions.has('files:manage_access');
  const { reload, refresh } = useRealtimeReload(spaceId, ['files']);

  const [folderId, setFolderId] = useState<string | null>(null);
  const [listing, setListing] = useState<FileListing | null>(null);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [selected, setSelected] = useState<FileItem | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [panel, setPanel] = useState<Panel>('details');
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [archive, setArchive] = useState<ArchiveListing | null>(null);
  const [versions, setVersions] = useState<FileVersionEntry[]>([]);
  const [activity, setActivity] = useState<FileActivityEntry[]>([]);
  const [trash, setTrash] = useState<{ folders: FileFolder[]; files: FileItem[] } | null>(null);
  const [tokens, setTokens] = useState<WebDavToken[]>([]);
  const [newToken, setNewToken] = useState<WebDavToken | null>(null);
  const [engines, setEngines] = useState<MediaEngineStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [uploads, setUploads] = useState<
    Array<{ name: string; sent: number; total: number; error?: string }>
  >([]);
  const [rename, setRename] = useState('');
  const [tags, setTags] = useState('');
  const [description, setDescription] = useState('');
  const [tokenName, setTokenName] = useState('');
  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    if (!spaceId) {
      setLoading(false);
      return;
    }
    setError(false);
    try {
      const [rows, used] = await Promise.all([
        apiFetch<FileListing>(apiPath('/files', { spaceId, folderId: folderId ?? undefined })),
        apiFetch<StorageUsage>(apiPath('/files/usage', { spaceId })),
      ]);
      setListing(rows);
      setUsage(used);
      setSelected((current) =>
        current ? (rows.files.find((file) => file.id === current.id) ?? null) : null,
      );
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [folderId, spaceId]);

  useEffect(() => {
    void load();
  }, [load, reload]);

  // Deep link from search: /files?file=<id>
  useEffect(() => {
    if (!spaceId || typeof window === 'undefined') return;
    const fileId = new URLSearchParams(window.location.search).get('file');
    if (!fileId) return;
    void apiFetch<FileItem>(apiPath(`/files/${encodeURIComponent(fileId)}`, { spaceId }))
      .then((file) => {
        setFolderId(file.folderId);
        setSelected(file);
      })
      .catch(() => undefined);
  }, [spaceId]);

  useEffect(() => {
    setPreview(null);
    setArchive(null);
    if (!spaceId || !selected) return;
    setRename(selected.name);
    setTags(selected.tags.join(', '));
    setDescription(selected.description);
    const id = encodeURIComponent(selected.id);
    void apiFetch<FilePreview>(apiPath(`/files/${id}/preview`, { spaceId }))
      .then(setPreview)
      .catch(() => setPreview(null));
    if (selected.kind === 'archive' || selected.mimeType === 'application/zip') {
      void apiFetch<ArchiveListing>(apiPath(`/files/${id}/archive`, { spaceId }))
        .then(setArchive)
        .catch(() => setArchive(null));
    }
    void apiFetch<FileVersionEntry[]>(apiPath(`/files/${id}/versions`, { spaceId }))
      .then(setVersions)
      .catch(() => setVersions([]));
  }, [selected, spaceId]);

  useEffect(() => {
    if (!spaceId) return;
    if (panel === 'activity') {
      void apiFetch<FileActivityEntry[]>(
        apiPath('/files/activity', { spaceId, fileId: selected?.id }),
      ).then(setActivity);
    }
    if (panel === 'trash') {
      void apiFetch<{ folders: FileFolder[]; files: FileItem[] }>(
        apiPath('/files/trash', { spaceId }),
      ).then(setTrash);
    }
    if (panel === 'sync') {
      void apiFetch<WebDavToken[]>(apiPath('/files/webdav/tokens', { spaceId })).then(setTokens);
      void apiFetch<{ engines: MediaEngineStatus }>(apiPath('/files/processing', { spaceId })).then(
        (result) => setEngines(result.engines),
      );
    }
  }, [panel, reload, selected?.id, spaceId]);

  const run = async (action: () => Promise<unknown>, success = t('common.saved')) => {
    try {
      await action();
      notify(success, 'success');
      await load();
    } catch (cause) {
      notify(describeError(t, cause), 'error');
    }
  };

  const startUploads = async (files: FileList | null) => {
    if (!spaceId || !files || files.length === 0) return;
    const list = Array.from(files);
    setUploads(list.map((file) => ({ name: file.name, sent: 0, total: file.size })));
    for (const [index, file] of list.entries()) {
      try {
        await uploadFile({
          spaceId,
          file,
          folderId,
          onProgress: (sent, total) =>
            setUploads((current) =>
              current.map((entry, position) =>
                position === index ? { ...entry, sent, total } : entry,
              ),
            ),
        });
      } catch (cause) {
        const message = describeError(t, cause);
        setUploads((current) =>
          current.map((entry, position) =>
            position === index ? { ...entry, error: message } : entry,
          ),
        );
      }
    }
    if (fileInput.current) fileInput.current.value = '';
    await load();
  };

  const createFolder = (event: React.FormEvent) => {
    event.preventDefault();
    if (!spaceId || !folderName.trim()) return;
    void run(async () => {
      await apiFetch('/files/folders', {
        method: 'POST',
        body: { spaceId, name: folderName.trim(), parentId: folderId },
      });
      setFolderName('');
    });
  };

  const saveDetails = () => {
    if (!spaceId || !selected) return;
    void run(() =>
      apiFetch(`/files/${encodeURIComponent(selected.id)}`, {
        method: 'PATCH',
        body: {
          spaceId,
          name: rename.trim() || selected.name,
          description,
          tags: tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
        },
      }),
    );
  };

  const bulk = (action: 'trash' | 'move', target?: string | null) => {
    if (!spaceId || checked.size === 0) return;
    void run(async () => {
      await apiFetch('/files/bulk', {
        method: 'POST',
        body: { spaceId, action, fileIds: [...checked], folderId: target ?? null },
      });
      setChecked(new Set());
    });
  };

  const percent =
    usage && usage.quotaBytes > 0 ? Math.min(100, (usage.usedBytes / usage.quotaBytes) * 100) : 0;

  return (
    <>
      <PageHeader
        eyebrow={t('stageD.badge')}
        title={t('modules.files')}
        description={t('stageD.files.subtitle')}
        action={
          usage ? (
            <Card className="w-full max-w-xs p-4">
              <p className="mb-1 text-xs font-bold uppercase tracking-wider text-[var(--muted)]">
                {t('stageD.files.usage')}
              </p>
              <ProgressBar value={percent} />
              <p className="mt-2 text-xs text-[var(--muted)]">
                {formatBytes(usage.usedBytes)} / {formatBytes(usage.quotaBytes)} ·{' '}
                {t('stageD.files.mine')}: {formatBytes(usage.userUsedBytes)}
              </p>
              {usage.disk.lowSpace ? (
                <p className="mt-1 text-xs font-bold text-rose-600">{t('stageD.files.lowDisk')}</p>
              ) : null}
            </Card>
          ) : null
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
      ) : loading || !listing ? (
        <div className="uf-skeleton h-96" />
      ) : (
        <div className="uf-split uf-split-main">
          <div className="space-y-4">
            <Card className="p-4">
              <nav
                aria-label={t('stageD.files.path')}
                className="mb-3 flex flex-wrap items-center gap-1 text-sm"
              >
                {listing.breadcrumbs.map((crumb, index) => (
                  <span key={crumb.id ?? 'root'} className="flex items-center gap-1">
                    {index > 0 ? (
                      <Lucide.ChevronRight className="h-3.5 w-3.5 text-[var(--muted)]" />
                    ) : null}
                    <button
                      type="button"
                      className="uf-link font-semibold"
                      onClick={() => {
                        setFolderId(crumb.id);
                        setSelected(null);
                      }}
                    >
                      {crumb.id ? crumb.name : t('stageD.files.root')}
                    </button>
                  </span>
                ))}
              </nav>
              <div className="flex flex-wrap items-end gap-2">
                {canCreate ? (
                  <>
                    <input
                      ref={fileInput}
                      type="file"
                      multiple
                      className="sr-only"
                      id="file-upload"
                      onChange={(event) => void startUploads(event.target.files)}
                    />
                    <Button
                      variant="primary"
                      onClick={() => fileInput.current?.click()}
                      disabled={!online}
                    >
                      <Lucide.Upload className="h-4 w-4" aria-hidden="true" />
                      {t('stageD.files.upload')}
                    </Button>
                    <form onSubmit={createFolder} className="flex items-end gap-2">
                      <Field label={t('stageD.files.newFolder')} htmlFor="folder-name">
                        <input
                          id="folder-name"
                          className="uf-input"
                          value={folderName}
                          maxLength={240}
                          onChange={(event) => setFolderName(event.target.value)}
                        />
                      </Field>
                      <Button type="submit" disabled={!folderName.trim()}>
                        <Lucide.FolderPlus className="h-4 w-4" aria-hidden="true" />
                        {t('common.create')}
                      </Button>
                    </form>
                  </>
                ) : (
                  <Badge>{t('common.readOnly')}</Badge>
                )}
                {checked.size > 0 ? (
                  <div className="uf-pill-row ml-auto">
                    <Badge tone="accent">
                      {t('stageD.files.selected', { count: checked.size })}
                    </Badge>
                    <Button variant="ghost" onClick={() => bulk('move', folderId)}>
                      <Lucide.FolderInput className="h-4 w-4" aria-hidden="true" />
                      {t('stageD.files.moveHere')}
                    </Button>
                    <Button variant="danger" onClick={() => bulk('trash')}>
                      <Lucide.Trash2 className="h-4 w-4" aria-hidden="true" />
                      {t('stageD.files.toTrash')}
                    </Button>
                  </div>
                ) : null}
              </div>
              {uploads.length > 0 ? (
                <ul className="mt-3 space-y-2" aria-live="polite">
                  {uploads.map((entry) => (
                    <li key={entry.name} className="text-xs">
                      <span className="flex justify-between gap-2">
                        <span className="truncate font-semibold">{entry.name}</span>
                        <span className={entry.error ? 'text-rose-600' : 'text-[var(--muted)]'}>
                          {entry.error ??
                            `${formatBytes(entry.sent)} / ${formatBytes(entry.total)}`}
                        </span>
                      </span>
                      <ProgressBar value={entry.total ? (entry.sent / entry.total) * 100 : 100} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>

            <Card className="overflow-hidden">
              {listing.folders.length === 0 && listing.files.length === 0 ? (
                <div className="p-8 text-center text-sm text-[var(--muted)]">
                  {t('stageD.files.empty')}
                </div>
              ) : (
                <table className="uf-table w-full text-sm">
                  <thead>
                    <tr>
                      <th className="w-8">
                        <span className="sr-only">{t('stageD.files.select')}</span>
                      </th>
                      <th className="text-left">{t('common.name')}</th>
                      <th className="hidden text-left md:table-cell">{t('stageD.files.size')}</th>
                      <th className="hidden text-left md:table-cell">
                        {t('stageD.files.updated')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {listing.folders.map((folder) => (
                      <tr key={folder.id}>
                        <td />
                        <td>
                          <span className="flex items-center gap-2">
                            <button
                              type="button"
                              className="flex items-center gap-2 font-semibold"
                              onClick={() => {
                                setFolderId(folder.id);
                                setSelected(null);
                              }}
                            >
                              <Lucide.Folder
                                className="h-4 w-4 text-[var(--accent)]"
                                aria-hidden="true"
                              />
                              {folder.name}
                            </button>
                            {canCreate ? (
                              <button
                                type="button"
                                className="ml-auto text-[var(--muted)] hover:text-rose-600"
                                aria-label={`${t('stageD.files.toTrash')}: ${folder.name}`}
                                onClick={() =>
                                  void run(() =>
                                    apiFetch(
                                      apiPath(`/files/folders/${encodeURIComponent(folder.id)}`, {
                                        spaceId,
                                      }),
                                      {
                                        method: 'DELETE',
                                      },
                                    ),
                                  )
                                }
                              >
                                <Lucide.Trash2 className="h-4 w-4" />
                              </button>
                            ) : null}
                          </span>
                        </td>
                        <td className="hidden md:table-cell">—</td>
                        <td className="hidden md:table-cell">
                          {new Date(folder.updatedAt).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                    {listing.files.map((file) => (
                      <tr
                        key={file.id}
                        className={selected?.id === file.id ? 'bg-[var(--accent-soft)]' : undefined}
                      >
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`${t('stageD.files.select')}: ${file.name}`}
                            checked={checked.has(file.id)}
                            onChange={(event) =>
                              setChecked((current) => {
                                const next = new Set(current);
                                if (event.target.checked) next.add(file.id);
                                else next.delete(file.id);
                                return next;
                              })
                            }
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 text-left"
                            onClick={() => {
                              setSelected(file);
                              setPanel('details');
                            }}
                          >
                            <Icon name={KIND_ICON[file.kind] ?? 'File'} />
                            <span className="truncate font-semibold">{file.name}</span>
                            {file.visibility === 'private' ? (
                              <Lucide.Lock
                                className="h-3.5 w-3.5 text-[var(--muted)]"
                                aria-label={t('stageD.private')}
                              />
                            ) : null}
                            {file.version > 1 ? <Badge>v{file.version}</Badge> : null}
                            {file.scanStatus === 'blocked' ? (
                              <Badge tone="danger">{t('stageD.files.blocked')}</Badge>
                            ) : null}
                          </button>
                        </td>
                        <td className="hidden md:table-cell">{formatBytes(file.sizeBytes)}</td>
                        <td className="hidden md:table-cell">
                          {new Date(file.updatedAt).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>

          <aside className="space-y-4">
            <Card className="p-2">
              <div className="uf-pill-row" role="tablist">
                {(['details', 'versions', 'activity', 'trash', 'sync'] as Panel[]).map((entry) => (
                  <button
                    key={entry}
                    type="button"
                    role="tab"
                    aria-selected={panel === entry}
                    className={`uf-button ${panel === entry ? 'uf-button-primary' : 'uf-button-ghost'} px-3 py-1.5 text-xs`}
                    onClick={() => setPanel(entry)}
                  >
                    {t(`stageD.files.panel.${entry}`)}
                  </button>
                ))}
              </div>
            </Card>

            {panel === 'details' ? (
              !selected ? (
                <EmptyState icon="MousePointerClick" title={t('stageD.files.pick')} />
              ) : (
                <Card className="space-y-3 p-4">
                  <h2 className="break-words text-lg font-bold">{selected.name}</h2>
                  <div className="uf-pill-row text-xs">
                    <Badge>{t(`stageD.kind.${selected.kind}`)}</Badge>
                    <Badge>{formatBytes(selected.sizeBytes)}</Badge>
                    <Badge
                      tone={
                        selected.scanStatus === 'clean'
                          ? 'success'
                          : selected.scanStatus === 'blocked'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {t(`stageD.scan.${selected.scanStatus}`)}
                    </Badge>
                    {selected.ocrStatus !== 'none' ? (
                      <Badge>{t(`stageD.ocr.${selected.ocrStatus}`)}</Badge>
                    ) : null}
                  </div>
                  <FilePreviewView preview={preview} name={selected.name} />
                  {archive ? <ArchiveView archive={archive} /> : null}
                  <div className="uf-pill-row">
                    <a className="uf-button" href={contentUrl(spaceId!, selected.id, true)}>
                      <Lucide.Download className="h-4 w-4" aria-hidden="true" />
                      {t('stageD.files.download')}
                    </a>
                    <Button
                      variant="danger"
                      onClick={() =>
                        void run(async () => {
                          await apiFetch(
                            apiPath(`/files/${encodeURIComponent(selected.id)}`, { spaceId }),
                            {
                              method: 'DELETE',
                            },
                          );
                          setSelected(null);
                        })
                      }
                    >
                      <Lucide.Trash2 className="h-4 w-4" aria-hidden="true" />
                      {t('stageD.files.toTrash')}
                    </Button>
                  </div>
                  <Field label={t('common.name')} htmlFor="file-name">
                    <input
                      id="file-name"
                      className="uf-input"
                      value={rename}
                      onChange={(e) => setRename(e.target.value)}
                    />
                  </Field>
                  <Field
                    label={t('stageD.files.tags')}
                    htmlFor="file-tags"
                    hint={t('stageD.files.tagsHint')}
                  >
                    <input
                      id="file-tags"
                      className="uf-input"
                      value={tags}
                      onChange={(e) => setTags(e.target.value)}
                    />
                  </Field>
                  <Field label={t('stageD.files.description')} htmlFor="file-description">
                    <textarea
                      id="file-description"
                      className="uf-textarea"
                      rows={3}
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                    />
                  </Field>
                  <Button variant="primary" onClick={saveDetails}>
                    {t('common.save')}
                  </Button>
                </Card>
              )
            ) : null}

            {panel === 'versions' ? (
              <Card className="p-4">
                {!selected ? (
                  <p className="text-sm text-[var(--muted)]">{t('stageD.files.pick')}</p>
                ) : (
                  <ul className="space-y-2 text-sm">
                    {versions.map((version) => (
                      <li key={version.id} className="flex items-center justify-between gap-2">
                        <span>
                          <strong>v{version.version}</strong> · {formatBytes(version.sizeBytes)} ·{' '}
                          {new Date(version.createdAt).toLocaleString()}
                          <span className="block text-xs text-[var(--muted)]">
                            {version.createdByName ?? '—'} · {version.note}
                          </span>
                        </span>
                        <span className="flex gap-1">
                          <a
                            className="uf-button uf-button-ghost px-2 py-1 text-xs"
                            href={`${contentUrl(spaceId!, selected.id, true)}&version=${version.version}`}
                          >
                            <Lucide.Download
                              className="h-3.5 w-3.5"
                              aria-label={t('stageD.files.download')}
                            />
                          </a>
                          {version.version !== selected.version ? (
                            <Button
                              variant="ghost"
                              className="px-2 py-1 text-xs"
                              onClick={() =>
                                void run(() =>
                                  apiFetch(
                                    `/files/${encodeURIComponent(selected.id)}/versions/restore`,
                                    {
                                      method: 'POST',
                                      body: { spaceId, version: version.version },
                                    },
                                  ),
                                )
                              }
                            >
                              {t('stageD.files.restoreVersion')}
                            </Button>
                          ) : (
                            <Badge tone="success">{t('stageD.files.current')}</Badge>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            ) : null}

            {panel === 'activity' ? (
              <Card className="p-4">
                <ul className="space-y-2 text-sm">
                  {activity.length === 0 ? (
                    <li className="text-[var(--muted)]">{t('common.noData')}</li>
                  ) : null}
                  {activity.map((entry) => (
                    <li key={entry.id}>
                      <strong>{t(`stageD.activity.${entry.action}`)}</strong>
                      <span className="block text-xs text-[var(--muted)]">
                        {entry.userName ?? '—'} · {new Date(entry.createdAt).toLocaleString()}
                        {typeof entry.detail.name === 'string' ? ` · ${entry.detail.name}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}

            {panel === 'trash' ? (
              <Card className="space-y-3 p-4">
                <p className="text-xs text-[var(--muted)]">
                  {t('stageD.files.trashHint', { days: usage?.trashRetentionDays ?? 30 })}
                </p>
                {trash && trash.files.length === 0 && trash.folders.length === 0 ? (
                  <p className="text-sm text-[var(--muted)]">{t('stageD.files.trashEmpty')}</p>
                ) : null}
                <ul className="space-y-2 text-sm">
                  {[
                    ...(trash?.folders ?? []).map((folder) => ({
                      id: folder.id,
                      name: folder.name,
                      folder: true,
                    })),
                    ...(trash?.files ?? []).map((file) => ({
                      id: file.id,
                      name: file.name,
                      folder: false,
                    })),
                  ].map((entry) => (
                    <li key={entry.id} className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2 truncate">
                        {entry.folder ? (
                          <Lucide.Folder className="h-4 w-4" />
                        ) : (
                          <Lucide.File className="h-4 w-4" />
                        )}
                        {entry.name}
                      </span>
                      <span className="flex gap-1">
                        <Button
                          variant="ghost"
                          className="px-2 py-1 text-xs"
                          onClick={() =>
                            void run(() =>
                              apiFetch('/files/trash/restore', {
                                method: 'POST',
                                body: entry.folder
                                  ? { spaceId, folderId: entry.id }
                                  : { spaceId, fileId: entry.id },
                              }),
                            ).then(() => setPanel('trash'))
                          }
                        >
                          {t('stageD.files.restore')}
                        </Button>
                        {canDelete && !entry.folder ? (
                          <Button
                            variant="danger"
                            className="px-2 py-1 text-xs"
                            onClick={() =>
                              void run(() =>
                                apiFetch(
                                  apiPath(`/files/${encodeURIComponent(entry.id)}/purge`, {
                                    spaceId,
                                  }),
                                  {
                                    method: 'DELETE',
                                  },
                                ),
                              )
                            }
                          >
                            {t('stageD.files.purge')}
                          </Button>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
                {canDelete ? (
                  <Button
                    variant="danger"
                    onClick={() => {
                      if (window.confirm(t('stageD.files.emptyTrashConfirm'))) {
                        void run(() =>
                          apiFetch(apiPath('/files/trash', { spaceId }), { method: 'DELETE' }),
                        );
                      }
                    }}
                  >
                    {t('stageD.files.emptyTrash')}
                  </Button>
                ) : null}
              </Card>
            ) : null}

            {panel === 'sync' ? (
              <Card className="space-y-3 p-4">
                <h2 className="text-sm font-bold">WebDAV</h2>
                <p className="text-xs text-[var(--muted)]">{t('stageD.files.webdavHint')}</p>
                <code className="uf-mono block break-all rounded-lg bg-[var(--surface-soft)] p-2 text-xs">
                  {typeof window !== 'undefined' ? window.location.origin : ''}/api/webdav/{spaceId}
                  /
                </code>
                {newToken?.token ? (
                  <div className="rounded-xl border border-amber-300 p-3 text-xs">
                    <p className="font-bold">{t('stageD.files.tokenOnce')}</p>
                    <code className="uf-mono break-all">{newToken.token}</code>
                  </div>
                ) : null}
                <form
                  className="flex items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!tokenName.trim()) return;
                    void apiFetch<WebDavToken>('/files/webdav/tokens', {
                      method: 'POST',
                      body: { spaceId, name: tokenName.trim(), readOnly: false },
                    })
                      .then((token) => {
                        setNewToken(token);
                        setTokenName('');
                        return apiFetch<WebDavToken[]>(
                          apiPath('/files/webdav/tokens', { spaceId }),
                        );
                      })
                      .then(setTokens)
                      .catch((cause) => notify(describeError(t, cause), 'error'));
                  }}
                >
                  <Field label={t('stageD.files.device')} htmlFor="token-name">
                    <input
                      id="token-name"
                      className="uf-input"
                      value={tokenName}
                      onChange={(e) => setTokenName(e.target.value)}
                    />
                  </Field>
                  <Button type="submit">{t('common.create')}</Button>
                </form>
                <ul className="space-y-1 text-sm">
                  {tokens.map((token) => (
                    <li key={token.id} className="flex items-center justify-between gap-2">
                      <span>
                        {token.name}
                        <span className="block text-xs text-[var(--muted)]">
                          {token.lastUsedAt
                            ? new Date(token.lastUsedAt).toLocaleString()
                            : t('stageD.files.neverUsed')}
                        </span>
                      </span>
                      {token.revokedAt ? (
                        <Badge>{t('stageD.revoked')}</Badge>
                      ) : (
                        <Button
                          variant="ghost"
                          className="px-2 py-1 text-xs"
                          onClick={() =>
                            void apiFetch(
                              apiPath(`/files/webdav/tokens/${encodeURIComponent(token.id)}`, {
                                spaceId,
                              }),
                              {
                                method: 'DELETE',
                              },
                            )
                              .then(() =>
                                apiFetch<WebDavToken[]>(
                                  apiPath('/files/webdav/tokens', { spaceId }),
                                ),
                              )
                              .then(setTokens)
                          }
                        >
                          {t('stageD.revoke')}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
                {engines ? (
                  <div className="border-t border-[var(--border)] pt-3 text-xs">
                    <h3 className="mb-2 font-bold">{t('stageD.files.processing')}</h3>
                    <ul className="space-y-1">
                      {(['antivirus', 'ocr', 'video', 'faces'] as const).map((engine) => (
                        <li key={engine} className="flex justify-between">
                          <span>{t(`stageD.engine.${engine}`)}</span>
                          <Badge tone={engines[engine].available ? 'success' : 'warning'}>
                            {engines[engine].available
                              ? engines[engine].engine
                              : t('stageD.engine.off')}
                          </Badge>
                        </li>
                      ))}
                      <li className="text-[var(--muted)]">
                        {t('stageD.engine.queue', {
                          queued: engines.queue.queued,
                          failed: engines.queue.failed,
                        })}
                      </li>
                    </ul>
                    {canManage ? (
                      <p className="mt-2 text-[var(--muted)]">{t('stageD.engine.hint')}</p>
                    ) : null}
                  </div>
                ) : null}
              </Card>
            ) : null}
          </aside>
        </div>
      )}
    </>
  );
}

function ArchiveView({ archive }: { archive: ArchiveListing }) {
  const { t } = useApp();
  return (
    <div className="space-y-2 text-xs">
      <p className="font-bold">
        {t('stageD.files.archive')} · {archive.entries.length} ·{' '}
        {formatBytes(archive.totalUncompressedBytes)}
      </p>
      <p className="text-[var(--muted)]">{t('stageD.files.archiveHint')}</p>
      {archive.warnings.length > 0 ? (
        <div className="uf-pill-row">
          {archive.warnings.map((warning) => (
            <Badge key={warning} tone="danger">
              {t(`stageD.archive.${warning}`)}
            </Badge>
          ))}
        </div>
      ) : null}
      <ul className="uf-mono max-h-48 overflow-auto rounded-lg border border-[var(--border)] p-2">
        {archive.entries.map((entry) => (
          <li key={entry.name} className={entry.flags.length > 0 ? 'text-rose-600' : undefined}>
            {entry.directory ? '📁 ' : ''}
            {entry.name} {entry.directory ? '' : `· ${formatBytes(entry.sizeBytes)}`}
          </li>
        ))}
      </ul>
    </div>
  );
}
