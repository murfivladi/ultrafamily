import type {
  CallConnectionState,
  CallKind,
  CallParticipantState,
  CallRoom,
  ChatAttachment,
  ChatKind,
  ChatMemberRole,
  ChatMemberSummary,
  ChatMessage,
  ChatMessageVersion,
  ChatNotificationLevel,
  ChatReaction,
  ChatSummary,
  DecisionHistoryEntry,
  DocumentComment,
  DocumentKind,
  DocumentPermission,
  DocumentSummary,
  DocumentVersion,
  FeedComment,
  FeedPost,
  FeedPostKind,
  FeedVisibility,
  Poll,
  PollKind,
  PollOption,
  PollStatus,
  PollVote,
  PollVotingRule,
  Proposal,
  ProposalStatus,
  ProposalVote,
  SpaceGovernance,
  Wishlist,
  WishlistItem,
} from '@ufos/contracts';
import { iso, parseJson } from '../db/rows';

export interface ChatRow {
  id: string;
  space_id: string;
  kind: ChatKind;
  name: string;
  topic: string;
  description: string;
  visibility: 'members' | 'space';
  archived: boolean;
  created_by: string | null;
  last_message_at: Date | string | null;
  message_count: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ChatMemberRow {
  chat_id: string;
  user_id: string;
  role: ChatMemberRole;
  notification_level: ChatNotificationLevel;
  last_read_at: Date | string | null;
  display_name?: string;
  avatar_color?: string;
  is_child?: boolean;
}

export interface ChatMessageRow {
  id: string;
  chat_id: string;
  space_id: string;
  thread_root_id: string | null;
  author_user_id: string | null;
  author_name?: string | null;
  author_avatar_color?: string | null;
  body: string;
  mentions: unknown;
  pinned: boolean;
  edited_at: Date | string | null;
  deleted_at: Date | string | null;
  deleted_by: string | null;
  client_key: string | null;
  version: number | string;
  created_at: Date | string;
  reply_count?: number | string;
  delivered_count?: number | string;
  read_count?: number | string;
}

export interface ChatReactionRow {
  message_id: string;
  emoji: string;
  user_id: string;
}

export interface ChatAttachmentRow {
  id: string;
  message_id: string;
  name: string;
  kind: ChatAttachment['kind'];
  url: string;
  size_bytes: number | string;
}

export interface FeedPostRow {
  id: string;
  space_id: string;
  kind: FeedPostKind;
  title: string;
  body: string;
  visibility: FeedVisibility;
  audience_space_ids: unknown;
  tags: unknown;
  media: unknown;
  auto_event_key: string | null;
  pinned: boolean;
  author_user_id: string | null;
  author_name?: string | null;
  author_avatar_color?: string | null;
  published_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
  comment_count?: number | string;
}

export interface FeedCommentRow {
  id: string;
  post_id: string;
  author_user_id: string | null;
  author_name?: string | null;
  author_avatar_color?: string | null;
  body: string;
  created_at: Date | string;
  deleted_at: Date | string | null;
}

export interface PollRow {
  id: string;
  space_id: string;
  kind: PollKind;
  question: string;
  description: string;
  options: unknown;
  multi_choice: boolean;
  anonymous: boolean;
  status: PollStatus;
  quorum_percent: number | string;
  voting_rule: PollVotingRule;
  winning_option_key: string | null;
  closes_at: Date | string | null;
  closed_at: Date | string | null;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface PollVoteRow {
  poll_id: string;
  user_id: string;
  option_keys: unknown;
  comment: string;
  updated_at: Date | string;
  display_name?: string | null;
}

export interface ProposalRow {
  id: string;
  space_id: string;
  title: string;
  body: string;
  status: ProposalStatus;
  author_user_id: string | null;
  author_name?: string | null;
  voting_rule: PollVotingRule;
  quorum_percent: number | string;
  opens_at: Date | string | null;
  closes_at: Date | string | null;
  decided_at: Date | string | null;
  decision_summary: string;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ProposalVoteRow {
  proposal_id: string;
  user_id: string;
  choice: ProposalVote['choice'];
  comment: string;
  updated_at: Date | string;
  display_name?: string | null;
}

export interface GovernanceRow {
  space_id: string;
  quorum_percent: number | string;
  voting_rule: PollVotingRule;
  allow_abstain: boolean;
  default_duration_hours: number | string;
  auto_close_polls: boolean;
  updated_at: Date | string;
}

export interface WishlistRow {
  id: string;
  space_id: string;
  title: string;
  owner_user_id: string | null;
  owner_name?: string | null;
  visibility: FeedVisibility;
  occasion: string;
  due_at: Date | string | null;
  created_at: Date | string;
}

export interface WishlistItemRow {
  id: string;
  wishlist_id: string;
  title: string;
  url: string;
  price_cents: number | string | null;
  currency: string;
  notes: string;
  priority: number | string;
  reserved_by: string | null;
  purchased_by: string | null;
  created_at: Date | string;
}

export interface DocumentRow {
  id: string;
  space_id: string;
  parent_id: string | null;
  kind: DocumentKind;
  title: string;
  format: DocumentSummary['format'];
  content: string;
  yjs_state: string | null;
  version: number | string;
  created_by: string | null;
  created_by_name?: string | null;
  updated_by: string | null;
  updated_by_name?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  archived_at: Date | string | null;
  deleted_at: Date | string | null;
  comment_count?: number | string;
  open_comment_count?: number | string;
}

export interface DocumentVersionRow {
  id: string;
  document_id: string;
  version: number | string;
  title: string;
  content: string;
  created_by: string | null;
  created_by_name?: string | null;
  note: string;
  created_at: Date | string;
}

export interface DocumentCommentRow {
  id: string;
  document_id: string;
  author_user_id: string | null;
  author_name?: string | null;
  author_avatar_color?: string | null;
  body: string;
  anchor: unknown;
  resolved_at: Date | string | null;
  resolved_by: string | null;
  created_at: Date | string;
}

export interface DocumentCollaboratorRow {
  document_id: string;
  user_id: string;
  permission: DocumentPermission;
  display_name?: string | null;
  avatar_color?: string | null;
  cursor?: unknown;
  editing?: boolean;
  last_seen_at?: Date | string | null;
}

export interface CallRoomRow {
  id: string;
  space_id: string;
  name: string;
  kind: CallKind;
  created_by: string | null;
  created_at: Date | string;
  closed_at: Date | string | null;
}

export interface CallParticipantRow {
  room_id: string;
  user_id: string;
  display_name?: string | null;
  avatar_color?: string | null;
  role: 'host' | 'participant';
  state: CallParticipantState;
  audio: boolean;
  video: boolean;
  screen: boolean;
  connection_state: CallConnectionState;
  quality: unknown;
  joined_at: Date | string | null;
  left_at: Date | string | null;
  last_seen_at: Date | string;
}

export function groupReactions(rows: ChatReactionRow[]): ChatReaction[] {
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const list = map.get(row.emoji) ?? [];
    if (!list.includes(row.user_id)) list.push(row.user_id);
    map.set(row.emoji, list);
  }
  return [...map.entries()]
    .map(([emoji, userIds]) => ({ emoji, userIds: userIds.sort() }))
    .sort((left, right) => left.emoji.localeCompare(right.emoji));
}

export function toChatMember(row: ChatMemberRow): ChatMemberSummary {
  return {
    userId: row.user_id,
    displayName: row.display_name ?? '',
    avatarColor: row.avatar_color ?? '#5B7CFA',
    role: row.role,
    notificationLevel: row.notification_level,
    lastReadAt: iso(row.last_read_at),
    isChild: Boolean(row.is_child),
  };
}

export function toChatSummary(
  row: ChatRow,
  members: ChatMemberRow[],
  extras: {
    unreadCount?: number;
    mentionCount?: number;
    lastMessagePreview?: string;
    myRole?: ChatMemberRole | null;
    myNotificationLevel?: ChatNotificationLevel;
  } = {},
): ChatSummary {
  return {
    id: row.id,
    spaceId: row.space_id,
    kind: row.kind,
    name: row.name,
    topic: row.topic,
    description: row.description,
    visibility: row.visibility,
    archived: row.archived,
    createdBy: row.created_by,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
    lastMessageAt: iso(row.last_message_at),
    lastMessagePreview: extras.lastMessagePreview ?? '',
    messageCount: Number(row.message_count ?? 0),
    unreadCount: Number(extras.unreadCount ?? 0),
    mentionCount: Number(extras.mentionCount ?? 0),
    myRole: extras.myRole ?? null,
    myNotificationLevel: extras.myNotificationLevel ?? 'all',
    members: members.map(toChatMember),
  };
}

export function toChatMessage(
  row: ChatMessageRow,
  reactions: ChatReactionRow[] = [],
  attachments: ChatAttachmentRow[] = [],
): ChatMessage {
  const deleted = row.deleted_at !== null && row.deleted_at !== undefined;
  return {
    id: row.id,
    chatId: row.chat_id,
    spaceId: row.space_id,
    threadRootId: row.thread_root_id,
    authorUserId: row.author_user_id ?? '',
    authorName: row.author_name ?? '',
    authorAvatarColor: row.author_avatar_color ?? '#5B7CFA',
    // Deleted bodies are removed from the payload; the audit/version trail keeps
    // the moderation record without leaking content back to the client.
    body: deleted ? '' : row.body,
    mentions: deleted ? [] : parseJson<string[]>(row.mentions, []),
    attachments: deleted
      ? []
      : attachments.map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          kind: attachment.kind,
          url: attachment.url,
          sizeBytes: Number(attachment.size_bytes ?? 0),
        })),
    reactions: deleted ? [] : groupReactions(reactions),
    pinned: row.pinned,
    editedAt: iso(row.edited_at ?? null),
    deletedAt: iso(row.deleted_at ?? null),
    deletedBy: row.deleted_by,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    clientKey: row.client_key,
    replyCount: Number(row.reply_count ?? 0),
    deliveredCount: Number(row.delivered_count ?? 0),
    readCount: Number(row.read_count ?? 0),
    version: Number(row.version ?? 1),
  };
}

