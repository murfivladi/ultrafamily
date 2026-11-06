import zlib from 'node:zlib';
import type { FileKind } from '@ufos/contracts';
import { readZipDirectory, readZipEntry } from './archive';

/**
 * Text extraction for search: plain text, the text layer of PDFs and the XML
 * body of OOXML/ODF office documents. Image OCR is delegated to an optional
 * local engine (OCR_COMMAND) by the media queue. All work is bounded.
 */

export const MAX_EXTRACTED_CHARS = 200_000;

function clamp(text: string): string {
  const normalized = text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return normalized.trim().slice(0, MAX_EXTRACTED_CHARS);
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

export function xmlToText(xml: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<(w:p|a:p|text:p|text:h|row|w:br|text:line-break)[\s>/][^>]*>/g, '\n$&')
      .replace(/<w:tab\/>|<text:tab\/>/g, '\t')
      .replace(/<[^>]+>/g, ''),
  );
}

function officeText(buffer: Buffer): string {
  const directory = readZipDirectory(buffer);
  if (!directory) return '';
  const wanted = directory.entries.filter((entry) =>
    /^(word\/document\.xml|word\/(header|footer)\d*\.xml|xl\/sharedStrings\.xml|ppt\/slides\/slide\d+\.xml|content\.xml)$/.test(
      entry.name,
    ),
  );
  wanted.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  const parts: string[] = [];
  let total = 0;
  for (const entry of wanted) {
    const data = readZipEntry(buffer, entry);
    if (!data) continue;
    const text = xmlToText(data.toString('utf8'));
    parts.push(text);
    total += text.length;
    if (total > MAX_EXTRACTED_CHARS) break;
  }
  return parts.join('\n');
}

function decodePdfString(raw: string): string {
  let output = '';
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (character !== '\\') {
      output += character;
      continue;
    }
    const next = raw[index + 1];
    index += 1;
    if (next === undefined) break;
    if (next === 'n') output += '\n';
    else if (next === 'r') output += '\r';
    else if (next === 't') output += '\t';
    else if (next === 'b' || next === 'f') output += '';
    else if (/[0-7]/.test(next)) {
      let octal = next;
      while (octal.length < 3 && /[0-7]/.test(raw[index + 1] ?? '')) {
        octal += raw[index + 1];
        index += 1;
      }
      output += String.fromCharCode(parseInt(octal, 8));
    } else if (next === '\n' || next === '\r') {
      // line continuation
    } else output += next;
  }
  return output;
}

function pdfOperatorsToText(content: string): string {
  const lines: string[] = [];
  let current = '';
  const tokenPattern = /\((?:\\.|[^\\)])*\)|\[(?:\\.|[^\]])*\]\s*TJ|Tj|T\*|Td|TD|ET|'|"/g;
  let match: RegExpExecArray | null;
  let pending = '';
  while ((match = tokenPattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('(')) {
      pending = decodePdfString(token.slice(1, -1));
    } else if (token.startsWith('[')) {
      const strings = token.match(/\((?:\\.|[^\\)])*\)/g) ?? [];
      current += strings.map((entry) => decodePdfString(entry.slice(1, -1))).join('');
      pending = '';
    } else if (token === 'Tj' || token === "'" || token === '"') {
      if (token !== 'Tj') {
        lines.push(current);
        current = '';
      }
      current += pending;
      pending = '';
    } else if (token === 'T*' || token === 'Td' || token === 'TD' || token === 'ET') {
      if (current.trim()) lines.push(current);
      current = '';
    }
  }
  if (current.trim()) lines.push(current);
  return lines.join('\n');
}

export function pdfText(buffer: Buffer): string {
  const source = buffer.toString('latin1');
  const parts: string[] = [];
  const streamPattern = /<<([^]*?)>>\s*stream\r?\n/g;
  let match: RegExpExecArray | null;
  let total = 0;
  let streams = 0;
  while ((match = streamPattern.exec(source)) !== null && streams < 500) {
    streams += 1;
    const dictionary = match[1] ?? '';
    const start = match.index + match[0].length;
    const end = source.indexOf('endstream', start);
    if (end < 0) break;
    if (/\/Subtype\s*\/Image|\/Type\s*\/XObject/.test(dictionary)) continue;
    let data = buffer.subarray(start, end);
    if (/\/FlateDecode/.test(dictionary)) {
      try {
        data = zlib.inflateSync(data, { maxOutputLength: 4 * 1024 * 1024 });
      } catch {
        continue;
      }
    } else if (/\/Filter/.test(dictionary)) {
      continue;
    }
    const text = pdfOperatorsToText(data.toString('latin1'));
    if (text.trim()) {
      parts.push(text);
      total += text.length;
      if (total > MAX_EXTRACTED_CHARS) break;
    }
    streamPattern.lastIndex = end;
  }
  // latin1 decoding keeps bytes; re-decode as UTF-8 where it is valid.
  const joined = parts.join('\n');
  const asUtf8 = Buffer.from(joined, 'latin1').toString('utf8');
  return asUtf8.includes('�') ? joined : asUtf8;
}

export function extractText(kind: FileKind, extension: string, buffer: Buffer): string | null {
  if (kind === 'text') {
    const text = buffer.toString('utf8');
    if (extension === 'html' || extension === 'htm' || extension === 'xml')
      return clamp(xmlToText(text));
    return clamp(text);
  }
  if (kind === 'pdf') return clamp(pdfText(buffer));
  if (kind === 'office' && ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'].includes(extension)) {
    return clamp(officeText(buffer));
  }
  return null;
}
