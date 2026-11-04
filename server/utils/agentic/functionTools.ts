import type { AgenticAIClient as AiClient, AgenticFunctionDeclaration as FunctionDeclaration } from './aiTypes'
import { litellmCompletion } from '../litellm/createCompletion'
import { z, type ZodType } from 'zod'
import { assertSafeUrl, parseToolUrl } from './urlGuard'
import { consumeWebToolQuota, isWebToolAvailable } from '../webTools'
import { useLitellmAdmin, useLitellmForUser } from '../litellmClient'
import { FEATURE_TAGS, featureMetadata } from '../litellm/featureTags'
import { providerRequestFields, withProviderErrors } from '../aiProviders/requestFields'
import type { ResolvedAiProvider } from '../aiProviders/resolve'
import { THEME_FONTS } from '~~/shared/utils/themeFonts'
import { THEME_PRESETS } from '~~/shared/utils/themePresets'
import { TEMPLATE_IDS } from '~~/shared/templates'
import { AUDIENCE_KINDS } from '~~/shared/audiences'
import { CUSTOM_CSS_MAX_BYTES } from '~~/shared/types/customCss'
import { CUSTOM_CSS_AI_REFERENCE } from '~~/shared/utils/customCssReference'
import { SAVED_THEME_DESCRIPTION_MAX, SAVED_THEME_NAME_MAX } from '~~/shared/config/savedThemes'
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
  TocLeaderStyleSchema,
  HrStyleSchema,
  CoverLayoutSchema
} from '~~/shared/types/theme'

