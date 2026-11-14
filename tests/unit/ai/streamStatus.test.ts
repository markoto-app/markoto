import { describe, it, expect, vi } from 'vitest'
import {
  describeToolInput,
  processChunk,
  newStreamState,
  type StreamStatusPhase
} from '../../../server/utils/agentic/streamStatus'
import { at, first } from '../../helpers/assert'
import type { AiStatusInput } from '../../../shared/ai/statusSteps'

/** The English text of a tool's status line (null when the tool has none). */
function textOf(name: string, args: Record<string, unknown>): string | null {
  return describeToolInput(name, args)?.text ?? null
}

// Status-line derivation + per-turn dedupe for the agentic loop.
// Pure: no yjs, no network, no LLM. Each tool branch gets pinned so
// changes to the user-facing "Reading the document…" / "Editing …" etc.
// phrasing are explicit edits rather than accidents.

describe('describeToolInput: web_search', () => {
  it('includes the trimmed query in quotes', () => {
    expect(textOf('web_search', { query: 'mistral pricing' }))
      .toBe('Searching the web for "mistral pricing"')
  })

  it('falls back to a generic message when query is empty / whitespace', () => {
    expect(textOf('web_search', { query: '' })).toBe('Searching the web…')
    expect(textOf('web_search', { query: '   ' })).toBe('Searching the web…')
  })

  it('falls back when query is missing or non-string', () => {
    expect(textOf('web_search', {})).toBe('Searching the web…')
    expect(textOf('web_search', { query: 42 })).toBe('Searching the web…')
  })
})

describe('describeToolInput: view_document', () => {
  it('is a constant string regardless of args', () => {
    expect(textOf('view_document', {})).toBe('Reading the document…')
    expect(textOf('view_document', { view_range: [1, 10] })).toBe('Reading the document…')
  })
})

describe('describeToolInput: replace_text', () => {
  it('quotes a short old_str verbatim', () => {
    expect(textOf('replace_text', { old_str: 'foo', new_str: 'bar' }))
      .toBe('Editing "foo"')
  })

  it('collapses internal whitespace in the preview', () => {
    expect(textOf('replace_text', { old_str: 'foo\n\tbar   baz', new_str: 'x' }))
      .toBe('Editing "foo bar baz"')
  })

  it('truncates to 40 chars with an ellipsis', () => {
    const forty = 'a'.repeat(40)
    const long = 'a'.repeat(50)
    expect(textOf('replace_text', { old_str: long, new_str: '' }))
      .toBe(`Editing "${forty}…"`)
  })

  it('does NOT append ellipsis at exactly 40 chars', () => {
    const forty = 'a'.repeat(40)
    expect(textOf('replace_text', { old_str: forty, new_str: '' }))
      .toBe(`Editing "${forty}"`)
  })

  it('falls back to a generic message when old_str is missing or empty', () => {
    expect(textOf('replace_text', { new_str: 'x' })).toBe('Editing the document…')
    expect(textOf('replace_text', { old_str: '', new_str: 'x' })).toBe('Editing the document…')
  })
})

describe('describeToolInput: insert_text', () => {
  it('is a constant string', () => {
    expect(textOf('insert_text', { insert_line: 0, insert_text: 'hi' }))
      .toBe('Inserting text…')
  })
})

