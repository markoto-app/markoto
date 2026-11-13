import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { beforeEach, describe, expect, it } from 'vitest'
import { stubEnv } from '../../helpers/env'
import { createEvent } from 'h3'
import {
  classifyInternalRoute,
  normalizeInternalPath,
  rejectIfFromEdge,
  requireInternalSecret
} from '../../../server/utils/platform/internalRoutes'

// Which app routes only other containers may call, and the gates the auth
// middleware applies to them (server/middleware/auth.ts).

const CURRENT = 'current-secret-current-secret-0123456789'
const PREVIOUS = 'previous-secret-previous-secret-012345678'
beforeEach(() => {
  stubEnv({ NUXT_INTERNAL_API_SECRET: CURRENT, NUXT_INTERNAL_API_SECRET_PREVIOUS: PREVIOUS })
})

function eventWith(headers: Record<string, string>) {
  const req = new IncomingMessage(new Socket())
  for (const [k, v] of Object.entries(headers)) req.headers[k] = v
  return createEvent(req, new ServerResponse(req))
}

function statusOf(fn: () => void): number | null {
  try {
    fn()
    return null
  } catch (e) {
    return (e as { statusCode?: number }).statusCode ?? -1
  }
}

describe('classifyInternalRoute', () => {
  it('classifies the sync → app routes, existing or not', () => {
    expect(classifyInternalRoute('/api/internal/activity', 'POST')).toBe('internal-api')
    expect(classifyInternalRoute('/api/internal/comments-snapshot', 'POST')).toBe('internal-api')
    expect(classifyInternalRoute('/api/internal/some-future-route', 'GET')).toBe('internal-api')
    expect(classifyInternalRoute('/api/internal', 'POST')).toBe('internal-api')
  })

  it('treats other spellings of the prefix the same way', () => {
    expect(classifyInternalRoute('/API/Internal/activity', 'POST')).toBe('internal-api')
    expect(classifyInternalRoute('/api//internal/activity', 'POST')).toBe('internal-api')
    expect(classifyInternalRoute('/api/%69nternal/activity', 'POST')).toBe('internal-api')
  })

  it('singles out the Traefik provider poll (GET / HEAD only)', () => {
    expect(classifyInternalRoute('/api/internal/traefik/custom-domains', 'GET')).toBe('traefik-provider')
    expect(classifyInternalRoute('/api/internal/traefik/custom-domains', 'HEAD')).toBe('traefik-provider')
    expect(classifyInternalRoute('/api/internal/traefik/custom-domains', 'POST')).toBe('internal-api')
  })

  it('classifies the renderer print page and its bootstrap', () => {
    expect(classifyInternalRoute('/_internal/render/doc-1', 'GET')).toBe('render')
    expect(classifyInternalRoute('/api/_internal/render-bootstrap', 'GET')).toBe('render')
  })

  it('leaves public routes alone, including the public /api/_internal reads', () => {
    for (const path of ['/', '/api/health', '/api/_internal/legal/privacy', '/api/_internal/docs-search', '/api/internals', '/d/abc']) {
      expect(classifyInternalRoute(path, 'GET')).toBeNull()
    }
  })

  it('normalizes without throwing on malformed escapes', () => {
    expect(normalizeInternalPath('/api/%E0%A4%A/x')).toBe('/api/%e0%a4%a/x')
  })
})

describe('rejectIfFromEdge', () => {
  it('404s a request carrying the edge proxy headers', () => {
    expect(statusOf(() => rejectIfFromEdge(eventWith({ 'x-forwarded-host': 'markoto.app', 'x-real-ip': '203.0.113.7' })))).toBe(404)
  })

  it('lets a direct call through', () => {
    expect(statusOf(() => rejectIfFromEdge(eventWith({ 'x-forwarded-for': '127.0.0.1' })))).toBeNull()
  })
})

describe('requireInternalSecret', () => {
  it('accepts the current and the previous secret', () => {
    expect(statusOf(() => requireInternalSecret(eventWith({ 'x-internal-secret': CURRENT })))).toBeNull()
    expect(statusOf(() => requireInternalSecret(eventWith({ 'x-internal-secret': PREVIOUS })))).toBeNull()
  })

  it('401s a missing or wrong secret', () => {
    expect(statusOf(() => requireInternalSecret(eventWith({})))).toBe(401)
    expect(statusOf(() => requireInternalSecret(eventWith({ 'x-internal-secret': 'wrong' })))).toBe(401)
  })

  it('500s when the app has no secret configured', () => {
    stubEnv({ NUXT_INTERNAL_API_SECRET: undefined })
    expect(statusOf(() => requireInternalSecret(eventWith({ 'x-internal-secret': PREVIOUS })))).toBe(500)
  })
})
