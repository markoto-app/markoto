#!/usr/bin/env bash
# Validate the server PDF against PDF/UA-1 with veraPDF.
#
#   bash scripts/pdf-a11y-check.sh            # render the fixture, then validate
#   bash scripts/pdf-a11y-check.sh a.pdf b.pdf  # validate existing PDFs
#
# Without arguments it renders tests/fixtures/pdf-a11y/fixture.md through
# the real renderer by running tests/integration/endpoints/pdfAccessibility.test.ts
# with PDF_A11Y_OUT_DIR set (needs the test stack: `bun run test:integration:up`),
# then validates every PDF it wrote. veraPDF runs in its official container
# image, pinned below; Docker or Podman is picked like scripts/test-compose.sh.
# What passes and what can't: docs/contributing/accessible-pdf.md.
set -euo pipefail

VERAPDF_IMAGE='docker.io/verapdf/cli:v1.30.3'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  ENGINE=docker
elif command -v podman >/dev/null 2>&1; then
  ENGINE=podman
else
  echo 'pdf-a11y-check: needs docker or podman' >&2
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ "$#" -eq 0 ]; then
  echo "pdf-a11y-check: rendering the fixture through the test stack..."
  (cd "$ROOT" && PDF_A11Y_OUT_DIR="$WORK" bun run test:integration -- tests/integration/endpoints/pdfAccessibility.test.ts)
else
  for pdf in "$@"; do cp "$pdf" "$WORK/"; done
fi

# The container user is not the caller (rootless Podman maps it away).
chmod -R a+rX "$WORK"

status=0
for pdf in "$WORK"/*.pdf; do
  name="$(basename "$pdf")"
  echo
  echo "== $name (PDF/UA-1, veraPDF ${VERAPDF_IMAGE##*:})"
  "$ENGINE" run --rm -v "$WORK:/data:ro,z" "$VERAPDF_IMAGE" \
    --flavour ua1 --format json --maxfailuresdisplayed 1 "/data/$name" > "$WORK/$name.json" || true
  # One line per failed rule: clause-test, failed checks, description.
  if ! bun -e '
    const report = JSON.parse(await Bun.file(process.argv[1]).text()).report
    const result = [report.jobs[0].validationResult].flat()[0]
    const d = result.details
    console.log(`passed rules: ${d.passedRules}, failed rules: ${d.failedRules}, failed checks: ${d.failedChecks}`)
    for (const r of d.ruleSummaries) console.log(`  FAIL ${r.clause}-${r.testNumber} (${r.failedChecks}x) ${r.description.slice(0, 140)}`)
    process.exit(result.compliant ? 0 : 1)
  ' "$WORK/$name.json"; then
    status=1
  fi
done
exit "$status"
