import type { FileKind } from '@ufos/contracts';

/**
 * File type detection by content ("magic bytes"), not by the name a client
 * claims. Executables and scripts are refused; files whose content contradicts
 * a media extension are refused too, so a renamed binary cannot be previewed.
 */

const EXTENSION_KIND: Record<string, FileKind> = {};
const register = (kind: FileKind, extensions: string[]) => {
  for (const extension of extensions) EXTENSION_KIND[extension] = kind;
};
register('image', [
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'heic',
  'heif',
  'avif',
  'bmp',
  'tif',
  'tiff',
  'svg',
]);
register('video', ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', '3gp']);
register('audio', ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac']);
register('pdf', ['pdf']);
register('text', [
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'xml',
  'log',
  'ics',
  'vcf',
  'html',
  'htm',
  'yaml',
  'yml',
]);
register('office', [
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  'rtf',
  'epub',
]);
register('archive', ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz']);

export const BLOCKED_EXTENSIONS = new Set([
  'exe',
  'dll',
  'com',
  'bat',
  'cmd',
  'msi',
  'msp',
  'scr',
  'pif',
  'cpl',
  'ps1',
  'psm1',
  'vbs',
  'vbe',
  'wsf',
  'wsh',
  'hta',
  'jar',
  'sh',
  'bash',
  'zsh',
  'csh',
  'run',
  'apk',
  'appimage',
  'deb',
  'rpm',
  'lnk',
  'reg',
  'scf',
  'jse',
]);

// Types that browsers may render inline. Everything else is served as an
// attachment; SVG/HTML are never inline because they can carry scripts.
const INLINE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/mp4',
  'application/pdf',
  'text/plain; charset=utf-8',
]);

const EXTENSION_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  '3gp': 'video/3gpp',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  markdown: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8',
  tsv: 'text/plain; charset=utf-8',
  json: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  yaml: 'text/plain; charset=utf-8',
  yml: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  ics: 'text/calendar',
  vcf: 'text/vcard',
  html: 'text/html',
  htm: 'text/html',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  epub: 'application/epub+zip',
  zip: 'application/zip',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  bz2: 'application/x-bzip2',
  xz: 'application/x-xz',
};

type Signature =
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'bmp'
  | 'tiff'
  | 'pdf'
  | 'zip'
  | 'gzip'
  | '7z'
  | 'rar'
  | 'mp4'
  | 'heic'
  | 'quicktime'
  | 'webm'
  | 'mp3'
  | 'ogg'
  | 'wav'
  | 'flac'
  | 'ole'
  | 'rtf'
  | 'executable'
  | 'script'
  | 'text'
  | 'unknown';

function startsWith(buffer: Buffer, bytes: number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}

function ascii(buffer: Buffer, start: number, end: number): string {
  return buffer.subarray(start, end).toString('latin1');
}

export function sniff(head: Buffer): Signature {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47])) return 'png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (ascii(head, 0, 4) === 'GIF8') return 'gif';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return 'webp';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WAVE') return 'wav';
  if (ascii(head, 0, 2) === 'BM') return 'bmp';
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) {
    return 'tiff';
  }
  if (ascii(head, 0, 5) === '%PDF-') return 'pdf';
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) {
    return 'zip';
  }
  if (startsWith(head, [0x1f, 0x8b])) return 'gzip';
  if (startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z';
  if (ascii(head, 0, 4) === 'Rar!') return 'rar';
  if (ascii(head, 4, 8) === 'ftyp') {
    const brand = ascii(head, 8, 12);
    if (/^(heic|heix|hevc|mif1|msf1|avif)/.test(brand)) return 'heic';
    if (brand === 'qt  ') return 'quicktime';
    return 'mp4';
  }
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return 'webm';
  if (
    ascii(head, 0, 3) === 'ID3' ||
    startsWith(head, [0xff, 0xfb]) ||
    startsWith(head, [0xff, 0xf3])
  ) {
    return 'mp3';
  }
  if (ascii(head, 0, 4) === 'OggS') return 'ogg';
  if (ascii(head, 0, 4) === 'fLaC') return 'flac';
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole';
  if (ascii(head, 0, 5) === '{\\rtf') return 'rtf';
  // Windows PE, ELF, Mach-O (32/64/fat) binaries.
  if (
    ascii(head, 0, 2) === 'MZ' ||
    startsWith(head, [0x7f, 0x45, 0x4c, 0x46]) ||
    startsWith(head, [0xfe, 0xed, 0xfa, 0xce]) ||
    startsWith(head, [0xfe, 0xed, 0xfa, 0xcf]) ||
    startsWith(head, [0xcf, 0xfa, 0xed, 0xfe]) ||
    startsWith(head, [0xce, 0xfa, 0xed, 0xfe]) ||
    startsWith(head, [0xca, 0xfe, 0xba, 0xbe])
  ) {
    return 'executable';
  }
  if (ascii(head, 0, 2) === '#!') return 'script';
  if (head.length === 0) return 'text';
  const sample = head.subarray(0, Math.min(head.length, 8192));
  if (sample.includes(0)) return 'unknown';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, trimUtf8(sample)));
    return 'text';
  } catch {
    return 'unknown';
  }
}

