import { describe, it, expect } from 'vitest'
import { checkProviderBaseUrl, type ByokUrlPolicy, type Resolver } from '../../../server/utils/aiProviders/urlPolicy'
import { isAlwaysForbiddenIp } from '../../../server/utils/agentic/urlGuard'
import { RECOMMENDED_SAAS_ALLOWED_BASE_URLS, normalizeBaseUrl } from '../../../shared/ai/providers'

// BYOK SSRF policy (WP4). Pure function + injected DNS resolver, so the
// DNS-rebinding-shaped cases (a public-looking hostname resolving to a
// private / loopback / metadata address) run without a network.

const SELF_HOST: ByokUrlPolicy = { allowedBaseUrls: [], allowPrivate: false }
const SELF_HOST_PRIVATE: ByokUrlPolicy = { allowedBaseUrls: [], allowPrivate: true }
const SAAS: ByokUrlPolicy = { allowedBaseUrls: [...RECOMMENDED_SAAS_ALLOWED_BASE_URLS], allowPrivate: false }

/** Resolver that maps hostnames to fixed address lists. */
function dns(map: Record<string, string[]>): Resolver {
  return async (host) => {
    const hit = map[host]
    if (!hit) throw new Error(`ENOTFOUND ${host}`)
    return hit
  }
}

const PUBLIC = dns({
  'api.mistral.ai': ['104.18.10.1'],
  'api.openai.com': ['162.159.140.245'],
  'my-llm.example.com': ['93.184.215.14'],
  'rebind.example.com': ['127.0.0.1'],
  'mixed.example.com': ['93.184.215.14', '10.0.0.5'],
  'metadata.example.com': ['169.254.169.254'],
  'lan-gpu.example.com': ['192.168.1.20'],
  'host.docker.internal': ['172.17.0.1'],
  'v6-loop.example.com': ['::1']
})

async function refusal(url: string, policy: ByokUrlPolicy, resolver: Resolver = PUBLIC): Promise<string | null> {
  const r = await checkProviderBaseUrl(url, policy, resolver)
  return r.ok ? null : r.code
}

