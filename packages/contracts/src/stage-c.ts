// Stage C — communication and collaboration contracts.
// Shared by the NestJS API (validation/shape of responses) and the Next.js UI.
// Nothing here grants access: the server always re-resolves permissions.

import type { Language } from './types';

export type ChatKind = 'direct' | 'group' | 'channel';
export type ChatMemberRole = 'owner' | 'moderator' | 'member';
export type ChatNotificationLevel = 'all' | 'mentions' | 'muted';

export interface ChatMemberSummary {
  userId: string;
  displayName: string;
  avatarColor: string;
  role: ChatMemberRole;
  notificationLevel: ChatNotificationLevel;
  lastReadAt: string | null;
  isChild: boolean;
}

export interface ChatSummary {
  id: string;
  spaceId: string;
  kind: ChatKind;
  name: string;
  topic: string;
  description: string;
  visibility: 'members' | 'space';
  archived: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  lastMessagePreview: string;
  messageCount: number;
  unreadCount: number;
  mentionCount: number;
  myRole: ChatMemberRole | null;
  myNotificationLevel: ChatNotificationLevel;
  members: ChatMemberSummary[];
}

export interface ChatReaction {
  emoji: string;
  userIds: string[];
}

export interface ChatAttachment {
  id: string;
  name: string;
  kind: 'file' | 'photo' | 'link';
  url: string;
  sizeBytes: number;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  spaceId: string;
  threadRootId: string | null;
  authorUserId: string;
  authorName: string;
  authorAvatarColor: string;
  body: string;
  mentions: string[];
  attachments: ChatAttachment[];
  reactions: ChatReaction[];
  pinned: boolean;
  editedAt: string | null;
  deletedAt: string | null;
  deletedBy: string | null;
  createdAt: string;
  clientKey: string | null;
  replyCount: number;
  deliveredCount: number;
  readCount: number;
  version: number;
}

export interface ChatMessageVersion {
  version: number;
  body: string;
  editedBy: string | null;
  editedAt: string;
}

export interface ChatThreadView {
  root: ChatMessage | null;
  replies: ChatMessage[];
}

export interface ChatSearchHit {
  messageId: string;
  chatId: string;
  chatName: string;
  authorName: string;
  body: string;
  createdAt: string;
}

export interface ChatModerationEntry {
  id: string;
  chatId: string;
  actorUserId: string | null;
  action: string;
  targetUserId: string | null;
  targetMessageId: string | null;
  reason: string;
  createdAt: string;
}

export type FeedPostKind = 'news' | 'announcement' | 'photo' | 'moment' | 'system';
export type FeedVisibility = 'household' | 'network';

export interface FeedComment {
  id: string;
  postId: string;
  authorUserId: string;
  authorName: string;
  authorAvatarColor: string;
  body: string;
  createdAt: string;
  deletedAt: string | null;
}

export interface FeedPost {
  id: string;
  spaceId: string;
  kind: FeedPostKind;
  title: string;
  body: string;
  visibility: FeedVisibility;
  audienceSpaceIds: string[];
  tags: string[];
  media: Array<{ id: string; name: string; url: string; kind: string }>;
  autoEventKey: string | null;
  pinned: boolean;
  authorUserId: string | null;
  authorName: string;
  authorAvatarColor: string;
  publishedAt: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  comments: FeedComment[];
  reactions: ChatReaction[];
  commentCount: number;
}

export type PollKind = 'simple' | 'date';
export type PollStatus = 'open' | 'closed';
export type PollVotingRule = 'majority' | 'two_thirds' | 'unanimous';

export interface PollOption {
  key: string;
  label: string;
  votes: number;
  voters: Array<{ userId: string; displayName: string }>;
  wins: boolean;
}

export interface PollVote {
  userId: string;
  displayName: string;
  optionKeys: string[];
  comment: string;
  updatedAt: string;
}

export interface Poll {
  id: string;
  spaceId: string;
  kind: PollKind;
  question: string;
  description: string;
  options: PollOption[];
  multiChoice: boolean;
  anonymous: boolean;
  status: PollStatus;
  quorumPercent: number;
  votingRule: PollVotingRule;
  quorumMet: boolean;
  participationPercent: number;
  eligibleVoters: number;
  totalVoters: number;
  closesAt: string | null;
  closedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  winningOptionKey: string | null;
  myVote: string[];
  votes: PollVote[];
}

export interface ProposalVote {
  userId: string;
  displayName: string;
  choice: 'yes' | 'no' | 'abstain';
  comment: string;
  updatedAt: string;
}

export type ProposalStatus = 'discussion' | 'voting' | 'accepted' | 'rejected' | 'withdrawn';

export interface Proposal {
  id: string;
  spaceId: string;
  title: string;
  body: string;
  status: ProposalStatus;
  authorUserId: string | null;
  authorName: string;
  votingRule: PollVotingRule;
  quorumPercent: number;
  quorumMet: boolean;
  tallies: { yes: number; no: number; abstain: number };
  participationPercent: number;
  eligibleVoters: number;
  opensAt: string | null;
  closesAt: string | null;
  decidedAt: string | null;
  decisionSummary: string;
  createdAt: string;
  updatedAt: string;
  myVote: 'yes' | 'no' | 'abstain' | null;
  votes: ProposalVote[];
}

export interface SpaceGovernance {
  spaceId: string;
  quorumPercent: number;
  votingRule: PollVotingRule;
  allowAbstain: boolean;
  defaultDurationHours: number;
  autoClosePolls: boolean;
  updatedAt: string;
}

export interface DecisionHistoryEntry {
  id: string;
  entity: 'poll' | 'proposal' | 'governance';
  entityId: string;
  action: string;
  actorUserId: string | null;
  summary: string;
  snapshot: Record<string, unknown>;
  createdAt: string;
}

