'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { Language, PublicPost, PublicationVisibility } from '@ufos/contracts';
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

interface PublishingStats {
  total: number;
  byStatus: Record<string, number>;
  explicitPublishOnly: boolean;
}

const VISIBILITIES: PublicationVisibility[] = ['household', 'network', 'public'];

export default function PublishingPage() {
  const { language, t, snapshot, notify, online } = useApp();
  const spaceId = snapshot?.activeSpace?.id;
  const { connected, reload, refresh } = useRealtimeReload(spaceId, ['public_site']);
  const [posts, setPosts] = useState<PublicPost[]>([]);
  const [shared, setShared] = useState<PublicPost[]>([]);
  const [stats, setStats] = useState<PublishingStats | null>(null);
  const [previewPost, setPreviewPost] = useState<PublicPost | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [title, setTitle] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [body, setBody] = useState('');
  const [postLanguage, setPostLanguage] = useState<Language>('ru');
  const [visibility, setVisibility] = useState<PublicationVisibility>('household');
  const [guestShared, setGuestShared] = useState(false);
  const [audienceIds, setAudienceIds] = useState<string[]>([]);

  const networkSpaces = useMemo(() => {
    const active = snapshot?.activeSpace;
    if (!active) return [];
    return (snapshot?.spaces ?? []).filter(
      (space) =>
        space.id === active.id ||
        (active.networkId != null && space.networkId === active.networkId),
    );
  }, [snapshot?.activeSpace, snapshot?.spaces]);

  useEffect(() => {
    setAudienceIds(spaceId ? [spaceId] : []);
  }, [spaceId]);

  const load = useCallback(async () => {
    if (!spaceId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(false);
    try {
      const [postRows, statRows, sharedRows] = await Promise.all([
        apiFetch<PublicPost[]>(apiPath('/publishing', { spaceId })),
        apiFetch<PublishingStats>(apiPath('/publishing/stats', { spaceId })),
        apiFetch<PublicPost[]>(apiPath('/publishing/shared', { spaceId })),
      ]);
      setPosts(postRows);
      setStats(statRows);
      setShared(sharedRows);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  useEffect(() => {
    void load();
  }, [load, reload]);

  const createDraft = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!spaceId || !title.trim()) return;
    if (!online) {
      notify(t('error.offlineSave'), 'error');
      return;
    }
    try {
      const audience =
        visibility === 'household' ? [spaceId] : audienceIds.length ? audienceIds : [spaceId];
      await apiFetch('/publishing/drafts', {
        method: 'POST',
        body: {
          spaceId,
          title: title.trim(),
          excerpt,
          body,
          language: postLanguage,
          visibility,
          audienceSpaceIds: audience,
          guestShared,
        },
      });
      setTitle('');
      setExcerpt('');
      setBody('');
      notify(t('stageB.publishing.explicit'), 'success');
      refresh();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const preview = async (id: string) => {
    if (!spaceId) return;
    try {
      const result = await apiFetch<PublicPost>(
        apiPath(`/publishing/${encodeURIComponent(id)}/preview`, { spaceId }),
      );
      setPreviewPost(result);
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const publish = async (post: PublicPost) => {
    if (!spaceId) return;
    try {
      const postVisibility = post.visibility ?? 'household';
      const audience =
        post.audienceSpaceIds && post.audienceSpaceIds.length > 0
          ? post.audienceSpaceIds
          : [spaceId];
      await apiFetch(`/publishing/${encodeURIComponent(post.id)}/publish`, {
        method: 'POST',
        body: {
          spaceId,
          visibility: postVisibility,
          audienceSpaceIds: postVisibility === 'public' ? [] : audience,
          guestShared: post.guestShared ?? false,
        },
      });
      refresh();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const unpublish = async (post: PublicPost) => {
    if (!spaceId) return;
    try {
      await apiFetch(`/publishing/${encodeURIComponent(post.id)}/unpublish`, {
        method: 'POST',
        body: { spaceId, reason: 'manual' },
      });
      refresh();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  return (
    <>
      <PageHeader
        eyebrow={t('stage.current')}
        title={t('modules.public_site')}
        description={t('stageB.publishing.subtitle')}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={connected ? 'success' : 'warning'}>
              <Lucide.Radio className="h-3.5 w-3.5" />
              {connected ? t('stageB.common.connected') : t('stageB.common.disconnected')}
            </Badge>
            <Link href="/" className="uf-button">
              <Lucide.Globe2 className="h-4 w-4" />
              {t('common.publicSite')}
            </Link>
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
            <Card className="p-6">
              <h2 className="mb-4 text-lg font-bold">{t('stageB.publishing.newDraft')}</h2>
              <form onSubmit={createDraft} className="space-y-4">
                <Field label={t('common.title')} htmlFor="publish-title">
                  <input
                    id="publish-title"
                    className="uf-input"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    required
                    maxLength={200}
                  />
                </Field>
                <Field label={t('common.excerpt')} htmlFor="publish-excerpt">
                  <input
                    id="publish-excerpt"
                    className="uf-input"
                    value={excerpt}
                    onChange={(event) => setExcerpt(event.target.value)}
                    maxLength={600}
                  />
                </Field>
                <Field label={t('common.body')} htmlFor="publish-body">
                  <textarea
                    id="publish-body"
                    className="uf-input min-h-32"
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                    maxLength={30000}
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t('common.language')} htmlFor="publish-language">
                    <select
                      id="publish-language"
                      className="uf-select"
                      value={postLanguage}
                      onChange={(event) => setPostLanguage(event.target.value as Language)}
                    >
                      <option value="ru">{t('common.russian')}</option>
                      <option value="it">{t('common.italian')}</option>
                    </select>
                  </Field>
                  <Field label={t('stageB.common.visibility')} htmlFor="publish-visibility">
                    <select
                      id="publish-visibility"
                      className="uf-select"
                      value={visibility}
                      onChange={(event) =>
                        setVisibility(event.target.value as PublicationVisibility)
                      }
                    >
                      {VISIBILITIES.map((value) => (
                        <option key={value} value={value}>
                          {t(`stageB.visibility.${value}`)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <p className="text-xs leading-5 text-[var(--muted)]">
                  {t('stageB.publishing.audienceHint')}
                </p>
                {visibility !== 'household' ? (
                  <div className="space-y-2">
                    {networkSpaces.map((space) => (
                      <label
                        key={space.id}
                        className="uf-card-soft flex items-center gap-3 p-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={audienceIds.includes(space.id)}
                          onChange={(event) =>
                            setAudienceIds((current) =>
                              event.target.checked
                                ? [...new Set([...current, space.id])]
                                : current.filter((id) => id !== space.id),
                            )
                          }
                        />
                        {space.name}
                      </label>
                    ))}
                  </div>
                ) : null}
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold">{t('stageB.common.guestShared')}</span>
                  <Toggle
                    checked={guestShared}
                    onChange={setGuestShared}
                    label={t('stageB.common.guestShared')}
                  />
                </div>
                <Button type="submit" variant="primary">
                  <Lucide.FilePlus2 className="h-4 w-4" />
                  {t('common.create')}
                </Button>
              </form>
            </Card>

            <Card className="p-6">
              <h2 className="mb-4 text-lg font-bold">{t('stageB.publishing.stats')}</h2>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="uf-card-soft p-3">
                  <p className="text-xs text-[var(--muted)]">{t('common.total')}</p>
                  <p className="text-xl font-black">{stats?.total ?? 0}</p>
                </div>
                <div className="uf-card-soft p-3">
                  <p className="text-xs text-[var(--muted)]">{t('stageB.common.draft')}</p>
                  <p className="text-xl font-black">{stats?.byStatus.draft ?? 0}</p>
                </div>
                <div className="uf-card-soft p-3">
                  <p className="text-xs text-[var(--muted)]">{t('stageB.common.published')}</p>
                  <p className="text-xl font-black">{stats?.byStatus.published ?? 0}</p>
                </div>
              </div>
              <p className="mt-4 text-xs leading-5 text-[var(--muted)]">
                {t('stageB.publishing.explicit')}
              </p>
            </Card>

            {previewPost ? (
              <Card className="p-6">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <h2 className="text-lg font-bold">{t('stageB.common.preview')}</h2>
                  <Button variant="ghost" onClick={() => setPreviewPost(null)}>
                    <Lucide.X className="h-4 w-4" />
                  </Button>
                </div>
                <Badge tone="accent">{previewPost.language.toUpperCase()}</Badge>
                <h3 className="mt-3 text-xl font-bold">{previewPost.title}</h3>
                <p className="mt-2 text-sm leading-6 text-[var(--muted)]">{previewPost.excerpt}</p>
                <div className="mt-4 whitespace-pre-wrap text-sm leading-7">{previewPost.body}</div>
              </Card>
            ) : null}
          </div>

          <div className="space-y-5">
            <Card className="p-6">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-lg font-bold">{t('stageB.publishing.posts')}</h2>
                <Badge tone="accent">{posts.length}</Badge>
              </div>
              {posts.length === 0 ? (
                <EmptyState icon="Globe2" title={t('stageB.common.noData')} />
              ) : (
                <div className="space-y-3">
                  {posts.map((post) => (
                    <article key={post.id} className="uf-card-soft p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h3 className="font-bold">{post.title}</h3>
                          <p className="mt-1 text-xs text-[var(--muted)]">
                            {post.slug} · {post.language.toUpperCase()} ·{' '}
                            {formatDateTime(language, post.publishedAt)}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Badge
                            tone={
                              post.status === 'published'
                                ? 'success'
                                : post.status === 'draft'
                                  ? 'warning'
                                  : 'danger'
                            }
                          >
                            {post.status === 'published'
                              ? t('stageB.common.published')
                              : post.status === 'draft'
                                ? t('stageB.common.draft')
                                : t('stageB.common.unpublished')}
                          </Badge>
                          <Badge tone="accent">
                            {t(`stageB.visibility.${post.visibility ?? 'household'}`)}
                          </Badge>
                          {post.guestShared ? (
                            <Badge tone="warning">{t('stageB.common.guestShared')}</Badge>
                          ) : null}
                        </div>
                      </div>
                      <p className="mt-2 text-sm leading-6 text-[var(--muted)]">{post.excerpt}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button onClick={() => void preview(post.id)}>
                          {t('stageB.common.preview')}
                        </Button>
                        {post.status !== 'published' ? (
                          <Button variant="primary" onClick={() => void publish(post)}>
                            {t('stageB.common.publish')}
                          </Button>
                        ) : (
                          <Button onClick={() => void unpublish(post)}>
                            {t('stageB.common.unpublish')}
                          </Button>
                        )}
                        {post.status === 'published' && post.visibility === 'public' ? (
                          <Link href={`/public/${post.slug}`} className="uf-button">
                            <Lucide.ArrowUpRight className="h-4 w-4" />
                            {t('common.open')}
                          </Link>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </Card>

            <Card className="p-6">
              <h2 className="mb-4 text-lg font-bold">{t('stageB.publishing.shared')}</h2>
              {shared.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">{t('stageB.common.noData')}</p>
              ) : (
                <div className="space-y-2">
                  {shared.map((post) => (
                    <div key={post.id} className="uf-card-soft p-3">
                      <p className="text-sm font-bold">{post.title}</p>
                      <p className="mt-1 text-xs text-[var(--muted)]">{post.excerpt}</p>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
