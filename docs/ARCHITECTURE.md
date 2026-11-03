# Архитектура

## Форма

Stage A — **модульный монолит** с отдельным frontend-процессом и отдельным API-процессом. Realtime, медиа-workers, office editor и WebRTC не запускаются до соответствующих этапов. Это соответствует ограничению VPS 1–2 CPU / 2–4 GB RAM.

```text
Browser
  └── Next.js (0.0.0.0:3000)
        ├── public pages
        ├── authenticated SPA-like pages
        └── /api/* rewrite ──> NestJS (0.0.0.0:3001)
                                  ├── global AuthGuard + CSRF
                                  ├── AccessService
                                  ├── module services
                                  ├── AuditService (hash chain)
                                  └── DatabaseService
                                         ├── pg Pool ──> PostgreSQL 16 (production)
                                         └── PGlite ───> local preview / Jest
```

В браузере нет абсолютных URL another service: все вызовы идут на относительный `/api/*`. Next.js сервер-side проксирует путь через `API_PROXY_ORIGIN`. Это необходимо для Arena/e2b preview, Cloudflare и предотвращения смешанного CORS-контента.

## Слои API

1. **CommonModule** — `AppLogger`, `PasswordService`, глобальный exception filter. Логи рекурсивно редактируют ключи `password`, `token`, `secret`, `cookie`, `authorization`, `apiKey`, `credential`, `backup`, `privateKey`.
2. **DbModule** — единый SQL-интерфейс `query`, `queryOne`, `transaction`, миграция и bootstrap seed. `pg` и PGlite скрыты за адаптером.
3. **AuditModule** — добавление событий в транзакции с блокировкой строки `audit_control` и вычислением `chainHash = SHA256(previousHash | canonicalPayload)`.
4. **AccessModule** — `assert(userId, spaceId, moduleId, action)` загружает пользователя, membership, module toggle и вызывает общую функцию `resolvePermission` из `@ufos/contracts`.
5. **AuthModule** — публичные auth endpoints, session service, login throttle и глобальный `AuthGuard`.
6. **Feature modules** — Users, Spaces, Modules, Dashboard, Admin, Public, Health.

Глобальный guard включён по умолчанию. Только явно помеченные `@Public()` endpoints доступны без сессии. Для всех `POST/PATCH/DELETE` с существующей сессией проверяется `X-CSRF-Token`, равный `HMAC(SESSION_SECRET, session.id)`.

## Поток авторизации

1. Cookie `ufos_session` содержит случайный opaque token. В базе хранится только его SHA-256.
2. `AuthGuard` находит активную неотозванную сессию и загружает пользователя.
3. Контроллер получает `CurrentUser` и `CurrentRequest`.
4. Для любого запроса к данным вызывается `AccessService.assert` с активным `spaceId`, модулем и действием.
5. Проверяется: включён ли модуль, состоит ли пользователь в пространстве, его роль, override, sensitive grant, детские/гостевые ограничения.
6. Отказ возвращает `403` с причиной; успешное важное действие попадает в audit.

Платформенная роль не является «суперпользователем данных». Если у администратора сервера нет membership в домохозяйстве, `AccessService` отказывает с `platform_role_has_no_data_access`.

## Пространства

- `family_network` — необязательное объединение домохозяйств.
- `household` — основная граница изоляции.
- `personal` — персональное пространство, привязанное к пользователю/дому.
- `user_preferences.active_space_id` определяет текущий контекст.
- `module_toggles` задаёт доступность модуля для конкретного пространства.
- `memberships.overrides` и `sensitive_grants` задают точечные разрешения.

`public_posts` существует отдельно и возвращается только при `published_at <= now`, `unpublished_at IS NULL`. Публичный контроллер не выбирает приватные поля и не требует авторизации.

## Контракты

`packages/contracts` содержит:

- типы API (`AuthSnapshot`, `DashboardSnapshot`, `AdminSnapshot`, ...);
- каталог всех 40 модулей ТЗ с этапом, группой, чувствительностью и ограничениями;
- матрицу ролей и функцию `resolvePermission`, одинаковую для сервера и интерфейсных подсказок;
- генератор effective permissions для membership.

Frontend использует `MODULES` только для отображения roadmap; итоговое решение всегда принимает сервер.

## Production и preview

|                 | Preview / Jest                                            | Production                       |
| --------------- | --------------------------------------------------------- | -------------------------------- |
| DB              | PGlite WASM PostgreSQL, `memory://` или локальный каталог | PostgreSQL 16 через `pg` Pool    |
| Cookie `Secure` | false                                                     | true                             |
| Demo seed       | включён по умолчанию                                      | отключён, создаётся только owner |
| SMTP            | dev token в ответе                                        | требуется отдельный adapter      |
| Secrets         | deterministic development values                          | обязательные environment secrets |
| Build           | `nest start --watch`, `next dev`                          | prebuilt `dist` и `.next`        |

## ADR-001: embedded PostgreSQL в превью

PGlite выбран только как адаптер для тестов и демонстрации, потому что в среде разработки нет Docker/отдельного Postgres. Он исполняет ту же SQL-миграцию и сохраняет SQL-совместимость. Production всегда использует `DB_DRIVER=postgres` и `DATABASE_URL`; это обязательно проверяется в `config.ts`.

## ADR-002: hash chain вместо «неизменяемой» таблицы

API не предоставляет endpoints изменения или удаления `audit_events`. Каждая запись включает предыдущий хеш, а `audit_control` хранит последний. `GET /api/admin/audit/verify` пересчитывает цепочку. Для реальной защиты от привилегированного пользователя БД необходимо отдельное append-only хранилище/WORM и DB-роль без `UPDATE/DELETE` — это указано в `SECURITY.md`.
