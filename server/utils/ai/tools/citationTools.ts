import { z } from 'zod'
import { defineDocTool, toolError, toolOk, type ToolResult } from './toolDefinition'
import type { DocToolContext } from '../../agentic/toolContext'
import { describeItem, serializeItem, type CslItem } from '~~/shared/utils/citations/cslItem'
import { CITATION_STYLES, formatEntryText } from '~~/shared/utils/citations/citationStyles'
import { crossrefKind, findCitations } from '~~/shared/utils/citations/citeSyntax'
import { BIBLIOGRAPHY_ROOT } from '~~/shared/utils/citations/docBibliography'
import { documentLocale } from '~~/shared/utils/documents/documentLocale'
import { aiStatus } from '~~/shared/ai/statusSteps'
import { readDocCitations } from '../../citations/docCitations'
import { DoiLookupError, lookupDoi } from '../../citations/crossref'

// Citation-aware tools: the model sees the document's bibliography and may
// add to it only through a DOI that Crossref confirms. Every edit tool
// refuses text that cites a key outside the bibliography
// (`citationGuard.ts`), so a reference can't be made up.

const LIST_MAX = 200

const ListReferencesArgs = z.object({
  query: z.string().trim().max(200).optional()
    .describe('Words to filter by (author, title, year, key). Omit to list every entry.')
})

function locale(ctx: DocToolContext): string {
  const lang = ctx.ymeta.get('language')
  return documentLocale(typeof lang === 'string' ? lang : '')
}

function entryLine(item: CslItem, ctx: DocToolContext): string {
  const { style } = readDocCitations(ctx.ydoc)
  return `@${item.id}: ${formatEntryText(item, style, locale(ctx))}${item.DOI ? ` (DOI ${item.DOI})` : ''}`
}

export const listReferencesTool = defineDocTool({
  name: 'list_references',
  description: 'List the document\'s bibliography: every citation key with its formatted entry, and the citation style. Cite a work in the text as `[@key]`, `[@key, p. 12]`, `[@a; @b]` or narratively as `@key`; only keys listed here are allowed (edits citing any other key are refused). The bibliography is printed by the renderer itself; never type a reference list by hand.',
  schema: ListReferencesArgs,
  handler: (ctx, { query }): ToolResult => {
    ctx.updateStatus('tool', aiStatus('readReferences'))
    const { items, style } = readDocCitations(ctx.ydoc)
    const styleLabel = CITATION_STYLES.find(s => s.id === style)?.label ?? style
    if (items.length === 0) {
      return toolOk(`The bibliography is empty (style: ${styleLabel}). Add works with add_reference_by_doi, or ask the user to add references in the References panel (BibTeX, Zotero export, DOI).`)
    }
    const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    const hits = words.length === 0
      ? items
      : items.filter((item) => {
          const hay = `${item.id} ${describeItem(item)} ${item.DOI ?? ''}`.toLowerCase()
          return words.every(w => hay.includes(w))
        })
    const shown = hits.slice(0, LIST_MAX).map(item => entryLine(item, ctx))
    const more = hits.length > LIST_MAX ? `\n(${hits.length - LIST_MAX} more; narrow with query)` : ''
    return toolOk(`Citation style: ${styleLabel}. ${hits.length} of ${items.length} entries:\n${shown.join('\n')}${more}`)
  }
})

const AddReferenceArgs = z.object({
  doi: z.string().trim().min(1).max(300)
    .describe('The DOI (10.xxxx/...) or a doi.org link of the work, from a source you have actually seen (search result, fetched page, the user). Never guess or construct a DOI.'),
  expected_title: z.string().trim().min(1).max(500)
    .describe('The work\'s title as your source gives it. The entry is only added when Crossref\'s title for this DOI matches.')
})

/** Words of a title, for the match check. */
function titleWords(s: string): Set<string> {
  return new Set(s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2))
}

/** Share of the expected title's words that Crossref's title has. */
export function titleMatch(expected: string, actual: string): number {
  const want = titleWords(expected)
  if (want.size === 0) return 0
  const have = titleWords(actual)
  let hit = 0
  for (const w of want) if (have.has(w)) hit++
  return hit / want.size
}

const TITLE_MATCH_MIN = 0.6

