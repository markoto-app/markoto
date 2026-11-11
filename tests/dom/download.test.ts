import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { downloadFile, downloadMarkdown } from '../../app/utils/platform/download'

// Test the browser-download utilities. These need a real DOM because:
//   - `new Blob(...)` + `URL.createObjectURL` round-trip through window.URL
//   - `document.createElement('a')` + `.click()` + DOM append/remove
// happy-dom provides all of this. We spy on URL.createObjectURL /
// revokeObjectURL and HTMLAnchorElement.prototype.click so we can observe
// call order + args without actually triggering the browser's download
// flow (which would try to navigate and error in the jsdom/happy-dom env).

interface Spies {
  createUrl: ReturnType<typeof vi.fn>
  revokeUrl: ReturnType<typeof vi.fn>
  click: ReturnType<typeof vi.fn>
  clickedAnchor: HTMLAnchorElement | null
  // Snapshot of the anchor state at the moment `click()` fires — without
  // this we'd see the post-removal state (no parent, blanked href) since
  // the util revokes + removes right after click.
  clickSnapshot: {
    href: string
    download: string
    parentIsDocumentBody: boolean
  } | null
}

let spies: Spies

beforeEach(() => {
  const createUrl = vi.fn((blob: Blob) => `blob:mock/${Math.random().toString(36).slice(2)}#type=${blob.type}`)
  const revokeUrl = vi.fn()
  const click = vi.fn(function (this: HTMLAnchorElement) {
    spies.clickedAnchor = this
    spies.clickSnapshot = {
      href: this.href,
      download: this.download,
      parentIsDocumentBody: this.parentElement === document.body
    }
  })

  // Swap in spies on the globals. happy-dom lets us redefine window.URL
  // methods directly.
  window.URL.createObjectURL = createUrl
  window.URL.revokeObjectURL = revokeUrl
  HTMLAnchorElement.prototype.click = click

  spies = {
    createUrl,
    revokeUrl,
    click,
    clickedAnchor: null,
    clickSnapshot: null
  }
})

afterEach(() => {
  // Not strictly necessary between tests (beforeEach reassigns), but keeps
  // the global namespace tidy if a test fails mid-flight.
  vi.restoreAllMocks()
})

// downloadFile: string content path

describe('downloadFile — string content', () => {
  it('wraps a string in a Blob with the given MIME type', async () => {
    downloadFile('hello world', 'note.txt', 'text/plain')
    expect(spies.createUrl).toHaveBeenCalledTimes(1)
    const blob = spies.createUrl.mock.calls[0]![0] as Blob
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('text/plain')
    expect(await blob.text()).toBe('hello world')
  })

  it('defaults MIME to text/plain when the arg is omitted', async () => {
    downloadFile('hello', 'note.txt')
    const blob = spies.createUrl.mock.calls[0]![0] as Blob
    expect(blob.type).toBe('text/plain')
  })

  it('preserves a non-default MIME type passed through', async () => {
    downloadFile('x', 'a.json', 'application/json')
    const blob = spies.createUrl.mock.calls[0]![0] as Blob
    expect(blob.type).toBe('application/json')
  })

  it('preserves an empty string as blob content', async () => {
    downloadFile('', 'empty.txt')
    const blob = spies.createUrl.mock.calls[0]![0] as Blob
    expect(await blob.text()).toBe('')
  })
})

// downloadFile: Blob content path

describe('downloadFile — Blob content', () => {
  it('passes a Blob through without rewrapping', () => {
    const blob = new Blob(['raw'], { type: 'application/octet-stream' })
    downloadFile(blob, 'raw.bin')
    // The blob reaching createObjectURL is THE SAME instance — no
    // defensive copy — so the caller's ownership model is preserved.
    expect(spies.createUrl).toHaveBeenCalledWith(blob)
  })

  it('ignores the mimeType argument when content is already a Blob', () => {
    // Blob carries its own `.type` — the overload should not rewrap just
    // to apply the passed-in MIME. A caller who already has a typed blob
    // is authoritative.
    const blob = new Blob(['x'], { type: 'image/png' })
    downloadFile(blob, 'pic.png', 'application/json')
    const passed = spies.createUrl.mock.calls[0]![0] as Blob
    expect(passed.type).toBe('image/png')
  })
})

// downloadFile: anchor lifecycle + cleanup ordering

