import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AuthenticatedUser } from '../common/authed-request';
import { CurrentUser } from '../common/current-user.decorator';
import { querySpace, spaceFrom } from '../common/space-param';
import { StorageService } from '../storage/storage.service';
import { sendContent } from './content-response';
import {
  bulkSchema,
  completeSchema,
  filePatchSchema,
  folderPatchSchema,
  folderSchema,
  quotaSchema,
  restoreSchema,
  uploadSchema,
  versionRestoreSchema,
  webdavTokenSchema,
} from './dto';
import { FilesService } from './files.service';
import { MediaQueueService } from './media-queue.service';

@Controller('files')
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly queue: MediaQueueService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('spaceId') spaceId?: string,
    @Query('folderId') folderId?: string,
  ) {
    return this.files.list(user, querySpace(spaceId), folderId || null);
  }

  @Get('usage')
  usage(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.files.usage(user, querySpace(spaceId));
  }

  @Put('quota')
  quota(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.files.setQuota(user, spaceFrom(body), quotaSchema.parse(body));
  }

  @Get('trash')
  trash(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.files.trash(user, querySpace(spaceId));
  }

  @Post('trash/restore')
  restore(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.files.restore(user, spaceFrom(body), restoreSchema.parse(body));
  }

  @Delete('trash')
  emptyTrash(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.files.emptyTrash(user, querySpace(spaceId));
  }

  @Get('activity')
  activity(
    @CurrentUser() user: AuthenticatedUser,
    @Query('spaceId') spaceId?: string,
    @Query('fileId') fileId?: string,
  ) {
    return this.files.history(user, querySpace(spaceId), fileId || undefined);
  }

  @Get('duplicates')
  duplicates(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.files.duplicates(user, querySpace(spaceId));
  }

  @Post('bulk')
  bulk(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.files.bulk(user, spaceFrom(body), bulkSchema.parse(body));
  }

  // Folders ------------------------------------------------------------------

  @Post('folders')
  createFolder(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.files.createFolder(user, spaceFrom(body), folderSchema.parse(body));
  }

  @Patch('folders/:id')
  updateFolder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.files.updateFolder(user, spaceFrom(body), id, folderPatchSchema.parse(body));
  }

  @Delete('folders/:id')
  trashFolder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.files.trashFolder(user, querySpace(spaceId), id);
  }

  // Uploads ------------------------------------------------------------------

  @Post('uploads')
  createUpload(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.files.createUpload(user, spaceFrom(body), uploadSchema.parse(body));
  }

  @Get('uploads/:id')
  uploadStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.files.uploadStatus(user, querySpace(spaceId), id);
  }

  @Put('uploads/:id/chunks/:index')
  putChunk(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('index', ParseIntPipe) index: number,
    @Req() request: Request,
    @Query('spaceId') spaceId?: string,
  ) {
    const body = request.body as unknown;
    if (!Buffer.isBuffer(body)) throw new BadRequestException('chunk_must_be_octet_stream');
    return this.files.putChunk(user, querySpace(spaceId), id, index, body);
  }

  @Post('uploads/:id/complete')
  complete(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.files.completeUpload(user, spaceFrom(body), id, completeSchema.parse(body));
  }

  @Delete('uploads/:id')
  abort(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.files.abortUpload(user, querySpace(spaceId), id);
  }

  // Processing queue -----------------------------------------------------------

  @Get('processing')
  async processing(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    const space = querySpace(spaceId);
    await this.files.usage(user, space);
    return { engines: await this.queue.status(space), jobs: await this.queue.jobs(space) };
  }

  @Post('processing/run')
  async runQueue(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const spaceId = spaceFrom(body);
    // Draining the queue on demand is limited to people who already can upload.
    const canFiles = await this.files.can(user.id, spaceId, 'files', 'create');
    const canPhotos = await this.files.can(user.id, spaceId, 'photos', 'create');
    if (!canFiles && !canPhotos) throw new ForbiddenException('access_denied:role_not_permitted');
    const handled = await this.queue.runOnce(50, spaceId);
    return { handled, status: await this.queue.status(spaceId) };
  }

  // WebDAV tokens --------------------------------------------------------------

  @Get('webdav/tokens')
  tokens(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.files.webdavTokens(user, querySpace(spaceId));
  }

  @Post('webdav/tokens')
  createToken(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.files.createWebdavToken(user, spaceFrom(body), webdavTokenSchema.parse(body));
  }

  @Delete('webdav/tokens/:id')
  revokeToken(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.files.revokeWebdavToken(user, querySpace(spaceId), id);
  }

  // Single file --------------------------------------------------------------

  @Get(':id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.files.get(user, querySpace(spaceId), id);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.files.update(user, spaceFrom(body), id, filePatchSchema.parse(body));
  }

  @Delete(':id')
  trashFile(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.files.trashFile(user, querySpace(spaceId), id);
  }

  @Delete(':id/purge')
  purge(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.files.purge(user, querySpace(spaceId), id);
  }

  @Get(':id/versions')
  versions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.files.versions(user, querySpace(spaceId), id);
  }

  @Post(':id/versions/restore')
  restoreVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.files.restoreVersion(
      user,
      spaceFrom(body),
      id,
      versionRestoreSchema.parse(body).version,
    );
  }

  @Get(':id/preview')
  preview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.files.preview(user, querySpace(spaceId), id);
  }

  @Get(':id/archive')
  archive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.files.archive(user, querySpace(spaceId), id);
  }

  @Get(':id/content')
  async content(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Req() request: Request,
    @Res() response: Response,
    @Query('spaceId') spaceId?: string,
    @Query('version') version?: string,
    @Query('download') download?: string,
  ) {
    const target = await this.files.content(
      user,
      querySpace(spaceId),
      id,
      version ? Number(version) : undefined,
    );
    sendContent(request, response, this.storage.adapter, {
      key: target.key,
      size: target.size,
      mime: target.mime,
      name: target.file.name,
      sha256: target.file.sha256,
      inline: target.inline && download !== '1',
    });
  }
}
