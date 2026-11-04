import { Injectable, OnModuleInit } from '@nestjs/common';
import { FOUNDATION_MODULE_IDS, MODULE_IDS } from '@ufos/contracts';
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

    // Production bootstrap creates only the operator-controlled owner, empty
    // default organizational containers, and no demonstration content.
    const fullDemo = !config.isProduction && process.env.SEED_DEMO_DATA !== 'false';
    this.passwords.assertStrength(config.bootstrapOwnerPassword);
    const passwordHash = await this.passwords.hash(config.bootstrapOwnerPassword);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const enabled = new Set<string>(FOUNDATION_MODULE_IDS);

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
      // Users must exist before any membership or content foreign keys.
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

      const userIds = [ownerId];
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
          userIds.push(id);
        }
      }

      for (const userId of userIds) {
        await tx.query(
          'INSERT INTO notification_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
          [userId],
        );
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
        ? [networkId, householdId, personalId, secondHouseholdId, secondPersonalId]
        : [networkId, householdId, personalId];
      for (const space of toggleSpaces) {
        for (const moduleId of MODULE_IDS) {
          await tx.query(
            `INSERT INTO module_toggles (space_id, module_id, enabled, updated_at)
             VALUES ($1,$2,$3,$4)`,
            [space, moduleId, enabled.has(moduleId), now],
          );
        }
      }

      // Empty Stage B containers are part of a usable workspace, not demo data.
      const calendarIds = new Map<string, string>();
      const taskListIds = new Map<string, string>();
      const shoppingListIds = new Map<string, string>();
      for (const space of toggleSpaces) {
        const calendarId = newId('cal');
        const taskListId = newId('lst');
        const shoppingListId = newId('shl');
        calendarIds.set(space, calendarId);
        taskListIds.set(space, taskListId);
        shoppingListIds.set(space, shoppingListId);
        await tx.query(
          `INSERT INTO calendars
            (id, space_id, owner_user_id, name, kind, color, visibility, ctag)
           VALUES ($1,$2,$3,'Календарь','family','#5B7CFA','household','1')`,
          [calendarId, space, ownerId],
        );
        await tx.query(
          `INSERT INTO calendar_sync_state (calendar_id, sync_token, ctag)
           VALUES ($1,$2,'1')`,
          [calendarId, newId('sync')],
        );
        await tx.query(
          `INSERT INTO task_lists (id, space_id, name, kind, color, created_by)
           VALUES ($1,$2,'Общее','list','#14B8A6',$3)`,
          [taskListId, space, ownerId],
        );
        await tx.query(
          `INSERT INTO shopping_lists (id, space_id, name, kind, status, version, created_by)
           VALUES ($1,$2,'Покупки','grocery','active',1,$3)`,
          [shoppingListId, space, ownerId],
        );
      }

      if (!fullDemo) return;

      await tx.query(
        `INSERT INTO invitations
          (id, space_id, email, role, token_hash, created_by, expires_at, max_uses, created_at)
         VALUES ($1,$2,NULL,'adult',$3,$4,$5,10,$6)`,
        [newId('inv'), householdId, sha256(DEMO_INVITE_TOKEN), ownerId, expiresAt, now],
      );

      const homeCalendarId = calendarIds.get(householdId)!;
      const otherCalendarId = calendarIds.get(secondHouseholdId)!;
      const homeEventId = newId('evt');
      const menuEventId = newId('evt');
      const otherEventId = newId('evt');
      const tomorrow = new Date(Date.now() + 24 * 3_600_000).toISOString();
      const tomorrowEnd = new Date(Date.now() + 25 * 3_600_000).toISOString();
      const inThreeDays = new Date(Date.now() + 72 * 3_600_000).toISOString();
      const inThreeDaysEnd = new Date(Date.now() + 73 * 3_600_000).toISOString();
      await tx.query(
        `INSERT INTO calendar_events
          (id, calendar_id, space_id, uid, title, description, location, starts_at, ends_at,
           all_day, timezone, category, color, recurrence_rule, status, created_by, etag, version, source)
         VALUES
          ($1,$2,$3,$4,'Семейный ужин','Общее событие демонстрационного домохозяйства','Дом',
           $5,$6,FALSE,'Europe/Rome','family','#5B7CFA',NULL,'confirmed',$7,$8,1,'seed'),
          ($9,$2,$3,$10,'Меню на неделю','Связано со списком покупок','Кухня',
           $11,$12,FALSE,'Europe/Rome','menu','#14B8A6','FREQ=WEEKLY;COUNT=4','confirmed',$7,$13,1,'seed')`,
        [
          homeEventId,
          homeCalendarId,
          householdId,
          `${homeEventId}@ultra.family`,
          tomorrow,
          tomorrowEnd,
          ownerId,
          sha256(`${homeEventId}:1`),
          menuEventId,
          `${menuEventId}@ultra.family`,
          inThreeDays,
          inThreeDaysEnd,
          sha256(`${menuEventId}:1`),
        ],
      );
      await tx.query(
        `INSERT INTO calendar_events
          (id, calendar_id, space_id, uid, title, description, location, starts_at, ends_at,
           all_day, timezone, category, color, recurrence_rule, status, created_by, etag, version, source)
         VALUES ($1,$2,$3,$4,'Собрание второго дома','Изолированное событие второго пространства','Катания',
                 $5,$6,FALSE,'Europe/Rome','family','#8B5CF6',NULL,'confirmed',$7,$8,1,'seed')`,
        [
          otherEventId,
          otherCalendarId,
          secondHouseholdId,
          `${otherEventId}@ultra.family`,
          tomorrow,
          tomorrowEnd,
          adultId,
          sha256(`${otherEventId}:1`),
        ],
      );
      await tx.query(
        `INSERT INTO calendar_event_participants (event_id, user_id, rsvp) VALUES
          ($1,$2,'accepted'), ($1,$3,'pending'), ($4,$5,'accepted')`,
        [homeEventId, ownerId, childId, otherEventId, adultId],
      );
      await tx.query(
        `INSERT INTO calendar_event_links (id, event_id, target_module, target_id)
         VALUES ($1,$2,'menu',$3)`,
        [newId('lnk'), menuEventId, shoppingListIds.get(householdId)!],
      );

      const homeTaskListId = taskListIds.get(householdId)!;
      const otherTaskListId = taskListIds.get(secondHouseholdId)!;
      const homeTaskId = newId('tsk');
      const childTaskId = newId('tsk');
      const otherTaskId = newId('tsk');
      await tx.query(
        `INSERT INTO tasks
          (id, list_id, space_id, parent_task_id, title, description, status, priority,
           category, assignee_user_id, due_at, estimate_minutes, complexity, recurrence_rule,
           position, created_by, version)
         VALUES
          ($1,$2,$3,NULL,'Подготовить семейный ужин','Демонстрационная задача первого пространства','todo','high',
           'home',$4,$5,60,3,NULL,1,$4,1),
          ($6,$2,$3,NULL,'Полить растения','Задача с упрощённым интерфейсом для детского профиля','todo','normal',
           'home',$7,$8,15,1,'FREQ=WEEKLY;COUNT=4',2,$4,1)`,
        [
          homeTaskId,
          homeTaskListId,
          householdId,
          ownerId,
          tomorrow,
          childTaskId,
          childId,
          inThreeDays,
        ],
      );
      await tx.query(
        `INSERT INTO tasks
          (id, list_id, space_id, parent_task_id, title, description, status, priority,
           category, assignee_user_id, due_at, estimate_minutes, complexity, recurrence_rule,
           position, created_by, version)
         VALUES ($1,$2,$3,NULL,'Купить продукты в Катании','Изолированная задача второго пространства','todo','normal',
                 'shopping',$4,$5,30,2,NULL,1,$4,1)`,
        [otherTaskId, otherTaskListId, secondHouseholdId, adultId, tomorrow],
      );
      await tx.query(
        `INSERT INTO task_templates (id, space_id, name, fields, created_by)
         VALUES ($1,$2,'Еженедельная уборка',$3,$4)`,
        [
          newId('tpl'),
          householdId,
          JSON.stringify({
            title: 'Еженедельная уборка',
            category: 'home',
            estimateMinutes: 45,
            complexity: 2,
            recurrenceRule: 'FREQ=WEEKLY;COUNT=4',
          }),
          ownerId,
        ],
      );

      const ownerNotificationId = newId('ntf');
      const adultNotificationId = newId('ntf');
      await tx.query(
        `INSERT INTO notifications
          (id, user_id, space_id, category, severity, title, body, source_module,
           source_id, action_url, dedupe_key, grouped_count, created_at)
         VALUES
          ($1,$2,$3,'calendar','info','Скоро семейный ужин','Событие начинается завтра.','calendar',$4,'/calendar','seed:owner:event',1,$5),
          ($6,$7,$8,'tasks','important','Срок задачи в Катании','Задача второго пространства требует внимания.','tasks',$9,'/tasks','seed:adult:task',1,$5)`,
        [
          ownerNotificationId,
          ownerId,
          householdId,
          homeEventId,
          now,
          adultNotificationId,
          adultId,
          secondHouseholdId,
          otherTaskId,
        ],
      );
      await tx.query(
        `INSERT INTO notification_deliveries
          (id, notification_id, channel, status, delivered_at, created_at)
         VALUES ($1,$2,'in_app','delivered',$3,$3), ($4,$5,'in_app','delivered',$3,$3)`,
        [newId('dlv'), ownerNotificationId, now, newId('dlv'), adultNotificationId],
      );

      const homeShoppingListId = shoppingListIds.get(householdId)!;
      const otherShoppingListId = shoppingListIds.get(secondHouseholdId)!;
      const homeItemId = newId('shi');
      await tx.query(
        `INSERT INTO shopping_items
          (id, list_id, space_id, name, quantity, unit, category, checked,
           assigned_user_id, source_module, source_id, notes, position, created_by)
         VALUES
          ($1,$2,$3,'Молоко',1,'l','dairy',FALSE,NULL,NULL,NULL,'',1,$4),
          ($5,$2,$3,'Хлеб',2,'pcs','bakery',FALSE,NULL,NULL,NULL,'',2,$4),
          ($6,$7,$8,'Оливковое масло',1,'bottle','pantry',FALSE,NULL,NULL,NULL,'Изолированный список',1,$9)`,
        [
          homeItemId,
          homeShoppingListId,
          householdId,
          ownerId,
          newId('shi'),
          newId('shi'),
          otherShoppingListId,
          secondHouseholdId,
          adultId,
        ],
      );
      for (let index = 0; index < 3; index += 1) {
        await tx.query(
          `INSERT INTO purchase_history
            (id, space_id, list_id, item_name, quantity, unit, category, purchased_by, purchased_at)
           VALUES ($1,$2,$3,'Молоко',1,'l','dairy',$4,$5)`,
          [newId('pur'), householdId, homeShoppingListId, ownerId, now],
        );
      }
      await tx.query(
        `INSERT INTO shopping_presence (list_id, user_id, status, last_seen_at)
         VALUES ($1,$2,'viewing',$3)`,
        [homeShoppingListId, ownerId, now],
      );

      const publicPosts = [
        {
          slug: 'welcome-ru',
          language: 'ru',
          title: 'Добро пожаловать в семейное пространство',
          excerpt: 'Только явно опубликованные материалы видны на публичном сайте.',
          body: 'Это демонстрационная публикация. Личные записи, документы, фотографии и данные участников не попадают в публичную ленту или метаданные.',
          status: 'published',
          visibility: 'public',
          audience: [] as string[],
          guestShared: false,
        },
        {
          slug: 'welcome-it',
          language: 'it',
          title: 'Benvenuti nello spazio di famiglia',
          excerpt: 'Solo i contenuti pubblicati esplicitamente sono visibili sul sito pubblico.',
          body: 'Questo è un contenuto dimostrativo. Note private, documenti, foto e dati dei membri non compaiono nel feed pubblico o nei metadati.',
          status: 'published',
          visibility: 'public',
          audience: [] as string[],
          guestShared: false,
        },
        {
          slug: 'guest-note-ru',
          language: 'ru',
          title: 'Материал для приглашённого гостя',
          excerpt: 'Явно отмечен как доступный гостю только для чтения.',
          body: 'Этот материал не виден на публичном сайте. Он доступен гостю с явной пометкой в пределах выбранного пространства.',
          status: 'published',
          visibility: 'household',
          audience: [householdId],
          guestShared: true,
        },
        {
          slug: 'draft-ru',
          language: 'ru',
          title: 'Черновик: семейная новость',
          excerpt: 'Черновик не виден публично до явной публикации.',
          body: 'Проверьте предварительный просмотр, язык, видимость и аудиторию, затем опубликуйте материал вручную.',
          status: 'draft',
          visibility: 'household',
          audience: [householdId],
          guestShared: false,
        },
      ];
      for (const post of publicPosts) {
        const id = newId('pub');
        await tx.query(
          `INSERT INTO public_posts
            (id, space_id, slug, language, title, excerpt, body, status, visibility,
             audience_space_ids, guest_shared, published_at, updated_at,
             published_by, created_by, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$13,$12)`,
          [
            id,
            householdId,
            post.slug,
            post.language,
            post.title,
            post.excerpt,
            post.body,
            post.status,
            post.visibility,
            JSON.stringify(post.audience),
            post.guestShared,
            now,
            ownerId,
          ],
        );
        await tx.query(
          `INSERT INTO public_post_versions
            (id, post_id, version, title, excerpt, body, changed_by, created_at)
           VALUES ($1,$2,1,$3,$4,$5,$6,$7)`,
          [newId('ppv'), id, post.title, post.excerpt, post.body, ownerId, now],
        );
      }
    });
  }
}
