'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  DecisionHistoryEntry,
  Poll,
  Proposal,
  SpaceGovernance,
  Wishlist,
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
import { useRealtimeReload } from '@/lib/use-realtime';

type Tab = 'polls' | 'proposals' | 'wishlists' | 'history' | 'governance';

const TABS: Tab[] = ['polls', 'proposals', 'wishlists', 'history', 'governance'];

export default function DecisionsPage() {
  const { t, snapshot, notify, online } = useApp();
  const spaceId = snapshot?.activeSpace?.id;
  const { reload, refresh } = useRealtimeReload(spaceId, ['decisions']);
  const [tab, setTab] = useState<Tab>('polls');
  const [polls, setPolls] = useState<Poll[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [wishlists, setWishlists] = useState<Wishlist[]>([]);
  const [history, setHistory] = useState<DecisionHistoryEntry[]>([]);
  const [governance, setGovernance] = useState<SpaceGovernance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multiChoice, setMultiChoice] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [quorumPercent, setQuorumPercent] = useState(50);
  const [votingRule, setVotingRule] = useState<'majority' | 'two_thirds' | 'unanimous'>('majority');

  const [proposalTitle, setProposalTitle] = useState('');
  const [proposalBody, setProposalBody] = useState('');
  const [wishlistTitle, setWishlistTitle] = useState('');
  const [wishlistOccasion, setWishlistOccasion] = useState('');
  const [wishItems, setWishItems] = useState<Record<string, string>>({});
  const [governanceDraft, setGovernanceDraft] = useState({
    quorumPercent: 50,
    votingRule: 'majority' as 'majority' | 'two_thirds' | 'unanimous',
    allowAbstain: true,
    defaultDurationHours: 72,
    autoClosePolls: true,
  });

  const load = useCallback(async () => {
    if (!spaceId) {
      setLoading(false);
      return;
    }
    setError(false);
    try {
      const [pollRows, proposalRows, wishlistRows, historyRows, governanceRow] = await Promise.all([
        apiFetch<Poll[]>(apiPath('/decisions/polls', { spaceId })),
        apiFetch<Proposal[]>(apiPath('/decisions/proposals', { spaceId })),
        apiFetch<Wishlist[]>(apiPath('/decisions/wishlists', { spaceId })),
        apiFetch<DecisionHistoryEntry[]>(apiPath('/decisions/history', { spaceId, limit: 40 })),
        apiFetch<SpaceGovernance>(apiPath('/decisions/governance', { spaceId })),
      ]);
      setPolls(pollRows);
      setProposals(proposalRows);
      setWishlists(wishlistRows);
      setHistory(historyRows);
      setGovernance(governanceRow);
      setGovernanceDraft({
        quorumPercent: governanceRow.quorumPercent,
        votingRule: governanceRow.votingRule,
        allowAbstain: governanceRow.allowAbstain,
        defaultDurationHours: governanceRow.defaultDurationHours,
        autoClosePolls: governanceRow.autoClosePolls,
      });
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  useEffect(() => {
    void load();
  }, [load, reload]);

  const run = async (path: string, body: Record<string, unknown>, method = 'POST') => {
    if (!spaceId) return null;
    if (!online) {
      notify(t('error.offlineSave'), 'error');
      return null;
    }
    setBusy(true);
    try {
      const result = await apiFetch<Record<string, unknown>>(path, { method, body });
      await load();
      refresh();
      return result;
    } catch {
      notify(t('common.error'), 'error');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const createPoll = async (event: React.FormEvent) => {
    event.preventDefault();
    const cleaned = options.filter((option) => option.trim());
    if (!question.trim() || cleaned.length < 2) {
      notify(t('common.error'), 'error');
      return;
    }
    const result = await run('/decisions/polls', {
      spaceId,
      question: question.trim(),
      options: cleaned.map((label, index) => ({
        key: `opt-${index + 1}`,
        label: label.trim(),
      })),
      multiChoice,
      anonymous,
      quorumPercent,
      votingRule,
    });
    if (result) {
      setQuestion('');
      setOptions(['', '']);
    }
  };

  const vote = (poll: Poll, optionKey: string) => {
    const current = new Set(poll.myVote);
    if (poll.multiChoice) {
      if (current.has(optionKey)) current.delete(optionKey);
      else current.add(optionKey);
    } else {
      current.clear();
      current.add(optionKey);
    }
    return run(`/decisions/polls/${encodeURIComponent(poll.id)}/votes`, {
      spaceId,
      optionKeys: [...current],
    });
  };

  const abstainLike = () => notify(t('stageC.decisions.participation'), 'info');

  const voteProposal = (proposal: Proposal, choice: 'yes' | 'no' | 'abstain') =>
    run(`/decisions/proposals/${encodeURIComponent(proposal.id)}/votes`, {
      spaceId,
      choice,
      comment: '',
    });

  return (
    <>
      <PageHeader
        eyebrow={t('stageC.badge')}
        title={t('modules.decisions')}
        description={t('stageC.decisions.subtitle')}
        action={
          <div className="uf-pill-row">
            {governance ? (
              <Badge tone="accent">
                <Lucide.Scale className="h-3.5 w-3.5" aria-hidden="true" />
                {t('stageC.decisions.quorum')} {governance.quorumPercent}% ·{' '}
                {t(`stageC.decisions.rule.${governance.votingRule}`)}
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
        <div className="uf-skeleton h-72" />
      ) : (
        <>
          <div className="uf-pill-row mb-5" role="tablist" aria-label={t('modules.decisions')}>
            {TABS.map((entry) => (
              <Button
                key={entry}
                role="tab"
                aria-selected={tab === entry}
                variant={tab === entry ? 'primary' : 'default'}
                onClick={() => setTab(entry)}
              >
                {t(
                  entry === 'governance'
                    ? 'stageC.decisions.governance'
                    : `stageC.decisions.${entry}`,
                )}
              </Button>
            ))}
          </div>

          {tab === 'polls' ? (
            <div className="uf-split uf-split-main">
              <div className="space-y-4">
                {polls.length === 0 ? <EmptyState icon="Vote" title={t('common.noData')} /> : null}
                {polls.map((poll) => (
                  <Card key={poll.id} className="p-5">
                    <header className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h2 className="text-lg font-bold">{poll.question}</h2>
                        {poll.description ? (
                          <p className="mt-1 text-sm text-[var(--muted)]">{poll.description}</p>
                        ) : null}
                      </div>
                      <div className="uf-pill-row">
                        <Badge tone={poll.status === 'open' ? 'accent' : 'default'}>
                          {t(`stageC.decisions.${poll.status}`)}
                        </Badge>
                        <Badge tone={poll.quorumMet ? 'success' : 'warning'}>
                          {poll.quorumMet
                            ? t('stageC.decisions.quorumMet')
                            : t('stageC.decisions.quorumMissing')}
                        </Badge>
                        {poll.anonymous ? <Badge>{t('stageC.decisions.anonymous')}</Badge> : null}
                      </div>
                    </header>

                    <p className="mt-3 text-xs text-[var(--muted)]">
                      {t('stageC.decisions.participation')}: {poll.totalVoters}/
                      {poll.eligibleVoters} ({poll.participationPercent}%) ·{' '}
                      {t('stageC.decisions.quorum')} {poll.quorumPercent}% ·{' '}
                      {t(`stageC.decisions.rule.${poll.votingRule}`)}
                    </p>
                    <div className="uf-quorum-bar mt-2" aria-hidden="true">
                      <span style={{ width: `${Math.min(poll.participationPercent, 100)}%` }} />
                    </div>

                    <div className="mt-4 space-y-2">
                      {poll.options.map((option) => {
                        const selected = poll.myVote.includes(option.key);
                        const share =
                          poll.totalVoters === 0
                            ? 0
                            : Math.round((option.votes / poll.totalVoters) * 100);
                        return (
                          <button
                            key={option.key}
                            type="button"
                            disabled={poll.status !== 'open'}
                            onClick={() => void vote(poll, option.key)}
                            aria-pressed={selected}
                            className={`w-full rounded-2xl border p-3 text-left transition ${
                              selected
                                ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                                : 'border-[var(--border)] bg-[var(--surface)]'
                            } disabled:opacity-70`}
                          >
                            <span className="flex items-center justify-between gap-3 text-sm font-bold">
                              <span>
                                {option.wins ? (
                                  <Lucide.Trophy
                                    className="mr-1 inline h-4 w-4 text-[var(--success)]"
                                    aria-hidden="true"
                                  />
                                ) : null}
                                {option.label}
                              </span>
                              <span className="text-xs text-[var(--muted)]">
                                {option.votes} · {share}%
                              </span>
                            </span>
                            <span className="uf-quorum-bar mt-2 block" aria-hidden="true">
                              <span style={{ width: `${share}%` }} />
                            </span>
                            {!poll.anonymous && option.voters.length > 0 ? (
                              <span className="mt-2 flex flex-wrap gap-1">
                                {option.voters.map((voter) => (
                                  <Avatar
                                    key={`${option.key}-${voter.userId}`}
                                    name={voter.displayName || voter.userId.slice(-4)}
                                    size="sm"
                                  />
                                ))}
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {poll.status === 'open' ? (
                        <Button
                          loading={busy}
                          onClick={() =>
                            void run(`/decisions/polls/${encodeURIComponent(poll.id)}/close`, {
                              spaceId,
                              reason: 'manual',
                            })
                          }
                        >
                          <Lucide.Lock className="h-4 w-4" aria-hidden="true" />
                          {t('stageC.decisions.close')}
                        </Button>
                      ) : poll.winningOptionKey ? (
                        <Badge tone="success">
                          {t('stageC.decisions.winner')}:{' '}
                          {
                            poll.options.find((option) => option.key === poll.winningOptionKey)
                              ?.label
                          }
                        </Badge>
                      ) : (
                        <Badge tone="warning">{t('stageC.decisions.tie')}</Badge>
                      )}
                      <Button onClick={abstainLike} variant="ghost">
                        <Lucide.Info className="h-4 w-4" aria-hidden="true" />
                        {t('common.reason')}
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>

              <aside>
                <Card className="p-5">
                  <h2 className="mb-3 text-lg font-bold">{t('stageC.decisions.newPoll')}</h2>
                  <form onSubmit={createPoll} className="space-y-3">
                    <Field label={t('stageC.decisions.question')} htmlFor="poll-question">
                      <input
                        id="poll-question"
                        className="uf-input"
                        value={question}
                        onChange={(event) => setQuestion(event.target.value)}
                        maxLength={300}
                        required
                      />
                    </Field>
                    <fieldset className="space-y-2">
                      <legend className="uf-label">{t('stageC.decisions.options')}</legend>
                      {options.map((option, index) => (
                        <div key={index} className="flex gap-2">
                          <input
                            className="uf-input"
                            value={option}
                            aria-label={`${t('stageC.decisions.options')} ${index + 1}`}
                            onChange={(event) =>
                              setOptions((current) =>
                                current.map((entry, position) =>
                                  position === index ? event.target.value : entry,
                                ),
                              )
                            }
                            maxLength={200}
                          />
                          {options.length > 2 ? (
                            <Button
                              type="button"
                              onClick={() =>
                                setOptions((current) =>
                                  current.filter((_, position) => position !== index),
                                )
                              }
                              aria-label={t('common.cancel')}
                            >
                              <Lucide.Trash2 className="h-4 w-4" aria-hidden="true" />
                            </Button>
                          ) : null}
                        </div>
                      ))}
                      <Button
                        type="button"
                        onClick={() => setOptions((current) => [...current, ''])}
                        disabled={options.length >= 20}
                      >
                        <Lucide.Plus className="h-4 w-4" aria-hidden="true" />
                        {t('stageC.decisions.addOption')}
                      </Button>
                    </fieldset>
                    <label className="flex items-center justify-between gap-2 text-sm">
                      {t('stageC.decisions.multiChoice')}
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[var(--accent)]"
                        checked={multiChoice}
                        onChange={(event) => setMultiChoice(event.target.checked)}
                      />
                    </label>
                    <label className="flex items-center justify-between gap-2 text-sm">
                      {t('stageC.decisions.anonymous')}
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[var(--accent)]"
                        checked={anonymous}
                        onChange={(event) => setAnonymous(event.target.checked)}
                      />
                    </label>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label={t('stageC.decisions.quorumPercent')} htmlFor="poll-quorum">
                        <input
                          id="poll-quorum"
                          type="number"
                          min={0}
                          max={100}
                          className="uf-input"
                          value={quorumPercent}
                          onChange={(event) => setQuorumPercent(Number(event.target.value))}
                        />
                      </Field>
                      <Field label={t('stageC.decisions.votingRule')} htmlFor="poll-rule">
                        <select
                          id="poll-rule"
                          className="uf-select"
                          value={votingRule}
                          onChange={(event) =>
                            setVotingRule(
                              event.target.value as 'majority' | 'two_thirds' | 'unanimous',
                            )
                          }
                        >
                          <option value="majority">{t('stageC.decisions.rule.majority')}</option>
                          <option value="two_thirds">
                            {t('stageC.decisions.rule.two_thirds')}
                          </option>
                          <option value="unanimous">{t('stageC.decisions.rule.unanimous')}</option>
                        </select>
                      </Field>
                    </div>
                    <Button type="submit" variant="primary" loading={busy} disabled={!online}>
                      {t('common.create')}
                    </Button>
                  </form>
                </Card>
              </aside>
            </div>
          ) : null}

          {tab === 'proposals' ? (
            <div className="uf-split uf-split-main">
              <div className="space-y-4">
                {proposals.length === 0 ? (
                  <EmptyState icon="Vote" title={t('common.noData')} />
                ) : null}
                {proposals.map((proposal) => (
                  <Card key={proposal.id} className="p-5">
                    <header className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h2 className="text-lg font-bold">{proposal.title}</h2>
                        <p className="mt-1 text-xs text-[var(--muted)]">
                          {proposal.authorName} ·{' '}
                          {new Date(proposal.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                      <Badge
                        tone={
                          proposal.status === 'accepted'
                            ? 'success'
                            : proposal.status === 'rejected'
                              ? 'danger'
                              : proposal.status === 'voting'
                                ? 'accent'
                                : 'default'
                        }
                      >
                        {t(`stageC.decisions.${proposal.status}`)}
                      </Badge>
                    </header>
                    {proposal.body ? (
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{proposal.body}</p>
                    ) : null}
                    <p className="mt-3 text-xs text-[var(--muted)]">
                      {t('stageC.decisions.voteYes')}: {proposal.tallies.yes} ·{' '}
                      {t('stageC.decisions.voteNo')}: {proposal.tallies.no} ·{' '}
                      {t('stageC.decisions.voteAbstain')}: {proposal.tallies.abstain} ·{' '}
                      {t('stageC.decisions.participation')}: {proposal.participationPercent}% (
                      {proposal.eligibleVoters})
                    </p>
                    <div className="uf-quorum-bar mt-2" aria-hidden="true">
                      <span style={{ width: `${Math.min(proposal.participationPercent, 100)}%` }} />
                    </div>
                    {proposal.decisionSummary ? (
                      <p className="mt-3 text-sm font-bold">{proposal.decisionSummary}</p>
                    ) : null}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {proposal.status === 'discussion' ? (
                        <Button
                          onClick={() =>
                            void run(
                              `/decisions/proposals/${encodeURIComponent(proposal.id)}/status`,
                              {
                                spaceId,
                                status: 'voting',
                              },
                            )
                          }
                        >
                          {t('stageC.decisions.startVoting')}
                        </Button>
                      ) : null}
                      {proposal.status === 'voting' ? (
                        <>
                          {(['yes', 'no', 'abstain'] as const).map((choice) => (
                            <Button
                              key={choice}
                              variant={proposal.myVote === choice ? 'primary' : 'default'}
                              onClick={() => void voteProposal(proposal, choice)}
                            >
                              {t(
                                choice === 'yes'
                                  ? 'stageC.decisions.voteYes'
                                  : choice === 'no'
                                    ? 'stageC.decisions.voteNo'
                                    : 'stageC.decisions.voteAbstain',
                              )}
                            </Button>
                          ))}
                          <Button
                            onClick={() =>
                              void run(
                                `/decisions/proposals/${encodeURIComponent(proposal.id)}/decide`,
                                {
                                  spaceId,
                                },
                              )
                            }
                          >
                            {t('stageC.decisions.decide')}
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </Card>
                ))}
              </div>
              <aside>
                <Card className="p-5">
                  <h2 className="mb-3 text-lg font-bold">{t('stageC.decisions.newProposal')}</h2>
                  <form
                    className="space-y-3"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      const result = await run('/decisions/proposals', {
                        spaceId,
                        title: proposalTitle.trim(),
                        body: proposalBody.trim(),
                      });
                      if (result) {
                        setProposalTitle('');
                        setProposalBody('');
                      }
                    }}
                  >
                    <Field label={t('stageC.decisions.proposalTitle')} htmlFor="proposal-title">
                      <input
                        id="proposal-title"
                        className="uf-input"
                        value={proposalTitle}
                        onChange={(event) => setProposalTitle(event.target.value)}
                        maxLength={300}
                        required
                      />
                    </Field>
                    <Field label={t('stageC.feed.body')} htmlFor="proposal-body">
                      <textarea
                        id="proposal-body"
                        className="uf-input min-h-24"
                        value={proposalBody}
                        onChange={(event) => setProposalBody(event.target.value)}
                        maxLength={20000}
                      />
                    </Field>
                    <Button type="submit" variant="primary" loading={busy} disabled={!online}>
                      {t('common.create')}
                    </Button>
                  </form>
                </Card>
              </aside>
            </div>
          ) : null}

          {tab === 'wishlists' ? (
            <div className="uf-split uf-split-main">
              <div className="space-y-4">
                {wishlists.length === 0 ? (
                  <EmptyState icon="Gift" title={t('common.noData')} />
                ) : null}
                {wishlists.map((wishlist) => {
                  const mine = wishlist.ownerUserId === snapshot?.user.id;
                  return (
                    <Card key={wishlist.id} className="p-5">
                      <header className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h2 className="text-lg font-bold">{wishlist.title}</h2>
                          <p className="text-xs text-[var(--muted)]">
                            {t('stageC.decisions.owner')}: {wishlist.ownerName || '—'}
                            {wishlist.occasion ? ` · ${wishlist.occasion}` : ''}
                          </p>
                        </div>
                        {mine ? (
                          <Badge tone="accent">{t('stageC.decisions.hiddenForOwner')}</Badge>
                        ) : null}
                      </header>
                      <ul className="mt-3 space-y-2">
                        {wishlist.items.map((item) => (
                          <li
                            key={item.id}
                            className="uf-card-soft flex flex-wrap items-center justify-between gap-2 p-3"
                          >
                            <div>
                              <p className="font-bold">{item.title}</p>
                              <p className="text-xs text-[var(--muted)]">
                                {item.priceCents !== null
                                  ? `${(item.priceCents / 100).toFixed(2)} ${item.currency}`
                                  : t('stageC.decisions.price')}
                                {item.notes ? ` · ${item.notes}` : ''}
                                {item.reservedBy ? ` · ${t('stageC.decisions.reserved')}` : ''}
                                {item.purchasedBy ? ` · ${t('stageC.decisions.purchased')}` : ''}
                              </p>
                            </div>
                            {!mine ? (
                              <div className="flex flex-wrap gap-2">
                                <Button
                                  onClick={() =>
                                    void run(
                                      `/decisions/wishlists/${encodeURIComponent(wishlist.id)}/items/${encodeURIComponent(item.id)}`,
                                      { spaceId, reserved: !item.reservedBy },
                                      'PATCH',
                                    )
                                  }
                                >
                                  {item.reservedBy
                                    ? t('stageC.decisions.reserved')
                                    : t('stageC.decisions.reserve')}
                                </Button>
                                <Button
                                  variant={item.purchasedBy ? 'primary' : 'default'}
                                  onClick={() =>
                                    void run(
                                      `/decisions/wishlists/${encodeURIComponent(wishlist.id)}/items/${encodeURIComponent(item.id)}`,
                                      { spaceId, purchased: !item.purchasedBy },
                                      'PATCH',
                                    )
                                  }
                                >
                                  {t('stageC.decisions.purchased')}
                                </Button>
                              </div>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <label className="min-w-40 flex-1">
                          <span className="sr-only">{t('stageC.decisions.addItem')}</span>
                          <input
                            className="uf-input"
                            placeholder={t('stageC.decisions.addItem')}
                            value={wishItems[wishlist.id] ?? ''}
                            onChange={(event) =>
                              setWishItems((current) => ({
                                ...current,
                                [wishlist.id]: event.target.value,
                              }))
                            }
                            maxLength={200}
                          />
                        </label>
                        <Button
                          onClick={async () => {
                            const value = (wishItems[wishlist.id] ?? '').trim();
                            if (!value) return;
                            const result = await run(
                              `/decisions/wishlists/${encodeURIComponent(wishlist.id)}/items`,
                              { spaceId, title: value },
                            );
                            if (result) {
                              setWishItems((current) => ({ ...current, [wishlist.id]: '' }));
                            }
                          }}
                        >
                          <Lucide.Plus className="h-4 w-4" aria-hidden="true" />
                          {t('common.create')}
                        </Button>
                      </div>
                    </Card>
                  );
                })}
              </div>
              <aside>
                <Card className="p-5">
                  <h2 className="mb-3 text-lg font-bold">{t('stageC.decisions.newWishlist')}</h2>
                  <form
                    className="space-y-3"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      const result = await run('/decisions/wishlists', {
                        spaceId,
                        title: wishlistTitle.trim(),
                        occasion: wishlistOccasion.trim(),
                        ownerUserId: snapshot?.user.id ?? null,
                      });
                      if (result) {
                        setWishlistTitle('');
                        setWishlistOccasion('');
                      }
                    }}
                  >
                    <Field label={t('stageC.feed.title')} htmlFor="wishlist-title">
                      <input
                        id="wishlist-title"
                        className="uf-input"
                        value={wishlistTitle}
                        onChange={(event) => setWishlistTitle(event.target.value)}
                        maxLength={200}
                        required
                      />
                    </Field>
                    <Field label={t('stageC.decisions.occasion')} htmlFor="wishlist-occasion">
                      <input
                        id="wishlist-occasion"
                        className="uf-input"
                        value={wishlistOccasion}
                        onChange={(event) => setWishlistOccasion(event.target.value)}
                        maxLength={120}
                      />
                    </Field>
                    <Button type="submit" variant="primary" loading={busy} disabled={!online}>
                      {t('common.create')}
                    </Button>
                  </form>
                </Card>
              </aside>
            </div>
          ) : null}

          {tab === 'history' ? (
            <Card className="p-5">
              <h2 className="mb-4 text-lg font-bold">{t('stageC.decisions.history')}</h2>
              {history.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">{t('common.noData')}</p>
              ) : (
                <ol className="space-y-3">
                  {history.map((entry) => (
                    <li key={entry.id} className="uf-card-soft p-3">
                      <p className="text-sm font-bold">{entry.summary}</p>
                      <p className="text-xs text-[var(--muted)]">
                        {entry.entity} · {entry.action} ·{' '}
                        {new Date(entry.createdAt).toLocaleString()}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          ) : null}

          {tab === 'governance' ? (
            <Card className="max-w-xl p-5">
              <h2 className="mb-4 text-lg font-bold">{t('stageC.decisions.governance')}</h2>
              <form
                className="space-y-3"
                onSubmit={async (event) => {
                  event.preventDefault();
                  await run('/decisions/governance', { spaceId, ...governanceDraft }, 'PATCH');
                }}
              >
                <Field label={t('stageC.decisions.quorumPercent')} htmlFor="governance-quorum">
                  <input
                    id="governance-quorum"
                    type="number"
                    min={0}
                    max={100}
                    className="uf-input"
                    value={governanceDraft.quorumPercent}
                    onChange={(event) =>
                      setGovernanceDraft((current) => ({
                        ...current,
                        quorumPercent: Number(event.target.value),
                      }))
                    }
                  />
                </Field>
                <Field label={t('stageC.decisions.votingRule')} htmlFor="governance-rule">
                  <select
                    id="governance-rule"
                    className="uf-select"
                    value={governanceDraft.votingRule}
                    onChange={(event) =>
                      setGovernanceDraft((current) => ({
                        ...current,
                        votingRule: event.target.value as typeof current.votingRule,
                      }))
                    }
                  >
                    <option value="majority">{t('stageC.decisions.rule.majority')}</option>
                    <option value="two_thirds">{t('stageC.decisions.rule.two_thirds')}</option>
                    <option value="unanimous">{t('stageC.decisions.rule.unanimous')}</option>
                  </select>
                </Field>
                <Field label={t('stageC.calls.participants')} htmlFor="governance-duration">
                  <input
                    id="governance-duration"
                    type="number"
                    min={1}
                    max={720}
                    className="uf-input"
                    value={governanceDraft.defaultDurationHours}
                    onChange={(event) =>
                      setGovernanceDraft((current) => ({
                        ...current,
                        defaultDurationHours: Number(event.target.value),
                      }))
                    }
                  />
                </Field>
                <label className="flex items-center justify-between gap-2 text-sm">
                  {t('stageC.decisions.voteAbstain')}
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[var(--accent)]"
                    checked={governanceDraft.allowAbstain}
                    onChange={(event) =>
                      setGovernanceDraft((current) => ({
                        ...current,
                        allowAbstain: event.target.checked,
                      }))
                    }
                  />
                </label>
                <label className="flex items-center justify-between gap-2 text-sm">
                  {t('stageC.decisions.close')}
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[var(--accent)]"
                    checked={governanceDraft.autoClosePolls}
                    onChange={(event) =>
                      setGovernanceDraft((current) => ({
                        ...current,
                        autoClosePolls: event.target.checked,
                      }))
                    }
                  />
                </label>
                <Button type="submit" variant="primary" loading={busy} disabled={!online}>
                  {t('common.save')}
                </Button>
              </form>
            </Card>
          ) : null}
        </>
      )}
    </>
  );
}