describe('downloadFile — anchor lifecycle', () => {
  it('sets href to the object URL and download to the filename', () => {
    downloadFile('x', 'report.txt')
    expect(spies.clickSnapshot).not.toBeNull()
    // The anchor's href reflects the object URL our spy produced.
    expect(spies.clickSnapshot!.href).toMatch(/^blob:mock\//)
    expect(spies.clickSnapshot!.download).toBe('report.txt')
  })

  it('click fires WHILE the anchor is attached to document.body', () => {
    // Removing before click on some browsers causes the download not
    // to trigger. Pin the "attached at click time" invariant.
    downloadFile('x', 'a.txt')
    expect(spies.clickSnapshot?.parentIsDocumentBody).toBe(true)
  })

  it('anchor is removed from the DOM after the call returns', () => {
    downloadFile('x', 'a.txt')
    // The click snapshot shows it was attached during click; by the
    // time downloadFile returns, the anchor should be gone.
    expect(spies.clickedAnchor?.parentElement).toBe(null)
  })

  it('revokeObjectURL is called exactly once with the URL we created', () => {
    downloadFile('x', 'a.txt')
    expect(spies.revokeUrl).toHaveBeenCalledTimes(1)
    const createdUrl = spies.createUrl.mock.results[0]!.value as string
    expect(spies.revokeUrl).toHaveBeenCalledWith(createdUrl)
  })

  it('orders operations: createObjectURL → click → revokeObjectURL', () => {
    downloadFile('x', 'a.txt')
    const create = spies.createUrl.mock.invocationCallOrder[0]!
    const clicked = spies.click.mock.invocationCallOrder[0]!
    const revoked = spies.revokeUrl.mock.invocationCallOrder[0]!
    expect(create).toBeLessThan(clicked)
    expect(clicked).toBeLessThan(revoked)
  })

  it('does not leave residual <a download> elements in the body', () => {
    // Defensive: multiple downloads in a row shouldn't accumulate
    // orphaned anchors (would leak memory over a long session).
    downloadFile('one', 'a.txt')
    downloadFile('two', 'b.txt')
    downloadFile('three', 'c.txt')
    const leftovers = document.body.querySelectorAll('a[download]')
    expect(leftovers).toHaveLength(0)
  })
})

// downloadMarkdown: filename + MIME wiring

describe('downloadMarkdown', () => {
  it('appends .md to a clean title', () => {
    downloadMarkdown('# hi', 'My Note')
    expect(spies.clickSnapshot?.download).toBe('My Note.md')
  })

  it('uses text/markdown MIME for the Blob', () => {
    downloadMarkdown('# hi', 'x')
    const blob = spies.createUrl.mock.calls[0]![0] as Blob
    expect(blob.type).toBe('text/markdown')
  })

  it('sends the markdown content through verbatim', async () => {
    const md = '# Heading\n\n- one\n- two\n'
    downloadMarkdown(md, 'x')
    const blob = spies.createUrl.mock.calls[0]![0] as Blob
    expect(await blob.text()).toBe(md)
  })
})

// downloadMarkdown: sanitizeFilename (indirect coverage via title)
//
// Spec (from the regex):
// - Keep: [a-zA-Z0-9_\-. ] (alphanumeric, underscore, hyphen, dot, space). Any other char becomes '_'.
// - Trim leading/trailing whitespace AFTER substitution.
// - Empty result becomes 'document'.

describe('downloadMarkdown — filename sanitization', () => {
  function filenameFor(title: string): string {
    downloadMarkdown('x', title)
    return spies.clickSnapshot!.download
  }

  it('preserves alphanumerics + spaces + dots + hyphens + underscores', () => {
    expect(filenameFor('My Doc_v2-final.draft')).toBe('My Doc_v2-final.draft.md')
  })

  it('replaces slashes (path-separator injection)', () => {
    // Security-relevant: a title like "../etc/passwd" must never produce
    // a path-escaping filename on the user's disk.
    expect(filenameFor('a/b/c')).toBe('a_b_c.md')
    expect(filenameFor('..\\windows\\system32')).toBe('.._windows_system32.md')
  })

  it('replaces Windows-reserved shell characters', () => {
    // `<>:"|?*` — if the user syncs their downloads folder to OneDrive
    // these would otherwise produce save-dialog errors.
    expect(filenameFor('a<b>c:"d"|e?f*g')).toBe('a_b_c__d__e_f_g.md')
  })

  it('replaces unicode characters (non-ASCII letters, emoji)', () => {
    // BMP chars (single UTF-16 code unit) → one `_` each.
    expect(filenameFor('café')).toBe('caf_.md')
    expect(filenameFor('日本語')).toBe('___.md')
    // Astral-plane chars (🎉 is U+1F389, a surrogate pair in UTF-16) are
    // seen by the regex as TWO separate code units and mapped to TWO
    // underscores. Not a bug — the sanitizer works on code units, not
    // code points. Documented here so a future "fix" to String.iterator
    // semantics doesn't silently change filenames.
    expect(filenameFor('🎉 party')).toBe('__ party.md')
  })

  it('collapses each illegal char to a single underscore (no run compression)', () => {
    // The regex replaces per-character — consecutive illegal chars map
    // to consecutive underscores, NOT a single one. This is deliberate;
    // changing it would make "a??b" and "a?b" produce the same file.
    expect(filenameFor('a???b')).toBe('a___b.md')
  })

  it('trims leading and trailing whitespace AFTER substitution', () => {
    expect(filenameFor('   hello   ')).toBe('hello.md')
  })

  it('does NOT trim leading/trailing underscores (only whitespace)', () => {
    // `trim()` only removes whitespace. Leading/trailing underscores
    // produced by substitution survive — callers get the full mapped
    // filename rather than silent truncation.
    expect(filenameFor('!hello!')).toBe('_hello_.md')
  })

  it('falls back to "document" for an empty title', () => {
    expect(filenameFor('')).toBe('document.md')
  })

  it('falls back to "document" for a whitespace-only title', () => {
    // Whitespace is kept by the whitelist regex but stripped by trim —
    // the resulting empty string triggers the fallback.
    expect(filenameFor('   ')).toBe('document.md')
  })

  it('does NOT fall back when the title maps to all-underscores', () => {
    // `!@#` is not whitespace-only after sub (it becomes `___`), so it
    // survives trim and `'___' || 'document'` returns `'___'`.
    // Documents this quirk — if we ever want all-underscore to fall
    // back too, the regex needs a separate emptiness check.
    expect(filenameFor('!@#')).toBe('___.md')
  })

  it('handles a long title without truncation', () => {
    // No length cap in the util — long titles pass through. The OS
    // filesystem may still truncate on save, but that's its problem.
    const longTitle = 'x'.repeat(300)
    expect(filenameFor(longTitle)).toBe(`${longTitle}.md`)
  })
})
