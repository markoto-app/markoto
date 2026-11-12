// HTTP-facing guards for AI entry points. Every AI surface resolves the
// caller's providers once, up front, and refuses with a stable code +
// i18n key + settings link when the capability it needs is missing — the
// client renders that as "Add your API key in Settings" instead of a
// generic failure.

import { CAPABILITY_PLAN_FEATURE, resolveAiAccess, type ResolvedAiProviders } from './resolve'
import { assertPlanFeature } from '../billing/entitlements'
import type { AiCapability } from '~~/shared/ai/providers'
import type { PlanName } from '~~/shared/config/tiers'
import type { UserScope } from '../../repos/proofs'

const AI_PROVIDER_MISSING_CODE = 'ai/provider-missing'

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

const LOCKED_MESSAGE: Partial<Record<AiCapability, string>> = {
  image: 'Image generation is not part of this plan. Add your own image provider in Settings → AI provider, or upgrade.',
  transcription: 'Voice input is not part of this plan. Add your own transcription provider in Settings → AI provider, or upgrade.'
}

/**
 * Resolve all providers under `plan` and require one capability. A
 * capability the platform offers but the plan doesn't include answers
 * 409 `plan/feature-unavailable`; none at all → `ai/provider-missing`.
 */
export async function requireAiProviders(user: UserScope, capability: AiCapability, plan: PlanName): Promise<ResolvedAiProviders> {
  const access = await resolveAiAccess(user, plan)
  if (!access.providers[capability]) {
    const feature = CAPABILITY_PLAN_FEATURE[capability]
    if (feature && access.locked.includes(capability)) assertPlanFeature(plan, feature, LOCKED_MESSAGE[capability] ?? '')
    throw providerMissingError(capability)
  }
  return access.providers
}
