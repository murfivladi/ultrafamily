# Деплой через GitHub Actions по FTP

Автоматизация делает **только загрузку файлов по FTPS**. Она не выполняет SSH-команды, не перезапускает сервисы, не применяет миграции вручную и не использует Docker Compose. Backend и frontend загружаются отдельно, в корень `./` своих FTP-аккаунтов.

- `.github/workflows/ci.yml` — проверки на каждый push/PR.
- `.github/workflows/ftp.yml` — полная сборка backend и frontend в Actions и раздельная FTPS-загрузка.
- `scripts/package-ftp.sh` — собирает contracts, API `dist` и frontend `.next`, затем готовит два payload'а.
- `scripts/ftp-upload.sh` — FTPS-загрузка одного payload'а и слияние `.env`.
- `scripts/ftp-env.mjs` — генерирует автоматические значения.
- `scripts/merge-env.mjs` — дописывает только недостающие ключи, сохраняя ваши значения.

SSH-workflow, `scripts/deploy-remote.sh` и SFTP-скрипт удалены.

## Где собирается frontend

По вашему выбору frontend **снова собирается в GitHub Actions**:

- `ftp.yml` вызывает `npm run build`: contracts, Nest API и Next.js `.next` создаются в runner.
- `ci.yml` не менялся и по-прежнему делает полную проверочную сборку на push/PR.
- На хостинг загружается уже готовый `.next`; `npm run build -w @ufos/web` там запускать не нужно.
- Frontend слушает порт **26287** (`WEB_PORT=26287`).
- `/api` и `/caldav` переписываются на **https://api.family.vladislavb.qzz.io** (`API_PROXY_ORIGIN`).
- `APP_ORIGIN` уже задан вами в `./.env`; workflow добавляет только отсутствующие ключи и не перезаписывает его.

## Схема доступа

По вашему выбору используется **один хост**, но разные пользователи и пароли для backend и frontend. Порт по умолчанию `2121`; удалённый каталог всегда `./`.

| Имя                     | Где                 | Назначение                                                                   |
| ----------------------- | ------------------- | ---------------------------------------------------------------------------- |
| `FTP_HOST`              | variable или secret | общий FTP-хост, без `ftp://`                                                 |
| `FTP_PORT`              | variable            | общий порт, по умолчанию `2121`                                              |
| `FTP_BACKEND_PORT`      | variable            | необязательный порт backend                                                  |
| `FTP_FRONTEND_PORT`     | variable            | необязательный порт frontend                                                 |
| `FTP_BACKEND_USER`      | variable или secret | пользователь backend                                                         |
| `FTP_BACKEND_PASSWORD`  | **secret**          | пароль backend                                                               |
| `FTP_FRONTEND_USER`     | variable или secret | пользователь frontend                                                        |
| `FTP_FRONTEND_PASSWORD` | **secret**          | пароль frontend                                                              |
| `FTP_VERIFY_CERT`       | variable            | `true` по умолчанию; `false` только для проверенного self-signed сертификата |
| `FTP_TLS_MODE`          | variable            | `explicit` по умолчанию; `implicit` для TLS сразу на нестандартном порту     |
| `APP_ORIGIN`            | variable            | необязательный внешний origin                                                |
| `API_PROXY_ORIGIN`      | variable            | публичный API origin для frontend, по умолчанию задан в workflow             |
| `BOOTSTRAP_OWNER_EMAIL` | variable            | email первого владельца, по умолчанию `owner@ultra.family`                   |

По умолчанию используется явный FTPS (`ftp://` + `AUTH TLS`): `ftp:ssl-force`, `ftp:ssl-protect-data`, passive mode. Если хостинг требует неявный FTPS, когда TLS начинается сразу на порту `2121`, установите `FTP_TLS_MODE=implicit` — workflow переключится на схему `ftps://`. Обычный FTP и SSH не применяются.

Пароль передаётся только через `LFTP_PASSWORD` вместе с обязательным флагом `lftp --env-password`, а не в командной строке. Секреты должны быть созданы на уровне репозитория: **Settings → Secrets and variables → Actions → Secrets**. Если использовать Environment secrets, job должен явно ссылаться на этот environment.

