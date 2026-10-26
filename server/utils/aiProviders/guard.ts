// HTTP-facing guards for AI entry points. Every AI surface resolves the
// caller's providers once, up front, and refuses with a stable code +
// i18n key + settings link when the capability it needs is missing — the
// client renders that as "Add your API key in Settings" instead of a
// generic failure.

import { resolveAiProviders, type ResolvedAiProviders } from './resolve'
import type { AiCapability } from '~~/shared/ai/providers'

export const AI_PROVIDER_MISSING_CODE = 'ai/provider-missing'

/** Where the user configures providers. Kept in one place for every recovery hint. */
export const AI_SETTINGS_PATH = '/settings/ai'

const MESSAGE: Record<AiCapability, string> = {
  chat: 'No AI provider is configured. Add your API key in Settings → AI provider.',
  image: 'No image provider is configured. Add one in Settings → AI provider.',
  transcription: 'No transcription provider is configured. Add one in Settings → AI provider.'
}

export function providerMissingError(capability: AiCapability) {
  return createError({
    statusCode: 409,
    message: MESSAGE[capability],
    data: {
      code: AI_PROVIDER_MISSING_CODE,
      capability,
      messageKey: `aiProvider.missing.${capability}`,
      recovery: { kind: 'link', href: AI_SETTINGS_PATH, labelKey: 'aiProvider.missing.cta' }
    }
  })
}

/** Resolve all providers and require one capability to be available. */
export async function requireAiProviders(userId: number, capability: AiCapability): Promise<ResolvedAiProviders> {
  const providers = await resolveAiProviders(userId)
  if (!providers[capability]) throw providerMissingError(capability)
  return providers
}
