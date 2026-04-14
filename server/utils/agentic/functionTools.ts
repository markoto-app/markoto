import { GoogleGenAI, type FunctionDeclaration } from '@google/genai'
import { z, type ZodType } from 'zod'

/**
 * Function declarations + runtime arg schemas. Single source of truth — the
 * JSON Schema handed to Gemini and the runtime validator the loop uses to
 * parse `FunctionCall.args` come from the same Zod definition.
 *
 * Why Zod:
 *   - `safeParse` catches malformed args (wrong type, missing required field,
 *     bad enum) before they reach the handler. The loop then returns a clean
 *     error back to the model via `functionResponse.isError`, so the model
 *     can self-correct instead of us silently coercing garbage.
 *   - Inferred TS types flow through the dispatcher so `aiToolAdapter.ts`
 *     stops defensively casting with `String()` / `Number()`.
 *   - One definition → one JSON Schema → one TS type. No drift.
 */

// --- Schemas --------------------------------------------------------------

// NOTE on `view_range`: we want semantically a [start, end] tuple, but Zod's
// `z.tuple(...)` emits JSON Schema in draft-7 tuple form (`items: [...]`) or
// 2020-12 (`prefixItems: [...]`) — Gemini's function-declaration validator
// rejects both with "schema at properties.view_range.items must be a boolean
// or an object." A length-bounded array of integers flattens to the
// single-schema `items` shape Gemini accepts. The [start, end] ordering is
// enforced by description + runtime bounds check in `handleView`.
const ViewDocumentArgs = z.object({
  view_range: z.array(z.number().int()).min(2).max(2)
    .describe('Inclusive [startLine, endLine], 1-indexed. Use -1 as endLine to read to end of file.')
    .optional()
}).describe('Read the current document with 1-indexed line numbers.')

const ReplaceTextArgs = z.object({
  old_str: z.string().min(1)
    .describe('The exact text to replace. Must match EXACTLY ONE location including whitespace — include enough surrounding context to be unique.'),
  new_str: z.string()
    .describe('The replacement text. Use an empty string to delete the match.')
}).describe('Replace a unique exact-match string in the document.')

const InsertTextArgs = z.object({
  insert_line: z.number().int().min(0)
    .describe('Line number after which to insert. 0 = start of file.'),
  insert_text: z.string()
    .describe('Text to insert. A trailing newline is added automatically if not present.')
}).describe('Insert text after a specific line (1-indexed; 0 = start of file).')

const WebSearchArgs = z.object({
  query: z.string().min(1)
    .describe('Natural-language search query.')
}).describe('Search the web for up-to-date information with cited sources.')

// --- Inferred types the dispatcher consumes -------------------------------

export type ViewDocumentInput = z.infer<typeof ViewDocumentArgs>
export type ReplaceTextInput = z.infer<typeof ReplaceTextArgs>
export type InsertTextInput = z.infer<typeof InsertTextArgs>
export type WebSearchInput = z.infer<typeof WebSearchArgs>

// --- Name → schema registry used by runLoop for validate-before-dispatch --
//
// `ZodType<unknown>` is the bound so the map can hold heterogeneous schemas;
// the caller narrows via the name when it branches.
export const TOOL_SCHEMAS: Record<string, ZodType<unknown>> = {
  view_document: ViewDocumentArgs,
  replace_text: ReplaceTextArgs,
  insert_text: InsertTextArgs,
  web_search: WebSearchArgs
}

// --- FunctionDeclarations (what Gemini sees) ------------------------------
//
// `parametersJsonSchema` accepts any JSON-Schema-shaped object (the SDK types
// it as `unknown`), so we feed it the output of `zodToJsonSchema` directly.
// Descriptions live on the Zod schema and propagate through conversion, so
// we don't duplicate them on the declaration.

function decl(name: string, description: string, schema: ZodType<unknown>): FunctionDeclaration {
  return {
    name,
    description,
    // Zod 4 ships `toJSONSchema` natively (the external `zod-to-json-schema`
    // package is typed against Zod 3 and doesn't play nice with v4 internals).
    // `target: 'draft-7'` is the safe default for JSON-Schema-accepting SDKs.
    parametersJsonSchema: z.toJSONSchema(schema, { target: 'draft-7' })
  }
}

export const ALL_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  decl(
    'view_document',
    'Read the current document with 1-indexed line numbers prepended to each line. Always call this before making any edits so you have current content to match against. Returns the full text unless a view_range is specified.',
    ViewDocumentArgs
  ),
  decl(
    'replace_text',
    'Replace a single exact-match occurrence of `old_str` with `new_str` in the document. `old_str` must match EXACTLY ONE location including whitespace — include enough surrounding context to be unique. Returns an error if zero or multiple matches are found.',
    ReplaceTextArgs
  ),
  decl(
    'insert_text',
    'Insert `insert_text` after line `insert_line` (1-indexed). Use insert_line=0 to insert at the very start of the document. The inserted text is newline-terminated automatically.',
    InsertTextArgs
  ),
  decl(
    'web_search',
    'Search the web for up-to-date or factual information. Use for time-sensitive queries (current events, prices, recent news) before writing. Returns a synthesised answer with cited sources; the model can then cite or quote them in the document.',
    WebSearchArgs
  )
]

// --- Web search sub-call --------------------------------------------------

/**
 * Executes a grounded Gemini sub-call using the built-in `googleSearch` tool.
 * Isolated here because:
 *   - It keeps our main agentic loop free of the `googleSearch + functionDeclarations`
 *     coexistence question — this sub-call has `googleSearch` alone.
 *   - Per-call status ("Searching the web for …") is emitted by the outer loop
 *     from the validated `FunctionCall.args` before this runs.
 *   - Output format (top answer + bulleted sources) is controlled by us, not
 *     whatever shape grounding returns.
 *
 * The sub-call reuses `GOOGLE_MODEL` so pricing stays predictable. Grounding is
 * 5,000 prompts/month free across the Gemini 3 family, then $14 per 1,000
 * searches — revisit query caching if this bill climbs.
 */
export async function webSearch(
  ai: GoogleGenAI,
  model: string,
  query: string,
  signal: AbortSignal
): Promise<string> {
  // Abort guard — if we're already past the deadline, don't even issue the call.
  if (signal.aborted) throw new Error('aborted')

  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [{
          text:
            `Answer this question using up-to-date web sources. Be concise (3–6 sentences). `
            + `End with a bulleted "Sources:" list of the URLs you used.\n\nQuery: ${query}`
        }]
      }
    ],
    config: {
      tools: [{ googleSearch: {} }],
      abortSignal: signal
    }
  })

  const answer = (response.text ?? '').trim()
  const md = response.candidates?.[0]?.groundingMetadata
  const sources = (md?.groundingChunks ?? [])
    .flatMap(c => (c.web?.uri ? [{ title: c.web.title ?? c.web.uri, uri: c.web.uri }] : []))

  if (!answer) {
    return 'No answer returned. The search may not have surfaced relevant results.'
  }

  // If the model already included sources in its answer (it was asked to),
  // don't duplicate. Otherwise append our own list from groundingMetadata.
  const hasEmbeddedSources = /sources\s*:/i.test(answer)
  if (hasEmbeddedSources || sources.length === 0) return answer

  const sourceList = sources.map(s => `  - ${s.title}: ${s.uri}`).join('\n')
  return `${answer}\n\nSources:\n${sourceList}`
}
