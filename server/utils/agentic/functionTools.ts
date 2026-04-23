import type { GoogleGenAI, FunctionDeclaration } from '@google/genai'
import { z, type ZodType } from 'zod'
import { THEME_FONTS } from '~~/shared/utils/themeFonts'
import { THEME_PRESETS } from '~~/shared/utils/themePresets'
import {
  HexColorSchema,
  PageSizeSchema,
  PageOrientationSchema,
  TextAlignSchema,
  CodeThemeSchema,
  TableHeaderBgSchema,
  TableHeaderColorSchema,
  TableBordersSchema,
  BlockquoteStyleSchema,
  MermaidThemeSchema,
  TocLeaderStyleSchema
} from '~~/shared/types/theme'

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
    // Enforce at the schema level so Gemini self-corrects with a clean
    // error instead of hitting the runtime check in `handleView` (which
    // produces a less model-friendly message and burns a loop turn).
    .refine(([start, end]) => start !== undefined && end !== undefined && start >= 1 && (end === -1 || end >= start), {
      message: 'view_range must be [start, end] where start >= 1 and end is either -1 (read to EOF) or >= start'
    })
    .describe('Inclusive [startLine, endLine], both 1-indexed positive integers. Use -1 ONLY as the endLine sentinel (read to end of file). Never use -1 as start — start must be >= 1.')
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

const FetchUrlArgs = z.object({
  url: z.string().trim().min(1).max(2048)
    .describe('The URL to fetch. Any public web page (article, blog, docs, portfolio). A missing scheme is treated as https://. Do not pass /api/files/... paths — use view_image for those.')
}).describe('Fetch a specific URL and extract its readable text content plus any image URLs visible on the page. Use when the user names or links a source to draw information from. Returns both synthesised text AND a list of image URLs you can then inspect with view_image or embed verbatim via insert_text.')

// Only exposed when the current document is inside a workspace that the
// initiator is a member of — the runtime tool filter in prompt.post.ts
// drops these from the declarations otherwise, so the model isn't told
// about capabilities it can't actually use.
const SearchKnowledgeArgs = z.object({
  query: z.string().trim().min(1).max(500)
    .describe('Natural-language query. Semantic match, so ask the way you would ask a colleague — full phrases, not keyword salads. Example: "what does the procurement policy say about vendor onboarding timelines" rather than "procurement vendor timeline".'),
  top_k: z.number().int().min(1).max(15).optional()
    .describe('How many chunks to return. Default 5. Use 10–15 for research-style queries where you want to survey; use 3 when you want the single best hit.')
}).describe('Search the workspace knowledge base (uploaded PDFs, DOCX, etc.) by meaning and return the most relevant chunks with their source filename. Use BEFORE writing when the user references uploaded material ("what did the grant proposal say about X?", "summarise the research brief"), or when asked to write something grounded in workspace context. Only available when the document is in a workspace that has knowledge files.')

const GetKnowledgeFileArgs = z.object({
  knowledge_id: z.string().trim().min(1).max(64)
    .describe('The exact knowledge_id from the <knowledge_files> block in the system prompt. Do NOT guess — only pass ids that are listed there.')
}).describe('Retrieve the full parsed markdown of a single knowledge file. Use after `search_knowledge` when the returned chunks are insufficient and you need the whole document, or when the user asks to read / summarise a specific file by name (match it to the right knowledge_id from <knowledge_files>). Response may be truncated for very large files — an explicit marker is appended if so.')

const SetTitleArgs = z.object({
  // `.trim()` must come BEFORE `.min(1)` in Zod 4 for the length check
  // to see the trimmed string — otherwise "   " passes min(1) and only
  // later collapses to "" when the transform runs.
  title: z.string().trim().min(1).max(255)
    .describe('The new document title (1–255 characters after trimming leading/trailing whitespace).')
}).describe('Set the document title shown in the tab, topbar, and document listings.')

const ViewImageArgs = z.object({
  src: z.string().min(1).max(2048)
    .describe('The image URL or path exactly as it appears in the markdown (e.g. "/api/files/abc/def.png" for uploaded images, or "https://example.com/chart.jpg" for external URLs). Copy it verbatim from the source markdown.')
}).describe('Fetch an image from the document and add it to the conversation so you can see its contents. Use this whenever you need to reason about what an image actually shows — for writing alt text, describing figures, summarising charts, or verifying a picture matches its caption.')

