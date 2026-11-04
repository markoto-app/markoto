// Frames of a flow (public/flows/<id>/<locale>/<variant>/manifest.json,
// written by the Playwright flow suite) for the `::flow-strip` marketing
// block. Pure: the component fetches the manifests, this picks the shots.

export interface FlowStripFrame {
  /** Image file name inside the variant folder, e.g. `20.webp`. */
  file: string
  /** Caption / alt text from the manifest. */
  caption: string
}

export interface FlowStripData {
  width: number
  height: number
  frames: FlowStripFrame[]
}

const FILE_RE = /^\d{2,3}\.(?:webp|png|jpg)$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Every shot of a manifest with its caption (first caption per file wins; outcome shots before others). */
function framesOf(entries: unknown[]): Array<FlowStripFrame & { kind: string, hero: boolean }> {
  const out: Array<FlowStripFrame & { kind: string, hero: boolean }> = []
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const file = entry.file
    const text = typeof entry.caption === 'string' ? entry.caption : entry.text
    if (typeof file !== 'string' || !FILE_RE.test(file) || typeof text !== 'string' || !text.trim()) continue
    out.push({ file, caption: text.trim(), kind: String(entry.kind ?? ''), hero: entry.hero === true })
  }
  return out
}

/**
 * The shots to show. `pick` lists image numbers (`"16,20"` → 16.webp,
 * 20.webp, in that order); without it, the hero shot (or else the last
 * outcome) plus up to `limit - 1` earlier outcomes, in flow order.
 * Null for a manifest that isn't one.
 */
export function flowStripData(raw: unknown, pick: string | undefined, limit = 3): FlowStripData | null {
  if (!isRecord(raw) || !isRecord(raw.viewport) || !Array.isArray(raw.entries)) return null
  const { w, h } = raw.viewport
  if (typeof w !== 'number' || typeof h !== 'number' || w <= 0 || h <= 0) return null
  const all = framesOf(raw.entries)

  let frames: FlowStripFrame[]
  if (pick) {
    frames = pick.split(',').map(s => s.trim()).filter(Boolean).flatMap((n) => {
      const matches = all.filter(f => f.file.split('.')[0] === n.padStart(2, '0'))
      const best = matches.find(f => f.kind === 'outcome') ?? matches[0]
      return best ? [{ file: best.file, caption: best.caption }] : []
    })
  } else {
    const outcomes = all.filter(f => f.kind === 'outcome')
    const unique = outcomes.filter((f, i) => outcomes.findIndex(o => o.file === f.file) === i)
    const last = unique.find(f => f.hero) ?? unique.at(-1)
    const others = limit > 1 ? unique.filter(f => f !== last).slice(-(limit - 1)) : []
    const chosen = new Set([...others, ...(last ? [last] : [])])
    frames = unique.filter(f => chosen.has(f)).map(f => ({ file: f.file, caption: f.caption }))
  }
  return { width: w, height: h, frames }
}
