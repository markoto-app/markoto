import fs from 'node:fs/promises'
import path from 'node:path'

// Flows that ended SKIPPED because a live provider was down
// (`skipForProviderOutage` in tests/e2e/fixtures/flow.ts). The fixture leaves
// a marker file with the reason in the variant's output directory; the
// release lists them so a skip can't hide a long outage.

/** File the fixture writes into `<slug>/<locale>/<variant>/` of a skipped flow. */
export const PROVIDER_OUTAGE_MARKER = '.skipped-provider-unavailable'

export interface SkippedFlow {
  slug: string
  /** `<locale>/<variant>` */
  variant: string
  reason: string
}

/** Markdown list of the skipped flows, grouped by flow; '' when none. */
export function skippedFlowsMarkdown(skipped: SkippedFlow[]): string {
  if (skipped.length === 0) return ''
  const bySlug = new Map<string, { variants: string[], reason: string }>()
  for (const s of [...skipped].sort((a, b) => a.slug.localeCompare(b.slug) || a.variant.localeCompare(b.variant))) {
    const entry = bySlug.get(s.slug) ?? { variants: [], reason: s.reason }
    entry.variants.push(s.variant)
    bySlug.set(s.slug, entry)
  }
  const lines = [...bySlug].map(([slug, { variants, reason }]) =>
    `- \`${slug}\` (${variants.length} variant${variants.length === 1 ? '' : 's'}): ${reason}`)
  return [
    '### Flows skipped: provider unavailable',
    '',
    'These flows could not be verified because the provider they call was down. Their published screenshots are unchanged.',
    '',
    ...lines
  ].join('\n')
}

/**
 * One GitHub Actions `::warning::` line per skipped flow, so the skip shows
 * as an annotation on the release run, not only in its summary. Newlines and
 * `%` are escaped as the workflow-command format requires.
 */
export function skippedFlowsWarnings(skipped: SkippedFlow[]): string[] {
  const escape = (v: string) => v.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  const bySlug = new Map<string, { count: number, reason: string }>()
  for (const s of [...skipped].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const entry = bySlug.get(s.slug) ?? { count: 0, reason: s.reason }
    entry.count += 1
    bySlug.set(s.slug, entry)
  }
  return [...bySlug].map(([slug, { count, reason }]) =>
    `::warning title=Flow skipped (provider unavailable)::${escape(`${slug} (${count} variant${count === 1 ? '' : 's'}): ${reason}`)}`)
}

/** Read every `<slug>/<locale>/<variant>/<marker>` under `root`. */
export async function readSkippedFlows(root: string): Promise<SkippedFlow[]> {
  const out: SkippedFlow[] = []
  const dirs = (p: string) => fs.readdir(p, { withFileTypes: true }).then(es => es.filter(e => e.isDirectory()).map(e => e.name), () => [])
  for (const slug of await dirs(root)) {
    for (const locale of await dirs(path.join(root, slug))) {
      for (const variant of await dirs(path.join(root, slug, locale))) {
        const marker = path.join(root, slug, locale, variant, PROVIDER_OUTAGE_MARKER)
        const reason = await fs.readFile(marker, 'utf8').then(t => t.trim(), () => null)
        if (reason !== null) out.push({ slug, variant: `${locale}/${variant}`, reason: reason || 'provider unavailable' })
      }
    }
  }
  return out
}
