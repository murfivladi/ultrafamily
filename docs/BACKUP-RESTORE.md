# Резервное копирование и восстановление

> Копия на том же VPS не защищает от отказа диска, удаления сервера, ошибки миграции, взлома или потери аккаунта хостинга. Для production обязательна минимум одна автоматическая шифрованная копия вне VPS.

## Что копируется

`scripts/backup.sh` создаёт один versioned bundle:

- `database.dump` — `pg_dump --format=custom --no-owner --no-privileges`;
- `files.tar.gz` — будущие managed files из `FILES_DIR` (Stage A пока не использует файловый модуль);
- `manifest.json` — product/version/timestamp;
- `SHA256SUMS` — checksums contents.

Archive name: `ufos-<UTC timestamp>.tar.gz`. Database and files are collected in one run; future modules must use a coordinated snapshot/lock if they write large media continuously.

## Шифрование и внешняя копия

```bash
DATABASE_URL='postgres://…' \
AGE_RECIPIENT='age1…' \
BACKUP_REMOTE='remote:ufos' \
BACKUP_RETENTION_DAYS=30 \
npm run db:backup
```

- With `AGE_RECIPIENT`, script creates `.tar.gz.age` and removes the plaintext archive.
- With `BACKUP_REMOTE`, `rclone copyto` sends the encrypted archive outside the VPS.
- Without these variables the script prints explicit warnings and creates only a local unencrypted copy.

Храните private age identity **вне VPS**. Не помещайте recipient/identity, `.env`, DB URL or API keys into the backup archive.

## Расписание

Example systemd timer or cron, twice daily:

```cron
17 3,15 * * * cd /srv/ufos/current && /usr/bin/env DATABASE_URL="$(cat /etc/ufos/db-url)" AGE_RECIPIENT=age1… BACKUP_REMOTE=remote:ufos /usr/bin/npm run db:backup >> /var/log/ufos-backup.log 2>&1
```

Alerts must be configured on non-zero exit. Review logs for `off-VPS copy completed`; no secrets should appear there.

## Восстановление

```bash
DATABASE_URL='postgres://…' \
AGE_IDENTITY='/etc/ufos/age-key.txt' \
FILES_DIR='/var/lib/ufos/files' \
npm run db:restore -- /path/to/ufos-20261103T030000Z.tar.gz.age
```

The script:

1. Decrypts if `.age` is used.
2. Verifies `SHA256SUMS`.
3. Requires typing `RESTORE`.
4. Makes a `pre-restore-*.dump` safety copy.
5. Runs `pg_restore --clean --if-exists`.
6. Moves current files to `.pre-restore-*` instead of deleting them.
7. Extracts the archived files.

After restore:

```bash
curl -fsS https://family.example/api/health
npm run smoke
# sign in, open /admin and verify audit chain
```

## Regular restore drill

At least monthly and before every schema-changing release:

1. Restore the newest encrypted off-VPS copy into a disposable database and file directory.
2. Verify checksum, schema version, users, memberships, module toggles and audit chain.
3. Compare expected record counts and public posts.
4. Confirm no secrets or private metadata leaked into logs.
5. Record date/result in the operations log.

A backup that has never been restored is not a backup.

## Disaster recovery checklist

- [ ] Off-VPS encrypted copy accessible without the original VPS credentials.
- [ ] `SESSION_SECRET`, DB credentials, age identity and deployment env recoverable separately.
- [ ] Previous release archive still available for rollback.
- [ ] DNS/Cloudflare origin can be pointed to a replacement host.
- [ ] Restore procedure tested on clean host.
- [ ] Responsible adult informed before real family data is restored.
- [ ] Monitoring/alerts reinstated.
- [ ] Audit chain verified after recovery.

Stage A scripts are a foundation; they do not yet replace a full monitored backup system with immutable retention, point-in-time recovery and automated restore tests.
