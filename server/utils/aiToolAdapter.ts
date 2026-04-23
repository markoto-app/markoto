// Translates Gemini tool calls to Y.Doc operations on a document shared via
// Hocuspocus. Edits appear live on every connected client.
//
// Entry point: `executeFunctionByName(session, name, args)` — dispatches a
// validated tool call to the right handler.

import type { Part } from '@google/genai'
import { GoogleGenAI } from '@google/genai'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { nanoid } from 'nanoid'
import type { AiSession } from './aiClient'
import type {
  ViewDocumentInput,
  ReplaceTextInput,
  InsertTextInput,
  UpdateThemeInput,
  SetTitleInput,
  ViewImageInput,
  GenerateImageInput,
  SearchKnowledgeInput,
  GetKnowledgeFileInput
} from './agentic/functionTools'
import type { DocTheme } from '~~/shared/types/theme'
import { defaultTheme } from '~~/shared/utils/defaultTheme'
import { isValidTheme } from '~~/shared/utils/themeValidation'
import { THEME_PRESETS } from '~~/shared/utils/themePresets'
import { getDoc, updateDocMeta } from '../repos/documents'
import { recordPending, markConfirmed } from '../repos/uploads'
import { getKnowledgeWithMarkdown, searchKnowledge } from '../repos/knowledge'
import { embedQuery } from './embeddings'

export interface ToolResult {
  content: string
  isError: boolean
  /**
   * Extra content parts (e.g. image inlineData) appended to the user
   * message AFTER the functionResponse so the model can see them on the
   * next turn. Gemini's functionResponse is JSON-only — binary data has
   * to ride as a sibling `inlineData` part.
   */
  extraParts?: Part[]
}

function ok(content: string): ToolResult {
  return { content, isError: false }
}

function err(content: string): ToolResult {
  return { content, isError: true }
}

function withLineNumbers(text: string, startLine: number = 1): string {
  const lines = text.split('\n')
  return lines.map((line, i) => `${startLine + i}: ${line}`).join('\n')
}

function handleView(
  session: AiSession,
  input: { view_range?: [number, number], max_characters?: number }
): ToolResult {
  const fullText = session.ytext.toString()
  const lines = fullText.split('\n')
  let startLine = 1
  let endLine = lines.length
  if (input.view_range) {
    const [start, end] = input.view_range
    if (start < 1) return err('Error: view_range start must be >= 1')
    startLine = start
    endLine = end === -1 ? lines.length : end
    if (endLine < startLine) return err('Error: view_range end must be >= start')
  }

  const slice = lines.slice(startLine - 1, endLine).join('\n')
  let output = withLineNumbers(slice, startLine)

  if (typeof input.max_characters === 'number' && output.length > input.max_characters) {
    output = output.slice(0, input.max_characters) + '\n[truncated]'
  }

  return ok(output)
}

function findIndexOfOnlyMatch(haystack: string, needle: string): { found: number, count: number } {
  if (needle.length === 0) return { found: -1, count: 0 }
  let count = 0
  let first = -1
  let i = 0
  while (true) {
    const pos = haystack.indexOf(needle, i)
    if (pos === -1) break
    if (count === 0) first = pos
    count += 1
    i = pos + needle.length
  }
  return { found: count === 1 ? first : -1, count }
}

function handleStrReplace(
  session: AiSession,
  input: { old_str: string, new_str: string }
): ToolResult {
  if (input.old_str.length === 0) {
    return err('Error: old_str cannot be empty (use `insert_text` for empty insertion)')
  }

  const full = session.ytext.toString()
  const { found, count } = findIndexOfOnlyMatch(full, input.old_str)

  if (count === 0) {
    return err('Error: No match found for old_str. The string must match exactly, including whitespace.')
  }
  if (count > 1) {
    return err(`Error: Found ${count} matches for old_str. Please provide more surrounding context to make a unique match.`)
  }

  session.updateStatus('editing', 'Applying edit…')

  const origin = `ai:assistant:${session.sessionId}`
  session.ydoc.transact(() => {
    session.ytext.delete(found, input.old_str.length)
    session.ytext.insert(found, input.new_str)
  }, origin)

  return ok('Successfully replaced text at exactly one location.')
}

