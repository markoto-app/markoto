// Per-workspace SSO admin side: how a workspace's connection settings are
// validated, and the view sent to the browser (never a secret). Who may manage
// them is the routes' policy: `allow.workspace('admin', { ignoreSso: true })`.

import { X509Certificate } from 'node:crypto'
import type { H3Event } from 'h3'
import { listSsoDomains, type SsoConnectionFields, type SsoConnectionRow, type SsoDomainRow } from '../../repos/sso'
import { planHasFeature, resolveWorkspacePlan } from '../billing/entitlements'
import { sealSecret, secretContext } from '../platform/secretBox'
import { checkSsoUrl, ssoAllowsPrivateUrls, SsoUrlRefused } from './urlPolicy'
import { samlAcsUrl, samlSpEntityId, ssoBaseUrl, ssoCallbackUrl } from './http'
import { DOMAIN_TXT_PREFIX } from './domains'

function invalid(field: string, message: string): Error {
  return createError({ statusCode: 400, message, data: { code: 'sso/invalid-settings', field } })
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
  if (!/^[A-Za-z0-9+/]+=*$/.test(body)) throw invalid('samlIdpCert', 'Paste the IdP signing certificate (PEM or Base64).')
  const pem = `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`
  let cert: X509Certificate
  try {
    cert = new X509Certificate(pem)
  } catch {
    throw invalid('samlIdpCert', 'This is not a valid X.509 certificate.')
  }
  if (new Date(cert.validTo).getTime() <= now.getTime()) throw invalid('samlIdpCert', 'This certificate has expired.')
  return pem
}

/** Validate the PUT body into repo fields. The client secret is encrypted here. */
export async function parseSsoSettings(body: unknown, existing: SsoConnectionRow | null, workspaceId: string): Promise<SsoConnectionFields> {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  if (b.protocol !== 'oidc' && b.protocol !== 'saml') throw invalid('protocol', 'Choose OpenID Connect or SAML.')
  const defaultRole = b.defaultRole === undefined ? undefined : b.defaultRole === 'editor' || b.defaultRole === 'viewer' ? b.defaultRole : null
  if (defaultRole === null) throw invalid('defaultRole', 'The default role is editor or viewer.')

  if (b.protocol === 'oidc') {
    const issuer = text(b.oidcIssuer, 'oidcIssuer')
    try {
      await checkSsoUrl(issuer)
    } catch (e) {
      if (e instanceof SsoUrlRefused) throw invalid('oidcIssuer', e.message)
      throw e
    }
    const clientId = text(b.oidcClientId, 'oidcClientId')
    let secret: string | undefined
    if (typeof b.oidcClientSecret === 'string' && b.oidcClientSecret.trim()) {
      secret = sealSecret('sso-client-secret', secretContext.ssoClientSecret(workspaceId), text(b.oidcClientSecret, 'oidcClientSecret'))
    } else if (!(existing?.protocol === 'oidc' && existing.oidcClientSecret)) {
      throw invalid('oidcClientSecret', 'The client secret is required.')
    }
    return { protocol: 'oidc', oidcIssuer: issuer.replace(/\/+$/, ''), oidcClientId: clientId, oidcClientSecret: secret, defaultRole }
  }

  const entityId = text(b.samlIdpEntityId, 'samlIdpEntityId')
  const ssoUrl = text(b.samlSsoUrl, 'samlSsoUrl')
  let parsed: URL
  try {
    parsed = new URL(ssoUrl)
  } catch {
    throw invalid('samlSsoUrl', 'The SSO URL is not a valid URL.')
  }
  // The browser goes there, not the server, so https is all we require
  // (http only on an instance that allows private IdPs, e.g. tests).
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ssoAllowsPrivateUrls())) {
    throw invalid('samlSsoUrl', 'The SSO URL must start with https://.')
  }
  if (parsed.username || parsed.password) throw invalid('samlSsoUrl', 'The SSO URL must not contain a user name or password.')
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
