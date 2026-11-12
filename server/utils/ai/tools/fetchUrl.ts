import { z } from 'zod'
import type { AgenticAIClient as AiClient } from '../../agentic/aiTypes'
import { litellmCompletion } from '../../litellm/createCompletion'
import { assertSafeUrl, parseToolUrl } from '../../agentic/urlGuard'
import { consumeWebToolQuota, isWebToolAvailable } from '../webTools'
import { useLitellmAdmin, useLitellmForUser } from '../litellmClient'
import { FEATURE_TAGS, featureMetadata } from '../../litellm/featureTags'
import { providerRequestFields, withProviderErrors } from '../../aiProviders/requestFields'
import { useEnv } from '~~/shared/env/load'
import type { WebToolSpendContext } from './webSearch'

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

/**
 * URL-fetch sub-call: Jina Reader returns the page as markdown, then Mistral
 * extracts a structured `{summary, images[]}` with `json_schema strict:true`.
 */
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

  // The `ai` + `model` args are retained on the signature for harness
  // compatibility.
  return await fetchUrlViaJina(url, signal, spendCtx)
}

// Third-party answers: a mistyped field reads as absent.
const optionalText = z.string().optional().catch(undefined)
const jinaReaderResponse = z.object({
  data: z.object({ content: optionalText, title: optionalText }).optional().catch(undefined)
})

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
  const jinaKey = useEnv().providers.jinaApiKey
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
  const readerPayload = jinaReaderResponse.catch({}).parse(await readerRes.json())
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

  return {
    text: formatPageExtract(parsed),
    url,
    summary: parsed.summary ?? '',
    images: (parsed.images ?? []).filter(i => i?.url)
  }
}

/** The text the model gets for an extracted page: the summary, then one line per image. */
function formatPageExtract(parsed: FetchUrlResponse): string {
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
  return lines.join('\n')
}
