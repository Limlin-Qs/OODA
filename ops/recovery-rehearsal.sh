#!/usr/bin/env bash
set -euo pipefail

: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL must be provided through the environment}"
: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL must be provided through the environment}"
backup_dir="${BACKUP_DIR:-./backups/rehearsal}"
mkdir -p "$backup_dir"
backup_file="${backup_dir%/}/rehearsal-$(date -u +%Y%m%dT%H%M%SZ).dump"

pg_dump --format=custom --no-owner --file="$backup_file" "$SOURCE_DATABASE_URL"
pg_restore --list "$backup_file" >/dev/null
pg_restore --dbname="$TARGET_DATABASE_URL" --clean --if-exists --no-owner --exit-on-error "$backup_file"
psql --set=ON_ERROR_STOP=1 --command='SELECT 1 FROM _sharework_schema_migrations LIMIT 1' "$TARGET_DATABASE_URL" >/dev/null
printf 'Recovery rehearsal passed: %s -> configured target database\n' "$backup_file"
