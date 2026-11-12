#!/usr/bin/env bun
import fs from 'node:fs/promises'
import path from 'node:path'
import { flowEmbedSlugs } from '../shared/docs/flowDocPages'
import { addStats, countFiles, emptyStats, summaryMarkdown, syncVariant, type SyncStats } from './lib/flowShots'

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
// build would happily ship that broken state to the docs site. When
// the sentinel is missing, the prior published output is kept
// untouched so a single flaky run doesn't drop the flow from the docs.
//
// No churn: a passed variant is synced frame by frame (scripts/lib/flowShots.ts).
// A frame that looks the same as the committed one keeps the committed
// file byte-for-byte; only visibly changed frames are rewritten, frames
// the run no longer has are deleted, and the manifest is rewritten only
// when it changed beyond the run's random document ids.
//
// Garbage collection: flows no docs page embeds, flows without a source
// dir (test renamed or deleted) and variants a flow no longer records are
// removed, so stale output doesn't linger.
//
//   bun scripts/build-flows.ts [--summary FILE]
//
// `--summary` writes the kept / replaced / added / removed counts as
// Markdown (the screenshots PR's body, .github/workflows/publish-flow-shots.yml).
//
// Frames are lossless WebP at capture time (see
// tests/e2e/fixtures/flow.ts) — manifest already references `.webp`,
// no conversion needed. Within-variant content-hash dedup happens in
// the fixture before publishing.

const FLOWS_SRC = 'tests/e2e/output/flows'
const FLOWS_OUT = 'public/flows'
const DOCS_DIR = 'content/docs'

// Only flows a docs page embeds (`::flow{id="<slug>" ...}`) are published.
// The suite's second pass runs the `@billing` flows on a billing-ON
// server so the paid-plan UI keeps its regression coverage
// (scripts/flows-ephemeral.ts), but some of them (`upgrade-to-pro`,
// `what-happens-when-you-hit-the-ai-cap`) show purchase UI no public
// instance offers today. No docs page embeds them, so they must not ship
// to public/flows either. Publishing by reference keeps the rule in one
// place: embed a flow in a docs page and it gets published; drop the
// embed and the next build reaps it.

interface RunStats {
  publishedVariants: number
  skippedVariants: number
  publishedSlugs: Set<string>
  files: SyncStats
}

async function main() {
  if (!(await isDir(FLOWS_SRC))) {
    console.log(`[flows] no source at ${FLOWS_SRC} — run \`bun run flows:test\` first (or \`flows:test:against-running\` if you have an app already running)`)
    return
  }

  await fs.mkdir(FLOWS_OUT, { recursive: true })

  const referenced = await referencedFlowSlugs()
  const stats = await publishAllVariants(referenced)
  stats.files.removed += await garbageCollect(referenced)

  console.log(
    `[flows] published ${stats.publishedVariants} variant(s) across ${stats.publishedSlugs.size} flow(s); `
    + `skipped ${stats.skippedVariants} unpassed variant(s)`
  )
  const f = stats.files
  console.log(`[flows] frames: ${f.kept} kept, ${f.replaced} replaced, ${f.added} added, ${f.removed} removed; ${f.manifestsWritten} manifest(s) written`)
  const summaryFile = process.argv[process.argv.indexOf('--summary') + 1]
  if (process.argv.includes('--summary') && summaryFile) {
    await fs.writeFile(summaryFile, `${summaryMarkdown(f, stats.skippedVariants)}\n`)
  }

  // Surface a non-zero exit when nothing passed at all — the most
  // common shape of "the whole run was broken" so CI fails loudly.
  if (stats.publishedVariants === 0 && stats.skippedVariants > 0) {
    console.error('[flows] no variant passed — refusing to declare success')
    process.exit(1)
  }
}

/**
 * Walk every (slug, locale, variant) source dir under FLOWS_SRC and
 * publish (or skip) it. Returns aggregate stats.
 */
async function publishAllVariants(referenced: Set<string>): Promise<RunStats> {
  const stats: RunStats = {
    publishedVariants: 0,
    skippedVariants: 0,
    publishedSlugs: new Set(),
    files: emptyStats()
  }

  for await (const variant of walkVariants()) {
    if (!referenced.has(variant.slug)) continue
    const result = await publishVariant(variant)
    if (result) {
      stats.publishedVariants += 1
      stats.publishedSlugs.add(variant.slug)
      addStats(stats.files, result)
    } else {
      stats.skippedVariants += 1
      // If a prior published variant survives the skip, the slug is still live.
      if (await isDir(variant.dstDir)) stats.publishedSlugs.add(variant.slug)
    }
  }
  return stats
}

