import { describe, it, expect } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { createEvent, useSession, type H3Event } from 'h3'
import {
  DEFAULT_SESSION_COOKIE,
  dropUnusedSessionCookie,
  isUnusedSession,
  requestHasCookie,
  withoutCookie
} from '../../../server/utils/auth/sessionCookie'

// Visitors who never signed in get no `nuxt-session` cookie (privacy
// policy §9: "Set only when you sign in"). h3's useSession creates and
// sends one on any read of a cookieless request; the beforeResponse
// plugin (server/plugins/session-cookie.ts) strips that header again.
// These tests drive the real h3 session code.

const CONFIG = { name: DEFAULT_SESSION_COOKIE, password: 'x'.repeat(40) }

function eventWith(cookie?: string): H3Event {
  const req = new IncomingMessage(new Socket())
  req.method = 'GET'
  req.url = '/_nuxt/entry.css'
  if (cookie) req.headers.cookie = cookie
  return createEvent(req, new ServerResponse(req))
}

function setCookies(event: H3Event): string[] {
  const value = event.node.res.getHeader('set-cookie')
  if (value === undefined) return []
  return Array.isArray(value) ? value : [String(value)]
}

describe('dropUnusedSessionCookie (real h3 sessions)', () => {
  it('sets no cookie at all on the pages host or a custom domain', async () => {
    for (const kind of ['pages', 'custom-domain'] as const) {
      // A stale cookie sent to such a host: h3 answers it with a fresh one.
      const event = eventWith('nuxt-session=stale')
      event.context.publicPageHost = kind
      event.node.res.setHeader('set-cookie', ['ypad_locale=de; Path=/', 'markoto-anon=x; Path=/'])
      await useSession(event, CONFIG)
      dropUnusedSessionCookie(event)
      expect(setCookies(event), kind).toEqual([])
    }
  })

  it('strips the cookie a mere read creates on a cookieless request', async () => {
    const event = eventWith()
    await useSession(event, CONFIG)
    expect(setCookies(event).some(c => c.startsWith('nuxt-session='))).toBe(true)
    dropUnusedSessionCookie(event)
    expect(setCookies(event)).toEqual([])
  })

  it('keeps other cookies on the same response', async () => {
    const event = eventWith()
    event.node.res.setHeader('set-cookie', ['ypad_locale=de; Path=/'])
    await useSession(event, CONFIG)
    dropUnusedSessionCookie(event)
    expect(setCookies(event)).toEqual(['ypad_locale=de; Path=/'])
  })

  it('keeps the cookie of a sign-in (data written)', async () => {
    const event = eventWith()
    const session = await useSession(event, CONFIG)
    await session.update({ user: { id: 1 } })
    dropUnusedSessionCookie(event)
    expect(setCookies(event).some(c => c.startsWith('nuxt-session='))).toBe(true)
  })

  it('keeps a signed-in browser\'s session intact (no new cookie on a read, nothing removed)', async () => {
    const signIn = eventWith()
    const session = await useSession(signIn, CONFIG)
    await session.update({ user: { id: 7 } })
    const sealed = setCookies(signIn).find(c => c.startsWith('nuxt-session='))?.split(';')[0] ?? ''
    expect(sealed).not.toBe('')

    const later = eventWith(sealed)
    const read = await useSession(later, CONFIG)
    expect(read.data).toEqual({ user: { id: 7 } })
    dropUnusedSessionCookie(later)
    expect(setCookies(later)).toEqual([])
  })

  it('leaves the cookie of a request that sent one (sign-out, stale-cookie replacement)', async () => {
    const event = eventWith('nuxt-session=garbage')
    await useSession(event, CONFIG)
    dropUnusedSessionCookie(event)
    expect(setCookies(event).some(c => c.startsWith('nuxt-session='))).toBe(true)
  })

  it('does nothing when no session was touched', () => {
    const event = eventWith()
    event.node.res.setHeader('set-cookie', ['other=1'])
    dropUnusedSessionCookie(event)
    expect(setCookies(event)).toEqual(['other=1'])
  })
})

describe('pure helpers', () => {
  it('requestHasCookie', () => {
    expect(requestHasCookie('a=1; nuxt-session=x', 'nuxt-session')).toBe(true)
    expect(requestHasCookie('nuxt-session-other=x', 'nuxt-session')).toBe(false)
    expect(requestHasCookie(undefined, 'nuxt-session')).toBe(false)
  })
  it('withoutCookie', () => {
    expect(withoutCookie(['nuxt-session=a; Path=/', 'b=1'], 'nuxt-session')).toEqual(['b=1'])
  })
  it('isUnusedSession', () => {
    expect(isUnusedSession({ requestHadCookie: false, sessionData: {} })).toBe(true)
    expect(isUnusedSession({ requestHadCookie: false, sessionData: { user: 1 } })).toBe(false)
    expect(isUnusedSession({ requestHadCookie: true, sessionData: {} })).toBe(false)
  })
})
