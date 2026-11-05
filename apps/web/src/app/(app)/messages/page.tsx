'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, ChatSummary } from '@ufos/contracts';
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
import { useCollaboration } from '@/lib/collaboration';
import { useRealtimeReload } from '@/lib/use-realtime';

const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉'];

export default function MessagesPage() {
  const { t, snapshot, notify, online } = useApp();
  const spaceId = snapshot?.activeSpace?.id;
  const { connected, reload, refresh } = useRealtimeReload(spaceId, ['messenger']);
  const collaboration = useCollaboration(spaceId, ['messenger']);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [threadRoot, setThreadRoot] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState('');
  const [newChatName, setNewChatName] = useState('');
  const [newChatKind, setNewChatKind] = useState<'group' | 'channel'>('group');
  const [busy, setBusy] = useState(false);
  const [moderation, setModeration] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const selectedChat = useMemo(
    () => chats.find((chat) => chat.id === selectedId) ?? null,
    [chats, selectedId],
  );

  const loadChats = useCallback(async () => {
    if (!spaceId) {
      setLoading(false);
      return;
    }
    setError(false);
    try {
      const rows = await apiFetch<ChatSummary[]>(apiPath('/messenger/chats', { spaceId }));
      setChats(rows);
      setSelectedId((current) => current || rows[0]?.id || '');
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  const loadMessages = useCallback(async () => {
    if (!spaceId || !selectedId) return;
    try {
      const rows = await apiFetch<ChatMessage[]>(
        apiPath(`/messenger/chats/${encodeURIComponent(selectedId)}/messages`, {
          spaceId,
          limit: 60,
        }),
      );
      setMessages(rows);
    } catch {
      notify(t('common.error'), 'error');
    }
  }, [notify, selectedId, spaceId, t]);

  useEffect(() => {
    void loadChats();
  }, [loadChats, reload]);

  useEffect(() => {
    void loadMessages();
    setThreadRoot(null);
  }, [loadMessages, reload]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, selectedId]);

  useEffect(() => {
    if (!spaceId || !selectedId) return;
    const timer = setTimeout(() => {
      void apiFetch(`/messenger/chats/${encodeURIComponent(selectedId)}/read`, {
        method: 'POST',
        body: { spaceId },
      }).catch(() => undefined);
    }, 800);
    return () => clearTimeout(timer);
  }, [messages.length, selectedId, spaceId]);

  useEffect(() => {
    if (collaboration.status !== 'connected' || !selectedId) return;
    collaboration.send({ type: 'presence', status: 'active', chatId: selectedId });
  }, [collaboration, selectedId]);

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!spaceId || !selectedChat || !draft.trim()) return;
    if (!online) {
      notify(t('error.offlineSave'), 'error');
      return;
    }
    setBusy(true);
    const body = draft;
    setDraft('');
    try {
      await apiFetch(`/messenger/chats/${encodeURIComponent(selectedChat.id)}/messages`, {
        method: 'POST',
        body: {
          spaceId,
          body,
          threadRootId: threadRoot,
          clientKey: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        },
      });
      await loadMessages();
      refresh();
    } catch {
      setDraft(body);
      notify(t('common.error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const createChat = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!spaceId || !newChatName.trim()) return;
    setBusy(true);
    try {
      const created = await apiFetch<ChatSummary>('/messenger/chats', {
        method: 'POST',
        body: { spaceId, kind: newChatKind, name: newChatName.trim(), visibility: 'space' },
      });
      setNewChatName('');
      setShowSetup(false);
      await loadChats();
      setSelectedId(created.id);
    } catch {
      notify(t('common.error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const react = async (message: ChatMessage, emoji: string) => {
    if (!spaceId || !selectedChat) return;
    try {
      await apiFetch(`/messenger/messages/${encodeURIComponent(message.id)}/reactions`, {
        method: 'POST',
        body: { spaceId, chatId: selectedChat.id, emoji },
      });
      await loadMessages();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const togglePin = async (message: ChatMessage) => {
    if (!spaceId || !selectedChat) return;
    try {
      await apiFetch(`/messenger/messages/${encodeURIComponent(message.id)}/pin`, {
        method: 'POST',
        body: { spaceId, chatId: selectedChat.id, pinned: !message.pinned },
      });
      await loadMessages();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const saveEdit = async (message: ChatMessage) => {
    if (!spaceId || !selectedChat || !editingBody.trim()) return;
    try {
      await apiFetch(`/messenger/messages/${encodeURIComponent(message.id)}`, {
        method: 'PATCH',
        body: { spaceId, chatId: selectedChat.id, body: editingBody },
      });
      setEditingId(null);
      setEditingBody('');
      await loadMessages();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const removeMessage = async (message: ChatMessage, reason = '') => {
    if (!spaceId || !selectedChat) return;
    try {
      await apiFetch(
        apiPath(`/messenger/messages/${encodeURIComponent(message.id)}`, {
          spaceId,
          chatId: selectedChat.id,
          reason,
        }),
        { method: 'DELETE' },
      );
      await loadMessages();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const setNotificationLevel = async (level: 'all' | 'mentions' | 'muted') => {
    if (!spaceId || !selectedChat) return;
    try {
      await apiFetch(`/messenger/chats/${encodeURIComponent(selectedChat.id)}/notifications`, {
        method: 'PATCH',
        body: { spaceId, level },
      });
      await loadChats();
    } catch {
      notify(t('common.error'), 'error');
    }
  };

  const visibleMessages = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    if (!term) return messages;
    return messages.filter((message) => message.body.toLocaleLowerCase().includes(term));
  }, [messages, search]);

  const statusTone =
    collaboration.status === 'connected'
      ? 'success'
      : collaboration.status === 'offline'
        ? 'danger'
        : 'warning';

  return (
    <>
      <PageHeader
        eyebrow={t('stageC.badge')}
        title={t('modules.messenger')}
        description={t('stageC.messenger.subtitle')}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone}>
              <Lucide.Radio className="h-3.5 w-3.5" aria-hidden="true" />
              {t(
                `stageC.calls.${collaboration.status === 'connected' ? 'connected' : 'reconnecting'}`,
              )}
            </Badge>
            <Badge tone={(connected ? 'success' : 'warning') as 'success' | 'warning'}>
              {t('stageC.common.realtime')}
            </Badge>
            <Button onClick={() => setShowSetup((value) => !value)}>
              <Lucide.Plus className="h-4 w-4" aria-hidden="true" />
              {t('stageC.messenger.newChat')}
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
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          <div className="uf-skeleton h-96" />
          <div className="uf-skeleton h-96" />
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
          <div className="space-y-4">
            {showSetup ? (
              <Card className="p-5">
                <form onSubmit={createChat} className="space-y-3">
                  <Field label={t('stageC.messenger.chatName')} htmlFor="chat-name">
                    <input
                      id="chat-name"
                      className="uf-input"
                      value={newChatName}
                      onChange={(event) => setNewChatName(event.target.value)}
                      maxLength={120}
                      required
                    />
                  </Field>
                  <Field label={t('common.kind')} htmlFor="chat-kind">
                    <select
                      id="chat-kind"
                      className="uf-select"
                      value={newChatKind}
                      onChange={(event) =>
                        setNewChatKind(event.target.value as 'group' | 'channel')
                      }
                    >
                      <option value="group">{t('stageC.messenger.kind.group')}</option>
                      <option value="channel">{t('stageC.messenger.kind.channel')}</option>
                    </select>
                  </Field>
                  <Button type="submit" variant="primary" loading={busy}>
                    {t('common.create')}
                  </Button>
                </form>
              </Card>
            ) : null}

            <Card className="p-4">
              <ul className="space-y-2">
                {chats.length === 0 ? (
                  <li className="p-3 text-sm text-[var(--muted)]">
                    {t('stageC.messenger.noChats')}
                  </li>
                ) : null}
                {chats.map((chat) => (
                  <li key={chat.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(chat.id)}
                      aria-current={chat.id === selectedId ? 'true' : undefined}
                      className={`w-full rounded-2xl border p-3 text-left transition ${
                        chat.id === selectedId
                          ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                          : 'border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]'
                      }`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate font-bold">
                          {chat.name || t('stageC.messenger.kind.direct')}
                        </span>
                        {chat.unreadCount > 0 ? (
                          <Badge tone="accent">{chat.unreadCount}</Badge>
                        ) : null}
                      </span>
                      <span className="mt-1 block truncate text-xs text-[var(--muted)]">
                        {chat.lastMessagePreview || chat.topic || t('common.noData')}
                      </span>
                      <span className="mt-2 flex flex-wrap items-center gap-2 text-[0.68rem] text-[var(--muted)]">
                        <Badge>{t(`stageC.messenger.kind.${chat.kind}`)}</Badge>
                        <span>
                          {chat.members.length} {t('stageC.messenger.members').toLocaleLowerCase()}
                        </span>
                        {chat.mentionCount > 0 ? (
                          <Badge tone="warning">
                            {chat.mentionCount} {t('stageC.messenger.mentions').toLocaleLowerCase()}
                          </Badge>
                        ) : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          <Card className="flex min-h-[36rem] flex-col p-0">
            {!selectedChat ? (
              <div className="p-8">
                <EmptyState icon="MessagesSquare" title={t('stageC.messenger.noChats')} />
              </div>
            ) : (
              <>
                <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] p-4">
                  <div>
                    <h2 className="text-lg font-bold">
                      {selectedChat.name || t('stageC.messenger.kind.direct')}
                    </h2>
                    <p className="text-xs text-[var(--muted)]">
                      {selectedChat.topic || selectedChat.description || '—'}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      className="uf-select max-w-44 text-xs"
                      aria-label={t('stageC.messenger.notifications')}
                      value={selectedChat.myNotificationLevel}
                      onChange={(event) =>
                        void setNotificationLevel(
                          event.target.value as 'all' | 'mentions' | 'muted',
                        )
                      }
                    >
                      <option value="all">{t('stageC.messenger.allMessages')}</option>
                      <option value="mentions">{t('stageC.messenger.mentionsOnly')}</option>
                      <option value="muted">{t('stageC.messenger.mute')}</option>
                    </select>
                    <Button onClick={() => setModeration((value) => !value)}>
                      <Lucide.ShieldAlert className="h-4 w-4" aria-hidden="true" />
                      {t('stageC.messenger.moderation')}
                    </Button>
                  </div>
                </header>

                <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-3">
                  <label className="flex-1">
                    <span className="sr-only">{t('stageC.messenger.search')}</span>
                    <input
                      className="uf-input"
                      placeholder={t('stageC.messenger.search')}
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </label>
                  {selectedChat.members.slice(0, 6).map((member) => (
                    <Avatar
                      key={member.userId}
                      name={member.displayName}
                      color={member.avatarColor}
                    />
                  ))}
                </div>

                <div className="flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
                  {visibleMessages.length === 0 ? (
                    <p className="text-sm text-[var(--muted)]">{t('common.noData')}</p>
                  ) : null}
                  {visibleMessages.map((message) => (
                    <article
                      key={message.id}
                      className={`uf-card-soft p-3 ${message.pinned ? 'border-[var(--accent)]' : ''}`}
                    >
                      <div className="flex items-start gap-3">
                        <Avatar
                          name={message.authorName || '—'}
                          color={message.authorAvatarColor}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
                            <span className="font-bold text-[var(--text)]">
                              {message.authorName || '—'}
                            </span>
                            <time dateTime={message.createdAt}>
                              {new Date(message.createdAt).toLocaleString()}
                            </time>
                            {message.editedAt ? (
                              <Badge>{t('stageC.messenger.edited')}</Badge>
                            ) : null}
                            {message.pinned ? (
                              <Badge tone="accent">
                                <Lucide.Pin className="h-3 w-3" aria-hidden="true" />
                              </Badge>
                            ) : null}
                            {message.threadRootId ? (
                              <Badge tone="accent">
                                <Lucide.MessageSquareReply className="h-3 w-3" aria-hidden="true" />
                                {t('stageC.messenger.thread')}
                              </Badge>
                            ) : null}
                          </div>

                          {message.deletedAt ? (
                            <p className="mt-2 text-sm italic text-[var(--muted)]">
                              {t('stageC.messenger.deleted')}
                            </p>
                          ) : editingId === message.id ? (
                            <div className="mt-2 space-y-2">
                              <textarea
                                className="uf-input min-h-20"
                                value={editingBody}
                                onChange={(event) => setEditingBody(event.target.value)}
                                aria-label={t('stageC.messenger.edit')}
                              />
                              <div className="flex gap-2">
                                <Button
                                  variant="primary"
                                  onClick={() => void saveEdit(message)}
                                  loading={busy}
                                >
                                  {t('common.save')}
                                </Button>
                                <Button onClick={() => setEditingId(null)}>
                                  {t('common.cancel')}
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <p className="mt-2 whitespace-pre-wrap break-words text-sm">
                              {message.body}
                            </p>
                          )}

                          {message.attachments.length > 0 ? (
                            <ul className="mt-2 space-y-1 text-xs">
                              {message.attachments.map((attachment) => (
                                <li key={attachment.id}>
                                  <a
                                    className="text-[var(--accent-strong)] underline"
                                    href={attachment.url}
                                    rel="noreferrer noopener"
                                    target="_blank"
                                  >
                                    {attachment.name}
                                  </a>
                                </li>
                              ))}
                            </ul>
                          ) : null}

                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            {message.reactions.map((reaction) => (
                              <button
                                key={reaction.emoji}
                                type="button"
                                className="uf-reaction"
                                onClick={() => void react(message, reaction.emoji)}
                                aria-label={`${reaction.emoji} ${reaction.userIds.length}`}
                              >
                                {reaction.emoji} {reaction.userIds.length}
                              </button>
                            ))}
                            {QUICK_REACTIONS.map((emoji) => (
                              <button
                                key={emoji}
                                type="button"
                                className="uf-reaction opacity-60 hover:opacity-100"
                                onClick={() => void react(message, emoji)}
                                aria-label={`${t('stageC.feed.react')} ${emoji}`}
                              >
                                {emoji}
                              </button>
                            ))}
                            <Button onClick={() => setThreadRoot(message.id)}>
                              <Lucide.MessageSquareReply
                                className="h-3.5 w-3.5"
                                aria-hidden="true"
                              />
                              {t('stageC.messenger.reply')}
                              {message.replyCount > 0 ? ` (${message.replyCount})` : ''}
                            </Button>
                            <Button onClick={() => void togglePin(message)}>
                              <Lucide.Pin className="h-3.5 w-3.5" aria-hidden="true" />
                            </Button>
                            {!message.deletedAt ? (
                              <Button
                                onClick={() => {
                                  setEditingId(message.id);
                                  setEditingBody(message.body);
                                }}
                              >
                                <Lucide.Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                              </Button>
                            ) : null}
                            <Button variant="danger" onClick={() => void removeMessage(message)}>
                              <Lucide.Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            </Button>
                            <span className="text-[0.62rem] text-[var(--muted)]">
                              {t('stageC.messenger.readReceipts')}: {message.deliveredCount}/
                              {message.readCount}
                            </span>
                          </div>
                        </div>
                      </div>
                    </article>
                  ))}
                  <div ref={bottomRef} />
                </div>

                {moderation ? (
                  <div className="border-t border-[var(--border)] p-4">
                    <h3 className="mb-2 text-sm font-bold">{t('stageC.messenger.moderation')}</h3>
                    <div className="flex flex-wrap gap-2">
                      {selectedChat.members
                        .filter((member) => member.userId !== snapshot?.user.id)
                        .map((member) => (
                          <Button
                            key={member.userId}
                            onClick={() =>
                              void apiFetch(
                                `/messenger/chats/${encodeURIComponent(selectedChat.id)}/moderation`,
                                {
                                  method: 'POST',
                                  body: {
                                    spaceId,
                                    action: 'restrict_member',
                                    targetUserId: member.userId,
                                    reason: 'семейная модерация',
                                  },
                                },
                              )
                                .then(() => notify(t('common.saved'), 'success'))
                                .catch(() => notify(t('common.error'), 'error'))
                            }
                          >
                            <Lucide.UserX className="h-3.5 w-3.5" aria-hidden="true" />
                            {t('stageC.messenger.restrictMember')}: {member.displayName}
                          </Button>
                        ))}
                    </div>
                    <p className="mt-2 text-xs text-[var(--muted)]">
                      {t('stageC.messenger.moderationLog')}: {t('common.private')}
                    </p>
                  </div>
                ) : null}

                <form
                  onSubmit={(event) => void send(event)}
                  className="border-t border-[var(--border)] p-4"
                >
                  {threadRoot ? (
                    <div className="mb-2 flex items-center justify-between gap-2 text-xs">
                      <Badge tone="accent">{t('stageC.messenger.thread')}</Badge>
                      <Button onClick={() => setThreadRoot(null)}>{t('common.cancel')}</Button>
                    </div>
                  ) : null}
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="min-w-48 flex-1">
                      <span className="sr-only">{t('stageC.messenger.message')}</span>
                      <textarea
                        className="uf-input min-h-16"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder={t('stageC.messenger.message')}
                        maxLength={8000}
                      />
                    </label>
                    <Button type="submit" variant="primary" loading={busy} disabled={!online}>
                      <Lucide.Send className="h-4 w-4" aria-hidden="true" />
                      {t('stageC.messenger.send')}
                    </Button>
                  </div>
                  <p className="mt-2 text-[0.68rem] text-[var(--muted)]">
                    {t('stageC.messenger.clientKey')}
                  </p>
                </form>
              </>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
