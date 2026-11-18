// Request schemas of the account routes (server/api/user/**, server/api/mcp/tokens/**).
// Shared with the client, which may validate a form with the same schema before sending.
import { z } from 'zod'
import { AI_CAPABILITIES } from '../ai/providers'

/** Scopes a Personal Access Token can carry (`mcp_personal_tokens.scopes`). */
export const MCP_SCOPES = [
  'documents:read',
  'documents:write',
  'knowledge:read',
  'web:fetch'
] as const

export type McpScope = (typeof MCP_SCOPES)[number]

/** POST /api/mcp/tokens. `scopes` defaults to all of them. */
export const createMcpTokenBody = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.enum(MCP_SCOPES)).min(1).optional()
})

export const mcpTokenParams = z.object({ tokenId: z.string().min(1) })

/** PUT /api/user/ai-model: the platform chat model the user wants. */
export const setAiModelBody = z.object({ tier: z.enum(['fast', 'strong']) })

export const aiProviderParams = z.object({ capability: z.enum(AI_CAPABILITIES) })

/**
 * PUT /api/user/ai-providers/:capability. Model ids across providers use
 * letters, digits and `._:/@+-` (`gpt-5.4-mini`, `mistralai/mistral-small`,
 * `qwen3:14b`): no spaces, no URL syntax.
 */
export const saveAiProviderBody = z.object({
  baseUrl: z.string().trim().min(1).max(500),
  model: z.string().trim().min(1).max(200).regex(/^[\w.:/@+-]+$/, 'Invalid model id'),
  // Chat only: the worker model on the same base URL and key (no URL or
  // key of its own, so it can never point anywhere the chat model can't).
  // Omitted, null or empty = none.
  fastModel: z.string().trim().max(200).regex(/^([\w.:/@+-]+)?$/, 'Invalid model id').nullish(),
  // Optional on update: omitted = keep the stored key, but ONLY while the
  // base URL is unchanged (a stored key must never be redirected to a
  // new host without the user re-entering it).
  apiKey: z.string().trim().min(1).max(500).regex(/^\S+$/, 'API keys contain no whitespace').optional(),
  supportsVision: z.boolean().optional()
})

export const customDomainParams = z.object({ domainId: z.string() })

/** POST /api/user/custom-domains. */
export const addCustomDomainBody = z.object({ hostname: z.string() })

/** PATCH /api/user/custom-domains/:domainId: the published page the domain shows, or null for none. */
export const setCustomDomainPageBody = z.object({ docId: z.string().max(64).nullable() })

/** POST /api/user/onboarding-accept. The versions are the ones the client read. */
export const acceptOnboardingBody = z.object({
  // Checked by the handler (`onboarding/age-required`): absent or false both mean "not confirmed".
  ageConfirmed: z.boolean().nullish(),
  privacyVersion: z.number().int(),
  tosVersion: z.number().int(),
  // Any other value falls back to the authoritative locale (the handler checks the list).
  locale: z.string().nullish().catch(null)
})

/** POST /api/user/dpa-accept. */
export const acceptDpaBody = z.object({
  dpaVersion: z.number().int(),
  // Any other value falls back to the authoritative locale (the handler checks the list).
  locale: z.string().nullish().catch(null)
})

export const exportJobParams = z.object({ jobId: z.string().min(1) })

export const inviteParams = z.object({ inviteId: z.string() })

/**
 * POST /api/user/invites/by-token. The token is deliberately not shape-checked
 * here: a malformed token answers the same 404 as an unknown one.
 */
export const actOnInviteTokenBody = z.object({
  token: z.unknown().optional(),
  action: z.enum(['accept', 'decline'])
})
