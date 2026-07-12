#!/usr/bin/env bash
# Firefly III database backup (SPEC section 11). Runs ON THE LXC that hosts the
# Dockge stack, not on the PM2 host. Dumps MariaDB from inside the db container,
# gzips to a dated file, verifies the gzip, and rotates old copies.
#
# Install: copy next to the stack, make executable, then cron it, e.g.
#   15 3 * * * /opt/stacks/fincore-firefly/backup-firefly-db.sh >> /var/log/firefly-backup.log 2>&1
#
# BACKUP_DIR should leave the LXC (NFS/CIFS mount to the NAS or another node);
# a backup that dies with the host is not a backup.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/mnt/backups/firefly}"
KEEP="${KEEP:-14}"
CONTAINER="${CONTAINER:-fincore-firefly-db}"
STACK_ENV="${STACK_ENV:-$(dirname "$0")/.env}"

# Pull DB credentials from the stack .env, tolerating quoted values. The password
# is handed to the dump via the MYSQL_PWD environment variable inside the exec,
# never as a command-line argument: argv is world-readable in ps and /proc for the
# whole dump, every night.
env_val() {
  local v
  v=$(grep -E "^$1=" "$STACK_ENV" | head -1 | cut -d= -f2-)
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}
DB_DATABASE=$(env_val DB_DATABASE)
DB_USERNAME=$(env_val DB_USERNAME)
DB_PASSWORD=$(env_val DB_PASSWORD)

# No mkdir: the destination should be a mount that leaves the LXC; creating it
# here would silently turn a dropped mount into local backups that die with the host.
[ -d "$BACKUP_DIR" ] || { echo "BACKUP_DIR $BACKUP_DIR does not exist. Is the backup mount down?"; exit 1; }
STAMP=$(date +%F)
DEST="$BACKUP_DIR/firefly-$STAMP.sql.gz"
TMP="$DEST.tmp"

# --single-transaction: consistent snapshot without locking Firefly out.
docker exec -e MYSQL_PWD="$DB_PASSWORD" "$CONTAINER" mariadb-dump \
  --single-transaction --quick --routines --triggers \
  -u"$DB_USERNAME" "$DB_DATABASE" | gzip > "$TMP"

# Verify the archive is a valid gzip with content before giving it a real name.
gzip -t "$TMP"
[ "$(stat -c%s "$TMP")" -gt 10000 ] || { echo "dump suspiciously small, refusing"; rm -f "$TMP"; exit 1; }
mv "$TMP" "$DEST"
echo "backup ok: $DEST"

# Rotate.
ls -1 "$BACKUP_DIR"/firefly-????-??-??.sql.gz 2>/dev/null | sort -r | tail -n +$((KEEP + 1)) | xargs -r rm -v
