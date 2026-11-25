import { describe, expect, it, vi } from 'vitest'
import { isProduction, nodeEnv } from '../../../shared/env/runtime'

// Vitest runs unbundled, so the "built" NODE_ENV is the live one ('test'
// unless a test stubs it). The bundled behaviour is covered by
// tests/unit/platform/cliBundles.test.ts.

describe('nodeEnv / isProduction', () => {
  it('reads NODE_ENV of the given environment', () => {
    expect(nodeEnv({ NODE_ENV: 'development' })).toBe('development')
    expect(nodeEnv({})).toBeUndefined()
    expect(isProduction({ NODE_ENV: 'production' })).toBe(true)
    expect(isProduction({ NODE_ENV: 'development' })).toBe(false)
    expect(isProduction({})).toBe(false)
  })

  it('defaults to the process environment', () => {
    expect(nodeEnv()).toBe('test')
    expect(isProduction()).toBe(false)
    vi.stubEnv('NODE_ENV', 'production')
    expect(nodeEnv()).toBe('production')
    expect(isProduction()).toBe(true)
  })

  it('stays production when the code was built for production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    // A production build whose process runs without NODE_ENV (a test stack
    // starting `.output` directly) keeps the production behaviour.
    expect(isProduction({})).toBe(true)
    expect(nodeEnv({ NODE_ENV: 'development' })).toBe('production')
  })
})
