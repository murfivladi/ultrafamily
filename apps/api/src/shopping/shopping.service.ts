import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ShoppingItem, ShoppingList } from '@ufos/contracts';
import type { z } from 'zod';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { newId } from '../config';
import type { AuthenticatedUser } from '../common/authed-request';
import { DatabaseService } from '../db/database.service';
import { iso } from '../db/rows';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  toShoppingItem,
  toShoppingList,
  type ShoppingItemRow,
  type ShoppingListRow,
  type ShoppingPresenceRow,
} from '../stage-b/mappers';
import type {
  claimSchema,
  generateSchema,
  itemSchema,
  listSchema,
  mergeSchema,
  updateItemSchema,
} from './dto';

type ListInput = z.infer<typeof listSchema>;
type ItemInput = z.infer<typeof itemSchema>;
type ItemPatch = z.infer<typeof updateItemSchema>;
type MergeInput = z.infer<typeof mergeSchema>;
type GenerateInput = z.infer<typeof generateSchema>;
type ClaimInput = z.infer<typeof claimSchema>;

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase('ru').replace(/\s+/g, ' ');
}

@Injectable()
export class ShoppingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
  ) {}

  async lists(user: AuthenticatedUser, spaceId: string): Promise<ShoppingList[]> {
    await this.access.assert(user.id, spaceId, 'shopping', 'read');
    const rows = await this.db.query<ShoppingListRow>(
      `SELECT id, space_id, name, kind, status, version, updated_at
       FROM shopping_lists WHERE space_id = $1 AND status = 'active'
       ORDER BY created_at ASC`,
      [spaceId],
    );
    return Promise.all(rows.map((row) => this.buildList(spaceId, row)));
  }

  async createList(
    user: AuthenticatedUser,
    spaceId: string,
    input: ListInput,
  ): Promise<ShoppingList> {
    await this.access.assert(user.id, spaceId, 'shopping', 'create');
    const row = await this.db.queryOne<ShoppingListRow>(
      `INSERT INTO shopping_lists (id, space_id, name, kind, status, version, created_by)
       VALUES ($1,$2,$3,$4,'active',1,$5)
       RETURNING id, space_id, name, kind, status, version, updated_at`,
      [newId('shl'), spaceId, input.name, input.kind, user.id],
    );
    if (!row) throw new NotFoundException('shopping_list_not_created');
    await this.record(user, spaceId, 'shopping.list.create', 'shopping_list', row.id, {
      name: input.name,
    });
    this.realtime.publish(spaceId, 'shopping', user.id, { action: 'list.create', id: row.id });
    return this.buildList(spaceId, row);
  }

  async createItem(
    user: AuthenticatedUser,
    spaceId: string,
    input: ItemInput,
  ): Promise<ShoppingItem> {
    await this.access.assert(user.id, spaceId, 'shopping', 'create');
    await this.assertList(spaceId, input.listId);
    const assignee = await this.resolveAssignee(spaceId, input.assignedUserId);
    const row = await this.db.queryOne<ShoppingItemRow>(
      `INSERT INTO shopping_items
         (id, list_id, space_id, name, quantity, unit, category, checked,
          assigned_user_id, source_module, source_id, notes, position, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        newId('shi'),
        input.listId,
        spaceId,
        input.name,
        input.quantity,
        input.unit,
        input.category,
        assignee,
        input.sourceModule,
        input.sourceId,
        input.notes,
        await this.nextPosition(input.listId),
        user.id,
      ],
    );
    if (!row) throw new NotFoundException('shopping_item_not_created');
    await this.touchList(spaceId, input.listId);
    await this.record(user, spaceId, 'shopping.item.create', 'shopping_item', row.id, {
      name: input.name,
    });
    this.realtime.publish(spaceId, 'shopping', user.id, {
      action: 'item.create',
      id: row.id,
      listId: input.listId,
    });
    await this.notifyAssigned(spaceId, input.listId, assignee, input.name);
    return toShoppingItem(row);
  }

  async updateItem(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    patch: ItemPatch,
  ): Promise<ShoppingItem> {
    await this.access.assert(user.id, spaceId, 'shopping', 'update');
    const list = await this.assertList(spaceId, patch.listId);
    if (Number(list.version) !== patch.expectedVersion) {
      throw new ConflictException('shopping_list_version_conflict');
    }
    const existing = await this.db.queryOne<ShoppingItemRow>(
      'SELECT * FROM shopping_items WHERE id = $1 AND list_id = $2 AND space_id = $3',
      [id, patch.listId, spaceId],
    );
    if (!existing) throw new NotFoundException('shopping_item_not_found');
    const current = toShoppingItem(existing);
    const merged: ItemInput = {
      listId: patch.listId,
      name: patch.name ?? current.name,
      quantity: patch.quantity ?? current.quantity,
      unit: patch.unit ?? current.unit,
      category: patch.category ?? current.category,
      assignedUserId:
        patch.assignedUserId === undefined ? current.assignedUserId : patch.assignedUserId,
      sourceModule: patch.sourceModule === undefined ? current.sourceModule : patch.sourceModule,
      sourceId: patch.sourceId === undefined ? current.sourceId : patch.sourceId,
      notes: patch.notes ?? current.notes,
    };
    const checked = patch.checked ?? current.checked;
    const assignee = await this.resolveAssignee(spaceId, merged.assignedUserId);
    const row = await this.db.queryOne<ShoppingItemRow>(
      `UPDATE shopping_items SET name = $2, quantity = $3, unit = $4, category = $5,
         checked = $6, assigned_user_id = $7, source_module = $8, source_id = $9,
         notes = $10, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *`,
      [
        id,
        merged.name,
        merged.quantity,
        merged.unit,
        merged.category,
        checked,
        assignee,
        merged.sourceModule,
        merged.sourceId,
        merged.notes,
      ],
    );
    if (!row) throw new NotFoundException('shopping_item_not_found');
    if (!current.checked && checked) {
      await this.db.query(
        `INSERT INTO purchase_history
           (id, space_id, list_id, item_name, quantity, unit, category, purchased_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          newId('pur'),
          spaceId,
          patch.listId,
          merged.name,
          merged.quantity,
          merged.unit,
          merged.category,
          user.id,
        ],
      );
    }
    await this.touchList(spaceId, patch.listId);
    await this.record(user, spaceId, 'shopping.item.update', 'shopping_item', id, {
      checked,
      fields: Object.keys(patch).filter((key) => !['listId', 'expectedVersion'].includes(key)),
    });
    this.realtime.publish(spaceId, 'shopping', user.id, {
      action: 'item.update',
      id,
      listId: patch.listId,
    });
    await this.notifyAssigned(spaceId, patch.listId, assignee, merged.name);
    return toShoppingItem(row);
  }

  async deleteItem(user: AuthenticatedUser, spaceId: string, id: string, listId: string) {
    await this.access.assert(user.id, spaceId, 'shopping', 'delete');
    await this.assertList(spaceId, listId);
    const row = await this.db.queryOne<{ id: string }>(
      'DELETE FROM shopping_items WHERE id = $1 AND list_id = $2 AND space_id = $3 RETURNING id',
      [id, listId, spaceId],
    );
    if (!row) throw new NotFoundException('shopping_item_not_found');
    await this.touchList(spaceId, listId);
    await this.record(user, spaceId, 'shopping.item.delete', 'shopping_item', id);
    this.realtime.publish(spaceId, 'shopping', user.id, { action: 'item.delete', id, listId });
    return { deleted: true };
  }

  async merge(user: AuthenticatedUser, spaceId: string, input: MergeInput) {
    await this.access.assert(user.id, spaceId, 'shopping', 'update');
    await this.assertList(spaceId, input.listId);
    const rows = await this.db.query<ShoppingItemRow>(
      'SELECT * FROM shopping_items WHERE list_id = $1 AND space_id = $2 ORDER BY position ASC',
      [input.listId, spaceId],
    );
    const groups = new Map<string, ShoppingItemRow[]>();
    for (const row of rows) {
      const key = `${normalizeName(row.name)}|${row.unit}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    let merged = 0;
    let removed = 0;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const [first, ...rest] = group;
      if (!first) continue;
      const quantity = group.reduce((sum, item) => sum + Number(item.quantity ?? 0), 0);
      const checked = group.every((item) => item.checked);
      const notes = [...new Set(group.map((item) => item.notes).filter(Boolean))].join('; ');
      await this.db.query(
        'UPDATE shopping_items SET quantity = $2, checked = $3, notes = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [first.id, quantity, checked, notes],
      );
      for (const item of rest) {
        await this.db.query('DELETE FROM shopping_items WHERE id = $1', [item.id]);
        removed += 1;
      }
      merged += 1;
    }
    await this.touchList(spaceId, input.listId);
    await this.record(user, spaceId, 'shopping.merge', 'shopping_list', input.listId, {
      merged,
      removed,
    });
    this.realtime.publish(spaceId, 'shopping', user.id, {
      action: 'list.merge',
      listId: input.listId,
      merged,
    });
    return { merged, removed };
  }

  async generateFromSources(user: AuthenticatedUser, spaceId: string, input: GenerateInput) {
    await this.access.assert(user.id, spaceId, 'shopping', 'create');
    await this.assertList(spaceId, input.listId);
    const from = input.from ?? new Date().toISOString();
    const to = input.to ?? new Date(Date.now() + 7 * 86_400_000).toISOString();
    const menuEvents = await this.db.query<{ id: string; title: string }>(
      `SELECT DISTINCT e.id, e.title FROM calendar_events e
       LEFT JOIN calendar_event_links l ON l.event_id = e.id
       WHERE e.space_id = $1 AND e.starts_at BETWEEN $2 AND $3
         AND (e.category IN ('meal','menu','recipe') OR l.target_module = 'menu')`,
      [spaceId, from, to],
    );
    const shoppingTasks = await this.db.query<{ id: string; title: string }>(
      `SELECT id, title FROM tasks WHERE space_id = $1 AND category = 'shopping'
       AND status NOT IN ('done','cancelled') AND due_at BETWEEN $2 AND $3`,
      [spaceId, from, to],
    );
    const existing = await this.db.query<{ name: string }>(
      'SELECT name FROM shopping_items WHERE list_id = $1 AND space_id = $2',
      [input.listId, spaceId],
    );
    const names = new Set(existing.map((row) => normalizeName(row.name)));
    const candidates = [
      ...menuEvents.map((event) => ({
        name: event.title,
        sourceModule: 'menu',
        sourceId: event.id,
      })),
      ...shoppingTasks.map((task) => ({
        name: task.title,
        sourceModule: 'tasks',
        sourceId: task.id,
      })),
    ];
    const created: ShoppingItem[] = [];
    for (const candidate of candidates) {
      const key = normalizeName(candidate.name);
      if (names.has(key)) continue;
      names.add(key);
      created.push(
        await this.createItem(user, spaceId, {
          listId: input.listId,
          name: candidate.name,
          quantity: 1,
          unit: 'pcs',
          category: 'meal',
          assignedUserId: null,
          sourceModule: candidate.sourceModule,
          sourceId: candidate.sourceId,
          notes: 'Создано из меню/задач Stage B',
        }),
      );
    }
    await this.record(user, spaceId, 'shopping.generate', 'shopping_list', input.listId, {
      created: created.length,
      from,
      to,
    });
    return { created: created.length, items: created, autoOrdering: false };
  }

  async joinPresence(user: AuthenticatedUser, spaceId: string, listId: string) {
    await this.access.assert(user.id, spaceId, 'shopping', 'read');
    await this.assertList(spaceId, listId);
    await this.db.query(
      `INSERT INTO shopping_presence (list_id, user_id, status, last_seen_at)
       VALUES ($1,$2,'viewing',CURRENT_TIMESTAMP)
       ON CONFLICT (list_id, user_id) DO UPDATE SET status = 'viewing', last_seen_at = CURRENT_TIMESTAMP`,
      [listId, user.id],
    );
    this.realtime.publish(spaceId, 'shopping.presence', user.id, {
      action: 'presence.join',
      listId,
    });
    return { joined: true };
  }

  async leavePresence(user: AuthenticatedUser, spaceId: string, listId: string) {
    await this.access.assert(user.id, spaceId, 'shopping', 'read');
    await this.db.query('DELETE FROM shopping_presence WHERE list_id = $1 AND user_id = $2', [
      listId,
      user.id,
    ]);
    this.realtime.publish(spaceId, 'shopping.presence', user.id, {
      action: 'presence.leave',
      listId,
    });
    return { left: true };
  }

  async claimItem(user: AuthenticatedUser, spaceId: string, id: string, input: ClaimInput) {
    await this.access.assert(user.id, spaceId, 'shopping', 'update');
    const list = await this.assertList(spaceId, input.listId);
    if (Number(list.version) !== input.expectedVersion) {
      throw new ConflictException('shopping_list_version_conflict');
    }
    const row = await this.db.queryOne<ShoppingItemRow>(
      `UPDATE shopping_items SET assigned_user_id = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND list_id = $3 AND space_id = $4 RETURNING *`,
      [id, user.id, input.listId, spaceId],
    );
    if (!row) throw new NotFoundException('shopping_item_not_found');
    await this.touchList(spaceId, input.listId);
    this.realtime.publish(spaceId, 'shopping', user.id, {
      action: 'item.claim',
      id,
      listId: input.listId,
    });
    return toShoppingItem(row);
  }

  async history(user: AuthenticatedUser, spaceId: string) {
    await this.access.assert(user.id, spaceId, 'shopping', 'read');
    const rows = await this.db.query<{
      id: string;
      item_name: string;
      quantity: number | string;
      unit: string;
      category: string;
      purchased_by: string | null;
      purchased_at: Date | string;
    }>(
      `SELECT id, item_name, quantity, unit, category, purchased_by, purchased_at
       FROM purchase_history WHERE space_id = $1 ORDER BY purchased_at DESC LIMIT 200`,
      [spaceId],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.item_name,
      quantity: Number(row.quantity ?? 0),
      unit: row.unit,
      category: row.category,
      purchasedBy: row.purchased_by,
      purchasedAt: iso(row.purchased_at),
    }));
  }

  async suggestions(user: AuthenticatedUser, spaceId: string) {
    await this.access.assert(user.id, spaceId, 'shopping', 'read');
    const rows = await this.db.query<{
      item_name: string;
      count: number | string;
      category: string;
    }>(
      `SELECT item_name, COUNT(*)::int AS count, MAX(category) AS category
       FROM purchase_history WHERE space_id = $1 GROUP BY item_name
       ORDER BY count DESC, item_name ASC LIMIT 10`,
      [spaceId],
    );
    await this.db.query(
      'DELETE FROM shopping_suggestions WHERE space_id = $1 AND accepted_at IS NULL',
      [spaceId],
    );
    const output = [];
    for (const row of rows) {
      const reason = `Часто покупается: ${Number(row.count ?? 0)} раз(а)`;
      const saved = await this.db.queryOne<{ id: string }>(
        `INSERT INTO shopping_suggestions (id, space_id, item_name, reason)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [newId('sug'), spaceId, row.item_name, reason],
      );
      output.push({
        id: saved?.id ?? null,
        name: row.item_name,
        category: row.category,
        reason,
        autoOrdering: false,
      });
    }
    return output;
  }

  async acceptSuggestion(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    listId: string,
  ): Promise<ShoppingItem> {
    await this.access.assert(user.id, spaceId, 'shopping', 'create');
    await this.assertList(spaceId, listId);
    const row = await this.db.queryOne<{ item_name: string }>(
      'SELECT item_name FROM shopping_suggestions WHERE id = $1 AND space_id = $2 AND accepted_at IS NULL',
      [id, spaceId],
    );
    if (!row) throw new NotFoundException('shopping_suggestion_not_found');
    const item = await this.createItem(user, spaceId, {
      listId,
      name: row.item_name,
      quantity: 1,
      unit: 'pcs',
      category: 'other',
      assignedUserId: null,
      sourceModule: 'shopping',
      sourceId: id,
      notes: 'Добавлено из локальной истории покупок',
    });
    await this.db.query(
      'UPDATE shopping_suggestions SET accepted_at = CURRENT_TIMESTAMP WHERE id = $1',
      [id],
    );
    return item;
  }

  async archiveList(user: AuthenticatedUser, spaceId: string, listId: string) {
    await this.access.assert(user.id, spaceId, 'shopping', 'update');
    const row = await this.db.queryOne<{ id: string }>(
      `UPDATE shopping_lists SET status = 'archived', completed_at = CURRENT_TIMESTAMP,
         version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND space_id = $2 RETURNING id`,
      [listId, spaceId],
    );
    if (!row) throw new NotFoundException('shopping_list_not_found');
    await this.record(user, spaceId, 'shopping.list.archive', 'shopping_list', listId);
    this.realtime.publish(spaceId, 'shopping', user.id, { action: 'list.archive', listId });
    return { archived: true };
  }

  private async buildList(spaceId: string, row: ShoppingListRow): Promise<ShoppingList> {
    const [items, presence] = await Promise.all([
      this.db.query<ShoppingItemRow>(
        'SELECT * FROM shopping_items WHERE list_id = $1 AND space_id = $2 ORDER BY position ASC',
        [row.id, spaceId],
      ),
      this.db.query<ShoppingPresenceRow>(
        `SELECT user_id, status, last_seen_at FROM shopping_presence
         WHERE list_id = $1 AND last_seen_at > CURRENT_TIMESTAMP - INTERVAL '5 minutes'`,
        [row.id],
      ),
    ]);
    return toShoppingList(row, items, presence);
  }

  private async assertList(spaceId: string, listId: string): Promise<ShoppingListRow> {
    const row = await this.db.queryOne<ShoppingListRow>(
      `SELECT id, space_id, name, kind, status, version, updated_at
       FROM shopping_lists WHERE id = $1 AND space_id = $2`,
      [listId, spaceId],
    );
    if (!row) throw new NotFoundException('shopping_list_not_found');
    return row;
  }

  private async touchList(spaceId: string, listId: string) {
    await this.db.query(
      'UPDATE shopping_lists SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND space_id = $2',
      [listId, spaceId],
    );
  }

  private async nextPosition(listId: string): Promise<number> {
    const row = await this.db.queryOne<{ next: number | string }>(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next FROM shopping_items WHERE list_id = $1',
      [listId],
    );
    return Number(row?.next ?? 1);
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

  private async notifyAssigned(
    spaceId: string,
    listId: string,
    assignee: string | null,
    name: string,
  ) {
    if (!assignee) return;
    try {
      await this.notifications.notifyUser(assignee, {
        spaceId,
        category: 'shopping',
        severity: 'info',
        title: `Покупка: ${name}`,
        body: 'Позиция назначена вам в совместном списке.',
        sourceModule: 'shopping',
        sourceId: listId,
        actionUrl: '/shopping',
        dedupeKey: `shopping:${listId}:${name}:${assignee}`,
      });
    } catch {
      // Category can be disabled in notification preferences.
    }
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
