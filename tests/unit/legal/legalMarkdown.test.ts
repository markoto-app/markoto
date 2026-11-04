import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { legalMarkdown, legalSlugify } from '../../../server/utils/legalMarkdown'

const ROOT = resolve(__dirname, '../../..')
const LEGAL = resolve(ROOT, 'content/legal')

describe('legal markdown renderer', () => {
  it('keeps "(c)" as typed (no © substitution): legal texts cite Art. 6(1)(c)', () => {
    const html = legalMarkdown.render('Legal obligation (Art. 6(1)(c) GDPR), (r) and +-.')
    expect(html).toContain('6(1)(c) GDPR')
    expect(html).not.toMatch(/[©®±]/)
  })

  it('still renders smart quotes', () => {
    expect(legalMarkdown.render('"Sign in with Google"')).toContain('“Sign in with Google”')
  })

  it('turns [[toc]] into links to the h2 sections', () => {
    const html = legalMarkdown.render('**Contents**\n\n[[toc]]\n\n## 1. Who we are\n\nText\n\n## 5b. Qué datos tratamos\n')
    expect(html).toContain('id="1-who-we-are"')
    expect(html).toContain('href="#1-who-we-are"')
    expect(html).toContain('id="5b-que-datos-tratamos"')
    expect(html).toContain('href="#5b-que-datos-tratamos"')
    expect(html).toContain('class="legal-toc"')
  })

  it('slugifies to ASCII, folding accents', () => {
    expect(legalSlugify('2b. Données anonymes, l’accès')).toBe('2b-donnees-anonymes-l-acces')
  })
})

describe('bundled legal sources', () => {
  const files = readdirSync(LEGAL, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .flatMap(d => readdirSync(resolve(LEGAL, d.name)).filter(f => f.endsWith('.md')).map(f => `${d.name}/${f}`))

  it.each(files)('%s: no hand-typed contents line (use [[toc]])', (file) => {
    const src = readFileSync(resolve(LEGAL, file), 'utf8')
    expect(src).not.toMatch(/^\*\*[^*]+:\*\* .*·/m)
  })

  it.each(files)('%s: app paths are links, not code', (file) => {
    const src = readFileSync(resolve(LEGAL, file), 'utf8')
    expect(src).not.toMatch(/`\/(?:legal|settings|docs)[^`]*`/)
  })
})
