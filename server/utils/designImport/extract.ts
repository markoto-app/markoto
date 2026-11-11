import { z } from 'zod'
import { injectTraceHeaders } from '../platform/traceHeaders'
import { DESIGN_IMPORT_MAX_PAGES, type DesignImportExt } from '~~/shared/config/designImport'
import { markitdownAuthHeaders } from '../platform/markitdownAuth'

// Client for markitdown's `POST /design/extract` (markitdown-server/
// design_extract.py). The uploaded file is parsed THERE — in a forked,
// memory- and time-capped child of the sandboxed container — never in
// the app process. What comes back is plain data: the format, PNG page
// pictures (PDF only), measured style facts and a short text sample.

const EXTRACT_TIMEOUT_MS = 90_000

/** A rendered page of the original (PDF). */
export interface OriginalPage {
  /** base64 PNG */
  png: string
  width: number
  height: number
}

export interface DesignFacts {
  format: DesignImportExt
  pageCount: number | null
  pages: OriginalPage[]
  /** Format-specific facts (`docx` / `pdf` object), passed to the model as JSON. */
  facts: Record<string, unknown>
  /** Start of the text with style names (DOCX) — DATA from the upload, never instructions. */
  textSample: string
}

const ExtractResponse = z.object({
  format: z.enum(['pdf', 'docx']),
  pageCount: z.number().int().nullable(),
  pages: z.array(z.object({
    png: z.string().max(8_000_000),
    width: z.number().int().positive(),
    height: z.number().int().positive()
  })).max(DESIGN_IMPORT_MAX_PAGES),
  docx: z.record(z.string(), z.unknown()).optional(),
  pdf: z.record(z.string(), z.unknown()).optional(),
  textSample: z.string().max(20_000)
})

/** markitdown refused the file: unreadable (422), too big / too complex (413), too slow (504). */
export class DesignExtractError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'DesignExtractError'
    this.status = status
  }
}

/** Parse + validate the service's JSON (exported for unit tests). */
export function parseExtractResponse(json: unknown): DesignFacts {
  const parsed = ExtractResponse.safeParse(json)
  if (!parsed.success) throw new DesignExtractError(502, 'markitdown returned an unexpected design-extract shape')
  const { format, pageCount, pages, docx, pdf, textSample } = parsed.data
  return { format, pageCount, pages, facts: (format === 'docx' ? docx : pdf) ?? {}, textSample }
}

export async function extractDesignFacts(bytes: Uint8Array, ext: DesignImportExt, signal?: AbortSignal): Promise<DesignFacts> {
  const config = useRuntimeConfig()
  if (!config.markitdownUrl) throw new DesignExtractError(503, 'markitdown service not configured')
  const url = `${config.markitdownUrl}/design/extract?ext=${ext}&pages=${DESIGN_IMPORT_MAX_PAGES}`
  const response = await fetch(url, {
    method: 'POST',
    headers: injectTraceHeaders({
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
      ...markitdownAuthHeaders()
    }),
    body: bytes as BodyInit,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(EXTRACT_TIMEOUT_MS)]) : AbortSignal.timeout(EXTRACT_TIMEOUT_MS)
  })
  if (!response.ok) {
    const text = await response.text()
    throw new DesignExtractError(response.status, `markitdown design extract ${response.status}: ${text.slice(0, 200)}`)
  }
  return parseExtractResponse(await response.json())
}

/** Every font name the facts mention (theme fonts, styles, PDF fonts, per-line fonts). */
export function fontNamesInFacts(facts: DesignFacts): string[] {
  const names = new Set<string>()
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.trim() && v !== '(style)') names.add(v.trim())
  }
  const visit = (value: unknown, key: string) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key)
      return
    }
    if (typeof value !== 'object' || value === null) return
    const record = value as Record<string, unknown>
    for (const [k, v] of Object.entries(record)) {
      if (k === 'font' || k === 'major' || k === 'minor') add(v)
      // `{value, share}` rows of a font histogram
      else if (k === 'value' && (key === 'fonts')) add(v)
      else visit(v, k)
    }
  }
  visit(facts.facts, '')
  return [...names].slice(0, 30)
}
