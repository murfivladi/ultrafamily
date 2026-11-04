# Безопасность и приватность

## Реализовано в Stage A и Stage B

### Аутентификация и сессии

- `scrypt` с индивидуальной случайной солью, cost `N=16384`, `r=8`, `p=1`.
- Пароль проверяется через constant-time `timingSafeEqual`.
- Session token — 256-bit случайное значение; в БД хранится только SHA-256.
- Cookie `HttpOnly`, `SameSite=Lax`, `Secure` в production, `Path=/`.
- CSRF token привязан к session id through HMAC and required for unsafe methods.
- Ограничение частоты входов in-memory + database account lockout.
- Список активных сессий, отзыв одной/всех, истечение по роли (child/guest/platform/adult).
- IP не хранится напрямую: только HMAC-префикс.
- Пароли, токены, cookie и секреты редактируются в structured logger и audit metadata.

### Авторизация

- Глобальный deny-by-default guard.
- Каждый запрос к данным проверяет `spaceId`, membership, role, module toggle и action.
- Типовая роль не даёт `publish`, `export`, `manage_access` взрослым.
- Гость — только `read` на явно выбранные материалы.
- Детские ограничения не обходятся `allow` override.
- Чувствительные модули требуют отдельного grant.
- Platform admin не получает данных семьи без membership.
- E2E-тесты проверяют доступ другого домохозяйства, ребёнка, гостя и platform admin.

### Защита приложения

- Zod-валидация тел запросов.
- JSON body limit 64 KB.
- Глобальный exception filter не раскрывает stack trace.
- Security headers: `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy`, `Cache-Control: no-store`.
- SQL только с параметрами; строки SQL не строятся из пользовательских идентификаторов.
- Security slug/email values are parameterized.
- No CORS allowlist: browser and API are same-origin via Next.js rewrite; optional `APP_ORIGIN` check for explicit deployments.
- robots.txt disallows private routes; no generated sitemap/RSS.

### Аудит

- Append-only-by-API event table with hash chain.
- Transactional `SELECT … FOR UPDATE` on `audit_control`.
- `GET /api/admin/audit/verify` recomputes chain.
- Important auth, profile, space, module and session actions are logged.

## Production blockers

Stage B **не считается готовым к реальным чувствительным данным**, пока не выполнено:

1. HTTPS end-to-end, firewall, restricted PostgreSQL port, OS updates and secret rotation.
2. Separate DB role for application with no `UPDATE/DELETE` on `audit_events`; WORM/object-lock or external log sink.
3. At least one automatic encrypted off-VPS backup and a tested restore.
4. SMTP/TOTP/passkey flows for real account lifecycle; remove development token responses.
5. Redis-backed rate limiting and shared session/event policy for multiple API instances.
6. CSRF/Origin policy tuned for the real domain (`APP_ORIGIN`), plus CSP review for Next.js.
7. Full security audit, dependency scanning, SAST, DAST and penetration test.
8. Load testing for 6–10 users and all later realtime/media components.
9. GDPR/Italian/EU privacy review with a responsible adult before adding children’s, medical or financial data.
10. Monitoring, alerting, log retention, anomaly notifications and documented incident response.

## Not yet implemented

Passkeys/WebAuthn, TOTP 2FA, backup codes, trusted-device policies, SMTP, Web Push, Telegram, signed file URLs, malware scanning, field-level encryption, E2EE vault, TURN/WebRTC hardening, sandbox for user automation code, OAuth, API tokens, webhook signatures, SSRF protections for future URL import, and AI data-policy enforcement are later-stage work.

Tables and types for some of these features exist, but a schema placeholder is **not** an implemented control.

## Privacy principles in code

- Private by default; public site reads only `public_posts` with explicit publication state.
- Data minimization: no persistent raw IP, no tokens/secrets in logs.
- Child/guest restrictions are enforced by shared server-side policy.
- В Stage B нет AI-провайдера, ключа и доступа ИИ к данным.
- No hidden geolocation, face recognition, ad trackers or third-party analytics.
- E2EE limitations on server search/AI must be shown to users when the vault is implemented.

## Responsible disclosure

For a private family installation, report suspected vulnerabilities directly to the platform owner out-of-band. Do not put tokens, passwords or private family data into issue descriptions or logs.

## Дополнительно в Stage B

- Каждый новый модуль проверяет `spaceId`, членство, роль, включаемый модуль и действие на сервере. E2E-тест подтверждает изоляцию двух домохозяйств для календаря, задач, покупок и публикаций.
- `public_site` остаётся недоступным детскому профилю; гость получает только явно помеченные `guest_shared` материалы и только на чтение.
- Публичный контроллер не возвращает `spaceId`, `createdBy`, `status`, `visibility`, `audienceSpaceIds` или `guestShared`.
- CalDAV-токены и webhook-секреты хранятся как SHA-256-хеши. Токен привязан к `calendarId`; `If-Match` и версии событий защищают от устаревшей записи.
- SSE-подключение проходит ту же проверку `dashboard:read` для пространства, что и остальные приватные данные. В heartbeat не передаются данные.
- Уведомления не используют скрытую геолокацию, публичные рейтинги детей или геймификацию. Webhook подписывается HMAC от хеша секрета; внешние адаптеры без конфигурации помечаются `skipped`.
- PWA service worker по-прежнему не кэширует `/api/*`.
