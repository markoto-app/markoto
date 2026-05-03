import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

// `_internal/flows-index`: enumerate every published flow under
// `public/flows/<slug>/`. Read each slug's en/light-desktop manifest
// (the canonical variant — every flow ships at least this one) and
// return a compact summary: title, slug, hero file, next-link, mobile
// availability.
//
// Auth: this endpoint is whitelisted as `_internal/*` because the
// docs site fetches it during SSR; the contents are derived from
// already-public assets under `public/flows/`. No sensitive data
// flows through.
//
// The route is GET-only and read-only; we do NOT cache because
// `public/flows/` is rewritten end-to-end by `flows:build` (the
// build script clears the dir first), so caching across rebuilds
// would surface stale slugs. Per-request cost is one fs walk + ~20
// JSON reads — sub-50ms in practice.

interface FlowSummary {
  slug: string
  title: string
  /** Heroes are the manifest's `hero: true` outcome frame, if any.
   *  Path is relative to /flows so the client can prefix with
   *  `useRequestURL().origin` (mirrors `Flow.vue`'s manifest fetch). */
  heroPath: string | null
  next?: { slug: string, why: string }
  /** True when a `<slug>/en/light-mobile/manifest.json` exists. The
   *  gallery surfaces a small "📱 mobile" pill so readers know the
   *  flow has a mobile sibling captured. */
  hasMobile: boolean
}

interface ManifestLite {
  title: string
  entries: Array<{ kind: string, file?: string, hero?: boolean }>
  next?: { slug: string, why: string }
}

const FLOWS_DIR = 'public/flows'
const VARIANT = 'light-desktop'
const LOCALE = 'en'

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p)
    return s.isDirectory()
  } catch {
    return false
  }
}

async function readManifest(slug: string): Promise<ManifestLite | null> {
  const p = join(FLOWS_DIR, slug, LOCALE, VARIANT, 'manifest.json')
  try {
    const raw = await readFile(p, 'utf-8')
    return JSON.parse(raw) as ManifestLite
  } catch {
    return null
  }
}

export default defineEventHandler(async () => {
  if (!(await dirExists(FLOWS_DIR))) {
    // No flows built yet — return empty rather than 404 so the
    // gallery page renders cleanly with an empty-state message.
    return { flows: [] as FlowSummary[] }
  }

  const slugs = await readdir(FLOWS_DIR)
  const out: FlowSummary[] = []

  for (const slug of slugs) {
    // Skip non-directories (.DS_Store etc.) — readdir mixes both.
    if (!(await dirExists(join(FLOWS_DIR, slug)))) continue
    const manifest = await readManifest(slug)
    if (!manifest) continue

    // The hero frame is the OUTCOME entry with `hero: true`; fall
    // back to the first outcome with a file when none is marked
    // (older manifests). NEVER use a chapter/narration entry as
    // the hero — chapters have no `file` and narration screenshots
    // are setup frames, not the payoff.
    const hero = manifest.entries.find(e => e.kind === 'outcome' && e.hero === true && e.file)
      ?? manifest.entries.find(e => e.kind === 'outcome' && !!e.file)
    const heroPath = hero?.file
      ? `/flows/${slug}/${LOCALE}/${VARIANT}/${hero.file}`
      : null

    const hasMobile = await dirExists(join(FLOWS_DIR, slug, LOCALE, 'light-mobile'))

    out.push({
      slug,
      title: manifest.title,
      heroPath,
      next: manifest.next,
      hasMobile
    })
  }

  // Stable sort by title — readdir order is filesystem-dependent and
  // the gallery should look consistent across machines.
  out.sort((a, b) => a.title.localeCompare(b.title))

  return { flows: out }
})
