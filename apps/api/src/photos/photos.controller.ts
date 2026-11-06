import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/authed-request';
import { CurrentUser } from '../common/current-user.decorator';
import { querySpace, spaceFrom } from '../common/space-param';
import {
  albumItemsSchema,
  albumPatchSchema,
  albumSchema,
  commentSchema,
  faceSchema,
  favoriteSchema,
  mediaMetaSchema,
  peopleTagSchema,
  reactionSchema,
  shareSchema,
} from './dto';
import { PhotosService } from './photos.service';
import { FilesService } from '../files/files.service';

@Controller('photos')
export class PhotosController {
  constructor(
    private readonly photos: PhotosService,
    private readonly files: FilesService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('spaceId') spaceId?: string,
    @Query('albumId') albumId?: string,
    @Query('favorites') favorites?: string,
    @Query('personId') personId?: string,
    @Query('period') period?: string,
    @Query('q') q?: string,
  ) {
    return this.photos.list(user, querySpace(spaceId), {
      albumId: albumId || undefined,
      favorites: favorites === '1' || favorites === 'true',
      personId: personId || undefined,
      period: period || undefined,
      q: q?.trim() ? q.trim().slice(0, 200) : undefined,
    });
  }

  @Get('timeline')
  timeline(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.photos.timeline(user, querySpace(spaceId));
  }

  @Get('duplicates')
  duplicates(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.files.duplicates(user, querySpace(spaceId), 'photos');
  }

  @Get('albums')
  albums(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.photos.albums(user, querySpace(spaceId));
  }

  @Post('albums')
  createAlbum(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.photos.createAlbum(user, spaceFrom(body), albumSchema.parse(body));
  }

  @Patch('albums/:id')
  updateAlbum(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.photos.updateAlbum(user, spaceFrom(body), id, albumPatchSchema.parse(body));
  }

  @Delete('albums/:id')
  deleteAlbum(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.photos.deleteAlbum(user, querySpace(spaceId), id);
  }

  @Post('albums/:id/items')
  addItems(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.photos.addItems(user, spaceFrom(body), id, albumItemsSchema.parse(body).fileIds);
  }

  @Delete('albums/:id/items/:fileId')
  removeItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.photos.removeItem(user, querySpace(spaceId), id, fileId);
  }

  @Get('faces')
  faceStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Query('spaceId') spaceId?: string,
    @Query('userId') userId?: string,
  ) {
    return this.photos.faceStatus(user, querySpace(spaceId), userId || undefined);
  }

  @Post('faces')
  setFace(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.photos.setFace(user, spaceFrom(body), faceSchema.parse(body));
  }

  @Delete('faces/data')
  deleteFaceData(
    @CurrentUser() user: AuthenticatedUser,
    @Query('spaceId') spaceId?: string,
    @Query('userId') userId?: string,
  ) {
    return this.photos.deleteFaceData(user, querySpace(spaceId), userId || undefined);
  }

  @Get('shares')
  shares(
    @CurrentUser() user: AuthenticatedUser,
    @Query('spaceId') spaceId?: string,
    @Query('targetId') targetId?: string,
  ) {
    return this.photos.shares(user, querySpace(spaceId), targetId || undefined);
  }

  @Post('shares')
  createShare(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.photos.createShare(user, spaceFrom(body), shareSchema.parse(body));
  }

  @Delete('shares/:id')
  revokeShare(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.photos.revokeShare(user, querySpace(spaceId), id);
  }

  @Get(':fileId')
  item(
    @CurrentUser() user: AuthenticatedUser,
    @Param('fileId') fileId: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.photos.item(user, querySpace(spaceId), fileId);
  }

  @Patch(':fileId')
  updateMeta(
    @CurrentUser() user: AuthenticatedUser,
    @Param('fileId') fileId: string,
    @Body() body: unknown,
  ) {
    return this.photos.updateMeta(user, spaceFrom(body), fileId, mediaMetaSchema.parse(body));
  }

  @Get(':fileId/comments')
  comments(
    @CurrentUser() user: AuthenticatedUser,
    @Param('fileId') fileId: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.photos.comments(user, querySpace(spaceId), fileId);
  }

  @Post(':fileId/comments')
  addComment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('fileId') fileId: string,
    @Body() body: unknown,
  ) {
    return this.photos.addComment(user, spaceFrom(body), fileId, commentSchema.parse(body).body);
  }

  @Delete(':fileId/comments/:commentId')
  deleteComment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('fileId') fileId: string,
    @Param('commentId') commentId: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.photos.deleteComment(user, querySpace(spaceId), fileId, commentId);
  }

  @Post(':fileId/reactions')
  react(
    @CurrentUser() user: AuthenticatedUser,
    @Param('fileId') fileId: string,
    @Body() body: unknown,
  ) {
    const input = reactionSchema.parse(body);
    return this.photos.react(user, spaceFrom(body), fileId, input.emoji, input.on);
  }

  @Post(':fileId/favorite')
  favorite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('fileId') fileId: string,
    @Body() body: unknown,
  ) {
    return this.photos.favorite(user, spaceFrom(body), fileId, favoriteSchema.parse(body).on);
  }

  @Post(':fileId/people')
  tag(
    @CurrentUser() user: AuthenticatedUser,
    @Param('fileId') fileId: string,
    @Body() body: unknown,
  ) {
    return this.photos.tagPerson(user, spaceFrom(body), fileId, peopleTagSchema.parse(body));
  }

  @Delete(':fileId/people/:tagId')
  untag(
    @CurrentUser() user: AuthenticatedUser,
    @Param('fileId') fileId: string,
    @Param('tagId') tagId: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.photos.untagPerson(user, querySpace(spaceId), fileId, tagId);
  }
}
