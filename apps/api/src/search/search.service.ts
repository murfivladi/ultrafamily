import { BadRequestException, Injectable } from '@nestjs/common';
import type { ModuleId, SearchModule, SearchResponse, SearchResult } from '@ufos/contracts';
import { AccessService, type AccessContext } from '../access/access.service';
import type { AuthenticatedUser } from '../common/authed-request';
import { escapeLike } from '../common/like';
import { DatabaseService } from '../db/database.service';

export interface SearchFilter {
  q: string;
  spaceId: string | 'all';
  modules?: SearchModule[];
  from?: string;
  to?: string;
  personId?: string;
  limit?: number;
}

const ALL_MODULES: SearchModule[] = [
  'files',
  'photos',
  'documents',
  'journal',
  'encyclopedia',
  'messenger',
  'feed',
  'tasks',
  'calendar',
];

const MODULE_PERMISSION: Record<SearchModule, ModuleId> = {
  files: 'files',
  photos: 'photos',
  documents: 'documents',
  journal: 'journal',
  encyclopedia: 'encyclopedia',
  messenger: 'messenger',
  feed: 'feed',
  tasks: 'tasks',
  calendar: 'calendar',
};

interface Row {
  id: string;
  title: string;
  body: string;
  extra: string;
  tags: string;
  ocr: string;
  people: string;
  place: string;
  visual: string;
  date: Date | string | null;
  person_id: string | null;
  person_name: string | null;
}

