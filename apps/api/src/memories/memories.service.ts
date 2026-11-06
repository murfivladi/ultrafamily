import { Injectable } from '@nestjs/common';
import type { MemoryCollection, MemoryItem, MemoryYear } from '@ufos/contracts';
import { AccessService, type AccessContext } from '../access/access.service';
import type { AuthenticatedUser } from '../common/authed-request';
import { DatabaseService } from '../db/database.service';
import { dateOnly } from '../stage-d/mappers';

interface Sources {
  journal: boolean;
  photos: boolean;
  encyclopedia: AccessContext | null;
}

/**
 * Family memories are assembled on demand from modules the viewer can read:
 * family journal entries and stories (plus the viewer's own private diary),
 * dated photos/videos/audio and birthdays from the encyclopedia. Collections
 * are deterministic (no AI): "on this day", "last month", stories, albums.
 */
@Injectable()
export class MemoriesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
  ) {}

  private async sources(user: AuthenticatedUser, spaceId: string): Promise<Sources> {
    await this.access.assert(user.id, spaceId, 'memories', 'read');
    const can = (module: string) =>
      this.access
        .assert(user.id, spaceId, module, 'read')
        .then((context) => context)
        .catch(() => null);
    const [journal, photos, encyclopedia] = await Promise.all([
      can('journal'),
      can('photos'),
      can('encyclopedia'),
    ]);
    return { journal: Boolean(journal), photos: Boolean(photos), encyclopedia };
  }

  private async items(
    user: AuthenticatedUser,
    spaceId: string,
    sources: Sources,
    where: { journal: string; media: string; births: string },
    params: unknown[],
    limit = 400,
  ): Promise<MemoryItem[]> {
    const parts: MemoryItem[] = [];
    if (sources.journal) {
      const rows = await this.db.query<{
        id: string;
        kind: 'diary' | 'story';
        title: string;
        body: string;
        entry_date: Date | string;
      }>(
        `SELECT id, kind, title, body, entry_date FROM journal_entries
         WHERE space_id = $1 AND deleted_at IS NULL AND (visibility = 'family' OR author_user_id = $2)
           ${where.journal}
         ORDER BY entry_date DESC LIMIT ${limit}`,
        [spaceId, user.id, ...params],
      );
      for (const row of rows) {
        parts.push({
          id: row.id,
          kind: row.kind === 'story' ? 'story' : 'journal',
          title: row.title || (row.kind === 'story' ? 'story' : 'diary'),
          summary: row.body.replace(/\s+/g, ' ').slice(0, 220),
          date: dateOnly(row.entry_date) ?? '',
          href: `/journal?entry=${encodeURIComponent(row.id)}`,
          fileId: null,
        });
      }
    }
    if (sources.photos) {
      const rows = await this.db.query<{
        id: string;
        name: string;
        kind: 'image' | 'video' | 'audio';
        description: string;
        place: string;
        moment: Date | string;
      }>(
        `SELECT id, name, kind, description, place, COALESCE(taken_at, created_at) AS moment FROM files
         WHERE space_id = $1 AND deleted_at IS NULL AND kind IN ('image','video','audio')
           AND scan_status <> 'blocked' AND (visibility = 'space' OR created_by = $2)
           ${where.media}
         ORDER BY moment DESC LIMIT ${limit}`,
        [spaceId, user.id, ...params],
      );
      for (const row of rows) {
        parts.push({
          id: row.id,
          kind: row.kind === 'image' ? 'photo' : row.kind,
          title: row.description || row.name,
          summary: row.place,
          date: new Date(row.moment).toISOString().slice(0, 10),
          href: `/photos?item=${encodeURIComponent(row.id)}`,
          fileId: row.id,
        });
      }
    }
    if (sources.encyclopedia) {
      const manager =
        sources.encyclopedia.role === 'space_owner' || sources.encyclopedia.role === 'space_admin';
      const rows = await this.db.query<{
        id: string;
        full_name: string;
        birth_date: Date | string;
        birth_place: string;
      }>(
        `SELECT id, full_name, birth_date, birth_place FROM family_people
         WHERE space_id = $1 AND deleted_at IS NULL AND birth_date IS NOT NULL
           AND (${manager ? 'TRUE' : `visibility = 'family' OR created_by = $2`}) AND $2::text IS NOT NULL
           ${where.births}
         ORDER BY birth_date DESC LIMIT ${limit}`,
        [spaceId, user.id, ...params],
      );
      for (const row of rows) {
        parts.push({
          id: row.id,
          kind: 'birth',
          title: row.full_name,
          summary: row.birth_place,
          date: dateOnly(row.birth_date) ?? '',
          href: `/encyclopedia?person=${encodeURIComponent(row.id)}`,
          fileId: null,
        });
      }
    }
    return parts.sort((a, b) => b.date.localeCompare(a.date));
  }

  async timeline(user: AuthenticatedUser, spaceId: string, year?: number): Promise<MemoryYear[]> {
    const sources = await this.sources(user, spaceId);
    const params: unknown[] = [];
    let where = { journal: '', media: '', births: '' };
    if (year) {
      params.push(year);
      where = {
        journal: 'AND EXTRACT(YEAR FROM entry_date) = $3',
        media: 'AND EXTRACT(YEAR FROM COALESCE(taken_at, created_at)) = $3',
        births: 'AND EXTRACT(YEAR FROM birth_date) = $3',
      };
    }
    const items = await this.items(user, spaceId, sources, where, params, year ? 500 : 300);
    const years = new Map<number, MemoryItem[]>();
    for (const item of items) {
      const key = Number(item.date.slice(0, 4));
      if (!key) continue;
      years.set(key, [...(years.get(key) ?? []), item]);
    }
    return [...years.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([value, entries]) => ({
        year: value,
        count: entries.length,
        items: entries.slice(0, 60),
      }));
  }

  async collections(
    user: AuthenticatedUser,
    spaceId: string,
    today: string,
  ): Promise<MemoryCollection[]> {
    const sources = await this.sources(user, spaceId);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : new Date().toISOString().slice(0, 10);
    const monthDay = date.slice(5);
    const year = Number(date.slice(0, 4));
    const onThisDay = await this.items(
      user,
      spaceId,
      sources,
      {
        journal: `AND to_char(entry_date, 'MM-DD') = $3 AND EXTRACT(YEAR FROM entry_date) < $4`,
        media: `AND to_char(COALESCE(taken_at, created_at), 'MM-DD') = $3 AND EXTRACT(YEAR FROM COALESCE(taken_at, created_at)) < $4`,
        births: `AND to_char(birth_date, 'MM-DD') = $3 AND $4::int IS NOT NULL`,
      },
      [monthDay, year],
      60,
    );
    const first = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
    const previous = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() - 1, 1));
    const lastMonth = await this.items(
      user,
      spaceId,
      { ...sources, encyclopedia: null },
      {
        journal: `AND entry_date >= $3::date AND entry_date < $4::date`,
        media: `AND COALESCE(taken_at, created_at) >= $3::date AND COALESCE(taken_at, created_at) < $4::date`,
        births: '',
      },
      [previous.toISOString().slice(0, 10), first.toISOString().slice(0, 10)],
      60,
    );
    const stories = sources.journal
      ? (
          await this.items(
            user,
            spaceId,
            { journal: true, photos: false, encyclopedia: null },
            { journal: `AND kind = 'story' AND visibility = 'family'`, media: '', births: '' },
            [],
            20,
          )
        ).slice(0, 12)
      : [];
    const collections: MemoryCollection[] = [
      {
        id: 'on_this_day',
        kind: 'on_this_day',
        title: 'on_this_day',
        description: monthDay,
        items: onThisDay,
      },
      {
        id: 'last_month',
        kind: 'last_month',
        title: 'last_month',
        description: previous.toISOString().slice(0, 7),
        items: lastMonth,
      },
      { id: 'stories', kind: 'stories', title: 'stories', description: '', items: stories },
    ];
    if (sources.photos) {
      const album = await this.db.queryOne<{ id: string; title: string; description: string }>(
        `SELECT id, title, description FROM photo_albums WHERE space_id = $1 AND deleted_at IS NULL
         ORDER BY updated_at DESC LIMIT 1`,
        [spaceId],
      );
      if (album) {
        const albumItems = await this.items(
          user,
          spaceId,
          { journal: false, photos: true, encyclopedia: null },
          {
            journal: '',
            media: `AND id IN (SELECT file_id FROM photo_album_items WHERE album_id = $3)`,
            births: '',
          },
          [album.id],
          24,
        );
        collections.push({
          id: `album:${album.id}`,
          kind: 'album',
          title: album.title,
          description: album.description,
          items: albumItems,
        });
      }
    }
    return collections.filter(
      (collection) => collection.items.length > 0 || collection.kind === 'on_this_day',
    );
  }
}
