// Translates Gemini tool calls to Y.Doc operations on a document shared via
// Hocuspocus. Edits appear live on every connected client.
//
// Entry point: `executeFunctionByName(session, name, args)` — dispatches a
// validated tool call to the right handler.

import type { Part } from '@google/genai'
import { GoogleGenAI } from '@google/genai'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { nanoid } from 'nanoid'
import * as Y from 'yjs'
import * as Sentry from '@sentry/nuxt'
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
  GetKnowledgeFileInput,
  ReadCommentsInput,
  CreateCommentInput,
  ReplyToCommentInput,
  ResolveCommentInput,
  DeleteCommentInput
} from './agentic/functionTools'
import type { DocTheme } from '~~/shared/types/theme'
import { defaultTheme } from '~~/shared/utils/defaultTheme'
import { isValidTheme } from '~~/shared/utils/themeValidation'
import { THEME_PRESETS } from '~~/shared/utils/themePresets'
import { getDoc, updateDocMeta } from '../repos/documents'
import { recordPending, markConfirmed } from '../repos/uploads'
import { getKnowledgeWithMarkdown, searchKnowledge } from '../repos/knowledge'
import { getMemberRole } from '../repos/workspaceMembers'
import { canManageDoc } from './workspaceAccess'
import { embedQuery } from './embeddings'
import { chargeInteractions, BudgetExhausted } from './billing'
import { stripAiMention } from './agentic/commentTriggerPrompt'

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
    Sentry.captureException(e, {
      tags: { component: 'aiToolAdapter', event: 'theme_persist_failed', docId: session.docId }
    })
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
    Sentry.captureException(e, {
      tags: { component: 'aiToolAdapter', event: 'title_persist_failed', docId: session.docId }
    })
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
    Sentry.captureException(e, {
      tags: { component: 'aiToolAdapter', event: 'image_generate_failed' }
    })
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
  // 1. Charge 5 interactions BEFORE the sub-call — otherwise an
  //    exhausted user can still trigger an image-gen cost we've
  //    already incurred. If charging fails we surface the error
  //    through the tool-result channel so the model sees it and can
  //    respond to the user (the runLoop also converts BudgetExhausted
  //    at the turn-charge site into a doc breadcrumb; this is the
  //    tool-level fallback for when the cap lands mid-tool-call).
  try {
    await chargeInteractions({
      attributedTo: session.attributedTo,
      plan: session.plan,
      delta: 5,
      periodStart: session.periodStart,
      reason: 'generate_image tool'
    })
  } catch (e) {
    if (e instanceof BudgetExhausted) {
      return err(`Error: AI budget exhausted — cannot generate the image. Ask the user to upgrade at /pricing.`)
    }
    throw e
  }

  session.updateStatus('tool', 'Generating image…')

  // 2. Generate. The 5-minute loop deadline is the effective cap — we
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
      Sentry.captureException(e, {
        tags: { component: 'aiToolAdapter', event: 'uploads_row_insert_failed', s3Key: key }
      })
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
    case 'read_comments':
      return handleReadComments(session, args as ReadCommentsInput)
    case 'create_comment':
      return handleCreateComment(session, args as CreateCommentInput)
    case 'reply_to_comment':
      return handleReplyToComment(session, args as ReplyToCommentInput)
    case 'resolve_comment':
      return handleResolveComment(session, args as ResolveCommentInput)
    case 'delete_comment':
      return handleDeleteComment(session, args as DeleteCommentInput)
    default:
      return err(`Error: Unsupported function "${name}". Supported: view_document, replace_text, insert_text, web_search, update_theme, set_title, view_image, generate_image, search_knowledge, get_knowledge_file, read_comments, create_comment, reply_to_comment, resolve_comment, delete_comment.`)
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

/**
 * Per-call membership recheck for knowledge tools. AI sessions are
 * long-lived (up to 5 min hard deadline) and session.workspaceId is
 * resolved ONCE at /api/ai/prompt time. If an admin demotes the
 * initiator to viewer — or removes them from the workspace entirely —
 * mid-session, we'd otherwise keep serving knowledge until the loop
 * ends. One cheap getMemberRole call per tool invocation closes that
 * window at tool-call granularity.
 *
 * Viewer role still passes: viewers can read knowledge (same as the
 * REST list endpoint). We reject only on "no membership at all".
 */
