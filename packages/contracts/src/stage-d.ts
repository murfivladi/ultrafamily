// Stage D — files and family memory: storage, gallery, search/OCR, journal,
// memories and the family encyclopedia. Shared between API and web.

export type FileKind =
  'image' | 'video' | 'audio' | 'pdf' | 'text' | 'office' | 'archive' | 'other';
export type FileVisibility = 'space' | 'private';
export type FileScanStatus = 'pending' | 'clean' | 'unscanned' | 'blocked';
export type FileOcrStatus = 'none' | 'pending' | 'done' | 'unavailable' | 'failed';

export interface FileFolder {
  id: string;
  spaceId: string;
  parentId: string | null;
  name: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface FileMetadata {
  width?: number;
  height?: number;
  takenAt?: string;
  durationSeconds?: number;
  pages?: number;
  [key: string]: unknown;
}

export interface FileItem {
  id: string;
  spaceId: string;
  folderId: string | null;
  name: string;
  extension: string;
  mimeType: string;
  kind: FileKind;
  visibility: FileVisibility;
  sizeBytes: number;
  sha256: string;
  version: number;
  scanStatus: FileScanStatus;
  scanDetail: string;
  ocrStatus: FileOcrStatus;
  hasText: boolean;
  metadata: FileMetadata;
  tags: string[];
  visualLabels: string[];
  description: string;
  takenAt: string | null;
  place: string;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  previewable: boolean;
}

export interface FileVersionEntry {
  id: string;
  fileId: string;
  version: number;
  sizeBytes: number;
  sha256: string;
  mimeType: string;
  note: string;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface FileListing {
  folder: FileFolder | null;
  breadcrumbs: Array<{ id: string | null; name: string }>;
  folders: FileFolder[];
  files: FileItem[];
}

export interface FileActivityEntry {
  id: string;
  fileId: string | null;
  folderId: string | null;
  userId: string | null;
  userName: string | null;
  action: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface StorageUsage {
  spaceId: string;
  usedBytes: number;
  quotaBytes: number;
  userUsedBytes: number;
  userQuotaBytes: number;
  trashBytes: number;
  fileCount: number;
  trashRetentionDays: number;
  disk: {
    driver: 'local' | 's3';
    freeBytes: number | null;
    totalBytes: number | null;
    lowSpace: boolean;
    note: string;
  };
}

export interface UploadSession {
  id: string;
  name: string;
  totalBytes: number;
  chunkBytes: number;
  totalChunks: number;
  receivedBytes: number;
  nextIndex: number;
  status: 'open' | 'complete' | 'aborted';
  expiresAt: string;
  resultFileId: string | null;
}

export interface ArchiveEntry {
  name: string;
  sizeBytes: number;
  compressedBytes: number;
  directory: boolean;
  flags: Array<'path_traversal' | 'absolute_path' | 'high_ratio' | 'nested_archive' | 'executable'>;
}

export interface ArchiveListing {
  fileId: string;
  format: 'zip' | 'unsupported';
  entries: ArchiveEntry[];
  totalUncompressedBytes: number;
  truncated: boolean;
  warnings: string[];
  extracted: false;
}

export interface FilePreview {
  fileId: string;
  mode: 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'archive' | 'none';
  contentUrl: string | null;
  text: string | null;
  truncated: boolean;
  reason: string | null;
}

export interface WebDavToken {
  id: string;
  name: string;
  readOnly: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  url: string;
  /** Returned only once, on creation. */
  token?: string;
}

export interface MediaJobSummary {
  id: string;
  fileId: string;
  kind: 'scan' | 'metadata' | 'ocr' | 'video' | 'faces';
  status: 'queued' | 'running' | 'done' | 'failed' | 'skipped';
  attempts: number;
  lastError: string;
  updatedAt: string;
}

export interface MediaEngineStatus {
  ocr: { available: boolean; engine: string };
  antivirus: { available: boolean; engine: string };
  video: { available: boolean; engine: string };
  faces: { available: boolean; engine: string };
  queue: { queued: number; running: number; failed: number; concurrency: number };
}

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

export interface MediaPeopleTag {
  id: string;
  personId: string | null;
  userId: string | null;
  label: string;
  box: { x: number; y: number; w: number; h: number } | null;
}

export interface MediaItem extends FileItem {
  favorite: boolean;
  commentCount: number;
  reactions: Array<{ emoji: string; count: number; mine: boolean }>;
  people: MediaPeopleTag[];
  albumIds: string[];
}

export interface MediaComment {
  id: string;
  fileId: string;
  authorUserId: string | null;
  authorName: string | null;
  body: string;
  createdAt: string;
}

export interface PhotoAlbum {
  id: string;
  spaceId: string;
  title: string;
  description: string;
  coverFileId: string | null;
  itemCount: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TimelineBucket {
  period: string; // YYYY-MM
  count: number;
  coverFileId: string | null;
}

export interface DuplicateGroup {
  sha256: string;
  sizeBytes: number;
  files: Array<Pick<FileItem, 'id' | 'name' | 'folderId' | 'createdAt' | 'kind'>>;
}

export interface ShareLink {
  id: string;
  targetKind: 'file' | 'album';
  targetId: string;
  label: string;
  passwordProtected: boolean;
  allowDownload: boolean;
  expiresAt: string;
  createdAt: string;
  createdBy: string | null;
  revokedAt: string | null;
  lastAccessAt: string | null;
  accessCount: number;
  active: boolean;
  /** Returned only once, on creation. */
  url?: string;
}

export interface PublicShareView {
  passwordRequired: boolean;
  label: string;
  targetKind: 'file' | 'album';
  allowDownload: boolean;
  expiresAt: string;
  grant?: string;
  items: Array<{
    id: string;
    name: string;
    kind: FileKind;
    mimeType: string;
    sizeBytes: number;
    contentUrl: string;
  }>;
}

export interface FaceRecognitionStatus {
  userId: string;
  enabled: boolean;
  isChild: boolean;
  consentBy: string | null;
  consentAt: string | null;
  engineAvailable: boolean;
  storedRepresentations: number;
  note: string;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export type SearchModule =
  | 'files'
  | 'photos'
  | 'documents'
  | 'journal'
  | 'encyclopedia'
  | 'messenger'
  | 'feed'
  | 'tasks'
  | 'calendar';

export interface SearchResult {
  id: string;
  module: SearchModule;
  spaceId: string;
  spaceName: string;
  title: string;
  snippet: string;
  matchedIn: Array<'title' | 'content' | 'tags' | 'ocr' | 'visual' | 'people' | 'place'>;
  date: string | null;
  personId: string | null;
  personName: string | null;
  href: string;
  score: number;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  searchedModules: SearchModule[];
  skippedModules: Array<{ module: SearchModule; reason: string }>;
  spaces: Array<{ id: string; name: string }>;
  tookMs: number;
}

// ---------------------------------------------------------------------------
// Journal and memories
// ---------------------------------------------------------------------------

export type JournalKind = 'diary' | 'story';
export type JournalVisibility = 'private' | 'family';

export interface JournalEntry {
  id: string;
  spaceId: string;
  authorUserId: string | null;
  authorName: string | null;
  kind: JournalKind;
  title: string;
  body: string;
  visibility: JournalVisibility;
  mood: string;
  entryDate: string;
  tags: string[];
  fileIds: string[];
  eventIds: string[];
  personIds: string[];
  sharedAt: string | null;
  createdAt: string;
  updatedAt: string;
  mine: boolean;
}

export type MemoryItemKind = 'journal' | 'story' | 'photo' | 'video' | 'audio' | 'birth' | 'event';

export interface MemoryItem {
  id: string;
  kind: MemoryItemKind;
  title: string;
  summary: string;
  date: string;
  href: string;
  fileId: string | null;
}

export interface MemoryYear {
  year: number;
  count: number;
  items: MemoryItem[];
}

export interface MemoryCollection {
  id: string;
  kind: 'on_this_day' | 'last_month' | 'album' | 'person' | 'stories';
  title: string;
  description: string;
  items: MemoryItem[];
}

// ---------------------------------------------------------------------------
// Encyclopedia
// ---------------------------------------------------------------------------

export type RelationKind = 'parent' | 'spouse' | 'sibling';

export interface FamilyPerson {
  id: string;
  spaceId: string;
  fullName: string;
  birthName: string;
  birthDate: string | null;
  deathDate: string | null;
  birthPlace: string;
  living: boolean;
  biography: string;
  contacts: { phone?: string; email?: string; address?: string } | null;
  contactsHidden: boolean;
  contactVisibility: 'owner' | 'adults' | 'family';
  visibility: 'private' | 'family';
  linkedUserId: string | null;
  publishAllowed: boolean;
  publishedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FamilyRelation {
  id: string;
  personId: string;
  relatedPersonId: string;
  kind: RelationKind;
  sinceDate: string | null;
  note: string;
}

export interface FamilyTree {
  people: Array<FamilyPerson & { generation: number }>;
  relations: FamilyRelation[];
}

export interface FamilyPersonDetail extends FamilyPerson {
  relations: Array<FamilyRelation & { otherName: string; direction: 'out' | 'in' }>;
  links: Array<{
    targetKind: 'journal' | 'file' | 'document' | 'album';
    targetId: string;
    title: string;
  }>;
  photos: Array<Pick<FileItem, 'id' | 'name' | 'kind' | 'takenAt'>>;
}

export interface PublicFamilyPerson {
  id: string;
  fullName: string;
  birthYear: number | null;
  deathYear: number | null;
  biography: string;
}
