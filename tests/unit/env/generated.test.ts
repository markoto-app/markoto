import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadEnv } from '../../../shared/env/load'
import { registeredVars } from '../../../shared/env/registry'
import { nameFor, VALIDATED_SERVICES } from '../../../shared/env/define'
import { loadRendererEnv } from '../../../renderer/src/env.generated'
import { configurationJson, configurationReference, envExample, rendererEnvModule } from '../../../scripts/env-gen'
import { VALID_RENDERER_ENV } from './fixtures'

// Everything derived from the registry: the generated files are current
// (CI also runs `bun scripts/env-gen.ts --check`), and the renderer's
// generated loader parses exactly like loadEnv('renderer').

const ROOT = resolve(import.meta.dirname, '../../..')
const read = (file: string): string => readFileSync(resolve(ROOT, file), 'utf8')

describe('generated files are current', () => {
  it.each([
    ['.env.example', envExample],
    ['docs/reference/configuration.md', configurationReference],
    ['docs/reference/configuration.json', configurationJson],
    ['renderer/src/env.generated.ts', rendererEnvModule]
  ])('%s', (file, render) => {
    expect(read(file), 'run `bun scripts/env-gen.ts`').toBe(render())
  })
})

describe('renderer loader (generated) ↔ loadEnv(\'renderer\')', () => {
  it('parses the same values', () => {
    const source = { ...VALID_RENDERER_ENV, RENDERER_ALLOWED_ORIGINS: 'https://cdn.example.org, http://s3:8333', RENDERER_CHROMIUM_SANDBOX: 'off', S3_SSE: '' }
    expect(loadRendererEnv(source)).toEqual(JSON.parse(JSON.stringify(loadEnv('renderer', source))))
  })

  it('reports the same problems', () => {
    const source = { ...VALID_RENDERER_ENV, INTERNAL_API_SECRET: 'short', PORT: 'x', RENDERER_LOCALHOST_TARGET: 'http://host' }
    let shared = ''
    try {
      loadEnv('renderer', source)
    } catch (e) {
      shared = (e as Error).message
    }
    expect(shared).not.toBe('')
    expect(() => loadRendererEnv(source)).toThrow(shared)
  })
})

describe('registry shape', () => {
  it('a process reads each name once', () => {
    for (const service of VALIDATED_SERVICES) {
      const names = registeredVars().filter(v => v.spec.services.includes(service)).map(v => nameFor(v.spec, service))
      expect(names.filter((n, i) => names.indexOf(n) !== i), service).toEqual([])
    }
  })

  it('every variable is documented and a secret never has a printable default', () => {
    for (const { spec } of registeredVars()) {
      expect(spec.doc.length, spec.name).toBeGreaterThan(5)
      expect(!spec.secret || spec.default === undefined || spec.default === '', spec.name).toBe(true)
    }
  })
})