const GenerateImageArgs = z.object({
  prompt: z.string().trim().min(1).max(2000)
    .describe('Detailed description of the image to generate. Be specific about subject, style, composition, mood. Good: "A warm handshake between two business professionals, shallow depth of field, office lighting, photorealistic". Weak: "handshake".'),
  alt: z.string().trim().min(1).max(200)
    .describe('Concise alt text (1–200 chars) describing the image for screen readers and fallback display. This becomes the alt attribute in the returned markdown.')
}).describe('Generate a photo or illustration from a text description and upload it. Returns the markdown reference (e.g. "![alt](/api/files/…/x.png)") — the caller decides how to place it (insert_text to add, replace_text to swap an existing image, etc.). Do NOT use for diagrams/flowcharts/charts — write a Mermaid code block via insert_text instead.')

// --- update_theme ---------------------------------------------------------
//
// Partial theme patch. Every leaf is optional and every sub-object is
// optional — the AI only sends what it wants to change, the handler
// deep-merges over the current theme. Enums + ranges mirror
// `isValidTheme` exactly so Gemini's schema advertises the same
// valid-value surface the validator enforces at runtime.
//
// Fonts are pinned to the curated Google Fonts list in `themeFonts.ts`:
// those are the only families themeToCss actually fetches, so letting
// the AI choose "Times New Roman" or similar would render as a system
// fallback rather than the classic serif the user asked for. Closest
// matches from the curated list (PT Serif, EB Garamond, Libre
// Baskerville, etc.) still get the typographic effect the user wants.

// FONT_NAMES is a non-empty tuple, which `z.enum` requires.
//
// Why fonts differ from the other enums in this file: `DocThemeSchema`
// (shared/types/theme.ts) accepts any string matching FONT_NAME_REGEX —
// that's "any CSS-safe font name". This tool intentionally restricts
// Gemini to the CURATED list of fonts we actually fetch from Google
// Fonts (via `themeFonts.ts`). If the AI picked "Times New Roman", the
// preview would silently fall back to a system font rather than render
// the serif the user asked for.
const FONT_NAMES = THEME_FONTS.map(f => f.name) as [string, ...string[]]
const PRESET_IDS = THEME_PRESETS.map(p => p.id) as [string, ...string[]]

// The numeric-range and header/footer-template schemas are repeated
// inline below rather than imported from `DocThemeSchema`, because this
// is a PATCH schema — every field is `.optional()` — and the base
// DocThemeSchema's fields are all required. Flipping them via
// `.partial()` on a deeply nested schema would lose the Gemini-friendly
// `.describe()` annotations.
//
// Enum schemas that match 1:1 with DocTheme (page size, orientation,
// text align, code theme, table bgs, borders, blockquote, mermaid
// theme, leader style) ARE imported from theme.ts to keep the valid-
// value surfaces in sync. Adding a new e.g. code theme there now
// automatically extends what the AI can request.

const RunningSlotsPatch = z.object({
  left: z.string().max(200).optional()
    .describe('Header/footer left slot template. Tokens: {title}, {page}, {pages}, {date}. Empty string disables the slot.'),
  center: z.string().max(200).optional().describe('Center slot template; same tokens as left.'),
  right: z.string().max(200).optional().describe('Right slot template; same tokens as left.')
})

