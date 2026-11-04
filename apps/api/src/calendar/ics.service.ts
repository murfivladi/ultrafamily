import { Injectable } from '@nestjs/common';
import type { CalendarEvent } from '@ufos/contracts';
import { RRule, rrulestr } from 'rrule';
import { newId } from '../config';

export interface IcsEventInput {
  uid: string;
  title: string;
  description: string;
  location: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  timezone: string;
  category: string;
  recurrenceRule: string | null;
  status: 'confirmed' | 'tentative' | 'cancelled';
  participants: Array<{ userId: string; rsvp: string }>;
  exceptions: Array<{ occurrenceStart: string; action: string }>;
}

export interface IcsDocument {
  events: IcsEventInput[];
}

function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function icsDate(value: string, allDay: boolean): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return allDay ? '19700101' : '19700101T000000Z';
  const pad = (part: number) => String(part).padStart(2, '0');
  const datePart = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
  if (allDay) return datePart;
  return `${datePart}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function parseIcsDate(value: string, allDay: boolean): string {
  const raw = value.trim();
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(raw);
  if (!match) return new Date(0).toISOString();
  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
  const suffix = allDay || !raw.includes('T') || raw.endsWith('Z') ? 'Z' : '';
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${suffix || 'Z'}`);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function foldLine(line: string): string {
  if (line.length <= 74) return line;
  const chunks: string[] = [];
  let rest = line;
  while (rest.length > 73) {
    chunks.push(rest.slice(0, 73));
    rest = ` ${rest.slice(73)}`;
  }
  chunks.push(rest);
  return chunks.join('\r\n');
}

function parseProperty(line: string): {
  key: string;
  params: Record<string, string>;
  value: string;
} {
  const separator = line.indexOf(':');
  if (separator < 0) return { key: '', params: {}, value: '' };
  const left = line.slice(0, separator);
  const value = line.slice(separator + 1);
  const [key, ...params] = left.split(';');
  const parsed: Record<string, string> = {};
  for (const param of params) {
    const index = param.indexOf('=');
    if (index > 0) parsed[param.slice(0, index).toUpperCase()] = param.slice(index + 1);
  }
  return { key: (key ?? '').toUpperCase(), params: parsed, value };
}

function textProperty(block: string[], key: string): string {
  const line = block.find((entry) => parseProperty(entry).key === key);
  return line ? unescapeText(parseProperty(line).value) : '';
}

function property(block: string[], key: string) {
  const line = block.find((entry) => parseProperty(entry).key === key);
  return line ? parseProperty(line) : null;
}

@Injectable()
export class IcsService {
  generate(events: CalendarEvent[], calendarName = 'Ultra Family OS'): string {
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Ultra Family OS//Stage B//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${escapeText(calendarName)}`,
    ];
    for (const event of events) {
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${event.uid}`);
      lines.push(`DTSTAMP:${icsDate(event.updatedAt, false)}`);
      lines.push(
        event.allDay
          ? `DTSTART;VALUE=DATE:${icsDate(event.startsAt, true)}`
          : `DTSTART:${icsDate(event.startsAt, false)}`,
      );
      lines.push(
        event.allDay
          ? `DTEND;VALUE=DATE:${icsDate(event.endsAt, true)}`
          : `DTEND:${icsDate(event.endsAt, false)}`,
      );
      lines.push(`SUMMARY:${escapeText(event.title)}`);
      lines.push(`DESCRIPTION:${escapeText(event.description)}`);
      lines.push(`LOCATION:${escapeText(event.location)}`);
      lines.push(`CATEGORIES:${escapeText(event.category)}`);
      lines.push(`STATUS:${event.status.toUpperCase()}`);
      lines.push(`X-UFOS-ETAG:${event.etag}`);
      lines.push(`X-UFOS-TIMEZONE:${event.timezone}`);
      if (event.recurrenceRule) lines.push(`RRULE:${event.recurrenceRule}`);
      for (const participant of event.participants) {
        lines.push(
          `ATTENDEE;PARTSTAT=${participant.rsvp.toUpperCase()};CN=${escapeText(participant.userId)}:urn:uuid:user:${participant.userId}`,
        );
      }
      for (const link of event.links) {
        lines.push(`X-UFOS-LINK:${escapeText(`${link.module}:${link.targetId}`)}`);
      }
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return `${lines.map(foldLine).join('\r\n')}\r\n`;
  }

  parse(text: string): IcsDocument {
    const unfolded = text.replace(/\r?\n[ \t]/g, '');
    const lines = unfolded.split(/\r?\n/);
    const events: IcsEventInput[] = [];
    let block: string[] | null = null;
    for (const line of lines) {
      if (line.trim().toUpperCase() === 'BEGIN:VEVENT') {
        block = [];
        continue;
      }
      if (line.trim().toUpperCase() === 'END:VEVENT') {
        if (block) events.push(this.parseEvent(block));
        block = null;
        continue;
      }
      if (block && line.trim()) block.push(line);
    }
    return { events };
  }

  private parseEvent(block: string[]): IcsEventInput {
    const start = property(block, 'DTSTART');
    const end = property(block, 'DTEND');
    const allDay = start?.params.VALUE === 'DATE' || !start?.value.includes('T');
    const startsAt = parseIcsDate(start?.value ?? '', allDay);
    const durationMs = end
      ? new Date(parseIcsDate(end.value, allDay)).getTime() - new Date(startsAt).getTime()
      : 60 * 60 * 1000;
    const status = (textProperty(block, 'STATUS').toLowerCase() ||
      'confirmed') as IcsEventInput['status'];
    const exceptions: IcsEventInput['exceptions'] = [];
    for (const line of block) {
      const parsed = parseProperty(line);
      if (parsed.key === 'EXDATE') {
        exceptions.push({
          occurrenceStart: parseIcsDate(parsed.value.split(',')[0] ?? '', allDay),
          action: 'cancelled',
        });
      } else if (parsed.key === 'RECURRENCE-ID') {
        exceptions.push({
          occurrenceStart: parseIcsDate(parsed.value, allDay),
          action: 'modified',
        });
      }
    }
    return {
      uid: textProperty(block, 'UID') || newId('ics'),
      title: textProperty(block, 'SUMMARY') || 'Imported event',
      description: textProperty(block, 'DESCRIPTION'),
      location: textProperty(block, 'LOCATION'),
      startsAt,
      endsAt: new Date(new Date(startsAt).getTime() + Math.max(durationMs, 0)).toISOString(),
      allDay,
      timezone: textProperty(block, 'X-UFOS-TIMEZONE') || start?.params.TZID || 'Europe/Rome',
      category: textProperty(block, 'CATEGORIES') || 'imported',
      recurrenceRule: textProperty(block, 'RRULE') || null,
      status: ['confirmed', 'tentative', 'cancelled'].includes(status) ? status : 'confirmed',
      participants: [],
      exceptions,
    };
  }

  occurrences(rule: string, startsAt: string, from: Date, to: Date, limit = 200): Date[] {
    try {
      const parsed = rrulestr(rule, { dtstart: new Date(startsAt) });
      return parsed.between(from, to, true).slice(0, limit);
    } catch {
      try {
        const options = RRule.parseString(rule);
        return new RRule({ ...options, dtstart: new Date(startsAt) })
          .between(from, to, true)
          .slice(0, limit);
      } catch {
        return [];
      }
    }
  }

  nextOccurrence(rule: string, after: Date): Date | null {
    try {
      const parsed = rrulestr(rule, { dtstart: after });
      return parsed.after(after, true) ?? null;
    } catch {
      return null;
    }
  }
}
