import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TaskBoard, TaskItem, TaskPriority, TaskStatus } from '@ufos/contracts';
import type { z } from 'zod';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { newId } from '../config';
import type { AuthenticatedUser } from '../common/authed-request';
import { DatabaseService } from '../db/database.service';
import { iso, parseJson } from '../db/rows';
import { IcsService } from '../calendar/ics.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import { toTaskItem, type TaskRow } from '../stage-b/mappers';
import type {
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

type ListInput = z.infer<typeof listSchema>;
type TaskInput = z.infer<typeof taskSchema>;
type TaskPatch = z.infer<typeof updateTaskSchema>;
type CommentInput = z.infer<typeof commentSchema>;
type AttachmentInput = z.infer<typeof attachmentSchema>;
type DependencyInput = z.infer<typeof dependencySchema>;
type LinkInput = z.infer<typeof linkSchema>;
type AutoAssignInput = z.infer<typeof autoAssignSchema>;
type PrioritizeInput = z.infer<typeof prioritizeSchema>;
type SplitInput = z.infer<typeof splitSchema>;
type TemplateInput = z.infer<typeof templateSchema>;
type ApplyTemplateInput = z.infer<typeof applyTemplateSchema>;

const TASK_SELECT = `
  SELECT t.*,
    (SELECT COUNT(*)::int FROM tasks s WHERE s.parent_task_id = t.id) AS subtask_count,
    (SELECT COUNT(*)::int FROM task_dependencies d WHERE d.task_id = t.id) AS dependency_count
  FROM tasks t
`;

@Injectable()
export class TasksService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
    private readonly ics: IcsService,
  ) {}

  async board(user: AuthenticatedUser, spaceId: string): Promise<TaskBoard> {
    await this.access.assert(user.id, spaceId, 'tasks', 'read');
    const lists = await this.db.query<{ id: string; name: string; color: string; kind: string }>(
      'SELECT id, name, color, kind FROM task_lists WHERE space_id = $1 ORDER BY created_at ASC',
      [spaceId],
    );
    const tasks = await this.db.query<TaskRow>(
      `${TASK_SELECT} WHERE t.space_id = $1 ORDER BY t.position ASC, t.created_at ASC LIMIT 500`,
      [spaceId],
    );
    const workload = await this.db.query<{
      user_id: string;
      open_tasks: number | string;
      minutes: number | string;
    }>(
      `SELECT assignee_user_id AS user_id, COUNT(*)::int AS open_tasks,
              COALESCE(SUM(estimate_minutes), 0)::int AS minutes
       FROM tasks WHERE space_id = $1 AND status NOT IN ('done','cancelled')
         AND assignee_user_id IS NOT NULL
       GROUP BY assignee_user_id`,
      [spaceId],
    );
    return {
      lists,
      tasks: tasks.map(toTaskItem),
      workload: workload.map((row) => ({
        userId: row.user_id,
        openTasks: Number(row.open_tasks ?? 0),
        minutes: Number(row.minutes ?? 0),
      })),
    };
  }

  async createList(user: AuthenticatedUser, spaceId: string, input: ListInput) {
    await this.access.assert(user.id, spaceId, 'tasks', 'create');
    const row = await this.db.queryOne<{ id: string; name: string; color: string; kind: string }>(
      `INSERT INTO task_lists (id, space_id, name, kind, color, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, color, kind`,
      [newId('lst'), spaceId, input.name, input.kind, input.color, user.id],
    );
    if (!row) throw new NotFoundException('task_list_not_created');
    await this.record(user, spaceId, 'tasks.list.create', 'task_list', row.id, {
      name: input.name,
    });
    this.realtime.publish(spaceId, 'tasks', user.id, { action: 'list.create', id: row.id });
    return row;
  }

  async createTask(user: AuthenticatedUser, spaceId: string, input: TaskInput): Promise<TaskItem> {
    await this.access.assert(user.id, spaceId, 'tasks', 'create');
    const list = await this.resolveList(spaceId, input.listId, user.id);
    const assignee = await this.resolveAssignee(spaceId, input.assigneeUserId);
    const row = await this.db.queryOne<{ id: string }>(
      `INSERT INTO tasks
         (id, list_id, space_id, parent_task_id, title, description, status, priority,
          category, assignee_user_id, due_at, estimate_minutes, complexity,
          recurrence_rule, position, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id`,
      [
        newId('tsk'),
        list.id,
        spaceId,
        input.parentTaskId ?? null,
        input.title,
        input.description,
        input.status,
        input.priority,
        input.category,
        assignee,
        input.dueAt ?? null,
        input.estimateMinutes,
        input.complexity,
        input.recurrenceRule,
        await this.nextPosition(spaceId, list.id),
        user.id,
      ],
    );
    if (!row) throw new NotFoundException('task_not_created');
    await this.replaceLinks(row.id, input.links);
    await this.history(user.id, row.id, 'create', {}, { title: input.title, status: input.status });
    await this.record(user, spaceId, 'tasks.create', 'task', row.id, { title: input.title });
    this.realtime.publish(spaceId, 'tasks', user.id, { action: 'task.create', id: row.id });
    await this.notifyAssignee(spaceId, row.id, assignee, input.title, input.dueAt);
    return this.getTaskRow(spaceId, row.id);
  }

  async updateTask(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    patch: TaskPatch,
  ): Promise<TaskItem> {
    await this.access.assert(user.id, spaceId, 'tasks', 'update');
    const existing = await this.db.queryOne<TaskRow>(
      `${TASK_SELECT} WHERE t.id = $1 AND t.space_id = $2`,
      [id, spaceId],
    );
    if (!existing) throw new NotFoundException('task_not_found');
    if (Number(existing.version ?? 1) !== patch.expectedVersion) {
      throw new ConflictException('task_version_conflict');
    }
    const current = toTaskItem(existing);
    const links = await this.taskLinks(id);
    const merged: TaskInput = {
      listId: patch.listId ?? current.listId,
      parentTaskId: patch.parentTaskId === undefined ? current.parentTaskId : patch.parentTaskId,
      title: patch.title ?? current.title,
      description: patch.description ?? current.description,
      status: patch.status ?? current.status,
      priority: patch.priority ?? current.priority,
      category: patch.category ?? current.category,
      assigneeUserId:
        patch.assigneeUserId === undefined ? current.assigneeUserId : patch.assigneeUserId,
      dueAt: patch.dueAt === undefined ? current.dueAt : patch.dueAt,
      estimateMinutes: patch.estimateMinutes ?? current.estimateMinutes,
      complexity: patch.complexity ?? current.complexity,
      recurrenceRule:
        patch.recurrenceRule === undefined ? current.recurrenceRule : patch.recurrenceRule,
      links: patch.links ?? links,
    };
    const assignee = await this.resolveAssignee(spaceId, merged.assigneeUserId);
    const list = await this.resolveList(spaceId, merged.listId, user.id);
    await this.db.query(
      `UPDATE tasks SET list_id = $2, parent_task_id = $3, title = $4, description = $5,
         status = $6, priority = $7, category = $8, assignee_user_id = $9,
         due_at = $10, estimate_minutes = $11, complexity = $12, recurrence_rule = $13,
         completed_at = CASE WHEN $6 = 'done' THEN COALESCE(completed_at, CURRENT_TIMESTAMP) ELSE NULL END,
         version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [
        id,
        list.id,
        merged.parentTaskId,
        merged.title,
        merged.description,
        merged.status,
        merged.priority,
        merged.category,
        assignee,
        merged.dueAt,
        merged.estimateMinutes,
        merged.complexity,
        merged.recurrenceRule,
      ],
    );
    await this.replaceLinks(id, merged.links);
    await this.history(
      user.id,
      id,
      'update',
      { status: current.status, version: current.updatedAt },
      {
        title: merged.title,
        status: merged.status,
        priority: merged.priority,
        version: patch.expectedVersion + 1,
      },
    );
    await this.record(user, spaceId, 'tasks.update', 'task', id, {
      fields: Object.keys(patch).filter((key) => key !== 'expectedVersion'),
    });
    this.realtime.publish(spaceId, 'tasks', user.id, { action: 'task.update', id });
    if (merged.assigneeUserId !== current.assigneeUserId || merged.dueAt !== current.dueAt) {
      await this.notifyAssignee(spaceId, id, assignee, merged.title, merged.dueAt);
    }
    if (merged.status === 'done' && current.status !== 'done' && merged.recurrenceRule) {
      await this.cloneRecurringTask(user, spaceId, merged, list.id, assignee);
    }
    return this.getTaskRow(spaceId, id);
  }

  async deleteTask(user: AuthenticatedUser, spaceId: string, id: string) {
    await this.access.assert(user.id, spaceId, 'tasks', 'delete');
    const row = await this.db.queryOne<{ title: string }>(
      'SELECT title FROM tasks WHERE id = $1 AND space_id = $2',
      [id, spaceId],
    );
    if (!row) throw new NotFoundException('task_not_found');
    await this.history(user.id, id, 'delete', { title: row.title }, {});
    await this.db.query('DELETE FROM tasks WHERE id = $1', [id]);
    await this.record(user, spaceId, 'tasks.delete', 'task', id, { title: row.title });
    this.realtime.publish(spaceId, 'tasks', user.id, { action: 'task.delete', id });
    return { deleted: true };
  }

  async comment(user: AuthenticatedUser, spaceId: string, id: string, input: CommentInput) {
    await this.access.assert(user.id, spaceId, 'tasks', 'update');
    await this.assertTask(id, spaceId);
    const row = await this.db.queryOne<{ id: string; created_at: Date | string }>(
      `INSERT INTO task_comments (id, task_id, author_user_id, body)
       VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [newId('cmt'), id, user.id, input.body],
    );
    this.realtime.publish(spaceId, 'tasks', user.id, { action: 'task.comment', id });
    return { id: row?.id ?? null, createdAt: iso(row?.created_at) };
  }

  async attach(user: AuthenticatedUser, spaceId: string, id: string, input: AttachmentInput) {
    await this.access.assert(user.id, spaceId, 'tasks', 'update');
    await this.assertTask(id, spaceId);
    const row = await this.db.queryOne<{ id: string }>(
      `INSERT INTO task_attachments (id, task_id, name, url, mime_type, size_bytes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        newId('att'),
        id,
        input.name,
        input.url,
        input.mimeType ?? null,
        input.sizeBytes ?? null,
        user.id,
      ],
    );
    return { id: row?.id ?? null };
  }

  async addDependency(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    input: DependencyInput,
  ) {
    await this.access.assert(user.id, spaceId, 'tasks', 'update');
    if (id === input.dependsOnTaskId) throw new BadRequestException('task_cannot_depend_on_itself');
    await this.assertTask(id, spaceId);
    await this.assertTask(input.dependsOnTaskId, spaceId);
    await this.db.query(
      `INSERT INTO task_dependencies (task_id, depends_on_task_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [id, input.dependsOnTaskId],
    );
    this.realtime.publish(spaceId, 'tasks', user.id, { action: 'task.dependency', id });
    return { created: true };
  }

  async addLink(user: AuthenticatedUser, spaceId: string, id: string, input: LinkInput) {
    await this.access.assert(user.id, spaceId, 'tasks', 'update');
    await this.assertTask(id, spaceId);
    await this.db.query(
      `INSERT INTO task_links (id, task_id, target_module, target_id)
       VALUES ($1,$2,$3,$4)`,
      [newId('tlk'), id, input.module, input.targetId],
    );
    this.realtime.publish(spaceId, 'tasks', user.id, { action: 'task.link', id });
    return { created: true };
  }

  async claim(user: AuthenticatedUser, spaceId: string, id: string): Promise<TaskItem> {
    await this.access.assert(user.id, spaceId, 'tasks', 'update');
    const task = await this.db.queryOne<{ assignee_user_id: string | null }>(
      'SELECT assignee_user_id FROM tasks WHERE id = $1 AND space_id = $2',
      [id, spaceId],
    );
    if (!task) throw new NotFoundException('task_not_found');
    if (task.assignee_user_id && task.assignee_user_id !== user.id) {
      throw new ConflictException('task_already_assigned');
    }
    await this.db.query(
      'UPDATE tasks SET assignee_user_id = $2, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [id, user.id],
    );
    await this.record(user, spaceId, 'tasks.claim', 'task', id);
    this.realtime.publish(spaceId, 'tasks', user.id, { action: 'task.claim', id });
    return this.getTaskRow(spaceId, id);
  }

  async autoAssign(user: AuthenticatedUser, spaceId: string, input: AutoAssignInput) {
    await this.access.assert(user.id, spaceId, 'tasks', 'update');
    const members = await this.db.query<{ user_id: string }>(
      `SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.space_id = $1 AND u.is_child = FALSE`,
      [spaceId],
    );
    if (members.length === 0) throw new BadRequestException('no_eligible_members');
    const workload = await this.db.query<{ user_id: string; score: number | string }>(
      `SELECT t.assignee_user_id AS user_id,
              (COUNT(*) * 10 + COALESCE(SUM(t.estimate_minutes), 0) / 60)::int AS score
       FROM tasks t
       WHERE t.space_id = $1 AND t.status NOT IN ('done','cancelled') AND t.assignee_user_id IS NOT NULL
       GROUP BY t.assignee_user_id`,
      [spaceId],
    );
    const calendarLoad = await this.db.query<{ user_id: string; count: number | string }>(
      `SELECT p.user_id, COUNT(*)::int AS count
       FROM calendar_events e JOIN calendar_event_participants p ON p.event_id = e.id
       WHERE e.space_id = $1 AND e.status <> 'cancelled'
         AND e.starts_at BETWEEN CURRENT_TIMESTAMP AND CURRENT_TIMESTAMP + INTERVAL '7 days'
       GROUP BY p.user_id`,
      [spaceId],
    );
    const taskScore = new Map(workload.map((row) => [row.user_id, Number(row.score ?? 0)]));
    const eventScore = new Map(
      calendarLoad.map((row) => [row.user_id, Number(row.count ?? 0) * 5]),
    );
    const score = (userId: string) => (taskScore.get(userId) ?? 0) + (eventScore.get(userId) ?? 0);
    const assignments: Array<{ taskId: string; assigneeUserId: string; reason: string }> = [];
    for (const taskId of input.taskIds) {
      const chosen = [...members]
        .map((member) => member.user_id)
        .sort((left, right) => score(left) - score(right) || left.localeCompare(right))[0]!;
      const result = await this.db.query<{ id: string }>(
        `UPDATE tasks SET assignee_user_id = $2, version = version + 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND space_id = $3 RETURNING id`,
        [taskId, chosen, spaceId],
      );
      if (result.length === 0) continue;
      taskScore.set(chosen, (taskScore.get(chosen) ?? 0) + 10);
      assignments.push({
        taskId,
        assigneeUserId: chosen,
        reason: 'Наименьшая текущая загрузка по задачам и календарю; без баллов и рейтингов',
      });
      await this.notifyAssignee(spaceId, taskId, chosen, 'Новая задача', null);
    }
    await this.record(user, spaceId, 'tasks.auto_assign', 'task_collection', null, {
      assigned: assignments.length,
    });
    this.realtime.publish(spaceId, 'tasks', user.id, {
      action: 'task.auto_assign',
      count: assignments.length,
    });
    return { assignments };
  }

  async prioritize(user: AuthenticatedUser, spaceId: string, id: string, input: PrioritizeInput) {
    await this.access.assert(user.id, spaceId, 'tasks', 'read');
    const task = await this.getTaskRow(spaceId, id);
    const reasons: string[] = [];
    let score = 10;
    if (task.dueAt) {
      const hours = (new Date(task.dueAt).getTime() - Date.now()) / 3_600_000;
      if (hours < 24) {
        score += 40;
        reasons.push('срок менее чем через сутки');
      } else if (hours < 72) {
        score += 20;
        reasons.push('срок в течение трёх дней');
      }
    }
    if (task.status === 'blocked' || task.dependencyCount > 0) {
      score += 15;
      reasons.push('есть зависимости или блокировка');
    }
    score += task.complexity * 3;
    if (task.complexity >= 4) reasons.push('высокая сложность');
    const suggested: TaskPriority =
      score >= 55 ? 'urgent' : score >= 35 ? 'high' : score >= 20 ? 'normal' : 'low';
    let applied = false;
    if (input.apply && suggested !== task.priority) {
      await this.access.assert(user.id, spaceId, 'tasks', 'update');
      await this.db.query(
        'UPDATE tasks SET priority = $2, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [id, suggested],
      );
      applied = true;
      this.realtime.publish(spaceId, 'tasks', user.id, {
        action: 'task.prioritize',
        id,
        suggested,
      });
    }
    return {
      taskId: id,
      current: task.priority,
      suggested,
      score,
      reasons,
      applied,
      explanation:
        'Детерминированные правила: срок, зависимости, сложность. ИИ и геймификация не используются.',
    };
  }

  async split(user: AuthenticatedUser, spaceId: string, id: string, input: SplitInput) {
    await this.access.assert(user.id, spaceId, 'tasks', 'read');
    const task = await this.getTaskRow(spaceId, id);
    const steps = [
      `Подготовить: ${task.title}`,
      `Выполнить основную часть: ${task.title}`,
      `Проверить результат: ${task.title}`,
      `Оформить и убрать: ${task.title}`,
      `Отметить завершение: ${task.title}`,
    ].slice(0, input.count);
    const estimate = Math.max(5, Math.ceil(task.estimateMinutes / input.count));
    let created: TaskItem[] = [];
    if (input.apply) {
      await this.access.assert(user.id, spaceId, 'tasks', 'create');
      for (const [index, title] of steps.entries()) {
        const child = await this.createTask(user, spaceId, {
          listId: task.listId,
          parentTaskId: id,
          title,
          description: `Подзадача для «${task.title}»`,
          status: 'todo',
          priority: task.priority,
          category: task.category,
          assigneeUserId: task.assigneeUserId,
          dueAt: task.dueAt,
          estimateMinutes: estimate,
          complexity: Math.max(1, task.complexity - 1),
          recurrenceRule: null,
          links: [],
        });
        created.push(child);
      }
    }
    return { taskId: id, steps, estimateMinutes: estimate, applied: input.apply, created };
  }

  async templates(user: AuthenticatedUser, spaceId: string) {
    await this.access.assert(user.id, spaceId, 'tasks', 'read');
    const rows = await this.db.query<{
      id: string;
      name: string;
      fields: unknown;
      created_at: Date | string;
    }>(
      'SELECT id, name, fields, created_at FROM task_templates WHERE space_id = $1 ORDER BY created_at DESC',
      [spaceId],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      fields: parseJson<Record<string, unknown>>(row.fields, {}),
      createdAt: iso(row.created_at),
    }));
  }

  async createTemplate(user: AuthenticatedUser, spaceId: string, input: TemplateInput) {
    await this.access.assert(user.id, spaceId, 'tasks', 'create');
    const row = await this.db.queryOne<{ id: string }>(
      `INSERT INTO task_templates (id, space_id, name, fields, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [newId('tpl'), spaceId, input.name, JSON.stringify(input.fields), user.id],
    );
    return { id: row?.id ?? null, name: input.name };
  }

  async applyTemplate(user: AuthenticatedUser, spaceId: string, input: ApplyTemplateInput) {
    await this.access.assert(user.id, spaceId, 'tasks', 'create');
    const row = await this.db.queryOne<{ name: string; fields: unknown }>(
      'SELECT name, fields FROM task_templates WHERE id = $1 AND space_id = $2',
      [input.templateId, spaceId],
    );
    if (!row) throw new NotFoundException('task_template_not_found');
    const fields = {
      ...parseJson<Record<string, unknown>>(row.fields, {}),
      ...input.overrides,
    };
    return this.createTask(user, spaceId, {
      listId: typeof fields.listId === 'string' ? fields.listId : undefined,
      parentTaskId: typeof fields.parentTaskId === 'string' ? fields.parentTaskId : null,
      title: typeof fields.title === 'string' ? fields.title : row.name,
      description: typeof fields.description === 'string' ? fields.description : '',
      status: isTaskStatus(fields.status) ? fields.status : 'todo',
      priority: isTaskPriority(fields.priority) ? fields.priority : 'normal',
      category: typeof fields.category === 'string' ? fields.category : 'home',
      assigneeUserId: typeof fields.assigneeUserId === 'string' ? fields.assigneeUserId : null,
      dueAt: typeof fields.dueAt === 'string' ? fields.dueAt : null,
      estimateMinutes: typeof fields.estimateMinutes === 'number' ? fields.estimateMinutes : 30,
      complexity: typeof fields.complexity === 'number' ? fields.complexity : 2,
      recurrenceRule: typeof fields.recurrenceRule === 'string' ? fields.recurrenceRule : null,
      links: Array.isArray(fields.links)
        ? (fields.links as Array<{ module: string; targetId: string }>)
        : [],
    });
  }

  private async getTaskRow(spaceId: string, id: string): Promise<TaskItem> {
    const row = await this.db.queryOne<TaskRow>(
      `${TASK_SELECT} WHERE t.id = $1 AND t.space_id = $2`,
      [id, spaceId],
    );
    if (!row) throw new NotFoundException('task_not_found');
    return toTaskItem(row);
  }

  private async taskLinks(id: string) {
    const rows = await this.db.query<{ target_module: string; target_id: string }>(
      'SELECT target_module, target_id FROM task_links WHERE task_id = $1',
      [id],
    );
    return rows.map((row) => ({ module: row.target_module, targetId: row.target_id }));
  }

  private async replaceLinks(id: string, links: Array<{ module: string; targetId: string }>) {
    await this.db.query('DELETE FROM task_links WHERE task_id = $1', [id]);
    for (const link of links) {
      await this.db.query(
        'INSERT INTO task_links (id, task_id, target_module, target_id) VALUES ($1,$2,$3,$4)',
        [newId('tlk'), id, link.module, link.targetId],
      );
    }
  }

  private async resolveList(spaceId: string, listId: string | undefined, userId: string) {
    if (listId) {
      const row = await this.db.queryOne<{ id: string }>(
        'SELECT id FROM task_lists WHERE id = $1 AND space_id = $2',
        [listId, spaceId],
      );
      if (!row) throw new NotFoundException('task_list_not_found');
      return row;
    }
    const existing = await this.db.queryOne<{ id: string }>(
      'SELECT id FROM task_lists WHERE space_id = $1 ORDER BY created_at ASC LIMIT 1',
      [spaceId],
    );
    if (existing) return existing;
    const row = await this.db.queryOne<{ id: string }>(
      `INSERT INTO task_lists (id, space_id, name, kind, color, created_by)
       VALUES ($1,$2,'Общее','list','#14B8A6',$3) RETURNING id`,
      [newId('lst'), spaceId, userId],
    );
    if (!row) throw new NotFoundException('task_list_not_created');
    return row;
  }

  private async resolveAssignee(spaceId: string, userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const row = await this.db.queryOne<{ user_id: string }>(
      'SELECT user_id FROM memberships WHERE space_id = $1 AND user_id = $2',
      [spaceId, userId],
    );
    if (!row) throw new BadRequestException('assignee_not_space_member');
    return row.user_id;
  }

  private async nextPosition(spaceId: string, listId: string): Promise<number> {
    const row = await this.db.queryOne<{ next: number | string }>(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next FROM tasks WHERE space_id = $1 AND list_id = $2',
      [spaceId, listId],
    );
    return Number(row?.next ?? 1);
  }

  private async assertTask(id: string, spaceId: string) {
    const row = await this.db.queryOne<{ id: string }>(
      'SELECT id FROM tasks WHERE id = $1 AND space_id = $2',
      [id, spaceId],
    );
    if (!row) throw new NotFoundException('task_not_found');
  }

  private async notifyAssignee(
    spaceId: string,
    taskId: string,
    assignee: string | null,
    title: string,
    dueAt: string | null,
  ) {
    if (!assignee) return;
    try {
      await this.notifications.notifyUser(assignee, {
        spaceId,
        category: 'tasks',
        severity:
          dueAt && new Date(dueAt).getTime() - Date.now() < 86_400_000 ? 'important' : 'info',
        title: `Задача: ${title}`,
        body: dueAt ? `Срок: ${new Date(dueAt).toLocaleString('ru-RU')}` : 'Назначена новая задача',
        sourceModule: 'tasks',
        sourceId: taskId,
        actionUrl: '/tasks',
        dedupeKey: `task:${taskId}:assignment:${assignee}`,
      });
    } catch {
      // Category can be disabled in user notification preferences.
    }
  }

  private async cloneRecurringTask(
    user: AuthenticatedUser,
    spaceId: string,
    input: TaskInput,
    listId: string,
    assignee: string | null,
  ) {
    const after = input.dueAt ? new Date(input.dueAt) : new Date();
    const next = input.recurrenceRule ? this.ics.nextOccurrence(input.recurrenceRule, after) : null;
    if (!next) return;
    await this.db.query(
      `INSERT INTO tasks
         (id, list_id, space_id, parent_task_id, title, description, status, priority,
          category, assignee_user_id, due_at, estimate_minutes, complexity,
          recurrence_rule, position, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'todo',$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        newId('tsk'),
        listId,
        spaceId,
        input.parentTaskId ?? null,
        input.title,
        input.description,
        input.priority,
        input.category,
        assignee,
        next.toISOString(),
        input.estimateMinutes,
        input.complexity,
        input.recurrenceRule,
        await this.nextPosition(spaceId, listId),
        user.id,
      ],
    );
    await this.record(user, spaceId, 'tasks.recurrence.create', 'task', null, {
      title: input.title,
      dueAt: next.toISOString(),
    });
  }

  private async history(
    actorUserId: string,
    taskId: string,
    action: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ) {
    await this.db.query(
      `INSERT INTO task_history (id, task_id, actor_user_id, action, before, after)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [newId('th'), taskId, actorUserId, action, JSON.stringify(before), JSON.stringify(after)],
    );
  }

  private async record(
    user: AuthenticatedUser,
    spaceId: string,
    action: string,
    entity: string,
    entityId: string | null,
    metadata: Record<string, unknown> = {},
  ) {
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action,
      entity,
      entityId,
      metadata,
    });
  }
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return ['todo', 'in_progress', 'blocked', 'done', 'cancelled'].includes(String(value));
}

function isTaskPriority(value: unknown): value is TaskPriority {
  return ['low', 'normal', 'high', 'urgent'].includes(String(value));
}
