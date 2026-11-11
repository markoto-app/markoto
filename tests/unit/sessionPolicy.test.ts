import { describe, it, expect } from 'vitest'
import {
  RECENT_LOGIN_MAX_AGE_MS,
  isRecentLogin,
  sessionEpochMatches,
  sessionEpochOf
} from '../../server/utils/auth/sessionPolicy'

// Revocable sessions: the epoch sealed into the cookie must equal the
// user's current `session_epoch`; sensitive actions need a recent
// sign-in (`loggedInAt`).

describe('sessionEpochOf / sessionEpochMatches', () => {
  it('treats a missing or malformed epoch as 0 (cookies sealed before the column existed)', () => {
    expect(sessionEpochOf(undefined)).toBe(0)
    expect(sessionEpochOf('3')).toBe(0)
    expect(sessionEpochOf(1.5)).toBe(0)
    expect(sessionEpochOf(4)).toBe(4)
  })

  it('accepts a cookie only while its epoch is the current one', () => {
    expect(sessionEpochMatches(undefined, 0)).toBe(true)
    expect(sessionEpochMatches(2, 2)).toBe(true)
    // After "log out everywhere" bumps the column, older cookies fail.
    expect(sessionEpochMatches(undefined, 1)).toBe(false)
    expect(sessionEpochMatches(2, 3)).toBe(false)
  })
})

describe('isRecentLogin', () => {
  const now = 1_800_000_000_000

  it('accepts a sign-in within the window', () => {
    expect(isRecentLogin(now - 60_000, now)).toBe(true)
    expect(isRecentLogin(now - RECENT_LOGIN_MAX_AGE_MS, now)).toBe(true)
  })

  it('rejects an older sign-in', () => {
    expect(isRecentLogin(now - RECENT_LOGIN_MAX_AGE_MS - 1, now)).toBe(false)
  })

  it('fails closed on a missing, malformed or far-future value', () => {
    expect(isRecentLogin(undefined, now)).toBe(false)
    expect(isRecentLogin('yesterday', now)).toBe(false)
    expect(isRecentLogin(Number.NaN, now)).toBe(false)
    expect(isRecentLogin(now + 10 * 60_000, now)).toBe(false)
  })

  it('tolerates small clock skew', () => {
    expect(isRecentLogin(now + 30_000, now)).toBe(true)
  })

  it('uses a 12-hour default window', () => {
    expect(RECENT_LOGIN_MAX_AGE_MS).toBe(12 * 60 * 60 * 1000)
  })
})