## Куда именно загружаются файлы

В runner GitHub Actions artifact распаковывается во временную локальную папку `payload/`. Это **не каталог на FTP**.

`scripts/ftp-upload.sh` делает `lcd payload/` и вызывает `mirror -R` без source/target: по документации `lftp` в этом случае используются текущий локальный и текущий удалённый каталоги [4](https://linux.die.net/man/1/lftp). Поэтому на FTP загружается **содержимое** payload прямо в корень `./`:

```text
./package.json
./package-lock.json
./RELEASE.json
./FTP-NOTES.txt
./ENV-SETUP.txt
./.nvmrc
./.env.example
./.env
./apps/web/.next/...
./apps/web/public/...
./packages/contracts/...
```

Папок `artifact/` или `payload/` на FTP создаваться не должно. Если от предыдущих запусков уже осталась `./artifact/`, удалите её вручную в файловом менеджере хостинга: `mirror -R` намеренно работает без `--delete` и не удаляет старые файлы.

## Запуск

В **Actions → FTP deploy → Run workflow** выберите:

- `target`: `backend`, `frontend` или `both`;
- `version`: необязательная версия релиза. Если оставить пустым, берётся имя тега или короткий SHA.

Push тега `v*` автоматически загружает **оба** payload'а.

Каждый job загрузки:

1. Скачивает свой GitHub Artifact.
2. Проверяет FTPS-соединение и листинг корня; при ошибке соединения деплой прерывается.
3. Читает существующий `.env` из корня FTP-аккаунта.
4. Генерирует автоматические значения.
5. Дописывает **только отсутствующие ключи**; существующие строки, комментарии и вручную введённые значения сохраняются.
6. Загружает предсобранный backend `dist` или frontend `.next` через `mirror -R` без `--delete`, затем выгружает объединённый `.env`.

## Что попадает в `.env` автоматически

Общие: `NODE_ENV`, `APP_VERSION`, при наличии `APP_ORIGIN`.

Backend: `SESSION_SECRET`, `BOOTSTRAP_OWNER_PASSWORD`, `BOOTSTRAP_OWNER_EMAIL`, `API_PORT`, `DB_DRIVER`, `DATABASE_SSL`, `DB_POOL_SIZE`, `PGLITE_DATA_DIR`, `SEED_DEMO_DATA`.

Frontend: `WEB_PORT=26287`, `NEXT_PUBLIC_DEMO_PASSWORD`, `API_PROXY_ORIGIN=https://api.family.vladislavb.qzz.io`.

`SESSION_SECRET` и `BOOTSTRAP_OWNER_PASSWORD` генерируются случайно. Сгенерированный пароль первого владельца можно прочитать в `.env` на FTP; workflow не выводит его в логи. Повторный деплой не перезаписывает уже созданные значения.

Канонический `.env` находится в корне каждого релиза. `apps/api/src/config.ts` и `apps/web/next.config.mjs` ищут его от текущего каталога вверх, поэтому отдельные `apps/api/.env` и `apps/web/.env` создавать не нужно.

## Как настроить `.env`

У **каждого FTP-аккаунта свой корневой `.env`**: отдельно для backend и отдельно для frontend. Редактируйте именно `./.env` в корне FTP-аккаунта, а не файл внутри старой `artifact/`, не `apps/api/.env` и не `apps/web/.env`. Шаблоны лежат рядом: `.env.example` и `ENV-SETUP.txt`.

### 1. Что делает workflow сам

После каждого запуска workflow читает существующий `./.env`, генерирует автоматические значения и дописывает **только отсутствующие ключи**. Ваши строки, комментарии и уже введённые значения не перезаписываются. Если `.env` ещё не было, он создаётся.

Автоматически:

- общие: `NODE_ENV=production`, `APP_VERSION`, `APP_ORIGIN` при наличии одноимённой GitHub Variable;
- backend: `SESSION_SECRET`, `BOOTSTRAP_OWNER_PASSWORD`, `BOOTSTRAP_OWNER_EMAIL`, `API_PORT=3001`, `DB_DRIVER=postgres`, `DATABASE_SSL=false`, `DB_POOL_SIZE=8`, `PGLITE_DATA_DIR=.data/pglite`, `SEED_DEMO_DATA=false`;
- frontend: `WEB_PORT=26287`, `NEXT_PUBLIC_DEMO_PASSWORD=`, `API_PROXY_ORIGIN=https://api.family.vladislavb.qzz.io`.

`BOOTSTRAP_OWNER_PASSWORD` генерируется один раз. После первого деплоя откройте backend `./.env`, прочитайте этот пароль и используйте его вместе с `BOOTSTRAP_OWNER_EMAIL` для первого входа. Не удаляйте и не дублируйте эту строку; если нужен другой пароль до первого входа — отредактируйте существующую строку.

### 2. Что ввести в backend `.env`

Минимум:

```dotenv
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DATABASE
APP_ORIGIN=https://family.example
```

`DATABASE_URL` обязателен: в production API не запустится без PostgreSQL. `APP_ORIGIN` должен точно совпадать с публичным origin сайта, без завершающего `/`; он участвует в проверке origin/CORS. При необходимости измените уже существующие автоматические строки, а не добавляйте дубликаты:

```dotenv
# примеры только если значения по умолчанию не подходят
# API_PORT=3101
# DATABASE_SSL=true
# DB_POOL_SIZE=8
# BOOTSTRAP_OWNER_EMAIL=admin@family.example
# SMTP_URL=smtp://...
# TELEGRAM_BOT_TOKEN=...
```

### 3. Что ввести в frontend `.env`

Обычно нужен адрес, по которому Next.js процесс может достучаться до Nest API:

```dotenv
API_PROXY_ORIGIN=https://api.family.vladislavb.qzz.io
```

Если API слушает другой порт/хост, укажите его. При необходимости:

```dotenv
# WEB_PORT=26287
# APP_ORIGIN=https://family.example
```

`APP_ORIGIN` уже задан вами в `./.env` и не перезаписывается. `API_PROXY_ORIGIN` по умолчанию равен `https://api.family.vladislavb.qzz.io`; одноимённая **GitHub Variable** может задать другое значение, но только для отсутствующего ключа в `.env`.

### 4. После правки

1. Сохраните `./.env` в корне соответствующего FTP-аккаунта.
2. Перезапустите процессы в админке сервера: `npm run start:prod -w @ufos/api` и `npm run start -w @ufos/web`. Сборка на хостинге не нужна.
3. Первый вход сделайте с email/паролем из backend `.env`.
4. Остальные первичные настройки — название семьи, пользователи, модули и т.п. — введите в уже существующей админке платформы. Новый setup-визард не добавлялся.

Если админка сервера задаёт переменные окружения напрямую, они имеют приоритет над `.env`: загрузчик заполняет только те `process.env`, которые ещё не определены.

## Первый запуск на сервере

Через админку сервера/хостинга, в корне каждого FTP-аккаунта:

```bash
npm ci --omit=dev
# backend
npm run start:prod -w @ufos/api
# frontend, порт 26287
npm run start -w @ufos/web
```

Frontend уже собран в Actions, поэтому `npm run build -w @ufos/web` на хостинге не запускайте. `API_PROXY_ORIGIN` зашит в `.next` во время сборки; если этот адрес изменится, перезапустите `ftp.yml`, чтобы пересобрать frontend.

Команды запуска, порты, reverse proxy и HTTPS настраиваются в админке сервера. Миграции применяет сам API при старте. Workflow только загружает файлы.

## Откат

Запустите `ftp.yml` с предыдущей `version` и нужным `target`, либо загрузите сохранённый предыдущий artifact вручную. `mirror -R` не удаляет лишние файлы, поэтому перед откатом при необходимости очистите каталог релиза в админке сервера. Восстановление PostgreSQL выполняется отдельно по [BACKUP-RESTORE.md](BACKUP-RESTORE.md); workflow не трогает БД.

## Если пишет «неверный пароль»

Самая частая причина в этой конфигурации была исправлена: `LFTP_PASSWORD` без `--env-password` игнорируется `lftp`, поэтому сервер получал пустой/анонимный пароль. Теперь workflow вызывает `lftp --env-password`.

Если ошибка осталась, проверьте по порядку:

1. **Секрет на уровне репозитория**, а не только в Environment: `FTP_BACKEND_PASSWORD` и `FTP_FRONTEND_PASSWORD`.
2. Пересохраните секрет без кавычек, пробелов в начале/конце и без завершающего перевода строки. Workflow теперь явно ругается на `
`/`
` и предупреждает о крайних пробелах.
3. Убедитесь, что пара user/password соответствует выбранному `target`: backend secret не подходит к frontend пользователю и наоборот. Имя пользователя часто выглядит как `user@example.com` — вносите его целиком.
4. В логах job смотрите строку `FTP settings:` и `FTPS diagnostics:`: там видны host, port, user, TLS mode, `password_length`, но не сам пароль.
5. Проверьте режим TLS в панели хостинга. Для неявного FTPS установите variable `FTP_TLS_MODE=implicit`; для обычного `AUTH TLS` оставьте `explicit`.
6. Для self-signed сертификата установите `FTP_VERIFY_CERT=false`; сначала убедитесь, что это действительно ваш хост.

Пришлите строки ошибки `lftp` и обе безопасные диагностические строки без пароля, если проблема повторится.

## Если пишет `500 SITE support is disabled`

Это не ошибка пароля: `mirror -R` пытался скопировать локальные права доступа через `SITE CHMOD`/`MFF`, а хостинг отключил команду `SITE`. `SITE CHMOD` не является обязательной FTP-командой [5](https://forum.filezilla-project.org/viewtopic.php?t=49864), а `lftp` поддерживает `--no-perms` и `mirror:set-permissions off` [3](https://manpages.org/lftp).

Workflow теперь:

- не копирует chmod-биты: `mirror --no-perms --no-umask` и `set mirror:set-permissions no`;
- отключает `SITE CHMOD`, `SITE UTIME` и перегруженный `MDTM`;
- оставляет права, которые сервер назначает загруженным файлам по умолчанию.

Если какому-то файлу нужен особый executable bit, выставьте его в панели хостинга/админке сервера, а не через FTP-деплой. Повторно запускать `chmod` в workflow не нужно.

## Если frontend загрузил только `public/` и `.next/trace`

Причина — скрытые файлы/папки. Папка Next.js `.next/` начинается с точки, а `actions/upload-artifact@v4` по умолчанию исключает hidden files и hidden directories [2](https://github.com/actions/upload-artifact/blob/v4/README.md). Кроме того, некоторые FTP-серверы не показывают dot-файлы в листинге; для этого `lftp` рекомендует `set ftp:list-options -a` [5](https://linux.die.net/man/1/lftp).

Исправлено:

- у обоих GitHub Artifact включён `include-hidden-files: true`;
- в `path` явно исключены только реальные секреты `.env`, `.env.local`, `.env.*.local`, `node_modules/`, `.git/`; `.env.example`, `.nvmrc`, `.next/**`, `.next/static/**` теперь попадают в artifact;
- `lftp` получает `set ftp:list-options -a`;
- вместо широких regex `--exclude .env` используются точные `--exclude-glob .env` и т.п., чтобы не вырезать `.env.example`;
- package job и upload job проверяют `.next/trace`, `.next/static/`, `public/`, `.env.example` и собранный backend `dist/main.js`.

Старые неполные файлы или `./artifact/` можно удалить вручную: `mirror -R` без `--delete` не чистит лишнее.

## Ограничения

- FTPS-загрузка не даёт атомарного переключения `current`, health check и автоматического rollback; это делает админка сервера.
- Нет SSH, SFTP, Docker Compose и удалённых shell-команд в Actions.
- `scripts/deploy-sftp.sh` и SSH-деплой удалены.
- Файлы `Dockerfile.*` и `docker-compose.yml` остаются в репозитории как альтернативные артефакты, но в этом сценарии не используются.
- Реальный VPS, FTP-пользователи, секреты и production `.env` в этой рабочей среде не настраивались.
