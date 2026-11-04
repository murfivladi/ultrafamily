# API Этапа A

Базовый путь: `/api`. Все ответы JSON. Браузер использует относительные URL; Next.js rewrite проксирует их к NestJS. Кэш отключён для API (`Cache-Control: no-store`).

## Аутентификация

- Cookie: `ufos_session`, `HttpOnly`, `SameSite=Lax`, `Secure` в production.
- Для `POST`, `PATCH`, `DELETE` с сессией требуется заголовок `X-CSRF-Token`.
- CSRF token = `HMAC-SHA256(SESSION_SECRET, session.id)`; возвращается в `AuthSnapshot.csrfToken`.
- Публичные auth endpoints CSRF не требуют.
- Неизменяющие `GET/HEAD/OPTIONS` CSRF не требуют.
- Все endpoints защищены глобальным `AuthGuard`, кроме `@Public()`.

Типичный ответ ошибки:

```json
{
  "statusCode": 403,
  "code": "ForbiddenException",
  "message": "access_denied:not_a_space_member",
  "requestId": null
}
```

## Публичные endpoints

| Method | Path                                | Описание                              |
| ------ | ----------------------------------- | ------------------------------------- |
| `GET`  | `/api/health`                       | health, версия, DB driver, `demoMode` |
| `GET`  | `/api/public/posts?language=ru\|it` | только опубликованные материалы       |
| `GET`  | `/api/public/posts/:slug`           | одна публикация                       |
| `POST` | `/api/auth/register`                | регистрация только по приглашению     |
| `POST` | `/api/auth/login`                   | вход, установка session cookie        |
| `POST` | `/api/auth/verify-email`            | подтверждение email token             |
| `POST` | `/api/auth/password-reset/request`  | создание reset token                  |
| `POST` | `/api/auth/password-reset/confirm`  | смена пароля и отзыв всех сессий      |

В development reset/verification token возвращается в ответе для локального тестирования. В production этот токен должен отправляться через SMTP adapter и из ответа удалён.

## Аккаунт и сессии

| Method   | Path                            | Право                                       |
| -------- | ------------------------------- | ------------------------------------------- |
| `GET`    | `/api/auth/me`                  | активная сессия; returning `AuthSnapshot`   |
| `POST`   | `/api/auth/logout`              | активная сессия + CSRF                      |
| `GET`    | `/api/auth/sessions`            | активная сессия                             |
| `DELETE` | `/api/auth/sessions/:id`        | владелец сессии + CSRF                      |
| `POST`   | `/api/auth/sessions/revoke-all` | владелец + CSRF, текущая сессия сохраняется |
| `GET`    | `/api/profile`                  | активная сессия                             |
| `PATCH`  | `/api/profile`                  | displayName, language, avatarColor + CSRF   |
| `PATCH`  | `/api/profile/preferences`      | whitelist настроек + CSRF                   |

`AuthSnapshot` содержит пользователя, настройки, активное пространство, список пространств с ролью, effective permissions и csrf token.

## Пространства и права

| Method  | Path                               | Серверная проверка                                    |
| ------- | ---------------------------------- | ----------------------------------------------------- |
| `GET`   | `/api/spaces`                      | membership list пользователя                          |
| `POST`  | `/api/spaces`                      | недетский аккаунт; creates household + personal space |
| `POST`  | `/api/spaces/:id/switch`           | `spaces:read` в целевом пространстве                  |
| `GET`   | `/api/spaces/:id/members`          | `spaces:read`                                         |
| `POST`  | `/api/spaces/:id/invitations`      | `spaces:manage_access`                                |
| `PATCH` | `/api/spaces/:id/permissions`      | `spaces:manage_access`                                |
| `PATCH` | `/api/spaces/:id/sensitive-grants` | `spaces:manage_access`                                |

Пример точечного override:

```json
{
  "userId": "usr_…",
  "moduleId": "calendar",
  "action": "publish",
  "decision": "allow"
}
```