/**
 * Resolve a 1-indexed "insert after line N" into a character offset
 * into `full`. Returns null if the line is beyond EOF.
 *
 * - insert_line=0 → 0 (beginning of file)
 * - insert_line=N → start of line N+1
 * - insert_line === lines.length → end of file
 *
 * The +1-per-newline tally overshoots when the doc has no trailing
 * newline and we're appending; `Math.min(idx, full.length)` clamps us
 * back. Mid-doc positions never exceed total length, so they're
 * unaffected.
 */
/** @internal exported for unit tests; not part of the public API. */
export function lineToCharOffset(full: string, insertLine: number): number | null {
  const lines = full.split('\n')
  if (insertLine > lines.length) return null
  let idx = 0
  for (let i = 0; i < insertLine; i++) {
    idx += lines[i]!.length + 1
  }
  return Math.min(idx, full.length)
}

function handleInsert(
  session: AiSession,
  input: { insert_line: number, insert_text: string }
): ToolResult {
  const full = session.ytext.toString()
  const idx = lineToCharOffset(full, input.insert_line)
  if (idx === null) {
    const lineCount = full.split('\n').length
    return err(`Error: insert_line ${input.insert_line} is beyond the end of the file (${lineCount} lines)`)
  }

  session.updateStatus('editing', 'Applying insert…')

  const origin = `ai:assistant:${session.sessionId}`
  // Ensure the insertion itself ends with a newline so it forms clean lines.
  const insertText = input.insert_text.endsWith('\n') ? input.insert_text : input.insert_text + '\n'
  session.ydoc.transact(() => {
    session.ytext.insert(idx, insertText)
  }, origin)

  return ok('Successfully inserted text.')
}

// --- Theme update ---------------------------------------------------------

/**
 * Numeric fields are declared as string enums in the Zod schema for
 * Gemini-schema stability: weight (headings), columns (layout), maxDepth
 * (toc). Coerce them back to numbers before deep-merge + isValidTheme.
 */
/** @internal exported for unit tests; not part of the public API. */
export function coerceThemePatch(patch: UpdateThemeInput): Record<string, unknown> {
  const out: Record<string, unknown> = { ...patch }
  // `preset` is a directive, not a theme field — strip it so it doesn't
  // leak into mergeTheme and land on the final DocTheme.
  delete out.preset
  if (patch.headings?.weight !== undefined) {
    out.headings = { ...patch.headings, weight: Number(patch.headings.weight) }
  }
  if (patch.layout?.columns !== undefined) {
    out.layout = { ...patch.layout, columns: Number(patch.layout.columns) }
  }
  if (patch.toc?.maxDepth !== undefined) {
    out.toc = { ...patch.toc, maxDepth: Number(patch.toc.maxDepth) }
  }
  return out
}

/**
 * Deep-merge a partial theme patch over a complete current theme. Only
 * two levels deep (top-level sections like `body`, sub-fields like
 * `body.size`) — the theme shape is flat enough that a generic deep
 * merge isn't worth it.
 */
/** @internal exported for unit tests; not part of the public API. */
export function mergeTheme(current: DocTheme, patch: Record<string, unknown>): DocTheme {
  const merged: Record<string, unknown> = { ...(current as unknown as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      merged[key] = {
        ...(current as unknown as Record<string, Record<string, unknown>>)[key],
        ...(value as Record<string, unknown>)
      }
    } else if (value !== undefined) {
      merged[key] = value
    }
  }
  return merged as unknown as DocTheme
}

/**
 * Short human-readable summary of what the patch changed.
 * @internal exported for unit tests; not part of the public API.
 */
export function summarizePatch(patch: UpdateThemeInput): string {
  const parts: string[] = []
  if (patch.preset) parts.push(`preset=${patch.preset}`)
  const touched = Object.entries(patch)
    .filter(([k, v]) => k !== 'preset' && v && typeof v === 'object' && Object.keys(v).length > 0)
    .map(([k]) => k)
  if (touched.length) parts.push(touched.join(', '))
  return parts.length ? parts.join(' + ') : '(no changes)'
}

