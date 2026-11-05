import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  DecisionHistoryEntry,
  Poll,
  PollOption,
  PollVotingRule,
  Proposal,
  ProposalStatus,
  SpaceGovernance,
  Wishlist,
} from '@ufos/contracts';
import type { z } from 'zod';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { newId } from '../config';
import type { AuthenticatedUser } from '../common/authed-request';
import { DatabaseService } from '../db/database.service';
import { iso, parseJson } from '../db/rows';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  pollOptionLabels,
  toDecisionHistoryEntry,
  toPoll,
  toProposal,
  toSpaceGovernance,
  toWishlist,
  type GovernanceRow,
  type PollRow,
  type PollVoteRow,
  type ProposalRow,
  type ProposalVoteRow,
  type WishlistItemRow,
  type WishlistRow,
} from '../stage-c/mappers';
import type {
  decisionHistoryQuerySchema,
  governanceSchema,
  pollSchema,
  pollVoteSchema,
  proposalSchema,
  proposalUpdateSchema,
  wishlistItemPatchSchema,
  wishlistItemSchema,
  wishlistSchema,
  wishlistUpdateSchema,
} from './dto';

type GovernanceInput = z.infer<typeof governanceSchema>;
type PollInput = z.infer<typeof pollSchema>;
type PollVoteInput = z.infer<typeof pollVoteSchema>;
type ProposalInput = z.infer<typeof proposalSchema>;
type ProposalPatch = z.infer<typeof proposalUpdateSchema>;
type WishlistInput = z.infer<typeof wishlistSchema>;
type WishlistPatch = z.infer<typeof wishlistUpdateSchema>;
type WishlistItemInput = z.infer<typeof wishlistItemSchema>;
type WishlistItemPatch = z.infer<typeof wishlistItemPatchSchema>;
type HistoryQuery = z.infer<typeof decisionHistoryQuerySchema>;

interface QuorumResult {
  eligibleVoters: number;
  voters: number;
  participationPercent: number;
  quorumMet: boolean;
}

function ruleSatisfied(rule: PollVotingRule, yes: number, no: number, total: number): boolean {
  const decisive = yes + no;
  if (total === 0 || decisive === 0) return false;
  if (rule === 'unanimous') return no === 0 && yes > 0;
  if (rule === 'two_thirds') return yes / decisive >= 2 / 3;
  return yes > no;
}

