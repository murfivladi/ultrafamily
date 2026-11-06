import type {
  FamilyPerson,
  FamilyRelation,
  FileActivityEntry,
  FileFolder,
  FileItem,
  FileKind,
  FileMetadata,
  FileOcrStatus,
  FileScanStatus,
  FileVersionEntry,
  FileVisibility,
  JournalEntry,
  JournalKind,
  JournalVisibility,
  MediaComment,
  PhotoAlbum,
  RelationKind,
  ShareLink,
} from '@ufos/contracts';
import { iso, parseJson } from '../db/rows';
import { isPreviewable } from '../files/file-types';

type Stamp = Date | string;

export interface FolderRow {
  id: string;
  space_id: string;
  parent_id: string | null;
  name: string;
  created_by: string | null;
  created_at: Stamp;
  updated_at: Stamp;
  deleted_at: Stamp | null;
  trash_batch?: string | null;
}

export interface FileRow {
  id: string;
  space_id: string;
  folder_id: string | null;
  name: string;
  extension: string;
  mime_type: string;
  kind: FileKind;
  visibility: FileVisibility;
  size_bytes: number | string;
  sha256: string;
  storage_key: string;
  version: number | string;
  scan_status: FileScanStatus;
  scan_detail: string;
  ocr_status: FileOcrStatus;
  ocr_text: string;
  metadata: unknown;
  visual_labels: unknown;
  tags: unknown;
  description: string;
  taken_at: Stamp | null;
  place: string;
  created_by: string | null;
  created_by_name?: string | null;
  updated_by: string | null;
  created_at: Stamp;
  updated_at: Stamp;
  deleted_at: Stamp | null;
  trash_batch?: string | null;
}

export interface FileVersionRow {
  id: string;
  file_id: string;
  space_id: string;
  version: number | string;
  size_bytes: number | string;
  sha256: string;
  mime_type: string;
  storage_key: string;
  note: string;
  created_by: string | null;
  created_by_name?: string | null;
  created_at: Stamp;
}

export interface UploadSessionRow {
  id: string;
  space_id: string;
  user_id: string;
  folder_id: string | null;
  target_file_id: string | null;
  name: string;
  mime_type: string;
  visibility: FileVisibility;
  total_bytes: number | string;
  chunk_bytes: number | string;
  received_bytes: number | string;
  next_index: number | string;
  status: 'open' | 'complete' | 'aborted';
  temp_key: string;
  result_file_id: string | null;
  expires_at: Stamp;
}

export interface ActivityRow {
  id: string;
  file_id: string | null;
  folder_id: string | null;
  user_id: string | null;
  user_name?: string | null;
  action: string;
  detail: unknown;
  created_at: Stamp;
}

export interface AlbumRow {
  id: string;
  space_id: string;
  title: string;
  description: string;
  cover_file_id: string | null;
  item_count?: number | string;
  created_by: string | null;
  created_at: Stamp;
  updated_at: Stamp;
}

export interface ShareRow {
  id: string;
  space_id: string;
  target_kind: 'file' | 'album';
  target_id: string;
  label: string;
  token_hash: string;
  password_hash: string | null;
  allow_download: boolean;
  expires_at: Stamp;
  created_by: string | null;
  created_at: Stamp;
  revoked_at: Stamp | null;
  last_access_at: Stamp | null;
  access_count: number | string;
}

export interface JournalRow {
  id: string;
  space_id: string;
  author_user_id: string | null;
  author_name?: string | null;
  kind: JournalKind;
  title: string;
  body: string;
  visibility: JournalVisibility;
  mood: string;
  entry_date: Stamp;
  tags: unknown;
  file_ids: unknown;
  event_ids: unknown;
  person_ids: unknown;
  shared_at: Stamp | null;
  created_at: Stamp;
  updated_at: Stamp;
}

export interface PersonRow {
  id: string;
  space_id: string;
  full_name: string;
  birth_name: string;
  birth_date: Stamp | null;
  death_date: Stamp | null;
  birth_place: string;
  biography: string;
  contacts: unknown;
  contact_visibility: 'owner' | 'adults' | 'family';
  visibility: 'private' | 'family';
  linked_user_id: string | null;
  publish_allowed: boolean;
  publish_consent_note: string;
  published_at: Stamp | null;
  created_by: string | null;
  created_at: Stamp;
  updated_at: Stamp;
}

export interface RelationRow {
  id: string;
  person_id: string;
  related_person_id: string;
  kind: RelationKind;
  since_date: Stamp | null;
  note: string;
}

const stamp = (value: Stamp | null | undefined): string => iso(value) ?? new Date(0).toISOString();

