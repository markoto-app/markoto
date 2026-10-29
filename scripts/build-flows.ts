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
// build would happily ship that broken state to the docs site. When
// the sentinel is missing, the prior published output is kept
// untouched so a single flaky run doesn't drop the flow from the docs.
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
const DOCS_DIR = 'content/docs'

// Only flows a docs page embeds (`::flow{id="<slug>" ...}`) are published.
// The flow suite runs on a billing-ON stack so the paid-plan flows keep
// their regression coverage, but some of them (`upgrade-to-pro`,
// `what-happens-when-you-hit-the-ai-cap`) show purchase UI no public
// instance offers today. No docs page embeds them, so they must not ship
// to public/flows either. Publishing by reference keeps the rule in one
// place: embed a flow in a docs page and it gets published; drop the
// embed and the next build reaps it.
const FLOW_EMBED_RE = /::flow\{[^}]*\bid="([^"]+)"/g

interface VariantStats {
  /** True if `.passed` sentinel was present and we re-published. */
  published: boolean
  /** True if `.passed` was missing and we kept the prior published output. */
  skipped: boolean
  frameCount: number
  totalBytes: number
}

interface RunStats {
  publishedVariants: number
  skippedVariants: number
  frameCount: number
  totalBytes: number
  publishedSlugs: Set<string>
}

async function main() {
  if (!(await isDir(FLOWS_SRC))) {
    console.log(`[flows] no source at ${FLOWS_SRC} — run \`bun run flows:test\` first (or \`flows:test:against-running\` if you have an app already running)`)
    return
  }

  await fs.mkdir(FLOWS_OUT, { recursive: true })

  const referenced = await referencedFlowSlugs()
  const stats = await publishAllVariants(referenced)
  await garbageCollectStaleSlugs(referenced)

  console.log(
    `[flows] published ${stats.publishedVariants} variant(s) across ${stats.publishedSlugs.size} flow(s); `
    + `skipped ${stats.skippedVariants} unpassed variant(s)`
  )
  console.log(`[flows] ${stats.frameCount} fresh frame(s), ${formatBytes(stats.totalBytes)} total`)

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
    frameCount: 0,
    totalBytes: 0,
    publishedSlugs: new Set()
  }

  for await (const variant of walkVariants()) {
    if (!referenced.has(variant.slug)) continue
    const result = await publishVariant(variant)
    if (result.published) {
      stats.publishedVariants += 1
      stats.publishedSlugs.add(variant.slug)
    } else if (result.skipped) {
      stats.skippedVariants += 1
      // If a prior published variant survives the skip, the slug is still live.
      if (await isDir(variant.dstDir)) stats.publishedSlugs.add(variant.slug)
    }
    stats.frameCount += result.frameCount
    stats.totalBytes += result.totalBytes
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
 * Publish one variant. Honours the `.passed` sentinel: missing
 * sentinel → keep last-good output (skip). Present sentinel → wipe
 * + recopy so a re-run with fewer frames doesn't leave stale frames
 * orphaned next to the new manifest.
 */
async function publishVariant(v: VariantPath): Promise<VariantStats> {
  const stats: VariantStats = { published: false, skipped: false, frameCount: 0, totalBytes: 0 }

  if (!(await fileExists(path.join(v.srcDir, '.passed')))) {
    stats.skipped = true
    const lastGood = await isDir(v.dstDir)
    console.log(
      `[flows] SKIP ${v.slug}/${v.locale}/${v.variant} — test did not pass `
      + `(${lastGood ? 'keeping last-good output' : 'no prior output to keep'})`
    )
    return stats
  }

  await fs.rm(v.dstDir, { recursive: true, force: true })
  await fs.mkdir(v.dstDir, { recursive: true })

  for (const f of await fs.readdir(v.srcDir)) {
    if (f !== 'manifest.json' && !f.endsWith('.webp')) continue
    const dst = path.join(v.dstDir, f)
    await fs.copyFile(path.join(v.srcDir, f), dst)
    if (f.endsWith('.webp')) {
      const stat = await fs.stat(dst)
      stats.totalBytes += stat.size
      stats.frameCount += 1
    }
  }
  stats.published = true
  return stats
}

/**
 * Drop published slugs whose source directory disappeared entirely
 * (test renamed or deleted) so they don't 404 forever.
 */
async function garbageCollectStaleSlugs(referenced: Set<string>): Promise<void> {
  for (const slug of await fs.readdir(FLOWS_OUT)) {
    const slugOut = path.join(FLOWS_OUT, slug)
    if (!(await isDir(slugOut))) continue
    if (!referenced.has(slug)) {
      await fs.rm(slugOut, { recursive: true, force: true })
      console.log(`[flows] GC ${slug} — no docs page embeds it, removed from ${FLOWS_OUT}`)
      continue
    }
    if (await isDir(path.join(FLOWS_SRC, slug))) continue
    await fs.rm(slugOut, { recursive: true, force: true })
    console.log(`[flows] GC ${slug} — no source directory, removed from ${FLOWS_OUT}`)
  }
}

/** Every flow slug a page under content/docs embeds. */
async function referencedFlowSlugs(): Promise<Set<string>> {
  const slugs = new Set<string>()
  for (const rel of await fs.readdir(DOCS_DIR, { recursive: true })) {
    if (!rel.endsWith('.md')) continue
    const text = await fs.readFile(path.join(DOCS_DIR, rel), 'utf8')
    for (const match of text.matchAll(FLOW_EMBED_RE)) slugs.add(match[1])
  }
  return slugs
}

const isDir = async (p: string) => fs.stat(p).then(s => s.isDirectory(), () => false)
const fileExists = async (p: string) => fs.stat(p).then(s => s.isFile(), () => false)

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(2)}MB`
}

try {
  await main()
} catch (e) {
  console.error(e)
  process.exit(1)
}
