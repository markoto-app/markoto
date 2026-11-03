import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ANON_DOC_CREATE_LIMITS } from '../../shared/config/anonLimits'

// The staging/prod smoke suite runs from one runner address, and hosted
// anonymous creation is limited per network (shared/config/anonLimits.ts).
// Pin: specs never create anonymous documents themselves (a retry would
// create another one); the global setup creates at most 3 per run.

const SMOKE_DIR = resolve(__dirname, '../smoke')

describe('smoke suite anonymous-creation budget', () => {
  it('specs reuse the shared documents and never create their own', () => {
    const specs = readdirSync(SMOKE_DIR).filter(f => f.endsWith('.spec.ts'))
    expect(specs.length).toBeGreaterThan(0)
    for (const file of specs) {
      const src = readFileSync(resolve(SMOKE_DIR, file), 'utf8')
      expect(src, file).not.toMatch(/createAnonDoc\s*\(/)
      expect(src, file).not.toMatch(/['"`]\/api\/docs['"`]/)
    }
  })

  it('the global setup creates at most 3 anonymous documents per run', () => {
    const setup = readFileSync(resolve(SMOKE_DIR, 'globalSetup.ts'), 'utf8')
    const creations = setup.match(/createAnonDoc\s*\(/g) ?? []
    expect(creations.length).toBeLessThanOrEqual(3)
    expect(creations.length).toBeLessThan(ANON_DOC_CREATE_LIMITS[0]?.max ?? 0)
    const config = readFileSync(resolve(__dirname, '../../playwright.smoke.config.ts'), 'utf8')
    expect(config).toContain('globalSetup: \'./tests/smoke/globalSetup.ts\'')
  })
})
