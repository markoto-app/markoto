// Save / view orchestration for user BYOK provider configs. The only
// place that encrypts a provider key; the only shape that leaves the
// server is `AiProviderConfigView` (host + last four characters).

import { z } from 'zod'
import { encryptToken, decryptToken } from '../litellm/tokenCrypto'
import { getAiProvider, upsertAiProvider, type AiProviderRow } from '../../repos/aiProviders'
import { resolveByokUrlPolicy } from './config'
import { checkProviderBaseUrl } from './urlPolicy'
import { verifyProvider, type VerifyResult } from './verify'
import type { ResolvedAiProvider } from './resolve'
import { apiKeyLast4, baseUrlHost, normalizeBaseUrl, type AiCapability, type AiProviderConfigView } from '~~/shared/ai/providers'

export function toProviderView(row: AiProviderRow): AiProviderConfigView {
  return {
    capability: row.capability,
    baseUrl: row.baseUrl,
    host: baseUrlHost(row.baseUrl),
    model: row.model,
    apiKeyLast4: row.apiKeyLast4,
    supportsVision: row.supportsVision,
    supportsTools: row.supportsTools,
    lastVerifiedAt: row.lastVerifiedAt ? row.lastVerifiedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString()
  }
}

/**
 * Model ids across providers use letters, digits and `._:/@+-`
 * (`gpt-5.4-mini`, `mistralai/mistral-small`, `qwen3:14b`). No spaces,
 * no URL syntax.
 */
export const saveBodySchema = z.object({
  baseUrl: z.string().trim().min(1).max(500),
  model: z.string().trim().min(1).max(200).regex(/^[\w.:/@+-]+$/, 'Invalid model id'),
  // Optional on update: omitted = keep the stored key, but ONLY while the
  // base URL is unchanged (a stored key must never be redirected to a
  // new host without the user re-entering it).
  apiKey: z.string().trim().min(1).max(500).regex(/^\S+$/, 'API keys contain no whitespace').optional(),
  supportsVision: z.boolean().optional()
})
export type SaveBody = z.infer<typeof saveBodySchema>

export type SaveOutcome
  = | { kind: 'saved', view: AiProviderConfigView, verify: VerifyResult }
    | { kind: 'url-refused', code: string, message: string }
    | { kind: 'key-required' }
    | { kind: 'verify-failed', verify: VerifyResult }

export async function saveUserProvider(
  userId: number,
  capability: AiCapability,
  body: SaveBody,
  virtualKey: string
): Promise<SaveOutcome> {
  const check = await checkProviderBaseUrl(body.baseUrl, resolveByokUrlPolicy())
  if (!check.ok) return { kind: 'url-refused', code: check.code, message: check.message }
  const baseUrl = check.normalized

  const existing = await getAiProvider(userId, capability)
  let apiKey = body.apiKey
  if (!apiKey) {
    if (!existing || normalizeBaseUrl(existing.baseUrl) !== baseUrl) return { kind: 'key-required' }
    try {
      apiKey = decryptToken(existing.apiKeyEncrypted)
    } catch {
      return { kind: 'key-required' }
    }
  }

  const supportsVision = capability === 'chat' && (body.supportsVision ?? false)
  const candidate: ResolvedAiProvider = {
    capability,
    source: 'user',
    model: body.model,
    credentials: { baseUrl, apiKey },
    supportsVision
  }
  const verify = await verifyProvider(capability, candidate, virtualKey)
  if (!verify.ok) return { kind: 'verify-failed', verify }

  const row = await upsertAiProvider({
    userId,
    capability,
    baseUrl,
    model: body.model,
    apiKeyEncrypted: encryptToken(apiKey),
    apiKeyLast4: apiKeyLast4(apiKey),
    supportsVision,
    supportsTools: verify.supportsTools,
    lastVerifiedAt: new Date()
  })
  return { kind: 'saved', view: toProviderView(row), verify }
}

/** Re-verify a stored config. Null when the user has none for `capability`. */
export async function reverifyUserProvider(
  row: AiProviderRow,
  virtualKey: string
): Promise<VerifyResult> {
  let apiKey: string
  try {
    apiKey = decryptToken(row.apiKeyEncrypted)
  } catch {
    return { code: 'auth-failed', ok: false, supportsTools: null, message: 'The stored key can no longer be read. Enter it again.' }
  }
  return verifyProvider(row.capability, {
    capability: row.capability,
    source: 'user',
    model: row.model,
    credentials: { baseUrl: row.baseUrl, apiKey },
    supportsVision: row.supportsVision
  }, virtualKey)
}
