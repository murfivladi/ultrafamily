# Деплой через GitHub Actions по FTP

Автоматизация делает **только загрузку файлов по FTPS**. Она не выполняет SSH-команды, не перезапускает сервисы, не применяет миграции вручную и не использует Docker Compose. Backend и frontend загружаются отдельно, в корень `./` своих FTP-аккаунтов.

- `.github/workflows/ci.yml` — проверки на каждый push/PR.
- `.github/workflows/ftp.yml` — сборка двух payload'ов и раздельная загрузка.
- `scripts/package-ftp.sh` — собирает `releases/ftp/backend` и `releases/ftp/frontend`.
- `scripts/ftp-upload.sh` — FTPS-загрузка одного payload'а и слияние `.env`.
- `scripts/ftp-env.mjs` — генерирует автоматические значения.
- `scripts/merge-env.mjs` — дописывает только недостающие ключи, сохраняя ваши значения.

SSH-workflow, `scripts/deploy-remote.sh` и SFTP-скрипт удалены.

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
| `API_PROXY_ORIGIN`      | variable            | необязательный внутренний API origin для frontend                            |
| `BOOTSTRAP_OWNER_EMAIL` | variable            | email первого владельца, по умолчанию `owner@ultra.family`                   |

По умолчанию используется явный FTPS (`ftp://` + `AUTH TLS`): `ftp:ssl-force`, `ftp:ssl-protect-data`, passive mode. Если хостинг требует неявный FTPS, когда TLS начинается сразу на порту `2121`, установите `FTP_TLS_MODE=implicit` — workflow переключится на схему `ftps://`. Обычный FTP и SSH не применяются.

Пароль передаётся только через `LFTP_PASSWORD` вместе с обязательным флагом `lftp --env-password`, а не в командной строке. Секреты должны быть созданы на уровне репозитория: **Settings → Secrets and variables → Actions → Secrets**. Если использовать Environment secrets, job должен явно ссылаться на этот environment.

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
6. Загружает файлы релиза через `mirror -R` без `--delete`, затем выгружает объединённый `.env`.

## Что попадает в `.env` автоматически

Общие: `NODE_ENV`, `APP_VERSION`, при наличии `APP_ORIGIN`.

Backend: `SESSION_SECRET`, `BOOTSTRAP_OWNER_PASSWORD`, `BOOTSTRAP_OWNER_EMAIL`, `API_PORT`, `DB_DRIVER`, `DATABASE_SSL`, `DB_POOL_SIZE`, `PGLITE_DATA_DIR`, `SEED_DEMO_DATA`.

Frontend: `WEB_PORT`, `NEXT_PUBLIC_DEMO_PASSWORD`, при наличии `API_PROXY_ORIGIN`.

`SESSION_SECRET` и `BOOTSTRAP_OWNER_PASSWORD` генерируются случайно. Сгенерированный пароль первого владельца можно прочитать в `.env` на FTP; workflow не выводит его в логи. Повторный деплой не перезаписывает уже созданные значения.

Канонический `.env` находится в корне каждого релиза. `apps/api/src/config.ts` и `apps/web/next.config.mjs` ищут его от текущего каталога вверх, поэтому отдельные `apps/api/.env` и `apps/web/.env` создавать не нужно.

## Что вводите вы

В тот же `.env` вручную добавьте installation-specific значения, например:

```dotenv
DATABASE_URL=postgres://…
APP_ORIGIN=https://family.example
API_PROXY_ORIGIN=http://127.0.0.1:3001
```

Остальные настройки первого запуска вводятся в уже существующей админке платформы; новый setup-визард не добавлялся. Шаблон всех ключей лежит в `.env.example` внутри payload'а.

## Первый запуск на сервере

Через админку сервера/хостинга:

```bash
npm ci --omit=dev
# backend
npm run start:prod -w @ufos/api
# frontend
npm run start -w @ufos/web
```

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

## Ограничения

- FTPS-загрузка не даёт атомарного переключения `current`, health check и автоматического rollback; это делает админка сервера.
- Нет SSH, SFTP, Docker Compose и удалённых shell-команд в Actions.
- `scripts/deploy-sftp.sh` и SSH-деплой удалены.
- Файлы `Dockerfile.*` и `docker-compose.yml` остаются в репозитории как альтернативные артефакты, но в этом сценарии не используются.
- Реальный VPS, FTP-пользователи, секреты и production `.env` в этой рабочей среде не настраивались.