// Gemini-compatibility quirk: numeric theme fields (`headings.weight`,
// `layout.columns`, `toc.maxDepth`) are declared here as STRING enums
// even though DocThemeSchema has them as numeric unions. Gemini's
// function-declaration validator rejects `oneOf` with numeric literals
// (only strings), so we accept the string form here and coerce back to
// a number in `aiToolAdapter.coerceThemePatch` before the merged theme
// goes through `isValidTheme`. The canonical numeric surface lives in
// theme.ts; don't add a new weight/column/depth value without updating
// both lists.
const UpdateThemeArgs = z.object({
  preset: z.enum(PRESET_IDS).optional()
    .describe(`Apply a built-in preset as the base, replacing ALL current theme values. Other fields passed alongside are applied on top of the preset. Available presets: ${PRESET_IDS.join(', ')}.`),
  page: z.object({
    size: PageSizeSchema.optional(),
    orientation: PageOrientationSchema.optional(),
    margin: z.number().min(0).max(60).optional().describe('Uniform page margin in mm (0–60).')
  }).optional(),
  body: z.object({
    font: z.enum(FONT_NAMES).optional()
      .describe('Body text font. Pick the closest curated Google Font to what the user asked for.'),
    size: z.number().min(6).max(24).optional().describe('Body font size in pt (6–24).'),
    lineHeight: z.number().min(0.8).max(3).optional().describe('Unitless line-height multiplier (0.8–3).'),
    textAlign: TextAlignSchema.optional(),
    color: HexColorSchema.optional().describe('Body text color, hex.'),
    background: HexColorSchema.optional().describe('Page background color, hex.')
  }).optional(),
  headings: z.object({
    font: z.enum(FONT_NAMES).optional(),
    scale: z.number().min(1).max(2).optional()
      .describe('Modular scale ratio between heading levels (1–2). Typical: 1.2 tight, 1.25 default, 1.333 airy.'),
    weight: z.enum(['400', '500', '600', '700', '800', '900']).optional()
      .describe('Heading font weight; pass as a string numeric like "600".'),
    underline: z.boolean().optional().describe('Draw a brand-colored underline below headings.'),
    color: HexColorSchema.optional()
  }).optional(),
  color: z.object({
    brand: HexColorSchema.optional().describe('Brand color used for links, accents, optional heading underline.')
  }).optional(),
  layout: z.object({
    columns: z.enum(['1', '2', '3']).optional().describe('Column count; pass as string numeric like "2".'),
    columnGap: z.number().min(0).max(30).optional().describe('Gap between columns in mm (0–30).')
  }).optional(),
  header: RunningSlotsPatch.optional(),
  footer: RunningSlotsPatch.optional(),
  code: z.object({
    theme: CodeThemeSchema.optional(),
    fontSize: z.number().min(6).max(16).optional().describe('Code block font size in pt (6–16).')
  }).optional(),
  tables: z.object({
    headerBackground: TableHeaderBgSchema.optional(),
    headerTextColor: TableHeaderColorSchema.optional(),
    borders: TableBordersSchema.optional(),
    zebra: z.boolean().optional().describe('Alternating row backgrounds.'),
    cellPadding: z.number().int().min(0).max(24).optional().describe('Cell padding in px (0–24).')
  }).optional(),
  blocks: z.object({
    imageRadius: z.number().min(0).max(32).optional().describe('Image corner radius in px (0–32).'),
    imageMaxWidth: z.number().min(10).max(100).optional().describe('Image max width as % of column (10–100).'),
    blockquoteStyle: BlockquoteStyleSchema.optional()
  }).optional(),
  mermaid: z.object({
    theme: MermaidThemeSchema.optional()
  }).optional(),
  toc: z.object({
    maxDepth: z.enum(['2', '3', '4']).optional().describe('Max heading depth shown in TOC; pass as string numeric like "3".'),
    showTitle: z.boolean().optional(),
    showPageNumbers: z.boolean().optional(),
    leaderStyle: TocLeaderStyleSchema.optional()
  }).optional()
}).describe('Update document theme settings. Pass ONLY the fields you want to change — omitted fields keep their current value. The change broadcasts live to all collaborators and persists to the database.')

// --- Inferred types the dispatcher consumes -------------------------------

export type ViewDocumentInput = z.infer<typeof ViewDocumentArgs>
export type ReplaceTextInput = z.infer<typeof ReplaceTextArgs>
export type InsertTextInput = z.infer<typeof InsertTextArgs>
export type WebSearchInput = z.infer<typeof WebSearchArgs>
export type UpdateThemeInput = z.infer<typeof UpdateThemeArgs>
export type SetTitleInput = z.infer<typeof SetTitleArgs>
export type ViewImageInput = z.infer<typeof ViewImageArgs>
export type GenerateImageInput = z.infer<typeof GenerateImageArgs>
export type FetchUrlInput = z.infer<typeof FetchUrlArgs>
export type SearchKnowledgeInput = z.infer<typeof SearchKnowledgeArgs>
export type GetKnowledgeFileInput = z.infer<typeof GetKnowledgeFileArgs>

