import type { CORSRule } from '@aws-sdk/client-s3'

// Browsers upload images and knowledge files straight to S3 with a presigned
// PUT, so a bucket on another origin than the site needs a CORS rule for the
// site's origin; without it every upload fails in the browser while every
// server-side check passes. The rule the docs ask for (docs/S3-SETUP.md):
// AllowedOrigins = the site origin, methods GET / PUT / HEAD, headers
// Content-Type / Content-Length, ExposeHeaders ETag.

/** Lower-cased origin of a URL, or null when it doesn't parse. */
function originOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).origin.toLowerCase()
  } catch {
    return null
  }
}

/**
 * The site origin a CORS rule must allow, or null when no check applies: no
 * site URL configured, or the browser reaches S3 under the site's own origin
 * (the self-host stack routes `/<bucket>/` through the same host), where the
 * browser makes no cross-origin request at all.
 */
export function corsOriginToCheck(siteUrl: string | null | undefined, browserS3Endpoint: string | null | undefined): string | null {
  const site = originOf(siteUrl)
  if (!site) return null
  return originOf(browserS3Endpoint) === site ? null : site
}

/** S3 matching: case-insensitive, at most one `*` wildcard per entry. */
function wildcardMatch(pattern: string, value: string): boolean {
  const p = pattern.toLowerCase()
  const v = value.toLowerCase()
  const star = p.indexOf('*')
  if (star === -1) return p === v
  const head = p.slice(0, star)
  const tail = p.slice(star + 1)
  return v.length >= head.length + tail.length && v.startsWith(head) && v.endsWith(tail)
}

function ruleAllows(rule: CORSRule, origin: string, method: string, header?: string): boolean {
  const originOk = (rule.AllowedOrigins ?? []).some(o => wildcardMatch(o, origin))
  const methodOk = (rule.AllowedMethods ?? []).some(m => m.toUpperCase() === method)
  const headerOk = header === undefined || (rule.AllowedHeaders ?? []).some(h => wildcardMatch(h, header))
  return originOk && methodOk && headerOk
}

/**
 * What the bucket's CORS rules miss for uploads from `origin`, or null when
 * they cover it: a presigned PUT carrying `Content-Type` (a preflighted
 * request) and the GET that reads a file back.
 */
export function corsRulesProblem(rules: CORSRule[] | undefined, origin: string): string | null {
  const list = rules ?? []
  if (list.length === 0) return `no CORS rule on the bucket; browser uploads from ${origin} fail`
  if (!list.some(r => ruleAllows(r, origin, 'PUT', 'content-type'))) {
    return `no CORS rule allows PUT with a Content-Type header from ${origin}; browser uploads fail`
  }
  if (!list.some(r => ruleAllows(r, origin, 'GET'))) return `no CORS rule allows GET from ${origin}`
  return null
}