export const addReferenceByDoiTool = defineDocTool({
  name: 'add_reference_by_doi',
  description: 'Add a work to the document\'s bibliography by its DOI. The DOI is looked up at Crossref and the entry is added only when Crossref knows the DOI and its title matches expected_title; you get the new citation key back to cite as `[@key]`. This is the only way to add a reference: never write an entry or a key yourself. A work that is already in the bibliography returns its existing key.',
  schema: AddReferenceArgs,
  sessionCallCap: 10,
  trustBoundary: 'confirm',
  handler: async (ctx, { doi, expected_title }): Promise<ToolResult> => {
    ctx.updateStatus('tool', aiStatus('addReference', { doi: doi.slice(0, 60) }))
    const bib = ctx.ydoc.getMap<unknown>(BIBLIOGRAPHY_ROOT)
    let item: CslItem
    try {
      item = await lookupDoi(doi, key => bib.has(key))
    } catch (e) {
      if (!(e instanceof DoiLookupError)) throw e
      if (e.reason === 'invalid') return toolError('Error: that is not a DOI (10.xxxx/...). Nothing was added.')
      if (e.reason === 'not-found') return toolError('Error: Crossref has no record of this DOI, so it was not added. Do not cite this work; check the DOI in your source, or tell the user the claim needs a source.')
      return toolError('Error: the DOI lookup at Crossref failed. Nothing was added; try again later or ask the user to add the reference.')
    }
    const score = titleMatch(expected_title, item.title ?? '')
    if (score < TITLE_MATCH_MIN) {
      return toolError(`Error: nothing was added. Crossref's title for this DOI is "${item.title ?? '(none)'}", which does not match "${expected_title}". The DOI probably belongs to another work; do not cite it.`)
    }
    const existing = readDocCitations(ctx.ydoc).items.find(i => i.DOI && i.DOI.toLowerCase() === (item.DOI ?? '').toLowerCase())
    if (existing) return toolOk(`Already in the bibliography as @${existing.id}. Cite it as [@${existing.id}].`)
    ctx.ydoc.transact(() => bib.set(item.id, serializeItem(item)), `ai:assistant:${ctx.sessionId}`)
    return toolOk(`Added (verified at Crossref): ${entryLine(item, ctx)}\nCite it as [@${item.id}].`)
  }
})

export const checkCitationsTool = defineDocTool({
  name: 'check_citations',
  description: 'Check the document\'s citations and cross-references: cited keys missing from the bibliography, bibliography entries never cited, and `@fig:` / `@tbl:` / `@eq:` / `@sec:` references to labels the document does not define. Use it before finishing a task that touched citations.',
  schema: z.object({}),
  handler: (ctx): ToolResult => {
    ctx.updateStatus('tool', aiStatus('checkCitations'))
    const text = ctx.ytext.toJSON()
    const { items } = readDocCitations(ctx.ydoc)
    const keys = new Set(items.map(i => i.id))
    const labels = new Set(Array.from(text.matchAll(/\{#((?:fig|tbl|eq|sec):[\p{L}\p{N}_:.-]{1,100})\}/gu), m => m[1] ?? ''))
    const cited = findCitations(text)
    const missing = new Set<string>()
    const missingLabels = new Set<string>()
    const used = new Set<string>()
    for (const c of cited) {
      if (crossrefKind(c.key)) {
        if (!labels.has(c.key)) missingLabels.add(c.key)
      } else if (keys.has(c.key)) {
        used.add(c.key)
      } else if (c.bracketed) {
        missing.add(c.key)
      }
    }
    const unused = items.filter(i => !used.has(i.id)).map(i => `@${i.id}`)
    const lines = [
      missing.size ? `Cited but not in the bibliography (shown as broken markers): ${[...missing].map(k => `@${k}`).join(', ')}` : 'Every citation has a bibliography entry.',
      missingLabels.size ? `References to labels that do not exist: ${[...missingLabels].map(k => `@${k}`).join(', ')}` : 'Every cross-reference has its label.',
      unused.length ? `In the bibliography but never cited (not printed): ${unused.slice(0, 50).join(', ')}` : 'Every entry is cited.'
    ]
    return toolOk(lines.join('\n'))
  }
})
