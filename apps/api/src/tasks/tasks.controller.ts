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
  applyTemplateSchema,
  attachmentSchema,
  autoAssignSchema,
  commentSchema,
  dependencySchema,
  linkSchema,
  listSchema,
  prioritizeSchema,
  splitSchema,
  taskSchema,
  templateSchema,
  updateTaskSchema,
} from './dto';
import { TasksService } from './tasks.service';

function spaceFrom(body: unknown): string {
  const spaceId = (body as { spaceId?: string } | null)?.spaceId;
  if (!spaceId) throw new BadRequestException('spaceId_required');
  return spaceId;
}

function querySpace(spaceId?: string): string {
  if (!spaceId) throw new BadRequestException('spaceId_required');
  return spaceId;
}

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get('board')
  board(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.tasks.board(user, querySpace(spaceId));
  }

  @Get('templates')
  templates(@CurrentUser() user: AuthenticatedUser, @Query('spaceId') spaceId?: string) {
    return this.tasks.templates(user, querySpace(spaceId));
  }

  @Post('templates')
  createTemplate(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.tasks.createTemplate(user, spaceFrom(body), templateSchema.parse(body));
  }

  @Post('templates/apply')
  applyTemplate(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.tasks.applyTemplate(user, spaceFrom(body), applyTemplateSchema.parse(body));
  }

  @Post('lists')
  createList(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.tasks.createList(user, spaceFrom(body), listSchema.parse(body));
  }

  @Post('auto-assign')
  autoAssign(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.tasks.autoAssign(user, spaceFrom(body), autoAssignSchema.parse(body));
  }

  @Post()
  createTask(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.tasks.createTask(user, spaceFrom(body), taskSchema.parse(body));
  }

  @Patch(':id')
  updateTask(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.tasks.updateTask(user, spaceFrom(body), id, updateTaskSchema.parse(body));
  }

  @Delete(':id')
  deleteTask(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.tasks.deleteTask(user, querySpace(spaceId), id);
  }

  @Post(':id/comments')
  comment(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.tasks.comment(user, spaceFrom(body), id, commentSchema.parse(body));
  }

  @Post(':id/attachments')
  attach(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.tasks.attach(user, spaceFrom(body), id, attachmentSchema.parse(body));
  }

  @Post(':id/dependencies')
  dependency(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.tasks.addDependency(user, spaceFrom(body), id, dependencySchema.parse(body));
  }

  @Post(':id/links')
  link(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.tasks.addLink(user, spaceFrom(body), id, linkSchema.parse(body));
  }

  @Post(':id/claim')
  claim(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.tasks.claim(user, spaceFrom(body), id);
  }

  @Post(':id/prioritize')
  prioritize(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.tasks.prioritize(user, spaceFrom(body), id, prioritizeSchema.parse(body ?? {}));
  }

  @Post(':id/split')
  split(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.tasks.split(user, spaceFrom(body), id, splitSchema.parse(body ?? {}));
  }
}
