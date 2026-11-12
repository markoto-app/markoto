// Per-workspace SSO admin side: how a workspace's connection settings are
// validated, and the view sent to the browser (never a secret). Who may manage
// them is the routes' policy: `allow.workspace('admin', { ignoreSso: true })`.

import { X509Certificate } from 'node:crypto'
import type { UpdateSsoSettingsBody } from '~~/shared/api/sso'
import type { H3Event } from 'h3'
import { listSsoDomains, type SsoConnectionFields, type SsoConnectionRow, type SsoDomainRow } from '../../repos/sso'
import { planHasFeature, resolveWorkspacePlan } from '../billing/entitlements'
import { sealSecret, secretContext } from '../platform/secretBox'
import { checkSsoUrl, ssoAllowsPrivateUrls, SsoUrlRefused } from './urlPolicy'
import { samlAcsUrl, samlSpEntityId, ssoBaseUrl, ssoCallbackUrl } from './http'
import { DOMAIN_TXT_PREFIX } from './domains'
import { apiError } from '../api/apiError'
import { trimTrailingSlashes } from '~~/shared/utils/trimTrailingSlashes'

function invalid(field: string, detail: string): Error {
  return apiError('sso/invalid-settings', { field, detail })
}

/** A refused URL as the error that tells the admin what to change. */
function urlRefused(field: string, e: SsoUrlRefused): Error {
  switch (e.reason) {
    case 'invalid': return apiError('sso/url-invalid', { field })
    case 'not-https': return apiError('sso/url-not-https', { field })
    case 'credentials': return apiError('sso/url-credentials', { field })
    case 'unresolvable': return apiError('sso/url-unresolvable', { field, host: e.host ?? '' })
    case 'refused': return apiError('sso/url-refused', { field })
  }
}

const MAX_TEXT = 1024
const MAX_CERT = 16 * 1024

function text(v: unknown, field: string, max = MAX_TEXT): string {
  if (typeof v !== 'string' || !v.trim()) throw invalid(field, `${field} is required.`)
  if (v.length > max) throw invalid(field, `${field} is too long.`)
  return v.trim()
}

/** One PEM certificate (BEGIN/END lines optional), currently valid. */
function normalizeIdpCertificate(raw: unknown, now = new Date()): string {
  const input = text(raw, 'samlIdpCert', MAX_CERT)
  const body = input.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]+=*$/.test(body)) throw apiError('sso/certificate-format', { field: 'samlIdpCert' })
  const lines: string[] = []
  for (let i = 0; i < body.length; i += 64) lines.push(body.slice(i, i + 64))
  const pem = `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`
  let cert: X509Certificate
  try {
    cert = new X509Certificate(pem)
  } catch {
    throw apiError('sso/certificate-invalid', { field: 'samlIdpCert' })
  }
  if (new Date(cert.validTo).getTime() <= now.getTime()) throw apiError('sso/certificate-expired', { field: 'samlIdpCert' })
  return pem
}

