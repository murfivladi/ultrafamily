# Модель данных и прав

SQL-схема: [`apps/api/src/db/sql/001_init.sql`](../apps/api/src/db/sql/001_init.sql). Идентификаторы — текстовые UUID, генерируемые приложением, чтобы одна схема работала и в PostgreSQL, и в PGlite.

## Основные таблицы

| Таблица               | Назначение                                                                             |
| --------------------- | -------------------------------------------------------------------------------------- |
| `users`               | Аккаунт, email, `scrypt`-хеш, язык, платформенная роль, флаг ребёнка, блокировка входа |
| `user_preferences`    | Активное пространство, тема, режимы доступности, виджеты, избранное, быстрые действия  |
| `spaces`              | Семейная сеть, домохозяйство, личное пространство                                      |
| `memberships`         | Связь пользователь↔пространство, роль, точечные overrides, sensitive grants            |
| `invitations`         | Только хеш приглашения, срок, роль, счётчик использований                              |
| `sessions`            | Только хеш session token, сроки, UA, HMAC-префикс IP, revoke                           |
| `email_tokens`        | Только хеш токена подтверждения email/сброса пароля                                    |
| `backup_codes`        | Заготовка для 2FA; flow ещё не включён                                                 |
| `passkey_credentials` | Заготовка для WebAuthn; flow ещё не включён                                            |
| `module_toggles`      | Включение модуля для конкретного пространства                                          |
| `audit_events`        | Каноническое событие, metadata, previous hash и chain hash                             |
| `audit_control`       | Singleton с последним хешем цепочки                                                    |
| `public_posts`        | Явно опубликованные материалы; `unpublished_at` снимает публикацию                     |
| `schema_migrations`   | applied migration versions                                                             |

Пароли, session tokens, invite tokens и email tokens **никогда не хранятся в открытом виде** и не попадают в аудит/логи.

## Роли

Платформенные:

- `platform_owner`
- `platform_admin`

Пространственные:

- `space_owner`
- `space_admin`
- `adult`
- `child`
- `guest`

Платформенные роли нужны для `/api/admin`, но не дают доступа к `memberships`-данных домохозяйств без явного membership.

## Действия

`read`, `create`, `update`, `delete`, `publish`, `export`, `manage_access`.

Эффективное разрешение вычисляется в порядке:

1. Явный `deny` override.
2. Выключенный модуль.
3. Платформенная роль без membership.
4. Явный `allow` override, если не нарушает гостевые/детские/чувствительные ограничения.
5. Гость: только `read` и только при `explicitlyShared`.
6. Ребёнок: запрещены restricted modules и опасные действия.
7. Чувствительный модуль: нужен `sensitiveGrants`, кроме владельца пространства.
8. Базовая матрица роли.

Правила реализованы в [`packages/contracts/src/permissions.ts`](../packages/contracts/src/permissions.ts) и покрыты unit-тестами. Сервер не доверяет frontend-списку permissions: `AuthSnapshot.permissions` нужен только для UI.

## Модули

`MODULES` содержит 41 модуль ТЗ. Каждый имеет:

- `stage` A–H;
- `status`: `foundation` для готовых модулей Этапа A, `planned` для остальных;
- `sensitive`;
- `childRestricted`;
- `group` и `icon`.

В базе для каждого пространства создаётся строка `module_toggles`. По умолчанию включены только модули основы. Каталог показывает запланированные модули, но не открывает их как готовую функциональность.

## Публикация и поиск

Публичный endpoint выбирает только:

```text
id, slug, language, title, excerpt, body, published_at, space_name
```

Он не возвращает `spaceId`, `createdBy`, пользователей, membership, пути файлов или audit metadata. Sitemap/RSS отсутствуют; приватные маршруты запрещены в `robots.txt`.

## Аудит

`canonical_payload` — стабильная JSON-строка с id, временем, актором, пространством, действием, entity и очищенными metadata. `chain_hash = SHA256(previous_hash | "|" | canonical_payload)`. Проверка сравнивает последовательность и значение `audit_control.last_hash`.

Журнал доступен только платформенной роли. API не имеет update/delete endpoints для событий. Для production дополнительно нужны DB grants/WORM и вынос логов за пределы VPS.

