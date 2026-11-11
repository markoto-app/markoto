import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

// Enumerates every published flow under `public/flows/<slug>/` from each slug's
// en/light-desktop manifest (every flow ships at least this variant).
//
// Auth: public (server/utils/auth/publicRoutes.ts) because the docs site fetches
// it during SSR; the contents derive from already-public assets.
//
// Not cached: `flows:build` rewrites `public/flows/` end to end, so caching
// across rebuilds would surface stale slugs.

interface FlowSummary {
  slug: string
  title: string
  /** Path relative to /flows so the client can prefix it with the origin. */
  heroPath: string | null
  next?: { slug: string, why: string }
  /** True when a `<slug>/en/light-mobile/manifest.json` exists. */
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

export default defineApiHandler({
  access: allow.public('Flow gallery index: derived from the already-public assets under public/flows/'),
  handler: async () => {
    if (!(await dirExists(FLOWS_DIR))) {
      // No flows built yet: return empty rather than 404.
      return { flows: [] as FlowSummary[] }
    }

    const slugs = await readdir(FLOWS_DIR)
    const out: FlowSummary[] = []

    for (const slug of slugs) {
      if (!(await dirExists(join(FLOWS_DIR, slug)))) continue
      const manifest = await readManifest(slug)
      if (!manifest) continue

      // The hero is the outcome entry with `hero: true`, else the first outcome
      // with a file. Never a chapter/narration entry: chapters have no `file`
      // and narration shots are setup frames.
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

    // readdir order is filesystem-dependent.
    out.sort((a, b) => a.title.localeCompare(b.title))

    return { flows: out }
  }
})