@Injectable()
export class DecisionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  // -------------------------------------------------------------------------
  // Governance
  // -------------------------------------------------------------------------

  async governance(user: AuthenticatedUser, spaceId: string): Promise<SpaceGovernance> {
    await this.access.assert(user.id, spaceId, 'decisions', 'read');
    const row = await this.db.queryOne<GovernanceRow>(
      'SELECT * FROM space_governance WHERE space_id = $1',
      [spaceId],
    );
    return toSpaceGovernance(row, spaceId);
  }

  async updateGovernance(
    user: AuthenticatedUser,
    spaceId: string,
    patch: GovernanceInput,
  ): Promise<SpaceGovernance> {
    await this.access.assert(user.id, spaceId, 'decisions', 'manage_access');
    const current = await this.governance(user, spaceId);
    const next = {
      quorumPercent: patch.quorumPercent ?? current.quorumPercent,
      votingRule: patch.votingRule ?? current.votingRule,
      allowAbstain: patch.allowAbstain ?? current.allowAbstain,
      defaultDurationHours: patch.defaultDurationHours ?? current.defaultDurationHours,
      autoClosePolls: patch.autoClosePolls ?? current.autoClosePolls,
    };
    await this.db.query(
      `INSERT INTO space_governance
        (space_id, quorum_percent, voting_rule, allow_abstain, default_duration_hours, auto_close_polls)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (space_id) DO UPDATE SET
         quorum_percent = EXCLUDED.quorum_percent,
         voting_rule = EXCLUDED.voting_rule,
         allow_abstain = EXCLUDED.allow_abstain,
         default_duration_hours = EXCLUDED.default_duration_hours,
         auto_close_polls = EXCLUDED.auto_close_polls,
         updated_at = CURRENT_TIMESTAMP`,
      [
        spaceId,
        next.quorumPercent,
        next.votingRule,
        next.allowAbstain,
        next.defaultDurationHours,
        next.autoClosePolls,
      ],
    );
    await this.recordHistory(spaceId, 'governance', spaceId, 'update', user.id, 'Правила кворума обновлены', {
      before: current,
      after: next,
    });
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'decisions.governance.update',
      entity: 'space_governance',
      entityId: spaceId,
      metadata: { ...next },
    });
    this.realtime.publish(spaceId, 'decisions', user.id, { action: 'governance.update' });
    return this.governance(user, spaceId);
  }

  // -------------------------------------------------------------------------
  // Polls
  // -------------------------------------------------------------------------

  async polls(user: AuthenticatedUser, spaceId: string): Promise<Poll[]> {
    await this.access.assert(user.id, spaceId, 'decisions', 'read');
    const rows = await this.db.query<PollRow>(
      'SELECT * FROM polls WHERE space_id = $1 ORDER BY created_at DESC LIMIT 100',
      [spaceId],
    );
    await this.closeExpiredPolls(spaceId);
    const refreshed = await this.db.query<PollRow>(
      'SELECT * FROM polls WHERE space_id = $1 ORDER BY created_at DESC LIMIT 100',
      [spaceId],
    );
    return Promise.all((refreshed.length > 0 ? refreshed : rows).map((row) => this.buildPoll(user, row)));
  }

  async poll(user: AuthenticatedUser, spaceId: string, id: string): Promise<Poll> {
    await this.access.assert(user.id, spaceId, 'decisions', 'read');
    const row = await this.requirePoll(spaceId, id);
    return this.buildPoll(user, row);
  }

  async createPoll(user: AuthenticatedUser, spaceId: string, input: PollInput): Promise<Poll> {
    await this.access.assert(user.id, spaceId, 'decisions', 'create');
    const governance = await this.governance(user, spaceId);
    const keys = new Set<string>();
    const options = input.options.map((option, index) => {
      const key = option.key ?? `opt-${index + 1}`;
      if (keys.has(key)) throw new BadRequestException('duplicate_option_key');
      keys.add(key);
      return { key, label: option.label };
    });
    if (input.kind === 'date') {
      for (const option of options) {
        if (Number.isNaN(Date.parse(option.label))) {
          throw new BadRequestException('date_option_must_be_iso_date');
        }
      }
    }
    const closesAt =
      input.closesAt ??
      new Date(Date.now() + governance.defaultDurationHours * 3600 * 1000).toISOString();
    const row = await this.db.queryOne<PollRow>(
      `INSERT INTO polls
        (id, space_id, kind, question, description, options, multi_choice, anonymous,
         quorum_percent, voting_rule, closes_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        newId('pol'),
        spaceId,
        input.kind,
        input.question,
        input.description,
        JSON.stringify(options),
        input.multiChoice,
        input.anonymous,
        input.quorumPercent ?? governance.quorumPercent,
        input.votingRule ?? governance.votingRule,
        closesAt,
        user.id,
      ],
    );
    if (!row) throw new NotFoundException('poll_not_created');
    await this.recordHistory(spaceId, 'poll', row.id, 'create', user.id, `Опрос: ${input.question}`, {
      question: input.question,
      options,
      closesAt,
    });
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'decisions.poll.create',
      entity: 'poll',
      entityId: row.id,
      metadata: { question: input.question, kind: input.kind },
    });
    this.realtime.publish(spaceId, 'decisions', user.id, { action: 'poll.create', pollId: row.id });
    await this.notifications.notifySpaceMembers(spaceId, {
      category: 'decisions',
      severity: 'info',
      title: 'Новый опрос',
      body: input.question,
      sourceModule: 'decisions',
      sourceId: row.id,
      actionUrl: `/decisions?poll=${row.id}`,
      dedupeKey: `poll:${row.id}`,
    });
    return this.buildPoll(user, row);
  }

  async vote(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    input: PollVoteInput,
  ): Promise<Poll> {
    await this.access.assert(user.id, spaceId, 'decisions', 'read');
    const poll = await this.requirePoll(spaceId, id);
    if (poll.status !== 'open') throw new BadRequestException('poll_closed');
    const options = parseJson<Array<{ key: string; label: string }>>(poll.options, []);
    const validKeys = new Set(options.map((option) => option.key));
    if (input.optionKeys.some((key) => !validKeys.has(key))) {
      throw new BadRequestException('unknown_option_key');
    }
    if (!poll.multi_choice && input.optionKeys.length > 1) {
      throw new BadRequestException('poll_single_choice');
    }
    const unique = [...new Set(input.optionKeys)];
    await this.db.query(
      `INSERT INTO poll_votes (poll_id, user_id, option_keys, comment, updated_at)
       VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)
       ON CONFLICT (poll_id, user_id) DO UPDATE SET
         option_keys = EXCLUDED.option_keys,
         comment = EXCLUDED.comment,
         updated_at = CURRENT_TIMESTAMP`,
      [id, user.id, JSON.stringify(unique), input.comment],
    );
    this.realtime.publish(spaceId, 'decisions', user.id, { action: 'poll.vote', pollId: id });
    const refreshed = await this.requirePoll(spaceId, id);
    if (refreshed.status === 'open') await this.maybeClosePoll(spaceId, refreshed, user.id);
    return this.poll(user, spaceId, id);
  }

  async closePoll(user: AuthenticatedUser, spaceId: string, id: string, reason: string) {
    await this.access.assert(user.id, spaceId, 'decisions', 'update');
    const poll = await this.requirePoll(spaceId, id);
    if (poll.status === 'closed') return this.buildPoll(user, poll);
    await this.finalizePoll(spaceId, poll, user.id, reason || 'manual');
    return this.poll(user, spaceId, id);
  }

  // -------------------------------------------------------------------------
  // Proposals
  // -------------------------------------------------------------------------

  async proposals(user: AuthenticatedUser, spaceId: string): Promise<Proposal[]> {
    await this.access.assert(user.id, spaceId, 'decisions', 'read');
    const rows = await this.db.query<ProposalRow>(
      `SELECT p.*, u.display_name AS author_name FROM proposals p
       LEFT JOIN users u ON u.id = p.author_user_id
       WHERE p.space_id = $1 ORDER BY p.created_at DESC LIMIT 100`,
      [spaceId],
    );
    return Promise.all(rows.map((row) => this.buildProposal(user, row)));
  }

  async proposal(user: AuthenticatedUser, spaceId: string, id: string): Promise<Proposal> {
    await this.access.assert(user.id, spaceId, 'decisions', 'read');
    const row = await this.requireProposal(spaceId, id);
    return this.buildProposal(user, row);
  }

  async createProposal(
    user: AuthenticatedUser,
    spaceId: string,
    input: ProposalInput,
  ): Promise<Proposal> {
    await this.access.assert(user.id, spaceId, 'decisions', 'create');
    const governance = await this.governance(user, spaceId);
    const row = await this.db.queryOne<ProposalRow>(
      `INSERT INTO proposals
        (id, space_id, title, body, status, author_user_id, voting_rule, quorum_percent, closes_at)
       VALUES ($1,$2,$3,$4,'discussion',$5,$6,$7,$8) RETURNING *`,
      [
        newId('prp'),
        spaceId,
        input.title,
        input.body,
        user.id,
        input.votingRule ?? governance.votingRule,
        input.quorumPercent ?? governance.quorumPercent,
        input.closesAt ??
          new Date(Date.now() + governance.defaultDurationHours * 3600 * 1000).toISOString(),
      ],
    );
    if (!row) throw new NotFoundException('proposal_not_created');
    await this.recordHistory(spaceId, 'proposal', row.id, 'create', user.id, input.title, {
      title: input.title,
      status: 'discussion',
    });
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'decisions.proposal.create',
      entity: 'proposal',
      entityId: row.id,
      metadata: { title: input.title },
    });
    this.realtime.publish(spaceId, 'decisions', user.id, {
      action: 'proposal.create',
      proposalId: row.id,
    });
    return this.buildProposal(user, { ...row, author_name: user.displayName });
  }

  async updateProposal(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    patch: ProposalPatch,
  ): Promise<Proposal> {
    await this.access.assert(user.id, spaceId, 'decisions', 'update');
    const existing = await this.requireProposal(spaceId, id);
    if (existing.author_user_id !== user.id && existing.status !== 'discussion') {
      throw new ForbiddenException('proposal_locked');
    }
    const fields: string[] = [];
    const params: unknown[] = [id];
    const push = (column: string, value: unknown) => {
      params.push(value);
      fields.push(`${column} = $${params.length}`);
    };
    if (patch.title !== undefined) push('title', patch.title);
    if (patch.body !== undefined) push('body', patch.body);
    if (fields.length === 0) return this.proposal(user, spaceId, id);
    await this.db.query(
      `UPDATE proposals SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      params,
    );
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'decisions.proposal.update',
      entity: 'proposal',
      entityId: id,
      metadata: { fields: Object.keys(patch) },
    });
    this.realtime.publish(spaceId, 'decisions', user.id, {
      action: 'proposal.update',
      proposalId: id,
    });
    return this.proposal(user, spaceId, id);
  }

  async transitionProposal(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    status: 'discussion' | 'voting' | 'withdrawn',
  ): Promise<Proposal> {
    await this.access.assert(user.id, spaceId, 'decisions', 'update');
    const existing = await this.requireProposal(spaceId, id);
    if (existing.status === 'accepted' || existing.status === 'rejected') {
      throw new BadRequestException('proposal_already_decided');
    }
    if (status === 'withdrawn' && existing.author_user_id !== user.id) {
      const canManage = await this.access
        .assert(user.id, spaceId, 'decisions', 'manage_access')
        .then(() => true)
        .catch(() => false);
      if (!canManage) throw new ForbiddenException('proposal_author_or_manager_required');
    }
    const opensAt = status === 'voting' ? new Date().toISOString() : null;
    await this.db.query(
      `UPDATE proposals SET status = $2, opens_at = COALESCE($3, opens_at),
         updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [id, status, opensAt],
    );
    await this.recordHistory(spaceId, 'proposal', id, `status:${status}`, user.id, existing.title, {
      from: existing.status,
      to: status,
    });
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'decisions.proposal.status',
      entity: 'proposal',
      entityId: id,
      metadata: { from: existing.status, to: status },
    });
    this.realtime.publish(spaceId, 'decisions', user.id, {
      action: 'proposal.status',
      proposalId: id,
    });
    if (status === 'voting') {
      await this.notifications.notifySpaceMembers(spaceId, {
        category: 'decisions',
        severity: 'important',
        title: 'Голосование по предложению',
        body: existing.title,
        sourceModule: 'decisions',
        sourceId: id,
        actionUrl: `/decisions?proposal=${id}`,
        dedupeKey: `proposal-vote:${id}`,
      });
    }
    return this.proposal(user, spaceId, id);
  }

  async voteProposal(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    choice: 'yes' | 'no' | 'abstain',
    comment: string,
  ): Promise<Proposal> {
    await this.access.assert(user.id, spaceId, 'decisions', 'read');
    const existing = await this.requireProposal(spaceId, id);
    if (existing.status !== 'voting') throw new BadRequestException('proposal_not_voting');
    const governance = await this.governance(user, spaceId);
    if (choice === 'abstain' && !governance.allowAbstain) {
      throw new BadRequestException('abstain_not_allowed');
    }
    await this.db.query(
      `INSERT INTO proposal_votes (proposal_id, user_id, choice, comment, updated_at)
       VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)
       ON CONFLICT (proposal_id, user_id) DO UPDATE SET
         choice = EXCLUDED.choice, comment = EXCLUDED.comment, updated_at = CURRENT_TIMESTAMP`,
      [id, user.id, choice, comment],
    );
    this.realtime.publish(spaceId, 'decisions', user.id, {
      action: 'proposal.vote',
      proposalId: id,
    });
    await this.maybeDecideProposal(spaceId, existing, user.id);
    return this.proposal(user, spaceId, id);
  }

  async decideProposal(user: AuthenticatedUser, spaceId: string, id: string) {
    await this.access.assert(user.id, spaceId, 'decisions', 'update');
    const existing = await this.requireProposal(spaceId, id);
    if (existing.status !== 'voting') throw new BadRequestException('proposal_not_voting');
    await this.finalizeProposal(spaceId, existing, user.id, 'manual');
    return this.proposal(user, spaceId, id);
  }

  // -------------------------------------------------------------------------
  // Wishlists
  // -------------------------------------------------------------------------

  async wishlists(user: AuthenticatedUser, spaceId: string): Promise<Wishlist[]> {
    await this.access.assert(user.id, spaceId, 'decisions', 'read');
    const rows = await this.db.query<WishlistRow>(
      `SELECT w.*, u.display_name AS owner_name FROM wishlists w
       LEFT JOIN users u ON u.id = w.owner_user_id
       WHERE w.space_id = $1 ORDER BY w.created_at DESC`,
      [spaceId],
    );
    const items = await this.db.query<WishlistItemRow>(
      `SELECT i.* FROM wishlist_items i JOIN wishlists w ON w.id = i.wishlist_id
       WHERE w.space_id = $1 ORDER BY i.created_at ASC`,
      [spaceId],
    );
    return rows.map((row) =>
      toWishlist(
        row,
        items.filter((item) => item.wishlist_id === row.id),
        user.id,
      ),
    );
  }

  async createWishlist(
    user: AuthenticatedUser,
    spaceId: string,
    input: WishlistInput,
  ): Promise<Wishlist> {
    await this.access.assert(user.id, spaceId, 'decisions', 'create');
    const owner = await this.resolveOwner(spaceId, input.ownerUserId);
    const row = await this.db.queryOne<WishlistRow>(
      `INSERT INTO wishlists
        (id, space_id, title, owner_user_id, visibility, occasion, due_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        newId('wsh'),
        spaceId,
        input.title,
        owner ?? user.id,
        input.visibility,
        input.occasion,
        input.dueAt ?? null,
        user.id,
      ],
    );
    if (!row) throw new NotFoundException('wishlist_not_created');
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'decisions.wishlist.create',
      entity: 'wishlist',
      entityId: row.id,
      metadata: { title: input.title },
    });
    this.realtime.publish(spaceId, 'decisions', user.id, {
      action: 'wishlist.create',
      wishlistId: row.id,
    });
    return toWishlist({ ...row, owner_name: input.ownerUserId === user.id ? user.displayName : '' }, [], user.id);
  }

  async updateWishlist(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    patch: WishlistPatch,
  ): Promise<Wishlist> {
    await this.access.assert(user.id, spaceId, 'decisions', 'update');
    await this.requireWishlist(spaceId, id);
    const fields: string[] = [];
    const params: unknown[] = [id];
    const push = (column: string, value: unknown) => {
      params.push(value);
      fields.push(`${column} = $${params.length}`);
    };
    if (patch.title !== undefined) push('title', patch.title);
    if (patch.visibility !== undefined) push('visibility', patch.visibility);
    if (patch.occasion !== undefined) push('occasion', patch.occasion);
    if (patch.dueAt !== undefined) push('due_at', patch.dueAt);
    if (patch.ownerUserId !== undefined) {
      push('owner_user_id', await this.resolveOwner(spaceId, patch.ownerUserId));
    }
    if (fields.length > 0) {
      await this.db.query(`UPDATE wishlists SET ${fields.join(', ')} WHERE id = $1`, params);
    }
    this.realtime.publish(spaceId, 'decisions', user.id, {
      action: 'wishlist.update',
      wishlistId: id,
    });
    const list = (await this.wishlists(user, spaceId)).find((entry) => entry.id === id);
    if (!list) throw new NotFoundException('wishlist_not_found');
    return list;
  }

  async deleteWishlist(user: AuthenticatedUser, spaceId: string, id: string) {
    await this.access.assert(user.id, spaceId, 'decisions', 'delete');
    await this.requireWishlist(spaceId, id);
    await this.db.query('DELETE FROM wishlists WHERE id = $1', [id]);
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action: 'decisions.wishlist.delete',
      entity: 'wishlist',
      entityId: id,
    });
    this.realtime.publish(spaceId, 'decisions', user.id, {
      action: 'wishlist.delete',
      wishlistId: id,
    });
    return { deleted: true };
  }

  async addWishlistItem(
    user: AuthenticatedUser,
    spaceId: string,
    wishlistId: string,
    input: WishlistItemInput,
  ) {
    await this.access.assert(user.id, spaceId, 'decisions', 'create');
    await this.requireWishlist(spaceId, wishlistId);
    const row = await this.db.queryOne<WishlistItemRow>(
      `INSERT INTO wishlist_items
        (id, wishlist_id, title, url, price_cents, currency, notes, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        newId('wit'),
        wishlistId,
        input.title,
        input.url,
        input.priceCents,
        input.currency,
        input.notes,
        input.priority,
      ],
    );
    this.realtime.publish(spaceId, 'decisions', user.id, {
      action: 'wishlist.item',
      wishlistId,
    });
    return row;
  }

  async updateWishlistItem(
    user: AuthenticatedUser,
    spaceId: string,
    wishlistId: string,
    itemId: string,
    patch: WishlistItemPatch,
  ) {
    await this.access.assert(user.id, spaceId, 'decisions', 'update');
    const wishlist = await this.requireWishlist(spaceId, wishlistId);
    const item = await this.db.queryOne<WishlistItemRow>(
      'SELECT * FROM wishlist_items WHERE id = $1 AND wishlist_id = $2',
      [itemId, wishlistId],
    );
    if (!item) throw new NotFoundException('wishlist_item_not_found');
    // Surprise protection: the list owner cannot reserve or buy their own gift
    // and cannot see who did; other members manage reservations.
    if (wishlist.owner_user_id === user.id && (patch.reserved !== undefined || patch.purchased !== undefined)) {
      throw new ForbiddenException('wishlist_owner_cannot_reserve');
    }
    const fields: string[] = [];
    const params: unknown[] = [itemId];
    const push = (column: string, value: unknown) => {
      params.push(value);
      fields.push(`${column} = $${params.length}`);
    };
    if (patch.title !== undefined) push('title', patch.title);
    if (patch.url !== undefined) push('url', patch.url);
    if (patch.priceCents !== undefined) push('price_cents', patch.priceCents);
    if (patch.currency !== undefined) push('currency', patch.currency);
    if (patch.notes !== undefined) push('notes', patch.notes);
    if (patch.priority !== undefined) push('priority', patch.priority);
    if (patch.reserved !== undefined) push('reserved_by', patch.reserved ? user.id : null);
    if (patch.purchased !== undefined) push('purchased_by', patch.purchased ? user.id : null);
    if (fields.length > 0) {
      await this.db.query(`UPDATE wishlist_items SET ${fields.join(', ')} WHERE id = $1`, params);
    }
    this.realtime.publish(spaceId, 'decisions', user.id, {
      action: 'wishlist.item',
      wishlistId,
    });
    return { updated: true };
  }

  async removeWishlistItem(user: AuthenticatedUser, spaceId: string, wishlistId: string, itemId: string) {
    await this.access.assert(user.id, spaceId, 'decisions', 'delete');
    await this.requireWishlist(spaceId, wishlistId);
    await this.db.query('DELETE FROM wishlist_items WHERE id = $1 AND wishlist_id = $2', [
      itemId,
      wishlistId,
    ]);
    this.realtime.publish(spaceId, 'decisions', user.id, {
      action: 'wishlist.item',
      wishlistId,
    });
    return { deleted: true };
  }

  // -------------------------------------------------------------------------
  // Decision history
  // -------------------------------------------------------------------------

  async history(
    user: AuthenticatedUser,
    spaceId: string,
    query: HistoryQuery,
  ): Promise<DecisionHistoryEntry[]> {
    await this.access.assert(user.id, spaceId, 'decisions', 'read');
    const params: unknown[] = [spaceId];
    let condition = '';
    if (query.entity) {
      params.push(query.entity);
      condition = ` AND entity = $${params.length}`;
    }
    params.push(query.limit);
    const rows = await this.db.query<{
      id: string;
      entity: DecisionHistoryEntry['entity'];
      entity_id: string;
      action: string;
      actor_user_id: string | null;
      summary: string;
      snapshot: unknown;
      created_at: Date | string;
    }>(
      `SELECT * FROM decision_history WHERE space_id = $1${condition}
       ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(toDecisionHistoryEntry);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async buildPoll(user: AuthenticatedUser, row: PollRow): Promise<Poll> {
    const votes = await this.db.query<PollVoteRow>(
      `SELECT v.*, u.display_name FROM poll_votes v
       LEFT JOIN users u ON u.id = v.user_id
       WHERE v.poll_id = $1 ORDER BY v.updated_at ASC`,
      [row.id],
    );
    const quorum = await this.quorum(row.space_id, votes.length, Number(row.quorum_percent ?? 50));
    const options: PollOption[] = pollOptionLabels(row).map((option) => {
      const voters = votes.filter((vote) => parseJson<string[]>(vote.option_keys, []).includes(option.key));
      return {
        ...option,
        votes: voters.length,
        voters: voters.map((vote) => ({
          userId: row.anonymous ? 'anonymous' : vote.user_id,
          displayName: row.anonymous ? '' : (vote.display_name ?? ''),
        })),
        wins: row.winning_option_key === option.key,
      };
    });
    const myVoteRow = votes.find((vote) => vote.user_id === user.id);
    return toPoll(row, votes, {
      options,
      eligibleVoters: quorum.eligibleVoters,
      quorumMet: quorum.quorumMet,
      participationPercent: quorum.participationPercent,
      myVote: myVoteRow ? parseJson<string[]>(myVoteRow.option_keys, []) : [],
      winningOptionKey: row.winning_option_key,
    });
  }

  private async buildProposal(user: AuthenticatedUser, row: ProposalRow): Promise<Proposal> {
    const votes = await this.db.query<ProposalVoteRow>(
      `SELECT v.*, u.display_name FROM proposal_votes v
       LEFT JOIN users u ON u.id = v.user_id
       WHERE v.proposal_id = $1 ORDER BY v.updated_at ASC`,
      [row.id],
    );
    const quorum = await this.quorum(row.space_id, votes.length, Number(row.quorum_percent ?? 50));
    const mine = votes.find((vote) => vote.user_id === user.id);
    return toProposal(row, votes, {
      quorumMet: quorum.quorumMet,
      participationPercent: quorum.participationPercent,
      eligibleVoters: quorum.eligibleVoters,
      myVote: mine?.choice ?? null,
    });
  }

  private async quorum(spaceId: string, voters: number, quorumPercent: number): Promise<QuorumResult> {
    const eligible = await this.db.queryOne<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count FROM memberships
       WHERE space_id = $1 AND role <> 'guest'`,
      [spaceId],
    );
    const eligibleVoters = Number(eligible?.count ?? 0);
    const participationPercent =
      eligibleVoters === 0 ? 0 : Math.round((voters / eligibleVoters) * 100);
    return {
      eligibleVoters,
      voters,
      participationPercent,
      quorumMet: eligibleVoters > 0 && participationPercent >= quorumPercent,
    };
  }

  private async closeExpiredPolls(spaceId: string): Promise<void> {
    const expired = await this.db.query<PollRow>(
      `SELECT * FROM polls WHERE space_id = $1 AND status = 'open'
         AND closes_at IS NOT NULL AND closes_at <= CURRENT_TIMESTAMP`,
      [spaceId],
    );
    for (const poll of expired) {
      await this.finalizePoll(spaceId, poll, null, 'deadline');
    }
  }

  private async maybeClosePoll(spaceId: string, poll: PollRow, actorUserId: string): Promise<void> {
    const governance = toSpaceGovernance(
      await this.db.queryOne<GovernanceRow>('SELECT * FROM space_governance WHERE space_id = $1', [
        spaceId,
      ]),
      spaceId,
    );
    if (!governance.autoClosePolls) return;
    const votes = await this.db.queryOne<{ count: number | string }>(
      'SELECT COUNT(*)::int AS count FROM poll_votes WHERE poll_id = $1',
      [poll.id],
    );
    const voters = Number(votes?.count ?? 0);
    const quorum = await this.quorum(spaceId, voters, Number(poll.quorum_percent ?? 50));
    // Auto-close only when everybody eligible has voted; otherwise the poll
    // stays open until its deadline so a minority cannot decide silently.
    if (quorum.eligibleVoters > 0 && voters >= quorum.eligibleVoters) {
      await this.finalizePoll(spaceId, poll, actorUserId, 'everyone_voted');
    }
  }

  private async finalizePoll(
    spaceId: string,
    poll: PollRow,
    actorUserId: string | null,
    reason: string,
  ): Promise<void> {
    const votes = await this.db.query<PollVoteRow>('SELECT * FROM poll_votes WHERE poll_id = $1', [
      poll.id,
    ]);
    const counts = new Map<string, number>();
    for (const vote of votes) {
      for (const key of parseJson<string[]>(vote.option_keys, [])) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const ranked = [...counts.entries()].sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    );
    const best = ranked[0]?.[1] ?? 0;
    const leaders = ranked.filter((entry) => entry[1] === best).map((entry) => entry[0]);
    // A tie has no winner. Picking one alphabetically would silently invent a
    // decision, so the poll closes with `winningOptionKey = null` and the tie
    // is visible in the decision history for a follow-up vote.
    const tie = leaders.length > 1;
    const winning: string | null = tie ? null : (ranked[0]?.[0] ?? null);
    const quorum = await this.quorum(spaceId, votes.length, Number(poll.quorum_percent ?? 50));
    const decided = quorum.quorumMet ? winning : null;
    await this.db.query(
      `UPDATE polls SET status = 'closed', closed_at = CURRENT_TIMESTAMP,
         winning_option_key = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [poll.id, decided],
    );
    await this.recordHistory(
      spaceId,
      'poll',
      poll.id,
      'close',
      actorUserId,
      decided
        ? `Опрос закрыт: ${poll.question}`
        : tie
          ? `Опрос закрыт с равным счётом: ${poll.question}`
          : `Опрос закрыт без кворума: ${poll.question}`,
      {
        reason,
        tie,
        leaders,
        winningOption: decided,
        votes: votes.length,
        eligibleVoters: quorum.eligibleVoters,
        participationPercent: quorum.participationPercent,
        quorumMet: quorum.quorumMet,
      },
    );
    await this.audit.record({
      actorUserId,
      spaceId,
      action: 'decisions.poll.close',
      entity: 'poll',
      entityId: poll.id,
      metadata: { reason, winningOption: decided, tie, quorumMet: quorum.quorumMet },
    });
    this.realtime.publish(spaceId, 'decisions', actorUserId, {
      action: 'poll.close',
      pollId: poll.id,
    });
    await this.notifications.notifySpaceMembers(spaceId, {
      category: 'decisions',
      severity: 'important',
      title: 'Опрос завершён',
      body: poll.question,
      sourceModule: 'decisions',
      sourceId: poll.id,
      actionUrl: `/decisions?poll=${poll.id}`,
      dedupeKey: `poll-closed:${poll.id}`,
    });
  }

  private async maybeDecideProposal(
    spaceId: string,
    proposal: ProposalRow,
    actorUserId: string,
  ): Promise<void> {
    const votes = await this.db.query<ProposalVoteRow>(
      'SELECT * FROM proposal_votes WHERE proposal_id = $1',
      [proposal.id],
    );
    const quorum = await this.quorum(spaceId, votes.length, Number(proposal.quorum_percent ?? 50));
    if (votes.length === 0 || quorum.eligibleVoters === 0) return;
    if (votes.length < quorum.eligibleVoters) return;
    await this.finalizeProposal(spaceId, proposal, actorUserId, 'everyone_voted');
  }

  private async finalizeProposal(
    spaceId: string,
    proposal: ProposalRow,
    actorUserId: string | null,
    reason: string,
  ): Promise<void> {
    const votes = await this.db.query<ProposalVoteRow>(
      'SELECT * FROM proposal_votes WHERE proposal_id = $1',
      [proposal.id],
    );
    const yes = votes.filter((vote) => vote.choice === 'yes').length;
    const no = votes.filter((vote) => vote.choice === 'no').length;
    const quorum = await this.quorum(spaceId, votes.length, Number(proposal.quorum_percent ?? 50));
    const passed = quorum.quorumMet && ruleSatisfied(proposal.voting_rule, yes, no, votes.length);
    const status: ProposalStatus = quorum.quorumMet
      ? passed
        ? 'accepted'
        : 'rejected'
      : 'rejected';
    const summary = quorum.quorumMet
      ? passed
        ? `Принято: ${yes} за, ${no} против`
        : `Отклонено: ${yes} за, ${no} против`
      : `Отклонено: кворум не собран (${quorum.participationPercent}% из ${proposal.quorum_percent}%)`;
    await this.db.query(
      `UPDATE proposals SET status = $2, decided_at = CURRENT_TIMESTAMP,
         decision_summary = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [proposal.id, status, summary],
    );
    await this.recordHistory(spaceId, 'proposal', proposal.id, 'decide', actorUserId, summary, {
      reason,
      yes,
      no,
      abstain: votes.length - yes - no,
      participationPercent: quorum.participationPercent,
      quorumMet: quorum.quorumMet,
      status,
    });
    await this.audit.record({
      actorUserId,
      spaceId,
      action: 'decisions.proposal.decide',
      entity: 'proposal',
      entityId: proposal.id,
      metadata: { status, yes, no, quorumMet: quorum.quorumMet, reason },
    });
    this.realtime.publish(spaceId, 'decisions', actorUserId, {
      action: 'proposal.decide',
      proposalId: proposal.id,
    });
    await this.notifications.notifySpaceMembers(spaceId, {
      category: 'decisions',
      severity: 'important',
      title: status === 'accepted' ? 'Предложение принято' : 'Предложение отклонено',
      body: `${proposal.title} — ${summary}`,
      sourceModule: 'decisions',
      sourceId: proposal.id,
      actionUrl: `/decisions?proposal=${proposal.id}`,
      dedupeKey: `proposal-decided:${proposal.id}`,
    });
  }

  private async recordHistory(
    spaceId: string,
    entity: 'poll' | 'proposal' | 'governance',
    entityId: string,
    action: string,
    actorUserId: string | null,
    summary: string,
    snapshot: Record<string, unknown>,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO decision_history
        (id, space_id, entity, entity_id, action, actor_user_id, summary, snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [newId('dch'), spaceId, entity, entityId, action, actorUserId, summary, JSON.stringify(snapshot)],
    );
  }

  private async requirePoll(spaceId: string, id: string): Promise<PollRow> {
    const row = await this.db.queryOne<PollRow>('SELECT * FROM polls WHERE id = $1 AND space_id = $2', [
      id,
      spaceId,
    ]);
    if (!row) throw new NotFoundException('poll_not_found');
    return row;
  }

  private async requireProposal(spaceId: string, id: string): Promise<ProposalRow> {
    const row = await this.db.queryOne<ProposalRow>(
      `SELECT p.*, u.display_name AS author_name FROM proposals p
       LEFT JOIN users u ON u.id = p.author_user_id
       WHERE p.id = $1 AND p.space_id = $2`,
      [id, spaceId],
    );
    if (!row) throw new NotFoundException('proposal_not_found');
    return row;
  }

  private async requireWishlist(spaceId: string, id: string): Promise<WishlistRow> {
    const row = await this.db.queryOne<WishlistRow>(
      'SELECT * FROM wishlists WHERE id = $1 AND space_id = $2',
      [id, spaceId],
    );
    if (!row) throw new NotFoundException('wishlist_not_found');
    return row;
  }

  private async resolveOwner(spaceId: string, userId: string | null | undefined): Promise<string | null> {
    if (!userId) return null;
    const row = await this.db.queryOne<{ user_id: string }>(
      'SELECT user_id FROM memberships WHERE space_id = $1 AND user_id = $2',
      [spaceId, userId],
    );
    if (!row) throw new BadRequestException('wishlist_owner_not_in_space');
    return row.user_id;
  }
}
