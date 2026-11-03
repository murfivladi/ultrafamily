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

`MODULES` содержит 40 модулей ТЗ. Каждый имеет:

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
