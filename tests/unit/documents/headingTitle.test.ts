import { describe, it, expect, vi, afterEach } from 'vitest'
import * as Y from 'yjs'
import { firstH1, followHeadingTitle } from '../../../shared/utils/markdown/markdownTitle'
import { createHeadingTitleSync } from '../../../app/utils/collab/headingTitle'

describe('firstH1', () => {
  it('finds the first level-1 heading outside code fences', () => {
    expect(firstH1('# Hello world\n\ntext')).toBe('Hello world')
    expect(firstH1('intro\n\n## Sub\n\n# Main title ##\n')).toBe('Main title')
    expect(firstH1('```\n# not a title\n```\n# Real')).toBe('Real')
    expect(firstH1('# **Bold** and `code`')).toBe('Bold and code')
    expect(firstH1('#NoSpace\n#\n')).toBe('')
    expect(firstH1('no heading at all')).toBe('')
    expect(firstH1(`# ${'x'.repeat(300)}`)).toHaveLength(255)
  })
})

describe('followHeadingTitle', () => {
  it('follows the heading while the title is a default or the previous heading', () => {
    expect(followHeadingTitle('Untitled', '', 'Plan')).toBe('Plan')
    expect(followHeadingTitle('Unbenannt', '', 'Plan')).toBe('Plan')
    expect(followHeadingTitle('', '', 'Plan')).toBe('Plan')
    expect(followHeadingTitle('Plan', 'Plan', 'Plan v2')).toBe('Plan v2')
  })

  it('keeps a title set by hand, and does nothing without a heading or a change', () => {
    expect(followHeadingTitle('My report', 'Plan', 'Plan v2')).toBeNull()
    expect(followHeadingTitle('Untitled', 'Plan', '')).toBeNull()
    expect(followHeadingTitle('Plan', 'Plan', 'Plan')).toBeNull()
    // A title that only happens to equal an empty previous heading is not "automatic".
    expect(followHeadingTitle('Notes', '', 'Plan')).toBeNull()
  })
})

describe('createHeadingTitleSync', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function setup(initialTitle: string, opts: { canWrite?: boolean } = {}) {
    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('content')
    let title = initialTitle
    const setTitle = vi.fn((t: string) => {
      title = t
    })
    const sync = createHeadingTitleSync({
      ytext,
      getTitle: () => title,
      setTitle,
      canWrite: () => opts.canWrite ?? true,
      debounceMs: 100
    })
    return { ydoc, ytext, sync, setTitle, title: () => title }
  }

  it('titles an untitled document from its heading on start, then follows edits to it', () => {
    vi.useFakeTimers()
    const s = setup('Untitled')
    s.ytext.insert(0, '# Trip notes\n\nday one')
    // Nothing before the first sync.
    vi.advanceTimersByTime(500)
    expect(s.setTitle).not.toHaveBeenCalled()
    s.sync.start()
    expect(s.title()).toBe('Trip notes')
    s.ytext.insert(12, ' 2027')
    expect(s.title()).toBe('Trip notes')
    vi.advanceTimersByTime(100)
    expect(s.title()).toBe('Trip notes 2027')
    s.sync.stop()
  })

  it('stops following once the title was changed by hand', () => {
    vi.useFakeTimers()
    const s = setup('Untitled')
    s.ytext.insert(0, '# Draft\n')
    s.sync.start()
    expect(s.title()).toBe('Draft')
    s.setTitle('Final report')
    s.ytext.insert(7, ' two')
    vi.advanceTimersByTime(100)
    expect(s.title()).toBe('Final report')
  })

  it('ignores remote changes and never writes on a read-only connection', () => {
    vi.useFakeTimers()
    const remote = setup('Untitled')
    remote.sync.start()
    const other = new Y.Doc()
    other.getText('content').insert(0, '# From someone else\n')
    Y.applyUpdate(remote.ydoc, Y.encodeStateAsUpdate(other))
    vi.advanceTimersByTime(200)
    expect(remote.setTitle).not.toHaveBeenCalled()

    const readOnly = setup('Untitled', { canWrite: false })
    readOnly.ytext.insert(0, '# Heading\n')
    readOnly.sync.start()
    expect(readOnly.setTitle).not.toHaveBeenCalled()
  })
})