/**
 * Function declarations + runtime arg schemas. Single source of truth — the
 * JSON Schema handed to the model (Mistral via LiteLLM) and the runtime
 * validator the loop uses to parse `FunctionCall.args` come from the same
 * Zod definition.
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
// 2020-12 (`prefixItems: [...]`) — pre-Phase-5 (Gemini-era) the function-
// declaration validator rejected both with "schema at properties.view_range
// .items must be a boolean or an object." A length-bounded array of integers
// flattens to the single-schema `items` shape that survived the migration to
// Mistral. The [start, end] ordering is enforced by description + runtime
// bounds check in `handleView`.
const ViewDocumentArgs = z.object({
  view_range: z.array(z.number().int()).min(2).max(2)
    // Enforce at the schema level so the model self-corrects with a clean
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

// --- Comment tools -----------------------------------------------------------
//
// Comments are the primary channel for AI ↔ user communication. Every comment
// appears in the sidebar in real time (same as collaborator comments).

export const ReadCommentsArgs = z.object({})
  .describe('Read all comment threads on this document: IDs, anchored line ranges, resolved status, bodies, and replies. Call this before creating, replying to, resolving, or deleting any comment.')

export const CreateCommentArgs = z.object({
  start_line: z.number().int().min(1)
    .describe('First line of the text range to anchor the comment to (1-indexed, inclusive).'),
  end_line: z.number().int().min(1)
    .describe('Last line of the text range (1-indexed, inclusive). Must be >= start_line.'),
  body: z.string().trim().min(1).max(4000)
    .describe('Comment body (max 4000 chars). Plain text — comments do not render Markdown, so no **bold**, # headings or list markup. May include @[Name](user:ID) mention tokens using IDs from <workspace_members>.')
}).describe('Place a new comment anchored to a line range. Use for review notes, questions, to-dos, or to communicate with the user about a specific part of the document. Your comment appears as "markoto".')

export const ReplyToCommentArgs = z.object({
  comment_id: z.string().min(1).max(64)
    .describe('The id of the comment thread to reply to (from read_comments).'),
  body: z.string().trim().min(1).max(2000)
    .describe('Reply body (max 2000 chars). Plain text — comments do not render Markdown, so no **bold**, # headings or list markup. May include @[Name](user:ID) mention tokens.')
}).describe('Add a reply to an existing comment thread. Your reply appears as "markoto" nested under the thread.')

export const ResolveCommentArgs = z.object({
  comment_id: z.string().min(1).max(64)
    .describe('The id of the comment thread to resolve or reopen (from read_comments).'),
  resolved: z.boolean()
    .describe('true to mark the thread resolved, false to reopen it.')
}).describe('Resolve or reopen a comment thread. Resolved threads are hidden by default in the UI but not deleted.')

export const DeleteCommentArgs = z.object({
  comment_id: z.string().min(1).max(64)
    .describe('The id of the comment thread (from read_comments).'),
  reply_id: z.string().min(1).max(64).optional()
    .describe('If provided, delete only this specific reply. If omitted, delete the whole thread.')
}).describe('Delete a comment thread or a single reply within a thread. Can only delete comments/replies authored by AI Assistant or by the user who triggered this session, unless that user has document management rights.')

const SetTitleArgs = z.object({
  // `.trim()` must come BEFORE `.min(1)` in Zod 4 for the length check
  // to see the trimmed string — otherwise "   " passes min(1) and only
  // later collapses to "" when the transform runs.
  title: z.string().trim().min(1).max(255)
    .describe('The new document title (1–255 characters after trimming leading/trailing whitespace).')
}).describe('Set the document title shown in the tab, topbar, and document listings.')

export const ViewImageArgs = z.object({
  src: z.string().min(1).max(2048)
    .describe('The image URL or path exactly as it appears in the markdown (e.g. "/api/files/abc/def.png" for uploaded images, or "https://example.com/chart.jpg" for external URLs). Copy it verbatim from the source markdown.')
}).describe('Fetch an image from the document and add it to the conversation so you can see its contents. Use this whenever you need to reason about what an image actually shows — for writing alt text, describing figures, summarising charts, or verifying a picture matches its caption.')

export const GenerateImageArgs = z.object({
  prompt: z.string().trim().min(1).max(2000)
    .describe('Detailed description of the image to generate. Be specific about subject, style, composition, mood. Good: "A warm handshake between two business professionals, shallow depth of field, office lighting, photorealistic". Weak: "handshake".'),
  alt: z.string().trim().min(1).max(200)
    .describe('Concise alt text (1–200 chars) describing the image for screen readers and fallback display. This becomes the alt attribute in the returned markdown.'),
  // Aspect ratio. BFL meters by megapixel — non-square output is the
  // SAME price as 1024×1024 only when w*h ≈ 1MP. The model picks the
  // closest supported combo; deviations beyond ~1.05× MP price linearly.
  // The agentic loop should choose dimensions deliberately based on
  // intended use (logo = square, banner = wide, portrait = tall).
  width: z.number().int().min(512).max(1536).optional()
    .describe('Output image width in pixels (multiple of 32, range 512-1536). Default 1024. Use a wider value (e.g. 1408) for landscape banners; pair with smaller height. Skip both for the default 1:1 1024×1024.'),
  height: z.number().int().min(512).max(1536).optional()
    .describe('Output image height in pixels (multiple of 32, range 512-1536). Default 1024. Use a taller value (e.g. 1408) for portrait illustrations; pair with smaller width. Skip both for the default 1:1 1024×1024.')
}).describe('Generate a photo or illustration from a text description and upload it. Returns the markdown reference (e.g. "![alt](/api/files/…/x.png)") — the caller decides how to place it (insert_text to add, replace_text to swap an existing image, etc.). Do NOT use for diagrams/flowcharts/charts — write a Mermaid code block via insert_text instead.')

// --- view_pages / get_page_count -----------------------------------------
//
// Backend rendering pair. The user sees a paginated document (paged.js
// breaks the content into A4/Letter pages with @page rules); the AI only
// sees raw markdown which has no concept of "page". When the user says
// "fix the table on page 3" or "is page 1 too dense?" the AI needs to
// actually SEE the rendered output, not just read the markdown.
//
// `get_page_count` returns just the total. Cheap when the doc is already
// rendered; triggers a fresh render otherwise (~5-15s).
//
// `view_pages([n, m, …])` returns up to 5 PNGs of specific pages as
// `inlineData` parts on the next user turn (same smuggle-via-extraParts
// pattern as `view_image`). Costs more interactions because the
// vision model charges per-image input.

export const GetPageCountArgs = z.object({}).strict()
  .describe('Return the total number of paginated pages in the current document (using the current theme\'s @page rules). Use when the user references a specific page number ("look at page 3") so you know if that page exists, before calling view_pages. Triggers a backend render if the doc hasn\'t been rendered yet.')

export const ViewPagesArgs = z.object({
  pages: z.array(z.number().int().min(1).max(50)).min(1).max(5)
    .describe('1-indexed list of page numbers to fetch. Maximum 5 pages per call. Page numbers must be within the doc\'s rendered page count (use get_page_count first if you don\'t know it).')
}).strict()
  .describe('Fetch rendered PNG images of specific pages from the current document and inline them into the conversation so you can VISUALLY inspect what those pages look like. Use when the user references a specific page ("issue on page 3", "is page 1 too dense?", "fix the table layout on page 5") — the markdown gives you the content but not the page boundaries paged.js produces. Each page costs interactions; never call this preemptively, only when the user names a specific page.')

// --- message_to_user ------------------------------------------------------
//
// The AI's only direct response surface OUTSIDE the document. Renders in
// a thin panel above the prompt bar, auto-collapsed after 2s for plain
// messages, sticky for questions. The doc itself remains the artefact;
// this is just where the AI says one short thing back to the user.
//
// Contract:
//   - `message` — at most 600 chars. Anything longer belongs in the doc.
//   - `is_question` — true means the message stays on screen until the
//     user dismisses it or replies. Default false (auto-collapse).
//
// Use cases the system prompt teaches: answer a user question that
// doesn't belong in the doc; report a finding; ask for clarification
// when the task is genuinely ambiguous. NOT for "Done" / status reports
// — those stay silent.

// --- search_activity_log --------------------------------------------------
//
// Long-term memory tier. The agentic loop's in-prompt
// `<conversation_history>` block holds the last 60 minutes (capped at
// 40 rows) of *this user's* prompts + AI tool calls + AI replies. Past
// that window, the AI must opt in to recall. `search_activity_log`
// gives it filtered access to the doc's activity log: every edit,
// comment, theme/title change, AI tool call, and restore — all users
// of the doc, not just this initiator.
//
// Use cases (from the user-facing prompt):
//   - "what did you base that table on?" → search for ai.tool rows
//     with web_search / fetch_url / search_knowledge / generate_image
//     near the time of the table edit.
//   - "revert what we did yesterday" → search for `edit` rows with
//     since=yesterday-start, before=yesterday-end.
//   - "did anyone change the title last week?" → action='title.changed'.
//
// Doc-scoped: the AI only sees activity for the current `aiSession.docId`.
// No cross-doc surface — for that, the model uses `view_other_document`
// + the destination doc's own activity.

const ACTIVITY_ACTION_NAMES = [
  'edit',
  'join',
  'leave',
  'comment.added',
  'comment.replied',
  'comment.resolved',
  'comment.reopened',
  'comment.deleted',
  'theme.changed',
  'title.changed',
  'ai.tool',
  'restore'
] as const

const SearchActivityLogArgs = z.object({
  query: z.string().trim().max(200).optional()
    .describe('Substring match against row metadata + author name (case-insensitive). Use this when the user references a specific topic ("the pricing table", "the intro") and you want to find when it was edited or commented on. Omit to search by action / time only.'),
  actions: z.array(z.enum(ACTIVITY_ACTION_NAMES)).max(12).optional()
    .describe('Restrict to specific action types. Common picks: ["edit"] (content changes), ["ai.tool"] (your own past tool calls — useful for "what did you base that on?"), ["title.changed", "theme.changed"] (metadata changes), ["restore"] (rollbacks), ["comment.added","comment.replied","comment.resolved","comment.reopened","comment.deleted"] (any comment activity). Omit for all action types.'),
  // Plain `z.string()` instead of `.datetime()` — Zod's draft-7 emit
  // for `.datetime()` includes a 600-char leap-year-aware regex that
  // some model versions reject as an invalid schema (carried over from
  // pre-Phase-5 Gemini compatibility). The handler re-validates with
  // `new Date(s)` + `isFinite` so a malformed string round-trips back
  // to the model as a clean tool error.
  since: z.string().min(1).max(40).optional()
    .describe('ISO-8601 timestamp lower bound (inclusive), UTC. Example: "2026-04-30T00:00:00Z" for "yesterday onwards" relative to a 2026-05-01 query date.'),
  before: z.string().min(1).max(40).optional()
    .describe('ISO-8601 timestamp upper bound (inclusive), UTC. Pair with `since` to window a specific day or range.'),
  limit: z.number().int().min(1).max(50).optional()
    .describe('Maximum rows to return. Default 20. Bump to 50 for survey-style queries; drop to 5–10 for "find the most recent X" lookups.')
}).strict()
  .describe('Search the document\'s long-term activity log: every edit, comment, theme/title change, AI tool call, and restore from this and prior sessions. Use when the user references something OUTSIDE the loaded `<conversation_history>` block — yesterday, last week, "what did you base X on", "find when the intro was last rewritten". Doc-scoped (current document only). Returns most-recent-first; each row carries action, author, ISO timestamp, and a brief summary. Cheap (DB query, no LLM sub-call). Don\'t use for current-state lookups — call view_document / read_comments for that.')

const MessageToUserArgs = z.object({
  message: z.string().trim().min(1).max(600)
    .describe('Short user-facing message, max 600 characters. Plain text or lightweight markdown. Use complete sentences. NOT for status reports ("Done", "Changes applied") — silence is the correct answer there. The doc edit IS the deliverable; this is for things the user needs to read OUTSIDE the doc.'),
  is_question: z.boolean().optional()
    .describe('Set true ONLY when you are asking the user something AND cannot proceed without their answer. Sticky on screen until the user dismisses or replies. Default false: the message auto-collapses after 2s and the user can re-expand it on demand.')
}).strict()
  .describe('Send a short ephemeral message back to the user, rendered above the AI prompt bar. Use when the user asked a question whose answer does NOT belong in the document (a status report on what you found, a brief explanation, a clarifying question), OR when the task is genuinely ambiguous and you need the user to choose. Prefer SILENCE for "Done" / "Changes applied" — the diff is the receipt. Each session shows only the latest message; no history.')

// --- update_theme ---------------------------------------------------------
//
// Partial theme patch. Every leaf is optional and every sub-object is
// optional — the AI only sends what it wants to change, the handler
// deep-merges over the current theme. Enums + ranges mirror
// `isValidTheme` exactly so the AI's schema advertises the same
// valid-value surface the validator enforces at runtime.
//
// Fonts are pinned to the curated, self-hosted list in `themeFonts.ts`:
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
// the model to the CURATED list of fonts we actually fetch from Google
// Fonts (via `themeFonts.ts`). If the AI picked "Times New Roman", the
// preview would silently fall back to a system font rather than render
// the serif the user asked for.
const FONT_NAMES = THEME_FONTS.map(f => f.name) as [string, ...string[]]
const PRESET_IDS = THEME_PRESETS.map(p => p.id) as [string, ...string[]]

// The numeric-range and header/footer-template schemas are repeated
// inline below rather than imported from `DocThemeSchema`, because this
// is a PATCH schema — every field is `.optional()` — and the base
// DocThemeSchema's fields are all required. Flipping them via
// `.partial()` on a deeply nested schema would lose the model-friendly
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

// Function-call compatibility quirk (carried over from pre-Phase-5
// Gemini era): numeric theme fields (`headings.weight`,
// `layout.columns`, `toc.maxDepth`) are declared here as STRING enums
// even though DocThemeSchema has them as numeric unions. The original
// function-declaration validator rejected `oneOf` with numeric
// literals (only strings); the string form has been kept stable
// post-migration to Mistral so the schema doesn't churn. We coerce
// back to a number in `aiToolAdapter.coerceThemePatch` before the
// merged theme goes through `isValidTheme`. The canonical numeric
// surface lives in theme.ts; don't add a new weight/column/depth
// value without updating both lists.
export const UpdateThemeArgs = z.object({
  preset: z.enum(PRESET_IDS).optional()
    .describe(`Apply a built-in preset as the base, replacing ALL current theme values except customCss (kept). Other fields passed alongside are applied on top of the preset. Available presets: ${PRESET_IDS.join(', ')}. Mutually exclusive with theme_id and from_workspace_default — pass only one base source.`),
  theme_id: z.string().min(1).max(64).optional()
    .describe('Apply one of the user\'s SAVED themes as the base, replacing ALL current theme values. The id comes from `list_themes` — never fabricate it. Other fields in the same call are merged on top. Mutually exclusive with `preset` and `from_workspace_default`.'),
  from_workspace_default: z.boolean().optional()
    .describe('Apply the workspace\'s default theme as the base, replacing ALL current theme values. Errors if the document is not in a workspace OR the workspace has no default set. Mutually exclusive with `preset` and `theme_id`.'),
  page: z.object({
    size: PageSizeSchema.optional(),
    orientation: PageOrientationSchema.optional(),
    margin: z.number().min(0).max(60).optional().describe('Uniform page margin in mm (0–60).')
  }).optional(),
  body: z.object({
    font: z.enum(FONT_NAMES).optional()
      .describe('Body text font. Pick the closest curated Google Font to what the user asked for. Falls back to a system serif/sans if the user names something off-list.'),
    size: z.number().min(6).max(24).optional().describe('Body font size in pt (6–24).'),
    lineHeight: z.number().min(0.8).max(3).optional().describe('Unitless line-height multiplier (0.8–3).'),
    textAlign: TextAlignSchema.optional(),
    color: HexColorSchema.optional().describe('Body text color, hex.'),
    background: HexColorSchema.optional().describe('Page background color, hex.'),
    dropCap: z.boolean().optional()
      .describe('Drop cap on the first paragraph (3.4× body size in heading font, floated left). Editorial signature — pairs naturally with novel/long-form themes.'),
    firstLineIndent: z.boolean().optional()
      .describe('Indent the first line of every paragraph except the first in a sequence. Novel typography — best paired with low paragraphSpacing (≤0.2em).'),
    paragraphSpacing: z.number().min(0).max(2).optional()
      .describe('Vertical margin between paragraphs in em (0–2). 0.6 print default, 0.2 novel-tight, 1.0 newsletter-airy.'),
    hyphenate: z.boolean().optional()
      .describe('Auto-hyphenate body text. Recommended for justified text to avoid word-spacing rivers; fine to disable for left-aligned prose.')
  }).optional(),
  headings: z.object({
    font: z.enum(FONT_NAMES).optional(),
    scale: z.number().min(1).max(2).optional()
      .describe('Modular scale ratio between heading levels (1–2). Typical: 1.2 tight, 1.25 default, 1.333 airy.'),
    weight: z.enum(['400', '500', '600', '700', '800', '900']).optional()
      .describe('Heading font weight; pass as a string numeric like "600".'),
    underline: z.boolean().optional().describe('Draw a brand-colored underline below headings.'),
    color: HexColorSchema.optional(),
    letterSpacing: z.number().min(-0.05).max(0.1).optional()
      .describe('Heading letter-spacing in em (-0.05 to 0.1). Display serifs (Fraunces) want slight negative tracking (-0.01); geometric sans tolerate 0.'),
    lineHeight: z.number().min(0.9).max(1.6).optional()
      .describe('Heading line-height multiplier (0.9–1.6). 1.2 print default; 1.25 for larger display serifs.'),
    spacingScale: z.number().min(0.5).max(2).optional()
      .describe('Multiplier on heading top margins (0.5–2). 1.0 default; 1.2 editorial breathing; 0.7 tight reports.')
  }).optional(),
  color: z.object({
    brand: HexColorSchema.optional().describe('Brand color used for links, accents, optional heading underline.'),
    secondary: HexColorSchema.optional()
      .describe('Muted neutral hue for hairlines, dividers, table borders, figcaptions, TOC leader, footnote rule. Pick a desaturated tone in the same temperature family as the brand.')
  }).optional(),
  meta: z.object({
    font: z.enum(FONT_NAMES).optional()
      .describe('Eyebrow / meta voice font for header/footer text, figcaptions, footnotes. Often a mono or distinct face for "instrument" feel; can match body for unified themes.')
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
    blockquoteStyle: BlockquoteStyleSchema.optional(),
    hrStyle: HrStyleSchema.optional()
      .describe('Horizontal-rule style. `rule`/`dashed`/`dotted` draw a line; `asterism` emits a centered ⁂ glyph (literary scene break); `none` is invisible.'),
    hrThickness: z.number().int().min(1).max(6).optional()
      .describe('HR stroke width in px (1–6). Ignored by asterism + none.')
  }).optional(),
  mermaid: z.object({
    theme: MermaidThemeSchema.optional()
      .describe('Diagram colours. `document` (recommended) derives every colour from the theme (brand, heading, text, secondary, paper), incl. chart palettes; the others are Mermaid built-ins. Diagrams always use the body font.')
  }).optional(),
  alerts: z.object({
    note: HexColorSchema.optional().describe('Color for [!NOTE] admonitions.'),
    tip: HexColorSchema.optional().describe('Color for [!TIP] admonitions.'),
    important: HexColorSchema.optional().describe('Color for [!IMPORTANT] admonitions.'),
    warning: HexColorSchema.optional().describe('Color for [!WARNING] admonitions.'),
    caution: HexColorSchema.optional().describe('Color for [!CAUTION] admonitions.')
  }).optional()
    .describe('GitHub-style admonition palette. Each color drives both the left border and the bg tint. Pick desaturated tones for warm-paper themes, traditional saturated hues for SaaS-doc themes. Caution is "stop, look here" — can borrow brand red since cover/print contexts have no AI seal to confuse.'),
  toc: z.object({
    maxDepth: z.enum(['2', '3', '4']).optional().describe('Max heading depth shown in TOC; pass as string numeric like "3".'),
    showTitle: z.boolean().optional(),
    showPageNumbers: z.boolean().optional(),
    leaderStyle: TocLeaderStyleSchema.optional()
  }).optional(),
  cover: z.object({
    enabled: z.boolean().optional()
      .describe('Toggle the title-sheet cover page (page 1 with title/subtitle/authors/date, no header/footer running text).'),
    layout: CoverLayoutSchema.optional()
      .describe('Cover composition: `centered` (vertical mid, classic), `top` (title block top, blank below), `split` (title top, meta bottom).'),
    showTitle: z.boolean().optional(),
    showSubtitle: z.boolean().optional(),
    subtitle: z.string().max(200).optional().describe('Cover subtitle text (≤200 chars).'),
    showDate: z.boolean().optional(),
    date: z.string().regex(/^(?:\d{4}-\d{2}-\d{2})?$/).optional()
      .describe('Publication date YYYY-MM-DD shown on the cover and by the {date} header/footer token (written out in the document language). Empty string = today.'),
    showAuthors: z.boolean().optional(),
    authors: z.array(z.string().max(100)).max(10).optional()
      .describe('Author name list (up to 10). Each renders on its own line — for collaboration. Pass full name strings; ordering is preserved.'),
    showLogo: z.boolean().optional()
      .describe('Render `brand.logoUrl` above the title block on the cover. Requires brand.logoUrl to be set.')
  }).optional(),
  brand: z.object({
    logoUrl: z.string().max(500).optional()
      .describe('Logo image URL: must be an image uploaded to THIS document (`/api/files/<this doc id>/<file id>`, png/jpg/gif/webp, e.g. one you generated or that is already in the document). External URLs are not accepted. Empty string clears the logo.'),
    logoHeight: z.number().int().min(8).max(80).optional()
      .describe('Logo height in px (8–80). Width scales proportionally.')
  }).optional(),
  customCss: z.string().max(CUSTOM_CSS_MAX_BYTES).optional()
    .describe(`Custom CSS for the document (preview, print and PDF only — never the app UI), appended after the generated theme CSS so its rules win. LAST RESORT: first use the structured fields above (fonts, sizes, colours, spacing, tables.zebra, blocks.*, alerts.*, header/footer, cover, layout.columns); write CSS only for what no field expresses (a coloured h2 underline, a custom alert look, a two-column section, page-number formats). REPLACES the whole existing custom CSS: call get_theme first and send the full text with your rules added — keep the user's existing rules. Empty string clears it. ${CUSTOM_CSS_AI_REFERENCE}`)
}).describe('Update document theme settings. Pass ONLY the fields you want to change — omitted fields keep their current value. The change broadcasts live to all collaborators and persists to the database. NEW theme surfaces shipped recently: cover-page section, multi-author list, drop cap (`body.dropCap`), asterism HR (`blocks.hrStyle: "asterism"`), eyebrow font (`meta.font`), secondary color (`color.secondary`), per-kind alert palette (`alerts.*`), custom CSS (`customCss` — read the field docs before using it).')

// --- Theme inspection / preset management --------------------------------
//
// Three thin tools so the AI can reason about styling beyond just
// "apply a built-in preset":
//   - get_theme: read the current ymeta.theme. No args.
//   - list_themes: enumerate the initiator's saved themes + the
//     workspace default (when applicable). Drives "mix Brand red with
//     academic" requests by giving the model both halves to compare.
//   - save_theme_as_preset: capture the current ymeta.theme as a new
//     row in `themes` for the initiator. Per-user 20-cap.
//
// All three reuse the `initiatorUserId` already on the AI session;
// they're light enough to be ALWAYS-ON (no workspace-gated split).

export const GetThemeArgs = z.object({}).describe('Read the document\'s current theme as JSON. Use BEFORE calling `update_theme` for "mix theme X with theme Y" or "tweak the current colors" — without it you don\'t know what the doc looks like right now. Pure read; no edits.')

const ListThemesArgs = z.object({}).describe('List the user\'s saved theme presets AND the workspace default theme (if the document is in a workspace and a default is set). Each saved theme returns its theme_id, name, and full theme JSON; pass the theme_id to `update_theme` to apply one as the base. Use when the user mentions a theme by name ("apply my Brand red", "use the workspace default"). Pure read; no edits.')

export const SaveThemeAsPresetArgs = z.object({
  name: z.string().trim().min(1).max(SAVED_THEME_NAME_MAX)
    .describe(`User-visible name for the preset (1–${SAVED_THEME_NAME_MAX} chars). Should describe what the theme is for ("Brand red", "Quarterly report", "Academic mix"). Becomes the label in the user's saved-themes list.`),
  description: z.string().trim().max(SAVED_THEME_DESCRIPTION_MAX).optional()
    .describe(`Optional one-line description shown under the name (≤${SAVED_THEME_DESCRIPTION_MAX} chars), e.g. "Two columns, serif body, for papers".`)
}).describe('Save the document\'s CURRENT theme as a personal preset for the initiator. Available across all their documents from the theme picker afterwards. Capped at 20 saved themes per user — call returns an error if the cap is reached. Only call when the user explicitly asks to save / bookmark / remember a theme. Does NOT change the current document\'s theme; pair with `update_theme` if they also want it applied somewhere.')

// --- Cross-document reads -------------------------------------------------
//
// Two tools that let the AI reach BEYOND the current document:
//
//   - list_workspace_documents — enumerate the OTHER docs in the
//     current session's workspace (current doc excluded). Useful for
//     "summarise everything in this workspace" or "find the doc
//     about X that I wrote last week".
//   - view_other_document — read the full body of any doc the user
//     could open in their browser. Same access surface: own private
//     docs, workspace member, public open-edit/open-view, password-
//     protected (workspace-membership bypass only — there's no way
//     to ship the password through the AI surface).
//
// Both tools share access semantics with the human session: the
// initiator's permissions, never the AI's synthetic principal.

const ListWorkspaceDocumentsArgs = z.object({}).describe('List all OTHER documents in the current document\'s workspace (the current document is excluded). Returns each doc\'s id, title, description, language, access_mode, last_active timestamp, and is_owner flag for the initiator. Errors if the document is not in a workspace. Use when the user asks to summarise the workspace, find a sibling doc by topic, or cross-reference content. After picking a candidate, call `view_other_document({ doc_id: ... })` to actually read it.')

const ListMyDocumentsArgs = z.object({
  limit: z.number().int().min(1).max(100).optional()
    .describe('Max documents to return. Default 25, cap 100. Sorted by last-active descending so the most recently touched docs come first.')
}).describe('List documents the initiator OWNS, across every workspace they participate in. Returns each doc\'s id, title, description, language, access_mode, workspace_id, word_count, and last_active timestamp. Use when the user references a doc by name without giving the id ("the Q3 retro doc", "my brand guidelines") so you can find the matching id, then call `view_other_document({ doc_id: ... })` to read it. Cross-workspace counterpart to `list_workspace_documents`, which is per-workspace and exposes shared (not just owned) docs.')

// ─── Host-style tools (Phase 4) ──────────────────────────────────────
// Tools that operate AT the user's library level rather than inside a
// specific doc: create + duplicate + export. Available to both the
// in-app agentic loop and MCP clients.

const TEMPLATE_ID_ENUM = TEMPLATE_IDS.length > 0
  ? (TEMPLATE_IDS as [string, ...string[]])
  : (['blank'] as [string, ...string[]])

export const CreateDocumentArgs = z.object({
  title: z.string().trim().max(255).optional()
    .describe('Doc title (≤255 chars after trimming). Empty / omitted falls back to "Untitled".'),
  initial_markdown: z.string().max(100_000).optional()
    .describe('Optional initial body for the new doc. Up to 100k chars. The new doc is opened as a Y.js client and this string is inserted at the start before the tool returns. Omit to get an empty doc.'),
  workspace_id: z.string().min(1).optional()
    .describe('Optional workspace id to file the doc into. Caller MUST be admin or editor of the workspace; viewers and non-members get a 403. Omit for a personal (non-workspace) doc.'),
  description: z.string().max(500).optional()
    .describe('Optional one-sentence summary, ≤500 chars. Surfaced in doc listings + injected into AI prompts as the doc\'s purpose statement.'),
  audience: z.enum(AUDIENCE_KINDS as [string, ...string[]]).optional()
    .describe(`Audience the doc is written for — drives AI tone steering. One of: ${AUDIENCE_KINDS.join(', ')}.`),
  language: z.string().trim().min(1).max(50).optional()
    .describe('Free-form language label ("English", "Deutsch", "Schwiizerdütsch"). Used in AI prompts as the writing language.'),
  template_id: z.enum(TEMPLATE_ID_ENUM).optional()
    .describe(`Template id whose default body becomes the initial markdown when initial_markdown is NOT provided. One of: ${TEMPLATE_IDS.join(', ')}.`),
  theme_preset: z.string().min(1).optional()
    .describe('Built-in theme preset id to apply (one of THEME_PRESETS). Mutually exclusive with theme_id.'),
  theme_id: z.string().min(1).max(64).optional()
    .describe('User-saved theme preset id (from list_themes). Mutually exclusive with theme_preset. Caller must own the theme.')
}).describe('Create a NEW document owned by the initiator. Returns { doc_id, url } so the caller can deep-link or follow up with view_document / insert_text. Optional initial_markdown seeds the doc body in one call.')

export const DuplicateDocumentArgs = z.object({
  source_doc_id: z.string().trim().min(1)
    .describe('The doc id to duplicate. Caller must have edit access on the source.'),
  title: z.string().trim().max(255).optional()
    .describe('Title for the duplicate. Defaults to "Copy of {source title}" when omitted.'),
  workspace_id: z.string().optional()
    .describe('Target workspace id, or empty string to park as a personal (non-workspace) doc. Omit to inherit the source\'s workspace. Caller must be admin or editor of the target.')
}).describe('Duplicate a document into a new docId owned by the initiator. Carries over title, theme, accessMode, content (Y.js state with image-URL rewrite), and S3 image assets. Returns { doc_id, url }.')

export const ExportDocumentAsMarkdownArgs = z.object({
  doc_id: z.string().min(1)
    .describe('The doc id to export.')
}).describe('Export a document as a markoto Markdown file: YAML frontmatter (title, description, audience, language, templateId, theme) followed by the body without line-number prefixes. Use to deliver the doc to the user as a file, archive a snapshot, or feed it into another tool.')

const ViewOtherDocumentArgs = z.object({
  doc_id: z.string().trim().min(1).max(2048)
    .describe('The target document id, OR a markoto URL containing it. Accepted shapes: bare id ("xyz123abc"), absolute URL ("https://markoto.app/d/xyz123abc" — works for any markoto host), root-relative path ("/d/xyz123abc"). The id is extracted server-side; trailing slashes and query strings are tolerated. Pass the URL the user paste-shared verbatim — no need to parse it yourself.'),
  view_range: z.array(z.number().int()).min(2).max(2)
    .refine(([s, e]) => s !== undefined && (s >= 1) && (e === -1 || (e !== undefined && e >= s)), { message: 'view_range must be [start, end] where start >= 1 and end is either -1 (read to EOF) or >= start' })
    .optional()
    .describe('Optional 1-indexed inclusive line range [start, end]. Use -1 for end to read through to the end of the document. Default: full document, capped at the first 50 000 characters. Page through long docs by repeating the call with non-overlapping ranges.')
}).describe('Read another document\'s body + metadata. Permission check is the SAME as if the user opened the URL in their browser: their own docs, any doc in any workspace they belong to (any role — viewer is enough), and any anonymous open-edit / open-view doc. Private docs owned by other users return "not found." Password-protected docs are accessible only when the initiator is a member of that doc\'s workspace (workspace membership bypasses the password gate). Returns line-numbered body so you can quote / replace specific lines. The current document cannot be read this way — use `view_document` instead.')

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
export type ReadCommentsInput = z.infer<typeof ReadCommentsArgs>
export type CreateCommentInput = z.infer<typeof CreateCommentArgs>
export type ReplyToCommentInput = z.infer<typeof ReplyToCommentArgs>
export type ResolveCommentInput = z.infer<typeof ResolveCommentArgs>
export type DeleteCommentInput = z.infer<typeof DeleteCommentArgs>
export type GetThemeInput = z.infer<typeof GetThemeArgs>
export type ListThemesInput = z.infer<typeof ListThemesArgs>
export type SaveThemeAsPresetInput = z.infer<typeof SaveThemeAsPresetArgs>
export type ListWorkspaceDocumentsInput = z.infer<typeof ListWorkspaceDocumentsArgs>
export type ListMyDocumentsInput = z.infer<typeof ListMyDocumentsArgs>
export type CreateDocumentInput = z.infer<typeof CreateDocumentArgs>
export type DuplicateDocumentInput = z.infer<typeof DuplicateDocumentArgs>
export type ExportDocumentAsMarkdownInput = z.infer<typeof ExportDocumentAsMarkdownArgs>
export type ViewOtherDocumentInput = z.infer<typeof ViewOtherDocumentArgs>
export type GetPageCountInput = z.infer<typeof GetPageCountArgs>
export type ViewPagesInput = z.infer<typeof ViewPagesArgs>
export type MessageToUserInput = z.infer<typeof MessageToUserArgs>
export type SearchActivityLogInput = z.infer<typeof SearchActivityLogArgs>

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
  get_theme: GetThemeArgs,
  list_themes: ListThemesArgs,
  save_theme_as_preset: SaveThemeAsPresetArgs,
  list_workspace_documents: ListWorkspaceDocumentsArgs,
  list_my_documents: ListMyDocumentsArgs,
  create_document: CreateDocumentArgs,
  duplicate_document: DuplicateDocumentArgs,
  export_document_as_markdown: ExportDocumentAsMarkdownArgs,
  view_other_document: ViewOtherDocumentArgs,
  set_title: SetTitleArgs,
  view_image: ViewImageArgs,
  generate_image: GenerateImageArgs,
  get_page_count: GetPageCountArgs,
  view_pages: ViewPagesArgs,
  fetch_url: FetchUrlArgs,
  search_knowledge: SearchKnowledgeArgs,
  get_knowledge_file: GetKnowledgeFileArgs,
  read_comments: ReadCommentsArgs,
  create_comment: CreateCommentArgs,
  reply_to_comment: ReplyToCommentArgs,
  resolve_comment: ResolveCommentArgs,
  delete_comment: DeleteCommentArgs,
  message_to_user: MessageToUserArgs,
  search_activity_log: SearchActivityLogArgs
}

// --- FunctionDeclarations (what the model sees) --------------------------
//
// `parameters` accepts any JSON-Schema-shaped object (the SDK types
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
    // Field name MUST be `parameters` (matches both `AgenticFunctionDeclaration`
    // and the OpenAI SDK's `ChatCompletionTool['function'].parameters`).
    // `internalToOpenAITools` reads `d.parameters` and falls back to an
    // EMPTY schema when missing — which is exactly what happened during
    // the Gemini→LiteLLM migration when this was named
    // `parametersJsonSchema`. Mistral then saw no required fields on
    // any tool and emitted empty `{}` arg objects, blowing up Zod
    // validation in `runLoop.ts` for every tool call.
    parameters: z.toJSONSchema(schema, { target: 'draft-7' })
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
    'Replace a single exact-match occurrence of `old_str` with `new_str` in the document. `old_str` must match EXACTLY ONE location including whitespace — include enough surrounding context to be unique. Returns an error if zero or multiple matches are found, or if `new_str` equals `old_str`. On success the result shows the edited lines as they now read.',
    ReplaceTextArgs
  ),
  decl(
    'insert_text',
    'Insert `insert_text` after line `insert_line` (1-indexed). Use insert_line=0 to insert at the very start of the document. The inserted text is newline-terminated automatically. Put any blank line you need INSIDE `insert_text` (e.g. "\\nNew paragraph.") — never call this just to add empty lines. The result shows the inserted lines as they now read.',
    InsertTextArgs
  ),
  decl(
    'web_search',
    'Search the web for up-to-date or factual information. Use for time-sensitive queries (current events, prices, recent news) before writing. Returns a synthesised answer with cited sources; the model can then cite or quote them in the document.',
    WebSearchArgs
  ),
  decl(
    'update_theme',
    'Update the document theme (page size, fonts, colors, margins, columns, headers/footers, code styling, tables, TOC, etc.). Pass ONLY the fields you want to change — omitted keys keep their current value. Changes appear live in the preview and persist. Use this whenever the user asks for typographic, layout, or styling changes. Three optional base sources (mutually exclusive): `preset` (built-in id), `theme_id` (one of the user\'s saved themes from list_themes), or `from_workspace_default: true` (the workspace\'s default theme). Without any base source, your patch merges over the CURRENT theme.',
    UpdateThemeArgs
  ),
  decl(
    'get_theme',
    'Read the document\'s current theme as JSON. Use this BEFORE update_theme when the user asks for a TWEAK to current styling ("make it warmer", "tighten the margins") or wants to MIX the current theme with another. Without this call you can only blindly replace the theme.',
    GetThemeArgs
  ),
  decl(
    'list_themes',
    'List the user\'s saved theme presets and the workspace\'s default theme (when applicable). Use BEFORE update_theme when the user names a theme by NAME ("apply my Brand red", "use the workspace default") or asks to combine two named themes. Returns each saved theme with its theme_id and full JSON so you can compare side-by-side and merge specific fields.',
    ListThemesArgs
  ),
  decl(
    'save_theme_as_preset',
    'Save the CURRENT document theme as one of the user\'s personal presets, available across all their documents going forward. Per-user cap is 20 saved themes; over-cap calls error. Only call when the user explicitly asks to save / bookmark / remember a theme — never volunteer this. Does not modify the document.',
    SaveThemeAsPresetArgs
  ),
  decl(
    'list_workspace_documents',
    'List all OTHER documents in the current document\'s workspace (the current document itself is excluded). Returns id, title, description, language, access_mode, last_active, and is_owner per row. Errors if the current document is not in a workspace. Use to find sibling docs to summarise / cross-reference, or to discover what else lives in the workspace. Pair with `view_other_document` to read a specific one.',
    ListWorkspaceDocumentsArgs
  ),
  decl(
    'list_my_documents',
    'List documents the initiator OWNS, across every workspace they participate in (NOT scoped to the current doc\'s workspace). Returns id, title, description, language, access_mode, workspace_id, word_count, and last_active per row, sorted most-recent-first. Use when the user references a doc by name without giving the id ("the Q3 retro doc", "my brand guidelines doc") so you can find the matching id and then call `view_other_document({ doc_id: ... })`. Cross-workspace counterpart to `list_workspace_documents`.',
    ListMyDocumentsArgs
  ),
  decl(
    'create_document',
    'Create a NEW document owned by the initiator. Optional initial_markdown seeds the doc body in one call (no follow-up insert_text needed). Optional workspace_id files into a workspace (caller must be admin/editor of it). Returns { doc_id, url } — share the url with the user or follow up with view_document / insert_text against the new doc_id.',
    CreateDocumentArgs
  ),
  decl(
    'duplicate_document',
    'Duplicate an existing document into a new docId owned by the initiator. Carries title, theme, accessMode, content (Y.js state with image-URL rewrite), and S3 image assets. Caller must have edit access on the source. Use for "fork this template", "make a copy I can edit", "branch this for revision". Returns { doc_id, url }.',
    DuplicateDocumentArgs
  ),
  decl(
    'export_document_as_markdown',
    'Export a document as a markoto Markdown file — the same file the editor\'s "Download Markdown" writes: YAML frontmatter (markoto version, title, description, audience, language, templateId, theme) followed by the full body without line-number prefixes. Importing the file restores the theme and properties. Use when the caller wants the doc as a file (deliver to user, archive, feed to another tool). Different from view_document, which is for AI inspection of the working text.',
    ExportDocumentAsMarkdownArgs
  ),
  decl(
    'view_other_document',
    'Read the body and metadata of ANOTHER document — anything the user could open by URL: their own private docs, any doc in any workspace they belong to (viewer role is enough), public open-edit / open-view docs, or workspace docs (membership bypasses password gates). Accepts the doc_id directly OR a full markoto URL like https://markoto.app/d/xyz. Use when the user references a specific doc by id, by name in the workspace, or by URL ("can you summarise https://markoto.app/d/abc into this doc?"). The current document cannot be read this way — call `view_document` instead. Returns line-numbered body and full metadata so you can quote, link, or summarise. Long docs are capped at 50 000 chars; use the optional `view_range` to page through.',
    ViewOtherDocumentArgs
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
    'get_page_count',
    'Return how many paginated pages the document currently has under its theme\'s @page rules. The markdown source has no inherent page count — page boundaries only exist after paged.js paginates. Use this before view_pages when you don\'t already know the total, especially when the user references a page number ("look at page 3", "is page 5 the last one?"). Cheap on cache hit, ~5-15s on cache miss (full backend render).',
    GetPageCountArgs
  ),
  decl(
    'view_pages',
    'Fetch rendered PNG screenshots of specific pages and add them to the conversation so you can SEE the typography, spacing, table layout, image placement, page-break decisions — anything that\'s visible after pagination but invisible in the markdown source. Use when the user names a specific page ("the table on page 3 is broken", "page 7 looks too sparse"). Pass a 1-indexed array of page numbers (1-5 pages per call). Each page is a real interaction-billed image input — don\'t call preemptively or "to check"; only when the user is asking about layout / visual issues on identified pages.',
    ViewPagesArgs
  ),
  decl(
    'fetch_url',
    'Fetch a specific URL and extract both its readable text content AND a list of image URLs visible on the page. Use when the user names or links a source to draw information from (e.g. "write about me based on myportfolio.com"). Differs from `web_search` — that one searches the web for a topic; this one reads a URL you already have. The returned image URLs can be passed to `view_image` to inspect them or embedded directly via `insert_text` as `![alt](https://...)`.',
    FetchUrlArgs
  ),
  decl(
    'read_comments',
    'Read all comment threads on the document: IDs, anchored line ranges, resolved status, full bodies, and replies. Always call this before creating, replying to, resolving, or deleting any comment so you have current IDs and context.',
    ReadCommentsArgs
  ),
  decl(
    'create_comment',
    'Anchor a new comment to a line range (start_line, end_line). Use for review notes, to-dos, questions, or to communicate with the user about a specific part of the document. Your comment appears as "markoto" in the sidebar. PREFER leaving a comment over writing nothing when you make an assumption or notice an issue — users see comments in real time.',
    CreateCommentArgs
  ),
  decl(
    'reply_to_comment',
    'Add a reply to an existing comment thread (by comment_id from read_comments). Use to continue a discussion or respond to a user question left in a thread.',
    ReplyToCommentArgs
  ),
  decl(
    'resolve_comment',
    'Resolve or reopen a comment thread. resolved=true hides it from the active list; resolved=false reopens it. Use after addressing a to-do or question from a thread.',
    ResolveCommentArgs
  ),
  decl(
    'delete_comment',
    'Delete a whole comment thread or a single reply (pass reply_id to target one reply). Only allowed for AI-authored comments or comments by the user who triggered this session, unless that user has document management rights.',
    DeleteCommentArgs
  ),
  decl(
    'message_to_user',
    'Send a short ephemeral message to the user above the AI prompt bar. Use when the user asked something whose answer does NOT belong in the document (a quick finding, a brief explanation, a clarifying question), OR when the task is genuinely ambiguous and you need the user to choose before proceeding. Set `is_question: true` ONLY when you cannot proceed without an answer — that keeps the message on screen until they reply or dismiss. Plain messages auto-collapse after 2 seconds. Prefer SILENCE for "Done" / "Changes applied" — the doc edit is already the receipt. Counts as a valid terminal tool call: a turn that ends with `message_to_user` (and optionally edits) is fine.',
    MessageToUserArgs
  ),
  decl(
    'search_activity_log',
    'Search the document\'s activity log — every edit, comment, theme/title change, AI tool call, and restore across ALL users and ALL prior sessions, not just the current conversation. Use when the user references something OUTSIDE the in-prompt `<conversation_history>` window: "what did you base that table on yesterday", "revert the changes from last week", "when did we last rewrite the intro", "did anyone change the title". Doc-scoped to the current document. Returns most-recent-first with author, ISO timestamp, and a one-line summary per row. Pure read; no LLM sub-call.',
    SearchActivityLogArgs
  )
]

/**
 * Knowledge-base tools. Split out so `prompt.post.ts` can decide per
 * session whether to expose them — they're only meaningful when the
 * document is in a workspace the caller belongs to AND that workspace
 * has at least one `status='ready'` knowledge file. Exposing them
 * empty-handed invites the model to hallucinate filenames.
 */
