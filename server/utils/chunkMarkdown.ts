/**
 * Markdown-aware chunker for knowledge-base ingestion. Splits a single
 * markdown document into roughly-equal chunks for embedding.
 *
 * Strategy (cheap + good-enough):
 *   1. Segment at `##`/`###` heading boundaries — these correspond to
 *      semantic sections. Chunks across headings would dilute retrieval
 *      ranking.
 *   2. Within each section, pack paragraphs (blank-line separated) until
 *      the target token budget is reached; emit a chunk and start the
 *      next one.
 *   3. Long sections (>target) are split at paragraph boundaries with
 *      a small overlap so a citation that straddles the seam still
 *      matches.
 *
 * Why not a third-party splitter:
 *   - langchain's MarkdownTextSplitter pulls in a large dep tree for what
 *     is ~80 lines of logic.
 *   - unstructured-io's value is layout-aware parsing of the source file
 *     (PDF → blocks), which markitdown already did. By the time we reach
 *     this function we're working with clean markdown.
 *
 * Tokens are estimated as chars/4 — good enough for budgeting and avoids
 * pulling tokenizer deps in. The consuming embedding call (Jina via
 * LiteLLM) has its own hard cap and will truncate if we under-estimate
 * on edge cases (CJK text).
 */

export interface ChunkMarkdownOptions {
  /** Approximate target tokens per chunk. Default 800. */
  targetTokens?: number
  /** Hard cap for a single chunk. If a paragraph exceeds this we force-split. Default 1500. */
  maxTokens?: number
  /** Overlap in tokens between adjacent chunks inside one section. Default 100. */
  overlapTokens?: number
  /**
   * Hard ceiling on number of chunks the splitter will emit. Caps the
   * blast radius on pathological inputs (e.g. 25 MB of single-word
   * lines) — each chunk becomes one embedding API call, so without
   * a ceiling a single upload can issue tens of thousands of API calls.
   *
   * When hit, the chunker keeps the first `maxChunks - 1` chunks and
   * replaces everything after with a single sentinel "[truncated]"
   * chunk so downstream search can still see SOMETHING hit for that
   * part of the document. Default: no ceiling (undefined).
   */
  maxChunks?: number
}

export interface Chunk {
  /** 1-based ordering within the document. */
  index: number
  /** Plain-text chunk body (markdown, ready to embed). */
  content: string
  /** Estimated token count. */
  tokens: number
}

const CHARS_PER_TOKEN = 4

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** Hard-split a single oversized block on paragraph boundaries, with overlap. */
function splitOversizedBlock(block: string, maxTokens: number, overlapTokens: number): string[] {
  const paras = block.split(/\n{2,}/).filter(p => p.trim().length > 0)
  if (paras.length === 0) return []
  const out: string[] = []
  let buf: string[] = []
  let bufTokens = 0
  for (const p of paras) {
    const t = estimateTokens(p)
    if (bufTokens + t > maxTokens && buf.length > 0) {
      out.push(buf.join('\n\n'))
      // Retain a tail for overlap
      const overlap: string[] = []
      let overlapT = 0
      for (let i = buf.length - 1; i >= 0; i--) {
        const pt = estimateTokens(buf[i]!)
        if (overlapT + pt > overlapTokens) break
        overlap.unshift(buf[i]!)
        overlapT += pt
      }
      buf = overlap
      bufTokens = overlapT
    }
    buf.push(p)
    bufTokens += t
    // Paragraph itself larger than maxTokens: sentence-split as last resort.
    if (bufTokens > maxTokens && buf.length === 1) {
      const sentences = p.match(/[^.!?\n]+[.!?]+[\])'"`’”]*|[^.!?\n]+$/g) ?? [p]
      let sBuf: string[] = []
      let sT = 0
      for (const s of sentences) {
        const st = estimateTokens(s)
        if (sT + st > maxTokens && sBuf.length > 0) {
          out.push(sBuf.join(' ').trim())
          sBuf = []
          sT = 0
        }
        sBuf.push(s)
        sT += st
      }
      if (sBuf.length > 0) out.push(sBuf.join(' ').trim())
      buf = []
      bufTokens = 0
    }
  }
  if (buf.length > 0) out.push(buf.join('\n\n'))
  return out
}

