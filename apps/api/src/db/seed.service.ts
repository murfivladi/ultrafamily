import { Injectable, OnModuleInit } from '@nestjs/common';
import { MODULE_IDS, STAGE_A_MODULE_IDS } from '@ufos/contracts';
import { config, newId, sha256 } from '../config';
import { PasswordService } from '../common/password.service';
import { DatabaseService } from './database.service';

const DEMO_INVITE_TOKEN = 'WELCOME-UFOS-2026';

@Injectable()
export class SeedService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly passwords: PasswordService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.db.ensureReady();
    const existing = await this.db.queryOne<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM users',
    );
    if (Number(existing?.count ?? 0) > 0) return;

    // Production bootstrap creates only the operator-controlled owner.
    // Demonstration accounts and public posts are never seeded in production.
    const fullDemo = !config.isProduction && process.env.SEED_DEMO_DATA !== 'false';
    this.passwords.assertStrength(config.bootstrapOwnerPassword);
    const passwordHash = await this.passwords.hash(config.bootstrapOwnerPassword);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const enabled = new Set<string>(STAGE_A_MODULE_IDS);

    const ownerId = newId('usr');
    const adultId = newId('usr');
    const childId = newId('usr');
    const guestId = newId('usr');
    const adminId = newId('usr');
    const networkId = newId('net');
    const householdId = newId('spc');
    const personalId = newId('spc');
    const secondHouseholdId = newId('spc');
    const secondPersonalId = newId('spc');

    await this.db.transaction(async (tx) => {
      // Users must exist before any membership foreign keys are inserted.
      await tx.query(
        `INSERT INTO users
          (id, email, display_name, password_hash, avatar_color, language,
           platform_role, email_verified_at, is_child, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'#5B7CFA','ru','platform_owner',$5,FALSE,$5,$5)`,
        [ownerId, config.bootstrapOwnerEmail, 'Владелец платформы', passwordHash, now],
      );
      await tx.query(
        `INSERT INTO user_preferences (user_id, active_space_id, theme, color_mode, updated_at)
         VALUES ($1,$2,'family','light',$3)`,
        [ownerId, householdId, now],
      );

      if (fullDemo) {
        const demoUsers = [
          [
            adultId,
            'adult@ultra.family',
            'Взрослый участник',
            '#14B8A6',
            null,
            false,
            secondHouseholdId,
          ],
          [childId, 'child@ultra.family', 'Детский профиль', '#F59E0B', null, true, householdId],
          [guestId, 'guest@ultra.family', 'Гость семьи', '#94A3B8', null, false, householdId],
          [
            adminId,
            'admin@ultra.family',
            'Администратор сервера',
            '#8B5CF6',
            'platform_admin',
            false,
            null,
          ],
        ] as const;
        for (const [id, email, name, color, platformRole, isChild, activeSpace] of demoUsers) {
          await tx.query(
            `INSERT INTO users
              (id, email, display_name, password_hash, avatar_color, language,
               platform_role, email_verified_at, is_child, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,'ru',$6,$7,$8,$7,$7)`,
            [id, email, name, passwordHash, color, platformRole, now, isChild],
          );
          await tx.query(
            `INSERT INTO user_preferences
              (user_id, active_space_id, theme, color_mode, simplified_ui, updated_at)
             VALUES ($1,$2,'family','light',$3,$4)`,
            [id, activeSpace, isChild, now],
          );
        }
      }

      const spaces: Array<readonly [string, string, string, string | null, string | null, string]> =
        [
          [networkId, 'Семейная сеть', 'family_network', null, null, ownerId],
          [householdId, 'Дом Палермо', 'household', networkId, null, ownerId],
          [
            personalId,
            'Личное пространство владельца',
            'personal',
            networkId,
            householdId,
            ownerId,
          ],
        ];
      if (fullDemo) {
        spaces.push(
          [secondHouseholdId, 'Дом Катании', 'household', networkId, null, adultId],
          [
            secondPersonalId,
            'Личное пространство взрослого',
            'personal',
            networkId,
            secondHouseholdId,
            adultId,
          ],
        );
      }
      for (const [id, name, kind, network, parent, owner] of spaces) {
        await tx.query(
          `INSERT INTO spaces
            (id, name, kind, network_id, parent_space_id, owner_user_id, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, name, kind, network, parent, owner, now],
        );
      }

      const memberships: Array<readonly [string, string, string]> = [
        [networkId, ownerId, 'space_owner'],
        [householdId, ownerId, 'space_owner'],
        [personalId, ownerId, 'space_owner'],
      ];
      if (fullDemo) {
        memberships.push(
          [householdId, childId, 'child'],
          [householdId, guestId, 'guest'],
          [secondHouseholdId, adultId, 'space_owner'],
          [secondPersonalId, adultId, 'space_owner'],
        );
      }
      for (const [spaceId, userId, role] of memberships) {
        await tx.query(
          `INSERT INTO memberships
            (space_id, user_id, role, overrides, sensitive_grants, joined_at)
           VALUES ($1,$2,$3,'{}'::jsonb,'[]'::jsonb,$4)`,
          [spaceId, userId, role, now],
        );
      }

      const toggleSpaces = fullDemo
        ? [householdId, secondHouseholdId, personalId, secondPersonalId]
        : [householdId, personalId];
      for (const space of toggleSpaces) {
        for (const moduleId of MODULE_IDS) {
          await tx.query(
            `INSERT INTO module_toggles (space_id, module_id, enabled, updated_at)
             VALUES ($1,$2,$3,$4)`,
            [space, moduleId, enabled.has(moduleId), now],
          );
        }
      }

      if (!fullDemo) return;

      await tx.query(
        `INSERT INTO invitations
          (id, space_id, email, role, token_hash, created_by, expires_at, max_uses, created_at)
         VALUES ($1,$2,NULL,'adult',$3,$4,$5,10,$6)`,
        [newId('inv'), householdId, sha256(DEMO_INVITE_TOKEN), ownerId, expiresAt, now],
      );

      const publicPosts = [
        [
          newId('pub'),
          householdId,
          'welcome-ru',
          'ru',
          'Добро пожаловать в семейное пространство',
          'Только явно опубликованные материалы видны на публичном сайте.',
          'Это демонстрационная публикация. Личные записи, документы, фотографии и данные участников не попадают в публичную ленту или метаданные.',
          ownerId,
        ],
        [
          newId('pub'),
          householdId,
          'welcome-it',
          'it',
          'Benvenuti nello spazio di famiglia',
          'Solo i contenuti pubblicati esplicitamente sono visibili sul sito pubblico.',
          'Questo è un contenuto dimostrativo. Note private, documenti, foto e dati dei membri non compaiono nel feed pubblico o nei metadati.',
          ownerId,
        ],
      ] as const;
      for (const [id, spaceId, slug, language, title, excerpt, body, createdBy] of publicPosts) {
        await tx.query(
          `INSERT INTO public_posts
            (id, space_id, slug, language, title, excerpt, body, published_at, created_by, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8)`,
          [id, spaceId, slug, language, title, excerpt, body, now, createdBy],
        );
      }
    });
  }
}
