import { describe, it, expect } from 'vitest'
import { splitAnyFrontmatter } from '../../../shared/utils/markdown/markdownFrontmatter'

describe('splitAnyFrontmatter', () => {
  it('takes a site generator block off and returns its data', () => {
    const md = '---\ntitle: Work with long documents\ncategory: ai\norder: 4\n---\n\n# Work with long documents\n\nText.\n'
    const split = splitAnyFrontmatter(md)
    expect(split?.data.title).toBe('Work with long documents')
    expect(split?.data.order).toBe(4)
    expect(split?.body).toBe('# Work with long documents\n\nText.\n')
  })

  it('also takes markoto frontmatter off', () => {
    const split = splitAnyFrontmatter('---\nmarkoto: 1\ntitle: A\n---\nBody')
    expect(split?.body).toBe('Body')
  })

  it('leaves text without frontmatter, with an unclosed block or with a non-mapping alone', () => {
    expect(splitAnyFrontmatter('# Title\n\n---\n')).toBeNull()
    expect(splitAnyFrontmatter('---\ntitle: open\n\nno end')).toBeNull()
    expect(splitAnyFrontmatter('---\n- a\n- b\n---\nBody')).toBeNull()
  })

  it('a horizontal rule at the start with plain text after it is not frontmatter', () => {
    expect(splitAnyFrontmatter('---\nJust a paragraph, then\n---\n')).toBeNull()
  })
})
