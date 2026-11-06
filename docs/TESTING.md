# Тестирование и качество

## Команды

```bash
npm test               # contracts unit + API/E2E + web typecheck
npm run typecheck      # TypeScript strict checks across workspaces
npm run build          # production build
npm run smoke          # running deployment smoke checks
npm run check          # typecheck + test
```

API Jest uses `NODE_OPTIONS=--experimental-vm-modules` because PGlite dynamically imports its WASM module inside the Jest VM. This flag is needed only for tests, not production.

## Что покрыто

### `packages/contracts` (Vitest)

- Adult baseline vs publish denial.
- Guest read-only + explicit share.
- Platform admin cannot bypass household isolation.
- Child restrictions survive `allow` override.
- Sensitive module grants and disabled modules.
- Explicit allow/deny overrides.
- Effective permission generation.

### `apps/api` (Jest + Supertest + PGlite)

A real Nest application is booted with an isolated embedded PostgreSQL database and seeded accounts. Tests cover:

- public health and public post field minimization;
- CSRF rejection and acceptance;
- session list and revoke-all;
- invitation-only registration and email verification;
- cross-household member access denial;
- platform admin denial on family data;
- guest denial on member list;
- child denial on invitations;
- owner-only module toggle;
- admin audit-chain verification;
- platform-role restriction on admin endpoints;
- password reset, old-password rejection, new-password login and session revocation.

### Frontend

- Strict TypeScript compile.
- Production Next.js build.
- Manual keyboard/responsive checks are documented in `USER-GUIDE.md`; automated browser E2E is not yet included.

## Test isolation

`test/setup.ts` sets:

```text
NODE_ENV=test
DB_DRIVER=pglite
DATABASE_URL=
PGLITE_DATA_DIR=:memory:
SEED_DEMO_DATA=true
```

Each test application creates its own PGlite instance; no shared production or developer database is touched. Sessions use deterministic development CSRF secret only in tests.

## Not yet automated

From section 33 of the TЗ, the following remain for later stages/version 1.0:

- Playwright/Cypress browser E2E scenarios on real mobile and desktop viewports;
- migration up/down tests with real PostgreSQL;
- backup restore integration test;
- SAST/DAST/dependency/security scans;
- accessibility audit with axe and screen readers;
- RU/IT snapshot tests for every screen;
- PWA install and Web Push device tests;
- queue retry/idempotency tests;
- AI forbidden-data tests;
- WebRTC/TURN network/load tests;
- realtime/Yjs conflict tests;
- 6–10 user load and VPS resource tests.

Эти границы намеренно задокументированы; Stage B и Stage C также не заявлены как версия 1.0.

## Definition of Done for future modules

Every module from stages C–H must add:

1. API tests for all accepted scenarios;
2. role and cross-space isolation tests;
3. server-side permission assertions;
4. error and empty states;
5. audit records;
6. RU/IT strings;
7. responsive and accessibility checks;
8. export/backup participation;
9. docs;
10. VPS resource/security review.

## Stage B

`npm run test -w @ufos/api` запускает 22 серверных теста: 11 Stage A и 11 Stage B. Добавлены проверки умной ленты, запрета данных для администратора сервера с членством, изоляции пространств, гостевых/детских ограничений, календаря/ICS/RRULE, версий и CalDAV, задач без геймификации, настроек/очереди уведомлений, совместных покупок и явной публикации.

CalDAV проверяется через `PROPFIND`, `REPORT`, `PUT` с `If-None-Match`, `GET`, `DELETE` с `If-Match`, а также отклонение токена для чужого календаря. Публичный API проверяется до и после публикации/снятия с публикации.

Локально собираются два FTP payload без секретов и локальных данных; реальная загрузка требует FTPS-доступа и GitHub secrets. CI- и FTP-workflow добавлены; shell-скрипты проверяются `bash -n`, Node-скрипты — `node --check`: `ci.yml` повторяет проверки на каждый push/PR, `ftp.yml` собирает отдельные backend/frontend payloads и загружает выбранный `target` по FTPS. Живое превью на встроенном PGlite дополнительно проверяло SSE-событие `tasks` через `/api/realtime/stream`, `PROPFIND 207` через `/caldav/:calendarId/`, миграцию существующей Stage A базы (`001_stage_a_foundation` → `001_init` + `002`–`004`) и сохранение пользователей/публикаций. Ещё не выполнялись: Playwright/браузерные сценарии, production PostgreSQL/Docker runtime, реальные SMTP/Telegram/Web Push, нагрузочное тестирование SSE и `npm audit`.

## Stage C

`npm run test -w @ufos/api` запускает 36 серверных тестов: 11 Stage A, 11 Stage B, 9 Stage C и 5 WebSocket/collaboration. `packages/contracts` добавляет 8 unit-тестов прав.

`stage-c.e2e-spec.ts` проверяет messenger (создание чата, отправка сообщения, реакции, закрепление, ветки, прочтение, поиск, модерация), ленту (посты, комментарии, реакции, источники, автоматические события), решения (опросы с кворумом и ничьей, предложения, вишлисты, история, правила голосования), документы (версии, восстановление, комментарии, коллабораторы, права), WebRTC-комнаты (создание, участие, сигналы, диагностика ICE) и изоляцию пространств.

`collaboration.e2e-spec.ts` поднимает реальный `WebSocket` к `/ws`:

- отказ без сессии — код `4401`;
- отказ без CSRF — код `4403`;
- `hello` → `ready`, подписка, `ping` → `pong`, presence участников;
- Yjs-синхронизация между двумя клиентами и сохранение документа в базу;
- сигналинг WebRTC (`call:signal`) и сохранение сигналов в `call_signals` (`GET /api/calls/rooms/:id/signals`).

В живом превью дополнительно проверялись: `/api/health` через WS-прокси, страницы `/messages`, `/feed`, `/decisions`, `/documents`, `/calls` (200 без runtime-ошибок), `hello` через прокси с настоящей сессией, наличие демо-данных Stage C в ленте/решениях/документах. `scripts/smoke.sh` проверяет, что gateway на `/ws` отвечает на upgrade (101/401/403), а не 404.

Ещё не выполнялись: реальное двустороннее аудио/видео между браузерами, TURN в мобильных сетях, нагрузочные тесты signaling/Yjs, Playwright-сценарии совместного редактирования и `npm audit`.

## Stage D

`stage-d.e2e-spec.ts` (17 тестов): загрузка частями и идемпотентные повторы, версии и восстановление, Range, блокировка исполняемых и переименованных файлов, квоты, изоляция пространств, приватные файлы, корзина с восстановлением папки и окончательным удалением, ZIP без распаковки, извлечение текста PDF/DOCX и поиск по нему, дубликаты, WebDAV (PROPFIND/MKCOL/PUT/GET/MOVE/DELETE, отзыв токена, привязка к пространству), галерея (альбомы, хронология, участие детей, избранное, отметки), защищённые ссылки (пароль, без скачивания, отзыв), согласие на распознавание лиц, приватность дневника от владельца, экспорт и удаление своих записей, наследование доступа к вложениям, воспоминания, энциклопедия (древо, циклы, приватность, публикация с согласием), права в общем поиске.

`scripts/smoke.sh` дополнительно проверяет `/ws` через web-origin (Next rewrite) и WebDAV (`DAV`-заголовок, 401 без токена). Тест-хранилище создаётся во временном каталоге ОС.