/** Validate the PUT body into repo fields. The client secret is encrypted here. */
export async function parseSsoSettings(b: UpdateSsoSettingsBody, existing: SsoConnectionRow | null, workspaceId: string): Promise<SsoConnectionFields> {
  // `protocol` and `defaultRole` are checked by the route's schema
  // (`updateSsoSettingsBody`); the protocol's own fields are checked here.
  const defaultRole = b.defaultRole

  if (b.protocol === 'oidc') {
    const issuer = text(b.oidcIssuer, 'oidcIssuer')
    try {
      await checkSsoUrl(issuer)
    } catch (e) {
      if (e instanceof SsoUrlRefused) throw urlRefused('oidcIssuer', e)
      throw e
    }
    const clientId = text(b.oidcClientId, 'oidcClientId')
    let secret: string | undefined
    if (b.oidcClientSecret?.trim()) {
      secret = sealSecret('sso-client-secret', secretContext.ssoClientSecret(workspaceId), text(b.oidcClientSecret, 'oidcClientSecret'))
    } else if (!(existing?.protocol === 'oidc' && existing.oidcClientSecret)) {
      throw apiError('sso/client-secret-required', { field: 'oidcClientSecret' })
    }
    return { protocol: 'oidc', oidcIssuer: trimTrailingSlashes(issuer), oidcClientId: clientId, oidcClientSecret: secret, defaultRole }
  }

  const entityId = text(b.samlIdpEntityId, 'samlIdpEntityId')
  const ssoUrl = text(b.samlSsoUrl, 'samlSsoUrl')
  let parsed: URL
  try {
    parsed = new URL(ssoUrl)
  } catch {
    throw apiError('sso/url-invalid', { field: 'samlSsoUrl' })
  }
  // The browser goes there, not the server, so https is all we require
  // (http only on an instance that allows private IdPs, e.g. tests).
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ssoAllowsPrivateUrls())) {
    throw apiError('sso/url-not-https', { field: 'samlSsoUrl' })
  }
  if (parsed.username || parsed.password) throw apiError('sso/url-credentials', { field: 'samlSsoUrl' })
  return {
    protocol: 'saml',
    samlIdpEntityId: entityId,
    samlSsoUrl: parsed.href,
    samlIdpCert: normalizeIdpCertificate(b.samlIdpCert),
    defaultRole
  }
}

export interface SsoSettingsView {
  /** The workspace's plan includes single sign-on. */
  available: boolean
  connection: null | {
    id: string
    protocol: 'oidc' | 'saml'
    status: 'draft' | 'active'
    defaultRole: 'editor' | 'viewer'
    oidcIssuer: string | null
    oidcClientId: string | null
    hasClientSecret: boolean
    samlIdpEntityId: string | null
    samlSsoUrl: string | null
    /** Subject + expiry of the pasted certificate, never its body. */
    samlCertificate: null | { subject: string, validTo: string }
    hasScimToken: boolean
    activatedAt: string | null
    /** What the admin enters at the IdP. */
    sp: { loginUrl: string, callbackUrl: string, entityId: string, acsUrl: string, metadataUrl: string, scimBaseUrl: string }
  }
  domains: Array<{ id: number, domain: string, verified: boolean, txtName: string, txtValue: string }>
}

function certificateSummary(pem: string | null): { subject: string, validTo: string } | null {
  if (!pem) return null
  try {
    const cert = new X509Certificate(pem)
    return { subject: cert.subject.replace(/\n/g, ', '), validTo: new Date(cert.validTo).toISOString() }
  } catch {
    return null
  }
}

export function domainView(d: SsoDomainRow) {
  return { id: d.id, domain: d.domain, verified: d.verifiedAt !== null, txtName: d.domain, txtValue: `${DOMAIN_TXT_PREFIX}${d.verificationToken}` }
}

export async function ssoSettingsView(event: H3Event, wsId: string, connection: SsoConnectionRow | null): Promise<SsoSettingsView> {
  const available = planHasFeature(await resolveWorkspacePlan(wsId), 'sso')
  const domains = (await listSsoDomains(wsId)).map(domainView)
  if (!connection) return { available, connection: null, domains }
  const base = ssoBaseUrl(event)
  return {
    available,
    domains,
    connection: {
      id: connection.id,
      protocol: connection.protocol,
      status: connection.status,
      defaultRole: connection.defaultRole,
      oidcIssuer: connection.oidcIssuer,
      oidcClientId: connection.oidcClientId,
      hasClientSecret: connection.oidcClientSecret !== null,
      samlIdpEntityId: connection.samlIdpEntityId,
      samlSsoUrl: connection.samlSsoUrl,
      samlCertificate: certificateSummary(connection.samlIdpCert),
      hasScimToken: connection.hasScimToken,
      activatedAt: connection.activatedAt?.toISOString() ?? null,
      sp: {
        loginUrl: `${base}/auth/sso/${connection.id}`,
        callbackUrl: ssoCallbackUrl(event, connection.id),
        entityId: samlSpEntityId(event, connection.id),
        acsUrl: samlAcsUrl(event, connection.id),
        metadataUrl: samlSpEntityId(event, connection.id),
        scimBaseUrl: `${base}/scim/v2`
      }
    }
  }
}
