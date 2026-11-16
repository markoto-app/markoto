#!/usr/bin/env bash
# Compare rendered template pages against a reference rendering, page by page.
#
#   scripts/compare-template-reference.sh <reference-dir> <ours-dir> <preset> <pages>
#
# <reference-dir>  ref-1.png, ref-2.png, …: the original (e.g. compiled LaTeX:
#                  `pdftoppm -r 144 -png template.pdf <dir>/ref`, then rename
#                  ref-01.png → ref-1.png if pdftoppm zero-pads)
# <ours-dir>       the theme-shots output (`<preset>-p1.png`, …,
#                  scripts/render-theme-shots.ts)
# <preset>         the file prefix in <ours-dir> (the preset id)
# <pages>          how many pages to compare
#
# Writes into <ours-dir>:
#   side-N.png     reference left, ours right, at half size
#   overlay-N.png  both pages thresholded and stacked: black = both,
#                  cyan = reference only, red = ours only
# Needs ImageMagick 7 (`magick`). See docs/contributing/TEMPLATE-WORKFLOW.md.
set -euo pipefail

if [[ "$#" -ne 4 ]]; then
  sed -n '2,17p' "$0" >&2
  exit 2
fi
ref_dir=$1
ours=$2
prefix=$3
pages=$4

for i in $(seq 1 "$pages"); do
  ref="$ref_dir/ref-$i.png"
  page="$ours/$prefix-p$i.png"
  [[ -f "$ref" ]] || { echo "missing $ref" >&2; exit 1; }
  [[ -f "$page" ]] || { echo "missing $page" >&2; exit 1; }
  size=$(magick identify -format '%wx%h' "$ref")
  magick "$page" -resize "${size}!" "$ours/_o$i.png"
  magick "$ref" "$ours/_o$i.png" +append -resize 50% "$ours/side-$i.png"
  magick "$ref" -colorspace gray -threshold 70% "$ours/_rg.png"
  magick "$ours/_o$i.png" -colorspace gray -threshold 70% "$ours/_og.png"
  # R = reference, G = B = ours: ink in only one of them shows in colour.
  magick "$ours/_rg.png" "$ours/_og.png" "$ours/_og.png" -combine "$ours/overlay-$i.png"
done
rm -f "$ours"/_o*.png "$ours/_rg.png" "$ours/_og.png"
echo "wrote $ours/side-1..$pages.png and overlay-1..$pages.png"
