import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AuthenticatedUser } from '../common/authed-request';
import { CurrentUser } from '../common/current-user.decorator';
import { querySpace, spaceFrom } from '../common/space-param';
import { sendContent } from '../files/content-response';
import { StorageService } from '../storage/storage.service';
import { journalPatchSchema, journalSchema } from './dto';
import { JournalService } from './journal.service';

@Controller('journal')
export class JournalController {
  constructor(
    private readonly journal: JournalService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('spaceId') spaceId?: string,
    @Query('scope') scope?: string,
    @Query('kind') kind?: string,
    @Query('year') year?: string,
    @Query('q') q?: string,
  ) {
    return this.journal.list(user, querySpace(spaceId), {
      scope: scope === 'mine' || scope === 'family' ? scope : 'all',
      kind: kind === 'diary' || kind === 'story' ? kind : undefined,
      year: year && /^\d{4}$/.test(year) ? Number(year) : undefined,
      q: q?.trim() ? q.trim().slice(0, 200) : undefined,
    });
  }

  @Get('export')
  exportMine(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.journal.exportMine(user, querySpace(spaceId));
  }

  @Delete('mine')
  deleteMine(
    @CurrentUser() user: AuthenticatedUser,
    @Query('spaceId') spaceId?: string,
    @Query('confirm') confirm?: string,
  ) {
    return this.journal.deleteMine(user, querySpace(spaceId), confirm ?? '');
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.journal.create(user, spaceFrom(body), journalSchema.parse(body));
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.journal.get(user, querySpace(spaceId), id);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.journal.update(user, spaceFrom(body), id, journalPatchSchema.parse(body));
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.journal.remove(user, querySpace(spaceId), id);
  }

  @Get(':id/attachments')
  attachments(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.journal.attachments(user, querySpace(spaceId), id);
  }

  @Get(':id/attachments/:fileId/content')
  async attachment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Req() request: Request,
    @Res() response: Response,
    @Query('spaceId') spaceId?: string,
  ) {
    const content = await this.journal.attachmentContent(user, querySpace(spaceId), id, fileId);
    sendContent(request, response, this.storage.adapter, {
      key: content.key,
      size: content.size,
      mime: content.mime,
      name: content.file.name,
      inline: content.inline,
    });
  }
}
