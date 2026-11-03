import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import type { Language, PublicPost } from '@ufos/contracts';
import { Public } from '../common/public.decorator';
import { DatabaseService } from '../db/database.service';
import { toPublicPost, type PublicPostRow } from '../db/rows';

function requestedLanguage(value: unknown): Language {
  return value === 'it' ? 'it' : 'ru';
}

@Public()
@Controller('public')
export class PublicController {
  constructor(private readonly db: DatabaseService) {}

  @Get('posts')
  async posts(@Query('language') language: unknown): Promise<PublicPost[]> {
    const rows = await this.db.query<PublicPostRow>(
      `SELECT p.id, p.slug, p.language, p.title, p.excerpt, p.body,
              p.published_at, s.name AS space_name
       FROM public_posts p JOIN spaces s ON s.id = p.space_id
       WHERE p.language = $1
         AND p.unpublished_at IS NULL
         AND p.published_at <= CURRENT_TIMESTAMP
       ORDER BY p.published_at DESC LIMIT 20`,
      [requestedLanguage(language)],
    );
    return rows.map(toPublicPost);
  }

  @Get('posts/:slug')
  async post(@Param('slug') slug: string): Promise<PublicPost> {
    const row = await this.db.queryOne<PublicPostRow>(
      `SELECT p.id, p.slug, p.language, p.title, p.excerpt, p.body,
              p.published_at, s.name AS space_name
       FROM public_posts p JOIN spaces s ON s.id = p.space_id
       WHERE p.slug = $1
         AND p.unpublished_at IS NULL
         AND p.published_at <= CURRENT_TIMESTAMP`,
      [slug],
    );
    if (!row) throw new NotFoundException('public_post_not_found');
    return toPublicPost(row);
  }
}
