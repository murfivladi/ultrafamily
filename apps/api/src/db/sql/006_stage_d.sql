-- Ultra Family OS — Stage D: files and family memory.
-- Safe additive migration: existing Stage A/B/C installations keep all data.
-- Every table carries space_id (directly or through its parent) so the same
-- AccessService checks apply to files, gallery, search, journal and the
-- family encyclopedia. Binary content never lives in PostgreSQL: rows point to
-- keys of the storage adapter (local disk now, S3-compatible later).

-- ---------------------------------------------------------------------------
-- File storage
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS space_storage_settings (
  space_id TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
  quota_bytes BIGINT NOT NULL,
  user_quota_bytes BIGINT NOT NULL,
  trash_retention_days INTEGER NOT NULL DEFAULT 30,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS file_folders (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES file_folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMPTZ,
  deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  trash_batch TEXT
);

CREATE INDEX IF NOT EXISTS file_folders_space_idx ON file_folders (space_id, parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS file_folders_name_unique
  ON file_folders (space_id, COALESCE(parent_id, ''), LOWER(name))
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES file_folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  extension TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  kind TEXT NOT NULL DEFAULT 'other'
    CHECK (kind IN ('image', 'video', 'audio', 'pdf', 'text', 'office', 'archive', 'other')),
  visibility TEXT NOT NULL DEFAULT 'space' CHECK (visibility IN ('space', 'private')),
  size_bytes BIGINT NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  storage_key TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  scan_status TEXT NOT NULL DEFAULT 'unscanned'
    CHECK (scan_status IN ('pending', 'clean', 'unscanned', 'blocked')),
  scan_detail TEXT NOT NULL DEFAULT '',
  ocr_status TEXT NOT NULL DEFAULT 'none'
    CHECK (ocr_status IN ('none', 'pending', 'done', 'unavailable', 'failed')),
  ocr_text TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  visual_labels JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  description TEXT NOT NULL DEFAULT '',
  taken_at TIMESTAMPTZ,
  place TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMPTZ,
  deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  trash_batch TEXT
);

CREATE INDEX IF NOT EXISTS files_space_folder_idx ON files (space_id, folder_id, name);
CREATE INDEX IF NOT EXISTS files_space_kind_idx ON files (space_id, kind, taken_at DESC);
CREATE INDEX IF NOT EXISTS files_sha_idx ON files (space_id, sha256);
CREATE UNIQUE INDEX IF NOT EXISTS files_name_unique
  ON files (space_id, COALESCE(folder_id, ''), LOWER(name))
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS file_versions (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  storage_key TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (file_id, version)
);

CREATE INDEX IF NOT EXISTS file_versions_usage_idx ON file_versions (space_id, created_by);

CREATE TABLE IF NOT EXISTS file_upload_sessions (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES file_folders(id) ON DELETE SET NULL,
  target_file_id TEXT REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  visibility TEXT NOT NULL DEFAULT 'space',
  total_bytes BIGINT NOT NULL,
  chunk_bytes INTEGER NOT NULL,
  received_bytes BIGINT NOT NULL DEFAULT 0,
  next_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'complete', 'aborted')),
  temp_key TEXT NOT NULL,
  result_file_id TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS file_upload_sessions_open_idx
  ON file_upload_sessions (space_id, user_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS file_activity (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  file_id TEXT,
  folder_id TEXT,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS file_activity_space_idx ON file_activity (space_id, created_at DESC);
CREATE INDEX IF NOT EXISTS file_activity_file_idx ON file_activity (file_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webdav_tokens (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  read_only BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- Media processing queue (scan, metadata, OCR, video). Bounded, persistent.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS media_jobs (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('scan', 'metadata', 'ocr', 'video', 'faces')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  run_after TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS media_jobs_queue_idx ON media_jobs (status, run_after);

-- ---------------------------------------------------------------------------
-- Gallery
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS photo_albums (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cover_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS photo_album_items (
  album_id TEXT NOT NULL REFERENCES photo_albums(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (album_id, file_id)
);

CREATE TABLE IF NOT EXISTS media_comments (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS media_comments_file_idx ON media_comments (file_id, created_at);

CREATE TABLE IF NOT EXISTS media_reactions (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (file_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS media_favorites (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (file_id, user_id)
);

CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('file', 'album')),
  target_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  allow_download BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  last_access_at TIMESTAMPTZ,
  access_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS share_links_target_idx ON share_links (space_id, target_kind, target_id);

-- Local face recognition is opt-in per person and per space. Children stay
-- disabled unless a guardian (space owner/admin) records consent.
CREATE TABLE IF NOT EXISTS face_recognition_settings (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  consent_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  consent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (space_id, user_id)
);

-- Deletable biometric representations, produced only by a local engine.
CREATE TABLE IF NOT EXISTS face_embeddings (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id TEXT REFERENCES files(id) ON DELETE CASCADE,
  vector JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Family encyclopedia (people, relations, links)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS family_people (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  birth_name TEXT NOT NULL DEFAULT '',
  birth_date DATE,
  death_date DATE,
  birth_place TEXT NOT NULL DEFAULT '',
  biography TEXT NOT NULL DEFAULT '',
  contacts JSONB NOT NULL DEFAULT '{}'::jsonb,
  contact_visibility TEXT NOT NULL DEFAULT 'adults'
    CHECK (contact_visibility IN ('owner', 'adults', 'family')),
  visibility TEXT NOT NULL DEFAULT 'family' CHECK (visibility IN ('private', 'family')),
  linked_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  publish_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  publish_consent_note TEXT NOT NULL DEFAULT '',
  published_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS family_people_space_idx ON family_people (space_id, full_name);

CREATE TABLE IF NOT EXISTS family_relations (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES family_people(id) ON DELETE CASCADE,
  related_person_id TEXT NOT NULL REFERENCES family_people(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('parent', 'spouse', 'sibling')),
  since_date DATE,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (person_id, related_person_id, kind)
);

CREATE TABLE IF NOT EXISTS family_person_links (
  person_id TEXT NOT NULL REFERENCES family_people(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('journal', 'file', 'document', 'album')),
  target_id TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (person_id, target_kind, target_id)
);

-- Manual people tags on photos/videos (available before any face engine).
CREATE TABLE IF NOT EXISTS media_people_tags (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  person_id TEXT REFERENCES family_people(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  box JSONB,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS media_people_tags_file_idx ON media_people_tags (file_id);

-- ---------------------------------------------------------------------------
-- Journal: private diaries, family entries and family stories
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  author_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'diary' CHECK (kind IN ('diary', 'story')),
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'family')),
  mood TEXT NOT NULL DEFAULT '',
  entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  file_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  event_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  person_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  shared_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS journal_entries_space_idx ON journal_entries (space_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS journal_entries_author_idx ON journal_entries (author_user_id, entry_date DESC);

-- ---------------------------------------------------------------------------
-- Activate Stage D modules only where the toggle still carries the original
-- seed timestamp, exactly like 004/005 did. Owner changes always win.
-- ---------------------------------------------------------------------------

UPDATE module_toggles AS mt
SET enabled = TRUE,
    updated_at = CURRENT_TIMESTAMP
WHERE mt.module_id IN ('files', 'photos', 'search', 'journal', 'memories', 'encyclopedia')
  AND mt.enabled = FALSE
  AND mt.updated_at = (
    SELECT MIN(mt2.updated_at)
    FROM module_toggles AS mt2
    WHERE mt2.space_id = mt.space_id
  );