// --- Name → schema registry used by runLoop for validate-before-dispatch --
//
// `ZodType<unknown>` is the bound so the map can hold heterogeneous schemas;
// the caller narrows via the name when it branches.
export const TOOL_SCHEMAS: Record<string, ZodType<unknown>> = {
  view_document: ViewDocumentArgs,
  replace_text: ReplaceTextArgs,
  insert_text: InsertTextArgs,
  web_search: WebSearchArgs,
  update_theme: UpdateThemeArgs,
  set_title: SetTitleArgs,
  view_image: ViewImageArgs,
  generate_image: GenerateImageArgs,
  fetch_url: FetchUrlArgs,
  search_knowledge: SearchKnowledgeArgs,
  get_knowledge_file: GetKnowledgeFileArgs
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
  ),
  decl(
    'update_theme',
    'Update the document theme (page size, fonts, colors, margins, columns, headers/footers, code styling, tables, TOC, etc.). Pass ONLY the fields you want to change — omitted keys keep their current value. Changes appear live in the preview and persist. Use this whenever the user asks for typographic, layout, or styling changes.',
    UpdateThemeArgs
  ),
  decl(
    'set_title',
    'Set the document title (1–255 chars). The title appears in the browser tab, topbar, and document listings — and is usable in header/footer templates via the {title} token. Use when the user asks to rename the document, or to give an untitled doc a title based on its contents.',
    SetTitleArgs
  ),
  decl(
    'view_image',
    'Fetch an image embedded in the document (via its URL or path as written in the markdown) and inline it into the conversation so you can visually inspect it. Use this when you need to know what an image actually depicts — for writing or improving alt text, describing figures, summarising charts, matching a caption, or cropping decisions. Without this call you only see the markdown reference, not the pixels.',
    ViewImageArgs
  ),
  decl(
    'generate_image',
    'Generate a photo or illustration from a text description and upload it (as if the user had attached it). Returns the markdown image reference — the caller decides where it goes by chaining `insert_text` (to add) or `replace_text` (to swap an existing image). Use when the user asks to add, insert, or replace a picture/photo/illustration/artwork. Do NOT use for diagrams, flowcharts, sequence diagrams, Gantt charts, ER diagrams, or pie charts — those should be Mermaid code blocks authored via `insert_text` instead.',
    GenerateImageArgs
  ),
  decl(
    'fetch_url',
    'Fetch a specific URL and extract both its readable text content AND a list of image URLs visible on the page. Use when the user names or links a source to draw information from (e.g. "write about me based on myportfolio.com"). Differs from `web_search` — that one searches the web for a topic; this one reads a URL you already have. The returned image URLs can be passed to `view_image` to inspect them or embedded directly via `insert_text` as `![alt](https://...)`.',
    FetchUrlArgs
  )
]

/**
 * Knowledge-base tools. Split out so `prompt.post.ts` can decide per
 * session whether to expose them — they're only meaningful when the
 * document is in a workspace the caller belongs to AND that workspace
 * has at least one `status='ready'` knowledge file. Exposing them
 * empty-handed invites the model to hallucinate filenames.
 */
