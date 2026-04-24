#!/bin/sh
# One-way sync: copies new and changed files from source to destination.
# Does NOT delete files on the destination that were removed from source.
#
# Usage: sync.sh <source_remote>:<path> <dest_remote>:<path>
# Example in crontab: /scripts/sync.sh ugreen:Media wdnas:Media

SOURCE="${1}"
DEST="${2}"
LOG="/logs/sync-$(date +%Y%m%d-%H%M%S).log"

echo "[$(date)] Starting sync: $SOURCE -> $DEST" | tee -a "$LOG"

rclone copy "$SOURCE" "$DEST" \
  --log-file="$LOG" \
  --log-level=INFO \
  --stats=30s \
  --checksum

echo "[$(date)] Sync complete." | tee -a "$LOG"
