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
} from '@nestjs/common';
import type { AuthenticatedUser } from '../common/authed-request';
import { CurrentUser } from '../common/current-user.decorator';
import {
  collaboratorSchema,
  commentSchema,
  cursorSchema,
  documentContentSchema,
  documentPatchSchema,
  documentSchema,
  restoreSchema,
} from './dto';
import { DocumentsService } from './documents.service';
import { z } from 'zod';

function spaceFrom(body: unknown): string {
  const spaceId = (body as { spaceId?: string } | null)?.spaceId;
  if (!spaceId) throw new BadRequestException('spaceId_required');
  return spaceId;
}

function querySpace(spaceId?: string): string {
  if (!spaceId) throw new BadRequestException('spaceId_required');
  return spaceId;
}

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.documents.list(user, querySpace(spaceId));
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.documents.create(user, spaceFrom(body), documentSchema.parse(body));
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.documents.get(user, querySpace(spaceId), id);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.documents.update(user, spaceFrom(body), id, documentPatchSchema.parse(body));
  }

  @Post(':id/content')
  saveContent(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.documents.saveContent(user, spaceFrom(body), id, documentContentSchema.parse(body));
  }

  @Get(':id/versions')
  versions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.documents.versions(user, querySpace(spaceId), id);
  }

  @Post(':id/restore')
  restore(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    const input = restoreSchema.parse(body);
    return this.documents.restore(user, spaceFrom(body), id, input.version);
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.documents.remove(user, querySpace(spaceId), id);
  }

  @Get(':id/collaborators')
  collaborators(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.documents.collaborators(user, querySpace(spaceId), id);
  }

  @Post(':id/collaborators')
  setCollaborators(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = z.object({ collaborators: z.array(collaboratorSchema).max(50) }).parse(body);
    return this.documents.setCollaborators(
      user,
      spaceFrom(body),
      id,
      input.collaborators as Array<{ userId: string; permission: 'read' | 'comment' | 'edit' }>,
    );
  }

  @Get(':id/comments')
  comments(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.documents.comments(user, querySpace(spaceId), id);
  }

  @Post(':id/comments')
  addComment(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.documents.addComment(user, spaceFrom(body), id, commentSchema.parse(body));
  }

  @Post(':id/comments/:commentId/resolve')
  resolve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Body() body: unknown,
  ) {
    const resolved = (body as { resolved?: boolean } | null)?.resolved ?? true;
    return this.documents.resolveComment(user, spaceFrom(body), id, commentId, resolved);
  }

  @Post(':id/presence')
  presence(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    const input = cursorSchema.parse(body);
    return this.documents
      .checkReadAccess(user, spaceFrom(body), id)
      .then(async () => {
        await this.documents.recordPresence(id, user.id, { anchor: input.anchor, head: input.head }, input.editing);
        return { ok: true, transport: 'http-fallback' };
      });
  }
}
