import { solveChallenge, type Challenge } from 'altcha-lib'
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2'

// API calls use the runtime's global `fetch`, NOT Playwright's `request`
// fixture. Under Bun, the `request` fixture throws while parsing the
// response's Set-Cookie header against the URL ("cannot be parsed as a URL")
// even though the HTTP call itself succeeds, a Playwright-under-Bun quirk.
// Global fetch with an absolute URL sidesteps it entirely and is all the
// smoke suite needs (stateless, anonymous). Page navigations still use the
// `page` fixture with the config's baseURL.
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'https://staging.markoto.app'

function api(path: string): string {
  return new URL(path, BASE_URL).toString()
}

/**
 * Staging's edge login (Traefik basic auth in front of the app host), from
 * EDGE_BASIC_AUTH_USER / EDGE_BASIC_AUTH_PASSWORD. Null when unset: prod
 * and local stacks have no login.
 */
export function edgeCredentials(): { username: string, password: string } | null {
  const username = process.env.EDGE_BASIC_AUTH_USER ?? ''
  const password = process.env.EDGE_BASIC_AUTH_PASSWORD ?? ''
  return username && password ? { username, password } : null
}

const MAX_REDIRECTS = 5

/**
 * `fetch` against the target deployment with its edge login. Redirects are
 * followed by hand so the login only goes to the deployment's own origin,
 * never to the presigned S3 URL a download redirects to (S3 refuses a
 * request that carries a second authorization).
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const creds = edgeCredentials()
  const origin = new URL(BASE_URL).origin
  let url = api(path)
  let request = init
  for (let hop = 0; ; hop++) {
    const headers = new Headers(request.headers)
    if (creds && new URL(url).origin === origin) {
      headers.set('authorization', `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`)
    }
    const res = await fetch(url, { ...request, headers, redirect: 'manual' })
    const location = res.headers.get('location')
    if (res.status < 300 || res.status >= 400 || !location || hop >= MAX_REDIRECTS) return res
    url = new URL(location, url).toString()
    // Like a browser: 307/308 repeat the request, the others turn it into a GET.
    if (res.status !== 307 && res.status !== 308) request = { ...request, method: 'GET', body: undefined }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isChallenge(value: unknown): value is Challenge {
  return isRecord(value) && isRecord(value.parameters)
}

/**
 * Pass the anonymous gate like a browser does: fetch the server's ALTCHA
 * challenge and solve it (real production difficulty, about a second),
 * plus the terms acceptance. Empty when the instance has no gate. Plain
 * errors (no `expect`): this also runs in the global setup.
 */
async function anonGateFields(): Promise<Record<string, unknown>> {
  const res = await apiFetch('/api/anon-gate/challenge?purpose=doc-create')
  if (res.status !== 200) throw new Error(`GET /api/anon-gate/challenge → ${res.status}`)
  const json: unknown = await res.json()
  const challenge = isRecord(json) ? json.challenge : null
  if (!isChallenge(challenge)) return {}
  const solution = await solveChallenge({ challenge, deriveKey })
  if (!solution) throw new Error('ALTCHA challenge did not solve')
  const altcha = Buffer.from(JSON.stringify({ challenge, solution: { counter: solution.counter, derivedKey: solution.derivedKey } })).toString('base64')
  return { altcha, acceptTerms: true }
}

/**
 * Create an anonymous document via the public API and return its id,
 * passing the anonymous gate (bot check + terms) exactly like the browser.
 * Optional body carries new-doc-dialog fields (templateId / language / …).
 *
 * Anonymous creation is limited to 10/hour per network on the hosted
 * service and the smoke run comes from ONE runner address, so specs never
 * call this: `globalSetup.ts` creates the run's documents once and specs
 * read them with `smokeDoc()`. A retried spec reuses the same document,
 * retry the action, not the creation.
 */
export async function createAnonDoc(body: Record<string, unknown> = {}): Promise<string> {
  const res = await apiFetch('/api/docs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, ...(await anonGateFields()) })
  })
  const text = await res.text()
  if (res.status >= 300) throw new Error(`POST /api/docs → ${res.status}: ${text.slice(0, 200)}`)
  const json: unknown = JSON.parse(text)
  const docId = isRecord(json) ? json.docId : null
  if (typeof docId !== 'string' || !docId) throw new Error('no docId in the create response')
  return docId
}

/**
 * The run's shared anonymous documents, created once by globalSetup.ts:
 *   - `demo`: a Demo-template document (markdown tour incl. a mermaid
 *                  diagram), shared by every spec that just needs "an
 *                  anonymous doc with content" (editor + preview, PDF, mobile).
 *   - `template`: created with the business-plan template; the template
 *                  spec needs its own because the template is chosen at
 *                  creation.
 * Two anonymous creations per run, whatever the retries.
 */
export type SmokeDoc = 'demo' | 'template'

export const SMOKE_DOCS_ENV = 'SMOKE_ANON_DOCS'

export const DEMO_DOC_BODY: Record<string, unknown> = Object.freeze({ templateId: 'demo', language: 'en' })
export const TEMPLATE_DOC_BODY: Record<string, unknown> = Object.freeze({ templateId: 'business-plan', language: 'en' })

export function smokeDoc(kind: SmokeDoc): string {
  const raw = process.env[SMOKE_DOCS_ENV]
  if (!raw) throw new Error(`${SMOKE_DOCS_ENV} is not set, run the smoke suite through tests/smoke/playwright.config.ts (it has the global setup)`)
  const parsed: unknown = JSON.parse(raw)
  const id = isRecord(parsed) ? parsed[kind] : null
  if (typeof id !== 'string') throw new Error(`no shared smoke document "${kind}"`)
  return id
}
