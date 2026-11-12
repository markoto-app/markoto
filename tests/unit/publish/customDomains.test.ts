import { describe, expect, it } from 'vitest'
import { normalizeCustomHostname } from '../../../shared/config/customDomains'
import { checkCustomDomainDns, type DnsLookups } from '../../../server/utils/customDomains/dns'
import { buildTraefikDynamicConfig } from '../../../server/utils/customDomains/traefikConfig'
import { customDomainSettings, traefikProviderSettings, type TraefikProviderSettings } from '../../../server/utils/customDomains/config'

// Custom domains: hostname rules, the DNS check (ownership TXT +
// CNAME or same addresses), the Traefik dynamic config, the settings.

describe('normalizeCustomHostname', () => {
  it('accepts plain names in any typed form', () => {
    expect(normalizeCustomHostname('Docs.Acme.com')).toBe('docs.acme.com')
    expect(normalizeCustomHostname(' https://docs.acme.com/a/b?c ')).toBe('docs.acme.com')
    expect(normalizeCustomHostname('docs.acme.com.')).toBe('docs.acme.com')
    expect(normalizeCustomHostname('acme.com')).toBe('acme.com')
    expect(normalizeCustomHostname('münchen.de')).toBe('xn--mnchen-3ya.de')
  })

  it('refuses everything that is not a public DNS name', () => {
    for (const bad of ['', 'acme', 'localhost', '1.2.3.4', '0x7f.1', '[::1]', 'a.com:8443', 'u@a.com', '*.a.com', 'a..com', '-a.com', 'a-.com', 'a b.com',
      'x.local', 'x.internal', 'x.localhost', 'x.home.arpa', '4.3.2.1.in-addr.arpa', 'x.onion', 'x.example', 'x.test', 'ftp://a.com', 42, null]) {
      expect(normalizeCustomHostname(bad), String(bad)).toBeNull()
    }
    expect(normalizeCustomHostname('x.test', { allowTestNames: true })).toBe('x.test')
  })
})

describe('checkCustomDomainDns', () => {
  const TOKEN = 'tok123'
  const TARGET = 'pages.markoto.app'
  function lookups(records: { txt?: Record<string, string[][]>, cname?: Record<string, string[]>, a?: Record<string, string[]>, aaaa?: Record<string, string[]> }, failing = false): DnsLookups {
    const get = <T>(table: Record<string, T[]> | undefined, name: string): Promise<T[]> => {
      if (failing) return Promise.reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }))
      const v = table?.[name]
      return v ? Promise.resolve(v) : Promise.reject(Object.assign(new Error('nodata'), { code: 'ENODATA' }))
    }
    return {
      resolveTxt: n => get(records.txt, n),
      resolveCname: n => get(records.cname, n),
      resolve4: n => get(records.a, n),
      resolve6: n => get(records.aaaa, n)
    }
  }
  const txt = { '_markoto-verify.docs.acme.com': [['markoto-verify=', 'tok123']] }

  it('ownership first', async () => {
    expect(await checkCustomDomainDns('docs.acme.com', TOKEN, TARGET, lookups({}))).toEqual({ ok: false, problem: 'txt-missing' })
    expect(await checkCustomDomainDns('docs.acme.com', TOKEN, TARGET, lookups({ txt: { '_markoto-verify.docs.acme.com': [['markoto-verify=other']] } }))).toEqual({ ok: false, problem: 'txt-mismatch' })
  })

  it('a CNAME to the target (chunked TXT, trailing dots, case)', async () => {
    expect(await checkCustomDomainDns('docs.acme.com', TOKEN, TARGET, lookups({ txt, cname: { 'docs.acme.com': ['Pages.Markoto.App.'] } }))).toEqual({ ok: true })
    expect(await checkCustomDomainDns('docs.acme.com', TOKEN, TARGET, lookups({ txt, cname: { 'docs.acme.com': ['elsewhere.example.net'] } }))).toEqual({ ok: false, problem: 'not-pointing' })
  })

  it('an apex domain with exactly our addresses', async () => {
    const a = { 'pages.markoto.app': ['203.0.113.7'], 'docs.acme.com': ['203.0.113.7'] }
    expect(await checkCustomDomainDns('docs.acme.com', TOKEN, TARGET, lookups({ txt, a }))).toEqual({ ok: true })
    // One foreign address is enough to refuse (round-robin to someone else).
    expect(await checkCustomDomainDns('docs.acme.com', TOKEN, TARGET, lookups({ txt, a: { ...a, 'docs.acme.com': ['203.0.113.7', '198.51.100.1'] } }))).toEqual({ ok: false, problem: 'not-pointing' })
    expect(await checkCustomDomainDns('docs.acme.com', TOKEN, TARGET, lookups({ txt, a: { 'docs.acme.com': ['203.0.113.7'] } }))).toEqual({ ok: false, problem: 'not-pointing' })
  })

  it('a resolver failure is not a verdict about the records', async () => {
    expect(await checkCustomDomainDns('docs.acme.com', TOKEN, TARGET, lookups({}, true))).toEqual({ ok: false, problem: 'lookup-failed' })
  })
})