async function verifyWorkspaceMembership(session: AiSession): Promise<string | null> {
  if (!session.workspaceId) {
    return 'Error: this tool is only available for documents inside a workspace.'
  }
  const role = await getMemberRole(session.workspaceId, session.initiatorUserId)
  if (!role) {
    return 'Error: your membership in this workspace has been revoked. Knowledge tools are unavailable.'
  }
  return null
}

async function handleSearchKnowledge(session: AiSession, input: SearchKnowledgeInput): Promise<ToolResult> {
  const denied = await verifyWorkspaceMembership(session)
  if (denied) return err(denied)
  // verifyWorkspaceMembership guarantees workspaceId is non-null when
  // it returns null; TS can't follow that through the helper, hence
  // the local narrow.
  const workspaceId = session.workspaceId!
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
    workspaceId,
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
  const denied = await verifyWorkspaceMembership(session)
  if (denied) return err(denied)

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

// --- Comment tools -----------------------------------------------------------
//
// Comments live in a top-level `Y.Array<Y.Map>` named "comments" in the Y.Doc.
// Each comment map has: id, anchorStart, anchorEnd (base64 Y.RelativePositions),
// body, authorId (null for AI), authorName, authorAvatar, createdAt, updatedAt,
// resolved, replies (nested Y.Array<Y.Map>).
//
// Anchors are encoded as base64 strings via Buffer (not btoa — server context).

function _toBase64Comment(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function _fromBase64Comment(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

/** Resolve a comment's anchor to { from, to } char offsets, or null (orphan). */
function resolveCommentAnchor(
  map: Y.Map<unknown>,
  ydoc: Y.Doc
): { from: number, to: number } | null {
  const startB64 = map.get('anchorStart')
  const endB64 = map.get('anchorEnd')
  if (typeof startB64 !== 'string' || typeof endB64 !== 'string') return null
  try {
    const startRel = Y.decodeRelativePosition(_fromBase64Comment(startB64))
    const endRel = Y.decodeRelativePosition(_fromBase64Comment(endB64))
    const startAbs = Y.createAbsolutePositionFromRelativePosition(startRel, ydoc)
    const endAbs = Y.createAbsolutePositionFromRelativePosition(endRel, ydoc)
    if (!startAbs || !endAbs || startAbs.index >= endAbs.index) return null
    return { from: startAbs.index, to: endAbs.index }
  } catch {
    return null
  }
}

/** Strip mention tokens to bare @Name for model-readable display. */
function stripMentions(body: string): string {
  return body.replace(/@\[([^\]]+)\]\(user:\d+\)/g, '@$1')
}

/** Format epoch-ms as a human-readable date string. */
function fmtDate(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

function handleReadComments(
  session: AiSession,
  _input: ReadCommentsInput
): ToolResult {
  const ycomments = session.ydoc.getArray<Y.Map<unknown>>('comments')
  if (ycomments.length === 0) {
    return ok('No comments on this document.')
  }

  const fullText = session.ytext.toString()
  const ANCHOR_PREVIEW_MAX = 150

  const lines: string[] = [`Found ${ycomments.length} comment thread(s):\n`]
  for (let i = 0; i < ycomments.length; i++) {
    const map = ycomments.get(i)
    if (!(map instanceof Y.Map)) continue

    const id = map.get('id') as string
    const body = typeof map.get('body') === 'string' ? stripMentions(map.get('body') as string) : ''
    const authorName = typeof map.get('authorName') === 'string' ? (map.get('authorName') as string) : 'Unknown'
    const createdAt = typeof map.get('createdAt') === 'number' ? (map.get('createdAt') as number) : 0
    const resolved = Boolean(map.get('resolved'))

    const anchor = resolveCommentAnchor(map, session.ydoc)
    let anchorLabel: string
    if (anchor) {
      const anchorText = fullText.slice(anchor.from, anchor.to)
      const preview = anchorText.length > ANCHOR_PREVIEW_MAX
        ? anchorText.slice(0, ANCHOR_PREVIEW_MAX) + '…'
        : anchorText
      // Convert char offsets to approximate line numbers for the model
      const beforeStart = fullText.slice(0, anchor.from)
      const beforeEnd = fullText.slice(0, anchor.to)
      const startLine = beforeStart.split('\n').length
      const endLine = beforeEnd.split('\n').length
      anchorLabel = startLine === endLine
        ? `line ${startLine}: "${preview}"`
        : `lines ${startLine}–${endLine}: "${preview}"`
    } else {
      anchorLabel = '[orphaned — anchored text was deleted]'
    }

    lines.push(`--- Thread ${id}${resolved ? ' [RESOLVED]' : ''} ---`)
    lines.push(`Anchor: ${anchorLabel}`)
    lines.push(`By: ${authorName} at ${fmtDate(createdAt)}`)
    lines.push(`Comment: ${body}`)

    const repliesArr = map.get('replies')
    if (repliesArr instanceof Y.Array && repliesArr.length > 0) {
      lines.push(`Replies (${repliesArr.length}):`)
      for (let j = 0; j < repliesArr.length; j++) {
        const r = repliesArr.get(j)
        if (!(r instanceof Y.Map)) continue
        const rId = r.get('id') as string
        const rBody = typeof r.get('body') === 'string' ? stripMentions(r.get('body') as string) : ''
        const rAuthor = typeof r.get('authorName') === 'string' ? (r.get('authorName') as string) : 'Unknown'
        const rCreatedAt = typeof r.get('createdAt') === 'number' ? (r.get('createdAt') as number) : 0
        lines.push(`  [${rId}] ${rAuthor} at ${fmtDate(rCreatedAt)}: ${rBody}`)
      }
    }
    lines.push('')
  }

  return ok(lines.join('\n'))
}

async function handleCreateComment(
  session: AiSession,
  input: CreateCommentInput
): Promise<ToolResult> {
  if (input.end_line < input.start_line) {
    return err('Error: end_line must be >= start_line.')
  }

  const full = session.ytext.toString()
  const startChar = lineToCharOffset(full, input.start_line - 1)
  if (startChar === null) {
    return err(`Error: start_line ${input.start_line} is beyond the end of the document.`)
  }
  // end_line offset: start of the line AFTER end_line. Clamped to full.length
  // when end_line is the last line (lineToCharOffset returns null in that case).
  const rawEnd = lineToCharOffset(full, input.end_line)
  const endChar = rawEnd !== null ? rawEnd : full.length

  if (startChar >= endChar) {
    return err('Error: the specified line range resolves to an empty anchor. Use a range that covers at least one character.')
  }

  session.updateStatus('editing', 'Adding comment…')

  const startRel = Y.createRelativePositionFromTypeIndex(session.ytext, startChar, 0)
  const endRel = Y.createRelativePositionFromTypeIndex(session.ytext, endChar, -1)
  const anchorStart = _toBase64Comment(Y.encodeRelativePosition(startRel))
  const anchorEnd = _toBase64Comment(Y.encodeRelativePosition(endRel))

  const id = nanoid(12)
  const now = Date.now()
  const origin = `ai:assistant:${session.sessionId}`

  // Strip any `@ai` tokens the model may have written into its body —
  // otherwise its own comment would re-trigger the @ai-mention path the
  // next time the doc is loaded by a client. Belt-and-suspenders: the
  // server-side trigger guard ALSO rejects AI-authored messages, but
  // stripping here keeps the badge from rendering misleadingly in the UI.
  const safeBody = stripAiMention(input.body)

  session.ydoc.transact(() => {
    const ycomments = session.ydoc.getArray<Y.Map<unknown>>('comments')
    const map = new Y.Map<unknown>()
    map.set('id', id)
    map.set('anchorStart', anchorStart)
    map.set('anchorEnd', anchorEnd)
    map.set('body', safeBody)
    map.set('authorId', null)
    map.set('authorName', 'markoto')
    map.set('authorAvatar', null)
    map.set('createdAt', now)
    map.set('updatedAt', now)
    map.set('resolved', false)
    map.set('replies', new Y.Array())
    ycomments.push([map])
  }, origin)

  return ok(`Comment ${id} created on lines ${input.start_line}–${input.end_line}.`)
}

function handleReplyToComment(
  session: AiSession,
  input: ReplyToCommentInput
): ToolResult {
  const ycomments = session.ydoc.getArray<Y.Map<unknown>>('comments')
  let parentMap: Y.Map<unknown> | null = null
  for (let i = 0; i < ycomments.length; i++) {
    const m = ycomments.get(i)
    if (m instanceof Y.Map && m.get('id') === input.comment_id) {
      parentMap = m as Y.Map<unknown>
      break
    }
  }
  if (!parentMap) {
    return err(`Error: comment "${input.comment_id}" not found. Call read_comments to get current IDs.`)
  }

  const repliesArr = parentMap.get('replies')
  if (!(repliesArr instanceof Y.Array)) {
    return err(`Error: comment "${input.comment_id}" has a malformed replies array.`)
  }

  session.updateStatus('editing', 'Adding reply…')

  const id = nanoid(12)
  const now = Date.now()
  const origin = `ai:assistant:${session.sessionId}`

  // Strip @ai from the reply body — same rationale as create_comment.
  const safeBody = stripAiMention(input.body)

  session.ydoc.transact(() => {
    const reply = new Y.Map<unknown>()
    reply.set('id', id)
    reply.set('body', safeBody)
    reply.set('authorId', null)
    reply.set('authorName', 'markoto')
    reply.set('authorAvatar', null)
    reply.set('createdAt', now)
    reply.set('updatedAt', now)
    ;(repliesArr as Y.Array<Y.Map<unknown>>).push([reply])
    parentMap!.set('updatedAt', now)
  }, origin)

  return ok(`Reply ${id} added to thread ${input.comment_id}.`)
}

function handleResolveComment(
  session: AiSession,
  input: ResolveCommentInput
): ToolResult {
  const ycomments = session.ydoc.getArray<Y.Map<unknown>>('comments')
  for (let i = 0; i < ycomments.length; i++) {
    const m = ycomments.get(i)
    if (m instanceof Y.Map && m.get('id') === input.comment_id) {
      const origin = `ai:assistant:${session.sessionId}`
      session.ydoc.transact(() => {
        m.set('resolved', input.resolved)
        m.set('updatedAt', Date.now())
      }, origin)
      return ok(`Thread ${input.comment_id} marked as ${input.resolved ? 'resolved' : 'open'}.`)
    }
  }
  return err(`Error: comment "${input.comment_id}" not found. Call read_comments to get current IDs.`)
}

async function handleDeleteComment(
  session: AiSession,
  input: DeleteCommentInput
): Promise<ToolResult> {
  const ycomments = session.ydoc.getArray<Y.Map<unknown>>('comments')

  // Determine if the initiator has doc management rights (cached once per call).
  let _canManage: boolean | null = null
  async function initiatorCanManage(): Promise<boolean> {
    if (_canManage === null) {
      _canManage = await canManageDoc(session.initiatorUserId, session.docId)
    }
    return _canManage
  }

  function canDeleteEntry(map: Y.Map<unknown>): boolean {
    const authorId = map.get('authorId')
    const authorName = map.get('authorName')
    // markoto's own comment: authorId=null and authorName='markoto'
    // (or legacy 'AI Assistant' from before the rename — keep for
    // backwards compat on existing comment threads).
    if (authorId === null && (authorName === 'markoto' || authorName === 'AI Assistant')) return true
    // Initiator's own comment
    if (authorId === session.initiatorUserId) return true
    return false
  }

  for (let i = 0; i < ycomments.length; i++) {
    const m = ycomments.get(i)
    if (!(m instanceof Y.Map) || m.get('id') !== input.comment_id) continue

    if (input.reply_id) {
      // Delete a specific reply
      const repliesArr = m.get('replies')
      if (!(repliesArr instanceof Y.Array)) {
        return err(`Error: comment "${input.comment_id}" has no replies.`)
      }
      for (let j = 0; j < repliesArr.length; j++) {
        const r = repliesArr.get(j)
        if (!(r instanceof Y.Map) || r.get('id') !== input.reply_id) continue
        if (!canDeleteEntry(r as Y.Map<unknown>) && !(await initiatorCanManage())) {
          return err(`Error: cannot delete reply "${input.reply_id}" — it was not authored by AI Assistant or by you, and you do not have document management rights.`)
        }
        const origin = `ai:assistant:${session.sessionId}`
        session.ydoc.transact(() => {
          ;(repliesArr as Y.Array<Y.Map<unknown>>).delete(j, 1)
          m.set('updatedAt', Date.now())
        }, origin)
        return ok(`Reply ${input.reply_id} deleted from thread ${input.comment_id}.`)
      }
      return err(`Error: reply "${input.reply_id}" not found in thread "${input.comment_id}".`)
    } else {
      // Delete the whole thread
      if (!canDeleteEntry(m) && !(await initiatorCanManage())) {
        return err(`Error: cannot delete thread "${input.comment_id}" — it was not authored by AI Assistant or by you, and you do not have document management rights.`)
      }
      const origin = `ai:assistant:${session.sessionId}`
      session.ydoc.transact(() => {
        ycomments.delete(i, 1)
      }, origin)
      return ok(`Thread ${input.comment_id} deleted.`)
    }
  }

  return err(`Error: comment "${input.comment_id}" not found. Call read_comments to get current IDs.`)
}
