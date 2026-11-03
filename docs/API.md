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

Stage A не обещает стабильного публичного API. Версия возвращается в `/api/health`. Публичный API с OAuth, scoped tokens, webhooks и документацией входит в Этап H.
