import { describe, expect, it } from 'vitest'
import { checkAccessibility } from '../../../app/utils/editor/accessibilityCheck'

describe('checkAccessibility', () => {
  it('finds nothing in a well-formed document', () => {
    const md = '# Title\n\n## Part\n\n### Detail\n\n![A chart](/a.png)\n\nSee [the docs](https://x.test).\n\n## Next\n\n# Another\n'
    expect(checkAccessibility(md)).toEqual([])
  })

  it('flags images without alt text with the offsets of the image', () => {
    const md = 'Intro\n\n![](/a.png) and ![   ](/b.png){width=50%}\n'
    const issues = checkAccessibility(md)
    expect(issues.map(i => [i.kind, i.line])).toEqual([['image-alt', 3], ['image-alt', 3]])
    const first = issues[0]!
    expect(md.slice(first.from, first.to)).toBe('![](')
  })

  it('flags skipped heading levels but not a first heading below h1 or a step back up', () => {
    const md = '## Start\n\n#### Too deep\n\n## Back\n\n### Fine\n\n# Top\n\n### Skip again\n'
    const issues = checkAccessibility(md)
    expect(issues).toEqual([
      expect.objectContaining({ kind: 'heading-skip', line: 3, level: 4, previousLevel: 2 }),
      expect.objectContaining({ kind: 'heading-skip', line: 11, level: 3, previousLevel: 1 })
    ])
    const skip = issues[0]!
    expect(md.slice(skip.from, skip.to)).toBe('#### Too deep')
  })

  it('flags links with empty or whitespace-only text', () => {
    const md = '[](https://a.test) text [ ](https://b.test) and [ok](https://c.test)\n'
    const issues = checkAccessibility(md)
    expect(issues.map(i => i.kind)).toEqual(['empty-link', 'empty-link'])
    expect(md.slice(issues[0]!.from, issues[0]!.to)).toBe('[](')
    expect(md.slice(issues[1]!.from, issues[1]!.to)).toBe('[ ](')
  })

  it('ignores code fences, inline code and comments', () => {
    const md = [
      '```md',
      '# Title',
      '#### skipped in code',
      '![](/a.png)',
      '```',
      'Inline `![](/b.png)` and `[](x)` code.',
      '<!-- hint: ![](/c.png) -->',
      '<!--',
      '#### inside a comment',
      '[](https://d.test)',
      '-->',
      '~~~~',
      '[](y)',
      '~~~~'
    ].join('\n')
    expect(checkAccessibility(md)).toEqual([])
  })

  it('does not mistake an image or an escaped bracket for an empty link', () => {
    expect(checkAccessibility('![chart](/a.png) \\[](x)\n')).toEqual([])
  })

  it('reports the line of each issue', () => {
    const md = 'a\nb\n\n![](/a.png)\n'
    expect(checkAccessibility(md)[0]?.line).toBe(4)
  })
})
