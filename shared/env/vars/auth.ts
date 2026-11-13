import { bool, secret, string, url } from '../coerce'
import { defineNamespace, v } from '../define'

// A deliberate floor: `openssl rand -hex 32` (64 chars) clears it, while a
// shell-typo placeholder like `dev-secret` or `changeme` fails boot loudly
// instead of silently running an insecure stack.
const SECRET_MIN_LENGTH = 32

const signingSecret = secret(SECRET_MIN_LENGTH)

export const auth = defineNamespace({
  name: 'auth',
  title: 'Secrets',
  intro: `Signing and service-to-service secrets (≥ ${SECRET_MIN_LENGTH} chars each; \`openssl rand -hex 32\`). *_PREVIOUS only during a rotation (docs/SELF-HOSTING.md, rotating secrets).`,
  vars: {
    sessionPassword: v({
      name: 'NUXT_SESSION_PASSWORD',
      example: '',
      type: signingSecret,
      required: 'always',
      secret: true,
      doc: 'Seals the session cookie (nuxt-auth-utils; runtimeConfig.session.password).',
      services: ['app'],
      scope: 'both'
    }),
    jwtSecret: v({
      name: 'NUXT_JWT_SECRET',
      example: '',
      type: signingSecret,
      required: 'always',
      secret: true,
      doc: 'Signs the document tokens the sync server verifies.',
      services: ['app', 'sync'],
      scope: 'both',
      aliases: { sync: 'JWT_SECRET' }
    }),
    jwtSecretPrevious: v({
      name: 'NUXT_JWT_SECRET_PREVIOUS',
      example: '',
      type: signingSecret,
      secret: true,
      doc: 'Previous NUXT_JWT_SECRET, still accepted by verifiers during a rotation.',
      services: ['app', 'sync'],
      scope: 'both',
      aliases: { sync: 'JWT_SECRET_PREVIOUS' }
    }),
    internalApiSecret: v({
      name: 'NUXT_INTERNAL_API_SECRET',
      example: '',
      type: signingSecret,
      required: 'always',
      secret: true,
      doc: 'Shared secret of the app ↔ sync ↔ renderer internal HTTP calls and render tokens.',
      services: ['app', 'sync', 'renderer'],
      scope: 'both',
      aliases: { sync: 'INTERNAL_API_SECRET', renderer: 'INTERNAL_API_SECRET' }
    }),
    internalApiSecretPrevious: v({
      name: 'NUXT_INTERNAL_API_SECRET_PREVIOUS',
      example: '',
      type: signingSecret,
      secret: true,
      doc: 'Previous NUXT_INTERNAL_API_SECRET, still accepted during a rotation.',
      services: ['app', 'sync', 'renderer'],
      scope: 'both',
      aliases: { sync: 'INTERNAL_API_SECRET_PREVIOUS', renderer: 'INTERNAL_API_SECRET_PREVIOUS' }
    }),
    encryptionKey: v({
      name: 'NUXT_ENCRYPTION_KEY',
      example: '',
      type: signingSecret,
      required: 'production',
      secret: true,
      doc: 'Encrypts the secrets the app stores in Postgres (LiteLLM virtual keys, users\' own AI provider keys, workspace SSO client secrets). Losing or replacing it makes them unreadable: rotate through NUXT_ENCRYPTION_KEY_PREVIOUS.',
      services: ['app'],
      scope: 'both'
    }),
    encryptionKeyPrevious: v({
      name: 'NUXT_ENCRYPTION_KEY_PREVIOUS',
      example: '',
      type: signingSecret,
      secret: true,
      doc: 'Previous NUXT_ENCRYPTION_KEY, still used to decrypt during a rotation (then `bun run secrets:reencrypt`).',
      services: ['app'],
      scope: 'both'
    }),
    dictateJwtSecret: v({
      name: 'NUXT_AI_DICTATE_JWT_SECRET',
      example: '',
      type: signingSecret,
      secret: true,
      doc: 'Signs live-dictation WebSocket tokens; empty = NUXT_JWT_SECRET.',
      services: ['app'],
      scope: 'both'
    })
  }
})