export const KNOWLEDGE_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  decl(
    'search_knowledge',
    'Semantic search over this workspace\'s uploaded knowledge (PDFs, DOCX, etc.). Returns the top-K most relevant chunks with filename, chunk index, similarity score, and content. Use BEFORE writing when the user references uploaded files ("based on the grant proposal…", "what does the policy say about…"). Prefer this over `web_search` for workspace-private info. Only call for queries you actually intend to use — the model pays for each call.',
    SearchKnowledgeArgs
  ),
  decl(
    'get_knowledge_file',
    'Retrieve the full parsed markdown of one specific knowledge file, given its knowledge_id from the <knowledge_files> block. Use when chunks from `search_knowledge` are insufficient and you need the whole document, or when the user asks to summarise / quote a specific file by name. Large files may be truncated with an explicit marker — re-chunk your reasoning instead of asking again.',
    GetKnowledgeFileArgs
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

  // Grounding tools (`googleSearch`) and structured output (`responseSchema`)
  // don't coexist cleanly across model versions — Gemini will 400 if you
  // pass both. Stay with freeform-text + groundingMetadata: the sources
  // come back already-structured from grounding metadata, and the answer
  // text is the one field where losing strict formatting is harmless (we
  // pass it straight through to the main model, which reads prose fine).
  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [{
          text:
            `Answer this question using up-to-date web sources. Be concise (3–6 sentences). `
            + `Return ONLY the answer — do NOT list sources in the text; the caller pulls them from grounding metadata.\n\nQuery: ${query}`
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
  // Deduplicate by URI — grounding metadata frequently repeats the same
  // source multiple times (one chunk per quoted span).
  const seen = new Set<string>()
  const sources: Array<{ title: string, uri: string }> = []
  for (const c of md?.groundingChunks ?? []) {
    const uri = c.web?.uri
    if (!uri || seen.has(uri)) continue
    seen.add(uri)
    sources.push({ title: c.web?.title ?? uri, uri })
  }

  if (!answer) {
    return 'No answer returned. The search may not have surfaced relevant results.'
  }

  if (sources.length === 0) return answer
  const sourceList = sources.map(s => `  - ${s.title}: ${s.uri}`).join('\n')
  return `${answer}\n\nSources:\n${sourceList}`
}

// --- URL context sub-call -------------------------------------------------

/**
 * Executes a Gemini sub-call with the built-in `urlContext` tool enabled.
 * Same isolation rationale as `webSearch`: keeps urlContext separate from
 * our `functionDeclarations` so their coexistence behaviour across model
 * versions doesn't affect the main loop.
 *
 * The sub-call asks Gemini to both summarise the page AND list the image
 * URLs it saw — we format the result back as text with a clear `Images:`
 * section the main model can parse. We do NOT request structured output
 * because JSON mode + urlContext coexistence is not documented as stable,
 * and the main model parses the informal format fine.
 */
/**
 * Structured shape Gemini returns for `fetch_url`. Mirrors the
 * `responseSchema` below — kept as a TS interface so the parser/narrower
 * can type-check the response without an extra schema wrapper.
 */
interface FetchUrlResponse {
  summary: string
  images: Array<{ url: string, description?: string }>
}

export async function fetchUrl(
  ai: GoogleGenAI,
  model: string,
  rawUrl: string,
  signal: AbortSignal
): Promise<string> {
  if (signal.aborted) throw new Error('aborted')

  // Add an https:// scheme if the AI (or user) passed a bare hostname.
  // urlContext won't resolve scheme-less strings.
  const url = /^https?:\/\//i.test(rawUrl.trim())
    ? rawUrl.trim()
    : `https://${rawUrl.trim()}`

  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [{
          text:
            `Fetch this URL and read its content: ${url}\n\n`
            + `Produce a JSON object matching the schema. Fields:\n`
            + `- "summary": 4–8 sentences synthesising the factual content of the page (who, what, when, where, why). If the page is unreachable or empty, say so plainly here.\n`
            + `- "images": up to 6 direct image URLs visible on the page, prioritising og:image, hero images, and figure images (NOT site-chrome icons/logos). Each entry is {"url": absolute URL, "description": what it depicts}. Return an empty array if none.\n\n`
            + `Do NOT include anything outside the JSON.`
        }]
      }
    ],
    config: {
      tools: [{ urlContext: {} }],
      // Structured output hardens the shape — the main loop never has to
      // parse free-form "Images observed:" prose. If Gemini rejects
      // urlContext+JSON coexistence on a given model version, we catch
      // and fall back to raw text below.
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          images: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                description: { type: 'string' }
              },
              required: ['url']
            }
          }
        },
        required: ['summary', 'images']
      },
      abortSignal: signal
    }
  })

  const raw = (response.text ?? '').trim()
  if (!raw) {
    return `Unable to extract content from ${url}. The page may be unreachable, require authentication, or block crawlers.`
  }

  // Parse the JSON Gemini returned per the schema. If parsing fails (model
  // emitted prose or malformed JSON despite the schema hint), hand the raw
  // text back — the main model can still make sense of it.
  let parsed: FetchUrlResponse
  try {
    parsed = JSON.parse(raw) as FetchUrlResponse
  } catch {
    return raw
  }

  const lines: string[] = []
  lines.push('Summary:', parsed.summary || '(empty)')
  lines.push('')
  lines.push('Images observed on the page:')
  if (!parsed.images?.length) {
    lines.push('- (none found)')
  } else {
    for (const img of parsed.images) {
      if (!img?.url) continue
      lines.push(img.description ? `- ${img.url}: ${img.description}` : `- ${img.url}`)
    }
  }
  return lines.join('\n')
}
