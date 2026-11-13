import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { SignedXml } from 'xml-crypto'

// A SAML identity provider in a function, for the per-workspace SSO tests. It signs exactly the Response the
// test asks for, including the malformed ones a real IdP would never send (wrong audience, expired, unsigned,
// answering another request), so every check in `server/utils/sso/saml.ts` is exercised against the real
// library.
//
// The key pair is generated per run with openssl (no key in the repo).

export interface IdpKeyPair {
  key: string
  cert: string
}

export function makeIdpKeyPair(cn = 'markoto-test-idp'): IdpKeyPair {
  const dir = mkdtempSync(join(tmpdir(), 'saml-idp-'))
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2',
      '-subj', `/CN=${cn}`, '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' })
    return { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export interface ResponseSpec {
  idp: IdpKeyPair
  issuer: string
  inResponseTo: string | null
  acsUrl: string
  audience: string
  nameId: string
  email?: string
  name?: string
  /** Default: now − 1 min … now + 5 min. */
  notBefore?: Date
  notOnOrAfter?: Date
  assertionId?: string
  /** false = no signature at all. */
  sign?: boolean
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const id = () => `_${randomBytes(16).toString('hex')}`

/** A Response with one assertion, the assertion signed (base64, as POSTed). */
export function samlResponse(spec: ResponseSpec): string {
  const now = new Date()
  const notBefore = (spec.notBefore ?? new Date(now.getTime() - 60_000)).toISOString()
  const notOnOrAfter = (spec.notOnOrAfter ?? new Date(now.getTime() + 5 * 60_000)).toISOString()
  const issueInstant = now.toISOString()
  const assertionId = spec.assertionId ?? id()
  const irt = spec.inResponseTo ? ` InResponseTo="${esc(spec.inResponseTo)}"` : ''
  const attrs = [
    spec.email ? `<saml:Attribute Name="email"><saml:AttributeValue>${esc(spec.email)}</saml:AttributeValue></saml:Attribute>` : '',
    spec.name ? `<saml:Attribute Name="displayName"><saml:AttributeValue>${esc(spec.name)}</saml:AttributeValue></saml:Attribute>` : ''
  ].join('')
  const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${issueInstant}">`
    + `<saml:Issuer>${esc(spec.issuer)}</saml:Issuer>`
    + `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${esc(spec.nameId)}</saml:NameID>`
    + `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${irt} NotOnOrAfter="${notOnOrAfter}" Recipient="${esc(spec.acsUrl)}"/></saml:SubjectConfirmation></saml:Subject>`
    + `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${esc(spec.audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
    + `<saml:AuthnStatement AuthnInstant="${issueInstant}" SessionIndex="${id()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`
    + (attrs ? `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` : '')
    + '</saml:Assertion>'

  let signedAssertion = assertion
  if (spec.sign !== false) {
    const sig = new SignedXml({
      privateKey: spec.idp.key,
      publicCert: spec.idp.cert,
      canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'
    })
    sig.addReference({
      xpath: '//*[local-name(.)=\'Assertion\']',
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#']
    })
    sig.computeSignature(assertion, { location: { reference: '//*[local-name(.)=\'Issuer\']', action: 'after' } })
    signedAssertion = sig.getSignedXml()
  }

  const response = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id()}" Version="2.0" IssueInstant="${issueInstant}" Destination="${esc(spec.acsUrl)}"${irt}>`
    + `<saml:Issuer>${esc(spec.issuer)}</saml:Issuer>`
    + '<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>'
    + signedAssertion
    + '</samlp:Response>'
  return Buffer.from(response).toString('base64')
}

/** The AuthnRequest ID inside a HTTP-Redirect sign-in URL. */
export async function authnRequestId(redirectUrl: string): Promise<string> {
  const { inflateRawSync } = await import('node:zlib')
  const raw = new URL(redirectUrl).searchParams.get('SAMLRequest')
  if (!raw) throw new Error('no SAMLRequest in the redirect')
  const xml = inflateRawSync(Buffer.from(raw, 'base64')).toString('utf8')
  const match = /\sID="([^"]+)"/.exec(xml)
  if (!match?.[1]) throw new Error('no ID in the AuthnRequest')
  return match[1]
}
