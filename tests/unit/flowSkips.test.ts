import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROVIDER_OUTAGE_MARKER, readSkippedFlows, skippedFlowsMarkdown, skippedFlowsWarnings } from '../../scripts/lib/flowSkips'

describe('skippedFlowsMarkdown', () => {
  it('is empty when nothing was skipped', () => {
    expect(skippedFlowsMarkdown([])).toBe('')
  })

  it('lists each flow once with its variant count and reason', () => {
    const md = skippedFlowsMarkdown([
      { slug: 'ask-the-ai-to-draw-an-image', variant: 'en/dark-mobile', reason: 'BFL down' },
      { slug: 'ask-the-ai-to-draw-an-image', variant: 'en/light-desktop', reason: 'BFL down' },
      { slug: 'another-flow', variant: 'en/light-desktop', reason: 'X down' }
    ])
    expect(md).toContain('### Flows skipped: provider unavailable')
    expect(md).toContain('- `ask-the-ai-to-draw-an-image` (2 variants): BFL down')
    expect(md).toContain('- `another-flow` (1 variant): X down')
  })
})

describe('skippedFlowsWarnings', () => {
  it('is one GitHub warning annotation per flow, with escaped text', () => {
    expect(skippedFlowsWarnings([])).toEqual([])
    expect(skippedFlowsWarnings([
      { slug: 'generate-an-image-yourself', variant: 'en/light-desktop', reason: 'BFL down' },
      { slug: 'generate-an-image-yourself', variant: 'en/dark-mobile', reason: 'BFL down' },
      { slug: 'other', variant: 'en/light-desktop', reason: '100% down\nreally' }
    ])).toEqual([
      '::warning title=Flow skipped (provider unavailable)::generate-an-image-yourself (2 variants): BFL down',
      '::warning title=Flow skipped (provider unavailable)::other (1 variant): 100%25 down%0Areally'
    ])
  })
})

describe('readSkippedFlows', () => {
  it('finds marker files and ignores variants without one', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-skips-'))
    try {
      const skipped = path.join(root, 'draw', 'en', 'light-desktop')
      const normal = path.join(root, 'draw', 'en', 'dark-desktop')
      await fs.mkdir(skipped, { recursive: true })
      await fs.mkdir(normal, { recursive: true })
      await fs.writeFile(path.join(skipped, PROVIDER_OUTAGE_MARKER), 'BFL down\n')
      await fs.writeFile(path.join(normal, '.passed'), '')
      expect(await readSkippedFlows(root)).toEqual([{ slug: 'draw', variant: 'en/light-desktop', reason: 'BFL down' }])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('returns nothing for a missing directory', async () => {
    expect(await readSkippedFlows('/nonexistent/flows-dir')).toEqual([])
  })
})
