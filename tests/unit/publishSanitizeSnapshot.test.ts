import { describe, expect, it } from 'vitest'
import { sanitizeSnapshotHtml } from '../../server/utils/publish/sanitizeSnapshot'

// The stored HTML of a published page is cleaned again on the server: a
// bypass of the print page's DOMPurify must not leave anything active in
// the snapshot that the page's no-script CSP doesn't already stop.

describe('sanitizeSnapshotHtml', () => {
  it('drops redirects, base URLs, scripts, frames, embeds and forms with their content', () => {
    const out = sanitizeSnapshotHtml([
      '<p>before</p>',
      '<meta http-equiv="refresh" content="0;url=https://evil.example/">',
      '<base href="https://evil.example/">',
      '<script>alert(1)</script>',
      '<iframe src="https://evil.example/"></iframe>',
      '<object data="x.swf"><embed src="x.swf"></object>',
      '<form action="https://evil.example/"><input name="pw"><button>Go</button></form>',
      '<link rel="stylesheet" href="https://evil.example/x.css">',
      '<p>after</p>'
    ].join(''))
    expect(out).toBe('<p>before</p><p>after</p>')
  })

  it('finds them nested, in SVG, in templates and in any letter case', () => {
    const out = sanitizeSnapshotHtml('<div><section><META HTTP-EQUIV="refresh" content="0;url=x"></section></div><svg><script>alert(1)</script><circle r="1"></circle></svg><template><script>alert(2)</script><b>t</b></template>')
    expect(out).not.toMatch(/<meta|<script/i)
    expect(out).toContain('<circle r="1"></circle>')
    expect(out).toContain('<b>t</b>')
  })

  it('removes event-handler and navigation attributes, keeps the rest', () => {
    const out = sanitizeSnapshotHtml('<img src="/api/published/p/files/a.png" alt="A" onerror="alert(1)" ONLOAD="x()"><a href="#s" ping="https://evil.example/">s</a><button formaction="https://evil.example/">b</button>')
    expect(out).toBe('<img src="/api/published/p/files/a.png" alt="A"><a href="#s">s</a><button>b</button>')
  })

  it('leaves ordinary rendered markdown as it is', () => {
    const html = '<div class="paged-doc"><h1 id="t">Title</h1><p>Text with <code>code</code> &amp; <em>emphasis</em>.</p><table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table><svg viewBox="0 0 1 1"><style>.a{fill:red}</style><path d="M0 0"></path></svg></div>'
    expect(sanitizeSnapshotHtml(html)).toBe(html)
  })
})