describe('describeToolInput: update_theme', () => {
  it('returns generic "Updating theme…" when args has no nested sections', () => {
    expect(textOf('update_theme', {})).toBe('Updating theme…')
  })

  it('prefers a named base source over the section-count fallback', () => {
    // preset / theme_id / from_workspace_default are user-meaningful
    // base sources: surface them in the live status instead of
    // generic "Updating theme…".
    expect(textOf('update_theme', { preset: 'modern' }))
      .toBe('Applying preset "modern"…')
    expect(textOf('update_theme', { theme_id: 'abc12345' }))
      .toBe('Applying a saved theme…')
    expect(textOf('update_theme', { from_workspace_default: true }))
      .toBe('Applying workspace default theme…')
  })

  it('lists sections when 1–2 are changed', () => {
    expect(textOf('update_theme', { body: { size: 12 } }))
      .toBe('Updating theme (body)…')
    expect(textOf('update_theme', { body: { size: 12 }, headings: { weight: '700' } }))
      .toBe('Updating theme (body, headings)…')
  })

  it('collapses to a count when 3+ sections are changed', () => {
    // Regression target: spamming a long "Updating theme (body, headings,
    // color, layout, footer, …)…" string would wrap the awareness
    // indicator. Pin the 3+ summary format.
    expect(textOf('update_theme', {
      body: { size: 12 },
      headings: { weight: '700' },
      color: { brand: '#000' }
    })).toBe('Updating theme (3 sections)…')
  })

  it('ignores empty nested objects', () => {
    // An AI call that passes `{ body: {} }` isn't "changing body".
    // filter requires Object.keys(v).length > 0, pin it.
    expect(textOf('update_theme', { body: {} })).toBe('Updating theme…')
  })
})

describe('describeToolInput: get_theme / list_themes / save_theme_as_preset', () => {
  it('get_theme uses a fixed read label', () => {
    expect(textOf('get_theme', {})).toBe('Reading current theme…')
  })

  it('list_themes uses a fixed list label', () => {
    expect(textOf('list_themes', {})).toBe('Listing your saved themes…')
  })

  it('save_theme_as_preset shows the trimmed name', () => {
    expect(textOf('save_theme_as_preset', { name: 'Brand red' }))
      .toBe('Saving theme as "Brand red"')
  })

  it('save_theme_as_preset truncates names >40 chars', () => {
    const forty = 'x'.repeat(40)
    expect(textOf('save_theme_as_preset', { name: 'x'.repeat(80) }))
      .toBe(`Saving theme as "${forty}…"`)
  })

  it('save_theme_as_preset falls back when name is empty', () => {
    expect(textOf('save_theme_as_preset', { name: '' }))
      .toBe('Saving theme as preset…')
    expect(textOf('save_theme_as_preset', { name: '   ' }))
      .toBe('Saving theme as preset…')
  })
})

describe('describeToolInput: list_workspace_documents / view_other_document', () => {
  it('list_workspace_documents uses a fixed browse label', () => {
    expect(textOf('list_workspace_documents', {}))
      .toBe('Browsing workspace documents…')
  })

  it('view_other_document extracts the id from a URL', () => {
    expect(textOf('view_other_document', { doc_id: 'https://markoto.app/d/xyz123abc' }))
      .toBe('Reading document xyz123abc')
  })

  it('view_other_document falls through to the bare id when no URL', () => {
    expect(textOf('view_other_document', { doc_id: 'abc987' }))
      .toBe('Reading document abc987')
  })

  it('view_other_document truncates very long ids', () => {
    const long = 'x'.repeat(40)
    expect(textOf('view_other_document', { doc_id: long }))
      .toBe(`Reading document ${'x'.repeat(24)}…`)
  })

  it('view_other_document falls back when doc_id is empty', () => {
    expect(textOf('view_other_document', { doc_id: '' }))
      .toBe('Reading another document…')
  })
})

describe('describeToolInput: set_title', () => {
  it('shows the trimmed title in quotes', () => {
    expect(textOf('set_title', { title: 'Project Brief' }))
      .toBe('Setting title to "Project Brief"')
  })

  it('truncates titles longer than 40 chars', () => {
    const forty = 'x'.repeat(40)
    expect(textOf('set_title', { title: 'x'.repeat(100) }))
      .toBe(`Setting title to "${forty}…"`)
  })

  it('falls back when title is empty / whitespace', () => {
    expect(textOf('set_title', { title: '' })).toBe('Updating title…')
    expect(textOf('set_title', { title: '   ' })).toBe('Updating title…')
  })
})

