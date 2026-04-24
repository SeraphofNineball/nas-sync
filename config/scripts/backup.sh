#!/bin/sh
# Versioned backup: syncs source to destination, but moves overwritten/deleted
# files into a dated folder instead of permanently deleting them.
# Lets you recover older versions of files.
#
# Usage: backup.sh <source_remote>:<path> <dest_remote>:<path>
# Example in crontab: /scripts/backup.sh ugreen:Documents wdnas:Documents

SOURCE="${1}"
DEST="${2}"
VERSIONS_DIR="${2}-versions/$(date +%Y%m%d-%H%M%S)"
LOG="/logs/backup-$(date +%Y%m%d-%H%M%S).log"

echo "[$(date)] Starting backup: $SOURCE -> $DEST (versions: $VERSIONS_DIR)" | tee -a "$LOG"

rclone sync "$SOURCE" "$DEST" \
  --backup-dir "$VERSIONS_DIR" \
  --log-file="$LOG" \
  --log-level=INFO \
  --stats=30s \
  --checksum

echo "[$(date)] Backup complete." | tee -a "$LOG"
