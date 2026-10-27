import { TEST_BASE_URL } from './env'

// Thin fetch wrapper with a cookie jar. Tests use this instead of raw
// `fetch` so sessions established via /api/_test/login are reused on
// subsequent calls in the same test — exactly how a browser would.

export interface ClientOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  // Some endpoints (token, files) return 302/redirects or JWT-carrying
  // responses. Follow redirects = false lets tests inspect the Location
  // header directly.
  redirect?: RequestRedirect
}

export class TestClient {
  private cookies: string[] = []

  /**
   * `baseUrl` defaults to the primary (billing-on) test server; pass
   * `TEST_BILLING_OFF_BASE_URL` to talk to the billing-off instance.
   */
  constructor(private readonly baseUrl: string = TEST_BASE_URL) {}

  /** Pre-seed a cookie (e.g. after out-of-band session creation). */
  setCookie(cookie: string): void {
    this.cookies.push(cookie)
  }

  cookieHeader(): string {
    // Browsers join with '; '. Duplicate cookie names: last wins.
    const seen = new Map<string, string>()
    for (const raw of this.cookies) {
      const [pair] = raw.split(';')
      const eq = pair.indexOf('=')
      if (eq < 0) continue
      seen.set(pair.slice(0, eq), pair.slice(eq + 1))
    }
    return [...seen.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  async request(path: string, opts: ClientOptions = {}): Promise<Response> {
    const headers: Record<string, string> = {
      ...opts.headers
    }
    const cookieHeader = this.cookieHeader()
    if (cookieHeader) headers.cookie = cookieHeader

    let body: string | undefined
    if (opts.body !== undefined) {
      body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
      if (!headers['content-type']) headers['content-type'] = 'application/json'
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body,
      redirect: opts.redirect ?? 'manual'
    })

    // Absorb any Set-Cookie values. undici exposes setCookie() on headers
    // (single header with multiple values), so we use getSetCookie() when
    // available.
    const setCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.()
      ?? res.headers.get('set-cookie')?.split(/,(?=[^;]+?=)/)
    if (setCookie) {
      for (const raw of setCookie) {
        this.cookies.push(raw.trim())
      }
    }

    return res
  }

  get(path: string, opts: Omit<ClientOptions, 'method' | 'body'> = {}): Promise<Response> {
    return this.request(path, { ...opts, method: 'GET' })
  }

  post(path: string, body?: unknown, opts: Omit<ClientOptions, 'method' | 'body'> = {}): Promise<Response> {
    return this.request(path, { ...opts, method: 'POST', body })
  }

  put(path: string, body?: unknown, opts: Omit<ClientOptions, 'method' | 'body'> = {}): Promise<Response> {
    return this.request(path, { ...opts, method: 'PUT', body })
  }

  patch(path: string, body?: unknown, opts: Omit<ClientOptions, 'method' | 'body'> = {}): Promise<Response> {
    return this.request(path, { ...opts, method: 'PATCH', body })
  }

  delete(path: string, opts: Omit<ClientOptions, 'method' | 'body'> = {}): Promise<Response> {
    return this.request(path, { ...opts, method: 'DELETE' })
  }
}

/**
 * Build an already-logged-in client for the given test user. Uses the
 * `/api/_test/login` shim (TEST_MODE=1 only) to seal a session cookie
 * and pre-seeds it on the client.
 */
export async function loggedInClient(userId: number, name?: string, baseUrl: string = TEST_BASE_URL): Promise<TestClient> {
  const c = new TestClient(baseUrl)
  const res = await c.post('/api/_test/login', { userId, name: name ?? `User ${userId}` })
  if (!res.ok) {
    throw new Error(`[loggedInClient] /api/_test/login returned ${res.status}: ${await res.text()}`)
  }
  return c
}

/**
 * Like `loggedInClient`, but the sealed session records a sign-in at
 * `loggedInAt` (epoch ms). Used to exercise the recent-sign-in
 * requirement on sensitive actions (account deletion, export, BYOK).
 */
export async function loggedInClientSignedInAt(userId: number, loggedInAt: number): Promise<TestClient> {
  const c = new TestClient(TEST_BASE_URL)
  const res = await c.post('/api/_test/login', { userId, name: `User ${userId}`, loggedInAt })
  if (!res.ok) {
    throw new Error(`[loggedInClientSignedInAt] /api/_test/login returned ${res.status}: ${await res.text()}`)
  }
  return c
}

export function anonClient(baseUrl: string = TEST_BASE_URL): TestClient {
  return new TestClient(baseUrl)
}