describe('describeToolInput: view_image', () => {
  it('shows the path leaf for internal /api/files/... refs', () => {
    expect(textOf('view_image', { src: '/api/files/docABC/img12.png' }))
      .toBe('Looking at "img12.png"')
  })

  it('shows the last segment of external URLs', () => {
    expect(textOf('view_image', { src: 'https://example.com/path/to/photo.jpg' }))
      .toBe('Looking at "photo.jpg"')
  })

  it('falls back to the whole src when there is no "/" to split on', () => {
    expect(textOf('view_image', { src: 'standalone' }))
      .toBe('Looking at "standalone"')
  })

  it('truncates long leaf names', () => {
    const forty = 'a'.repeat(40)
    const src = 'https://example.com/' + 'a'.repeat(60) + '.png'
    // The leaf is 60 "a"s + ".png", well over 40 chars.
    expect(textOf('view_image', { src })).toBe(`Looking at "${forty}…"`)
  })

  it('falls back when src is empty / missing', () => {
    expect(textOf('view_image', { src: '' })).toBe('Looking at an image…')
    expect(textOf('view_image', {})).toBe('Looking at an image…')
  })
})

describe('describeToolInput: generate_image', () => {
  it('shows the prompt in quotes', () => {
    expect(textOf('generate_image', { prompt: 'a handshake', alt: 'h' }))
      .toBe('Generating image: "a handshake"')
  })

  it('truncates prompts longer than 50 chars (not 40, this tool gets a wider budget)', () => {
    // Regression target: generate_image uses 50 as its preview limit
    // (prompts are usually more descriptive than replace_text's old_str).
    const fifty = 'a'.repeat(50)
    expect(textOf('generate_image', { prompt: 'a'.repeat(100), alt: 'h' }))
      .toBe(`Generating image: "${fifty}…"`)
  })

  it('falls back when prompt is empty / whitespace', () => {
    expect(textOf('generate_image', { prompt: '', alt: 'h' }))
      .toBe('Generating image…')
    expect(textOf('generate_image', { prompt: '   ', alt: 'h' }))
      .toBe('Generating image…')
  })
})

describe('describeToolInput: fetch_url', () => {
  it('strips http/https scheme and trailing slash', () => {
    expect(textOf('fetch_url', { url: 'https://example.com/' }))
      .toBe('Fetching example.com')
    expect(textOf('fetch_url', { url: 'http://example.com/page' }))
      .toBe('Fetching example.com/page')
  })

  it('preserves bare hostnames (no scheme to strip)', () => {
    expect(textOf('fetch_url', { url: 'example.com' }))
      .toBe('Fetching example.com')
  })

  it('is case-insensitive on the scheme prefix', () => {
    expect(textOf('fetch_url', { url: 'HTTPS://example.com' }))
      .toBe('Fetching example.com')
  })

  it('truncates display at 50 chars', () => {
    const fifty = 'a'.repeat(50)
    expect(textOf('fetch_url', { url: 'https://' + 'a'.repeat(60) + '.com' }))
      .toBe(`Fetching ${fifty}…`)
  })

  it('falls back to generic message when url is empty', () => {
    expect(textOf('fetch_url', { url: '' })).toBe('Fetching URL…')
  })
})

describe('describeToolInput: unknown names', () => {
  it('returns null so the loop leaves the previous status in place', () => {
    // Critical: unknown tool names must NOT yield a generic "Running
    // …" message: that would flash a confusing status when the
    // model emits a tool name we don't recognize. The loop fires an
    // "unsupported tool" error response back to the model; status
    // stays as whatever it was.
    expect(textOf('not_a_tool', {})).toBeNull()
    expect(textOf('', {})).toBeNull()
  })
})

