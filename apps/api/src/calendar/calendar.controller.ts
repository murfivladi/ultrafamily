import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AuthenticatedUser } from '../common/authed-request';
import { CurrentUser } from '../common/current-user.decorator';
import { CalendarService } from './calendar.service';
import {
  calendarSchema,
  eventSchema,
  exceptionSchema,
  freeBusySchema,
  importSchema,
  linkSchema,
  rsvpSchema,
  suggestTimeSchema,
  tokenSchema,
  updateEventSchema,
} from './dto';

function spaceFrom(body: unknown): string {
  const spaceId = (body as { spaceId?: string } | null)?.spaceId;
  if (!spaceId) throw new BadRequestException('spaceId_required');
  return spaceId;
}

function querySpace(spaceId?: string): string {
  if (!spaceId) throw new BadRequestException('spaceId_required');
  return spaceId;
}

@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get('calendars')
  calendars(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.calendar.calendars(user, querySpace(spaceId));
  }

  @Post('calendars')
  createCalendar(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.calendar.createCalendar(user, spaceFrom(body), calendarSchema.parse(body));
  }

  @Get('events')
  events(
    @CurrentUser() user: AuthenticatedUser,
    @Query('spaceId') spaceId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('view') view?: string,
    @Query('calendarId') calendarId?: string,
  ) {
    return this.calendar.events(user, querySpace(spaceId), { from, to, view, calendarId });
  }

  @Post('events')
  createEvent(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.calendar.createEvent(user, spaceFrom(body), eventSchema.parse(body));
  }

  @Get('events/:id')
  event(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.calendar.event(user, querySpace(spaceId), id);
  }

  @Patch('events/:id')
  updateEvent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.calendar.updateEvent(user, spaceFrom(body), id, updateEventSchema.parse(body));
  }

  @Delete('events/:id')
  deleteEvent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.calendar.deleteEvent(user, querySpace(spaceId), id);
  }

  @Post('events/:id/rsvp')
  rsvp(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    const input = rsvpSchema.parse(body);
    return this.calendar.rsvp(user, spaceFrom(body), id, input.rsvp);
  }

  @Post('events/:id/links')
  addLink(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.calendar.addLink(user, spaceFrom(body), id, linkSchema.parse(body));
  }

  @Post('events/:id/exceptions')
  addException(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.calendar.addException(user, spaceFrom(body), id, exceptionSchema.parse(body));
  }

  @Post('free-busy')
  freeBusy(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.calendar.freeBusy(user, spaceFrom(body), freeBusySchema.parse(body));
  }

  @Post('suggest-time')
  suggestTime(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.calendar.suggestTime(user, spaceFrom(body), suggestTimeSchema.parse(body));
  }

  @Get('overload')
  overload(
    @CurrentUser() user: AuthenticatedUser,
    @Query('spaceId') spaceId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.calendar.overload(user, querySpace(spaceId), from, to);
  }

  @Get('export.ics')
  async exportIcs(
    @CurrentUser() user: AuthenticatedUser,
    @Res() response: Response,
    @Query('spaceId') spaceId?: string,
    @Query('calendarId') calendarId?: string,
  ) {
    const ics = await this.calendar.exportIcs(user, querySpace(spaceId), calendarId);
    response.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename="ultra-family-os.ics"');
    response.setHeader('Cache-Control', 'no-store');
    response.send(ics);
  }

  @Post('import')
  importIcs(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = importSchema.parse(body);
    return this.calendar.importIcs(user, spaceFrom(body), input.ics, input.calendarId);
  }

  @Get('tokens')
  tokens(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.calendar.listTokens(user, querySpace(spaceId));
  }

  @Post('tokens')
  createToken(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.calendar.createToken(user, spaceFrom(body), tokenSchema.parse(body));
  }

  @Delete('tokens/:id')
  revokeToken(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.calendar.revokeToken(user, querySpace(spaceId), id);
  }
}
