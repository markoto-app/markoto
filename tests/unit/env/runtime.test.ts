import { describe, expect, it, vi } from 'vitest'
import { isProduction, nodeEnv } from '../../../shared/env/runtime'
import { EnvError, runtimeEnv } from '../../../shared/env/load'

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

describe('runtimeEnv: a bad value read before boot validation', () => {
  // Outside Vitest the runtime read goes through the per-process cache and
  // the early-read report; VITEST='' takes that path. Nothing is cached:
  // every call below throws.
  it('throws the full report outside production', () => {
    vi.stubEnv('VITEST', '')
    vi.stubEnv('LOG_LEVEL', 'nope')
    expect(() => runtimeEnv('app')).toThrow(EnvError)
  })

  it('prints the report and exits in production', () => {
    vi.stubEnv('VITEST', '')
    vi.stubEnv('LOG_LEVEL', 'nope')
    vi.stubEnv('NODE_ENV', 'production')
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`)
    }) as typeof process.exit)
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => runtimeEnv('app')).toThrow('exit 1')
      expect(printed.mock.calls[0]?.[0]).toContain('LOG_LEVEL')
    } finally {
      exit.mockRestore()
      printed.mockRestore()
    }
  })
})