/** DATE columns come back as Date at UTC midnight (pg) or strings (PGlite). */
export function dateOnly(value: Stamp | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  // node-postgres parses DATE as local midnight, PGlite as UTC midnight; keep
  // the calendar day stable in both cases.
  const utcMidnight = value.getUTCHours() === 0 && value.getUTCMinutes() === 0;
  const year = utcMidnight ? value.getUTCFullYear() : value.getFullYear();
  const month = (utcMidnight ? value.getUTCMonth() : value.getMonth()) + 1;
  const day = utcMidnight ? value.getUTCDate() : value.getDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function toFolder(row: FolderRow): FileFolder {
  return {
    id: row.id,
    spaceId: row.space_id,
    parentId: row.parent_id,
    name: row.name,
    createdBy: row.created_by,
    createdAt: stamp(row.created_at),
    updatedAt: stamp(row.updated_at),
    deletedAt: iso(row.deleted_at),
  };
}

export function toFileItem(row: FileRow): FileItem {
  return {
    id: row.id,
    spaceId: row.space_id,
    folderId: row.folder_id,
    name: row.name,
    extension: row.extension,
    mimeType: row.mime_type,
    kind: row.kind,
    visibility: row.visibility,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    version: Number(row.version),
    scanStatus: row.scan_status,
    scanDetail: row.scan_detail,
    ocrStatus: row.ocr_status,
    hasText: (row.ocr_text ?? '').length > 0,
    metadata: parseJson<FileMetadata>(row.metadata, {}),
    tags: parseJson<string[]>(row.tags, []),
    visualLabels: parseJson<string[]>(row.visual_labels, []),
    description: row.description,
    takenAt: iso(row.taken_at),
    place: row.place,
    createdBy: row.created_by,
    createdByName: row.created_by_name ?? null,
    createdAt: stamp(row.created_at),
    updatedAt: stamp(row.updated_at),
    deletedAt: iso(row.deleted_at),
    previewable: row.scan_status !== 'blocked' && isPreviewable(row.kind, row.mime_type),
  };
}

export function toFileVersion(row: FileVersionRow): FileVersionEntry {
  return {
    id: row.id,
    fileId: row.file_id,
    version: Number(row.version),
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    mimeType: row.mime_type,
    note: row.note,
    createdBy: row.created_by,
    createdByName: row.created_by_name ?? null,
    createdAt: stamp(row.created_at),
  };
}

export function toActivity(row: ActivityRow): FileActivityEntry {
  return {
    id: row.id,
    fileId: row.file_id,
    folderId: row.folder_id,
    userId: row.user_id,
    userName: row.user_name ?? null,
    action: row.action,
    detail: parseJson<Record<string, unknown>>(row.detail, {}),
    createdAt: stamp(row.created_at),
  };
}

export function toAlbum(row: AlbumRow): PhotoAlbum {
  return {
    id: row.id,
    spaceId: row.space_id,
    title: row.title,
    description: row.description,
    coverFileId: row.cover_file_id,
    itemCount: Number(row.item_count ?? 0),
    createdBy: row.created_by,
    createdAt: stamp(row.created_at),
    updatedAt: stamp(row.updated_at),
  };
}

export function toMediaComment(row: {
  id: string;
  file_id: string;
  author_user_id: string | null;
  author_name?: string | null;
  body: string;
  created_at: Stamp;
}): MediaComment {
  return {
    id: row.id,
    fileId: row.file_id,
    authorUserId: row.author_user_id,
    authorName: row.author_name ?? null,
    body: row.body,
    createdAt: stamp(row.created_at),
  };
}

export function toShareLink(row: ShareRow): ShareLink {
  const expiresAt = stamp(row.expires_at);
  return {
    id: row.id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    label: row.label,
    passwordProtected: Boolean(row.password_hash),
    allowDownload: row.allow_download,
    expiresAt,
    createdAt: stamp(row.created_at),
    createdBy: row.created_by,
    revokedAt: iso(row.revoked_at),
    lastAccessAt: iso(row.last_access_at),
    accessCount: Number(row.access_count),
    active: !row.revoked_at && new Date(expiresAt).getTime() > Date.now(),
  };
}

export function toJournalEntry(row: JournalRow, viewerId: string): JournalEntry {
  return {
    id: row.id,
    spaceId: row.space_id,
    authorUserId: row.author_user_id,
    authorName: row.author_name ?? null,
    kind: row.kind,
    title: row.title,
    body: row.body,
    visibility: row.visibility,
    mood: row.mood,
    entryDate: dateOnly(row.entry_date) ?? '',
    tags: parseJson<string[]>(row.tags, []),
    fileIds: parseJson<string[]>(row.file_ids, []),
    eventIds: parseJson<string[]>(row.event_ids, []),
    personIds: parseJson<string[]>(row.person_ids, []),
    sharedAt: iso(row.shared_at),
    createdAt: stamp(row.created_at),
    updatedAt: stamp(row.updated_at),
    mine: row.author_user_id === viewerId,
  };
}

export function toPerson(row: PersonRow, showContacts: boolean): FamilyPerson {
  const contacts = parseJson<FamilyPerson['contacts']>(row.contacts, {});
  return {
    id: row.id,
    spaceId: row.space_id,
    fullName: row.full_name,
    birthName: row.birth_name,
    birthDate: dateOnly(row.birth_date),
    deathDate: dateOnly(row.death_date),
    birthPlace: row.birth_place,
    living: !row.death_date,
    biography: row.biography,
    contacts: showContacts ? contacts : null,
    contactsHidden: !showContacts && Object.keys(contacts ?? {}).length > 0,
    contactVisibility: row.contact_visibility,
    visibility: row.visibility,
    linkedUserId: row.linked_user_id,
    publishAllowed: row.publish_allowed,
    publishedAt: iso(row.published_at),
    createdBy: row.created_by,
    createdAt: stamp(row.created_at),
    updatedAt: stamp(row.updated_at),
  };
}

export function toRelation(row: RelationRow): FamilyRelation {
  return {
    id: row.id,
    personId: row.person_id,
    relatedPersonId: row.related_person_id,
    kind: row.kind,
    sinceDate: dateOnly(row.since_date),
    note: row.note,
  };
}
