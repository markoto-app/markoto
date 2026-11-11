import { describe, it, expect } from 'vitest'
import { safeFetch, type PinnedFetch, type PinnedRequestInit } from '../../../server/utils/platform/safeFetch'
import { fetchExternalImage } from '../../../server/utils/storage/externalImage'

// Outbound fetch for URLs the model / a page / a document controls
// (`view_image`). Regression cases for the redirect + DNS-rebinding gap:
// the old code checked the first URL once and then let `fetch` follow
// redirects and resolve the host again on its own.

interface Call { url: string, init: PinnedRequestInit }

/** Fake network: URL (as dialled, i.e. with the IP) → response factory. */
function fakeNet(routes: Record<string, () => Response>): { fetchImpl: PinnedFetch, calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: PinnedFetch = async (url, init) => {
    calls.push({ url, init })
    const route = routes[url]
    if (!route) throw new Error(`unexpected dial ${url}`)
    return route()
  }
  return { fetchImpl, calls }
}

function dns(map: Record<string, string[]>): (host: string) => Promise<string[]> {
  return async (host) => {
    const hit = map[host]
    if (!hit) throw new Error(`ENOTFOUND ${host}`)
    return hit
  }
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const png = () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
const redirect = (location: string, status = 302) => () => new Response(null, { status, headers: { location } })

const IMAGE_LIMITS = { allowedTypes: new Set(['image/png']), maxBytes: 1024 }

describe('safeFetch — pinned connection', () => {
  it('dials the checked IP with the original Host header and TLS server name', async () => {
    const net = fakeNet({ 'https://93.184.216.34/a.png': png })
    const { response } = await safeFetch('https://img.example.com/a.png', {
      resolve: dns({ 'img.example.com': ['93.184.216.34'] }),
      fetchImpl: net.fetchImpl
    })
    expect(response.status).toBe(200)
    expect(net.calls).toHaveLength(1)
    const [call] = net.calls
    expect(call?.init.headers).toMatchObject({ Host: 'img.example.com' })
    expect(call?.init.tls).toEqual({ serverName: 'img.example.com' })
    expect(call?.init.redirect).toBe('manual')
    expect(call?.init.proxy).toBe(false)
  })

  it('keeps a non-default port in the Host header and brackets IPv6 addresses', async () => {
    const net = fakeNet({ 'http://[2606:4700::1111]:8080/x.png': png })
    await safeFetch('http://img.example.com:8080/x.png', {
      resolve: dns({ 'img.example.com': ['2606:4700::1111'] }),
      fetchImpl: net.fetchImpl
    })
    expect(net.calls[0]?.init.headers).toMatchObject({ Host: 'img.example.com:8080' })
    expect(net.calls[0]?.init.tls).toBeUndefined()
  })

  it('regression: a host whose DNS answer is private is never dialled', async () => {
    const net = fakeNet({})
    await expect(safeFetch('https://rebind.example.com/a.png', {
      resolve: dns({ 'rebind.example.com': ['127.0.0.1'] }),
      fetchImpl: net.fetchImpl
    })).rejects.toThrow(/private IP/i)
    expect(net.calls).toHaveLength(0)
  })

  it('regression: the address that was checked is the address that is dialled (one resolution per hop)', async () => {
    // A rebinding DNS server answers public first, then loopback. The
    // old code checked the first answer and let fetch resolve again.
    const answers = [['93.184.216.34'], ['127.0.0.1']]
    let lookups = 0
    const flipping = async () => answers[Math.min(lookups++, 1)] ?? []
    const net = fakeNet({ 'https://93.184.216.34/a.png': png })
    await safeFetch('https://rebind.example.com/a.png', { resolve: flipping, fetchImpl: net.fetchImpl })
    expect(lookups).toBe(1)
    expect(net.calls.map(c => c.url)).toEqual(['https://93.184.216.34/a.png'])
  })
})

describe('safeFetch — redirects', () => {
  const resolve = dns({
    'cdn.example.com': ['93.184.216.34'],
    'img.example.com': ['93.184.216.35'],
    'internal.example.com': ['10.0.0.5']
  })

  it('follows a redirect to another public host, re-resolving and pinning it', async () => {
    const net = fakeNet({
      'https://93.184.216.34/a.png': redirect('https://img.example.com/b.png'),
      'https://93.184.216.35/b.png': png
    })
    const { response, url } = await safeFetch('https://cdn.example.com/a.png', { resolve, fetchImpl: net.fetchImpl })
    expect(response.status).toBe(200)
    expect(url).toBe('https://img.example.com/b.png')
    expect(net.calls[1]?.init.headers).toMatchObject({ Host: 'img.example.com' })
  })

  it('resolves a relative Location against the hostname, not the dialled IP', async () => {
    const net = fakeNet({
      'https://93.184.216.34/a.png': redirect('/b.png', 301),
      'https://93.184.216.34/b.png': png
    })
    const { url } = await safeFetch('https://cdn.example.com/a.png', { resolve, fetchImpl: net.fetchImpl })
    expect(url).toBe('https://cdn.example.com/b.png')
    expect(net.calls[1]?.init.headers).toMatchObject({ Host: 'cdn.example.com' })
  })

  it.each([
    ['loopback literal', 'http://127.0.0.1:3000/api/health'],
    ['metadata literal', 'http://169.254.169.254/latest/meta-data/'],
    ['IPv4-mapped loopback', 'http://[::ffff:7f00:1]/'],
    ['name resolving to a private address', 'http://internal.example.com/'],
    ['compose service name', 'http://litellm:4000/']
  ])('regression: refuses a redirect to %s before dialling it', async (_label, target) => {
    const net = fakeNet({ 'https://93.184.216.34/a.png': redirect(target, 307) })
    await expect(safeFetch('https://cdn.example.com/a.png', { resolve, fetchImpl: net.fetchImpl })).rejects.toThrow(/refused/i)
    expect(net.calls).toHaveLength(1)
  })

  it('refuses a redirect to a non-http scheme', async () => {
    const net = fakeNet({ 'https://93.184.216.34/a.png': redirect('file:///etc/passwd') })
    await expect(safeFetch('https://cdn.example.com/a.png', { resolve, fetchImpl: net.fetchImpl })).rejects.toThrow(/scheme/i)
  })

  it('caps the number of hops', async () => {
    const net = fakeNet({ 'https://93.184.216.34/loop.png': redirect('https://cdn.example.com/loop.png') })
    await expect(safeFetch('https://cdn.example.com/loop.png', { resolve, fetchImpl: net.fetchImpl, maxRedirects: 3 }))
      .rejects.toThrow(/too many redirects/i)
    expect(net.calls).toHaveLength(4)
  })
})

describe('fetchExternalImage', () => {
  const resolve = dns({ 'img.example.com': ['93.184.216.34'] })

  it('returns the bytes of an allowed image', async () => {
    const net = fakeNet({ 'https://93.184.216.34/a.png': png })
    const result = await fetchExternalImage('https://img.example.com/a.png', IMAGE_LIMITS, { resolve, fetchImpl: net.fetchImpl })
    expect(result).toEqual({ bytes: PNG, mimeType: 'image/png' })
  })

  it('regression: a redirect to an internal address yields an error, not a fetch', async () => {
    const net = fakeNet({ 'https://93.184.216.34/a.png': redirect('http://127.0.0.1:4000/health') })
    const result = await fetchExternalImage('https://img.example.com/a.png', IMAGE_LIMITS, { resolve, fetchImpl: net.fetchImpl })
    expect(result).toMatchObject({ error: expect.stringMatching(/URL refused/) })
    expect(net.calls).toHaveLength(1)
  })

  it('caps the body even when Content-Length is missing', async () => {
    const big = () => new Response(new ReadableStream({
      start(controller) {
        for (let i = 0; i < 4; i++) controller.enqueue(new Uint8Array(512))
        controller.close()
      }
    }), { status: 200, headers: { 'content-type': 'image/png' } })
    const net = fakeNet({ 'https://93.184.216.34/big.png': big })
    const result = await fetchExternalImage('https://img.example.com/big.png', IMAGE_LIMITS, { resolve, fetchImpl: net.fetchImpl })
    expect(result).toMatchObject({ error: expect.stringMatching(/exceeded/) })
  })

  it('refuses a disallowed content type', async () => {
    const html = () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })
    const net = fakeNet({ 'https://93.184.216.34/a': html })
    const result = await fetchExternalImage('https://img.example.com/a', IMAGE_LIMITS, { resolve, fetchImpl: net.fetchImpl })
    expect(result).toMatchObject({ error: expect.stringMatching(/content-type "text\/html"/) })
  })
})