async function handleUpdateTheme(
  session: AiSession,
  input: UpdateThemeInput
): Promise<ToolResult> {
  // Base theme selection:
  //   - If `preset` is set, use that preset's theme as the base (full
  //     replacement — user said "change to X", so current values are
  //     discarded). Any other fields in the same call are then merged on
  //     top of the preset.
  //   - Otherwise, resolve the current theme: ymeta.theme → DB
  //     documents.theme JSONB → defaultTheme.
  let base: DocTheme
  if (input.preset) {
    const preset = THEME_PRESETS.find(p => p.id === input.preset)
    if (!preset) {
      // Should be unreachable — Zod enum restricts `preset` to known ids.
      return err(`Error: Unknown preset "${input.preset}".`)
    }
    base = preset.theme
  } else {
    const fromYmeta = session.ymeta.get('theme')
    if (isValidTheme(fromYmeta)) {
      base = fromYmeta
    } else {
      const doc = await getDoc(session.docId)
      base = (doc?.theme && isValidTheme(doc.theme)) ? doc.theme : defaultTheme
    }
  }

  const coerced = coerceThemePatch(input)
  const merged = mergeTheme(base, coerced)

  if (!isValidTheme(merged)) {
    // Should never happen — the Zod schema's enums/ranges mirror
    // isValidTheme — but this is defence-in-depth so we never write
    // structurally invalid JSON into the DB or Y.Doc.
    return err('Error: merged theme failed validation. Try narrower changes.')
  }

  session.updateStatus('editing', 'Updating theme…')

  const origin = `ai:assistant:${session.sessionId}`
  session.ydoc.transact(() => {
    session.ymeta.set('theme', merged)
  }, origin)

  // Persist to DB so fresh visitors on a new socket see the new theme
  // during the window before y-postgresql replays Y.js state. Mirrors
  // the client-side `persistTheme` debounce in `useDocument.ts`.
  try {
    await updateDocMeta(session.docId, { theme: merged })
  } catch (e) {
    // DB write is best-effort — Y.js broadcast already landed the change
    // live to everyone. Worst case: a new visitor sees stale theme for
    // the few hundred ms between connect and first Y.js sync.
    console.warn(`[aiToolAdapter] theme DB persist failed for ${session.docId}:`, e)
  }

  return ok(`Theme updated. Changed sections: ${summarizePatch(input)}. Changes are now live in the preview.`)
}

// --- Set title ------------------------------------------------------------

async function handleSetTitle(
  session: AiSession,
  input: SetTitleInput
): Promise<ToolResult> {
  // Zod trims and enforces 1–255; belt-and-braces re-check so an empty
  // trim result never reaches ymeta/DB (the meta.put endpoint also
  // validates server-side, but AI bypasses that route).
  const title = input.title.trim()
  if (title.length === 0) return err('Error: title cannot be empty')
  if (title.length > 255) return err('Error: title too long (max 255 chars)')

  session.updateStatus('editing', 'Updating title…')

  const origin = `ai:assistant:${session.sessionId}`
  session.ydoc.transact(() => {
    session.ymeta.set('title', title)
  }, origin)

  try {
    await updateDocMeta(session.docId, { title })
  } catch (e) {
    // Same tradeoff as theme: Y.js already broadcast the change live;
    // DB failure only affects what brand-new visitors see before sync.
    console.warn(`[aiToolAdapter] title DB persist failed for ${session.docId}:`, e)
  }

  return ok(`Title set to "${title}".`)
}

// --- View image -----------------------------------------------------------

// Gemini accepts a handful of image MIME types inline. Keep the allowlist
// aligned with what our upload pipeline emits plus what Gemini actually
// renders — reject anything else rather than gamble on model behavior.
const ALLOWED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif'
])

// 5 MiB cap: matches the upload flow's practical ceiling, keeps one turn's
// context footprint sane. Gemini inlines up to ~20MB per part but a 20MB
// image on every turn quickly blows up prompt-caching economics.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

