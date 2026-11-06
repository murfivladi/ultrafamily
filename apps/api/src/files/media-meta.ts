import type { FileMetadata } from '@ufos/contracts';

/**
 * Dependency-free metadata parsing for the formats families actually upload:
 * image dimensions (PNG, GIF, JPEG, WebP) and the EXIF capture date of JPEGs.
 * Only the first bytes of the file are read.
 */

function jpegExifDate(buffer: Buffer, start: number, length: number): string | undefined {
  if (buffer.toString('latin1', start, start + 6) !== 'Exif\u0000\u0000') return undefined;
  const tiff = start + 6;
  const little = buffer.toString('latin1', tiff, tiff + 2) === 'II';
  const u16 = (offset: number) =>
    little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  const u32 = (offset: number) =>
    little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  const end = Math.min(buffer.length, start + length);
  const readIfd = (offset: number): Map<number, number> => {
    const tags = new Map<number, number>();
    const at = tiff + offset;
    if (at + 2 > end) return tags;
    const count = u16(at);
    for (let index = 0; index < count && index < 200; index += 1) {
      const entry = at + 2 + index * 12;
      if (entry + 12 > end) break;
      tags.set(u16(entry), entry);
    }
    return tags;
  };
  const readAscii = (entry: number): string | undefined => {
    const count = u32(entry + 4);
    const valueOffset = count > 4 ? tiff + u32(entry + 8) : entry + 8;
    if (valueOffset + count > end) return undefined;
    return buffer.toString('latin1', valueOffset, valueOffset + count).replace(/\u0000+$/, '');
  };
  try {
    const ifd0 = readIfd(u32(tiff + 4));
    let raw: string | undefined;
    const exifPointer = ifd0.get(0x8769);
    if (exifPointer !== undefined) {
      const exif = readIfd(u32(exifPointer + 8));
      const original = exif.get(0x9003) ?? exif.get(0x9004);
      if (original !== undefined) raw = readAscii(original);
    }
    if (!raw) {
      const modified = ifd0.get(0x0132);
      if (modified !== undefined) raw = readAscii(modified);
    }
    const match = raw ? /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(raw) : null;
    if (!match) return undefined;
    const date = new Date(
      `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`,
    );
    return Number.isNaN(date.getTime()) || date.getUTCFullYear() < 1900
      ? undefined
      : date.toISOString();
  } catch {
    return undefined;
  }
}

function jpegMeta(buffer: Buffer): FileMetadata {
  const meta: FileMetadata = {};
  let offset = 2;
  while (offset + 4 < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1]!;
    const length = buffer.readUInt16BE(offset + 2);
    if (marker === 0xe1 && !meta.takenAt) {
      const takenAt = jpegExifDate(buffer, offset + 4, length - 2);
      if (takenAt) meta.takenAt = takenAt;
    }
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (offset + 9 < buffer.length) {
        meta.height = buffer.readUInt16BE(offset + 5);
        meta.width = buffer.readUInt16BE(offset + 7);
      }
      break;
    }
    if (marker === 0xda) break;
    offset += 2 + length;
  }
  return meta;
}

export function mediaMetadata(mimeType: string, buffer: Buffer): FileMetadata {
  try {
    if (mimeType === 'image/png' && buffer.length >= 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (mimeType === 'image/gif' && buffer.length >= 10) {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (mimeType === 'image/jpeg') return jpegMeta(buffer);
    if (mimeType === 'image/webp' && buffer.length >= 30) {
      const chunk = buffer.toString('latin1', 12, 16);
      if (chunk === 'VP8X') {
        return {
          width: 1 + buffer.readUIntLE(24, 3),
          height: 1 + buffer.readUIntLE(27, 3),
        };
      }
      if (chunk === 'VP8L') {
        const bits = buffer.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8 ') {
        return {
          width: buffer.readUInt16LE(26) & 0x3fff,
          height: buffer.readUInt16LE(28) & 0x3fff,
        };
      }
    }
  } catch {
    return {};
  }
  return {};
}