/** Tools that send images TO the model — only offered to vision-capable chat models. */
const VISION_INPUT_TOOLS = new Set(['view_image', 'view_pages'])

/**
 * Drop tools the session's providers can't serve (BYOK): no image
 * provider → no `generate_image`; a chat model without vision → no
 * `view_image` / `view_pages` (their results are image parts a
 * text-only model would reject). `web_search` / `fetch_url` are dropped
 * when the operator has no Staan / Jina key (`webTools`). Everything else
 * is unaffected.
 */
export function filterToolsForProviders(
  declarations: FunctionDeclaration[],
  providers: { chat: { supportsVision: boolean } | null, image: unknown },
  webTools: { search: boolean, fetch: boolean } = { search: true, fetch: true }
): FunctionDeclaration[] {
  const vision = providers.chat?.supportsVision ?? false
  return declarations.filter((d) => {
    const name = d.name ?? ''
    if (name === 'generate_image') return providers.image !== null
    if (name === 'web_search') return webTools.search
    if (name === 'fetch_url') return webTools.fetch
    if (VISION_INPUT_TOOLS.has(name)) return vision
    return true
  })
}

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
 * Executes a 2-call web-search sub-call: Jina Reader hands back a corpus
 * of snippets, then Mistral synthesises a grounded answer with cited
 * sources. Isolated here because:
 *   - It keeps our main agentic loop free of the
 *     "search-grounding + functionDeclarations" coexistence question
 *     that pre-Phase-5 (Gemini-era `googleSearch`) used to force.
 *   - Per-call status ("Searching the web for …") is emitted by the outer loop
 *     from the validated `FunctionCall.args` before this runs.
 *   - Output format (top answer + bulleted sources) is controlled by us, not
 *     whatever shape the upstream grounding returns.
 */