// Extracts `{ docId, fileId }` from either a relative path
// (`/api/files/abc/def.png`) or an absolute URL pointing at our own
// /api/files endpoint. Returns null for anything else.
/** @internal exported for unit tests; not part of the public API. */
export function parseInternalFileRef(src: string): { docId: string, fileId: string } | null {
  const match = src.match(/\/api\/files\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+\.[A-Za-z0-9]+)(?:$|[?#])/)
  if (!match) return null
  return { docId: match[1]!, fileId: match[2]! }
}

async function fetchFromS3(docId: string, fileId: string): Promise<{ bytes: Uint8Array, mimeType: string } | { error: string }> {
  const s3 = useS3Client()
  const config = useRuntimeConfig()
  try {
    const resp = await s3.send(new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: `docs/${docId}/${fileId}`
    }))
    const mimeType = resp.ContentType ?? 'application/octet-stream'
    if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
      return { error: `Unsupported image type "${mimeType}". Allowed: ${[...ALLOWED_IMAGE_TYPES].join(', ')}.` }
    }
    if (typeof resp.ContentLength === 'number' && resp.ContentLength > MAX_IMAGE_BYTES) {
      return { error: `Image is ${Math.round(resp.ContentLength / 1024)}KB, which exceeds the ${MAX_IMAGE_BYTES / (1024 * 1024)}MB limit for inlining.` }
    }
    const bytes = await resp.Body!.transformToByteArray()
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return { error: `Image exceeded the ${MAX_IMAGE_BYTES / (1024 * 1024)}MB limit after fetch.` }
    }
    return { bytes, mimeType }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return { error: `Failed to fetch image from storage: ${msg}` }
  }
}

async function fetchExternalImage(url: string): Promise<{ bytes: Uint8Array, mimeType: string } | { error: string }> {
  // 10s hard cap — an AI session that's already racing the 5-minute
  // deadline shouldn't spend a whole minute on one image fetch.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const resp = await fetch(url, { signal: ctrl.signal, redirect: 'follow' })
    if (!resp.ok) {
      return { error: `Remote returned HTTP ${resp.status}.` }
    }
    const mimeType = (resp.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase()
    if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
      return { error: `Remote returned content-type "${mimeType || '(none)'}". Allowed: ${[...ALLOWED_IMAGE_TYPES].join(', ')}.` }
    }
    const contentLength = Number(resp.headers.get('content-length') ?? '0')
    if (contentLength && contentLength > MAX_IMAGE_BYTES) {
      return { error: `Remote image is ${Math.round(contentLength / 1024)}KB, which exceeds the ${MAX_IMAGE_BYTES / (1024 * 1024)}MB limit.` }
    }
    const bytes = new Uint8Array(await resp.arrayBuffer())
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return { error: `Remote image exceeded the ${MAX_IMAGE_BYTES / (1024 * 1024)}MB limit after fetch.` }
    }
    return { bytes, mimeType }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return { error: `Failed to fetch image: ${msg}` }
  } finally {
    clearTimeout(timer)
  }
}

async function handleViewImage(
  session: AiSession,
  input: ViewImageInput
): Promise<ToolResult> {
  const src = input.src.trim()
  session.updateStatus('tool', 'Fetching image…')

  // Internal /api/files/... path → S3 direct fetch (bypass the HTTP
  // endpoint because we're already server-side with S3 creds). Verify
  // the docId in the URL matches the session's docId so the AI can't be
  // tricked into reading images from docs the initiator shouldn't see.
  const internal = parseInternalFileRef(src)
  let result: { bytes: Uint8Array, mimeType: string } | { error: string }
  if (internal) {
    if (internal.docId !== session.docId) {
      return err('Error: cross-document image reads are not allowed. The image must belong to the current document.')
    }
    result = await fetchFromS3(internal.docId, internal.fileId)
  } else if (/^https?:\/\//i.test(src)) {
    result = await fetchExternalImage(src)
  } else {
    return err(`Error: unsupported image src "${src.slice(0, 80)}…". Use a /api/files/{docId}/{fileId} path or an absolute http(s):// URL.`)
  }

  if ('error' in result) return err(`Error: ${result.error}`)

  const { bytes, mimeType } = result
  const base64 = Buffer.from(bytes).toString('base64')
  const sizeKB = Math.round(bytes.byteLength / 1024)

  return {
    content: `Fetched ${mimeType} image (${sizeKB}KB). See the following image part for the contents.`,
    isError: false,
    extraParts: [{ inlineData: { mimeType, data: base64 } }]
  }
}