/**
 * One search box across modules. Every module query is executed only after
 * `AccessService.assert(...read)` for that exact space, and each query carries
 * the module's own row-level rules (private files, private diaries, chat
 * membership, private calendars, private encyclopedia entries). Encrypted
 * vault content is not part of server-side search by design.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
  ) {}

  async search(user: AuthenticatedUser, filter: SearchFilter): Promise<SearchResponse> {
    const started = Date.now();
    const q = filter.q.trim();
    if (q.length < 2) throw new BadRequestException('search_query_too_short');
    const spaces = await this.access.listSpaces(user.id);
    const targetSpaces =
      filter.spaceId === 'all' ? spaces : spaces.filter((space) => space.id === filter.spaceId);
    if (filter.spaceId !== 'all' && targetSpaces.length === 0) {
      // Not a member: identical to "no results", never a hint the space exists.
      return {
        query: q,
        results: [],
        searchedModules: [],
        skippedModules: [],
        spaces: [],
        tookMs: Date.now() - started,
      };
    }
    const modules = filter.modules?.length ? filter.modules : ALL_MODULES;
    const pattern = `%${escapeLike(q)}%`;
    const results: SearchResult[] = [];
    const searched = new Set<SearchModule>();
    const skipped = new Map<SearchModule, string>();

    for (const space of targetSpaces) {
      for (const module of modules) {
        let context: AccessContext;
        try {
          context = await this.access.assert(user.id, space.id, MODULE_PERMISSION[module], 'read');
        } catch (error) {
          if (!searched.has(module)) {
            skipped.set(module, error instanceof Error ? error.message : 'access_denied');
          }
          continue;
        }
        skipped.delete(module);
        searched.add(module);
        const rows = await this.queryModule(module, user, context, space.id, pattern, filter);
        for (const row of rows) {
          results.push(this.toResult(module, space, row, q));
        }
      }
    }
    results.sort((a, b) => b.score - a.score || (b.date ?? '').localeCompare(a.date ?? ''));
    return {
      query: q,
      results: results.slice(0, filter.limit ?? 100),
      searchedModules: [...searched],
      skippedModules: [...skipped.entries()].map(([module, reason]) => ({ module, reason })),
      spaces: targetSpaces.map((space) => ({ id: space.id, name: space.name })),
      tookMs: Date.now() - started,
    };
  }

  private dateClause(column: string, params: unknown[], filter: SearchFilter): string {
    let clause = '';
    if (filter.from) {
      params.push(filter.from);
      clause += ` AND ${column} >= $${params.length}::timestamptz`;
    }
    if (filter.to) {
      params.push(filter.to);
      clause += ` AND ${column} < ($${params.length}::date + INTERVAL '1 day')`;
    }
    return clause;
  }

  private personClause(columns: string[], params: unknown[], filter: SearchFilter): string {
    if (!filter.personId) return '';
    params.push(filter.personId);
    return ` AND (${columns.map((column) => `${column} = $${params.length}`).join(' OR ')})`;
  }

  private async queryModule(
    module: SearchModule,
    user: AuthenticatedUser,
    context: AccessContext,
    spaceId: string,
    pattern: string,
    filter: SearchFilter,
  ): Promise<Row[]> {
    const params: unknown[] = [spaceId, pattern, user.id];
    const empty = `'' AS extra, '' AS tags, '' AS ocr, '' AS people, '' AS place, '' AS visual`;
    let sql = '';
    switch (module) {
      case 'files':
      case 'photos': {
        const kinds =
          module === 'photos'
            ? `f.kind IN ('image','video','audio')`
            : `f.kind NOT IN ('image','video','audio')`;
        const people = `COALESCE((SELECT string_agg(COALESCE(NULLIF(t.label,''), p.full_name, u2.display_name, ''), ' ')
            FROM media_people_tags t LEFT JOIN family_people p ON p.id = t.person_id
            LEFT JOIN users u2 ON u2.id = t.user_id WHERE t.file_id = f.id), '')`;
        sql = `SELECT f.id, f.name AS title, f.description AS body, '' AS extra, f.tags::text AS tags,
            f.ocr_text AS ocr, ${people} AS people, f.place AS place, f.visual_labels::text AS visual,
            COALESCE(f.taken_at, f.created_at) AS date, f.created_by AS person_id, u.display_name AS person_name
          FROM files f LEFT JOIN users u ON u.id = f.created_by
          WHERE f.space_id = $1 AND f.deleted_at IS NULL AND ${kinds} AND f.scan_status <> 'blocked'
            AND (f.visibility = 'space' OR f.created_by = $3)
            AND (f.name ILIKE $2 OR f.description ILIKE $2 OR f.tags::text ILIKE $2 OR f.ocr_text ILIKE $2
              OR f.place ILIKE $2 OR f.visual_labels::text ILIKE $2 OR ${people} ILIKE $2)
            ${this.dateClause('COALESCE(f.taken_at, f.created_at)', params, filter)}
            ${this.personClause(
              [
                'f.created_by',
                ...(module === 'photos'
                  ? [
                      `(SELECT t.user_id FROM media_people_tags t WHERE t.file_id = f.id AND t.user_id = $${params.length + 1} LIMIT 1)`,
                    ]
                  : []),
              ],
              params,
              filter,
            )}
          ORDER BY date DESC LIMIT 40`;
        break;
      }
      case 'documents':
        sql = `SELECT d.id, d.title, d.content AS body, ${empty}, d.updated_at AS date,
            d.created_by AS person_id, u.display_name AS person_name
          FROM documents d LEFT JOIN users u ON u.id = d.created_by
          WHERE d.space_id = $1 AND d.deleted_at IS NULL AND (d.title ILIKE $2 OR d.content ILIKE $2)
            AND $3::text IS NOT NULL
            ${this.dateClause('d.updated_at', params, filter)}
            ${this.personClause(['d.created_by'], params, filter)}
          ORDER BY d.updated_at DESC LIMIT 40`;
        break;
      case 'journal':
        sql = `SELECT j.id, j.title, j.body, '' AS extra, j.tags::text AS tags, '' AS ocr, '' AS people,
            '' AS place, '' AS visual, j.entry_date AS date, j.author_user_id AS person_id, u.display_name AS person_name
          FROM journal_entries j LEFT JOIN users u ON u.id = j.author_user_id
          WHERE j.space_id = $1 AND j.deleted_at IS NULL
            AND (j.author_user_id = $3 OR j.visibility = 'family')
            AND (j.title ILIKE $2 OR j.body ILIKE $2 OR j.tags::text ILIKE $2)
            ${this.dateClause('j.entry_date', params, filter)}
            ${this.personClause(['j.author_user_id'], params, filter)}
          ORDER BY j.entry_date DESC LIMIT 40`;
        break;
      case 'encyclopedia': {
        const manager = context.role === 'space_owner' || context.role === 'space_admin';
        sql = `SELECT p.id, p.full_name AS title, p.biography AS body, p.birth_name AS extra, '' AS tags,
            '' AS ocr, '' AS people, p.birth_place AS place, '' AS visual, p.birth_date AS date,
            p.linked_user_id AS person_id, NULL AS person_name
          FROM family_people p
          WHERE p.space_id = $1 AND p.deleted_at IS NULL
            AND (${manager ? '$3::text IS NOT NULL' : `p.visibility = 'family' OR p.created_by = $3`})
            AND (p.full_name ILIKE $2 OR p.birth_name ILIKE $2 OR p.biography ILIKE $2 OR p.birth_place ILIKE $2)
            ${this.dateClause('p.birth_date', params, filter)}
            ${this.personClause(['p.linked_user_id', 'p.created_by'], params, filter)}
          ORDER BY p.full_name LIMIT 40`;
        break;
      }
      case 'messenger':
        sql = `SELECT m.id, COALESCE(NULLIF(c.name,''), 'chat') AS title, m.body, c.id AS extra, '' AS tags,
            '' AS ocr, '' AS people, '' AS place, '' AS visual, m.created_at AS date,
            m.author_user_id AS person_id, u.display_name AS person_name
          FROM chat_messages m JOIN chats c ON c.id = m.chat_id
          LEFT JOIN users u ON u.id = m.author_user_id
          WHERE c.space_id = $1 AND m.deleted_at IS NULL AND m.body ILIKE $2
            AND (c.visibility = 'space'
              OR EXISTS (SELECT 1 FROM chat_members cm WHERE cm.chat_id = c.id AND cm.user_id = $3))
            ${this.dateClause('m.created_at', params, filter)}
            ${this.personClause(['m.author_user_id'], params, filter)}
          ORDER BY m.created_at DESC LIMIT 40`;
        break;
      case 'feed':
        sql = `SELECT p.id, p.title, p.body, ${empty}, p.published_at AS date,
            p.author_user_id AS person_id, u.display_name AS person_name
          FROM feed_posts p LEFT JOIN users u ON u.id = p.author_user_id
          WHERE p.space_id = $1 AND p.deleted_at IS NULL AND (p.title ILIKE $2 OR p.body ILIKE $2)
            AND $3::text IS NOT NULL
            ${this.dateClause('p.published_at', params, filter)}
            ${this.personClause(['p.author_user_id'], params, filter)}
          ORDER BY p.published_at DESC LIMIT 40`;
        break;
      case 'tasks':
        sql = `SELECT t.id, t.title, t.description AS body, ${empty}, COALESCE(t.due_at, t.created_at) AS date,
            t.assignee_user_id AS person_id, u.display_name AS person_name
          FROM tasks t LEFT JOIN users u ON u.id = t.assignee_user_id
          WHERE t.space_id = $1 AND (t.title ILIKE $2 OR t.description ILIKE $2) AND $3::text IS NOT NULL
            ${this.dateClause('COALESCE(t.due_at, t.created_at)', params, filter)}
            ${this.personClause(['t.assignee_user_id', 't.created_by'], params, filter)}
          ORDER BY date DESC LIMIT 40`;
        break;
      case 'calendar':
        sql = `SELECT e.id, e.title, e.description AS body, '' AS extra, '' AS tags, '' AS ocr, '' AS people,
            e.location AS place, '' AS visual, e.starts_at AS date, e.created_by AS person_id,
            u.display_name AS person_name
          FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id
          LEFT JOIN users u ON u.id = e.created_by
          WHERE e.space_id = $1 AND (c.visibility <> 'private' OR c.owner_user_id = $3)
            AND (e.title ILIKE $2 OR e.description ILIKE $2 OR e.location ILIKE $2)
            ${this.dateClause('e.starts_at', params, filter)}
            ${this.personClause(['e.created_by'], params, filter)}
          ORDER BY e.starts_at DESC LIMIT 40`;
        break;
    }
    return this.db.query<Row>(sql, params);
  }

  private toResult(
    module: SearchModule,
    space: { id: string; name: string },
    row: Row,
    q: string,
  ): SearchResult {
    const needle = q.toLowerCase();
    const has = (value: string | null | undefined) => (value ?? '').toLowerCase().includes(needle);
    const matchedIn: SearchResult['matchedIn'] = [];
    if (has(row.title) || has(row.extra)) matchedIn.push('title');
    if (has(row.body)) matchedIn.push('content');
    if (has(row.tags)) matchedIn.push('tags');
    if (has(row.ocr)) matchedIn.push('ocr');
    if (has(row.visual)) matchedIn.push('visual');
    if (has(row.people)) matchedIn.push('people');
    if (has(row.place)) matchedIn.push('place');
    const source =
      [row.body, row.ocr, row.people, row.place].find((value) => has(value)) ?? row.body ?? '';
    const score =
      (matchedIn.includes('title') ? 5 : 0) +
      (matchedIn.includes('tags') || matchedIn.includes('people') ? 3 : 0) +
      (matchedIn.includes('content') || matchedIn.includes('ocr') ? 2 : 0) +
      (matchedIn.includes('place') || matchedIn.includes('visual') ? 1 : 0);
    const hrefs: Record<SearchModule, string> = {
      files: `/files?file=${encodeURIComponent(row.id)}`,
      photos: `/photos?item=${encodeURIComponent(row.id)}`,
      documents: `/documents?id=${encodeURIComponent(row.id)}`,
      journal: `/journal?entry=${encodeURIComponent(row.id)}`,
      encyclopedia: `/encyclopedia?person=${encodeURIComponent(row.id)}`,
      messenger: `/messages?chat=${encodeURIComponent(row.extra)}`,
      feed: `/feed?post=${encodeURIComponent(row.id)}`,
      tasks: `/tasks?task=${encodeURIComponent(row.id)}`,
      calendar: `/calendar?event=${encodeURIComponent(row.id)}`,
    };
    return {
      id: row.id,
      module,
      spaceId: space.id,
      spaceName: space.name,
      title: row.title || '—',
      snippet: snippet(source, q),
      matchedIn,
      date: row.date ? new Date(row.date).toISOString() : null,
      personId: row.person_id,
      personName: row.person_name,
      href: hrefs[module],
      score,
    };
  }
}

export function snippet(text: string, q: string, radius = 80): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const index = clean.toLowerCase().indexOf(q.toLowerCase());
  if (index < 0) return clean.slice(0, radius * 2) + (clean.length > radius * 2 ? '…' : '');
  const start = Math.max(0, index - radius);
  const end = Math.min(clean.length, index + q.length + radius);
  return `${start > 0 ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`;
}