describe('structure', () => {
  it('accepts a public https base URL and normalises trailing slashes', async () => {
    const r = await checkProviderBaseUrl('https://api.mistral.ai/v1/', SELF_HOST, PUBLIC)
    expect(r).toEqual({ ok: true, normalized: 'https://api.mistral.ai/v1' })
  })

  it.each([
    ['not a url', 'invalid'],
    ['ftp://api.mistral.ai/v1', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['https://user:pw@api.mistral.ai/v1', 'credentials-in-url'],
    ['https://api.mistral.ai/v1?x=1', 'invalid'],
    ['https://api.mistral.ai/v1#frag', 'invalid']
  ])('refuses %s (%s)', async (url, code) => {
    expect(await refusal(url, SELF_HOST_PRIVATE)).toBe(code)
  })
})

describe('internal service hostnames are always refused', () => {
  it.each(['litellm', 'postgres', 'valkey', 'sync', 'renderer', 'markitdown', 'localhost', 'litellm-test', 'metadata.google.internal', 'foo.localhost'])(
    '%s — even with the private-network opt-in',
    async (host) => {
      expect(await refusal(`http://${host}:4000/v1`, SELF_HOST_PRIVATE, async () => ['10.0.0.9'])).toBe('internal-host')
    }
  )
})

describe('address classes', () => {
  it('refuses private IP literals without the opt-in', async () => {
    expect(await refusal('https://10.0.0.5/v1', SELF_HOST)).toBe('private-address')
    expect(await refusal('https://192.168.1.20/v1', SELF_HOST)).toBe('private-address')
    expect(await refusal('https://[fd00::1]/v1', SELF_HOST)).toBe('private-address')
  })

  it('refuses loopback, metadata and link-local even WITH the opt-in', async () => {
    expect(await refusal('http://127.0.0.1:11434/v1', SELF_HOST_PRIVATE)).toBe('private-address')
    expect(await refusal('http://169.254.169.254/latest', SELF_HOST_PRIVATE)).toBe('private-address')
    expect(await refusal('http://[::1]:11434/v1', SELF_HOST_PRIVATE)).toBe('private-address')
    expect(await refusal('http://0.0.0.0:8000/v1', SELF_HOST_PRIVATE)).toBe('private-address')
  })

  it('DNS rebinding: a public-looking hostname resolving to loopback is refused', async () => {
    expect(await refusal('https://rebind.example.com/v1', SELF_HOST_PRIVATE)).toBe('private-address')
    expect(await refusal('https://v6-loop.example.com/v1', SELF_HOST_PRIVATE)).toBe('private-address')
  })

  it('a hostname resolving to the metadata address is refused', async () => {
    expect(await refusal('https://metadata.example.com/v1', SELF_HOST_PRIVATE)).toBe('private-address')
  })

  it('ANY private record in a mixed answer refuses without the opt-in', async () => {
    expect(await refusal('https://mixed.example.com/v1', SELF_HOST)).toBe('private-address')
  })

  it('unresolvable hostnames are refused', async () => {
    expect(await refusal('https://nope.invalid/v1', SELF_HOST)).toBe('unresolvable')
  })

  it('self-host opt-in allows LAN / docker-bridge endpoints, incl. plain http', async () => {
    expect(await refusal('http://host.docker.internal:11434/v1', SELF_HOST_PRIVATE)).toBeNull()
    expect(await refusal('http://lan-gpu.example.com:8000/v1', SELF_HOST_PRIVATE)).toBeNull()
    expect(await refusal('http://172.17.0.1:4120/v1', SELF_HOST_PRIVATE)).toBeNull()
  })
})

describe('https requirement', () => {
  it('refuses plain http to a public host, with or without the opt-in', async () => {
    expect(await refusal('http://my-llm.example.com/v1', SELF_HOST)).toBe('https-required')
    expect(await refusal('http://my-llm.example.com/v1', SELF_HOST_PRIVATE)).toBe('https-required')
  })

  it('refuses plain http when a private host is mixed with a public record', async () => {
    expect(await refusal('http://mixed.example.com/v1', SELF_HOST_PRIVATE)).toBe('https-required')
  })
})

describe('SaaS allowlist', () => {
  it('allows listed providers (and paths under them)', async () => {
    expect(await refusal('https://api.mistral.ai/v1', SAAS)).toBeNull()
    expect(await refusal('https://api.openai.com/v1/', SAAS)).toBeNull()
  })

  it('refuses anything not on the list — even a perfectly public URL', async () => {
    expect(await refusal('https://my-llm.example.com/v1', SAAS)).toBe('not-allowlisted')
  })

  it('does not treat a shared prefix as a match (api.openai.com.evil)', async () => {
    expect(await refusal('https://api.openai.com.evil.example/v1', SAAS)).toBe('not-allowlisted')
    expect(await refusal('https://api.openai.com/v10', SAAS)).toBe('not-allowlisted')
  })

  it('the same URL is allowed in a self-host (free-form) config', async () => {
    expect(await refusal('https://my-llm.example.com/v1', SELF_HOST)).toBeNull()
  })
})

describe('isAlwaysForbiddenIp', () => {
  it.each(['127.0.0.1', '127.8.8.8', '0.0.0.0', '169.254.169.254', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'ff02::1', 'fd00:ec2::254', '::ffff:127.0.0.1', 'garbage'])(
    'forbids %s', (ip) => {
      expect(isAlwaysForbiddenIp(ip)).toBe(true)
    }
  )
  it.each(['10.0.0.1', '172.17.0.1', '192.168.0.10', '100.64.0.1', 'fd12::1', '93.184.215.14', '2606:4700::1111'])(
    'leaves %s to the private-network policy', (ip) => {
      expect(isAlwaysForbiddenIp(ip)).toBe(false)
    }
  )
})

// Regression (internal-hostname bypass): a trailing dot is the same name
// to a resolver, and some compose names were missing from the list.
describe('internal hostnames — every spelling, every compose name', () => {
  const resolveToBridge: Resolver = async () => ['172.18.0.7']
  it.each([
    'litellm.',
    'postgres.',
    'LITELLM',
    'Valkey..',
    'markoto-app',
    'litellm-db-init',
    'db-init',
    'socket-proxy',
    's3-init',
    'fake-openai-test',
    'markoto-litellm-1',
    'myinstance-postgres-1',
    'markoto_app_1'
  ])('refuses %s even with the private-network opt-in', async (host) => {
    expect(await refusal(`http://${host}:4000/v1`, SELF_HOST_PRIVATE, resolveToBridge)).toBe('internal-host')
  })

  it('does not over-match ordinary public hostnames that contain a service word', async () => {
    const pub: Resolver = async () => ['93.184.215.14']
    expect(await refusal('https://sync.example.com/v1', SELF_HOST, pub)).toBeNull()
    expect(await refusal('https://app-1.example.com/v1', SELF_HOST, pub)).toBeNull()
  })
})

// Regression (IPv6 classification): literal forms that embed a forbidden
// IPv4 address were accepted under the private-network opt-in.
describe('IPv6 literal forms under the private-network opt-in', () => {
  it.each([
    ['IPv4-mapped loopback (hex form)', 'http://[::ffff:7f00:1]/v1'],
    ['IPv4-mapped metadata', 'http://[::ffff:169.254.169.254]/v1'],
    ['IPv4-compatible loopback', 'http://[::127.0.0.1]/v1'],
    ['NAT64 loopback', 'http://[64:ff9b::7f00:1]/v1'],
    ['6to4 loopback', 'http://[2002:7f00:1::]/v1'],
    ['Teredo', 'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/v1']
  ])('refuses %s', async (_label, url) => {
    expect(await refusal(url, SELF_HOST_PRIVATE)).toBe('private-address')
  })
})

describe('recommended SaaS allowlist', () => {
  it('is all https and already normalised', () => {
    for (const url of RECOMMENDED_SAAS_ALLOWED_BASE_URLS) {
      expect(url.startsWith('https://')).toBe(true)
      expect(normalizeBaseUrl(url)).toBe(url)
    }
  })
})