// --- Generate image -------------------------------------------------------

// Map Gemini's image MIME to the extension the upload pipeline uses.
// (Keep the set narrow — the file-id regex in /api/files only accepts
// these extensions; anything else would be unreachable via /api/files.)
const IMAGE_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp'
}

/**
 * Call Gemini's image-gen model with the prompt and pull the first
 * inlineData part out of the response. Returns the raw bytes plus
 * MIME type, or an error string.
 */
async function generateImageBytes(
  prompt: string,
  signal: AbortSignal
): Promise<{ bytes: Uint8Array, mimeType: string } | { error: string }> {
  const config = useRuntimeConfig()
  if (!config.google.geminiApiKey) return { error: 'Gemini API key not configured on the server.' }
  if (!config.google.imageModel) return { error: 'Image model not configured on the server.' }

  const ai = new GoogleGenAI({ apiKey: config.google.geminiApiKey })

  try {
    console.log(`[generate_image] calling model=${config.google.imageModel} prompt="${prompt.slice(0, 100)}…"`)
    const response = await ai.models.generateContent({
      model: config.google.imageModel,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        // The flash-image models return an image part by default; asking
        // for both modalities lets the model narrate alongside the image
        // if it wants to (we ignore the text in favor of the caller's alt).
        responseModalities: ['IMAGE', 'TEXT'],
        abortSignal: signal
      }
    })
    const cand = response.candidates?.[0]
    const parts = cand?.content?.parts ?? []
    const finishReason = cand?.finishReason
    const partKinds = parts.map(p => Object.keys(p).find(k => k !== 'thought' && p[k as keyof typeof p] !== undefined)).filter(Boolean)
    console.log(`[generate_image] finishReason=${finishReason} parts=[${partKinds.join(',')}]`)

    const imgPart = parts.find(p => p.inlineData?.data)
    if (!imgPart?.inlineData?.data) {
      // Surface the finish reason + any text the model returned — flash-image
      // sometimes returns only text with an explanation (safety block,
      // model refusal, prompt misinterpretation).
      const text = parts.map(p => p.text).filter(Boolean).join(' ').slice(0, 300)
      return {
        error: `Image model returned no image part (finishReason=${finishReason ?? 'unknown'}).`
          + (text ? ` Model text: ${text}` : ' The prompt may have been blocked by safety filters — try rephrasing.')
      }
    }
    const mimeType = imgPart.inlineData.mimeType ?? 'image/png'
    if (!IMAGE_MIME_EXT[mimeType]) {
      return { error: `Image model returned unsupported MIME type "${mimeType}".` }
    }
    const bytes = Buffer.from(imgPart.inlineData.data, 'base64')
    console.log(`[generate_image] got ${mimeType} image, ${bytes.byteLength} bytes`)
    return { bytes, mimeType }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    console.error('[generate_image] SDK threw:', msg)
    return { error: `Image generation failed: ${msg}` }
  }
}

/**
 * Escape characters that would terminate a markdown image `![alt](url)`
 * bracket pair. Alt and caption are user-facing but AI-authored; a
 * stray `]` or `)` would fragment the link.
 */
/** @internal exported for unit tests; not part of the public API. */
export function sanitizeAltText(s: string): string {
  return s.replace(/[[\]()]/g, '').replace(/\s+/g, ' ').trim()
}