/**
 * Context threaded into the web-tool synthesis sub-calls.
 *
 * `workspaceId` / `userId` / `docId` drive the four-axis spend TAGS
 * (`featureMetadata` reads them). `virtualKey` is the LiteLLM per-user
 * virtual key the Mistral synthesis call authenticates WITH — so the
 * token spend lands on the caller's `max_budget` and a budget-exhausted
 * user's `web_search` / `fetch_url` fails at the proxy instead of
 * silently running on the master key. Both production call sites pass it
 * (the in-app loop from `billingContext.virtualKey`, MCP from
 * `MetaToolContext.virtualKey`); the admin-key fallback exists only so a
 * key-less harness path doesn't crash.
 */
export interface WebToolSpendContext {
  workspaceId?: string | null
  userId?: number | null
  docId?: string | null
  virtualKey?: string
  /**
   * The session's chat provider (BYOK key or instance default). The
   * synthesis step runs on it; when null (no provider configured) the
   * tools return the raw search results / page text unsynthesised.
   */
  chatProvider?: ResolvedAiProvider | null
}

export interface WebSearchResult {
  /** The synthesised answer text the main loop hands back to the model. */
  text: string
  /** Deduplicated grounding sources (title + uri). Used by the activity
   *  drawer to render a clickable list when the user expands the row. */
  sources: Array<{ title: string, uri: string }>
}

