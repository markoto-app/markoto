#!/usr/bin/env bun
import fs from 'node:fs/promises'
import path from 'node:path'

// Publishes Playwright flow output to the static dir so <Flow> can fetch
// the manifests + PNGs by URL. Mirrors the shape:
//
//   tests/e2e/output/flows/<slug>/<locale>/<variant>/manifest.json
//   tests/e2e/output/flows/<slug>/<locale>/<variant>/01.png
//   ↓
//   public/flows/<slug>/<locale>/<variant>/manifest.json
//   public/flows/<slug>/<locale>/<variant>/01.png
//
// Each (slug, locale, variant) triple gets its own manifest + screenshots.
// Within-variant screenshots are dedup'd by content hash inside the
// fixture (see flow.ts), so multiple manifest entries can point at the
// same PNG. Across variants the bytes always differ (light/dark = different
// pixels) so no cross-variant dedup is possible or attempted.
//
// Clean rebuild: stale flows that no longer exist in tests get removed
// from public/. If you want a flow to outlive its test, copy its files
// out of public/flows/ to a permanent location and reference via the
// `path` prop of <Flow> instead of `id`.

const FLOWS_SRC = 'tests/e2e/output/flows'
const FLOWS_OUT = 'public/flows'

async function main() {
  await fs.rm(FLOWS_OUT, { recursive: true, force: true })
  await fs.mkdir(FLOWS_OUT, { recursive: true })

  if (!(await isDir(FLOWS_SRC))) {
    console.log(`[flows] no source at ${FLOWS_SRC} — run \`bun run flows:test\` first`)
    return
  }

  let flowCount = 0
  let variantCount = 0

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
          if (f === 'manifest.json' || f.endsWith('.png')) {
            await fs.copyFile(path.join(variantSrc, f), path.join(variantDst, f))
            copied += 1
          }
        }
        if (copied > 0) variantCount += 1
      }
    }
  }

  console.log(`[flows] published ${flowCount} flow(s) across ${variantCount} (locale,variant) pair(s) to ${FLOWS_OUT}`)
}

const isDir = async (p: string) => fs.stat(p).then((s) => s.isDirectory(), () => false)

main().catch((e) => { console.error(e); process.exit(1) })
