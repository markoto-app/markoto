import { z } from 'zod'
import { nanoid } from 'nanoid'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import * as Sentry from '@sentry/nuxt'
import { defineMetaTool, pickStringArg, toolError, toolOk, type ToolResult } from './toolDefinition'
import type { MetaToolContext } from '../../agentic/toolContext'
import { fetchViewableExternalImage, fetchFromS3, parseInternalFileRef } from './imageFetch'
import { IMAGE_MIME_EXT, generateImageBytes } from './imageGeneration'
import { IMAGE_PROVIDER_UNAVAILABLE_MESSAGE } from '~~/shared/utils/aiProviderOutage'
import { getDoc } from '../../../repos/documents'
import { deletePending, markConfirmed, reservePendingUpload, sumImageBytesInScope } from '../../../repos/uploads'
import { imageQuotaMessage, resolveImageQuota } from '../../storage/imageQuota'
import { useS3Client } from '../../storage/s3'
import { useEnv } from '~~/shared/env/load'
import { useLogger } from '../../platform/logger'
import type { DocAccess } from '../../../repos/proofs'

// Images: view_image (show the model an image of the document or of the
// web) and generate_image (generate, store as an upload of the document,
// return its Markdown).

const log = useLogger('ai-tools')

const ViewImageArgs = z.object({
  src: z.string().min(1).max(2048)
    .describe('The image URL or path exactly as it appears in the markdown (e.g. "/api/files/abc/def.png" for uploaded images, or "https://example.com/chart.jpg" for external URLs). Copy it verbatim from the source markdown.')
}).describe('Fetch an image from the document and add it to the conversation so you can see its contents. Use this whenever you need to reason about what an image actually shows, for writing alt text, describing figures, summarising charts, or verifying a picture matches its caption.')

const GenerateImageArgs = z.object({
  prompt: z.string().trim().min(1).max(2000)
    .describe('Detailed description of the image to generate. Be specific about subject, style, composition, mood. Good: "A warm handshake between two business professionals, shallow depth of field, office lighting, photorealistic". Weak: "handshake".'),
  alt: z.string().trim().min(1).max(200)
    .describe('Concise alt text (1–200 chars) describing the image for screen readers and fallback display. This becomes the alt attribute in the returned markdown.'),
  // Aspect ratio. BFL meters by megapixel, non-square output is the
  // SAME price as 1024×1024 only when w*h ≈ 1MP. The model picks the
  // closest supported combo; deviations beyond ~1.05× MP price linearly.
  // The agentic loop should choose dimensions deliberately based on
  // intended use (logo = square, banner = wide, portrait = tall).
  width: z.number().int().min(512).max(1536).optional()
    .describe('Output image width in pixels (multiple of 32, range 512-1536). Default 1024. Use a wider value (e.g. 1408) for landscape banners; pair with smaller height. Skip both for the default 1:1 1024×1024.'),
  height: z.number().int().min(512).max(1536).optional()
    .describe('Output image height in pixels (multiple of 32, range 512-1536). Default 1024. Use a taller value (e.g. 1408) for portrait illustrations; pair with smaller width. Skip both for the default 1:1 1024×1024.')
}).describe('Generate a photo or illustration from a text description and upload it. Returns the markdown reference (e.g. "![alt](/api/files/…/x.png)"), the caller decides how to place it (insert_text to add, replace_text to swap an existing image, etc.). Do NOT use for diagrams/flowcharts/charts, write a Mermaid code block via insert_text instead.')

