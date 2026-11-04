import {
  All,
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Param,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { CalendarEvent } from '@ufos/contracts';
import { Public } from '../common/public.decorator';
import { CalendarService } from './calendar.service';
import { IcsService } from './ics.service';

function basicToken(request: Request): string {
  const header = request.headers.authorization;
  if (!header?.startsWith('Basic ')) throw new UnauthorizedException('caldav_basic_auth_required');
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const token = decoded.slice(decoded.indexOf(':') + 1);
  if (!token) throw new UnauthorizedException('caldav_token_required');
  return token;
}

function parseCalDavDate(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(value);
  if (!match) return fallback;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cdata(value: string): string {
  return `<![CDATA[${value.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function calendarProps(calendarId: string, name: string, ctag: string): string {
  return `<D:response>
  <D:href>/api/caldav/${xml(calendarId)}/</D:href>
  <D:propstat><D:prop>
    <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
    <D:displayname>${xml(name)}</D:displayname>
    <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
    <C:getctag>${xml(ctag)}</C:getctag>
    <D:current-user-principal><D:href>/api/caldav/principal/</D:href></D:current-user-principal>
  </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
</D:response>`;
}

function eventResponse(
  calendarId: string,
  event: CalendarEvent,
  ics: IcsService,
  includeData: boolean,
): string {
  const href = `/api/caldav/${calendarId}/${encodeURIComponent(event.uid)}.ics`;
  return `<D:response>
  <D:href>${xml(href)}</D:href>
  <D:propstat><D:prop>
    <D:getetag>${xml(`"${event.etag}"`)}</D:getetag>
    ${includeData ? `<C:calendar-data>${cdata(ics.generate([event]))}</C:calendar-data>` : ''}
  </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
</D:response>`;
}

function multistatus(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${body}</D:multistatus>`;
}

@Public()
@Controller('caldav')
export class CalDavController {
  constructor(
    private readonly calendar: CalendarService,
    private readonly ics: IcsService,
  ) {}

  @All(':calendarId')
  async collection(
    @Req() request: Request,
    @Res() response: Response,
    @Param('calendarId') calendarId: string,
    @Body() body: string,
  ) {
    return this.handle(request, response, calendarId, undefined, body);
  }

  @All(':calendarId/:uid')
  async item(
    @Req() request: Request,
    @Res() response: Response,
    @Param('calendarId') calendarId: string,
    @Param('uid') uid: string,
    @Body() body: string,
  ) {
    return this.handle(request, response, calendarId, uid, body);
  }

  private async handle(
    request: Request,
    response: Response,
    calendarId: string,
    uid: string | undefined,
    body: string | undefined,
  ): Promise<void> {
    const token = basicToken(request);
    const method = request.method.toUpperCase();
    response.setHeader('DAV', '1, 2, 3, calendar-access');
    response.setHeader('Allow', 'OPTIONS, PROPFIND, REPORT, GET, PUT, DELETE');
    response.setHeader('Cache-Control', 'no-store');
    if (method === 'OPTIONS') {
      response.status(HttpStatus.NO_CONTENT).send();
      return;
    }
    const context = await this.calendar.calDavContext(token, calendarId);
    if (method === 'PROPFIND') {
      response.type('application/xml; charset=utf-8');
      response
        .status(HttpStatus.MULTI_STATUS)
        .send(multistatus(calendarProps(calendarId, context.calendar.name, context.calendar.ctag)));
      return;
    }
    if (method === 'REPORT') {
      const xmlBody = typeof body === 'string' ? body : '';
      const range = /time-range[^>]*start="([^"]+)"[^>]*end="([^"]+)"/i.exec(xmlBody);
      const from = parseCalDavDate(range?.[1], new Date(Date.now() - 365 * 86_400_000));
      const to = parseCalDavDate(range?.[2], new Date(Date.now() + 365 * 86_400_000));
      const result = await this.calendar.calDavEvents(token, calendarId, from, to);
      const includeData = /calendar-data/i.test(xmlBody);
      response.type('application/xml; charset=utf-8');
      response
        .status(HttpStatus.MULTI_STATUS)
        .send(
          multistatus(
            calendarProps(calendarId, result.calendar.name, result.calendar.ctag) +
              result.events
                .map((event) => eventResponse(calendarId, event, this.ics, includeData))
                .join(''),
          ),
        );
      return;
    }
    if (method === 'GET' && uid) {
      const cleanUid = decodeURIComponent(uid).replace(/\.ics$/i, '');
      const result = await this.calendar.calDavEvents(
        token,
        calendarId,
        new Date('2000-01-01'),
        new Date('2100-01-01'),
      );
      const event = result.events.find((item) => item.uid === cleanUid);
      if (!event) throw new HttpException('event_not_found', HttpStatus.NOT_FOUND);
      response.type('text/calendar; charset=utf-8');
      response.setHeader('ETag', `"${event.etag}"`);
      response.send(this.ics.generate([event], result.calendar.name));
      return;
    }
    if (method === 'PUT' && uid) {
      const ifMatch = headerValue(request, 'if-match');
      const ifNoneMatch = headerValue(request, 'if-none-match');
      const text = typeof body === 'string' ? body : '';
      const cleanUid = decodeURIComponent(uid).replace(/\.ics$/i, '');
      const event = await this.calendar.calDavPut(
        token,
        calendarId,
        cleanUid,
        text,
        ifMatch,
        ifNoneMatch,
      );
      response.setHeader('ETag', `"${event.etag}"`);
      response.status(ifNoneMatch === '*' ? HttpStatus.CREATED : HttpStatus.NO_CONTENT).send();
      return;
    }
    if (method === 'DELETE' && uid) {
      const cleanUid = decodeURIComponent(uid).replace(/\.ics$/i, '');
      await this.calendar.calDavDelete(
        token,
        calendarId,
        cleanUid,
        headerValue(request, 'if-match'),
      );
      response.status(HttpStatus.NO_CONTENT).send();
      return;
    }
    throw new HttpException('caldav_method_not_supported', HttpStatus.METHOD_NOT_ALLOWED);
  }
}

function headerValue(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value.replace(/^"|"$/g, '') : undefined;
}
