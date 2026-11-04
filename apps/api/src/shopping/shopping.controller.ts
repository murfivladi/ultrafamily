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
  acceptSuggestionSchema,
  claimSchema,
  generateSchema,
  itemSchema,
  listSchema,
  mergeSchema,
  updateItemSchema,
} from './dto';
import { ShoppingService } from './shopping.service';

function spaceFrom(body: unknown): string {
  const spaceId = (body as { spaceId?: string } | null)?.spaceId;
  if (!spaceId) throw new BadRequestException('spaceId_required');
  return spaceId;
}

function querySpace(spaceId?: string): string {
  if (!spaceId) throw new BadRequestException('spaceId_required');
  return spaceId;
}

@Controller('shopping')
export class ShoppingController {
  constructor(private readonly shopping: ShoppingService) {}

  @Get('lists')
  lists(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.shopping.lists(user, querySpace(spaceId));
  }

  @Post('lists')
  createList(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.shopping.createList(user, spaceFrom(body), listSchema.parse(body));
  }

  @Post('lists/:id/archive')
  archiveList(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.shopping.archiveList(user, spaceFrom(body), id);
  }

  @Get('history')
  history(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.shopping.history(user, querySpace(spaceId));
  }

  @Get('suggestions')
  suggestions(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.shopping.suggestions(user, querySpace(spaceId));
  }

  @Post('suggestions/:id/accept')
  acceptSuggestion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = acceptSuggestionSchema.parse(body);
    return this.shopping.acceptSuggestion(user, spaceFrom(body), id, input.listId);
  }

  @Post('items')
  createItem(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.shopping.createItem(user, spaceFrom(body), itemSchema.parse(body));
  }

  @Patch('items/:id')
  updateItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.shopping.updateItem(user, spaceFrom(body), id, updateItemSchema.parse(body));
  }

  @Delete('items/:id')
  deleteItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
    @Query('listId') listId?: string,
  ) {
    if (!listId) throw new BadRequestException('listId_required');
    return this.shopping.deleteItem(user, querySpace(spaceId), id, listId);
  }

  @Post('items/:id/claim')
  claimItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.shopping.claimItem(user, spaceFrom(body), id, claimSchema.parse(body));
  }

  @Post('merge')
  merge(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.shopping.merge(user, spaceFrom(body), mergeSchema.parse(body));
  }

  @Post('generate')
  generate(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.shopping.generateFromSources(user, spaceFrom(body), generateSchema.parse(body));
  }

  @Post('presence/join')
  join(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { spaceId?: string; listId?: string },
  ) {
    if (!body.listId) throw new BadRequestException('listId_required');
    return this.shopping.joinPresence(user, spaceFrom(body), body.listId);
  }

  @Post('presence/leave')
  leave(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { spaceId?: string; listId?: string },
  ) {
    if (!body.listId) throw new BadRequestException('listId_required');
    return this.shopping.leavePresence(user, spaceFrom(body), body.listId);
  }
}