export async function webSearch(
  _ai: AiClient | undefined,
  _model: string,
  query: string,
  signal: AbortSignal,
  spendCtx: WebToolSpendContext = {}
): Promise<WebSearchResult> {
  // Abort guard — if we're already past the deadline, don't even issue the call.
  if (signal.aborted) throw new Error('aborted')
  if (!isWebToolAvailable('web_search')) throw new Error('Web search is not configured on this instance.')
  // Platform-paid upstream call: count it against the user's allowance
  // (shared with fetch_url and with MCP) before spending anything.
  await consumeWebToolQuota(spendCtx.userId)
  // Web search runs on Staan (staan.ai) — a European search index (OVHcloud,
  // EU) that replaces Jina Search. The motivation: Jina Search fans out to
  // Google/Bing under the hood, routing queries through US processors; Staan
  // uses its own EU index. EU-only routing (disabling Staan's optional US
  // fallback) is an ACCOUNT-LEVEL setting in the Staan dashboard — there is no
  // per-request parameter — so it must be verified enabled on the account.
  return await webSearchViaStaan(query, signal, spendCtx)
}

// --- URL context sub-call -------------------------------------------------

/**
 * Executes a 2-call URL-fetch sub-call: Jina Reader returns the page as
 * markdown, then Mistral synthesises a structured `{summary, images[]}`
 * extraction with `json_schema strict:true`. Same isolation rationale
 * as `webSearch`: keeps the URL-context behaviour separate from our
 * `functionDeclarations` so coexistence quirks don't affect the main
 * loop. (Pre-Phase-5: this used Gemini's built-in `urlContext` tool
 * with informal text output.)
 */