interface VariantPath {
  slug: string
  locale: string
  variant: string
  srcDir: string
  dstDir: string
}

/** Yield every (slug, locale, variant) source directory under FLOWS_SRC. */
async function* walkVariants(): AsyncGenerator<VariantPath> {
  for (const slug of await fs.readdir(FLOWS_SRC)) {
    const slugSrc = path.join(FLOWS_SRC, slug)
    if (!(await isDir(slugSrc))) continue
    for (const locale of await fs.readdir(slugSrc)) {
      const localeSrc = path.join(slugSrc, locale)
      if (!(await isDir(localeSrc))) continue
      for (const variant of await fs.readdir(localeSrc)) {
        const srcDir = path.join(localeSrc, variant)
        if (!(await isDir(srcDir))) continue
        yield {
          slug,
          locale,
          variant,
          srcDir,
          dstDir: path.join(FLOWS_OUT, slug, locale, variant)
        }
      }
    }
  }
}

/**
 * Publish one variant, or keep the last-good output when its test did
 * not pass (no `.passed` sentinel; returns null then).
 */
async function publishVariant(v: VariantPath): Promise<SyncStats | null> {
  if (!(await fileExists(path.join(v.srcDir, '.passed')))) {
    const lastGood = await isDir(v.dstDir)
    console.log(
      `[flows] SKIP ${v.slug}/${v.locale}/${v.variant} — test did not pass `
      + `(${lastGood ? 'keeping last-good output' : 'no prior output to keep'})`
    )
    return null
  }
  return syncVariant(v.srcDir, v.dstDir)
}

/**
 * Remove published output nothing produces any more: flows no docs page
 * embeds, flows without a source directory (test renamed or deleted), and
 * (locale, variant) directories a flow that still runs no longer records.
 * Returns the number of frames removed.
 */
async function garbageCollect(referenced: Set<string>): Promise<number> {
  let removed = 0
  for (const slug of await fs.readdir(FLOWS_OUT)) {
    const slugOut = path.join(FLOWS_OUT, slug)
    if (!(await isDir(slugOut))) continue
    const slugSrc = path.join(FLOWS_SRC, slug)
    if (!referenced.has(slug)) removed += await drop(slugOut, 'no docs page embeds it')
    else if (!(await isDir(slugSrc))) removed += await drop(slugOut, 'no source directory')
    else removed += await dropUnrecordedVariants(slugOut, slugSrc)
  }
  return removed
}

/** Drop the (locale, variant) dirs of a flow that its source no longer has. */
async function dropUnrecordedVariants(slugOut: string, slugSrc: string): Promise<number> {
  let removed = 0
  for (const locale of await fs.readdir(slugOut)) {
    const localeOut = path.join(slugOut, locale)
    if (!(await isDir(localeOut))) continue
    for (const variant of await fs.readdir(localeOut)) {
      const variantOut = path.join(localeOut, variant)
      if (await isDir(variantOut) && !(await isDir(path.join(slugSrc, locale, variant)))) {
        removed += await drop(variantOut, 'the flow no longer records this variant')
      }
    }
    if ((await fs.readdir(localeOut)).length === 0) await fs.rm(localeOut, { recursive: true })
  }
  return removed
}

/** Remove a published dir; returns how many frames it held. */
async function drop(dir: string, why: string): Promise<number> {
  const frames = await countFiles(dir)
  await fs.rm(dir, { recursive: true, force: true })
  console.log(`[flows] GC ${path.relative(FLOWS_OUT, dir)} — ${why}`)
  return frames
}

/** Every flow slug a page under content/docs embeds. */
async function referencedFlowSlugs(): Promise<Set<string>> {
  const slugs = new Set<string>()
  for (const rel of await fs.readdir(DOCS_DIR, { recursive: true })) {
    if (!rel.endsWith('.md')) continue
    const text = await fs.readFile(path.join(DOCS_DIR, rel), 'utf8')
    for (const slug of flowEmbedSlugs(text)) slugs.add(slug)
  }
  return slugs
}

const isDir = async (p: string) => fs.stat(p).then(s => s.isDirectory(), () => false)
const fileExists = async (p: string) => fs.stat(p).then(s => s.isFile(), () => false)

try {
  await main()
} catch (e) {
  console.error(e)
  process.exit(1)
}
