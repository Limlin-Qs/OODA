#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be provided through the environment}"
: "${BACKUP_FILE:?BACKUP_FILE must point to a verified custom-format dump}"

if [[ "${CONFIRM_RESTORE:-}" != "YES" ]]; then
  printf 'Refusing restore. Set CONFIRM_RESTORE=YES after verifying the target database and backup.\n' >&2
  exit 2
fi

pg_restore --dbname="$DATABASE_URL" --clean --if-exists --no-owner --exit-on-error "$BACKUP_FILE"
printf 'Restore completed into the configured target database.\n'
