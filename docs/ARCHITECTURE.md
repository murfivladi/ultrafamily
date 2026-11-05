# Архитектура

## Форма

Stage C остаётся **модульным монолитом** с отдельными frontend- и API-процессами. Realtime — SSE (Stage B) и WebSocket-шлюз `/ws` с Yjs-комнатами в памяти API-процесса (Stage C). WebRTC-медиа идёт P2P/TURN и не обслуживается API; медиа-workers и полноценный office editor не запускаются. Это соответствует ограничению VPS 1–2 CPU / 2–4 GB RAM.

```text
Browser
  └── Next.js (0.0.0.0:26287)
        ├── public pages
        ├── authenticated SPA-like pages
        └── /api/* rewrite ──> http://127.0.0.1:25031 (NestJS)
                                  ├── global AuthGuard + CSRF
                                  ├── AccessService
                                  ├── module services
                                  ├── AuditService (hash chain)
                                  └── DatabaseService
                                         ├── pg Pool ──> PostgreSQL 16 (production)
                                         └── PGlite ───> local preview / Jest
```

В браузере нет абсолютных URL другого сервиса: все вызовы идут на относительный `/api/*`. Next.js сервер-side проксирует путь на внутренний `http://127.0.0.1:25031` через `API_PROXY_ORIGIN`. Публичный `https://api.family.vladislavb.qzz.io` остаётся адресом reverse proxy в документации, а не исходящим TLS-запросом из Node.js.

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
- каталог всех 41 модуля ТЗ с этапом, группой, чувствительностью и ограничениями;
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

## Stage B

Добавлены NestJS-модули `RealtimeModule`, `NotificationsModule`, `CalendarModule`, `TasksModule`, `ShoppingModule`, `PublishingModule`. `RealtimeModule` и `NotificationsModule` глобальные, поэтому сервисы организационного ядра получают общий канал событий и центр уведомлений без циклических зависимостей. `TasksModule` импортирует `CalendarModule` только для детерминированного разбора `RRULE`.

Браузер использует `/api/*` и `/caldav/*` относительные пути. Next.js проксирует оба на NestJS. `DatabaseService` применяет все SQL-миграции из `src/db/sql` по имени файла; production-сборка копирует каталог целиком в `dist/db/sql`.

SSE рассчитан на один API-процесс. Для нескольких реплик потребуется общий bus (этап C/H); текущая реализация не выдаёт себя за распределённый WebSocket-шлюз.

## Stage C

- `CollaborationGateway` (`apps/api/src/collaboration/`) поднимает `ws` `WebSocketServer` на том же HTTP-сервере NestJS, путь `/ws`. Аутентификация — по cookie сессии до первого кадра; CSRF проверяется в `hello`. `Origin` сверяется с `APP_ORIGIN`.
- Yjs-комнаты (`Y.Doc`) живут в памяти процесса, гидрируются из `documents.content` и сохраняются с дебаунсом 1200 мс. Кадр ограничен 512 КБ, Yjs-обновление передаётся base64 внутри JSON.
- REST-модули Stage C (`messenger`, `feed`, `decisions`, `documents`, `calls`) следуют схеме Stage A/B: guard, CSRF, `AccessService.assert`, аудит, realtime-событие темы.
- Браузер использует относительные URL. HTTP проксирует Next.js, WebSocket — `scripts/ws-proxy.mjs` (dev) или reverse proxy (prod). Медиа WebRTC не проходит ни через один из них.
- Клиент (`apps/web/src/lib/collaboration.ts`) держит одно соединение на страницу, очередь отправки, backoff 500 мс → 15 с, ping каждые 25 с и полную пересылку состояния при реконнекте.
- Ограничение: без общего pub/sub несколько API-реплик не разделят Yjs-комнаты и presence.