export function toChatMessageVersion(row: {
  version: number | string;
  body: string;
  edited_by: string | null;
  created_at: Date | string;
}): ChatMessageVersion {
  return {
    version: Number(row.version ?? 1),
    body: row.body,
    editedBy: row.edited_by,
    editedAt: iso(row.created_at) ?? new Date(0).toISOString(),
  };
}

export function toFeedComment(row: FeedCommentRow): FeedComment {
  return {
    id: row.id,
    postId: row.post_id,
    authorUserId: row.author_user_id ?? '',
    authorName: row.author_name ?? '',
    authorAvatarColor: row.author_avatar_color ?? '#5B7CFA',
    body: row.deleted_at ? '' : row.body,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    deletedAt: iso(row.deleted_at ?? null),
  };
}

export function toFeedPost(
  row: FeedPostRow,
  comments: FeedCommentRow[] = [],
  reactions: ChatReactionRow[] = [],
): FeedPost {
  return {
    id: row.id,
    spaceId: row.space_id,
    kind: row.kind,
    title: row.deleted_at ? '' : row.title,
    body: row.deleted_at ? '' : row.body,
    visibility: row.visibility,
    audienceSpaceIds: parseJson<string[]>(row.audience_space_ids, []),
    tags: parseJson<string[]>(row.tags, []),
    media: parseJson<FeedPost['media']>(row.media, []),
    autoEventKey: row.auto_event_key,
    pinned: row.pinned,
    authorUserId: row.author_user_id,
    authorName: row.author_name ?? '',
    authorAvatarColor: row.author_avatar_color ?? '#5B7CFA',
    publishedAt: iso(row.published_at) ?? new Date(0).toISOString(),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
    deletedAt: iso(row.deleted_at ?? null),
    comments: comments.map(toFeedComment),
    reactions: groupReactions(reactions),
    commentCount: Number(row.comment_count ?? comments.length),
  };
}

