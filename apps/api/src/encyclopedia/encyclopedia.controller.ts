import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/authed-request';
import { CurrentUser } from '../common/current-user.decorator';
import { Public } from '../common/public.decorator';
import { querySpace, spaceFrom } from '../common/space-param';
import {
  linkSchema,
  personPatchSchema,
  personSchema,
  publicationSchema,
  relationSchema,
} from './dto';
import { EncyclopediaService } from './encyclopedia.service';

@Controller('encyclopedia')
export class EncyclopediaController {
  constructor(private readonly encyclopedia: EncyclopediaService) {}

  @Get('people')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('spaceId') spaceId?: string,
    @Query('q') q?: string,
  ) {
    return this.encyclopedia.list(
      user,
      querySpace(spaceId),
      q?.trim() ? q.trim().slice(0, 200) : undefined,
    );
  }

  @Get('tree')
  tree(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.encyclopedia.tree(user, querySpace(spaceId));
  }

  @Post('people')
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.encyclopedia.create(user, spaceFrom(body), personSchema.parse(body));
  }

  @Get('people/:id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.encyclopedia.get(user, querySpace(spaceId), id);
  }

  @Patch('people/:id')
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.encyclopedia.update(user, spaceFrom(body), id, personPatchSchema.parse(body));
  }

  @Delete('people/:id')
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.encyclopedia.remove(user, querySpace(spaceId), id);
  }

  @Post('people/:id/publication')
  publication(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.encyclopedia.setPublication(
      user,
      spaceFrom(body),
      id,
      publicationSchema.parse(body),
    );
  }

  @Post('people/:id/links')
  addLink(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.encyclopedia.addLink(user, spaceFrom(body), id, linkSchema.parse(body));
  }

  @Delete('people/:id/links/:kind/:targetId')
  removeLink(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Param('targetId') targetId: string,
    @Query('spaceId') spaceId?: string,
  ) {
    const parsed = linkSchema.parse({ targetKind: kind, targetId });
    return this.encyclopedia.removeLink(
      user,
      querySpace(spaceId),
      id,
      parsed.targetKind,
      parsed.targetId,
    );
  }

  @Post('relations')
  addRelation(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.encyclopedia.addRelation(user, spaceFrom(body), relationSchema.parse(body));
  }

  @Delete('relations/:id')
  removeRelation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.encyclopedia.removeRelation(user, querySpace(spaceId), id);
  }
}

/** Public site: only people explicitly published, with privacy-reduced fields. */
@Public()
@Controller('public/family-people')
export class PublicFamilyController {
  constructor(private readonly encyclopedia: EncyclopediaService) {}

  @Get()
  people() {
    return this.encyclopedia.publicPeople();
  }
}
