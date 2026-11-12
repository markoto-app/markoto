import { z } from 'zod'
// Verification of a BYOK provider config before it is saved (and on the
// settings page's "Verify" button).
//
//   - chat: a small completion WITH one tool definition at temperature 0,
//     through LiteLLM's `byok/*` deployment — the exact path real agent
//     calls take. A tool call back = OK. A plain-text answer = saved with
//     a `no-tool-support` warning (the agent needs tool calling).
//   - transcription: a 0.5 s silent WAV through LiteLLM's
//     `/audio/transcriptions` (same path as the voice prompt). Costs a
//     fraction of a cent on the user's account; proves auth + model.
//   - image: NO generation (a paid image per save is not acceptable).
//     LiteLLM has no clientside-credential passthrough for listing
//     upstream models, so the app GETs `{baseUrl}/models` itself — same
//     SSRF policy, redirects refused, short timeout. 401/403 → auth
//     failed; model absent from a returned list → `model-not-found`
//     warning (some providers' lists are incomplete, so it does not
//     block the save).
//
// Every message returned here is a fixed sentence: neither the key nor
// any upstream response text reaches the user (`providerErrorMessage`).

import type OpenAI from 'openai'
import { useLitellmForUser } from '../ai/litellmClient'
import { litellmCompletion, litellmTranscription } from '../litellm/createCompletion'
import { PROVIDER_ERROR_MESSAGES, classifyProviderError, logProviderFailure, providerErrorMessage, providerRequestFields } from './requestFields'
import type { ResolvedAiProvider } from './resolve'
import type { AiCapability, VerifyCode } from '~~/shared/ai/providers'

export interface VerifyResult {
  code: VerifyCode
  /** false = refuse to save. Warnings (`no-tool-support`, unlisted model) still save. */
  ok: boolean
  /** Chat only: did the probe get a tool call back? */
  supportsTools: boolean | null
  message: string
}

const PROBE_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'report_status',
    description: 'Report that the connection works. Always call this tool.',
    parameters: { type: 'object', properties: { status: { type: 'string', description: 'Use "ok".' } }, required: ['status'] }
  }
}

function failure(e: unknown, apiKey: string): VerifyResult {
  const code = classifyProviderError(e)
  // Fixed message only: the upstream response text stays in the server log.
  logProviderFailure(code, e, apiKey)
  return { code, ok: false, supportsTools: null, message: providerErrorMessage(code, e) }
}

/** 0.5 s of 16 kHz mono silence as a WAV file. */
function silentWav(): Buffer<ArrayBuffer> {
  const sampleRate = 16000
  const samples = sampleRate / 2
  const dataBytes = samples * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataBytes, 40)
  return buf
}

async function verifyChat(provider: ResolvedAiProvider, virtualKey: string, apiKey: string): Promise<VerifyResult> {
  try {
    const fields = await providerRequestFields(provider)
    const resp = await litellmCompletion(useLitellmForUser(virtualKey), {
      ...fields,
      messages: [
        { role: 'system', content: 'You are a connection test. Call the report_status tool with status "ok".' },
        { role: 'user', content: 'Run the connection test.' }
      ],
      tools: [PROBE_TOOL],
      tool_choice: 'auto',
      temperature: 0,
      max_tokens: 64
    })
    const calls = resp.choices?.[0]?.message?.tool_calls ?? []
    if (calls.length > 0) {
      return { code: 'ok', ok: true, supportsTools: true, message: 'Connected. Tool calling works.' }
    }
    return {
      code: 'no-tool-support',
      ok: true,
      supportsTools: false,
      message: 'Connected, but the model answered without calling the test tool. The writing agent needs tool calling and may not work with this model.'
    }
  } catch (e) {
    return failure(e, apiKey)
  }
}

async function verifyTranscription(provider: ResolvedAiProvider, virtualKey: string, apiKey: string): Promise<VerifyResult> {
  try {
    const fields = await providerRequestFields(provider)
    const form = new FormData()
    form.append('file', new Blob([silentWav()], { type: 'audio/wav' }), 'probe.wav')
    form.append('model', fields.model)
    if (fields.api_key) form.append('api_key', fields.api_key)
    if (fields.api_base) form.append('api_base', fields.api_base)
    await litellmTranscription(useLitellmForUser(virtualKey), form)
    return { code: 'ok', ok: true, supportsTools: null, message: 'Connected. Transcription works.' }
  } catch (e) {
    return failure(e, apiKey)
  }
}

async function verifyImage(provider: ResolvedAiProvider, apiKey: string): Promise<VerifyResult> {
  try {
    // Runs the SSRF policy (DNS included) exactly like a real call.
    const fields = await providerRequestFields(provider)
    const res = await fetch(`${fields.api_base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    })
    if (res.status === 401 || res.status === 403) {
      return { code: 'auth-failed', ok: false, supportsTools: null, message: PROVIDER_ERROR_MESSAGES['auth-failed'] }
    }
    if (!res.ok) {
      // Some image-only endpoints don't implement /models. Reachable +
      // not an auth error is the most we can learn without generating.
      return { code: 'ok', ok: true, supportsTools: null, message: 'Reachable. This provider does not list its models, so the model id was not checked.' }
    }
    const body: unknown = await res.json().catch(() => null)
    const ids = extractModelIds(body)
    if (ids.length > 0 && !ids.includes(provider.model)) {
      return { code: 'model-not-found', ok: true, supportsTools: null, message: 'Connected, but this model id is not in the provider\'s model list. Check the id if image generation fails.' }
    }
    return { code: 'ok', ok: true, supportsTools: null, message: 'Connected. The key is valid.' }
  } catch (e) {
    return failure(e, apiKey)
  }
}

/** OpenAI-compatible `GET /models`: `{ data: [{ id }] }`; entries without an id are skipped. */
const modelList = z.object({
  data: z.array(z.object({ id: z.string() }).nullable().catch(null))
})

function extractModelIds(body: unknown): string[] {
  const parsed = modelList.safeParse(body)
  if (!parsed.success) return []
  return parsed.data.data.flatMap(entry => (entry ? [entry.id] : []))
}

export async function verifyProvider(
  capability: AiCapability,
  provider: ResolvedAiProvider,
  virtualKey: string
): Promise<VerifyResult> {
  const apiKey = provider.credentials?.apiKey ?? ''
  if (capability === 'chat') return verifyChat(provider, virtualKey, apiKey)
  if (capability === 'transcription') return verifyTranscription(provider, virtualKey, apiKey)
  return verifyImage(provider, apiKey)
}
