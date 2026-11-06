import { Body, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Public } from '../common/public.decorator';
import { sendContent } from '../files/content-response';
import { StorageService } from '../storage/storage.service';
import { PhotosService } from './photos.service';

/** Unauthenticated access to protected, expiring, revocable share links. */
@Public()
@Controller('public/shares')
export class PublicSharesController {
  constructor(
    private readonly photos: PhotosService,
    private readonly storage: StorageService,
  ) {}

  @Get(':token')
  view(@Param('token') token: string, @Query('grant') grant?: string) {
    return this.photos.publicView(token, grant);
  }

  @Post(':token/unlock')
  unlock(@Param('token') token: string, @Body() body: unknown) {
    const input = z.object({ password: z.string().min(1).max(200) }).parse(body);
    return this.photos.unlock(token, input.password);
  }

  @Get(':token/items/:fileId')
  async item(
    @Param('token') token: string,
    @Param('fileId') fileId: string,
    @Req() request: Request,
    @Res() response: Response,
    @Query('grant') grant?: string,
    @Query('download') download?: string,
  ) {
    const content = await this.photos.publicItem(token, fileId, grant);
    sendContent(request, response, this.storage.adapter, {
      key: content.key,
      size: content.size,
      mime: content.mime,
      name: content.file.name,
      inline: content.inline && !(download === '1' && content.allowDownload),
    });
  }
}
