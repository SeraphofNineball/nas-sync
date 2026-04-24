#!/bin/sh
# Mirror: destination becomes an exact copy of source.
# Files deleted on source will also be deleted on destination.
#
# Usage: mirror.sh <source_remote>:<path> <dest_remote>:<path>
# Example in crontab: /scripts/mirror.sh ugreen:Backups wdnas:Backups

SOURCE="${1}"
DEST="${2}"
LOG="/logs/mirror-$(date +%Y%m%d-%H%M%S).log"

echo "[$(date)] Starting mirror: $SOURCE -> $DEST" | tee -a "$LOG"

rclone sync "$SOURCE" "$DEST" \
  --log-file="$LOG" \
  --log-level=INFO \
  --stats=30s \
  --checksum

echo "[$(date)] Mirror complete." | tee -a "$LOG"