/**
 * Structured shape returned by `fetch_url`. Mirrors the JSON schema
 * passed to Mistral on the synthesis call — kept as a TS interface so
 * the parser/narrower can type-check the response without an extra
 * schema wrapper.
 */
interface FetchUrlResponse {
  summary: string
  images: Array<{ url: string, description?: string }>
}

export interface FetchUrlResult {
  /** The textual blob the main loop hands back to the model. */
  text: string
  /** Resolved absolute URL (with scheme prepended if needed). */
  url: string
  /** Page summary parsed from the structured response. May be empty
   *  when the synthesis fell back to raw text or the page was unreachable. */
  summary: string
  /** Image URLs the page exposes — exposed verbatim to the activity
   *  drawer for an inline strip. */
  images: Array<{ url: string, description?: string }>
}

export async function fetchUrl(
  _ai: AiClient | undefined,
  _model: string,
  rawUrl: string,
  signal: AbortSignal,
  spendCtx: WebToolSpendContext = {}
): Promise<FetchUrlResult> {
  if (signal.aborted) throw new Error('aborted')
  if (!isWebToolAvailable('fetch_url')) throw new Error('Page fetching is not configured on this instance.')

  // Parse once (bare hostnames get https://, length + scheme checked) and
  // forward the PARSED form: the URL the guard checked is byte-for-byte
  // the URL Jina receives, so a parser difference (backslashes, odd
  // escapes) can't make Jina fetch a host other than the one checked.
  const url = parseToolUrl(rawUrl).href

  // SSRF guard. Reject before forwarding to upstream — private CIDRs,
  // metadata IPs, link-local, non-HTTP schemes, and hostnames whose DNS
  // records resolve into private space all throw here.
  await assertSafeUrl(url)

  // Platform-paid Jina Reader call — counted only for URLs that passed the
  // SSRF guard, so a rejected URL never burns allowance.
  await consumeWebToolQuota(spendCtx.userId)

  // Phase 5: Jina Reader → Mistral structured output is the only path.
  // The `ai` + `model` args are retained on the signature for harness
  // compat until P5.4 retypes the loop.
  return await fetchUrlViaJina(url, signal, spendCtx)
}

