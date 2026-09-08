#!/bin/bash
# career-ops user-layer backup — nightly 23:30 via ~/Library/LaunchAgents/io.career-ops.backup.plist
#
# Everything personal in this repo is gitignored (CV, profile, portals, tracker, reports,
# PDFs, contacts, plugin config) and existed only on this Mac until a `git clean -fdX`
# sweep wiped it on 2026-09-07. This mirrors that layer into the PRIVATE repo
# prasta1/backup-career under career-ops/ and pushes. Allowlist only: never .env,
# never node_modules, caches or logs. Run by hand any time: scheduling/backup-user-layer.sh
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$HOME/Projects/backups/backup-career"
DST="$REPO/career-ops"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
[ -d "$REPO/.git" ] || { echo "backup repo missing at $REPO — gh repo clone prasta1/backup-career there first"; exit 1; }
mkdir -p "$DST"

# Excludes first (first match wins), then the allowlist, then drop everything else.
rsync -a --delete \
  --exclude='*.log' --exclude='/data/cache/' --exclude='.DS_Store' \
  --include='/cv.md' --include='/article-digest.md' --include='/voice-dna.md' --include='/portals.yml' \
  --include='/plugins.lock' --include='/.mcp.json' --include='/.career-ops-data' \
  --include='/config/' --include='/config/profile.yml' --include='/config/plugins.yml' \
  --include='/modes/' --include='/modes/_profile.md' --include='/modes/_custom.md' --include='/modes/_brief.md' \
  --include='/data/***' --include='/reports/***' --include='/output/***' --include='/jds/***' \
  --include='/interview-prep/***' --include='/documents/***' \
  --include='/batch/' --include='/batch/tracker-additions/***' \
  --exclude='*' \
  "$SRC/" "$DST/"

# Belt and braces: the allowlist never copies .env, but refuse to commit if a token slipped in.
if grep -rIl -E 'pat-(na|eu)[0-9]-[0-9a-f]{8}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|ntn_[A-Za-z0-9]{20,}' "$DST" 2>/dev/null | grep -q .; then
  echo "$(date '+%F %T') ABORT: token-like string found in mirror — not committing"; exit 2
fi

cd "$REPO"
git add -A -- career-ops   # scoped to the mirror dir, which rsync built from the allowlist above
if git diff --cached --quiet; then echo "$(date '+%F %T') no changes"; exit 0; fi
git commit -q -m "career-ops user layer $(date '+%F %H:%M')"
git push -q origin main
echo "$(date '+%F %T') pushed $(git rev-parse --short HEAD): $(git diff --stat HEAD~1 | tail -1)"
