import type { Rule } from '../define'
import type { AppEnv } from '../namespaces'
import { testModeBootError } from '../../utils/security/testMode'

export const coreRules: Rule<AppEnv>[] = [
  {
    services: ['app'],
    vars: ['TEST_MODE', 'NUXT_SITE_URL'],
    doc: 'TEST_MODE=1 is refused on an instance whose NUXT_SITE_URL is a real host.',
    check: (_env, ctx) => {
      const error = testModeBootError(ctx.raw)
      return error ? [error] : []
    }
  },
  {
    services: ['app'],
    relaxedInTestMode: true,
    vars: ['NUXT_PUBLISH_PAGES_HOST', 'NUXT_SITE_URL'],
    doc: 'A pages host needs NUXT_SITE_URL (links from a page back to the app are built from it).',
    check: env => env.publish.pagesHost && !env.core.siteUrl
      ? ['NUXT_PUBLISH_PAGES_HOST is set but NUXT_SITE_URL is not: links from a published page back to the app (report form, redirects) are built from it']
      : []
  }
]
