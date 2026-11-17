import * as Sentry from '@sentry/nuxt'
import { litellmCompletion, litellmImage } from '../../litellm/createCompletion'
import { providerRequestFields, withProviderErrors } from '../../aiProviders/requestFields'
import type { ResolvedAiProvider } from '../../aiProviders/resolve'
import { useLitellmForUser } from '../litellmClient'
import { FEATURE_TAGS, featureMetadata } from '../../litellm/featureTags'
import type { ExternalImageResult } from '../../storage/externalImage'
import { budgetExhaustedMessage } from '../../billing/billingMode'
import { FREE_ALLOWANCE_EXHAUSTED_MESSAGE, isFreeAllowanceExhaustedError } from '../../litellm/freeTierTeam'
import { useEnv } from '~~/shared/env/load'
import { useLogger } from '../../platform/logger'
import { fetchViewableExternalImage } from './imageFetch'
import { isProviderUnavailableError } from './providerOutage'

const log = useLogger('ai-tools')

// Map the image-gen output MIME (BFL FLUX) to
// the extension the upload pipeline uses. (Keep the set narrow, the
// file-id regex in /api/files only accepts these extensions; anything
// else would be unreachable via /api/files.)
export const IMAGE_MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp'
} as const
type GeneratedImageMime = keyof typeof IMAGE_MIME_EXT

/**
 * A generated image fetched from the provider's URL, kept only in a format
 * the upload path stores (`view_image` also admits GIF / HEIC, which a
 * generated image must not become: it would get no file extension).
 */
/** @internal exported for unit tests; not part of the public API. */
export function generatedImageFromFetch(fetched: ExternalImageResult): ImageGenResult {
  if ('error' in fetched) return fetched
  const { mimeType } = fetched
  if (!isGeneratedImageMime(mimeType)) return { error: 'The image provider returned an unsupported image format.' }
  return { bytes: fetched.bytes, mimeType }
}

function isGeneratedImageMime(mime: string): mime is GeneratedImageMime {
  return Object.hasOwn(IMAGE_MIME_EXT, mime)
}

interface ImageGenOpts {
  /** The session's image provider (BYOK / instance default). Null = unavailable. */
  provider: ResolvedAiProvider | null
  /** Output width in pixels. Default from NUXT_LITELLM_IMAGE_DEFAULT_WIDTH (1024). */
  width?: number
  /** Output height in pixels. Default from NUXT_LITELLM_IMAGE_DEFAULT_HEIGHT (1024). */
  height?: number
  /** Per-user LiteLLM virtual-key bearer token. */
  virtualKey?: string
  /** Workspace context for spend-tagging. */
  workspaceId?: string | null
  /** Initiating user id for spend-tagging. */
  userId?: number | null
  /** Doc the image is being inserted into, drives doc-axis spend tag. */
  docId?: string | null
}

/**
 * `providerUnavailable`: the provider answered 5xx or could not be reached
 * (not our fault, not the user's). `budget`: the platform-paid call was
 * refused because the user's AI Points (`personal`) or the shared free
 * allowance (`free-allowance`) are used up.
 */
export type ImageGenFailure = { error: string, providerUnavailable?: true, budget?: 'personal' | 'free-allowance' }
type ImageGenResult = { bytes: Uint8Array, mimeType: GeneratedImageMime } | ImageGenFailure

/**
 * Generate an image from a text prompt. Two paths, picked by the
 * resolved image provider:
 *
 *   - BYOK (user key, or an instance default with base URL): the user's
 *     OpenAI-compatible images API via LiteLLM's zero-cost `byok/*`
 *     deployment (`/v1/images/generations`).
 *   - Instance default WITHOUT base URL: the operator's LiteLLM model
 *     alias, using the chat-wrapped convention of the bundled
 *     `flux-3-image-klein` deployment (BFL FLUX 3 Image Klein, EU-pinned). Platform-paid.
 *
 * Returns raw bytes + MIME type, or an error string. The S3 upload + Y.js
 * insertion happens in `handleGenerateImage` and is shape-agnostic.
 */
export async function generateImageBytes(
  prompt: string,
  _signal: AbortSignal,
  opts: ImageGenOpts
): Promise<ImageGenResult> {
  const provider = opts.provider
  if (!provider) {
    return { error: 'Image generation is not available: no image provider is configured. The user can add one under Settings → AI provider.' }
  }
  if (provider.credentials) return generateImageBytesByok(prompt, provider, opts)
  return generateImageBytesBfl(prompt, provider.model, opts)
}

/** Sniff PNG / JPEG / WebP from magic bytes, providers don't always say. */
function sniffImageMime(bytes: Uint8Array): GeneratedImageMime | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg'
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return null
}

/**
 * OpenAI-style images APIs only accept a few fixed sizes. Map the
 * requested aspect to the nearest of the common gpt-image sizes.
 */
