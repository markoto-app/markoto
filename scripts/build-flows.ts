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
// Pure copy. Frames are written as lossless WebP at capture time
// (see tests/e2e/fixtures/flow.ts) — the manifest already references
// `01.webp` etc, no conversion or rewriting needed here. PNGs never
// touch the codebase: the fixture transcodes the screenshot buffer
// directly before writing.
//
// Within-variant content-hash dedup happens in the fixture before
// publishing — multiple manifest entries can point at the same file.
//
// Clean rebuild: stale flows that no longer exist in tests get
// removed from public/. If you want a flow to outlive its test, copy
// its files out of public/flows/ to a permanent location and reference
// via the `path` prop of <Flow> instead of `id`.

const FLOWS_SRC = 'tests/e2e/output/flows'
const FLOWS_OUT = 'public/flows'

async function main() {
  await fs.rm(FLOWS_OUT, { recursive: true, force: true })
  await fs.mkdir(FLOWS_OUT, { recursive: true })

  if (!(await isDir(FLOWS_SRC))) {
    console.log(`[flows] no source at ${FLOWS_SRC} — run \`bun run flows:test\` first (or \`flows:test:against-running\` if you have an app already running)`)
    return
  }

  let flowCount = 0
  let variantCount = 0
  let frameCount = 0
  let totalBytes = 0

  for (const slug of await fs.readdir(FLOWS_SRC)) {
    const slugSrc = path.join(FLOWS_SRC, slug)
    if (!(await isDir(slugSrc))) continue
    flowCount += 1

    for (const locale of await fs.readdir(slugSrc)) {
      const localeSrc = path.join(slugSrc, locale)
      if (!(await isDir(localeSrc))) continue

      for (const variant of await fs.readdir(localeSrc)) {
        const variantSrc = path.join(localeSrc, variant)
        if (!(await isDir(variantSrc))) continue

        const variantDst = path.join(FLOWS_OUT, slug, locale, variant)
        await fs.mkdir(variantDst, { recursive: true })

        let copied = 0
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
            copied += 1
          }
        }
        if (copied > 0) variantCount += 1
      }
    }
  }

  console.log(
    `[flows] published ${flowCount} flow(s) across ${variantCount} (locale,variant) pair(s) to ${FLOWS_OUT}`
  )
  console.log(`[flows] ${frameCount} frame(s), ${formatBytes(totalBytes)} total`)
}

const isDir = async (p: string) => fs.stat(p).then((s) => s.isDirectory(), () => false)

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(2)}MB`
}

main().catch((e) => { console.error(e); process.exit(1) })
