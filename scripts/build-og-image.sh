#!/usr/bin/env bash
# Builds the Open Graph / Twitter card images (1200×630 JPEGs) from the
# product-tour posters. Committed output in public/og/ — nothing is
# generated at runtime. Re-run after `bun run tour:capture` refreshes the
# posters or when a card's text changes. Needs ffmpeg (with drawtext /
# libfreetype) and `bun install` (the brand fonts come from the
# @fontsource packages in node_modules).
#
#   markoto.jpg    default card: the top of the "write" poster, no text
#   pricing.jpg    /pricing
#   use-cases.jpg  marketing content pages (use cases, cheat sheet)
#   compare.jpg    /compare + comparison pages
#   docs.jpg       /docs/**
#
# Which page gets which card: shared/seo/ogImages.ts (keep the alt texts
# there in step with the text drawn here).
#
# JPEG, not WebP: some link unfurlers ignore WebP og:image files.
#
#   scripts/build-og-image.sh            # every card
#   scripts/build-og-image.sh default    # one card (default|pricing|use-cases|compare|docs)
set -euo pipefail
cd "$(dirname "$0")/.."

FONTS=node_modules/@fontsource-variable
SERIF="$FONTS/fraunces/files/fraunces-latin-standard-normal.woff2"
SANS="$FONTS/inter/files/inter-latin-wght-normal.woff2"
MONO="$FONTS/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2"
OUT=public/og
mkdir -p "$OUT"

# Brand tokens (app/assets/css/main.css): bone page, sumi ink, shu seal.
BONE=0xFAF8F4
INK=0x14110D
MUTED=0x6F675B
HAIRLINE=0xE2DDD2
SHU=0xB5371F

default_card() {
  # Crop the top of the 16:10 poster to 1200:630 (keeps the editor header
  # and the paged preview), then scale to exactly 1200×630.
  ffmpeg -hide_banner -loglevel error -y -i public/tour/light/write/poster-1920.webp \
    -vf "crop=iw:trunc(iw*630/1200):0:0,scale=1200:630:flags=lanczos" \
    -q:v 3 -frames:v 1 "$OUT/markoto.jpg"
  echo "wrote $OUT/markoto.jpg"
}

# group_card <file> <scene> <eyebrow> <title> <subtitle>
# Bone card: seal + mono eyebrow, a Fraunces title and an Inter subtitle
# at the top left; the scene's poster below, bleeding off the bottom right.
group_card() {
  local file="$1" scene="$2" eyebrow="$3" title="$4" subtitle="$5"
  local tmp
  tmp="$(mktemp -d)"
  printf '%s' "$eyebrow" > "$tmp/eyebrow.txt"
  printf '%s' "$title" > "$tmp/title.txt"
  printf '%s' "$subtitle" > "$tmp/subtitle.txt"
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "color=c=$BONE:s=1200x630" \
    -i "public/tour/light/$scene/poster-1920.webp" \
    -filter_complex "\
[1:v]scale=1000:-1:flags=lanczos,pad=iw+2:ih+2:1:1:color=$HAIRLINE[shot];\
[0:v][shot]overlay=x=200:y=262[bg];\
[bg]drawbox=x=64:y=66:w=14:h=14:color=$SHU:t=fill,\
drawtext=fontfile=$MONO:textfile=$tmp/eyebrow.txt:fontsize=19:fontcolor=$MUTED:x=92:y=64,\
drawtext=fontfile=$SERIF:textfile=$tmp/title.txt:fontsize=64:fontcolor=$INK:x=62:y=106,\
drawtext=fontfile=$SANS:textfile=$tmp/subtitle.txt:fontsize=27:fontcolor=$MUTED:x=64:y=196" \
    -q:v 3 -frames:v 1 "$OUT/$file"
  rm -rf "$tmp"
  echo "wrote $OUT/$file"
}

build() {
  case "$1" in
    default) default_card ;;
    pricing) group_card pricing.jpg write 'MARKOTO · PRICING' 'Pricing' 'Self-hosted, no account, a free account or a paid plan.' ;;
    use-cases) group_card use-cases.jpg themes 'MARKOTO' 'Markdown with real pages' 'A live paged preview, and a PDF that matches it page for page.' ;;
    compare) group_card compare.jpg collab 'MARKOTO · COMPARE' 'markoto compared' 'How it compares with other editors, with a source for every fact.' ;;
    docs) group_card docs.jpg rich 'MARKOTO · DOCS' 'Documentation' 'Guides, walkthroughs and reference for markoto.' ;;
    *) echo "unknown card: $1" >&2; exit 1 ;;
  esac
}

if [ "$#" -eq 0 ]; then
  for card in default pricing use-cases compare docs; do build "$card"; done
else
  for card in "$@"; do build "$card"; done
fi