export interface WishlistItem {
  id: string;
  wishlistId: string;
  title: string;
  url: string;
  priceCents: number | null;
  currency: string;
  notes: string;
  priority: number;
  reservedBy: string | null;
  purchasedBy: string | null;
  createdAt: string;
}

export interface Wishlist {
  id: string;
  spaceId: string;
  title: string;
  ownerUserId: string | null;
  ownerName: string;
  visibility: FeedVisibility;
  occasion: string;
  dueAt: string | null;
  createdAt: string;
  items: WishlistItem[];
}

export type DocumentKind = 'note' | 'document' | 'table' | 'presentation';
export type DocumentPermission = 'read' | 'comment' | 'edit';

export interface DocumentSummary {
  id: string;
  spaceId: string;
  parentId: string | null;
  kind: DocumentKind;
  title: string;
  format: 'text' | 'markdown' | 'csv' | 'slides';
  version: number;
  createdBy: string | null;
  createdByName: string;
  updatedByName: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  commentCount: number;
  openCommentCount: number;
  sizeChars: number;
  myPermission: DocumentPermission | null;
}

export interface DocumentCollaborator {
  userId: string;
  displayName: string;
  avatarColor: string;
  permission: DocumentPermission;
  lastSeenAt: string | null;
  cursor: { anchor: number; head: number } | null;
  editing: boolean;
}

export interface DocumentDetail extends DocumentSummary {
  content: string;
  collaborators: DocumentCollaborator[];
  presence: Array<{
    userId: string;
    displayName: string;
    cursor: { anchor: number; head: number } | null;
    lastSeenAt: string;
  }>;
}

export interface DocumentVersion {
  id: string;
  version: number;
  title: string;
  content: string;
  createdBy: string | null;
  createdByName: string;
  createdAt: string;
  note: string;
}

export interface DocumentComment {
  id: string;
  documentId: string;
  authorUserId: string;
  authorName: string;
  authorAvatarColor: string;
  body: string;
  anchor: { from: number; to: number; quote: string } | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
}

export type CallKind = 'audio' | 'video';
export type CallParticipantState = 'invited' | 'joined' | 'left';
export type CallConnectionState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed';

export interface CallParticipant {
  userId: string;
  displayName: string;
  avatarColor: string;
  role: 'host' | 'participant';
  state: CallParticipantState;
  audio: boolean;
  video: boolean;
  screen: boolean;
  connectionState: CallConnectionState;
  joinedAt: string | null;
  leftAt: string | null;
  lastSeenAt: string;
  quality: { rttMs: number | null; packetsLost: number | null; bitrateKbps: number | null };
}

export interface CallRoom {
  id: string;
  spaceId: string;
  name: string;
  kind: CallKind;
  createdBy: string | null;
  createdAt: string;
  closedAt: string | null;
  participants: CallParticipant[];
  turnConfigured: boolean;
  stunUrls: string[];
}

export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
  expiresAt?: string;
}

export interface CallDiagnostics {
  roomId: string;
  signaling: 'websocket' | 'http-poll';
  turnConfigured: boolean;
  iceServers: IceServerConfig[];
  participants: number;
  warnings: string[];
}

export type CollaborationClientMessage =
  | { type: 'hello'; spaceId: string; csrfToken: string }
  | { type: 'subscribe'; topics: string[] }
  | { type: 'ping' }
  | { type: 'presence'; status: 'active' | 'away'; chatId?: string | null }
  | { type: 'cursor'; documentId: string; anchor: number; head: number; editing?: boolean }
  | { type: 'doc:sync'; documentId: string; update: string; syncId?: string }
  | { type: 'doc:request-state'; documentId: string }
  | {
      type: 'call:signal';
      roomId: string;
      to: string;
      kind: 'offer' | 'answer' | 'ice' | 'renegotiate' | 'bye';
      payload: Record<string, unknown>;
    }
  | {
      type: 'call:state';
      roomId: string;
      audio?: boolean;
      video?: boolean;
      screen?: boolean;
      connectionState?: CallConnectionState;
      quality?: { rttMs?: number | null; packetsLost?: number | null; bitrateKbps?: number | null };
    };

export type CollaborationServerMessage =
  | { type: 'ready'; clientId: string; userId: string; spaceId: string; topics: string[] }
  | { type: 'error'; code: string; message?: string }
  | { type: 'pong'; at: string }
  | { type: 'event'; topic: string; payload: Record<string, unknown>; createdAt: string }
  | {
      type: 'presence:list';
      spaceId: string;
      users: Array<{ userId: string; displayName: string; status: string; lastSeenAt: string }>;
    }
  | {
      type: 'cursor';
      documentId: string;
      userId: string;
      displayName: string;
      anchor: number;
      head: number;
      editing: boolean;
      at: string;
    }
  | { type: 'doc:update'; documentId: string; update: string; actorUserId: string; syncId?: string }
  | {
      type: 'doc:state';
      documentId: string;
      update: string;
      version: number;
      reason: 'join' | 'ack' | 'request';
    }
  | { type: 'doc:rejected'; documentId: string; reason: string }
  | {
      type: 'call:signal';
      roomId: string;
      from: string;
      kind: 'offer' | 'answer' | 'ice' | 'renegotiate' | 'bye';
      payload: Record<string, unknown>;
    }
  | {
      type: 'call:state';
      roomId: string;
      userId: string;
      audio: boolean;
      video: boolean;
      screen: boolean;
      connectionState: CallConnectionState;
    };

export interface StageCSnapshot {
  chats: number;
  unreadMessages: number;
  feedPosts: number;
  openPolls: number;
  openProposals: number;
  wishlists: number;
  documents: number;
  activeCalls: number;
  generatedAt: string;
  languages: Language[];
}
