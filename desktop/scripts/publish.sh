#!/usr/bin/env bash
# Publish desktop installers to game.liamhosfeld.com/download (same bucket the game server already
# reads; the server streams the files through the load balancer -> Cloud Run path).
#   desktop/scripts/publish.sh [dist-dir] [version]
# Needs gcloud authenticated with write access to the bucket (CI uses Workload Identity; locally
# `gcloud auth activate-service-account --key-file ...`). Merges with builds already published for
# other platforms of the same version, so mac/win/linux can be published from different machines.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
DIST="${1:-$here/dist}"
VERSION="${2:-$(node -p "require('$here/package.json').version")}"
BUCKET="${DOWNLOAD_BUCKET:-${SNAPSHOT_BUCKET:-stem-471602-se-snapshots}}"
tmp="$(mktemp -d)"
node "$here/scripts/manifest.mjs" "$DIST" "$VERSION" > "$tmp/new.json"
for f in "$DIST"/*.dmg "$DIST"/*.zip "$DIST"/*.exe "$DIST"/*.AppImage; do
  [ -f "$f" ] || continue
  gcloud storage cp "$f" "gs://$BUCKET/downloads/$VERSION/$(basename "$f")"
done
# merge: keep other platforms' entries for this version
if gcloud storage cp "gs://$BUCKET/downloads/manifest.json" "$tmp/old.json" 2>/dev/null; then
  node -e "
    const fs=require('fs');const o=JSON.parse(fs.readFileSync('$tmp/old.json'));const n=JSON.parse(fs.readFileSync('$tmp/new.json'));
    const keep=o.version===n.version?o.files.filter(f=>!n.files.some(x=>x.platform===f.platform)):[];
    n.files=[...keep,...n.files];fs.writeFileSync('$tmp/new.json',JSON.stringify(n,null,2));"
fi
gcloud storage cp "$tmp/new.json" "gs://$BUCKET/downloads/manifest.json" --cache-control="no-cache"
echo "Published $VERSION: https://game.liamhosfeld.com/download"
