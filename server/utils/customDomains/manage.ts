import type { H3Event } from 'h3'
import { customDomainSettings, type CustomDomainSettings } from './config'
import { checkCustomDomainDns, dnsLookups, type DnsCheck } from './dns'
import { invalidateCustomDomainCache } from './routing'
import { recordCustomDomainCheck, type CustomDomainRow, type CustomDomainWithPage } from '../../repos/customDomains'
import { planHasFeature, resolveUserPlan } from '../billing/entitlements'
import { emailLinkBaseUrl } from '../platform/siteUrl'
import { publicBaseUrl, publishedPageUrl } from '../publish/access'
import { publishPagesSettings } from '../publish/pagesHost'
import {
  CUSTOM_DOMAIN_ERROR_CODES, CUSTOM_DOMAIN_GRACE_MS, customDomainVerifyName, customDomainVerifyValue, normalizeCustomHostname
} from '~~/shared/config/customDomains'
import { isInternalHostname } from '../aiProviders/urlPolicy'
import { appendAuditEvent } from '../../repos/audit'
import { AUDIT_CUSTOM_DOMAIN_DROPPED, AUDIT_CUSTOM_DOMAIN_VERIFIED } from '../../legal/auditActions'

// Custom domains: the signed-in user's own domains. Adding one
// needs the plan feature `customDomains`; the domain is routed only once
// its DNS check passed (TXT ownership + CNAME / same addresses).

export async function requireCustomDomainUser(event: H3Event): Promise<{ userId: number, settings: CustomDomainSettings, available: boolean }> {
  const session = await requireValidatedUserSession(event)
  const settings = customDomainSettings()
  if (!settings) {
    throw createError({ statusCode: 404, message: 'Custom domains are not set up on this instance.', data: { code: CUSTOM_DOMAIN_ERROR_CODES.disabled } })
  }
  const available = planHasFeature(await resolveUserPlan(session.user.id), 'customDomains')
  return { userId: session.user.id, settings, available }
}

/** The hostname a user may add, or a 400. */
export function validateNewHostname(event: H3Event, input: unknown, settings: CustomDomainSettings): string {
  const host = normalizeCustomHostname(input, { allowTestNames: settings.allowTestNames })
  const invalid = (message: string) => createError({ statusCode: 400, message, data: { code: CUSTOM_DOMAIN_ERROR_CODES.invalid, field: 'hostname' } })
  if (!host) throw invalid('Enter a domain name such as docs.example.com.')
  const site = emailLinkBaseUrl(useRuntimeConfig(event).siteUrl)
  const own = [settings.target, site ? new URL(site).hostname : null, new URL(publicBaseUrl(event)).hostname, publishPagesSettings()?.hostname ?? null].filter((h): h is string => !!h)
  if (own.some(o => host === o || host.endsWith(`.${o}`))) throw invalid('This domain belongs to this service.')
  if (isInternalHostname(host)) throw invalid('Enter a domain name such as docs.example.com.')
  return host
}

export function customDomainView(event: H3Event, d: CustomDomainWithPage, settings: CustomDomainSettings) {
  return {
    id: d.id,
    hostname: d.hostname,
    status: d.status,
    problem: d.lastError,
    verifiedAt: d.verifiedAt?.toISOString() ?? null,
    lastCheckedAt: d.lastCheckedAt?.toISOString() ?? null,
    dns: {
      txtName: customDomainVerifyName(d.hostname),
      txtValue: customDomainVerifyValue(d.verifyToken),
      cnameTarget: settings.target
    },
    page: d.pageId && d.pageSlug
      ? { docId: d.pageDocId, title: d.pageTitle, slug: d.pageSlug, url: publishedPageUrl(event, d.pageSlug) }
      : null,
    url: `https://${d.hostname}/`
  }
}

/**
 * Run the DNS check for one domain and record it. A verified domain whose
 * DNS stopped matching stays routed until `CUSTOM_DOMAIN_GRACE_MS` after its
 * last success (a DNS hiccup must not take a site down), then fails.
 */
export async function runCustomDomainCheck(
  domain: CustomDomainRow,
  settings: CustomDomainSettings,
  // Who asked (the Check button); the sweeper's checks are recorded as the system.
  actor: { userId: number, ip: string | null } | null = null
): Promise<{ check: DnsCheck, row: CustomDomainRow | null, newlyVerified: boolean }> {
  let check: DnsCheck = await checkCustomDomainDns(domain.hostname, domain.verifyToken, settings.target, dnsLookups(settings.dnsServers))
  // Only a live domain can be dropped; a pending one just stays pending.
  const dropVerified = domain.status === 'verified'
    && (!domain.verifiedAt || Date.now() - domain.verifiedAt.getTime() > CUSTOM_DOMAIN_GRACE_MS)
  let row: CustomDomainRow | null
  try {
    row = await recordCustomDomainCheck(domain.id, check.ok ? { ok: true } : { ok: false, problem: check.problem, dropVerified })
  } catch (e) {
    // Another account's claim of this hostname is verified (unique index on
    // verified hostnames): the records match, but the domain is theirs.
    if (!isUniqueViolation(e)) throw e
    check = { ok: false, problem: 'in-use' }
    row = await recordCustomDomainCheck(domain.id, { ok: false, problem: check.problem, dropVerified: false })
  }
  if (row?.status !== domain.status) invalidateCustomDomainCache()
  const newlyVerified = check.ok && domain.status !== 'verified'
  const dropped = domain.status === 'verified' && row?.status === 'failed'
  if (newlyVerified || dropped) {
    await appendAuditEvent({
      actorUserId: actor?.userId ?? null,
      actorIp: actor?.ip ?? null,
      scope: 'user',
      scopeId: String(domain.userId),
      action: newlyVerified ? AUDIT_CUSTOM_DOMAIN_VERIFIED : AUDIT_CUSTOM_DOMAIN_DROPPED,
      metadata: { domainId: domain.id, hostname: domain.hostname, ...(dropped && !check.ok ? { problem: check.problem } : {}) }
    })
  }
  return { check, row, newlyVerified }
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string }).code === '23505' || (e as { cause?: { code?: string } }).cause?.code === '23505'
}
