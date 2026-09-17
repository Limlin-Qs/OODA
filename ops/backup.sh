#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be provided through the environment}"
backup_dir="${BACKUP_DIR:-./backups}"
mkdir -p "$backup_dir"
backup_file="${backup_dir%/}/sharework-$(date -u +%Y%m%dT%H%M%SZ).dump"

pg_dump --format=custom --no-owner --file="$backup_file" "$DATABASE_URL"
pg_restore --list "$backup_file" >/dev/null
printf 'Backup created: %s\n' "$backup_file"
