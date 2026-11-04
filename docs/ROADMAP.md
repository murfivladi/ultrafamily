# Дорожная карта этапов B–H

Соответствует разделу 34 ТЗ. Этапы могут частично выполняться параллельно, но стабильность основы важнее скорости. Этап B реализован как внутренняя техническая сборка; этапы C–H ниже остаются планом. Ни один этап не является публичной версией 1.0.

## B. Организационное ядро — реализовано во внутренней сборке

- Настраиваемые источники ленты, детерминированные объяснения важности и ссылки на модули.
- Календарь day/week/month/agenda, повторы/исключения, участники, free/busy, ICS и CalDAV.
- Списки и доска задач, подзадачи, зависимости, повторы, шаблоны и назначение по нагрузке.
- In-app и webhook-уведомления, тихие часы, сводки, дедупликация и повторы локальной очереди. Адаптеры Web Push/email/Telegram пока не подключены.
- Совместные списки покупок, генерация позиций из календарного меню/задач, presence и версии. Полноценные рецепты/запасы относятся к этапу E.
- Явная публикация сайта: черновик, предпросмотр, снятие с публикации и видимость каждой записи.

Ограничения текущей реализации: вместо Redis/BullMQ используется ограниченная таблица доставки; конфликты CalDAV разрешаются ETag/версиями; SMTP/Telegram/Web Push-адаптеры не подключены; realtime сделан через SSE в одном API-процессе. Подробности — [STAGE-B.md](STAGE-B.md).

## C. Общение и совместная работа

- Messenger: chats, groups, channels, threads, reactions, mentions, delivery/read state, moderation.
- Family feed, polls, date selection, wishlists, proposals, quorum and decision history.
- WebSocket gateway, presence, collaborative cursors, reconnect and idempotency keys.
- Documents/notes/tables/presentations via an integrable office editor, Yjs, versions and comments.
- WebRTC signaling, STUN/TURN, audio/video rooms, screen share, reconnect diagnostics.

WebRTC is a separate high-risk workstream with dedicated network/load testing. Media must never be routed through ordinary HTTP/Cloudflare Origin Rules.

## D. Файлы и память семьи

- Storage adapter with local disk implementation and future S3-compatible backend.
- Folders, chunked uploads, previews, versions, trash, quotas, type validation and malware scanning.
- WebDAV or dedicated sync client; safe archive handling.
- Gallery, albums, timeline, comments, memories, duplicate search and protected expiring links.
- Bounded OCR/vision/photo/video queues; external worker option for a small VPS.
- Full-text and visual search with permission filters and source citations.
- Diaries, family stories, interactive timeline, family encyclopedia and private genealogy tree.
- Optional consent-based local face recognition, disabled for children by default; deletable biometric representations.

## E. Повседневные модули

- Recipes, scaling, import, versions, cooking mode and human-reviewed AI variants.
- Weekly menu, pantry, expiry/batches, shopping linkage, allergy warnings with restricted visibility.
- Finances: personal/shared transactions, recurring payments, budgets, goals, CSV import and duplicate checks.
- Home inventory, rooms, QR labels, warranties, checkout/return and maintenance schedules.
- Trips, packing lists, bookings, budget and calendar/task/document links.
- Energy, weather, saved places and voluntary temporary location sharing.

## F. Чувствительные и детские разделы

- School schedules, homework, study cards, spaced repetition, step-by-step AI tutor.
- Parental controls across modules, external links, invitations, publishing and AI memory.
- Health archive, vaccinations, medication notes, retention periods and access log.
- Document vault, expiry, versions, additional confirmation and field-level/E2EE encryption.
- Clear UI disclosure that E2EE limits search, AI and recovery.
- Additional privacy review before real minors’/medical data.

## G. AI и автоматизации

- Provider-independent adapter with Polza.ai implementation, server-only API key, spend caps, timeouts and retries.
- Per-module/per-space AI policy; medicine/finance/vault excluded by default.
- Retrieval with citations; visible source list; redaction of forbidden fields.
- Personal/family/conversation memory with inspect, correct, disable and delete.
- Action modes: forbidden, draft, confirm, safe-auto; elevated confirmation for destructive/publishing/financial actions.
- Voice input/output near realtime, interruption, visible recording state.
- Visual automation builder, safe sandboxed user scripts, resource/rate limits and run logs.
- AI forbidden-data tests and audit of every action.

## H. Подготовка версии 1.0

- Public API docs, scoped/expiring tokens, OAuth apps, signed/retried webhooks and revocation.
- Full admin panel for integrations, translations, themes, queues, quotas, monitoring and updates.
- Self-hosted feature analytics with limited retention.
- Complete ZIP/JSON/CSV export and cross-installation import with integrity/version checks.
- Backup restore drills, migration rollback tests, load and accessibility tests.
- Security audit, dependency scanning, log/metric/tracing stack and status panel.
- User/admin documentation and responsible-adult launch review.

## Gate for 1.0

Public family launch only when all TЗ requirements are implemented or formally changed in a new TЗ revision, no known critical/high vulnerabilities exist, space-isolation tests pass, restore and off-VPS backup are proven, load/device checks pass, monitoring is active, documentation is complete and a responsible adult participates in launch with minors’/sensitive data.
