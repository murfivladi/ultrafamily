import { z } from 'zod';

const id = z.string().min(1).max(120);
const isoDate = z
  .string()
  .datetime({ offset: true })
  .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/));

export const folderSchema = z.object({
  name: z.string().trim().min(1).max(240),
  parentId: id.nullable().default(null),
});

export const folderPatchSchema = z.object({
  name: z.string().trim().min(1).max(240).optional(),
  parentId: id.nullable().optional(),
});

export const uploadSchema = z.object({
  folderId: id.nullable().default(null),
  name: z.string().trim().min(1).max(240),
  mimeType: z.string().max(200).default('application/octet-stream'),
  size: z.number().int().min(0),
  visibility: z.enum(['space', 'private']).default('space'),
  targetFileId: id.nullable().default(null),
  module: z.enum(['files', 'photos']).default('files'),
});

export const completeSchema = z.object({
  onConflict: z.enum(['version', 'rename', 'fail']).default('version'),
  module: z.enum(['files', 'photos']).default('files'),
  takenAt: isoDate.nullable().default(null),
});

export const filePatchSchema = z.object({
  name: z.string().trim().min(1).max(240).optional(),
  folderId: id.nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  description: z.string().max(4000).optional(),
  takenAt: isoDate.nullable().optional(),
  place: z.string().max(240).optional(),
  visibility: z.enum(['space', 'private']).optional(),
});

export const restoreSchema = z
  .object({ fileId: id.optional(), folderId: id.optional() })
  .refine((value) => Boolean(value.fileId) !== Boolean(value.folderId), 'file_or_folder');

export const versionRestoreSchema = z.object({ version: z.number().int().min(1) });

export const bulkSchema = z.object({
  action: z.enum(['move', 'trash', 'tag']),
  fileIds: z.array(id).min(1).max(200),
  folderId: id.nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
});

export const quotaSchema = z.object({
  quotaBytes: z.number().int().min(0),
  userQuotaBytes: z.number().int().min(0),
  trashRetentionDays: z.number().int().min(1).max(365).default(30),
});

export const webdavTokenSchema = z.object({
  name: z.string().trim().min(1).max(120),
  readOnly: z.boolean().default(false),
});
