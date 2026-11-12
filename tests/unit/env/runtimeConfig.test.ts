import { describe, expect, it, vi } from 'vitest'
import { registeredVars } from '../../../shared/env/registry'

// runtimeConfig keeps only what Nuxt modules and the browser read
// (session + oauth for nuxt-auth-utils, `public`). Nuxt fills each key
// from NUXT_<PATH> at runtime, so every such name must be a registered
// app variable: otherwise boot validation and the reference miss it.

vi.stubGlobal('defineNuxtConfig', (config: unknown) => config)
// Imported through a variable so the tests' type-check doesn't pull in
// nuxt.config.ts (it needs Nuxt's generated types).
const CONFIG_PATH = '../../../nuxt.config'
const { default: config } = await import(/* @vite-ignore */ CONFIG_PATH) as { default: { runtimeConfig: Record<string, unknown> } }

function envNames(node: Record<string, unknown>, path: string[] = []): string[] {
  return Object.entries(node).flatMap(([key, value]) => {
    const next = [...path, key]
    if (value && typeof value === 'object') return envNames(value as Record<string, unknown>, next)
    return [`NUXT_${next.map(p => p.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()).join('_')}`]
  })
}

// Fixed in code, never set through the environment.
const NOT_ENV = /^NUXT_SESSION_(MAX_AGE|COOKIE_)/

describe('runtimeConfig ↔ registry', () => {
  it('every key Nuxt fills from the environment is a registered app variable', () => {
    const app = new Map(registeredVars().filter(v => v.spec.services.includes('app')).map(v => [v.spec.name, v.spec]))
    const names = envNames(config.runtimeConfig).filter(n => !NOT_ENV.test(n))
    expect(names).toContain('NUXT_SESSION_PASSWORD')
    expect(names).toContain('NUXT_PUBLIC_SYNC_URL')
    expect(names.filter(n => !app.has(n))).toEqual([])
  })
})