`decision: null` удаляет override и возвращает наследование роли.

## Модули, панель и администрирование

| Method  | Path                      | Проверка                               |
| ------- | ------------------------- | -------------------------------------- |
| `GET`   | `/api/modules`            | `catalog:read` в активном пространстве |
| `PATCH` | `/api/modules/:moduleId`  | `spaces:manage_access`                 |
| `GET`   | `/api/dashboard`          | `dashboard:read`                       |
| `GET`   | `/api/admin`              | `platform_owner` или `platform_admin`  |
| `GET`   | `/api/admin/audit/verify` | platform role                          |

`GET /api/admin` не возвращает пароли, token hashes, invitation hashes или contents future private vault.

## Ограничение частоты

`LoginThrottleService` ограничивает неудачные входы по email+IP-фингерпринту: 10 попыток / 15 минут. После 5 неудач для аккаунта включается 15-минутная блокировка в базе. IP сохраняется только как HMAC-префикс. Для распределённого production нужен общий Redis throttle.

## Версионирование

Stage A и Stage B не обещают стабильного публичного API. Версия возвращается в `/api/health`. Публичный API с OAuth, scoped tokens, webhooks и документацией входит в Этап H.

## Stage B endpoints

Все приватные маршруты требуют сессии, CSRF для изменяющих методов и `spaceId` в query или теле. Массив `permissions` из `/auth/me` показывает доступные действия.

- Realtime: `GET /api/realtime/stream?spaceId=...&topics=calendar,tasks,notifications,shopping,shopping.presence,public_site`.
- Dashboard: `GET /api/dashboard` возвращает `feed`, `feedSources`, `events`, `tasks`, `notifications`, `shopping` с фильтрацией по правам.
- Calendar: `GET|POST /api/calendar/calendars`, `GET|POST /api/calendar/events`, `GET|PATCH|DELETE /api/calendar/events/:id`, `POST .../rsvp|links|exceptions`, `POST /api/calendar/free-busy`, `POST /api/calendar/suggest-time`, `GET /api/calendar/overload`, `GET /api/calendar/export.ics`, `POST /api/calendar/import`, `GET|POST|DELETE /api/calendar/tokens`.
- CalDAV (Basic Auth, отдельный токен): `OPTIONS|PROPFIND|REPORT /api/caldav/:calendarId`, `GET|PUT|DELETE /api/caldav/:calendarId/:uid.ics`.
- Tasks: `GET /api/tasks/board`, `POST /api/tasks/lists`, `POST /api/tasks`, `PATCH|DELETE /api/tasks/:id`, `POST .../comments|attachments|dependencies|links|claim|prioritize|split`, `POST /api/tasks/auto-assign`, `GET|POST /api/tasks/templates`, `POST /api/tasks/templates/apply`.
- Notifications: `GET /api/notifications`, `GET /api/notifications/unread-count|preferences|digest|deliveries|webhooks`, `PATCH /api/notifications/preferences`, `POST /api/notifications/test|dispatch|read-all|push|webhooks|reminders/sweep`, `POST /api/notifications/:id/read`, `DELETE /api/notifications/push/:id`.
- Shopping: `GET /api/shopping/lists|history|suggestions`, `POST /api/shopping/lists|items|merge|generate|presence/join|presence/leave`, `PATCH|DELETE /api/shopping/items/:id`, `POST /api/shopping/items/:id/claim`, `POST /api/shopping/suggestions/:id/accept`, `POST /api/shopping/lists/:id/archive`.
- Publishing: `GET /api/publishing|stats|shared`, `POST /api/publishing/drafts`, `PATCH /api/publishing/:id`, `GET /api/publishing/:id/preview`, `POST /api/publishing/:id/publish|unpublish`.
- Public: `GET /api/public/posts`, `GET /api/public/news`, `GET /api/public/posts/:slug`. Публичная выдача содержит только явно опубликованные `public` материалы и безопасные поля.

Детали ограничений и форматов — в [STAGE-B.md](STAGE-B.md).