async function handleViewImage(
  session: MetaToolContext,
  input: z.output<typeof ViewImageArgs>
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
      return toolError('Error: cross-document image reads are not allowed. The image must belong to the current document.')
    }
    result = await fetchFromS3(internal.docId, internal.fileId)
  } else if (/^https?:\/\//i.test(src)) {
    result = await fetchViewableExternalImage(src)
  } else {
    return toolError(`Error: unsupported image src "${src.slice(0, 80)}…". Use a /api/files/{docId}/{fileId} path or an absolute http(s):// URL.`)
  }

  if ('error' in result) return toolError(`Error: ${result.error}`)

  const { bytes, mimeType } = result
  const base64 = Buffer.from(bytes).toString('base64')
  const sizeKB = Math.round(bytes.byteLength / 1024)

  return {
    content: `Fetched ${mimeType} image (${sizeKB}KB). See the following image part for the contents.`,
    isError: false,
    extraParts: [{ inlineData: { mimeType, data: base64 } }]
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

/**
 * The pending `uploads` row of a generated image, under the write proof of
 * the bound document (in-app sessions; MCP binds generate_image with
 * `access: 'edit'`). Without one, or for the anonymous-doc edge case (no
 * row), nothing is reserved. A DB failure stays non-fatal: an S3 object
 * with no row still serves and is reaped later by orphan-cleanup.
 */
async function reserveGeneratedImageRow(
  session: MetaToolContext,
  row: { fileId: string, uploaderId: number, contentType: string, sizeBytes: number, s3Key: string },
  quota: { maxBytes: number, scope: Parameters<typeof reservePendingUpload>[3] }
): Promise<{ reservedUnder: DocAccess<'write'> | null } | { error: ToolResult }> {
  const access = session.docAccess?.allows('write') ? session.docAccess : null
  if (!access || !(await getDoc(access))) return { reservedUnder: null }
  try {
    const reservation = await reservePendingUpload(access, row, quota.maxBytes, quota.scope)
    if (!reservation.reserved) return { error: toolError(`Error: ${imageQuotaMessage(quota.maxBytes)}`) }
    return { reservedUnder: access }
  } catch (e) {
    log.warn('uploads row insert failed', { key: row.s3Key, err: e })
    Sentry.captureException(e, {
      tags: { component: 'aiToolAdapter', event: 'uploads_row_insert_failed', s3Key: row.s3Key }
    })
    return { reservedUnder: null }
  }
}

/** Confirm the generated image's row; a failure is logged, not fatal. */
async function confirmGeneratedImageRow(access: DocAccess<'write'>, key: string): Promise<void> {
  try {
    await markConfirmed(access, key)
  } catch (e) {
    log.warn('uploads row insert failed', { key, err: e })
    Sentry.captureException(e, {
      tags: { component: 'aiToolAdapter', event: 'uploads_row_insert_failed', s3Key: key }
    })
  }
}

async function handleGenerateImage(
  session: MetaToolContext,
  input: z.output<typeof GenerateImageArgs>
): Promise<ToolResult> {
  // No app-side charging: the BFL custom provider bills the user's
  // LiteLLM virtual key directly via the chat-completion shape;
  // budget_exceeded surfaces as a `LitellmBudgetExhausted` thrown
  // from `generateImageBytesBfl` (caught + translated to a tool-result
  // error string).
  session.updateStatus('tool', 'Generating image…')

  // 1. Image storage quota, checked BEFORE generating so a full quota
  //    doesn't burn the user's AI budget on an image we can't store. The
  //    atomic reservation (with the real size) happens before the PUT.
  //    A Team / Business workspace document uses the workspace pool.
  const quota = await resolveImageQuota(session.initiatorUserId, session.docId)
  const quotaBytes = quota.maxBytes
  if (await sumImageBytesInScope(quota.scope) >= quotaBytes) {
    return toolError(`Error: ${imageQuotaMessage(quotaBytes)}`)
  }

  // 2. Generate. The 5-minute loop deadline is the effective cap, we
  //    don't thread a finer-grained signal here.
  const controller = new AbortController()
  const gen = await generateImageBytes(input.prompt, controller.signal, {
    provider: session.aiProviders.image,
    width: input.width,
    height: input.height,
    virtualKey: session.virtualKey,
    workspaceId: session.workspaceId,
    userId: session.initiatorUserId,
    docId: session.docId
  })
  if ('error' in gen) {
    if (gen.providerUnavailable) {
      return { ...toolError(`Error: ${gen.error}`), endSessionWith: IMAGE_PROVIDER_UNAVAILABLE_MESSAGE }
    }
    return toolError(`Error: ${gen.error}`)
  }

  // 2. Upload to S3 using the same key shape as user uploads so the
  //    existing /api/files endpoint serves it with no extra plumbing.
  session.updateStatus('tool', 'Uploading generated image…')

  const ext = IMAGE_MIME_EXT[gen.mimeType]
  const fileIdWithExt = `${nanoid(12)}.${ext}`
  const key = `docs/${session.docId}/${fileIdWithExt}`
  const s3 = useS3Client()
  const env = useEnv()

  // 3a. Reserve the bytes (pending `uploads` row) atomically against the
  //     quota BEFORE the PUT, so concurrent generations can't overshoot.
  const reserved = await reserveGeneratedImageRow(session, {
    fileId: fileIdWithExt,
    uploaderId: session.initiatorUserId,
    contentType: gen.mimeType,
    sizeBytes: gen.bytes.byteLength,
    s3Key: key
  }, quota)
  if ('error' in reserved) return reserved.error
  const rowReservedUnder = reserved.reservedUnder

  try {
    await s3.send(new PutObjectCommand({
      Bucket: env.storage.bucket,
      Key: key,
      Body: gen.bytes,
      ContentType: gen.mimeType,
      ContentLength: gen.bytes.byteLength
      // Encryption-at-rest is handled at the bucket level in prod
      // (docs/S3-SETUP.md §6). We deliberately do NOT pass
      // `ServerSideEncryption: 'AES256'` per-object because the
      // SeaweedFS backend used in dev/test rejects unknown SSE
      // headers with "We encountered an internal error", and the
      // browser presigned-PUT path (image upload request endpoint)
      // already trusts the bucket default. Keeping both paths
      // symmetric prevents one prod bucket policy change from
      // silently breaking only the AI-image flow.
    }))
  } catch (e) {
    if (rowReservedUnder) {
      await deletePending(session.self, key).catch(() => { /* reaped after 24 h */ })
    }
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return toolError(`Error: failed to upload generated image: ${msg}`)
  }

  // 3b. Confirm the row so orphan-cleanup doesn't reap it. Server-written
  //     bytes never had a presigned URL, so no staging copy is needed.
  if (rowReservedUnder) await confirmGeneratedImageRow(rowReservedUnder, key)

  // 4. Build and return the markdown. Caller chooses placement via a
  //    follow-up insert_text / replace_text call.
  const alt = sanitizeAltText(input.alt)
  const url = `/api/files/${session.docId}/${fileIdWithExt}`
  const md = `![${alt}](${url})`

  const sizeKB = Math.round(gen.bytes.byteLength / 1024)
  // Placement reminder: without it the model tended to drop the image at
  // line 0 (above the title) even when asked for "below the heading".
  return toolOk(`Generated and uploaded ${gen.mimeType} image (${sizeKB}KB). Markdown reference (copy verbatim into insert_text or replace_text): ${md}\nPlace it where the user asked: insert_text with insert_line = the line it should follow (a document's title is line 1, so "below the heading" is insert_line 1 or later, never 0). Check the line numbers with view_document if you have not seen them yet.`)
}

export const viewImageTool = defineMetaTool({
  name: 'view_image',
  description: 'Fetch an image embedded in the document (via its URL or path as written in the markdown) and inline it into the conversation so you can visually inspect it. Use this when you need to know what an image actually depicts, for writing or improving alt text, describing figures, summarising charts, matching a caption, or cropping decisions. Without this call you only see the markdown reference, not the pixels.',
  schema: ViewImageArgs,
  requires: 'vision',
  trustBoundary: { urlArg: 'src' },
  activity: args => ({ kind: 'ai.tool', tool: 'view_image', src: pickStringArg(args, 'src', 500) }),
  handler: handleViewImage
})

export const generateImageTool = defineMetaTool({
  name: 'generate_image',
  description: 'Generate a photo or illustration from a text description and upload it (as if the user had attached it). Returns the markdown image reference, the caller decides where it goes by chaining `insert_text` (to add) or `replace_text` (to swap an existing image). Use when the user asks to add, insert, or replace a picture/photo/illustration/artwork. Do NOT use for diagrams, flowcharts, sequence diagrams, Gantt charts, ER diagrams, or pie charts, those should be Mermaid code blocks authored via `insert_text` instead.',
  schema: GenerateImageArgs,
  requires: 'image',
  // A doc never needs more than a handful of new images per session.
  sessionCallCap: 5,
  activity: args => ({ kind: 'ai.tool', tool: 'generate_image', prompt: pickStringArg(args, 'prompt', 300) }),
  handler: handleGenerateImage
})
