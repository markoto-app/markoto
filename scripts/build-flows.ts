#!/usr/bin/env bun
import fs from 'node:fs/promises'
import path from 'node:path'

// Publishes Playwright flow output to the static dir so <Flow> can fetch
// the manifests + PNGs by URL. Mirrors the shape:
//
//   tests/e2e/output/flows/<slug>/<locale>/manifest.json
//   tests/e2e/output/flows/<slug>/<locale>/01.png
//   ↓
//   public/flows/<slug>/<locale>/manifest.json
//   public/flows/<slug>/<locale>/01.png
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
  let localeCount = 0

  for (const slug of await fs.readdir(FLOWS_SRC)) {
    const slugSrc = path.join(FLOWS_SRC, slug)
    if (!(await isDir(slugSrc))) continue

    const slugDst = path.join(FLOWS_OUT, slug)
    await fs.mkdir(slugDst, { recursive: true })
    flowCount += 1

    for (const locale of await fs.readdir(slugSrc)) {
      const localeSrc = path.join(slugSrc, locale)
      if (!(await isDir(localeSrc))) continue

      const localeDst = path.join(slugDst, locale)
      await fs.mkdir(localeDst, { recursive: true })

      let copied = 0
      for (const f of await fs.readdir(localeSrc)) {
        if (f === 'manifest.json' || f.endsWith('.png')) {
          await fs.copyFile(path.join(localeSrc, f), path.join(localeDst, f))
          copied += 1
        }
      }
      if (copied > 0) localeCount += 1
    }
  }

  console.log(`[flows] published ${flowCount} flow(s) across ${localeCount} locale(s) to ${FLOWS_OUT}`)
}

const isDir = async (p: string) => fs.stat(p).then((s) => s.isDirectory(), () => false)

main().catch((e) => { console.error(e); process.exit(1) })
