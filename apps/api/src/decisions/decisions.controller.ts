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
  decisionHistoryQuerySchema,
  governanceSchema,
  pollCloseSchema,
  pollSchema,
  pollVoteSchema,
  proposalSchema,
  proposalTransitionSchema,
  proposalUpdateSchema,
  proposalVoteSchema,
  wishlistItemPatchSchema,
  wishlistItemSchema,
  wishlistSchema,
  wishlistUpdateSchema,
} from './dto';
import { DecisionsService } from './decisions.service';

function spaceFrom(body: unknown): string {
  const spaceId = (body as { spaceId?: string } | null)?.spaceId;
  if (!spaceId) throw new BadRequestException('spaceId_required');
  return spaceId;
}

function querySpace(spaceId?: string): string {
  if (!spaceId) throw new BadRequestException('spaceId_required');
  return spaceId;
}

@Controller('decisions')
export class DecisionsController {
  constructor(private readonly decisions: DecisionsService) {}

  @Get('governance')
  governance(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.decisions.governance(user, querySpace(spaceId));
  }

  @Patch('governance')
  updateGovernance(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.decisions.updateGovernance(user, spaceFrom(body), governanceSchema.parse(body));
  }

  @Get('polls')
  polls(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.decisions.polls(user, querySpace(spaceId));
  }

  @Post('polls')
  createPoll(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.decisions.createPoll(user, spaceFrom(body), pollSchema.parse(body));
  }

  @Get('polls/:id')
  poll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.decisions.poll(user, querySpace(spaceId), id);
  }

  @Post('polls/:id/votes')
  vote(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.decisions.vote(user, spaceFrom(body), id, pollVoteSchema.parse(body));
  }

  @Post('polls/:id/close')
  close(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    const input = pollCloseSchema.parse(body ?? {});
    return this.decisions.closePoll(user, spaceFrom(body), id, input.reason);
  }

  @Get('proposals')
  proposals(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.decisions.proposals(user, querySpace(spaceId));
  }

  @Post('proposals')
  createProposal(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.decisions.createProposal(user, spaceFrom(body), proposalSchema.parse(body));
  }

  @Get('proposals/:id')
  proposal(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.decisions.proposal(user, querySpace(spaceId), id);
  }

  @Patch('proposals/:id')
  updateProposal(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.decisions.updateProposal(user, spaceFrom(body), id, proposalUpdateSchema.parse(body));
  }

  @Post('proposals/:id/status')
  transition(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    const input = proposalTransitionSchema.parse(body);
    return this.decisions.transitionProposal(user, spaceFrom(body), id, input.status);
  }

  @Post('proposals/:id/votes')
  voteProposal(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    const input = proposalVoteSchema.parse(body);
    return this.decisions.voteProposal(user, spaceFrom(body), id, input.choice, input.comment);
  }

  @Post('proposals/:id/decide')
  decide(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.decisions.decideProposal(user, spaceFrom(body), id);
  }

  @Get('wishlists')
  wishlists(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.decisions.wishlists(user, querySpace(spaceId));
  }

  @Post('wishlists')
  createWishlist(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.decisions.createWishlist(user, spaceFrom(body), wishlistSchema.parse(body));
  }

  @Patch('wishlists/:id')
  updateWishlist(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.decisions.updateWishlist(user, spaceFrom(body), id, wishlistUpdateSchema.parse(body));
  }

  @Delete('wishlists/:id')
  deleteWishlist(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.decisions.deleteWishlist(user, querySpace(spaceId), id);
  }

  @Post('wishlists/:id/items')
  addItem(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.decisions.addWishlistItem(user, spaceFrom(body), id, wishlistItemSchema.parse(body));
  }

  @Patch('wishlists/:id/items/:itemId')
  updateItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: unknown,
  ) {
    return this.decisions.updateWishlistItem(
      user,
      spaceFrom(body),
      id,
      itemId,
      wishlistItemPatchSchema.parse(body),
    );
  }

  @Delete('wishlists/:id/items/:itemId')
  removeItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.decisions.removeWishlistItem(user, querySpace(spaceId), id, itemId);
  }

  @Get('history')
  history(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, string | undefined>) {
    return this.decisions.history(
      user,
      querySpace(query.spaceId),
      decisionHistoryQuerySchema.parse(query),
    );
  }
}