## Stage B: организационные таблицы

Миграции `002_stage_b.sql`, `003_stage_b_compat.sql` и `004_stage_b_activation.sql` аддитивно расширяют базу; вторая включает организационные модули и пустые контейнеры для уже существующих Stage A пространств. Все новые записи содержат `space_id` и проверяются через `AccessService`; кросс-пространственные выборки запрещены.

- Календарь: `calendars`, `calendar_events`, `calendar_event_participants`, `calendar_event_exceptions`, `calendar_event_links`, `calendar_event_history`, `calendar_sync_state`, `calendar_sync_conflicts`, `calendar_tokens`.
- Задачи: `task_lists`, `tasks`, `task_dependencies`, `task_comments`, `task_attachments`, `task_links`, `task_history`, `task_templates`.
- Уведомления: `notification_preferences`, `notifications`, `notification_deliveries`, `web_push_subscriptions`, `webhook_endpoints`.
- Покупки: `shopping_lists`, `shopping_items`, `shopping_presence`, `purchase_history`, `shopping_suggestions`.
- Публикации и realtime: `public_post_versions`, `realtime_events`.
- `user_preferences.feed_sources`; `public_posts.status`, `visibility`, `audience_space_ids`, `guest_shared`, `updated_at`, `published_by`, `unpublished_at`.

Версионирование: `calendar_events.version`/`etag`, `tasks.version`, `shopping_lists.version`. `schema_migrations` хранит каждую применённую SQL-миграцию по имени файла. Пароли, CalDAV/webhook-секреты и сессионные токены в открытом виде не хранятся.

## Stage C: общение и совместная работа

Аддитивная миграция `005_stage_c.sql`, 29 таблиц, повторный запуск идемпотентен.

- Messenger: `chats`, `chat_members`, `chat_messages`, `chat_message_versions`, `chat_reactions`, `chat_attachments`, `chat_receipts`, `chat_moderation_log`.
- Лента и решения: `feed_posts`, `feed_comments`, `feed_reactions`, `space_governance`, `polls`, `poll_votes`, `proposals`, `proposal_votes`, `decision_history`, `wishlists`, `wishlist_items`.
- Документы: `documents`, `document_versions`, `document_collaborators`, `document_comments`, `document_presence`.
- WebRTC: `call_rooms`, `call_participants`, `call_signals`, `call_events`.
- Realtime: `collaboration_presence`.

Сообщения, голоса и реакции несут клиентские ключи идемпотентности; удаление сообщения оставляет версии для политики хранения; `decision_history` хранит итог, кворум и метаданные ничьей; `documents.content` — источник для гидрирования Yjs-комнаты, `document_versions` — снимки для восстановления.

## Stage D: файлы и память семьи

Миграция `006_stage_d.sql` (аддитивная, 21 таблица) и активация модулей `files`, `photos`, `search`, `journal`, `memories`, `encyclopedia` там, где владелец не менял переключатели.

- Хранилище: `space_storage_settings` (квоты, срок корзины), `file_folders`, `files` (тип по содержимому, `visibility space|private`, `scan_status`, `ocr_status/ocr_text`, метаданные, теги, место, дата съёмки, `trash_batch`), `file_versions` (каждая версия — отдельный ключ хранилища), `file_upload_sessions`, `file_activity`, `webdav_tokens` (хеш токена).
- Очередь: `media_jobs` (scan/metadata/ocr/video/faces, попытки, backoff).
- Галерея: `photo_albums`, `photo_album_items`, `media_comments`, `media_reactions`, `media_favorites`, `media_people_tags`, `share_links` (хеш токена, scrypt-пароль, срок, отзыв, счётчик), `face_recognition_settings`, `face_embeddings`.
- Энциклопедия: `family_people`, `family_relations` (parent направленная; spouse/sibling хранятся один раз), `family_person_links`.
- Дневники: `journal_entries` (`private|family`, `diary|story`, вложения, события, люди).

Бинарное содержимое хранится вне PostgreSQL в `STORAGE_DIR` по ключам `<spaceId>/<fileId>/v<N>-<random>`; имена файлов пользователей в путях не используются.
