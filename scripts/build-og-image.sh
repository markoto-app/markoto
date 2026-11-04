#!/usr/bin/env bash
# Builds the default Open Graph / Twitter card image (1200×630 JPEG) from a
# product-tour poster. Committed output: public/og/markoto.jpg — nothing is
# generated at runtime. Re-run after `bun run tour:capture` refreshes the
# posters. Needs ffmpeg.
#
# JPEG, not WebP: some link unfurlers ignore WebP og:image files.
#
#   scripts/build-og-image.sh [poster]   # default: light "write" scene
set -euo pipefail
cd "$(dirname "$0")/.."

src="${1:-public/tour/light/write/poster-1920.webp}"
out="public/og/markoto.jpg"
mkdir -p "$(dirname "$out")"

# Crop the top of the 16:10 poster to 1200:630 (keeps the editor header and
# the paged preview), then scale to exactly 1200×630.
ffmpeg -hide_banner -loglevel error -y -i "$src" \
  -vf "crop=iw:trunc(iw*630/1200):0:0,scale=1200:630:flags=lanczos" \
  -q:v 3 -frames:v 1 "$out"
echo "wrote $out"