// ─── AI grounding providers ─────────────────────────────────────────────
//
//   web_search → Staan /search/web (staan.ai): the European search index
//                returns ranked results (title/url/snippet) → Mistral
//                synthesis compresses them into a cited answer.
//   fetch_url  → Jina Reader (r.jina.ai) → Mistral synthesis with
//                json_schema strict:true extracting {summary, images[]}.
//                Jina stays for the direct-URL-fetch case: the user (or the
//                model) supplies a specific URL, so there is no Google/Bing
//                search backend involved — the EU-sovereignty concern that
//                motivated the Staan swap applies only to search fan-out.
//
// History: the pre-Staan web_search used Jina Search (s.jina.ai) for the
// first call. Jina Search fans out to Google/Bing, routing queries through
// US processors; Staan uses a proprietary EU index. The swap is a like-for-
// like source replacement — same 2-call (search → synthesise) shape, same
// synthesis prompt — so only the search backend changes. Staan's synthesising
// /answer endpoint would collapse this to one call but is gated to a higher
// plan tier (403 on the current key), so we keep our own synthesis step.

const _WEB_SEARCH_SYSTEM_PROMPT
  = 'You are a web-search synthesiser. Given a dump of search results '
    + 'as raw markdown, produce a single concise factual answer (3-6 '
    + 'sentences). Cite sources inline using [n] markers that index into '
    + 'the source list. Do not editorialise. Do not invent facts that '
    + 'aren\'t in the dump. If the dump doesn\'t answer the query, say '
    + 'so in one sentence.'

// Staan /search/web response envelope (fields we consume). See
// https://docs.staan.ai/docs/web-search.md.
interface StaanSearchResult {
  title?: string
  url?: string
  snippet?: string
}
interface StaanSearchResponse {
  search_id?: string
  web?: { results?: StaanSearchResult[] }
}

