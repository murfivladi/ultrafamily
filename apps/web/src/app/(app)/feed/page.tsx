'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FeedPost } from '@ufos/contracts';
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
import { useRealtimeReload } from '@/lib/use-realtime';

const REACTIONS = ['❤️', '👍', '🎉'];
const SOURCES = ['birthdays', 'plans', 'photos', 'announcements'] as const;

export default function FeedPage() {
  const { t, snapshot, notify, online } = useApp();
  const spaceId = snapshot?.activeSpace?.id;
  const { connected, reload, refresh } = useRealtimeReload(spaceId, ['feed']);
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<'news' | 'announcement' | 'photo' | 'moment'>('news');
  const [visibility, setVisibility] = useState<'household' | 'network'>('household');
  const [tags, setTags] = useState('');
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [sources, setSources] = useState<string[]>([...SOURCES]);
  const [filter, setFilter] = useState<'all' | FeedPost['kind']>('all');
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    if (!spaceId) {
      setLoading(false);
      return;
    }
    setError(false);
    try {
      const rows = await apiFetch<FeedPost[]>(
        apiPath('/feed/posts', { spaceId, limit: 40, q: query.trim() || undefined }),
      );
      setPosts(rows);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [query, spaceId]);

  const loadSources = useCallback(async () => {
    if (!spaceId) return;
    try {
      const result = await apiFetch<{ sources: string[] }>(apiPath('/feed/sources', { spaceId }));
      setSources(result.sources);
    } catch {
      // Preferences are optional; the default list stays visible.
    }
  }, [spaceId]);

  useEffect(() => {
    void load();
  }, [load, reload]);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  const visible = useMemo(
    () => (filter === 'all' ? posts : posts.filter((post) => post.kind === filter)),
    [filter, posts],
  );

  const publish = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!spaceId || (!title.trim() && !body.trim())) return;
    if (!online) {
      notify(t('error.offlineSave'), 'error');
      return;
    }
    setBusy(true);
    try {
      await apiFetch('/feed/posts', {
        method: 'POST',
        body: {
          spaceId,
          kind,
          title: title.trim(),
          body: body.trim(),
          visibility,
          tags: tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
        },
      });
      setTitle('');
      setBody('');
      setTags('');
      await load();
      refresh();
    } catch {
      notify(t('common.error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const comment = async (post: FeedPost) => {
    const draft = (commentDrafts[post.id] ?? '').trim();
    if (!spaceId || !draft) return;
    try {
      await apiFetch(`/feed/posts/${encodeURIComponent(post.id)}/comments`, {
        method: 'POST',
        body: { spaceId, body: draft },
      });
      setCommentDrafts((current) => ({ ...current, [post.id]: '' }));
      await load();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const react = async (post: FeedPost, emoji: string) => {
    if (!spaceId) return;
    try {
      await apiFetch(`/feed/posts/${encodeURIComponent(post.id)}/reactions`, {
        method: 'POST',
        body: { spaceId, emoji },
      });
      await load();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const togglePin = async (post: FeedPost) => {
    if (!spaceId) return;
    try {
      await apiFetch(`/feed/posts/${encodeURIComponent(post.id)}`, {
        method: 'PATCH',
        body: { spaceId, pinned: !post.pinned },
      });
      await load();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const toggleSource = async (source: string) => {
    if (!spaceId) return;
    const next = sources.includes(source)
      ? sources.filter((entry) => entry !== source)
      : [...sources, source];
    setSources(next);
    try {
      await apiFetch('/feed/sources', { method: 'PATCH', body: { spaceId, sources: next } });
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const generateEvents = async () => {
    if (!spaceId) return;
    setBusy(true);
    try {
      const result = await apiFetch<{ generated: number }>('/feed/auto-events', {
        method: 'POST',
        body: { spaceId, kinds: sources },
      });
      notify(t('common.saved'), 'success');
      if (result.generated > 0) await load();
    } catch {
      notify(t('common.error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow={t('stageC.badge')}
        title={t('modules.feed')}
        description={t('stageC.feed.subtitle')}
        action={
          <div className="uf-pill-row">
            <Badge tone={connected ? 'success' : 'warning'}>
              <Lucide.Radio className="h-3.5 w-3.5" aria-hidden="true" />
              {connected ? t('stageB.common.connected') : t('stageB.common.disconnected')}
            </Badge>
            <Button onClick={() => void generateEvents()} loading={busy}>
              <Lucide.Sparkles className="h-4 w-4" aria-hidden="true" />
              {t('stageC.feed.generate')}
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
      ) : (
        <div className="uf-split uf-split-main">
          <div className="space-y-5">
            <Card className="p-4">
              <div className="uf-pill-row">
                {(['all', 'news', 'announcement', 'photo', 'moment', 'system'] as const).map(
                  (entry) => (
                    <Button
                      key={entry}
                      onClick={() => setFilter(entry)}
                      variant={filter === entry ? 'primary' : 'default'}
                    >
                      {entry === 'all' ? t('common.all') : t(`stageC.feed.kind.${entry}`)}
                    </Button>
                  ),
                )}
                <label className="min-w-40 flex-1">
                  <span className="sr-only">{t('common.search')}</span>
                  <input
                    className="uf-input"
                    placeholder={t('common.search')}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
              </div>
            </Card>

            {loading ? (
              <div className="uf-skeleton h-64" />
            ) : visible.length === 0 ? (
              <EmptyState icon="Newspaper" title={t('stageC.feed.noPosts')} />
            ) : (
              visible.map((post) => (
                <Card
                  key={post.id}
                  className={`p-5 ${post.pinned ? 'border-[var(--accent)]' : ''}`}
                >
                  <header className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <Avatar name={post.authorName || '—'} color={post.authorAvatarColor} />
                      <div>
                        <p className="flex flex-wrap items-center gap-2 font-bold">
                          {post.authorName || '—'}
                          <Badge tone="accent">{t(`stageC.feed.kind.${post.kind}`)}</Badge>
                          {post.pinned ? (
                            <Badge>
                              <Lucide.Pin className="h-3 w-3" aria-hidden="true" />
                            </Badge>
                          ) : null}
                        </p>
                        <p className="text-xs text-[var(--muted)]">
                          {new Date(post.publishedAt).toLocaleString()} ·{' '}
                          {t(`stageC.feed.visibility.${post.visibility}`)}
                        </p>
                      </div>
                    </div>
                    <Button onClick={() => void togglePin(post)} aria-label={t('stageC.feed.pin')}>
                      <Lucide.Pin className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </header>

                  {post.title ? <h2 className="mt-3 text-lg font-bold">{post.title}</h2> : null}
                  {post.body ? (
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{post.body}</p>
                  ) : null}

                  {post.tags.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {post.tags.map((tag) => (
                        <Badge key={tag}>#{tag}</Badge>
                      ))}
                    </div>
                  ) : null}

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {post.reactions.map((reaction) => (
                      <button
                        key={reaction.emoji}
                        type="button"
                        className="uf-reaction"
                        onClick={() => void react(post, reaction.emoji)}
                        aria-label={`${reaction.emoji} ${reaction.userIds.length}`}
                      >
                        {reaction.emoji} {reaction.userIds.length}
                      </button>
                    ))}
                    {REACTIONS.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        className="uf-reaction opacity-60 hover:opacity-100"
                        onClick={() => void react(post, emoji)}
                        aria-label={`${t('stageC.feed.react')} ${emoji}`}
                      >
                        {emoji}
                      </button>
                    ))}
                    <span className="text-xs text-[var(--muted)]">
                      {post.commentCount} {t('stageC.feed.comments').toLocaleLowerCase()}
                    </span>
                  </div>

                  <section className="mt-4 space-y-2 border-t border-[var(--border)] pt-3">
                    {post.comments.map((entry) => (
                      <div key={entry.id} className="flex items-start gap-2 text-sm">
                        <Avatar
                          name={entry.authorName || '—'}
                          color={entry.authorAvatarColor}
                          size="sm"
                        />
                        <p>
                          <span className="font-bold">{entry.authorName || '—'}: </span>
                          {entry.body}
                        </p>
                      </div>
                    ))}
                    <div className="flex flex-wrap gap-2">
                      <label className="min-w-40 flex-1">
                        <span className="sr-only">{t('stageC.feed.comment')}</span>
                        <input
                          className="uf-input"
                          placeholder={t('stageC.feed.comment')}
                          value={commentDrafts[post.id] ?? ''}
                          onChange={(event) =>
                            setCommentDrafts((current) => ({
                              ...current,
                              [post.id]: event.target.value,
                            }))
                          }
                          maxLength={4000}
                        />
                      </label>
                      <Button onClick={() => void comment(post)}>
                        {t('stageC.messenger.send')}
                      </Button>
                    </div>
                  </section>
                </Card>
              ))
            )}
          </div>

          <aside className="space-y-5">
            <Card className="p-5">
              <h2 className="mb-3 text-lg font-bold">{t('stageC.feed.newPost')}</h2>
              <form onSubmit={publish} className="space-y-3">
                <Field label={t('common.kind')} htmlFor="feed-kind">
                  <select
                    id="feed-kind"
                    className="uf-select"
                    value={kind}
                    onChange={(event) =>
                      setKind(event.target.value as 'news' | 'announcement' | 'photo' | 'moment')
                    }
                  >
                    <option value="news">{t('stageC.feed.kind.news')}</option>
                    <option value="announcement">{t('stageC.feed.kind.announcement')}</option>
                    <option value="photo">{t('stageC.feed.kind.photo')}</option>
                    <option value="moment">{t('stageC.feed.kind.moment')}</option>
                  </select>
                </Field>
                <Field label={t('stageC.feed.title')} htmlFor="feed-title">
                  <input
                    id="feed-title"
                    className="uf-input"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    maxLength={200}
                  />
                </Field>
                <Field label={t('stageC.feed.body')} htmlFor="feed-body">
                  <textarea
                    id="feed-body"
                    className="uf-input min-h-24"
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                    maxLength={20000}
                  />
                </Field>
                <Field label={t('stageC.feed.tags')} htmlFor="feed-tags">
                  <input
                    id="feed-tags"
                    className="uf-input"
                    value={tags}
                    onChange={(event) => setTags(event.target.value)}
                    placeholder="дом, отпуск"
                  />
                </Field>
                <Field label={t('stageC.feed.visibility')} htmlFor="feed-visibility">
                  <select
                    id="feed-visibility"
                    className="uf-select"
                    value={visibility}
                    onChange={(event) =>
                      setVisibility(event.target.value as 'household' | 'network')
                    }
                  >
                    <option value="household">{t('stageC.feed.visibility.household')}</option>
                    <option value="network">{t('stageC.feed.visibility.network')}</option>
                  </select>
                </Field>
                <Button type="submit" variant="primary" loading={busy} disabled={!online}>
                  <Lucide.Send className="h-4 w-4" aria-hidden="true" />
                  {t('common.create')}
                </Button>
              </form>
            </Card>

            <Card className="p-5">
              <h2 className="mb-3 text-lg font-bold">{t('stageC.feed.sources')}</h2>
              <div className="space-y-2">
                {SOURCES.map((source) => (
                  <label key={source} className="flex items-center justify-between gap-2 text-sm">
                    <span>{t(`stageC.feed.sources.${source}`)}</span>
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[var(--accent)]"
                      checked={sources.includes(source)}
                      onChange={() => void toggleSource(source)}
                    />
                  </label>
                ))}
              </div>
              <p className="mt-3 text-xs leading-5 text-[var(--muted)]">
                {t('stageC.feed.autoEvents')}: {t('stageC.common.deterministic')}
              </p>
            </Card>
          </aside>
        </div>
      )}
    </>
  );
}