describe('processChunk: dedupe + state machine', () => {
  it('emits setStatus("tool", …) for each new call', () => {
    const setStatus = vi.fn<(phase: StreamStatusPhase, status?: AiStatusInput) => void>()
    const state = newStreamState()
    processChunk({ functionCalls: [{ name: 'view_document', args: {} }] }, state, { setStatus })
    expect(setStatus).toHaveBeenCalledWith('tool', { text: 'Reading the document…', step: { key: 'readDocument' } })
  })

  it('dedupes repeated chunks for the same (name, args) pair', () => {
    // The provider can re-emit a functionCall across multiple chunks
    // as args fill in. Once we've announced it, further repetitions
    // of the same (name + fingerprint) must be silent.
    const setStatus = vi.fn<(phase: StreamStatusPhase, status?: AiStatusInput) => void>()
    const state = newStreamState()
    const call = { name: 'view_document', args: {} }
    processChunk({ functionCalls: [call] }, state, { setStatus })
    processChunk({ functionCalls: [call] }, state, { setStatus })
    processChunk({ functionCalls: [call] }, state, { setStatus })
    expect(setStatus).toHaveBeenCalledTimes(1)
  })

  it('announces separately when args differ, different replace_text calls', () => {
    const setStatus = vi.fn<(phase: StreamStatusPhase, status?: AiStatusInput) => void>()
    const state = newStreamState()
    processChunk({ functionCalls: [{ name: 'replace_text', args: { old_str: 'a', new_str: 'A' } }] }, state, { setStatus })
    processChunk({ functionCalls: [{ name: 'replace_text', args: { old_str: 'b', new_str: 'B' } }] }, state, { setStatus })
    expect(setStatus).toHaveBeenCalledTimes(2)
    expect(first(setStatus.mock.calls)[1]).toEqual({ text: 'Editing "a"', step: { key: 'editPassage', params: { passage: 'a' } } })
    expect(at(setStatus.mock.calls, 1)[1]).toEqual({ text: 'Editing "b"', step: { key: 'editPassage', params: { passage: 'b' } } })
  })

  it('text-only chunks never trigger setStatus', () => {
    const setStatus = vi.fn<(phase: StreamStatusPhase, status?: AiStatusInput) => void>()
    const state = newStreamState()
    processChunk({ text: 'Hello there' }, state, { setStatus })
    processChunk({}, state, { setStatus })
    expect(setStatus).not.toHaveBeenCalled()
  })

  it('does NOT setStatus when describeToolInput returns null (unknown tool)', () => {
    // Regression target: announced tracks the call identity so we
    // don't re-process, but `setStatus` must only fire on a
    // non-null message.
    const setStatus = vi.fn<(phase: StreamStatusPhase, status?: AiStatusInput) => void>()
    const state = newStreamState()
    processChunk({ functionCalls: [{ name: 'ghost_tool', args: {} }] }, state, { setStatus })
    expect(setStatus).not.toHaveBeenCalled()
  })

  it('skips calls with no name (defensive)', () => {
    const setStatus = vi.fn<(phase: StreamStatusPhase, status?: AiStatusInput) => void>()
    const state = newStreamState()
    // Malformed call shape: library consumers could produce this.
    processChunk({ functionCalls: [{ args: {} }] }, state, { setStatus })
    expect(setStatus).not.toHaveBeenCalled()
  })

  it('processes multiple calls in one chunk independently', () => {
    const setStatus = vi.fn<(phase: StreamStatusPhase, status?: AiStatusInput) => void>()
    const state = newStreamState()
    processChunk({
      functionCalls: [
        { name: 'view_document', args: {} },
        { name: 'insert_text', args: { insert_line: 0, insert_text: 'hi' } }
      ]
    }, state, { setStatus })
    expect(setStatus).toHaveBeenCalledTimes(2)
  })

  it('each turn gets a fresh state (announced set)', () => {
    // Regression guard: if we accidentally shared state across turns,
    // the second turn's identical call would be silently suppressed.
    // State is per-turn by construction (newStreamState() inside the
    // loop), but pin the invariant that newStreamState() really is
    // fresh.
    const setStatus = vi.fn<(phase: StreamStatusPhase, status?: AiStatusInput) => void>()
    const call = { name: 'view_document', args: {} }
    const s1 = newStreamState()
    processChunk({ functionCalls: [call] }, s1, { setStatus })
    const s2 = newStreamState()
    processChunk({ functionCalls: [call] }, s2, { setStatus })
    expect(setStatus).toHaveBeenCalledTimes(2)
  })
})
