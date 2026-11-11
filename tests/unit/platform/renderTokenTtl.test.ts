import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RENDER_TOKEN_TTL_SECONDS } from '../../../shared/contracts/jwt'

// The renderer image is built from `renderer/` alone, so it cannot import
// the shared contract; it keeps its own copy of the render-token lifetime.

describe('render token lifetime', () => {
  it('is the same in the renderer and in the shared contract', () => {
    const root = resolve(__dirname, '../../..')
    const source = readFileSync(resolve(root, 'renderer/src/render.ts'), 'utf8')
    const match = /^const TOKEN_TTL_SECONDS = (\d+)$/m.exec(source)
    expect(match).not.toBeNull()
    expect(Number(match?.[1])).toBe(RENDER_TOKEN_TTL_SECONDS)
  })
})
