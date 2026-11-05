# Деплой, обновление и откат

Этот документ описывает текущий сценарий Stage B: **только загрузка готовых backend/frontend файлов через FTPS из GitHub Actions**. SSH/SCP, SFTP-деплой, Docker Compose runtime и удалённые shell-команды в автоматизации не используются. Workflow не перезапускает процессы, не запускает миграции вручную, не делает backup/health/smoke/rollback и не трогает PostgreSQL.

Подробная настройка GitHub Actions: [GITHUB-ACTIONS.md](GITHUB-ACTIONS.md). Полный runtime/API: [ARCHITECTURE.md](ARCHITECTURE.md) и [API.md](API.md).

## Состав

| Компонент                                 | Назначение                                                        |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `.github/workflows/ci.yml`                | форматирование, синтаксис скриптов, тесты, typecheck, build       |
| `.github/workflows/ftp.yml`               | один workflow с `target: backend \| frontend \| both`             |
| `scripts/package-ftp.sh`                  | предсобранный backend и исходники frontend для сборки на хостинге |
| `scripts/ftp-upload.sh`                   | FTPS-загрузка в `./` и merge-only-missing `.env`                  |
| `.env.example`                            | шаблон всех переменных окружения                                  |
| `scripts/backup.sh`, `scripts/restore.sh` | ручной backup/restore PostgreSQL, не часть Actions                |

Удалённые SSH/SFTP-скрипты и workflow не входят в деплой. Файлы `Dockerfile.*` и `docker-compose.yml` остаются в репозитории как альтернативные артефакты, но в этом сценарии не запускаются.

## FTP-доступ

- один FTP-хост;
- разные пользователи и пароли для backend и frontend;
- порт по умолчанию `2121`;
- удалённый каталог всегда `./`;
- FTPS: по умолчанию явный `AUTH TLS`; `FTP_TLS_MODE=implicit` для TLS сразу на порту; TLS для control и data channel;
- загрузка без `SITE CHMOD`/`MFF`: права файлов задаёт сервер, workflow не меняет permissions;
- GitHub Artifact включает hidden files: `.next/`, `.env.example`, `.nvmrc`; `lftp` использует `ftp:list-options -a`;
- `.next/cache/` и `*.pack` не загружаются: это build cache Next.js, не runtime; уже загруженный кэш удалите на FTP вручную;
- переменные и секреты GitHub описаны в [GITHUB-ACTIONS.md](GITHUB-ACTIONS.md).

Workflow загружает **содержимое** двух GitHub Artifact напрямую в корень `./` каждого FTP-аккаунта; локальная папка `payload/` runner'а на FTP не создаётся. Старую `./artifact/` от предыдущих запусков удалите вручную: `mirror -R` не использует `--delete`.

Workflow загружает два GitHub Artifact по отдельности. Backend artifact содержит собранный Nest API, contracts, SQL внутри `dist`, корневые manifests и `package-lock.json`. Frontend artifact содержит готовый `.next`, `public`, конфиги Next.js, contracts и manifests: frontend собирается в Actions. Ни один artifact не содержит `.env`, SSH-ключей, VCS, `node_modules`, БД или backups.

## `.env`

Канонический `.env` лежит в **корне `./` каждого FTP-аккаунта**, рядом с `package.json` и `RELEASE.json`, а не внутри `artifact/` или `payload/`. API и Next.js config ищут его от текущего каталога вверх; отдельные `apps/api/.env` и `apps/web/.env` не нужны. Точные примеры для backend и frontend лежат в корне payload'а в `ENV-SETUP.txt` и подробно описаны в [GITHUB-ACTIONS.md](GITHUB-ACTIONS.md#как-настроить-env).

Автоматически генерируются и дописываются только отсутствующие ключи:

- общие: `NODE_ENV`, `APP_VERSION`, при наличии `APP_ORIGIN`;
- backend: `SESSION_SECRET`, `BOOTSTRAP_OWNER_PASSWORD`, `BOOTSTRAP_OWNER_EMAIL`, `API_PORT`, `DB_DRIVER`, `DATABASE_SSL`, `DB_POOL_SIZE`, `PGLITE_DATA_DIR`, `SEED_DEMO_DATA`;
- frontend: `WEB_PORT=26287`, `NEXT_PUBLIC_DEMO_PASSWORD`, `API_PROXY_ORIGIN=http://127.0.0.1:25031`.

