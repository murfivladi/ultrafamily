'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DuplicateGroup,
  FaceRecognitionStatus,
  MediaComment,
  MediaItem,
  PhotoAlbum,
  ShareLink,
  TimelineBucket,
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
import { contentUrl, describeError, uploadFile } from '@/lib/uploads';
import { useRealtimeReload } from '@/lib/use-realtime';

type View = 'all' | 'favorites' | 'albums' | 'timeline' | 'duplicates' | 'privacy';
const EMOJI = ['❤️', '😂', '😮', '👍'];

interface Member {
  userId: string;
  displayName: string;
  isChild: boolean;
}

export default function PhotosPage() {
  const { t, notify, online, snapshot } = useApp();
  const spaceId = snapshot?.activeSpace?.id;
  const permissions = useMemo(() => new Set(snapshot?.permissions ?? []), [snapshot?.permissions]);
  const canCreate = permissions.has('photos:create');
  const canPublish = permissions.has('photos:publish');
  const isGuardian = permissions.has('photos:manage_access');
  const { reload, refresh } = useRealtimeReload(spaceId, ['photos', 'files']);

  const [view, setView] = useState<View>('all');
  const [items, setItems] = useState<MediaItem[]>([]);
  const [albums, setAlbums] = useState<PhotoAlbum[]>([]);
  const [albumId, setAlbumId] = useState('');
  const [period, setPeriod] = useState('');
  const [timeline, setTimeline] = useState<TimelineBucket[]>([]);
  const [duplicates, setDuplicates] = useState<DuplicateGroup[]>([]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<MediaItem | null>(null);
  const [comments, setComments] = useState<MediaComment[]>([]);
  const [shares, setShares] = useState<ShareLink[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [faces, setFaces] = useState<FaceRecognitionStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [albumTitle, setAlbumTitle] = useState('');
  const [tagUser, setTagUser] = useState('');
  const [tagLabel, setTagLabel] = useState('');
  const [place, setPlace] = useState('');
  const [takenAt, setTakenAt] = useState('');
  const [shareHours, setShareHours] = useState(72);
  const [sharePassword, setSharePassword] = useState('');
  const [shareDownload, setShareDownload] = useState(false);
  const [createdLink, setCreatedLink] = useState('');
  const input = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    if (!spaceId) {
      setLoading(false);
      return;
    }
    setError(false);
    try {
      const [rows, albumRows, buckets] = await Promise.all([
        apiFetch<MediaItem[]>(
          apiPath('/photos', {
            spaceId,
            favorites: view === 'favorites' ? '1' : undefined,
            albumId: view === 'albums' && albumId ? albumId : undefined,
            period: view === 'timeline' && period ? period : undefined,
            q: query.trim() || undefined,
          }),
        ),
        apiFetch<PhotoAlbum[]>(apiPath('/photos/albums', { spaceId })),
        apiFetch<TimelineBucket[]>(apiPath('/photos/timeline', { spaceId })),
      ]);
      setItems(rows);
      setAlbums(albumRows);
      setTimeline(buckets);
      if (view === 'duplicates') {
        setDuplicates(await apiFetch<DuplicateGroup[]>(apiPath('/photos/duplicates', { spaceId })));
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [albumId, period, query, spaceId, view]);

  useEffect(() => {
    void load();
  }, [load, reload]);

  useEffect(() => {
    if (!spaceId) return;
    void apiFetch<Member[]>(`/spaces/${encodeURIComponent(spaceId)}/members`)
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [spaceId]);

  useEffect(() => {
    if (!spaceId || typeof window === 'undefined') return;
    const itemId = new URLSearchParams(window.location.search).get('item');
    if (!itemId) return;
    void apiFetch<MediaItem>(apiPath(`/photos/${encodeURIComponent(itemId)}`, { spaceId }))
      .then(setActive)
      .catch(() => undefined);
  }, [spaceId]);

  useEffect(() => {
    if (!spaceId || !active) return;
    setPlace(active.place);
    setTakenAt(active.takenAt ? active.takenAt.slice(0, 10) : '');
    setCreatedLink('');
    void apiFetch<MediaComment[]>(
      apiPath(`/photos/${encodeURIComponent(active.id)}/comments`, { spaceId }),
    ).then(setComments);
    if (canPublish) {
      void apiFetch<ShareLink[]>(apiPath('/photos/shares', { spaceId, targetId: active.id })).then(
        setShares,
      );
    }
  }, [active, canPublish, spaceId]);

  useEffect(() => {
    if (view !== 'privacy' || !spaceId) return;
    const subjects = isGuardian
      ? members.map((member) => member.userId)
      : [snapshot?.user.id ?? ''];
    void Promise.all(
      subjects
        .filter(Boolean)
        .map((userId) =>
          apiFetch<FaceRecognitionStatus>(apiPath('/photos/faces', { spaceId, userId })).catch(
            () => null,
          ),
        ),
    ).then((rows) => setFaces(rows.filter((row): row is FaceRecognitionStatus => Boolean(row))));
  }, [isGuardian, members, snapshot?.user.id, spaceId, view]);

  const replaceItem = (item: MediaItem) => {
    setActive(item);
    setItems((current) => current.map((entry) => (entry.id === item.id ? item : entry)));
  };

  const act = async <T,>(action: () => Promise<T>, after?: (value: T) => void) => {
    try {
      const value = await action();
      after?.(value);
    } catch (cause) {
      notify(describeError(t, cause), 'error');
    }
  };

  const upload = async (files: FileList | null) => {
    if (!spaceId || !files) return;
    const list = Array.from(files);
    let done = 0;
    for (const file of list) {
      try {
        await uploadFile({
          spaceId,
          file,
          module: 'photos',
          onConflict: 'rename',
          folderId: null,
          takenAt: file.lastModified ? new Date(file.lastModified).toISOString() : null,
          onProgress: (sent, total) =>
            setProgress(((done + (total ? sent / total : 1)) / list.length) * 100),
        });
      } catch (cause) {
        notify(`${file.name}: ${describeError(t, cause)}`, 'error');
      }
      done += 1;
    }
    setProgress(null);
    if (input.current) input.current.value = '';
    await apiFetch('/files/processing/run', { method: 'POST', body: { spaceId } }).catch(
      () => undefined,
    );
    await load();
  };

  const itemPath = (suffix = '') => `/photos/${encodeURIComponent(active?.id ?? '')}${suffix}`;

  const views: View[] = ['all', 'favorites', 'albums', 'timeline', 'duplicates', 'privacy'];

  return (
    <>
      <PageHeader
        eyebrow={t('stageD.badge')}
        title={t('modules.photos')}
        description={t('stageD.photos.subtitle')}
        action={
          canCreate ? (
            <div className="flex flex-col items-end gap-2">
              <input
                ref={input}
                type="file"
                accept="image/*,video/*,audio/*"
                multiple
                className="sr-only"
                onChange={(event) => void upload(event.target.files)}
              />
              <Button variant="primary" onClick={() => input.current?.click()} disabled={!online}>
                <Lucide.ImagePlus className="h-4 w-4" aria-hidden="true" />
                {t('stageD.photos.upload')}
              </Button>
              {progress !== null ? (
                <div className="w-48">
                  <ProgressBar value={progress} />
                </div>
              ) : null}
            </div>
          ) : null
        }
      />

      {!spaceId ? (
        <EmptyState icon="UsersRound" title={t('common.noData')} />
      ) : error ? (
        <ErrorPanel message={t('common.error')} onRetry={refresh} />
      ) : (
        <div className="space-y-4">
          <Card className="flex flex-wrap items-end gap-3 p-3">
            <div className="uf-pill-row" role="tablist">
              {views.map((entry) => (
                <button
                  key={entry}
                  type="button"
                  role="tab"
                  aria-selected={view === entry}
                  className={`uf-button ${view === entry ? 'uf-button-primary' : 'uf-button-ghost'} px-3 py-1.5 text-xs`}
                  onClick={() => setView(entry)}
                >
                  {t(`stageD.photos.view.${entry}`)}
                </button>
              ))}
            </div>
            <Field
              label={t('common.search')}
              htmlFor="photo-search"
              className="ml-auto min-w-[12rem]"
            >
              <input
                id="photo-search"
                className="uf-input"
                value={query}
                placeholder={t('stageD.photos.searchHint')}
                onChange={(event) => setQuery(event.target.value)}
              />
            </Field>
          </Card>

          {view === 'albums' ? (
            <Card className="space-y-3 p-4">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={`uf-button ${albumId === '' ? 'uf-button-primary' : 'uf-button-ghost'} text-xs`}
                  onClick={() => setAlbumId('')}
                >
                  {t('common.all')}
                </button>
                {albums.map((album) => (
                  <button
                    key={album.id}
                    type="button"
                    className={`uf-button ${albumId === album.id ? 'uf-button-primary' : 'uf-button-ghost'} text-xs`}
                    onClick={() => setAlbumId(album.id)}
                  >
                    <Lucide.BookImage className="h-3.5 w-3.5" aria-hidden="true" />
                    {album.title} · {album.itemCount}
                  </button>
                ))}
              </div>
              {canCreate ? (
                <form
                  className="flex items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!albumTitle.trim()) return;
                    void act(
                      () =>
                        apiFetch<PhotoAlbum>('/photos/albums', {
                          method: 'POST',
                          body: {
                            spaceId,
                            title: albumTitle.trim(),
                            fileIds: active ? [active.id] : [],
                          },
                        }),
                      (album) => {
                        setAlbumTitle('');
                        setAlbumId(album.id);
                        void load();
                      },
                    );
                  }}
                >
                  <Field label={t('stageD.photos.newAlbum')} htmlFor="album-title">
                    <input
                      id="album-title"
                      className="uf-input"
                      value={albumTitle}
                      onChange={(e) => setAlbumTitle(e.target.value)}
                    />
                  </Field>
                  <Button type="submit">{t('common.create')}</Button>
                </form>
              ) : null}
            </Card>
          ) : null}

          {view === 'timeline' ? (
            <Card className="flex flex-wrap gap-2 p-3">
              <button
                type="button"
                className={`uf-button ${period === '' ? 'uf-button-primary' : 'uf-button-ghost'} text-xs`}
                onClick={() => setPeriod('')}
              >
                {t('common.all')}
              </button>
              {timeline.map((bucket) => (
                <button
                  key={bucket.period}
                  type="button"
                  className={`uf-button ${period === bucket.period ? 'uf-button-primary' : 'uf-button-ghost'} text-xs`}
                  onClick={() => setPeriod(bucket.period)}
                >
                  {bucket.period} · {bucket.count}
                </button>
              ))}
            </Card>
          ) : null}

          {view === 'duplicates' ? (
            <Card className="space-y-3 p-4">
              <p className="text-sm text-[var(--muted)]">{t('stageD.photos.duplicatesHint')}</p>
              {duplicates.length === 0 ? (
                <p className="text-sm">{t('stageD.photos.noDuplicates')}</p>
              ) : null}
              {duplicates.map((group) => (
                <div key={group.sha256} className="flex flex-wrap gap-2">
                  {group.files.map((file) => (
                    <button
                      key={file.id}
                      type="button"
                      onClick={() => setActive(items.find((item) => item.id === file.id) ?? null)}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={contentUrl(spaceId, file.id)}
                        alt={file.name}
                        className="h-24 w-24 rounded-xl border border-[var(--border)] object-cover"
                      />
                      <span className="block max-w-24 truncate text-xs">{file.name}</span>
                    </button>
                  ))}
                </div>
              ))}
            </Card>
          ) : null}

          {view === 'privacy' ? (
            <Card className="space-y-3 p-4">
              <h2 className="font-bold">{t('stageD.faces.title')}</h2>
              <p className="text-sm text-[var(--muted)]">{t('stageD.faces.hint')}</p>
              <ul className="space-y-2">
                {faces.map((status) => {
                  const member = members.find((entry) => entry.userId === status.userId);
                  return (
                    <li
                      key={status.userId}
                      className="flex flex-wrap items-center justify-between gap-2 text-sm"
                    >
                      <span>
                        <strong>{member?.displayName ?? t('stageD.faces.me')}</strong>
                        {status.isChild ? <Badge className="ml-2">{t('roles.child')}</Badge> : null}
                        <span className="block text-xs text-[var(--muted)]">
                          {status.enabled ? t('stageD.faces.on') : t('stageD.faces.off')} ·{' '}
                          {t('stageD.faces.stored', { count: status.storedRepresentations })} ·{' '}
                          {status.engineAvailable
                            ? t('stageD.faces.engineOn')
                            : t('stageD.faces.engineOff')}
                        </span>
                      </span>
                      <span className="flex gap-2">
                        <Button
                          variant={status.enabled ? 'danger' : 'default'}
                          className="text-xs"
                          disabled={
                            !status.enabled && status.isChild && status.userId === snapshot?.user.id
                          }
                          onClick={() => {
                            if (
                              !status.enabled &&
                              !window.confirm(t('stageD.faces.consentConfirm'))
                            )
                              return;
                            void act(
                              () =>
                                apiFetch<FaceRecognitionStatus>('/photos/faces', {
                                  method: 'POST',
                                  body: {
                                    spaceId,
                                    userId: status.userId,
                                    enabled: !status.enabled,
                                    consent: !status.enabled,
                                  },
                                }),
                              (next) =>
                                setFaces((current) =>
                                  current.map((row) => (row.userId === next.userId ? next : row)),
                                ),
                            );
                          }}
                        >
                          {status.enabled ? t('stageD.faces.disable') : t('stageD.faces.enable')}
                        </Button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Card>
          ) : null}

          {loading ? (
            <div className="uf-skeleton h-72" />
          ) : view !== 'duplicates' && view !== 'privacy' ? (
            items.length === 0 ? (
              <EmptyState icon="Images" title={t('stageD.photos.empty')} />
            ) : (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setActive(item)}
                      className="group relative block w-full overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-soft)] text-left"
                    >
                      {item.kind === 'image' ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={contentUrl(spaceId, item.id)}
                          alt={item.description || item.name}
                          loading="lazy"
                          className="aspect-square w-full object-cover"
                        />
                      ) : (
                        <span className="flex aspect-square w-full items-center justify-center">
                          {item.kind === 'video' ? (
                            <Lucide.Film className="h-10 w-10" />
                          ) : (
                            <Lucide.Music className="h-10 w-10" />
                          )}
                        </span>
                      )}
                      <span className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-black/45 px-2 py-1 text-[0.7rem] text-white">
                        {item.favorite ? (
                          <Lucide.Star
                            className="h-3 w-3 fill-current"
                            aria-label={t('stageD.photos.favorite')}
                          />
                        ) : null}
                        <span className="truncate">
                          {item.takenAt ? new Date(item.takenAt).toLocaleDateString() : item.name}
                        </span>
                        {item.commentCount > 0 ? (
                          <span className="ml-auto flex items-center gap-0.5">
                            <Lucide.MessageCircle className="h-3 w-3" aria-hidden="true" />
                            {item.commentCount}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </div>
      )}

      {active && spaceId ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={active.name}
          className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/70 p-2 md:p-6"
          onKeyDown={(event) => {
            if (event.key === 'Escape') setActive(null);
          }}
        >
          <div className="grid w-full max-w-6xl overflow-hidden rounded-2xl bg-[var(--surface)] md:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="relative flex min-h-[40vh] items-center justify-center bg-black">
              {active.kind === 'image' ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={contentUrl(spaceId, active.id)}
                  alt={active.description || active.name}
                  className="max-h-[85vh] max-w-full object-contain"
                />
              ) : active.kind === 'video' ? (
                <video
                  src={contentUrl(spaceId, active.id)}
                  controls
                  className="max-h-[85vh] max-w-full"
                />
              ) : (
                <audio src={contentUrl(spaceId, active.id)} controls />
              )}
              <button
                type="button"
                className="absolute right-3 top-3 rounded-full bg-black/60 p-2 text-white"
                onClick={() => setActive(null)}
                aria-label={t('common.close')}
                autoFocus
              >
                <Lucide.X className="h-5 w-5" />
              </button>
            </div>
            <div className="max-h-[90vh] space-y-4 overflow-y-auto p-4">
              <div>
                <h2 className="break-words font-bold">{active.name}</h2>
                <p className="text-xs text-[var(--muted)]">
                  {active.createdByName ?? '—'} ·{' '}
                  {active.takenAt ? new Date(active.takenAt).toLocaleString() : '—'}
                  {active.place ? ` · ${active.place}` : ''}
                </p>
              </div>
              <div className="uf-pill-row">
                <Button
                  variant={active.favorite ? 'primary' : 'ghost'}
                  className="text-xs"
                  onClick={() =>
                    void act(
                      () =>
                        apiFetch<MediaItem>(itemPath('/favorite'), {
                          method: 'POST',
                          body: { spaceId, on: !active.favorite },
                        }),
                      replaceItem,
                    )
                  }
                >
                  <Lucide.Star className="h-4 w-4" aria-hidden="true" />
                  {t('stageD.photos.favorite')}
                </Button>
                {EMOJI.map((emoji) => {
                  const reaction = active.reactions.find((entry) => entry.emoji === emoji);
                  return (
                    <button
                      key={emoji}
                      type="button"
                      className="uf-reaction"
                      aria-pressed={reaction?.mine ?? false}
                      onClick={() =>
                        void act(
                          () =>
                            apiFetch<MediaItem>(itemPath('/reactions'), {
                              method: 'POST',
                              body: { spaceId, emoji, on: !reaction?.mine },
                            }),
                          replaceItem,
                        )
                      }
                    >
                      {emoji} {reaction?.count ?? ''}
                    </button>
                  );
                })}
              </div>

              <section>
                <h3 className="mb-1 text-sm font-bold">{t('stageD.photos.people')}</h3>
                <div className="uf-pill-row mb-2">
                  {active.people.length === 0 ? (
                    <span className="text-xs text-[var(--muted)]">—</span>
                  ) : null}
                  {active.people.map((tag) => (
                    <Badge key={tag.id}>
                      {tag.label}
                      <button
                        type="button"
                        aria-label={`${t('stageD.photos.untag')}: ${tag.label}`}
                        onClick={() =>
                          void act(
                            () =>
                              apiFetch<MediaItem>(
                                apiPath(itemPath(`/people/${encodeURIComponent(tag.id)}`), {
                                  spaceId,
                                }),
                                {
                                  method: 'DELETE',
                                },
                              ),
                            replaceItem,
                          )
                        }
                      >
                        <Lucide.X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!tagUser && !tagLabel.trim()) return;
                    void act(
                      () =>
                        apiFetch<MediaItem>(itemPath('/people'), {
                          method: 'POST',
                          body: { spaceId, userId: tagUser || null, label: tagLabel.trim() },
                        }),
                      (item) => {
                        replaceItem(item);
                        setTagUser('');
                        setTagLabel('');
                      },
                    );
                  }}
                >
                  <select
                    className="uf-select w-36"
                    aria-label={t('stageD.photos.member')}
                    value={tagUser}
                    onChange={(event) => setTagUser(event.target.value)}
                  >
                    <option value="">{t('stageD.photos.member')}</option>
                    {members.map((member) => (
                      <option key={member.userId} value={member.userId}>
                        {member.displayName}
                      </option>
                    ))}
                  </select>
                  <input
                    className="uf-input w-28"
                    aria-label={t('stageD.photos.label')}
                    placeholder={t('stageD.photos.label')}
                    value={tagLabel}
                    onChange={(event) => setTagLabel(event.target.value)}
                  />
                  <Button type="submit" className="text-xs">
                    {t('stageD.photos.tag')}
                  </Button>
                </form>
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-bold">{t('stageD.photos.details')}</h3>
                <Field label={t('stageD.photos.takenAt')} htmlFor="taken-at">
                  <input
                    id="taken-at"
                    type="date"
                    className="uf-input"
                    value={takenAt}
                    onChange={(e) => setTakenAt(e.target.value)}
                  />
                </Field>
                <Field label={t('stageD.photos.place')} htmlFor="place">
                  <input
                    id="place"
                    className="uf-input"
                    value={place}
                    onChange={(e) => setPlace(e.target.value)}
                  />
                </Field>
                <div className="uf-pill-row">
                  <Button
                    className="text-xs"
                    onClick={() =>
                      void act(
                        () =>
                          apiFetch<MediaItem>(itemPath(), {
                            method: 'PATCH',
                            body: { spaceId, place, takenAt: takenAt || null },
                          }),
                        (item) => {
                          replaceItem(item);
                          notify(t('common.saved'), 'success');
                        },
                      )
                    }
                  >
                    {t('common.save')}
                  </Button>
                  {albums.length > 0 && canCreate ? (
                    <select
                      className="uf-select w-40 text-xs"
                      aria-label={t('stageD.photos.addToAlbum')}
                      value=""
                      onChange={(event) => {
                        const target = event.target.value;
                        if (!target) return;
                        void act(
                          () =>
                            apiFetch(`/photos/albums/${encodeURIComponent(target)}/items`, {
                              method: 'POST',
                              body: { spaceId, fileIds: [active.id] },
                            }),
                          () => notify(t('common.saved'), 'success'),
                        );
                      }}
                    >
                      <option value="">{t('stageD.photos.addToAlbum')}</option>
                      {albums.map((album) => (
                        <option key={album.id} value={album.id}>
                          {album.title}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <a
                    className="uf-button uf-button-ghost text-xs"
                    href={contentUrl(spaceId, active.id, true)}
                  >
                    <Lucide.Download className="h-4 w-4" aria-hidden="true" />
                    {t('stageD.files.download')}
                  </a>
                </div>
              </section>

              {canPublish ? (
                <section className="space-y-2">
                  <h3 className="text-sm font-bold">{t('stageD.share.title')}</h3>
                  <p className="text-xs text-[var(--muted)]">{t('stageD.share.hint')}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label={t('stageD.share.hours')} htmlFor="share-hours">
                      <input
                        id="share-hours"
                        type="number"
                        min={1}
                        max={2160}
                        className="uf-input"
                        value={shareHours}
                        onChange={(event) => setShareHours(Number(event.target.value) || 1)}
                      />
                    </Field>
                    <Field label={t('stageD.share.password')} htmlFor="share-password">
                      <input
                        id="share-password"
                        type="password"
                        autoComplete="new-password"
                        className="uf-input"
                        value={sharePassword}
                        onChange={(event) => setSharePassword(event.target.value)}
                      />
                    </Field>
                  </div>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={shareDownload}
                      onChange={(event) => setShareDownload(event.target.checked)}
                    />
                    {t('stageD.share.allowDownload')}
                  </label>
                  <div className="uf-pill-row">
                    {(
                      [['file', active.id], ...active.albumIds.map((id) => ['album', id])] as Array<
                        [string, string]
                      >
                    ).map(([kind, id]) => (
                      <Button
                        key={`${kind}-${id}`}
                        className="text-xs"
                        onClick={() =>
                          void act(
                            () =>
                              apiFetch<ShareLink>('/photos/shares', {
                                method: 'POST',
                                body: {
                                  spaceId,
                                  targetKind: kind,
                                  targetId: id,
                                  expiresInHours: shareHours,
                                  password: sharePassword.length >= 6 ? sharePassword : null,
                                  allowDownload: shareDownload,
                                },
                              }),
                            (link) => {
                              setCreatedLink(`${window.location.origin}${link.url ?? ''}`);
                              setSharePassword('');
                              void apiFetch<ShareLink[]>(
                                apiPath('/photos/shares', { spaceId, targetId: active.id }),
                              ).then(setShares);
                            },
                          )
                        }
                      >
                        <Lucide.Link className="h-3.5 w-3.5" aria-hidden="true" />
                        {kind === 'file'
                          ? t('stageD.share.thisItem')
                          : `${t('stageD.share.album')}: ${albums.find((album) => album.id === id)?.title ?? ''}`}
                      </Button>
                    ))}
                  </div>
                  {createdLink ? (
                    <div className="rounded-xl border border-amber-300 p-2 text-xs">
                      <p className="font-bold">{t('stageD.share.once')}</p>
                      <code className="uf-mono break-all">{createdLink}</code>
                    </div>
                  ) : null}
                  <ul className="space-y-1 text-xs">
                    {shares.map((share) => (
                      <li key={share.id} className="flex items-center justify-between gap-2">
                        <span>
                          {share.passwordProtected ? '🔒 ' : ''}
                          {new Date(share.expiresAt).toLocaleString()} · {share.accessCount}×
                        </span>
                        {share.active ? (
                          <Button
                            variant="ghost"
                            className="px-2 py-1 text-xs"
                            onClick={() =>
                              void act(
                                () =>
                                  apiFetch(
                                    apiPath(`/photos/shares/${encodeURIComponent(share.id)}`, {
                                      spaceId,
                                    }),
                                    {
                                      method: 'DELETE',
                                    },
                                  ),
                                () =>
                                  setShares((current) =>
                                    current.map((row) =>
                                      row.id === share.id ? { ...row, active: false } : row,
                                    ),
                                  ),
                              )
                            }
                          >
                            {t('stageD.revoke')}
                          </Button>
                        ) : (
                          <Badge>{t('stageD.revoked')}</Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <section>
                <h3 className="mb-2 text-sm font-bold">{t('stageD.photos.comments')}</h3>
                <ul className="mb-2 space-y-2 text-sm">
                  {comments.map((entry) => (
                    <li key={entry.id}>
                      <strong>{entry.authorName ?? '—'}</strong>
                      <span className="ml-1 text-xs text-[var(--muted)]">
                        {new Date(entry.createdAt).toLocaleString()}
                      </span>
                      <p>{entry.body}</p>
                    </li>
                  ))}
                </ul>
                <form
                  className="flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!comment.trim()) return;
                    void act(
                      () =>
                        apiFetch<MediaComment>(itemPath('/comments'), {
                          method: 'POST',
                          body: { spaceId, body: comment.trim() },
                        }),
                      (created) => {
                        setComments((current) => [...current, created]);
                        setComment('');
                      },
                    );
                  }}
                >
                  <input
                    className="uf-input"
                    aria-label={t('stageD.photos.comment')}
                    placeholder={t('stageD.photos.comment')}
                    value={comment}
                    onChange={(event) => setComment(event.target.value)}
                  />
                  <Button type="submit" variant="primary">
                    <Lucide.Send className="h-4 w-4" aria-label={t('stageC.messenger.send')} />
                  </Button>
                </form>
              </section>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
