// @vitest-environment jsdom
//
// Rendering that markdown-it 15 / @mdit plugins 1-2 changed by default and
// we keep as it was (see renderMarkdown.ts).
import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '../../app/utils/markdown/renderMarkdown'

function parse(html: string): DocumentFragment {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  return tpl.content
}

describe('markdown-it 15 upgrade: unchanged output', () => {
  it('bare domains are still links', async () => {
    const root = parse(await renderMarkdown('See www.example.com and example.org.'))
    const hrefs = Array.from(root.querySelectorAll('a')).map(a => a.getAttribute('href'))
    expect(hrefs).toEqual(['http://www.example.com', 'http://example.org'])
  })

  it('an alert title is the kind, capitalised, whatever case the author typed', async () => {
    const root = parse(await renderMarkdown('> [!WARNING]\n> Careful.\n\n> [!tip]\n> Hint.'))
    const titles = Array.from(root.querySelectorAll('.markdown-alert-title')).map(t => t.textContent)
    expect(titles).toEqual(['Warning', 'Tip'])
  })

  it('image attributes stay on the image, not on the figure', async () => {
    const root = parse(await renderMarkdown('![alt](cat.jpg "caption"){.centered}'))
    expect(root.querySelector('figure')?.getAttribute('class')).toBeNull()
    expect(root.querySelector('figure img')?.getAttribute('class')).toBe('centered')
  })
})
