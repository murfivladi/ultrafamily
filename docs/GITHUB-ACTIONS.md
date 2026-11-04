# Деплой через GitHub Actions

В репозитории есть два workflow:

- `.github/workflows/ci.yml` — на каждый `push` и `pull_request`: `npm ci`, `format:check`, `check` и production `build`.
- `.github/workflows/deploy.yml` — ручной запуск (`workflow_dispatch`) или push тега `v*`: сборка версионированного архива, проверка SHA-256, загрузка артефакта в GitHub и, для режима `deploy`, доставка на VPS по SSH/SCP.

Автоматический деплой из произвольной ветки намеренно выключен. Production-окружение должно переключаться вручную или из проверенного тега.

## 1. Подготовить VPS

На сервере должны быть:

- Node.js 22 и npm;
- PostgreSQL и `pg_dump`;
- `age`, `rclone`, `curl`, `tar`, `sha256sum`;
- reverse proxy с HTTPS и точным `APP_ORIGIN`;
- сервисы `ufos-api` и `ufos-web` под systemd/Supervisor;
- пользователь деплоя с доступом по SSH и правом выполнять команду рестарта;
- каталог релизов, например `/srv/ufos/releases`, и симлинк `/srv/ufos/current`;
- файл окружения вне каталога релиза, например `/etc/ufos/env`.

`/etc/ufos/env` должен содержать production-секреты и настройки, в том числе:

```dotenv
DATABASE_URL=postgres://…
SESSION_SECRET=…
BOOTSTRAP_OWNER_PASSWORD=…
APP_ORIGIN=https://family.example
AGE_RECIPIENT=age1…
BACKUP_REMOTE=remote:ufos
RCLONE_CONFIG=/etc/ufos/rclone.conf
```

Не добавляйте этот файл в Git, архив релиза или чат. Именно он используется для `npm run db:backup` перед переключением `current`.

## 2. Настроить GitHub Environment

Создайте Environment `production` в **Settings → Environments**. Рекомендуется включить required reviewers и, при необходимости, ограничить деплой проверенными ветками/тегами.

Задайте variables или secrets в репозитории/окружении:

| Имя                  | Где                 | Назначение                                              |
| -------------------- | ------------------- | ------------------------------------------------------- |
| `DEPLOY_HOST`        | variable или secret | хост VPS                                                |
| `DEPLOY_USER`        | variable или secret | SSH-пользователь                                        |
| `DEPLOY_PORT`        | variable            | SSH-порт, по умолчанию `22`                             |
| `DEPLOY_ROOT`        | variable            | корень релизов, по умолчанию `/srv/ufos`                |
| `DEPLOY_ENV_FILE`    | variable            | файл окружения, по умолчанию `/etc/ufos/env`            |
| `DEPLOY_RESTART_CMD` | variable            | по умолчанию `sudo systemctl restart ufos-api ufos-web` |
| `DEPLOY_BASE_URL`    | variable            | внешний HTTPS URL, например `https://family.example`    |
| `DEPLOY_SSH_KEY`     | **secret**          | приватный ed25519-ключ без passphrase                   |
| `DEPLOY_KNOWN_HOSTS` | variable или secret | проверенный `known_hosts` для VPS                       |

Пример получения `known_hosts`:

```bash
ssh-keyscan -t ed25519 -p 22 family.example
```

Сверьте отпечаток с независимым источником, затем добавьте строку в `DEPLOY_KNOWN_HOSTS`. Workflow использует `StrictHostKeyChecking=yes`; `StrictHostKeyChecking=no` не применяется.

## 3. Запустить деплой

### Безопасная проверка без обращения к VPS

В **Actions → Deploy → Run workflow** выберите `mode: artifact-only`. Workflow выполнит тесты, соберёт архив, проверит контрольную сумму и сохранит артефакт, но не будет обращаться к серверу.

### Обычный деплой

Там же выберите `mode: deploy`, при желании задайте `version`, например `v0.1.0-stage-b.1`, либо оставьте поле пустым: тогда используется имя тега или короткий SHA коммита.

Push тега `v*` запускает деплой автоматически; ручной запуск доступен с текущей ветки.

## 4. Что делает deploy job

1. Скачивает собранный `.tar.gz` и `.sha256` из артефакта.
2. Проверяет контрольную сумму ещё раз.
3. Загружает файлы в `$DEPLOY_ROOT/releases/` по SCP.
4. На VPS проверяет контрольную сумму повторно.
5. Если `current` уже существует, запускает `npm run db:backup` из старого релиза. Backup должен быть зашифрован `age` и скопирован вне VPS через `rclone`; без `DATABASE_URL`, `AGE_RECIPIENT`, `BACKUP_REMOTE` и утилит деплой прерывается.
6. Распаковывает версию в отдельный каталог, выполняет `npm ci --omit=dev`.
7. Атомарно переключает `current` через `current.next` и `mv -Tf`.
8. Перезапускает сервисы командой `DEPLOY_RESTART_CMD`.
9. Ждёт `/api/health`, затем запускает `npm run smoke` против `DEPLOY_BASE_URL`.
10. Вся серверная логика находится в `scripts/deploy-remote.sh` и передаётся на VPS по SSH stdin; CI проверяет синтаксис всех `scripts/*.sh` через `bash -n`.
11. При неудачном health check возвращает симлинк к предыдущему релизу и перезапускает сервисы.

Миграции применяются самим API при старте. Workflow не запускает их отдельно.

## 5. Откат

Автоматический откат меняет только симлинк `current`. Если новая версия уже применила несовместимую миграцию, дополнительно восстановите PostgreSQL из копии, созданной перед деплоем, по [BACKUP-RESTORE.md](BACKUP-RESTORE.md). Журнал аудита не очищается.

## 6. Ограничения

- GitHub Actions не хранит production-секреты приложения: они остаются в `/etc/ufos/env` на VPS.
- Workflow не использует Docker Compose. Для Compose-сценария см. [DEPLOYMENT.md](DEPLOYMENT.md).
- `scripts/deploy-sftp.sh` остаётся альтернативой; этот workflow использует SCP/SSH напрямую.
- Первый деплой пропускает backup, потому что предыдущего `current` ещё нет.
- SSE требует, чтобы reverse proxy не буферизировал `text/event-stream`; `/caldav/:path*` должен сохранять завершающий слэш.
- Workflow не запускает `docker compose` и не вызывает `scripts/deploy-sftp.sh`; он использует SCP/SSH и `scripts/deploy-remote.sh`.
- Реальный VPS, SSH-ключи и GitHub Environment в этой рабочей среде не настраивались.
