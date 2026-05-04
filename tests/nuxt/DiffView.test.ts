// @vitest-environment nuxt
import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { CollabDiffView as DiffView } from '#components'

// Component test for the unified-diff renderer. Drives the
// drawer-side rendering — kind classes, hunk headers, line numbering,
// truncation banner, and the empty-hunks placeholder.
//
// Why nuxt project: DiffView uses `useI18n()` for two strings
// (the empty/truncation banner). nuxt-test-utils auto-resolves
// auto-imports under `mountSuspended`, so we don't need to mock.

const sampleHunk = {
  oldStart: 7,
  oldLines: 3,
  newStart: 7,
  newLines: 4,
  lines: [
    { kind: 'context' as const, text: 'context line' },
    { kind: 'remove' as const, text: 'old line' },
    { kind: 'add' as const, text: 'new line' },
    { kind: 'context' as const, text: 'tail context' }
  ]
}

describe('DiffView.vue', () => {
  it('renders the empty placeholder when there are no hunks', async () => {
    const wrapper = await mountSuspended(DiffView, { props: { hunks: [] } })
    // i18n key resolves to "No textual change."
    expect(wrapper.text()).toContain('No textual change')
  })

  it('renders the hunk header in @@ git format', async () => {
    const wrapper = await mountSuspended(DiffView, { props: { hunks: [sampleHunk] } })
    expect(wrapper.text()).toContain('@@ -7,3 +7,4 @@')
  })

  it('renders one row per line with kind-specific bg classes', async () => {
    const wrapper = await mountSuspended(DiffView, { props: { hunks: [sampleHunk] } })
    const html = wrapper.html()
    // Add → green tint, remove → red tint. Pin the class strings
    // because they ARE the visual contract.
    expect(html).toContain('bg-green-500/10')
    expect(html).toContain('bg-red-500/10')
  })

  it('renders the truncation banner when truncated=true', async () => {
    const wrapper = await mountSuspended(DiffView, {
      props: { hunks: [sampleHunk], truncated: true, totalHunks: 250 }
    })
    expect(wrapper.text()).toContain('Showing 1 of 250 hunks')
  })

  it('does NOT render the truncation banner when truncated=false', async () => {
    const wrapper = await mountSuspended(DiffView, {
      props: { hunks: [sampleHunk], truncated: false, totalHunks: 1 }
    })
    expect(wrapper.text()).not.toContain('Showing')
    expect(wrapper.text()).not.toContain('truncated')
  })

  it('renders + and − markers in the gutter for add/remove rows', async () => {
    const wrapper = await mountSuspended(DiffView, { props: { hunks: [sampleHunk] } })
    const html = wrapper.html()
    // The marker column shows + for adds and − (Unicode minus, not
    // hyphen) for removes. Pin the actual character so a casual
    // refactor doesn't swap it for a hyphen.
    expect(html).toContain('+')
    expect(html).toContain('−')
  })

  it('renders the new-file line numbers for context + add lines', async () => {
    // newStart=7, so context line at index 0 → 7, remove at index 1
    // doesn't bump n (gets `−`), add at index 2 → 8, context at
    // index 3 → 9.
    const wrapper = await mountSuspended(DiffView, { props: { hunks: [sampleHunk] } })
    const html = wrapper.html()
    expect(html).toContain('>7<') // context line — opens at newStart
    expect(html).toContain('>8<') // first non-remove after the seven
    expect(html).toContain('>9<') // tail context line
  })

  it('handles a hunk with all-add lines (full-section insert)', async () => {
    const allAdd = {
      oldStart: 1, oldLines: 0, newStart: 1, newLines: 3,
      lines: [
        { kind: 'add' as const, text: 'first new' },
        { kind: 'add' as const, text: 'second new' },
        { kind: 'add' as const, text: 'third new' }
      ]
    }
    const wrapper = await mountSuspended(DiffView, { props: { hunks: [allAdd] } })
    const html = wrapper.html()
    expect(html).toContain('first new')
    expect(html).toContain('second new')
    expect(html).toContain('third new')
    // No remove row — no red tint.
    expect(html).not.toContain('bg-red-500/10')
  })

  it('renders multiple hunks in order', async () => {
    const second = { ...sampleHunk, oldStart: 50, newStart: 50, lines: [
      { kind: 'add' as const, text: 'second hunk addition' }
    ] }
    const wrapper = await mountSuspended(DiffView, { props: { hunks: [sampleHunk, second] } })
    const text = wrapper.text()
    // Order is preserved: first hunk's @@ line precedes the second.
    const firstAt = text.indexOf('@@ -7,3 +7,4 @@')
    const secondAt = text.indexOf('@@ -50,3 +50,4 @@')
    expect(firstAt).toBeGreaterThan(-1)
    expect(secondAt).toBeGreaterThan(firstAt)
  })

  it('preserves leading whitespace in line text (indentation matters)', async () => {
    // Indented markdown / code blocks must round-trip through the
    // renderer without leading-space collapse.
    const indented = {
      oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
      lines: [
        { kind: 'remove' as const, text: '  - item' },
        { kind: 'add' as const, text: '    - item' }
      ]
    }
    const wrapper = await mountSuspended(DiffView, { props: { hunks: [indented] } })
    const html = wrapper.html()
    expect(html).toContain('  - item')
    expect(html).toContain('    - item')
  })
})
