# Деплой, обновление и откат

## Локальная разработка и превью

```bash
npm install
npm run dev
```

Поднимаются:

- `0.0.0.0:3000` — Next.js;
- `0.0.0.0:3001` — NestJS API;
- `apps/api/.data/pglite` — локальная development БД.

`npm run dev` собирает общий contracts package до запуска. Next.js `allowedDevOrigins` разрешает `*.e2b.app` для Arena preview. В браузере используются только относительные `/api/*`.

## Production через Docker Compose

Поддерживается, если у VPS есть SSH-доступ и Docker. Проверьте это у Vladhost до выбора схемы.

1. Создайте `.env` на сервере по образцу `.env.example`. Обязательны:
   - `POSTGRES_PASSWORD`;
   - `SESSION_SECRET` (например, `openssl rand -base64 48`);
   - `BOOTSTRAP_OWNER_PASSWORD`;
   - `APP_ORIGIN=https://family.example`;
   - `DATABASE_URL` не нужен в compose: его формирует сервис `api`.
2. Не добавляйте `.env` в Git, архив релиза или браузерный код.
3. Запустите:

```bash
docker compose up -d --build
docker compose ps
curl -fsS https://family.example/api/health
```

Compose использует healthcheck и ждёт готовности PostgreSQL перед API, а API перед web. Web публикует только порт 3000; PostgreSQL и API остаются во внутренней сети.

## Production без Docker

```bash
npm ci
npm run build
NODE_ENV=production \
DB_DRIVER=postgres \
DATABASE_URL='postgres://…' \
SESSION_SECRET='…' \
BOOTSTRAP_OWNER_PASSWORD='…' \
APP_ORIGIN='https://family.example' \
npm start
```

Запуск двух процессов можно передать systemd, Supervisor или другому process manager. Next.js и NestJS должны быть доступны через reverse proxy с HTTPS. `API_PROXY_ORIGIN` должен указывать на внутренний API.

## FTP/SFTP по выбранной схеме ТЗ

Предпочтительно SFTP. Обычный FTP и Cloudflare Origin Rules **не заменяют** аутентификацию, firewall и защиту origin-сервера.

### 1. Собрать версионированный архив заранее

```bash
npm run release:package -- v0.1.0-stage-b.1
```

Создаёт `releases/ufos-<version>.tar.gz` и `.sha256`. Архив содержит только prebuilt artifacts, manifests, docs/scripts; excludes `.git`, `.env`, databases, uploads and node_modules. Сборка на production не выполняется.

### 2. Загрузить в отдельный каталог релиза

```bash
SFTP_HOST=… SFTP_USER=… SFTP_REMOTE_DIR=/srv/ufos \
LFTP_PASSWORD=… npm run deploy:sftp -- releases/ufos-v0.1.0-stage-b.1.tar.gz
```

Скрипт загружает сначала `.part`, затем atomically renames to final name. Он **не переключает current**, пока версия не проверена.

### 3. Подготовить release directory

На сервере:

```bash
sha256sum -c releases/ufos-<version>.tar.gz.sha256
mkdir -p /srv/ufos/releases/<version>
tar -xzf releases/ufos-<version>.tar.gz -C /srv/ufos/releases/<version> --strip-components=1
cd /srv/ufos/releases/<version>
npm ci --omit=dev --ignore-scripts=false
```

Секреты должны находиться вне каталога релиза (например, `/etc/ufos/env`), чтобы переключение версии их не перезаписывало.

### 4. Резервная копия перед миграциями

```bash
DATABASE_URL='postgres://…' BACKUP_REMOTE=remote:ufos AGE_RECIPIENT=age1… npm run db:backup
```

Только после успешной внешней копии применяйте миграции. `DatabaseService` последовательно применяет `001_init.sql`, `002_stage_b.sql`, `003_stage_b_compat.sql` и `004_stage_b_activation.sql`, записывая версии в `schema_migrations`; все миграции идемпотентны. Для отката используйте проверенную резервную копию и процедуру из [BACKUP-RESTORE.md](BACKUP-RESTORE.md).

### 5. Переключение current

```bash
ln -sfn /srv/ufos/releases/<version> /srv/ufos/current.next
mv -Tf /srv/ufos/current.next /srv/ufos/current
systemctl restart ufos-api ufos-web
curl -fsS https://family.example/api/health
npm run smoke
```

Точная команда process manager зависит от VPS; symlink switch должен быть атомарным.

### 6. Откат

1. Переключите symlink на предыдущий проверенный release directory.
2. Остановите сервисы и восстановите БД из копии, сделанной перед миграцией, только если новая версия изменила схему несовместимо.
3. Восстановите согласованную копию файлов из того же архива.
4. Проверьте `/api/health`, вход, audit chain и список пространств.
5. Зафиксируйте причину в журнале, не удаляя audit events.

## Cloudflare

- Origin Rules должны направлять только наружный HTTPS traffic на VPS port web.
- WebRTC media traffic в будущем не должен идти через обычный HTTP rewrite; для него нужен отдельный TURN/media path.
- Не публикуйте PostgreSQL/API internals.
- `APP_ORIGIN` должен содержать точный внешний origin.
- TLS на origin обязателен; Flexible SSL insufficient for sensitive family data.

## Переменные окружения

См. [`.env.example`](../.env.example). Production не запустится без `SESSION_SECRET`, `DATABASE_URL` и `BOOTSTRAP_OWNER_PASSWORD`. Ключи Polza.ai, SMTP и Telegram для Stage B не нужны и никогда не должны попадать в браузерный код.

## Stage B

Новых обязательных переменных окружения нет. Production-образ API копирует весь каталог SQL-миграций, поэтому `001_init.sql` и `002`–`004` доступны в `dist/db/sql`. SSE использует обычный HTTP-ответ и не требует отдельного порта; обратный прокси должен разрешать streaming и не буферизировать `text/event-stream`. Реврайт `/caldav/:path*` сохраняет завершающий слэш, поэтому внешний proxy не должен подменять его 308-редиректом для `PROPFIND`.

Перед обновлением с Stage A сделайте внешнюю копию PostgreSQL. При первом запуске Stage B миграции создадут новые таблицы, столбцы и пустые организационные контейнеры, сохранив существующие аккаунты, пространства, публикации и аудит.

Локально проверена сборка версионированного архива `npm run release:package -- v0.1.0-stage-b.1`: созданы `.tar.gz` и `.sha256`, контрольная сумма совпала, архив содержит prebuilt `dist`/`.next`, миграции `001`–`004`, документацию и скрипты, но не содержит `.env`, `.git`, `node_modules`, локальные БД или резервные копии. Архив не загружался на сервер; `releases/` исключён из Git. SFTP-загрузка, `pg_dump`, Docker Compose и восстановление на VPS в этой среде не выполнялись.
