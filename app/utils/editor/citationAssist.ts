import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { hoverTooltip, type EditorView, type Tooltip } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { describeItem, type CslItem } from '~~/shared/utils/citations/cslItem'
import { formatEntryText, type CitationStyleId } from '~~/shared/utils/citations/citationStyles'
import { bareCiteAllowedAfter, crossrefKind, readKey } from '~~/shared/utils/citations/citeSyntax'

/**
 * Editor help for citations and cross-references: after `@` (also inside
 * `[@…; @…]`) the bibliography keys and the document's labels are offered;
 * hovering a `@key` shows the formatted entry, or that the key is unknown.
 * Everything is read through `source()` at the moment it is needed, so the
 * extension never needs reconfiguring when the bibliography changes.
 */
export interface CitationAssistSource {
  items: () => readonly CslItem[]
  style: () => CitationStyleId
  locale: () => string
  /** Words shown next to labels ("Figure", "Table" …), by kind. */
  labelWord: (kind: 'fig' | 'tbl' | 'eq' | 'sec') => string
  /** Hover text for a key that names nothing. */
  unknownText: (key: string) => string
}

/** Labels defined in the source: `{#fig:x}`, `{#tbl:x}`, `{#eq:x}`, `{#sec:x}`. */
function labelsIn(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/\{#((?:fig|tbl|eq|sec):[\p{L}\p{N}_:.-]{1,100})\}/gu)) {
    if (m[1]) out.add(m[1])
  }
  return [...out]
}

function completionSource(src: CitationAssistSource) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const word = ctx.matchBefore(/-?@[\p{L}\p{N}_:.#$%&+?<>~/-]{0,100}$/u)
    if (!word) return null
    // The character before the whole match: for `[-@key` that is the `[`,
    // not the `-` of the suppress-author form.
    const at = word.text.startsWith('-') ? word.from + 1 : word.from
    const before = word.from > 0 ? ctx.state.sliceDoc(word.from - 1, word.from) : ''
    if (!bareCiteAllowedAfter(before || undefined)) return null
    if (word.text.length <= 1 && !ctx.explicit && before !== '[' && before !== ';' && before !== ' ') return null
    const options: Completion[] = src.items().map(item => ({
      label: item.id,
      detail: describeItem(item).slice(0, 80),
      type: 'text'
    }))
    for (const label of labelsIn(ctx.state.doc.toString())) {
      const kind = crossrefKind(label)
      if (kind) options.push({ label, detail: src.labelWord(kind), type: 'constant' })
    }
    if (options.length === 0) return null
    return { from: at + 1, options, validFor: /^[\p{L}\p{N}_:.#$%&+?<>~/-]*$/u }
  }
}

/** The `@key` under `pos`, with its range. */
function keyAt(view: EditorView, pos: number): { key: string, from: number, to: number } | null {
  const line = view.state.doc.lineAt(pos)
  const text = line.text
  const offset = pos - line.from
  const start = text.lastIndexOf('@', offset)
  if (start < 0 || offset - start > 101) return null
  const key = readKey(text.slice(start + 1))
  if (!key || start + 1 + key.length < offset) return null
  if (!bareCiteAllowedAfter(start > 0 ? text[start - 1] : undefined)) return null
  return { key, from: line.from + start, to: line.from + start + 1 + key.length }
}

function hoverSource(src: CitationAssistSource) {
  return (view: EditorView, pos: number): Tooltip | null => {
    const hit = keyAt(view, pos)
    if (!hit) return null
    const kind = crossrefKind(hit.key)
    let text: string
    if (kind) {
      if (!labelsIn(view.state.doc.toString()).includes(hit.key)) text = src.unknownText(hit.key)
      else text = `${src.labelWord(kind)}: ${hit.key}`
    } else {
      const item = src.items().find(i => i.id === hit.key)
      // A bare `@word` that is no key is ordinary text (a mention): no tooltip.
      const back = view.state.sliceDoc(Math.max(0, hit.from - 200), hit.from)
      const bracketed = back.lastIndexOf('[') > back.lastIndexOf(']')
      if (!item && !bracketed) return null
      text = item ? formatEntryText(item, src.style(), src.locale()) : src.unknownText(hit.key)
    }
    return {
      pos: hit.from,
      end: hit.to,
      above: true,
      create: () => {
        const dom = document.createElement('div')
        dom.className = 'cm-citation-tooltip'
        dom.textContent = text
        return { dom }
      }
    }
  }
}

export function citationAssist(src: CitationAssistSource): Extension {
  return [
    autocompletion({ override: [completionSource(src)], icons: false }),
    hoverTooltip(hoverSource(src), { hoverTime: 350 })
  ]
}
