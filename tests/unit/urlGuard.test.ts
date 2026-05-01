import { describe, it, expect, vi, beforeEach } from 'vitest'

// SSRF guard for AI URL-taking tools. Critical that:
//   - HTTP(S) public URLs pass.
//   - Non-HTTP schemes (file://, gopher://, dict://) are refused.
//   - IP literals in any private/special-use range are refused.
//   - Hostnames that resolve via DNS to a private IP are refused.
//
// We mock `node:dns/promises.lookup` so the public-hostname tests
// don't require live DNS — every test in this file is deterministic.

const lookup = vi.hoisted(() =>
  vi.fn<(host: string, opts?: unknown) => Promise<Array<{ address: string, family: number }>>>()
)

vi.mock('node:dns/promises', () => ({ lookup }))

const { assertSafeUrl, isPrivateIp } = await import('../../server/utils/agentic/urlGuard')

beforeEach(() => {
  lookup.mockReset()
  // Default: every hostname resolves to a fixed public IP. Tests that
  // care about the resolution override per-call.
  lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]) // example.com
})

describe('isPrivateIp — IPv4', () => {
  it.each([
    ['10.0.0.1', true],
    ['10.255.255.255', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.0.1', true],
    ['192.168.1.1', true],
    ['127.0.0.1', true],
    ['127.255.255.254', true],
    ['169.254.169.254', true], // AWS / GCP metadata
    ['100.64.0.1', true],
    ['100.127.255.255', true],
    ['100.128.0.1', false],
    ['0.0.0.0', true],
    ['255.255.255.255', true],
    ['224.0.0.1', true],
    ['198.18.0.1', true],
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['93.184.216.34', false], // example.com
    ['notanip', true]
  ])('classifies %s as private=%s', (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected)
  })
})

describe('isPrivateIp — IPv6', () => {
  it.each([
    ['::1', true],
    ['::', true],
    ['fc00::1', true],
    ['fd00::1', true],
    ['fe80::1', true],
    ['fec0::1', false], // outside fe80::/10
    ['ff02::1', true], // multicast
    ['::ffff:127.0.0.1', true], // IPv4-mapped loopback
    ['::ffff:8.8.8.8', false], // IPv4-mapped public
    ['2001:4860:4860::8888', false], // Google public DNS
    ['2606:4700:4700::1111', false] // Cloudflare public
  ])('classifies %s as private=%s', (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected)
  })
})

describe('assertSafeUrl — schemes', () => {
  it('allows https:// public URLs', async () => {
    await expect(assertSafeUrl('https://example.com/path')).resolves.toBeUndefined()
  })

  it('allows http:// public URLs', async () => {
    await expect(assertSafeUrl('http://example.com')).resolves.toBeUndefined()
  })

  it('allows scheme-less hostnames (https:// prepended)', async () => {
    await expect(assertSafeUrl('example.com')).resolves.toBeUndefined()
  })

  it('rejects file:// URLs', async () => {
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toThrow(/scheme/i)
  })

  it('rejects gopher:// URLs', async () => {
    await expect(assertSafeUrl('gopher://example.com/9/exploit')).rejects.toThrow(/scheme/i)
  })

  it('rejects dict:// URLs', async () => {
    await expect(assertSafeUrl('dict://localhost:11211/stats')).rejects.toThrow(/scheme/i)
  })

  it('rejects ftp:// URLs', async () => {
    await expect(assertSafeUrl('ftp://example.com/file')).rejects.toThrow(/scheme/i)
  })

  it('rejects empty input', async () => {
    await expect(assertSafeUrl('')).rejects.toThrow(/empty/i)
  })

  it('rejects malformed URLs', async () => {
    await expect(assertSafeUrl('http://[::badtoken')).rejects.toThrow(/malformed/i)
  })
})

describe('assertSafeUrl — IP literals', () => {
  it('rejects 127.0.0.1 (loopback)', async () => {
    await expect(assertSafeUrl('http://127.0.0.1/')).rejects.toThrow(/private IP/i)
  })

  it('rejects 10.x (RFC 1918)', async () => {
    await expect(assertSafeUrl('http://10.0.0.5/')).rejects.toThrow(/private IP/i)
  })

  it('rejects 192.168.x (RFC 1918)', async () => {
    await expect(assertSafeUrl('http://192.168.1.1/')).rejects.toThrow(/private IP/i)
  })

  it('rejects 169.254.169.254 (AWS / GCP metadata)', async () => {
    await expect(assertSafeUrl('http://169.254.169.254/latest/meta-data/'))
      .rejects.toThrow(/private IP/i)
  })

  it('rejects ::1 (IPv6 loopback)', async () => {
    await expect(assertSafeUrl('http://[::1]/')).rejects.toThrow(/private IP/i)
  })

  it('rejects fc00::/7 ULA', async () => {
    await expect(assertSafeUrl('http://[fc00::1]/')).rejects.toThrow(/private IP/i)
  })

  it('rejects fe80::/10 link-local', async () => {
    await expect(assertSafeUrl('http://[fe80::1]/')).rejects.toThrow(/private IP/i)
  })

  it('allows public IPv4 literal', async () => {
    await expect(assertSafeUrl('http://8.8.8.8/')).resolves.toBeUndefined()
  })

  it('allows public IPv6 literal', async () => {
    await expect(assertSafeUrl('http://[2001:4860:4860::8888]/')).resolves.toBeUndefined()
  })
})

describe('assertSafeUrl — DNS resolution', () => {
  it('allows hostnames that resolve to a public IP', async () => {
    lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
    await expect(assertSafeUrl('https://example.com/')).resolves.toBeUndefined()
    expect(lookup).toHaveBeenCalledWith('example.com', { all: true })
  })

  it('rejects when ANY resolved IP is private (rebinding-shaped)', async () => {
    lookup.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 } // attacker-controlled record
    ])
    await expect(assertSafeUrl('https://attacker.example/'))
      .rejects.toThrow(/private IP/i)
  })

  it('rejects on DNS failure', async () => {
    lookup.mockRejectedValueOnce(new Error('ENOTFOUND'))
    await expect(assertSafeUrl('https://no-such-host.invalid/'))
      .rejects.toThrow(/could not be resolved/i)
  })

  it('rejects on empty DNS result', async () => {
    lookup.mockResolvedValueOnce([])
    await expect(assertSafeUrl('https://no-records.example/'))
      .rejects.toThrow(/no DNS records/i)
  })

  it('rejects internal service names that resolve to private IPs (e.g. compose dns)', async () => {
    lookup.mockResolvedValueOnce([{ address: '172.18.0.5', family: 4 }])
    await expect(assertSafeUrl('http://postgres:5432/'))
      .rejects.toThrow(/private IP/i)
  })

  it('rejects IPv4-mapped IPv6 lookup of a private v4', async () => {
    lookup.mockResolvedValueOnce([{ address: '::ffff:10.0.0.1', family: 6 }])
    await expect(assertSafeUrl('https://sneaky.example/'))
      .rejects.toThrow(/private IP/i)
  })
})