export const oauth = defineNamespace({
  name: 'oauth',
  title: 'Sign-in',
  intro: 'Login is optional: with no provider configured the instance is anonymous-only. Each provider is all-or-nothing (boot fails on a half pair).',
  vars: {
    githubClientId: v({
      name: 'NUXT_OAUTH_GITHUB_CLIENT_ID',
      example: '',
      type: string,
      doc: 'GitHub OAuth app client id (runtimeConfig.oauth.github, read by nuxt-auth-utils).',
      services: ['app'],
      scope: 'both',
      required: { when: 'NUXT_OAUTH_GITHUB_CLIENT_SECRET is set' }
    }),
    githubClientSecret: v({
      name: 'NUXT_OAUTH_GITHUB_CLIENT_SECRET',
      example: '',
      type: string,
      secret: true,
      doc: 'GitHub OAuth app client secret.',
      services: ['app'],
      scope: 'both',
      required: { when: 'NUXT_OAUTH_GITHUB_CLIENT_ID is set' }
    }),
    githubRedirectUrl: v({
      name: 'NUXT_OAUTH_GITHUB_REDIRECT_URL',
      type: url(),
      doc: 'Explicit GitHub callback URL (<public URL>/auth/github); empty = derived by nuxt-auth-utils.',
      services: ['app'],
      scope: 'self-host'
    }),
    googleClientId: v({
      name: 'NUXT_OAUTH_GOOGLE_CLIENT_ID',
      example: '',
      type: string,
      doc: 'Google OAuth client id (runtimeConfig.oauth.google).',
      services: ['app'],
      scope: 'both',
      required: { when: 'NUXT_OAUTH_GOOGLE_CLIENT_SECRET is set' }
    }),
    googleClientSecret: v({
      name: 'NUXT_OAUTH_GOOGLE_CLIENT_SECRET',
      example: '',
      type: string,
      secret: true,
      doc: 'Google OAuth client secret.',
      services: ['app'],
      scope: 'both',
      required: { when: 'NUXT_OAUTH_GOOGLE_CLIENT_ID is set' }
    }),
    googleRedirectUrl: v({
      name: 'NUXT_OAUTH_GOOGLE_REDIRECT_URL',
      type: url(),
      doc: 'Explicit Google callback URL (<public URL>/auth/google); empty = derived by nuxt-auth-utils.',
      services: ['app'],
      scope: 'self-host'
    }),
    oidcIssuer: v({
      name: 'NUXT_OAUTH_OIDC_ISSUER',
      type: url(),
      doc: 'OpenID Connect issuer (exact `issuer` of the IdP\'s discovery document). https only, except NODE_ENV=development / TEST_MODE.',
      services: ['app'],
      scope: 'self-host',
      required: { when: 'NUXT_OAUTH_OIDC_CLIENT_ID or _CLIENT_SECRET is set' }
    }),
    oidcClientId: v({
      name: 'NUXT_OAUTH_OIDC_CLIENT_ID',
      type: string,
      doc: 'OIDC client id (confidential client, auth-code flow + PKCE).',
      services: ['app'],
      scope: 'self-host',
      required: { when: 'NUXT_OAUTH_OIDC_ISSUER or _CLIENT_SECRET is set' }
    }),
    oidcClientSecret: v({
      name: 'NUXT_OAUTH_OIDC_CLIENT_SECRET',
      type: string,
      secret: true,
      doc: 'OIDC client secret.',
      services: ['app'],
      scope: 'self-host',
      required: { when: 'NUXT_OAUTH_OIDC_ISSUER or _CLIENT_ID is set' }
    }),
    oidcName: v({
      name: 'NUXT_OAUTH_OIDC_NAME',
      type: string,
      default: '',
      doc: 'Sign-in button label ("Continue with <name>", max 40 chars); empty = "single sign-on".',
      services: ['app'],
      scope: 'self-host'
    }),
    oidcScopes: v({
      name: 'NUXT_OAUTH_OIDC_SCOPES',
      type: string,
      default: 'openid email profile',
      doc: 'Space- or comma-separated scopes (openid is always added).',
      services: ['app'],
      scope: 'self-host'
    }),
    oidcRedirectUrl: v({
      name: 'NUXT_OAUTH_OIDC_REDIRECT_URL',
      type: url(),
      doc: 'Explicit OIDC redirect URI; default <NUXT_SITE_URL>/auth/oidc (never the request Host).',
      services: ['app'],
      scope: 'self-host'
    }),
    ssoAllowPrivateUrls: v({
      name: 'NUXT_SSO_ALLOW_PRIVATE_URLS',
      type: bool,
      default: false,
      doc: 'Let workspace SSO connections (OIDC/SAML metadata) point at private-network IdPs. Self-host only.',
      services: ['app'],
      scope: 'self-host'
    })
  }
})
