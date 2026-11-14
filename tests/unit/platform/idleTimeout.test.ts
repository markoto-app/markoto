import { describe, it, expect } from 'vitest'
import { DEFAULT_IDLE_TIMEOUT_SECONDS } from '../../../server/runtime/idleTimeout'
import { RENDER_DEADLINE_MS } from '../../../server/utils/rendering/renderClient'
import { MARKITDOWN_IMPORT_TIMEOUT_MS } from '../../../server/config/markitdown'

// Bun drops a connection that stays silent for the idle timeout, even while
// its handler is still working: the client gets an empty reply instead of an
// error. Every slow route must give up (and answer) before that happens.

describe('app server idle timeout', () => {
  it('outlasts the PDF render deadline, so a slow render answers 504', () => {
    expect(DEFAULT_IDLE_TIMEOUT_SECONDS * 1000).toBeGreaterThan(RENDER_DEADLINE_MS + 5_000)
  })

  it('outlasts the import conversion timeout', () => {
    expect(DEFAULT_IDLE_TIMEOUT_SECONDS * 1000).toBeGreaterThan(MARKITDOWN_IMPORT_TIMEOUT_MS + 5_000)
  })

  it('stays within what Bun accepts', () => {
    expect(DEFAULT_IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(255)
  })
})