/**
 * Segment markdown into sections, where each section starts with a
 * level-2 heading (or the document preamble, if any). Level-1 is
 * treated as a title and folded into the first section's preamble.
 */
function segmentByHeadings(markdown: string): string[] {
  // Match ATX h2/h3 starts of line. h1 is intentionally not a boundary —
  // there's usually only one and we don't want a single "intro" mega-chunk.
  const lines = markdown.split('\n')
  const sections: string[] = []
  let current: string[] = []
  for (const line of lines) {
    if (/^#{2,3}\s/.test(line) && current.length > 0) {
      sections.push(current.join('\n').trim())
      current = [line]
    } else {
      current.push(line)
    }
  }
  if (current.length > 0) {
    const tail = current.join('\n').trim()
    if (tail.length > 0) sections.push(tail)
  }
  return sections.filter(s => s.length > 0)
}

/**
 * Split a markdown document into chunks ready for embedding.
 *
 * Empty / whitespace-only input returns an empty array — the caller
 * (processKnowledge) should treat that as "markitdown produced nothing
 * extractable" and flip the row to `status='failed'` rather than
 * inserting 0 chunks with no explanation.
 */
export function chunkMarkdown(markdown: string, options: ChunkMarkdownOptions = {}): Chunk[] {
  const targetTokens = options.targetTokens ?? 800
  const maxTokens = options.maxTokens ?? 1500
  const overlapTokens = options.overlapTokens ?? 100

  if (!markdown?.trim()) return []

  const sections = segmentByHeadings(markdown)
  const chunks: Chunk[] = []
  let index = 0

  for (const section of sections) {
    const sectionTokens = estimateTokens(section)
    if (sectionTokens <= maxTokens) {
      // Small section: emit as a single chunk. Combining sections under
      // targetTokens is explicitly NOT done — we'd lose heading-aware
      // retrieval boundaries for a marginal size gain.
      index += 1
      chunks.push({ index, content: section, tokens: sectionTokens })
      continue
    }
    // Large section: keep the heading line attached to each piece so
    // downstream retrieval still knows the section this chunk came from.
    const firstLine = section.split('\n', 1)[0]!
    const heading = /^#{2,3}\s/.test(firstLine) ? firstLine : null
    const body = heading ? section.slice(firstLine.length).trimStart() : section
    const pieces = splitOversizedBlock(body, maxTokens, overlapTokens)
    for (const piece of pieces) {
      const content = heading ? `${heading}\n\n${piece}` : piece
      index += 1
      chunks.push({ index, content, tokens: estimateTokens(content) })
    }
  }

  // Second pass: pack adjacent small chunks up to targetTokens. Doesn't
  // cross heading sections because `chunks` already respects them.
  const packed: Chunk[] = []
  let buf: Chunk[] = []
  let bufTokens = 0
  const flush = () => {
    if (buf.length === 0) return
    packed.push({
      index: packed.length + 1,
      content: buf.map(c => c.content).join('\n\n'),
      tokens: bufTokens
    })
    buf = []
    bufTokens = 0
  }
  for (const c of chunks) {
    if (bufTokens + c.tokens > targetTokens && buf.length > 0) {
      flush()
    }
    buf.push(c)
    bufTokens += c.tokens
  }
  flush()

  // Hard ceiling. Keep the first (maxChunks-1) chunks, replace the
  // rest with one sentinel so downstream search sees something at the
  // truncation point rather than silently losing the tail.
  if (options.maxChunks && packed.length > options.maxChunks) {
    const kept = packed.slice(0, options.maxChunks - 1)
    const droppedCount = packed.length - kept.length
    const sentinel: Chunk = {
      index: kept.length + 1,
      content: `[Document truncated: the remaining ${droppedCount} chunks were omitted because the file exceeded the per-file chunk limit. Upload a shorter or pre-summarised version for full coverage.]`,
      tokens: estimateTokens(`[Document truncated: …]`)
    }
    return [...kept, sentinel]
  }

  return packed
}
