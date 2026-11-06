import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  FamilyPerson,
  FamilyPersonDetail,
  FamilyRelation,
  FamilyTree,
  PublicFamilyPerson,
  RelationKind,
} from '@ufos/contracts';
import { AccessService, type AccessContext } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../common/authed-request';
import { newId } from '../config';
import { DatabaseService } from '../db/database.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  dateOnly,
  toPerson,
  toRelation,
  type PersonRow,
  type RelationRow,
} from '../stage-d/mappers';

export interface PersonInput {
  fullName: string;
  birthName: string;
  birthDate: string | null;
  deathDate: string | null;
  birthPlace: string;
  biography: string;
  contacts: { phone?: string; email?: string; address?: string };
  contactVisibility: 'owner' | 'adults' | 'family';
  visibility: 'private' | 'family';
  linkedUserId: string | null;
}

type LinkKind = 'journal' | 'file' | 'document' | 'album';

@Injectable()
export class EncyclopediaService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  private isManager(context: AccessContext) {
    return context.role === 'space_owner' || context.role === 'space_admin';
  }

  /** Private people are visible to their creator and space owners/admins. */
  private visibleClause(context: AccessContext, alias = 'p', userParam = '$2') {
    if (this.isManager(context))
      return `${alias}.deleted_at IS NULL AND ${userParam}::text IS NOT NULL`;
    return `${alias}.deleted_at IS NULL AND (${alias}.visibility = 'family' OR ${alias}.created_by = ${userParam})`;
  }

  private showContacts(user: AuthenticatedUser, context: AccessContext, row: PersonRow): boolean {
    if (row.created_by === user.id || context.role === 'space_owner') return true;
    if (row.contact_visibility === 'owner') return false;
    if (row.contact_visibility === 'adults') return !user.isChild && context.role !== 'child';
    return true;
  }

  private async log(
    user: AuthenticatedUser,
    spaceId: string,
    action: string,
    id: string,
    metadata = {},
  ) {
    await this.audit.record({
      actorUserId: user.id,
      actorEmail: user.email,
      spaceId,
      action,
      entity: 'family_person',
      entityId: id,
      metadata,
    });
    this.realtime.publish(spaceId, 'encyclopedia', user.id, { action, id });
  }

  async list(user: AuthenticatedUser, spaceId: string, q?: string): Promise<FamilyPerson[]> {
    const context = await this.access.assert(user.id, spaceId, 'encyclopedia', 'read');
    const params: unknown[] = [spaceId, user.id];
    let search = '';
    if (q) {
      params.push(`%${q.replace(/[%_\\]/g, (match) => `\\${match}`)}%`);
      search = ` AND (p.full_name ILIKE $3 OR p.birth_name ILIKE $3 OR p.biography ILIKE $3 OR p.birth_place ILIKE $3)`;
    }
    const rows = await this.db.query<PersonRow>(
      `SELECT p.* FROM family_people p WHERE p.space_id = $1 AND ${this.visibleClause(context)}${search}
       ORDER BY p.birth_date NULLS LAST, p.full_name LIMIT 1000`,
      params,
    );
    return rows.map((row) => toPerson(row, this.showContacts(user, context, row)));
  }

  private async requirePerson(user: AuthenticatedUser, spaceId: string, id: string) {
    const context = await this.access.assert(user.id, spaceId, 'encyclopedia', 'read');
    const row = await this.db.queryOne<PersonRow>(
      `SELECT p.* FROM family_people p WHERE p.id = $3 AND p.space_id = $1 AND ${this.visibleClause(context)}`,
      [spaceId, user.id, id],
    );
    if (!row) throw new NotFoundException('person_not_found');
    return { row, context };
  }

  private async assertEdit(user: AuthenticatedUser, spaceId: string, row: PersonRow) {
    if (row.created_by === user.id) {
      await this.access.assert(user.id, spaceId, 'encyclopedia', 'create');
      return;
    }
    await this.access.assert(user.id, spaceId, 'encyclopedia', 'update');
  }

  async get(user: AuthenticatedUser, spaceId: string, id: string): Promise<FamilyPersonDetail> {
    const { row, context } = await this.requirePerson(user, spaceId, id);
    const [relations, links, photos] = await Promise.all([
      this.db.query<RelationRow & { other_name: string; direction: 'out' | 'in' }>(
        `SELECT r.*, o.full_name AS other_name, 'out' AS direction FROM family_relations r
           JOIN family_people o ON o.id = r.related_person_id
           WHERE r.person_id = $1 AND ${this.visibleClause(context, 'o', '$2')}
         UNION ALL
         SELECT r.*, o.full_name AS other_name, 'in' AS direction FROM family_relations r
           JOIN family_people o ON o.id = r.person_id
           WHERE r.related_person_id = $1 AND ${this.visibleClause(context, 'o', '$2')}`,
        [id, user.id],
      ),
      this.db.query<{ target_kind: LinkKind; target_id: string }>(
        'SELECT target_kind, target_id FROM family_person_links WHERE person_id = $1 ORDER BY created_at',
        [id],
      ),
      this.db.query<{
        id: string;
        name: string;
        kind: 'image' | 'video';
        taken_at: Date | string | null;
      }>(
        `SELECT DISTINCT f.id, f.name, f.kind, f.taken_at FROM media_people_tags t
         JOIN files f ON f.id = t.file_id
         WHERE t.person_id = $1 AND f.deleted_at IS NULL AND (f.visibility = 'space' OR f.created_by = $2)
         LIMIT 60`,
        [id, user.id],
      ),
    ]);
    const resolvedLinks = [];
    for (const link of links) {
      const title = await this.linkTitle(user, spaceId, link.target_kind, link.target_id);
      if (title !== null)
        resolvedLinks.push({ targetKind: link.target_kind, targetId: link.target_id, title });
    }
    return {
      ...toPerson(row, this.showContacts(user, context, row)),
      relations: relations.map((relation) => ({
        ...toRelation(relation),
        otherName: relation.other_name,
        direction: relation.direction,
      })),
      links: resolvedLinks,
      photos: photos.map((photo) => ({
        id: photo.id,
        name: photo.name,
        kind: photo.kind,
        takenAt: photo.taken_at ? new Date(photo.taken_at).toISOString() : null,
      })),
    };
  }

  /** Returns null when the viewer cannot see the linked item (no title leak). */
  private async linkTitle(
    user: AuthenticatedUser,
    spaceId: string,
    kind: LinkKind,
    targetId: string,
  ): Promise<string | null> {
    if (kind === 'journal') {
      const row = await this.db.queryOne<{ title: string; kind: string }>(
        `SELECT title, kind FROM journal_entries WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL
           AND (visibility = 'family' OR author_user_id = $3)`,
        [targetId, spaceId, user.id],
      );
      return row ? row.title || row.kind : null;
    }
    if (kind === 'file') {
      const row = await this.db.queryOne<{ name: string }>(
        `SELECT name FROM files WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL
           AND (visibility = 'space' OR created_by = $3)`,
        [targetId, spaceId, user.id],
      );
      return row?.name ?? null;
    }
    if (kind === 'document') {
      const row = await this.db.queryOne<{ title: string }>(
        'SELECT title FROM documents WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL',
        [targetId, spaceId],
      );
      return row?.title ?? null;
    }
    const row = await this.db.queryOne<{ title: string }>(
      'SELECT title FROM photo_albums WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL',
      [targetId, spaceId],
    );
    return row?.title ?? null;
  }

  private validateDates(input: Partial<PersonInput>) {
    if (input.birthDate && input.deathDate && input.deathDate < input.birthDate) {
      throw new BadRequestException('death_before_birth');
    }
  }

  private async validateLinkedUser(spaceId: string, linkedUserId: string | null | undefined) {
    if (!linkedUserId) return;
    const member = await this.db.queryOne<{ user_id: string }>(
      'SELECT user_id FROM memberships WHERE space_id = $1 AND user_id = $2',
      [spaceId, linkedUserId],
    );
    if (!member) throw new BadRequestException('linked_user_not_in_space');
  }

  async create(
    user: AuthenticatedUser,
    spaceId: string,
    input: PersonInput,
  ): Promise<FamilyPerson> {
    const context = await this.access.assert(user.id, spaceId, 'encyclopedia', 'create');
    this.validateDates(input);
    await this.validateLinkedUser(spaceId, input.linkedUserId);
    const id = newId('per');
    const row = await this.db.queryOne<PersonRow>(
      `INSERT INTO family_people (id, space_id, full_name, birth_name, birth_date, death_date, birth_place,
         biography, contacts, contact_visibility, visibility, linked_user_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        id,
        spaceId,
        input.fullName,
        input.birthName,
        input.birthDate,
        input.deathDate,
        input.birthPlace,
        input.biography,
        JSON.stringify(input.contacts),
        input.contactVisibility,
        input.visibility,
        input.linkedUserId,
        user.id,
      ],
    );
    await this.log(user, spaceId, 'encyclopedia.person.create', id, {
      visibility: input.visibility,
    });
    return toPerson(row!, this.showContacts(user, context, row!));
  }

  async update(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    patch: Partial<PersonInput>,
  ): Promise<FamilyPerson> {
    const { row, context } = await this.requirePerson(user, spaceId, id);
    await this.assertEdit(user, spaceId, row);
    const merged = {
      birthDate: patch.birthDate !== undefined ? patch.birthDate : dateOnly(row.birth_date),
      deathDate: patch.deathDate !== undefined ? patch.deathDate : dateOnly(row.death_date),
    };
    this.validateDates(merged);
    await this.validateLinkedUser(spaceId, patch.linkedUserId);
    const visibility = patch.visibility ?? row.visibility;
    // Making a person private or marking them alive again withdraws publication.
    const withdraw = row.publish_allowed && visibility === 'private';
    const updated = await this.db.queryOne<PersonRow>(
      `UPDATE family_people SET full_name = $3, birth_name = $4, birth_date = $5, death_date = $6,
         birth_place = $7, biography = $8, contacts = $9, contact_visibility = $10, visibility = $11,
         linked_user_id = $12, publish_allowed = $13, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND space_id = $2 RETURNING *`,
      [
        id,
        spaceId,
        patch.fullName ?? row.full_name,
        patch.birthName ?? row.birth_name,
        merged.birthDate,
        merged.deathDate,
        patch.birthPlace ?? row.birth_place,
        patch.biography ?? row.biography,
        JSON.stringify(patch.contacts ?? row.contacts ?? {}),
        patch.contactVisibility ?? row.contact_visibility,
        visibility,
        patch.linkedUserId !== undefined ? patch.linkedUserId : row.linked_user_id,
        withdraw ? false : row.publish_allowed,
      ],
    );
    await this.log(user, spaceId, 'encyclopedia.person.update', id, {
      fields: Object.keys(patch),
      withdraw,
    });
    return toPerson(updated!, this.showContacts(user, context, updated!));
  }

  async remove(user: AuthenticatedUser, spaceId: string, id: string) {
    const { row } = await this.requirePerson(user, spaceId, id);
    if (row.created_by !== user.id)
      await this.access.assert(user.id, spaceId, 'encyclopedia', 'delete');
    else await this.access.assert(user.id, spaceId, 'encyclopedia', 'create');
    await this.db.query(
      'UPDATE family_people SET deleted_at = CURRENT_TIMESTAMP, publish_allowed = FALSE WHERE id = $1',
      [id],
    );
    await this.db.query(
      'DELETE FROM family_relations WHERE person_id = $1 OR related_person_id = $1',
      [id],
    );
    await this.log(user, spaceId, 'encyclopedia.person.delete', id);
    return { deleted: true };
  }

  async addRelation(
    user: AuthenticatedUser,
    spaceId: string,
    input: {
      personId: string;
      relatedPersonId: string;
      kind: RelationKind;
      sinceDate: string | null;
      note: string;
    },
  ): Promise<FamilyRelation> {
    await this.access.assert(user.id, spaceId, 'encyclopedia', 'create');
    if (input.personId === input.relatedPersonId) throw new BadRequestException('relation_to_self');
    await this.requirePerson(user, spaceId, input.personId);
    await this.requirePerson(user, spaceId, input.relatedPersonId);
    // Symmetric relations are stored once; "parent" is directional.
    let [a, b] = [input.personId, input.relatedPersonId];
    if (input.kind !== 'parent' && a > b) [a, b] = [b, a];
    if (input.kind === 'parent') {
      const reverse = await this.db.queryOne<{ id: string }>(
        `SELECT id FROM family_relations WHERE person_id = $1 AND related_person_id = $2 AND kind = 'parent'`,
        [b, a],
      );
      if (reverse) throw new BadRequestException('relation_cycle');
      if (await this.isAncestor(b, a)) throw new BadRequestException('relation_cycle');
    }
    const existing = await this.db.queryOne<{ id: string }>(
      'SELECT id FROM family_relations WHERE person_id = $1 AND related_person_id = $2 AND kind = $3',
      [a, b, input.kind],
    );
    if (existing) throw new ConflictException('relation_exists');
    const row = await this.db.queryOne<RelationRow>(
      `INSERT INTO family_relations (id, space_id, person_id, related_person_id, kind, since_date, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [newId('rel'), spaceId, a, b, input.kind, input.sinceDate, input.note, user.id],
    );
    await this.log(user, spaceId, 'encyclopedia.relation.create', input.personId, {
      kind: input.kind,
    });
    return toRelation(row!);
  }

  /** True when `ancestor` is already an ancestor of `person` via parent edges. */
  private async isAncestor(ancestor: string, person: string): Promise<boolean> {
    const seen = new Set<string>();
    const queue = [person];
    while (queue.length > 0 && seen.size < 2000) {
      const current = queue.shift()!;
      const parents = await this.db.query<{ person_id: string }>(
        `SELECT person_id FROM family_relations WHERE related_person_id = $1 AND kind = 'parent'`,
        [current],
      );
      for (const parent of parents) {
        if (parent.person_id === ancestor) return true;
        if (!seen.has(parent.person_id)) {
          seen.add(parent.person_id);
          queue.push(parent.person_id);
        }
      }
    }
    return false;
  }

  async removeRelation(user: AuthenticatedUser, spaceId: string, id: string) {
    const row = await this.db.queryOne<RelationRow & { created_by: string | null }>(
      'SELECT * FROM family_relations WHERE id = $1 AND space_id = $2',
      [id, spaceId],
    );
    if (!row) throw new NotFoundException('relation_not_found');
    if (row.created_by !== user.id)
      await this.access.assert(user.id, spaceId, 'encyclopedia', 'update');
    else await this.access.assert(user.id, spaceId, 'encyclopedia', 'create');
    await this.db.query('DELETE FROM family_relations WHERE id = $1', [id]);
    await this.log(user, spaceId, 'encyclopedia.relation.delete', row.person_id, {
      relationId: id,
    });
    return { deleted: true };
  }

  async tree(user: AuthenticatedUser, spaceId: string): Promise<FamilyTree> {
    const context = await this.access.assert(user.id, spaceId, 'encyclopedia', 'read');
    const people = await this.list(user, spaceId);
    const visible = new Set(people.map((person) => person.id));
    const relations = (
      await this.db.query<RelationRow>('SELECT * FROM family_relations WHERE space_id = $1', [
        spaceId,
      ])
    )
      .map(toRelation)
      .filter(
        (relation) => visible.has(relation.personId) && visible.has(relation.relatedPersonId),
      );
    void context;
    // Generation = longest parent chain above a person; spouses share a level.
    const parentsOf = new Map<string, string[]>();
    for (const relation of relations) {
      if (relation.kind !== 'parent') continue;
      parentsOf.set(relation.relatedPersonId, [
        ...(parentsOf.get(relation.relatedPersonId) ?? []),
        relation.personId,
      ]);
    }
    const memo = new Map<string, number>();
    const generation = (id: string, depth = 0): number => {
      if (memo.has(id)) return memo.get(id)!;
      if (depth > 64) return 0;
      const parents = parentsOf.get(id) ?? [];
      const value =
        parents.length === 0
          ? 0
          : 1 + Math.max(...parents.map((parent) => generation(parent, depth + 1)));
      memo.set(id, value);
      return value;
    };
    const levels = new Map(people.map((person) => [person.id, generation(person.id)]));
    for (let pass = 0; pass < 3; pass += 1) {
      for (const relation of relations) {
        if (relation.kind !== 'spouse' && relation.kind !== 'sibling') continue;
        const level = Math.max(
          levels.get(relation.personId) ?? 0,
          levels.get(relation.relatedPersonId) ?? 0,
        );
        levels.set(relation.personId, level);
        levels.set(relation.relatedPersonId, level);
      }
    }
    return {
      people: people.map((person) => ({ ...person, generation: levels.get(person.id) ?? 0 })),
      relations,
    };
  }

  async addLink(
    user: AuthenticatedUser,
    spaceId: string,
    personId: string,
    input: { targetKind: LinkKind; targetId: string },
  ) {
    const { row } = await this.requirePerson(user, spaceId, personId);
    await this.assertEdit(user, spaceId, row).catch(async () => {
      await this.access.assert(user.id, spaceId, 'encyclopedia', 'create');
    });
    const title = await this.linkTitle(user, spaceId, input.targetKind, input.targetId);
    if (title === null) throw new BadRequestException('link_target_not_found');
    await this.db.query(
      `INSERT INTO family_person_links (person_id, space_id, target_kind, target_id, created_by)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [personId, spaceId, input.targetKind, input.targetId, user.id],
    );
    await this.log(user, spaceId, 'encyclopedia.link.create', personId, input);
    return this.get(user, spaceId, personId);
  }

  async removeLink(
    user: AuthenticatedUser,
    spaceId: string,
    personId: string,
    targetKind: LinkKind,
    targetId: string,
  ) {
    const { row } = await this.requirePerson(user, spaceId, personId);
    await this.assertEdit(user, spaceId, row);
    await this.db.query(
      'DELETE FROM family_person_links WHERE person_id = $1 AND target_kind = $2 AND target_id = $3',
      [personId, targetKind, targetId],
    );
    await this.log(user, spaceId, 'encyclopedia.link.delete', personId, { targetKind, targetId });
    return this.get(user, spaceId, personId);
  }

  /**
   * Publication to the public site is a separate, explicit permission
   * (`encyclopedia:publish`). Living people additionally need a recorded
   * consent note; private entries can never be published. Contacts and exact
   * dates of living people are never part of the public view.
   */
  async setPublication(
    user: AuthenticatedUser,
    spaceId: string,
    id: string,
    input: { publish: boolean; livingConsent: boolean; consentNote: string },
  ): Promise<FamilyPerson> {
    const { row, context } = await this.requirePerson(user, spaceId, id);
    await this.access.assert(user.id, spaceId, 'encyclopedia', 'publish');
    if (input.publish) {
      if (row.visibility === 'private')
        throw new ForbiddenException('private_person_cannot_be_published');
      if (!row.death_date && (!input.livingConsent || input.consentNote.trim().length < 3)) {
        throw new BadRequestException('living_person_publication_requires_consent');
      }
    }
    const updated = await this.db.queryOne<PersonRow>(
      `UPDATE family_people SET publish_allowed = $3, publish_consent_note = $4,
         published_by = $5, published_at = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND space_id = $2 RETURNING *`,
      [
        id,
        spaceId,
        input.publish,
        input.publish ? input.consentNote : '',
        input.publish ? user.id : null,
        input.publish ? new Date().toISOString() : null,
      ],
    );
    await this.log(
      user,
      spaceId,
      input.publish ? 'encyclopedia.publish' : 'encyclopedia.unpublish',
      id,
      {
        living: !row.death_date,
      },
    );
    return toPerson(updated!, this.showContacts(user, context, updated!));
  }

  async publicPeople(): Promise<PublicFamilyPerson[]> {
    const rows = await this.db.query<PersonRow>(
      `SELECT * FROM family_people WHERE publish_allowed = TRUE AND visibility = 'family'
         AND deleted_at IS NULL ORDER BY birth_date NULLS LAST, full_name LIMIT 200`,
    );
    return rows.map((row) => {
      const living = !row.death_date;
      const year = (value: PersonRow['birth_date']) => {
        const date = dateOnly(value);
        return date ? Number(date.slice(0, 4)) : null;
      };
      return {
        id: row.id,
        fullName: row.full_name,
        birthYear: living ? null : year(row.birth_date),
        deathYear: year(row.death_date),
        biography: row.biography,
      };
    });
  }
}
