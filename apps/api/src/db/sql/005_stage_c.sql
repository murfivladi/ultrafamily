-- Ultra Family OS — Stage C: communication and collaboration.
-- Safe additive migration: existing Stage A/B installations keep all data.
-- Every table carries space_id (directly or through its parent) so the same
-- AccessService checks apply to chats, feed, decisions, documents and calls.

-- ---------------------------------------------------------------------------
-- Messenger
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'group' CHECK (kind IN ('direct', 'group', 'channel')),
  name TEXT NOT NULL DEFAULT '',
  topic TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'members' CHECK (visibility IN ('members', 'space')),
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  direct_key TEXT,
  last_message_at TIMESTAMPTZ,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS chats_direct_key_unique
  ON chats (space_id, direct_key)
  WHERE direct_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS chats_space_idx ON chats (space_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'moderator', 'member')),
  notification_level TEXT NOT NULL DEFAULT 'all' CHECK (notification_level IN ('all', 'mentions', 'muted')),
  restricted_until TIMESTAMPTZ,
  last_read_at TIMESTAMPTZ,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id, user_id)
);

CREATE INDEX IF NOT EXISTS chat_members_user_idx ON chat_members (user_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  thread_root_id TEXT REFERENCES chat_messages(id) ON DELETE CASCADE,
  author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL DEFAULT '',
  mentions JSONB NOT NULL DEFAULT '[]'::jsonb,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  client_key TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Idempotency: a retried send with the same client key never duplicates a message.
CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_client_key_unique
  ON chat_messages (chat_id, author_user_id, client_key)
  WHERE client_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS chat_messages_chat_idx ON chat_messages (chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS chat_messages_thread_idx ON chat_messages (thread_root_id, created_at ASC);

CREATE TABLE IF NOT EXISTS chat_message_versions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  edited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (message_id, version)
);

CREATE TABLE IF NOT EXISTS chat_reactions (
  message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS chat_attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'file' CHECK (kind IN ('file', 'photo', 'link')),
  url TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_receipts (
  message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS chat_moderation_log (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_message_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Family feed
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS feed_posts (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'news'
    CHECK (kind IN ('news', 'announcement', 'photo', 'moment', 'system')),
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'household' CHECK (visibility IN ('household', 'network')),
  audience_space_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  media JSONB NOT NULL DEFAULT '[]'::jsonb,
  auto_event_key TEXT,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMPTZ,
  deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS feed_posts_auto_event_unique
  ON feed_posts (space_id, auto_event_key)
  WHERE auto_event_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS feed_posts_space_idx ON feed_posts (space_id, published_at DESC);

CREATE TABLE IF NOT EXISTS feed_comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS feed_comments_post_idx ON feed_comments (post_id, created_at ASC);

CREATE TABLE IF NOT EXISTS feed_reactions (
  post_id TEXT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (post_id, user_id, emoji)
);

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS feed_event_sources JSONB
  NOT NULL DEFAULT '["birthdays","plans","photos","announcements"]'::jsonb;

-- ---------------------------------------------------------------------------
-- Polls, proposals, governance, wishlists and decision history
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS space_governance (
  space_id TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
  quorum_percent INTEGER NOT NULL DEFAULT 50,
  voting_rule TEXT NOT NULL DEFAULT 'majority'
    CHECK (voting_rule IN ('majority', 'two_thirds', 'unanimous')),
  allow_abstain BOOLEAN NOT NULL DEFAULT TRUE,
  default_duration_hours INTEGER NOT NULL DEFAULT 72,
  auto_close_polls BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS polls (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'simple' CHECK (kind IN ('simple', 'date')),
  question TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  multi_choice BOOLEAN NOT NULL DEFAULT FALSE,
  anonymous BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  quorum_percent INTEGER NOT NULL DEFAULT 50,
  voting_rule TEXT NOT NULL DEFAULT 'majority'
    CHECK (voting_rule IN ('majority', 'two_thirds', 'unanimous')),
  winning_option_key TEXT,
  closes_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS polls_space_idx ON polls (space_id, created_at DESC);

CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  comment TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (poll_id, user_id)
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'discussion'
    CHECK (status IN ('discussion', 'voting', 'accepted', 'rejected', 'withdrawn')),
  author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  voting_rule TEXT NOT NULL DEFAULT 'majority'
    CHECK (voting_rule IN ('majority', 'two_thirds', 'unanimous')),
  quorum_percent INTEGER NOT NULL DEFAULT 50,
  opens_at TIMESTAMPTZ,
  closes_at TIMESTAMPTZ,
  decided_at TIMESTAMPTZ,
  decision_summary TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS proposals_space_idx ON proposals (space_id, created_at DESC);

CREATE TABLE IF NOT EXISTS proposal_votes (
  proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  choice TEXT NOT NULL CHECK (choice IN ('yes', 'no', 'abstain')),
  comment TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (proposal_id, user_id)
);

CREATE TABLE IF NOT EXISTS decision_history (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  entity TEXT NOT NULL CHECK (entity IN ('poll', 'proposal', 'governance')),
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  summary TEXT NOT NULL DEFAULT '',
  snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS decision_history_space_idx
  ON decision_history (space_id, created_at DESC);

CREATE TABLE IF NOT EXISTS wishlists (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  visibility TEXT NOT NULL DEFAULT 'household' CHECK (visibility IN ('household', 'network')),
  occasion TEXT NOT NULL DEFAULT '',
  due_at TIMESTAMPTZ,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wishlist_items (
  id TEXT PRIMARY KEY,
  wishlist_id TEXT NOT NULL REFERENCES wishlists(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  price_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'EUR',
  notes TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 2,
  reserved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  purchased_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Documents and collaborative editing (Yjs)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'note'
    CHECK (kind IN ('note', 'document', 'table', 'presentation')),
  title TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'markdown'
    CHECK (format IN ('text', 'markdown', 'csv', 'slides')),
  content TEXT NOT NULL DEFAULT '',
  yjs_state TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS documents_space_idx ON documents (space_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (document_id, version)
);

CREATE TABLE IF NOT EXISTS document_collaborators (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read', 'comment', 'edit')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (document_id, user_id)
);

CREATE TABLE IF NOT EXISTS document_comments (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  anchor JSONB,
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS document_comments_doc_idx
  ON document_comments (document_id, created_at ASC);

CREATE TABLE IF NOT EXISTS document_presence (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cursor JSONB,
  editing BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (document_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Calls (WebRTC signaling and diagnostics) and collaboration presence
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS call_rooms (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'video' CHECK (kind IN ('audio', 'video')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS call_rooms_space_idx ON call_rooms (space_id, created_at DESC);

CREATE TABLE IF NOT EXISTS call_participants (
  room_id TEXT NOT NULL REFERENCES call_rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'participant' CHECK (role IN ('host', 'participant')),
  state TEXT NOT NULL DEFAULT 'invited' CHECK (state IN ('invited', 'joined', 'left')),
  audio BOOLEAN NOT NULL DEFAULT TRUE,
  video BOOLEAN NOT NULL DEFAULT FALSE,
  screen BOOLEAN NOT NULL DEFAULT FALSE,
  connection_state TEXT NOT NULL DEFAULT 'new',
  quality JSONB NOT NULL DEFAULT '{}'::jsonb,
  joined_at TIMESTAMPTZ,
  left_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (room_id, user_id)
);

-- HTTP fallback for signaling when a WebSocket cannot be established.
CREATE TABLE IF NOT EXISTS call_signals (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES call_rooms(id) ON DELETE CASCADE,
  from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('offer', 'answer', 'ice', 'renegotiate', 'bye')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS call_signals_pending_idx
  ON call_signals (to_user_id, room_id, created_at ASC) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS call_events (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES call_rooms(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  event TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS collaboration_presence (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'away')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (space_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Activate Stage C modules only where the toggle still carries the original
-- seed timestamp, exactly like 004 did for Stage B. Owner changes win.
-- ---------------------------------------------------------------------------

UPDATE module_toggles AS mt
SET enabled = TRUE,
    updated_at = CURRENT_TIMESTAMP
WHERE mt.module_id IN ('messenger', 'feed', 'decisions', 'documents', 'calls')
  AND mt.enabled = FALSE
  AND mt.updated_at = (
    SELECT MIN(mt2.updated_at)
    FROM module_toggles AS mt2
    WHERE mt2.space_id = mt.space_id
  );