async function webSearchViaStaan(
  query: string,
  signal: AbortSignal,
  spendCtx: WebToolSpendContext = {}
): Promise<WebSearchResult> {
  const staanKey = process.env.STAAN_API_KEY
  if (!staanKey) {
    throw new Error('STAAN_API_KEY not configured (required for web_search)')
  }

  // 1) Staan search — returns up to 10 ranked results with title/url/snippet.
  //    Staan enforces a 400-char query cap and rejects longer queries.
  const staanRes = await fetch('https://api.staan.ai/v2/search/web', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${staanKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      q: query.trim().slice(0, 400),
      // en-us is the broadest index for an English-first product; the doc
      // language isn't threaded into this sub-call today. `count` is fixed
      // at 10 by the API.
      market: 'en-us'
    }),
    signal
  })
  if (!staanRes.ok) {
    throw new Error(`Staan search returned ${staanRes.status}`)
  }
  const staanPayload = await staanRes.json() as StaanSearchResponse
  const results = staanPayload.web?.results ?? []

  if (results.length === 0) {
    return {
      text: 'No search results returned. The query may be too specific or filtered.',
      sources: []
    }
  }

  // 2) Mistral synthesis — pass results as a numbered list, ask for a
  //    concise answer with [n] citations.
  const dump = results.slice(0, 8).map((r, i) =>
    `[${i + 1}] ${r.title ?? ''}\nURL: ${r.url ?? ''}\n${(r.snippet ?? '').slice(0, 1500)}`
  ).join('\n\n---\n\n')

  const sources = results.slice(0, 8).map(r => ({
    title: (r.title ?? r.url ?? '').slice(0, 200),
    uri: r.url ?? ''
  })).filter(s => s.uri)

  // No chat provider (no BYOK key, no instance default): hand the raw
  // ranked results back instead of a synthesised answer. Search itself is
  // platform-provided and works without a key.
  const provider = spendCtx.chatProvider
  if (!provider) {
    return { text: `Search results for "${query}":\n\n${dump}`, sources }
  }

  // Authenticate the synthesis with the caller's virtual key (rpm limits
  // + spend tags) and run it on the session's chat provider — the user's
  // own key under BYOK. Fall back to the master key only when a key-less
  // harness path reaches here.
  const litellm = spendCtx.virtualKey ? useLitellmForUser(spendCtx.virtualKey) : useLitellmAdmin()
  const providerFields = await providerRequestFields(provider)

  const synth = await withProviderErrors(provider, () => litellmCompletion(litellm, {
    ...providerFields,
    messages: [
      { role: 'system', content: _WEB_SEARCH_SYSTEM_PROMPT },
      { role: 'user', content: `Query: ${query}\n\nSearch results:\n${dump}` }
    ],
    max_tokens: 400,
    // Modest temperature for the prose synthesis (no structured-output
    // contract). `fetch_url` synthesis stays at 0 because it has a strict
    // JSON schema; the outer agentic loop stays at 0 for tool determinism.
    temperature: 0.3,
    // Sub-step of the text agentic loop — same tag set so /admin/ai-spend's
    // "text-loop" total includes web_search synthesis and the workspace +
    // user breakdowns attribute correctly.
    ...featureMetadata(FEATURE_TAGS.textLoop, spendCtx)
  }, { signal }))

  const answer = (synth.choices?.[0]?.message?.content ?? '').trim()

  if (!answer) {
    return { text: 'No answer returned by the synthesiser.', sources }
  }
  if (sources.length === 0) return { text: answer, sources: [] }
  const sourceList = sources.map(s => `  - ${s.title}: ${s.uri}`).join('\n')
  return { text: `${answer}\n\nSources:\n${sourceList}`, sources }
}

// fetch_url 2-call: Jina Reader produces clean markdown of the page; a
// follow-up Mistral chat-completion with json_schema strict:true returns
// the existing {summary, images[]} contract.

const _FETCH_URL_SYSTEM_PROMPT
  = 'You are a page-content extractor. The user gives you a markdown '
    + 'rendering of a web page produced by Jina Reader. Return JSON '
    + 'matching the provided schema. The summary is 4-8 sentences of '
    + 'factual page content (who/what/when/where/why). The images array '
    + 'is up to 6 hero/figure image URLs from the page (NOT site-chrome '
    + 'icons or logos). Do not editorialise.'

const _FETCH_URL_JSON_SCHEMA = {
  name: 'page_extract',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'images'],
    properties: {
      summary: { type: 'string' },
      images: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['url', 'description'],
          properties: {
            url: { type: 'string' },
            description: { type: 'string' }
          }
        }
      }
    }
  }
}

async function fetchUrlViaJina(
  url: string,
  signal: AbortSignal,
  spendCtx: WebToolSpendContext = {}
): Promise<FetchUrlResult> {
  const jinaKey = process.env.JINA_AI_API_KEY
  if (!jinaKey) {
    throw new Error('JINA_AI_API_KEY not configured (required for fetch_url via mistral path)')
  }

  // 1) Jina Reader — returns the page as clean markdown.
  const readerUrl = `https://r.jina.ai/${url}`
  const readerRes = await fetch(readerUrl, {
    headers: {
      'Authorization': `Bearer ${jinaKey}`,
      'Accept': 'application/json',
      // Cap output so we don't pass 40k tokens to the synthesiser.
      'X-Token-Budget': '8000',
      // Keep image references verbatim so the extractor can list them.
      'X-Retain-Images': 'all'
    },
    signal
  })
  if (!readerRes.ok) {
    return {
      text: `Unable to extract content from ${url}. Reader returned ${readerRes.status}.`,
      url,
      summary: '',
      images: []
    }
  }
  const readerPayload = await readerRes.json() as { data?: { content?: string, title?: string } }
  const pageMarkdown = readerPayload.data?.content ?? ''
  const pageTitle = readerPayload.data?.title ?? ''

  if (!pageMarkdown) {
    return {
      text: `Unable to extract content from ${url}. The page may be empty or block crawlers.`,
      url,
      summary: '',
      images: []
    }
  }

  // No chat provider configured: return the extracted page text itself
  // (truncated) — the reader is platform-provided and works without a key.
  const provider = spendCtx.chatProvider
  if (!provider) {
    const excerpt = pageMarkdown.slice(0, 12000)
    return { text: `Page: ${pageTitle || url}\n\n${excerpt}`, url, summary: excerpt, images: [] }
  }

  // 2) Structured-output synthesis — extract {summary, images[]} — on the
  // session's chat provider (the user's own key under BYOK), authenticated
  // with the caller's virtual key. Master key only for a key-less harness.
  // A BYOK model without `json_schema` support returns prose; the
  // JSON.parse fallback below hands that prose back verbatim.
  const litellm = spendCtx.virtualKey ? useLitellmForUser(spendCtx.virtualKey) : useLitellmAdmin()
  const providerFields = await providerRequestFields(provider)

  const synth = await withProviderErrors(provider, () => litellmCompletion(litellm, {
    ...providerFields,
    messages: [
      { role: 'system', content: _FETCH_URL_SYSTEM_PROMPT },
      { role: 'user', content: `URL: ${url}\nTitle: ${pageTitle}\n\nPage content:\n${pageMarkdown.slice(0, 30000)}` }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: _FETCH_URL_JSON_SCHEMA
    },
    max_tokens: 800,
    temperature: 0,
    // Sub-tool of the text agentic loop — same tag set as the
    // surrounding loop call so workspace + user + doc breakdowns
    // attribute correctly.
    ...featureMetadata(FEATURE_TAGS.textLoop, spendCtx)
  }, { signal }))

  const raw = synth.choices?.[0]?.message?.content ?? ''
  let parsed: FetchUrlResponse
  try {
    parsed = JSON.parse(raw) as FetchUrlResponse
  } catch {
    return { text: raw, url, summary: '', images: [] }
  }

  const lines: string[] = []
  lines.push(
    'Summary:', parsed.summary || '(empty)',
    '',
    'Images observed on the page:'
  )
  if (parsed.images?.length) {
    for (const img of parsed.images) {
      if (!img?.url) continue
      lines.push(img.description ? `- ${img.url}: ${img.description}` : `- ${img.url}`)
    }
  } else {
    lines.push('- (none found)')
  }
  return {
    text: lines.join('\n'),
    url,
    summary: parsed.summary ?? '',
    images: (parsed.images ?? []).filter(i => i?.url)
  }
}
