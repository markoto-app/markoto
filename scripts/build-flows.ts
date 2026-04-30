#!/usr/bin/env bun
import fs from 'node:fs/promises'
import path from 'node:path'

// Publishes Playwright flow output to the static dir so <Flow> can fetch
// the manifests + frame images by URL. Mirrors the shape:
//
//   tests/e2e/output/flows/<slug>/<locale>/<variant>/manifest.json
//   tests/e2e/output/flows/<slug>/<locale>/<variant>/01.webp
//   ↓
//   public/flows/<slug>/<locale>/<variant>/manifest.json
//   public/flows/<slug>/<locale>/<variant>/01.webp
//
// Per-variant publishing gate: a (slug, locale, variant) directory is
// only republished if its source has a `.passed` sentinel — written
// by the flow fixture at teardown ONLY when the Playwright test
// reached its expected status. A failed or timed-out test leaves
// behind a partial manifest + half the frames; without the gate, the
// build would happily ship that broken state to the docs site
// (https://github.com/anthropics/.../md-online — see the prior
// truncated `write-with-ai` mobile manifest for the original
// motivation). When the sentinel is missing, the prior published
// output is kept untouched so a single flaky run doesn't drop the
// flow from the docs.
//
// Garbage collection: variants that no longer have a source dir at
// all (test renamed or deleted) ARE removed, so stale slugs don't
// linger forever.
//
// Frames are lossless WebP at capture time (see
// tests/e2e/fixtures/flow.ts) — manifest already references `.webp`,
// no conversion needed. Within-variant content-hash dedup happens in
// the fixture before publishing.

const FLOWS_SRC = 'tests/e2e/output/flows'
const FLOWS_OUT = 'public/flows'

async function main() {
  if (!(await isDir(FLOWS_SRC))) {
    console.log(`[flows] no source at ${FLOWS_SRC} — run \`bun run flows:test\` first (or \`flows:test:against-running\` if you have an app already running)`)
    return
  }

  await fs.mkdir(FLOWS_OUT, { recursive: true })

  let publishedVariants = 0
  let skippedVariants = 0
  let frameCount = 0
  let totalBytes = 0
  const publishedSlugs = new Set<string>()

  for (const slug of await fs.readdir(FLOWS_SRC)) {
    const slugSrc = path.join(FLOWS_SRC, slug)
    if (!(await isDir(slugSrc))) continue

    for (const locale of await fs.readdir(slugSrc)) {
      const localeSrc = path.join(slugSrc, locale)
      if (!(await isDir(localeSrc))) continue

      for (const variant of await fs.readdir(localeSrc)) {
        const variantSrc = path.join(localeSrc, variant)
        if (!(await isDir(variantSrc))) continue

        const variantDst = path.join(FLOWS_OUT, slug, locale, variant)
        const passedSentinel = await fileExists(path.join(variantSrc, '.passed'))

        if (!passedSentinel) {
          skippedVariants += 1
          const lastGood = await isDir(variantDst)
          console.log(
            `[flows] SKIP ${slug}/${locale}/${variant} — test did not pass `
            + `(${lastGood ? 'keeping last-good output' : 'no prior output to keep'})`
          )
          if (lastGood) publishedSlugs.add(slug)
          continue
        }

        // Wipe + recopy so a re-run with fewer frames doesn't leave
        // stale frames orphaned next to the new manifest.
        await fs.rm(variantDst, { recursive: true, force: true })
        await fs.mkdir(variantDst, { recursive: true })

        for (const f of await fs.readdir(variantSrc)) {
          if (f === 'manifest.json' || f.endsWith('.webp')) {
            const src = path.join(variantSrc, f)
            const dst = path.join(variantDst, f)
            await fs.copyFile(src, dst)
            if (f.endsWith('.webp')) {
              const stat = await fs.stat(dst)
              totalBytes += stat.size
              frameCount += 1
            }
          }
        }
        publishedVariants += 1
        publishedSlugs.add(slug)
      }
    }
  }

  // GC: published slugs whose source directory disappeared entirely
  // (test renamed or deleted) get removed from public/flows/ so they
  // don't 404 forever.
  for (const slug of await fs.readdir(FLOWS_OUT)) {
    const slugOut = path.join(FLOWS_OUT, slug)
    if (!(await isDir(slugOut))) continue
    if (!(await isDir(path.join(FLOWS_SRC, slug)))) {
      await fs.rm(slugOut, { recursive: true, force: true })
      console.log(`[flows] GC ${slug} — no source directory, removed from ${FLOWS_OUT}`)
    }
  }

  console.log(
    `[flows] published ${publishedVariants} variant(s) across ${publishedSlugs.size} flow(s); `
    + `skipped ${skippedVariants} unpassed variant(s)`
  )
  console.log(`[flows] ${frameCount} fresh frame(s), ${formatBytes(totalBytes)} total`)

  // Surface a non-zero exit when nothing passed at all — the most
  // common shape of "the whole run was broken" so CI fails loudly.
  if (publishedVariants === 0 && skippedVariants > 0) {
    console.error('[flows] no variant passed — refusing to declare success')
    process.exit(1)
  }
}

const isDir = async (p: string) => fs.stat(p).then(s => s.isDirectory(), () => false)
const fileExists = async (p: string) => fs.stat(p).then(s => s.isFile(), () => false)

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(2)}MB`
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