Существующие строки, комментарии и вручную введённые значения не перезаписываются. Сгенерированный `BOOTSTRAP_OWNER_PASSWORD` можно прочитать в `.env` на FTP; он не выводится в логи GitHub.

Вы сами вводите installation-specific значения, например:

```dotenv
DATABASE_URL=postgres://…
APP_ORIGIN=https://family.example
API_PROXY_ORIGIN=http://127.0.0.1:25031
```

`APP_ORIGIN` уже задан вами в `./.env` и не перезаписывается. `API_PROXY_ORIGIN=http://127.0.0.1:25031` зашит в `.next` при сборке в Actions; при смене внутреннего порта отредактируйте существующую строку `.env` и перезапустите `ftp.yml`. Внешний `https://api.family.vladislavb.qzz.io` — только публичный reverse proxy, его нельзя указывать в `API_PROXY_ORIGIN`: это даёт `EPROTO / SSL alert number 40`. Остальные настройки первого запуска вводятся в уже существующей админке платформы. Новый setup-визард не добавлялся.

## Первый запуск

Через админку сервера/хостинга, в корне каждого FTP-аккаунта. Ставьте зависимости **только для нужного workspace** — голая `npm ci --omit=dev` ставит весь монорепозиторий и на хостинге с 1–2 ГБ RAM умирает от OOM (см. ниже):

```bash
# backend-аккаунт
npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace=@ufos/api --include-workspace-root=false
npm run start:prod -w @ufos/api

# frontend-аккаунт
npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace=@ufos/web --include-workspace-root=false
npm run start -w @ufos/web
```

### Если `npm ci` падает с OOM (Killed / JavaScript heap out of memory)

Причина почти всегда одна: установка всего монорепозитория сразу. Замеренный пиковый RSS на этом lock-файле:

| Команда                                                                  | Пакетов | Пик RAM                                       |
| ------------------------------------------------------------------------ | ------- | --------------------------------------------- |
| `npm ci` (полная, с dev)                                                 | 706     | ~0,9–1,1 ГБ                                   |
| `npm ci --omit=dev` (все workspace)                                      | 159     | ~0,8 ГБ                                       |
| `npm ci --omit=dev --workspace=@ufos/api --include-workspace-root=false` | 137     | ~0,25 ГБ                                      |
| `npm ci --omit=dev --workspace=@ufos/web --include-workspace-root=false` | 35      | ~0,7 ГБ (пакеты Next.js сами по себе большие) |

Что делать:

