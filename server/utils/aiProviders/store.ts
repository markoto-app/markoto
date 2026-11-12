// Save / view orchestration for user BYOK provider configs. The only
// place that encrypts a provider key; the only shape that leaves the
// server is `AiProviderConfigView` (host + last four characters).

import type { z } from 'zod'
import { openProviderKey, sealProviderKey } from './keyCrypto'
import { getAiProvider, upsertAiProvider, type AiProviderRow } from '../../repos/aiProviders'
import { resolveByokUrlPolicy } from './config'
import { checkProviderBaseUrl } from './urlPolicy'
import { verifyProvider, type VerifyResult } from './verify'
import type { ResolvedAiProvider } from './resolve'
import type { saveAiProviderBody } from '~~/shared/api/account'
import { apiKeyLast4, baseUrlHost, normalizeBaseUrl, type AiCapability, type AiProviderConfigView } from '~~/shared/ai/providers'
import type { UserScope } from '../../repos/proofs'

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

export type SaveBody = z.infer<typeof saveAiProviderBody>

export type SaveOutcome
  = | { kind: 'saved', view: AiProviderConfigView, verify: VerifyResult }
    | { kind: 'url-refused', code: string, message: string }
    | { kind: 'key-required' }
    | { kind: 'verify-failed', verify: VerifyResult }

export async function saveUserProvider(
  self: UserScope,
  capability: AiCapability,
  body: SaveBody,
  virtualKey: string
): Promise<SaveOutcome> {
  const userId = self.userId
  const check = await checkProviderBaseUrl(body.baseUrl, resolveByokUrlPolicy())
  if (!check.ok) return { kind: 'url-refused', code: check.code, message: check.message }
  const baseUrl = check.normalized

  const existing = await getAiProvider(userId, capability)
  let apiKey = body.apiKey
  if (!apiKey) {
    if (!existing || normalizeBaseUrl(existing.baseUrl) !== baseUrl) return { kind: 'key-required' }
    try {
      apiKey = openProviderKey(existing)
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

  const row = await upsertAiProvider(self, {
    capability,
    baseUrl,
    model: body.model,
    apiKeyEncrypted: sealProviderKey(userId, capability, apiKey),
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
    apiKey = openProviderKey(row)
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