describe('Traefik dynamic config', () => {
  const settings: TraefikProviderSettings = { token: 'x'.repeat(32), entryPoint: 'websecure', certResolver: 'le', service: 'app@docker', upstream: null, middlewares: ['security-headers@docker'], pagesRouter: false }

  it('one TLS router per live domain to the app service', () => {
    const cfg = buildTraefikDynamicConfig([{ id: 'Ab_cd-12', hostname: 'docs.acme.com', pageId: 'p' }], settings)
    expect(cfg).toEqual({
      http: {
        routers: {
          'markoto-domain-Ab-cd-12': {
            rule: 'Host(`docs.acme.com`)',
            entryPoints: ['websecure'],
            service: 'app@docker',
            middlewares: ['security-headers@docker'],
            tls: { certResolver: 'le' }
          }
        }
      }
    })
  })

  it('declares its own service for an upstream URL; empty without domains; never a broken rule', () => {
    const cfg = buildTraefikDynamicConfig([{ id: 'a', hostname: 'docs.acme.com', pageId: null }], { ...settings, upstream: 'http://app:3000', middlewares: [] }) as { http: { services: unknown, routers: Record<string, { service: string }> } }
    expect(cfg.http.services).toEqual({ 'markoto-published-pages': { loadBalancer: { servers: [{ url: 'http://app:3000' }] } } })
    expect(cfg.http.routers['markoto-domain-a']!.service).toBe('markoto-published-pages')
    expect(buildTraefikDynamicConfig([], settings)).toEqual({})
    expect(buildTraefikDynamicConfig([{ id: 'b', hostname: 'a.com`) || Host(`evil.com', pageId: null }], settings)).toEqual({})
  })

  it('the pages host gets a router that admits only the published-page paths', () => {
    const cfg = buildTraefikDynamicConfig([], settings, 'pages.example.org') as { http: { routers: Record<string, { rule: string, tls: unknown, service: string }> } }
    const router = cfg.http.routers['markoto-pages-host']!
    expect(router.rule).toBe('Host(`pages.example.org`) && (PathPrefix(`/p/`) || PathPrefix(`/api/published/`) || PathPrefix(`/vendor/`) || Path(`/robots.txt`) || Path(`/favicon.ico`))')
    expect(router.tls).toEqual({ certResolver: 'le' })
    expect(router.service).toBe('app@docker')
    // Neither the app root nor any internal route matches it.
    expect(router.rule).not.toMatch(/PathPrefix\(`\/`\)|\/api\/internal|_internal/)
    expect(buildTraefikDynamicConfig([], settings, 'a.com`) || Host(`evil.com')).toEqual({})
  })
})

describe('settings', () => {
  it('custom domains are off without a target; the provider endpoint without a token', () => {
    expect(customDomainSettings({})).toBeNull()
    expect(customDomainSettings({ NUXT_PUBLISH_DOMAINS_TARGET: 'Pages.Markoto.App.', NUXT_PUBLISH_DNS_SERVERS: '1.1.1.1, 9.9.9.9:53' })).toEqual({ target: 'pages.markoto.app', dnsServers: ['1.1.1.1', '9.9.9.9:53'], allowTestNames: false })
    expect(traefikProviderSettings({})).toBeNull()
    // A short token is a configuration error at boot, not a silently closed endpoint.
    expect(() => traefikProviderSettings({ NUXT_PUBLISH_TRAEFIK_TOKEN: 'short' })).toThrow(/NUXT_PUBLISH_TRAEFIK_TOKEN: expected at least 32 characters/)
    expect(traefikProviderSettings({ NUXT_PUBLISH_TRAEFIK_TOKEN: 'y'.repeat(32) })).toMatchObject({ entryPoint: 'websecure', certResolver: 'le', service: 'app@docker', upstream: null, middlewares: [], pagesRouter: false })
    expect(traefikProviderSettings({ NUXT_PUBLISH_TRAEFIK_TOKEN: 'y'.repeat(32), NUXT_PUBLISH_TRAEFIK_PAGES_ROUTER: 'true' })?.pagesRouter).toBe(true)
  })
})