1. Используйте scoped-команды из «Первого запуска» выше — это основное исправление. Корневой `.npmrc` (он лежит и в обоих payload'ах) дополнительно отключает audit/fund/update-notifier и ограничивает параллельность загрузок (`maxsockets=4`).
2. На время установки остановите остальные Node-процессы (API, web, ws-proxy): npm нужен весь свободный объём.
3. Если свободной RAM меньше ~1 ГБ, добавьте swap, например 2 ГБ: `fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile` (на shared-хостинге без root это недоступно — тогда поможет только пункт 1 и остановка процессов).
4. Не лечите OOM увеличением `--max-old-space-size` вслепую: при жёстком лимите контейнера/хостинга это лишь меняет «Killed» на «JavaScript heap out of memory». Значение имеет смысл ставить только чуть ниже реального свободного объёма, например `NODE_OPTIONS=--max-old-space-size=1536` при 2 ГБ свободной RAM.
5. `--ignore-scripts` в командах выше безопасен для этого дерева зависимостей (нативные бинарники Next/sharp/PGlite приезжают готовыми optional-пакетами) и убирает дочерние процессы установки.

Frontend слушает порт `26287`; backend слушает `API_PORT=25031`. Frontend уже собран, поэтому `npm run build -w @ufos/web` на хостинге не нужен. Next.js направляет `/api` и `/caldav` на внутренний `http://127.0.0.1:25031`; `https://api.family.vladislavb.qzz.io` остаётся публичным адресом reverse proxy. При необходимости запретите буферизацию SSE и сохраните завершающий `/` для CalDAV-запросов. Миграции SQL применяет API при старте.

### Realtime `/ws` и WebRTC

Stage C добавляет второй протокол на том же frontend-хосте:

- `/api/*` — обычные HTTP-запросы (как раньше);
- `/ws` — WebSocket-соединение к NestJS (`CollaborationGateway`).

HTTP-реврайт Next.js не умеет upgrade соединения, поэтому нужен один из двух вариантов:

1. **Отдельный прокси `scripts/ws-proxy.mjs`** (`npm run start:ws`). Он слушает `WS_PUBLIC_PORT` (по умолчанию `26288`), передаёт обычный HTTP в Next.js и `Upgrade: websocket` на `/ws` — в API (`WS_API_HOST`/`WS_API_PORT`). В dev/preview режиме этот прокси запускается вместе с `npm run dev`.
2. **Правило в reverse proxy** (предпочтительно в production): `location /ws { proxy_pass http://127.0.0.1:25031; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_set_header Host $host; proxy_read_timeout 3600s; }` и проксирование остального на Next.js.

Обязательно: `APP_ORIGIN` должен содержать публичный origin (`https://family.example.org`), иначе gateway принимает WS без проверки Origin; при заданном `APP_ORIGIN` соединение из другого origin отклоняется. Прокси не должен буферизовать ответы на `/ws`.

**Медиа WebRTC не идёт через этот прокси и через обычный HTTP-деплой.** Аудио/видео использует SRTP/UDP напрямую между браузерами или через TURN. Для TURN откройте UDP `3478` (и `5349` для TURNS), задайте `WEBRTC_TURN_URLS`, `WEBRTC_TURN_USERNAME`, `WEBRTC_TURN_CREDENTIAL` на API; правило Cloudflare Origin Rules не должно применяться к медиатрафику. Если TURN не настроен, `GET /api/calls/rooms/:id/diagnostics` вернёт `turnConfigured: false`, и интерфейс покажет предупреждение.

`scripts/smoke.sh` проверяет, что `/ws` на `API_URL` отвечает на upgrade (101/401/403), а не 404.

## Обновление

1. Убедитесь, что CI зелёный.
2. Сделайте backup PostgreSQL по [BACKUP-RESTORE.md](BACKUP-RESTORE.md).
3. В Actions запустите `FTP deploy` с `target: backend`, `frontend` или `both`.
4. Workflow соберёт оба payload'а, проверит тесты/typecheck/build и загрузит только выбранные файлы.
5. Перезапустите сервисы в админке сервера. Workflow сам этого не делает.

## Откат

Запустите `ftp.yml` с предыдущей версией и нужным `target`, либо загрузите сохранённый artifact вручную. `mirror -R` не использует `--delete`, поэтому лишние файлы удаляются только вручную в админке сервера. PostgreSQL восстанавливается отдельно по [BACKUP-RESTORE.md](BACKUP-RESTORE.md).

## Backup и восстановление

Автоматический backup в FTP workflow отсутствует. До обновления выполните:

```bash
export DATABASE_URL='postgres://…'
bash scripts/backup.sh backups/pre-deploy.dump
```

Восстановление:

```bash
bash scripts/restore.sh backups/pre-deploy.dump
```

Храните dump вне FTP-каталога и проверяйте восстановление на копии БД. Embedded PGlite используется только для локального preview.

## Локальная проверка

```bash
npm ci --no-audit --no-fund
npm run format:check
npm run check
npm run build
bash scripts/package-ftp.sh local-ftp-test
```

Последняя команда создаёт gitignored `releases/ftp/backend` и `releases/ftp/frontend`, но **не загружает** их. Для реального FTPS-upload нужны переменные/секреты из [GITHUB-ACTIONS.md](GITHUB-ACTIONS.md).

## Текущий статус

Локально проверены build, тесты и packaging. Реальный VPS/FTPS, production PostgreSQL, домен, GitHub secrets и production `.env` в этой рабочей среде не настраивались, поэтому производственный деплой не выполнялся.
