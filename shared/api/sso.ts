// Request schemas of the single sign-on routes: the workspace SSO settings
// (server/api/workspaces/[wsId]/sso/**), the sign-in discovery
// (server/api/auth/sso/discover) and the sign-in legs under server/routes/auth/**.
import { z } from 'zod'

/** `:wsId` routes: the workspace policy reads `wsId` from the parsed params, so every params schema keeps it. */
const wsParams = { wsId: z.string() }

/** /api/workspaces/:wsId/sso/domains/:domainId. The id stays a string: a non-numeric id answers 404, like an unknown one. */
export const ssoDomainParams = z.object({ ...wsParams, domainId: z.string() })

/**
 * PUT /api/workspaces/:wsId/sso. Shape only; `parseSsoSettings`
 * (server/utils/sso/admin.ts) checks what each protocol requires, the URL
 * policy, the certificate and encrypts the client secret.
 */
export const updateSsoSettingsBody = z.object({
  protocol: z.enum(['oidc', 'saml']),
  defaultRole: z.enum(['editor', 'viewer']).optional(),
  oidcIssuer: z.string().optional(),
  oidcClientId: z.string().optional(),
  /** Left out: keep the stored secret. */
  oidcClientSecret: z.string().optional(),
  samlIdpEntityId: z.string().optional(),
  samlSsoUrl: z.string().optional(),
  samlIdpCert: z.string().optional()
})

/** POST /api/workspaces/:wsId/sso/domains. Normalised (and consumer domains refused) by `normalizeSsoDomain`. */
export const addSsoDomainBody = z.object({ domain: z.string() })

/**
 * POST /api/auth/sso/discover. Anything unusable reads as "no address", so a
 * malformed request gets the same 404 as an unknown domain (no oracle).
 */
export const discoverSsoBody = z.object({
  email: z.string().optional().catch(undefined),
  returnTo: z.string().optional().catch(undefined)
}).nullish().catch(null)

/** /auth/sso/:connectionId/**. Shape-checked in the handler, which answers an unknown id the way the IdP leg expects (redirect or 404). */
export const ssoConnectionParams = z.object({ connectionId: z.string() })

/** GET /auth/sso/:connectionId. A malformed value counts as absent: `?test` other than `1` is a plain sign-in. */
export const startSsoSignInQuery = z.object({
  test: z.string().optional().catch(undefined),
  returnTo: z.string().optional().catch(undefined)
})

/**
 * POST /auth/sso/:connectionId/acs, the IdP's HTML form post. Never refused
 * here: a missing or malformed response redirects to the sign-in error page
 * like any other failed assertion.
 */
export const samlAcsBody = z.object({ SAMLResponse: z.string().optional().catch(undefined) }).nullish().catch(null)

/** GET /auth/oidc. Only which keys are present matters (callback leg or start); openid-client reads the raw URL. */
export const oidcSignInQuery = z.object({
  code: z.unknown().optional(),
  error: z.unknown().optional(),
  state: z.unknown().optional()
})