async function handleGenerateImage(
  session: AiSession,
  input: GenerateImageInput
): Promise<ToolResult> {
  session.updateStatus('tool', 'Generating image…')

  // 1. Generate. The 5-minute loop deadline is the effective cap — we
  //    don't thread a finer-grained signal here.
  const controller = new AbortController()
  const gen = await generateImageBytes(input.prompt, controller.signal)
  if ('error' in gen) return err(`Error: ${gen.error}`)

  // 2. Upload to S3 using the same key shape as user uploads so the
  //    existing /api/files endpoint serves it with no extra plumbing.
  session.updateStatus('tool', 'Uploading generated image…')

  const ext = IMAGE_MIME_EXT[gen.mimeType]!
  const fileIdWithExt = `${nanoid(12)}.${ext}`
  const key = `docs/${session.docId}/${fileIdWithExt}`
  const s3 = useS3Client()
  const config = useRuntimeConfig()

  try {
    await s3.send(new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: gen.bytes,
      ContentType: gen.mimeType,
      ContentLength: gen.bytes.byteLength
    }))
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return err(`Error: failed to upload generated image: ${msg}`)
  }

  // 3. Record pending + confirm in the uploads table so orphan-cleanup
  //    doesn't reap it. Skip for anonymous-doc edge case (no FK target)
  //    — same behaviour as /api/upload/request. Best-effort: an S3
  //    object with no DB row still serves correctly; it just risks being
  //    cleaned up later if anonymous→owned promotion doesn't reconcile.
  const doc = await getDoc(session.docId)
  if (doc) {
    try {
      await recordPending({
        docId: session.docId,
        fileId: fileIdWithExt,
        uploaderId: session.initiatorUserId,
        contentType: gen.mimeType,
        sizeBytes: gen.bytes.byteLength,
        s3Key: key
      })
      await markConfirmed(key)
    } catch (e) {
      // Non-fatal — see note above.
      console.warn(`[aiToolAdapter] uploads row insert failed for ${key}:`, e)
    }
  }

  // 4. Build and return the markdown. Caller chooses placement via a
  //    follow-up insert_text / replace_text call.
  const alt = sanitizeAltText(input.alt)
  const url = `/api/files/${session.docId}/${fileIdWithExt}`
  const md = `![${alt}](${url})`

  const sizeKB = Math.round(gen.bytes.byteLength / 1024)
  return ok(`Generated and uploaded ${gen.mimeType} image (${sizeKB}KB). Markdown reference (copy verbatim into insert_text or replace_text): ${md}`)
}

/**
 * Gemini-shaped dispatcher. Args are expected pre-validated by Zod (see
 * `server/utils/agentic/functionTools.ts`); callers must not pass unvalidated
 * input. If args fail the Zod schema, the loop emits a
 * `functionResponse.isError` and this function is never called.
 *
 * `web_search` is NOT routed here — the main loop handles it via the
 * `webSearch` sub-call helper in `functionTools.ts` because it needs the
 * `GoogleGenAI` client and is async.
 */
export async function executeFunctionByName(
  session: AiSession,
  name: string,
  args: unknown
): Promise<ToolResult> {
  switch (name) {
    case 'view_document': {
      const vr = (args as ViewDocumentInput).view_range
      // Zod schema guarantees exactly two integers when present (min(2).max(2)).
      // The `!` non-null assertions tell TS what the runtime validator already
      // enforces. Narrowing to a tuple keeps `handleView`'s signature tight.
      return handleView(session, {
        view_range: vr ? [vr[0]!, vr[1]!] : undefined
      })
    }
    case 'replace_text':
      return handleStrReplace(session, args as ReplaceTextInput)
    case 'insert_text':
      return handleInsert(session, args as InsertTextInput)
    case 'update_theme':
      return handleUpdateTheme(session, args as UpdateThemeInput)
    case 'set_title':
      return handleSetTitle(session, args as SetTitleInput)
    case 'view_image':
      return handleViewImage(session, args as ViewImageInput)
    case 'generate_image':
      return handleGenerateImage(session, args as GenerateImageInput)
    case 'search_knowledge':
      return handleSearchKnowledge(session, args as SearchKnowledgeInput)
    case 'get_knowledge_file':
      return handleGetKnowledgeFile(session, args as GetKnowledgeFileInput)
    default:
      return err(`Error: Unsupported function "${name}". Supported: view_document, replace_text, insert_text, web_search, update_theme, set_title, view_image, generate_image, search_knowledge, get_knowledge_file.`)
  }
}

// --- Knowledge tools -------------------------------------------------------