// Do not fail UTF-8 validation because the sample cut a multi-byte character.
function trimUtf8(sample: Buffer): number {
  let end = sample.length;
  for (let back = 1; back <= 3 && end - back >= 0; back += 1) {
    const byte = sample[end - back]!;
    if ((byte & 0xc0) === 0xc0) return end - back;
    if ((byte & 0xc0) !== 0x80) break;
  }
  return end;
}

const SIGNATURE_KIND: Partial<Record<Signature, FileKind>> = {
  png: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  tiff: 'image',
  heic: 'image',
  pdf: 'pdf',
  mp4: 'video',
  quicktime: 'video',
  webm: 'video',
  mp3: 'audio',
  ogg: 'audio',
  wav: 'audio',
  flac: 'audio',
};

const SIGNATURE_MIME: Partial<Record<Signature, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  heic: 'image/heic',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  quicktime: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
};

export interface FileClassification {
  extension: string;
  kind: FileKind;
  mimeType: string;
  blocked: string | null;
  signature: Signature;
}

export function extensionOf(name: string): string {
  const base = name.split('/').pop() ?? name;
  const index = base.lastIndexOf('.');
  if (index <= 0 || index === base.length - 1) return '';
  return base.slice(index + 1).toLowerCase();
}

export function classify(name: string, head: Buffer): FileClassification {
  const extension = extensionOf(name);
  const signature = sniff(head);
  const byExtension = EXTENSION_KIND[extension];
  const result = (kind: FileKind, mimeType: string, blocked: string | null = null) => ({
    extension,
    kind,
    mimeType,
    blocked,
    signature,
  });

  if (BLOCKED_EXTENSIONS.has(extension)) {
    return result('other', 'application/octet-stream', 'blocked_extension');
  }
  if (signature === 'executable') {
    return result('other', 'application/octet-stream', 'executable_content');
  }
  if (signature === 'script') {
    return result('other', 'application/octet-stream', 'script_content');
  }

  const bySignature = SIGNATURE_KIND[signature];
  // A media/PDF extension must match real media/PDF content.
  if (
    byExtension &&
    ['image', 'video', 'audio', 'pdf'].includes(byExtension) &&
    extension !== 'svg'
  ) {
    // mp4/m4a and ogg audio/video share containers; anything else is a renamed file.
    const compatible =
      bySignature === byExtension ||
      (byExtension === 'audio' && bySignature === 'video') ||
      (byExtension === 'video' && bySignature === 'audio');
    if (!compatible) return result('other', 'application/octet-stream', 'type_mismatch');
  }
  if (bySignature) {
    const mime =
      byExtension === 'audio' && signature === 'mp4'
        ? 'audio/mp4'
        : (SIGNATURE_MIME[signature] ?? 'application/octet-stream');
    return result(byExtension === 'audio' ? 'audio' : bySignature, mime);
  }
  if (extension === 'svg') {
    return result('image', 'image/svg+xml');
  }
  if (signature === 'zip') {
    if (byExtension === 'office')
      return result('office', EXTENSION_MIME[extension] ?? 'application/zip');
    return result('archive', 'application/zip');
  }
  if (signature === 'gzip' || signature === '7z' || signature === 'rar') {
    return result('archive', EXTENSION_MIME[extension] ?? 'application/octet-stream');
  }
  if (signature === 'ole' || signature === 'rtf') {
    return result('office', EXTENSION_MIME[extension] ?? 'application/octet-stream');
  }
  if (signature === 'text') {
    if (byExtension === 'office' || byExtension === 'archive') {
      return result(byExtension, EXTENSION_MIME[extension] ?? 'application/octet-stream');
    }
    const mime = EXTENSION_MIME[extension];
    return result('text', mime ?? 'text/plain; charset=utf-8');
  }
  if (byExtension === 'archive' && extension === 'tar') {
    return result('archive', 'application/x-tar');
  }
  return result('other', 'application/octet-stream');
}

export function isInlineSafe(mimeType: string): boolean {
  return INLINE_MIME.has(mimeType);
}

export function isPreviewable(kind: FileKind, mimeType: string): boolean {
  if (kind === 'text' || kind === 'office' || kind === 'archive') return true;
  return isInlineSafe(mimeType);
}

export function sanitizeFileName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
    .replace(/^\.+/, '_')
    .trim()
    .slice(0, 240);
  return cleaned.length > 0 ? cleaned : 'file';
}

/** RFC 6266 / 5987 Content-Disposition with a safe ASCII fallback. */
export function contentDisposition(type: 'inline' | 'attachment', name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
