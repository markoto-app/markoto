import type { Rule } from '../define'
import type { AppEnv } from '../namespaces'

const set = (value: string | undefined): boolean => !!value

function pair(provider: 'github' | 'google'): Rule<AppEnv> {
  const upper = provider.toUpperCase()
  const id = `NUXT_OAUTH_${upper}_CLIENT_ID`
  const secret = `NUXT_OAUTH_${upper}_CLIENT_SECRET`
  return {
    services: ['app'],
    relaxedInTestMode: true,
    vars: [id, secret],
    doc: `${id} and ${secret} are set together or not at all.`,
    check: (env) => {
      const hasId = set(provider === 'github' ? env.oauth.githubClientId : env.oauth.googleClientId)
      const hasSecret = set(provider === 'github' ? env.oauth.githubClientSecret : env.oauth.googleClientSecret)
      return hasId === hasSecret
        ? []
        : [`${id} and ${secret} must be set together (got: id=${hasId ? 'set' : 'empty'}, secret=${hasSecret ? 'set' : 'empty'})`]
    }
  }
}

/** All three OIDC values present (the provider is configured). */
function oidcConfigured(env: AppEnv): boolean {
  return set(env.oauth.oidcIssuer) && set(env.oauth.oidcClientId) && set(env.oauth.oidcClientSecret)
}

export const authRules: Rule<AppEnv>[] = [
  pair('github'),
  pair('google'),
  {
    services: ['app'],
    relaxedInTestMode: true,
    vars: ['NUXT_OAUTH_OIDC_ISSUER', 'NUXT_OAUTH_OIDC_CLIENT_ID', 'NUXT_OAUTH_OIDC_CLIENT_SECRET'],
    doc: 'OIDC issuer, client id and secret are set together or not at all.',
    check: (env) => {
      const { oidcIssuer, oidcClientId, oidcClientSecret } = env.oauth
      const present = [oidcIssuer, oidcClientId, oidcClientSecret].filter(set).length
      if (present === 0 || present === 3) return []
      return ['NUXT_OAUTH_OIDC_ISSUER, NUXT_OAUTH_OIDC_CLIENT_ID and NUXT_OAUTH_OIDC_CLIENT_SECRET must be set together '
        + `(got: issuer=${set(oidcIssuer) ? 'set' : 'empty'}, id=${set(oidcClientId) ? 'set' : 'empty'}, secret=${set(oidcClientSecret) ? 'set' : 'empty'})`]
    }
  },
  {
    services: ['app'],
    vars: ['NUXT_OAUTH_OIDC_ISSUER'],
    doc: 'The OIDC issuer is https (http only with NODE_ENV=development or TEST_MODE) and has no query or fragment.',
    check: (env, ctx) => {
      if (!env.oauth.oidcIssuer) return []
      const issuer = new URL(env.oauth.oidcIssuer)
      const insecureAllowed = ctx.testMode || env.core.nodeEnv === 'development'
      if (issuer.protocol !== 'https:' && !(insecureAllowed && issuer.protocol === 'http:')) {
        return ['NUXT_OAUTH_OIDC_ISSUER must use https:']
      }
      if (issuer.search || issuer.hash) return ['NUXT_OAUTH_OIDC_ISSUER must not contain a query string or fragment']
      return []
    }
  },
  {
    services: ['app'],
    relaxedInTestMode: true,
    vars: ['NUXT_OAUTH_OIDC_REDIRECT_URL', 'NUXT_SITE_URL'],
    doc: 'With OIDC configured, NUXT_OAUTH_OIDC_REDIRECT_URL or NUXT_SITE_URL is set (never the request Host).',
    check: env => oidcConfigured(env) && !env.oauth.oidcRedirectUrl && !env.core.siteUrl
      ? ['OpenID Connect sign-in needs NUXT_OAUTH_OIDC_REDIRECT_URL or NUXT_SITE_URL (the redirect URI is never taken from the request Host header)']
      : []
  }
]