// Max chars returned to the model for `get_knowledge_file`. Matches the
// inline-rewrite window — enough to fit a ~15-20k-token document, which
// covers most workspace uploads. Anything larger gets truncated with a
// marker so the model knows to re-query via `search_knowledge` for the
// rest of the content.
const KNOWLEDGE_FILE_CHAR_CAP = 40_000
// We no longer floor by raw cosine similarity — the hybrid fusion can
// surface a low-sim chunk that's a strong BM25 match (e.g. "section 4.3"
// queries) and that's the point of having BM25. Drop obvious junk via
// the per-source candidate pool size instead.

async function handleSearchKnowledge(session: AiSession, input: SearchKnowledgeInput): Promise<ToolResult> {
  if (!session.workspaceId) {
    // Defense in depth: the runtime filter should already have hidden
    // this tool from the model on non-workspace sessions. If it still
    // lands here, return a self-correcting error.
    return err('Error: search_knowledge is only available for documents inside a workspace.')
  }
  const topK = input.top_k ?? 5

  session.updateStatus('tool', `Searching workspace knowledge for "${input.query.slice(0, 80)}"…`)

  let queryEmbedding: number[]
  try {
    queryEmbedding = await embedQuery(input.query)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return err(`Error: failed to embed query: ${msg}`)
  }

  const hits = await searchKnowledge({
    workspaceId: session.workspaceId,
    queryText: input.query,
    queryEmbedding,
    topK
  })

  if (hits.length === 0) {
    return ok('No relevant chunks found in the workspace knowledge base for this query. The knowledge base may not contain information on this topic — consider web_search, fetch_url, or asking the user.')
  }

  // Format: show semantic + lexical signals so the model can tell a
  // "paraphrased near-miss" (high sim, zero textScore) from an "exact
  // phrase hit" (low sim, high textScore). Keeps RRF transparent.
  const lines: string[] = [
    `Found ${hits.length} relevant chunk${hits.length === 1 ? '' : 's'}:`,
    ''
  ]
  for (const h of hits) {
    const sim = h.similarity > 0 ? h.similarity.toFixed(3) : '—'
    const bm25 = h.textScore > 0 ? h.textScore.toFixed(3) : '—'
    lines.push(`--- ${h.filename} (chunk ${h.chunkIndex}, semantic=${sim} lexical=${bm25}) ---`)
    lines.push(h.content)
    lines.push('')
  }
  return ok(lines.join('\n'))
}

async function handleGetKnowledgeFile(session: AiSession, input: GetKnowledgeFileInput): Promise<ToolResult> {
  if (!session.workspaceId) {
    return err('Error: get_knowledge_file is only available for documents inside a workspace.')
  }

  session.updateStatus('tool', `Reading knowledge file ${input.knowledge_id}…`)

  const row = await getKnowledgeWithMarkdown(input.knowledge_id)
  if (!row) {
    return err(`Error: knowledge_id "${input.knowledge_id}" not found. Use only ids from the <knowledge_files> block in the system prompt.`)
  }
  // Scope check — knowledge is workspace-scoped, session is workspace-scoped.
  if (row.workspaceId !== session.workspaceId) {
    return err(`Error: knowledge_id "${input.knowledge_id}" belongs to a different workspace.`)
  }
  if (row.status !== 'ready') {
    return err(`Error: knowledge file "${row.filename}" is currently in status "${row.status}"${row.errorMessage ? `: ${row.errorMessage}` : ''}.`)
  }
  if (!row.markdownCache) {
    return err(`Error: knowledge file "${row.filename}" has no cached content. Try search_knowledge instead.`)
  }

  const md = row.markdownCache
  if (md.length <= KNOWLEDGE_FILE_CHAR_CAP) {
    return ok(`# ${row.filename}\n\n${md}`)
  }
  const head = md.slice(0, KNOWLEDGE_FILE_CHAR_CAP)
  return ok(
    `# ${row.filename}\n\n${head}\n\n[… truncated at ${KNOWLEDGE_FILE_CHAR_CAP} characters of ${md.length}. Use search_knowledge with a targeted query to retrieve the remaining content. …]`
  )
}