function openAiImageSize(width: number, height: number): string {
  if (width > height * 1.2) return '1536x1024'
  if (height > width * 1.2) return '1024x1536'
  return '1024x1024'
}

// ─── BYOK path: OpenAI-compatible images API ────────────────────────────

async function generateImageBytesByok(
  prompt: string,
  provider: ResolvedAiProvider,
  opts: ImageGenOpts
): Promise<ImageGenResult> {
  if (!opts.virtualKey) return { error: 'Image generation requires a LiteLLM virtual key.' }
  const env = useEnv()
  const width = opts.width ?? env.litellm.imageDefaultWidth ?? 1024
  const height = opts.height ?? env.litellm.imageDefaultHeight ?? 1024
  try {
    const litellm = useLitellmForUser(opts.virtualKey)
    const fields = await providerRequestFields(provider)
    const resp = await withProviderErrors(provider, () => litellmImage(litellm, {
      ...fields,
      prompt,
      n: 1,
      size: openAiImageSize(width, height),
      ...featureMetadata(FEATURE_TAGS.imageGen, { workspaceId: opts.workspaceId, userId: opts.userId, docId: opts.docId })
    }))
    const first = resp.data?.[0]
    if (first?.b64_json) {
      const bytes = Buffer.from(first.b64_json, 'base64')
      const mimeType = sniffImageMime(bytes)
      if (!mimeType) return { error: 'The image provider returned an unsupported image format.' }
      return { bytes, mimeType }
    }
    if (first?.url) {
      // Some providers (dall-e style) answer with a URL. The URL comes
      // from a third party, so it goes through the same SSRF guard,
      // size cap and MIME allowlist as `view_image`.
      return generatedImageFromFetch(await fetchViewableExternalImage(first.url))
    }
    return { error: 'The image provider returned no image.' }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    log.error('BYOK image generation failed', { err: e })
    return { error: `Image generation failed: ${msg}` }
  }
}

// ─── BFL FLUX path (operator alias) ─────────────────────────────

async function generateImageBytesBfl(
  prompt: string,
  model: string,
  opts: ImageGenOpts
): Promise<ImageGenResult> {
  if (!opts.virtualKey) {
    return { error: 'BFL image gen requires a per-user LiteLLM virtual key.' }
  }
  const env = useEnv()
  const litellm = useLitellmForUser(opts.virtualKey)
  const width = opts.width ?? env.litellm.imageDefaultWidth ?? 1024
  const height = opts.height ?? env.litellm.imageDefaultHeight ?? 1024

  // Custom provider convention (see deploy/config/litellm/custom_handlers.py:
  // BFLFluxProvider). Single user message with JSON-encoded body.
  // Response's content is JSON with {b64_json, url, cost_credits, cost_usd}.
  try {
    log.debug('BFL image generation started', { model, width, height })
    const resp = await litellmCompletion(litellm, {
      model,
      messages: [{
        role: 'user',
        content: JSON.stringify({ prompt, width, height })
      }],
      ...featureMetadata(FEATURE_TAGS.imageGen, {
        workspaceId: opts.workspaceId,
        userId: opts.userId,
        docId: opts.docId
      })
    // No SDK retry on a 5xx: BFL may already have accepted (and billed) the
    // job. The provider retries the refused submissions itself.
    }, { maxRetries: 0 })
    const content = resp.choices?.[0]?.message?.content ?? ''
    let body: { b64_json?: string, url?: string, cost_usd?: number }
    try {
      body = JSON.parse(content)
    } catch {
      return { error: 'BFL provider returned non-JSON content (proxy misconfig).' }
    }
    if (!body.b64_json) {
      return { error: 'BFL returned no image bytes (provider error or content-moderated).' }
    }
    const bytes = Buffer.from(body.b64_json, 'base64')
    // BFL returns image/jpeg by default. Map MIME →
    // extension via IMAGE_MIME_EXT; if the response ever changes, the
    // upload pipeline will reject unknown MIMEs at /api/files.
    const mimeType: GeneratedImageMime = 'image/jpeg'
    log.debug('BFL image generated', { mimeType, bytes: bytes.byteLength, costUsd: body.cost_usd ?? null })
    return { bytes, mimeType }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    log.error('BFL image generation failed', { err: e })
    Sentry.captureException(e, {
      tags: { component: 'aiToolAdapter', event: 'image_generate_failed', provider: 'bfl' }
    })
    if (isFreeAllowanceExhaustedError(msg)) return { error: FREE_ALLOWANCE_EXHAUSTED_MESSAGE, budget: 'free-allowance' }
    if (msg.includes('budget_exceeded') || msg.includes('Budget has been exceeded')) {
      return { error: budgetExhaustedMessage(), budget: 'personal' }
    }
    if (isProviderUnavailableError(e)) return { error: `Image generation failed: ${msg}`, providerUnavailable: true }
    return { error: `Image generation failed: ${msg}` }
  }
}