export function toPollVote(row: PollVoteRow, anonymous: boolean): PollVote {
  return {
    userId: anonymous ? 'anonymous' : row.user_id,
    displayName: anonymous ? '' : (row.display_name ?? ''),
    optionKeys: parseJson<string[]>(row.option_keys, []),
    comment: row.comment,
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

export function toSpaceGovernance(row: GovernanceRow | null, spaceId: string): SpaceGovernance {
  return {
    spaceId,
    quorumPercent: Number(row?.quorum_percent ?? 50),
    votingRule: (row?.voting_rule ?? 'majority') as PollVotingRule,
    allowAbstain: row?.allow_abstain ?? true,
    defaultDurationHours: Number(row?.default_duration_hours ?? 72),
    autoClosePolls: row?.auto_close_polls ?? true,
    updatedAt: iso(row?.updated_at) ?? new Date(0).toISOString(),
  };
}

export function pollOptionLabels(row: PollRow): PollOption[] {
  return parseJson<Array<{ key: string; label: string }>>(row.options, []).map((option) => ({
    key: option.key,
    label: option.label,
    votes: 0,
    voters: [],
    wins: false,
  }));
}

export function toPoll(
  row: PollRow,
  votes: PollVoteRow[],
  extras: {
    options: PollOption[];
    eligibleVoters: number;
    quorumMet: boolean;
    participationPercent: number;
    myVote: string[];
    winningOptionKey: string | null;
  },
): Poll {
  return {
    id: row.id,
    spaceId: row.space_id,
    kind: row.kind,
    question: row.question,
    description: row.description,
    options: extras.options,
    multiChoice: row.multi_choice,
    anonymous: row.anonymous,
    status: row.status,
    quorumPercent: Number(row.quorum_percent ?? 50),
    votingRule: row.voting_rule,
    quorumMet: extras.quorumMet,
    participationPercent: extras.participationPercent,
    eligibleVoters: extras.eligibleVoters,
    totalVoters: votes.length,
    closesAt: iso(row.closes_at),
    closedAt: iso(row.closed_at),
    createdBy: row.created_by,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    winningOptionKey: extras.winningOptionKey,
    myVote: extras.myVote,
    votes: votes.map((vote) => toPollVote(vote, row.anonymous)),
  };
}

export function toProposal(
  row: ProposalRow,
  votes: ProposalVoteRow[],
  extras: {
    quorumMet: boolean;
    participationPercent: number;
    eligibleVoters: number;
    myVote: ProposalVote['choice'] | null;
  },
): Proposal {
  const tallies = { yes: 0, no: 0, abstain: 0 };
  for (const vote of votes) tallies[vote.choice] += 1;
  return {
    id: row.id,
    spaceId: row.space_id,
    title: row.title,
    body: row.body,
    status: row.status,
    authorUserId: row.author_user_id,
    authorName: row.author_name ?? '',
    votingRule: row.voting_rule,
    quorumPercent: Number(row.quorum_percent ?? 50),
    quorumMet: extras.quorumMet,
    tallies,
    participationPercent: extras.participationPercent,
    eligibleVoters: extras.eligibleVoters,
    opensAt: iso(row.opens_at),
    closesAt: iso(row.closes_at),
    decidedAt: iso(row.decided_at),
    decisionSummary: row.decision_summary,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
    myVote: extras.myVote,
    votes: votes.map((vote) => ({
      userId: vote.user_id,
      displayName: vote.display_name ?? '',
      choice: vote.choice,
      comment: vote.comment,
      updatedAt: iso(vote.updated_at) ?? new Date(0).toISOString(),
    })),
  };
}

export function toWishlist(
  row: WishlistRow,
  items: WishlistItemRow[],
  requesterId: string,
): Wishlist {
  // A wishlist owner must not learn who reserved or bought a surprise gift.
  const hideReservations = row.owner_user_id === requesterId;
  return {
    id: row.id,
    spaceId: row.space_id,
    title: row.title,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name ?? '',
    visibility: row.visibility,
    occasion: row.occasion,
    dueAt: iso(row.due_at),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    items: items.map(
      (item): WishlistItem => ({
        id: item.id,
        wishlistId: item.wishlist_id,
        title: item.title,
        url: item.url,
        priceCents: item.price_cents === null ? null : Number(item.price_cents),
        currency: item.currency,
        notes: item.notes,
        priority: Number(item.priority ?? 2),
        reservedBy: hideReservations ? (item.reserved_by ? 'hidden' : null) : item.reserved_by,
        purchasedBy: hideReservations ? (item.purchased_by ? 'hidden' : null) : item.purchased_by,
        createdAt: iso(item.created_at) ?? new Date(0).toISOString(),
      }),
    ),
  };
}

export function toDocumentSummary(
  row: DocumentRow,
  myPermission: DocumentPermission | null,
): DocumentSummary {
  return {
    id: row.id,
    spaceId: row.space_id,
    parentId: row.parent_id,
    kind: row.kind,
    title: row.deleted_at ? '' : row.title,
    format: row.format,
    version: Number(row.version ?? 1),
    createdBy: row.created_by,
    createdByName: row.created_by_name ?? '',
    updatedByName: row.updated_by_name ?? '',
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
    archivedAt: iso(row.archived_at),
    commentCount: Number(row.comment_count ?? 0),
    openCommentCount: Number(row.open_comment_count ?? 0),
    sizeChars: row.content?.length ?? 0,
    myPermission,
  };
}

export function toDocumentVersion(row: DocumentVersionRow): DocumentVersion {
  return {
    id: row.id,
    version: Number(row.version ?? 1),
    title: row.title,
    content: row.content,
    createdBy: row.created_by,
    createdByName: row.created_by_name ?? '',
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    note: row.note,
  };
}

export function toDocumentComment(row: DocumentCommentRow): DocumentComment {
  return {
    id: row.id,
    documentId: row.document_id,
    authorUserId: row.author_user_id ?? '',
    authorName: row.author_name ?? '',
    authorAvatarColor: row.author_avatar_color ?? '#5B7CFA',
    body: row.body,
    anchor:
      row.anchor && typeof row.anchor === 'object'
        ? parseJson<DocumentComment['anchor']>(row.anchor, null)
        : null,
    resolvedAt: iso(row.resolved_at ?? null),
    resolvedBy: row.resolved_by,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
  };
}

export function toDocumentCollaborator(row: DocumentCollaboratorRow) {
  return {
    userId: row.user_id,
    displayName: row.display_name ?? '',
    avatarColor: row.avatar_color ?? '#5B7CFA',
    permission: row.permission,
    lastSeenAt: iso(row.last_seen_at ?? null),
    cursor: row.cursor ? parseJson<{ anchor: number; head: number } | null>(row.cursor, null) : null,
    editing: Boolean(row.editing),
  };
}

export function toCallRoom(
  row: CallRoomRow,
  participants: CallParticipantRow[],
  options: { stunUrls: string[]; turnConfigured: boolean },
): CallRoom {
  return {
    id: row.id,
    spaceId: row.space_id,
    name: row.name,
    kind: row.kind,
    createdBy: row.created_by,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    closedAt: iso(row.closed_at),
    participants: participants.map((participant) => {
      const quality = parseJson<CallParticipantRow['quality']>(participant.quality, {});
      const typed = quality as {
        rttMs?: number | null;
        packetsLost?: number | null;
        bitrateKbps?: number | null;
      };
      return {
        userId: participant.user_id,
        displayName: participant.display_name ?? '',
        avatarColor: participant.avatar_color ?? '#5B7CFA',
        role: participant.role,
        state: participant.state,
        audio: participant.audio,
        video: participant.video,
        screen: participant.screen,
        connectionState: participant.connection_state,
        joinedAt: iso(participant.joined_at),
        leftAt: iso(participant.left_at),
        lastSeenAt: iso(participant.last_seen_at) ?? new Date(0).toISOString(),
        quality: {
          rttMs: typed.rttMs ?? null,
          packetsLost: typed.packetsLost ?? null,
          bitrateKbps: typed.bitrateKbps ?? null,
        },
      };
    }),
    turnConfigured: options.turnConfigured,
    stunUrls: options.stunUrls,
  };
}

export function toDecisionHistoryEntry(row: {
  id: string;
  entity: DecisionHistoryEntry['entity'];
  entity_id: string;
  action: string;
  actor_user_id: string | null;
  summary: string;
  snapshot: unknown;
  created_at: Date | string;
}): DecisionHistoryEntry {
  return {
    id: row.id,
    entity: row.entity,
    entityId: row.entity_id,
    action: row.action,
    actorUserId: row.actor_user_id,
    summary: row.summary,
    snapshot: parseJson<Record<string, unknown>>(row.snapshot, {}),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
  };
}
