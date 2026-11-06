import zlib from 'node:zlib';
import type { ArchiveEntry } from '@ufos/contracts';
import { BLOCKED_EXTENSIONS, extensionOf } from './file-types';

/**
 * Read-only ZIP inspection. Nothing is ever extracted to disk: the server only
 * reads the central directory to list entries and flags dangerous ones
 * (path traversal, absolute paths, zip-bomb ratios, nested archives,
 * executables). Single entries can be inflated into memory with a hard limit
 * for text extraction from office documents.
 */

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
export const MAX_ENTRIES = 2000;
const HIGH_RATIO = 100;

export interface ZipEntryRecord extends ArchiveEntry {
  method: number;
  localOffset: number;
}

export interface ZipDirectory {
  entries: ZipEntryRecord[];
  truncated: boolean;
  zip64: boolean;
}

export function readZipDirectory(buffer: Buffer): ZipDirectory | null {
  const searchStart = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) return null;
  const total = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  const zip64 = directoryOffset === 0xffffffff || total === 0xffff;
  if (zip64 || directoryOffset >= buffer.length) {
    return { entries: [], truncated: true, zip64: true };
  }
  const entries: ZipEntryRecord[] = [];
  let pointer = directoryOffset;
  for (let index = 0; index < total && index < MAX_ENTRIES; index += 1) {
    if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== CENTRAL) break;
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedBytes = buffer.readUInt32LE(pointer + 20);
    const sizeBytes = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8');
    const directory = name.endsWith('/');
    const flags: ArchiveEntry['flags'] = [];
    const segments = name.split(/[\\/]/);
    if (segments.includes('..')) flags.push('path_traversal');
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) flags.push('absolute_path');
    if (!directory && compressedBytes > 0 && sizeBytes / compressedBytes > HIGH_RATIO) {
      flags.push('high_ratio');
    }
    const extension = extensionOf(name);
    if (['zip', '7z', 'rar', 'gz', 'tgz', 'tar'].includes(extension)) flags.push('nested_archive');
    if (BLOCKED_EXTENSIONS.has(extension)) flags.push('executable');
    entries.push({ name, sizeBytes, compressedBytes, directory, flags, method, localOffset });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, truncated: total > entries.length, zip64: false };
}

/** Inflates one entry into memory; returns null when it is too large or unsupported. */
export function readZipEntry(
  buffer: Buffer,
  entry: ZipEntryRecord,
  maxBytes = 8 * 1024 * 1024,
): Buffer | null {
  if (entry.sizeBytes > maxBytes) return null;
  const offset = entry.localOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== LOCAL) return null;
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const data = buffer.subarray(start, start + entry.compressedBytes);
  try {
    if (entry.method === 0) return Buffer.from(data);
    if (entry.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: maxBytes });
  } catch {
    return null;
  }
  return null;
}
