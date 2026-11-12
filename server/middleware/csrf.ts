import { CSRF_ORIGIN_CODE, isRequestOriginAllowed } from '../utils/auth/csrf'
import { useEnv } from '~~/shared/env/load'

// Origin / Sec-Fetch-Site check for state-changing `/api` requests — see
// `server/utils/auth/csrf.ts` for the rules and exemptions.

export default defineEventHandler((event) => {
  const configuredSiteUrl: unknown = useEnv().core.siteUrl
  const allowed = isRequestOriginAllowed({
    method: event.method,
    path: getRequestURL(event).pathname,
    origin: getRequestHeader(event, 'origin'),
    referer: getRequestHeader(event, 'referer'),
    secFetchSite: getRequestHeader(event, 'sec-fetch-site'),
    host: getRequestHeader(event, 'host'),
    siteUrl: typeof configuredSiteUrl === 'string' ? configuredSiteUrl : undefined
  })
  if (allowed) return
  throw createError({
    statusCode: 403,
    message: 'Cross-origin request refused.',
    data: { code: CSRF_ORIGIN_CODE }
  })
})
