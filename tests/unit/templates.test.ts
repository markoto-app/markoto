import { describe, it, expect } from 'vitest'
import {
  TEMPLATES,
  TEMPLATE_IDS,
  isTemplateId,
  getTemplate,
  DEFAULT_TEMPLATE_ID,
  TEMPLATE_LOCALES
} from '../../shared/templates'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderTemplate } from '../../server/utils/templateRenderer'

// Template registry + renderer contract.
//
// Invariants:
//   - Every TEMPLATES entry resolves via getTemplate() and isTemplateId().
//   - `blank` is the only template with hasContent=false; renderTemplate
//     returns null for it.
//   - Title + description placeholders substitute everywhere they appear.
//   - Locale resolution: exact match → BCP-47 base → English fallback.
//   - Free-text languages ("Schwiizerdütsch") fall back to English without
//     throwing.

describe('TEMPLATES registry', () => {
  it('lists at least the seed templates we ship', () => {
    expect(TEMPLATE_IDS).toContain('demo')
    expect(TEMPLATE_IDS).toContain('blank')
    expect(TEMPLATE_IDS).toContain('business-plan')
    expect(TEMPLATE_IDS).toContain('academic-paper')
    expect(TEMPLATE_IDS).toContain('recipe')
    expect(TEMPLATE_IDS).toContain('meeting-notes')
    expect(TEMPLATE_IDS).toContain('project-readme')
  })

  it('every entry has the required metadata fields', () => {
    for (const tpl of TEMPLATES) {
      expect(tpl.id).toBeTruthy()
      expect(tpl.icon).toMatch(/^i-/)
      expect(tpl.labelKey).toMatch(/^templates\./)
      expect(tpl.descriptionKey).toMatch(/^templates\./)
      expect(typeof tpl.hasContent).toBe('boolean')
    }
  })

  it('the new-document dialog defaults to the demo template', () => {
    expect(DEFAULT_TEMPLATE_ID).toBe('demo')
    expect(isTemplateId(DEFAULT_TEMPLATE_ID)).toBe(true)
  })

  it('blank is the only template without content', () => {
    const noContent = TEMPLATES.filter(t => !t.hasContent).map(t => t.id)
    expect(noContent).toEqual(['blank'])
  })
})

describe('isTemplateId', () => {
  it('accepts every registered id', () => {
    for (const id of TEMPLATE_IDS) expect(isTemplateId(id)).toBe(true)
  })

  it('rejects unknown ids and non-strings', () => {
    expect(isTemplateId('not-a-template')).toBe(false)
    expect(isTemplateId('')).toBe(false)
    expect(isTemplateId(null)).toBe(false)
    expect(isTemplateId(undefined)).toBe(false)
    expect(isTemplateId(42)).toBe(false)
  })
})

describe('getTemplate', () => {
  it('returns the meta for a valid id', () => {
    const tpl = getTemplate('business-plan')
    expect(tpl).not.toBeNull()
    expect(tpl?.id).toBe('business-plan')
  })

  it('returns null for an unknown id', () => {
    expect(getTemplate('does-not-exist')).toBeNull()
  })
})

describe('renderTemplate', () => {
  const baseCtx = { title: 'My Plan', description: 'A test description', language: 'en' }

  it('returns null for blank (hasContent: false)', () => {
    expect(renderTemplate('blank', baseCtx)).toBeNull()
  })

  it('returns null for unknown templateId', () => {
    expect(renderTemplate('does-not-exist', baseCtx)).toBeNull()
  })

  it('substitutes {{title}} into the rendered body', () => {
    const out = renderTemplate('business-plan', baseCtx)
    expect(out).toContain('# My Plan')
    expect(out).not.toContain('{{title}}')
  })

  it('substitutes {{description}} into templates that use it', () => {
    const out = renderTemplate('project-readme', { ...baseCtx, title: 'YPad', description: 'Collaborative markdown' })
    expect(out).toContain('Collaborative markdown')
    expect(out).not.toContain('{{description}}')
  })

  it('falls back to a sensible default title when title is empty/whitespace', () => {
    const en = renderTemplate('business-plan', { ...baseCtx, title: '   ' })
    expect(en).toContain('# Untitled')
    const de = renderTemplate('business-plan', { ...baseCtx, title: '   ', language: 'de' })
    expect(de).toContain('# Unbenannt')
  })

  it('matches the doc language to the matching locale file', () => {
    const en = renderTemplate('business-plan', { ...baseCtx, language: 'en' })
    const de = renderTemplate('business-plan', { ...baseCtx, language: 'de' })
    expect(en).toContain('Executive summary')
    expect(de).toContain('Zusammenfassung')
  })

  it('strips BCP-47 region tag for matching (de-CH → de)', () => {
    const out = renderTemplate('business-plan', { ...baseCtx, language: 'de-CH' })
    expect(out).toContain('Zusammenfassung')
  })

  it('falls back to English for free-text languages we do not ship', () => {
    const out = renderTemplate('business-plan', { ...baseCtx, language: 'Romansh' })
    expect(out).toContain('Executive summary')
    expect(out).not.toContain('Zusammenfassung')
  })

  it('falls back to English when the template has no file for the locale', () => {
    const out = renderTemplate('business-plan', { ...baseCtx, language: 'ja' })
    expect(out).toContain('Executive summary')
  })

  it('ships the demo template in every UI locale', () => {
    const en = renderTemplate('demo', baseCtx)
    expect(en).toContain('# Welcome to markoto')
    for (const locale of TEMPLATE_LOCALES) {
      const out = renderTemplate('demo', { ...baseCtx, language: locale })
      expect(out, `demo/${locale}.md`).toBeTruthy()
      if (locale !== 'en') expect(out, `demo/${locale}.md is translated`).not.toBe(en)
      // Same structure in every language: the same number of sections,
      // the page break, the mermaid diagram and the task list.
      expect(out!.match(/^## /gm)?.length, `demo/${locale}.md sections`).toBe(en!.match(/^## /gm)?.length)
      expect(out).toContain('<!-- pagebreak -->')
      expect(out).toContain('```mermaid')
      expect(out).toContain('- [ ] ')
    }
  })

  it('every non-blank template renders to non-empty content with at least one heading', () => {
    for (const tpl of TEMPLATES) {
      if (!tpl.hasContent) continue
      const out = renderTemplate(tpl.id, baseCtx)
      expect(out, `template ${tpl.id} must produce content`).toBeTruthy()
      expect(out!.length).toBeGreaterThan(50)
      expect(out!).toMatch(/^#\s+/m)
    }
  })
})

// The two templates added for the /templates pages (SEO-8) ship in every
// UI locale, unlike the older skeletons (en + de, English fallback).
describe('resume + report templates', () => {
  const ROOT = join(__dirname, '..', '..')
  const NEW_IDS = ['resume', 'report'] as const

  function child(node: unknown, key: string): unknown {
    return typeof node === 'object' && node !== null ? Object.entries(node).find(([k]) => k === key)?.[1] : undefined
  }

  it('are registered with valid ids and i18n keys', () => {
    for (const id of NEW_IDS) {
      expect(isTemplateId(id)).toBe(true)
      const tpl = getTemplate(id)
      expect(tpl?.hasContent).toBe(true)
      expect(tpl?.labelKey).toBe(`templates.${id}.label`)
      expect(tpl?.descriptionKey).toBe(`templates.${id}.description`)
    }
  })

  it('every template id is a unique lowercase slug (stored in documents.templateId)', () => {
    for (const id of TEMPLATE_IDS) expect(id).toMatch(/^[a-z][a-z0-9-]*$/)
    expect(new Set(TEMPLATE_IDS).size).toBe(TEMPLATE_IDS.length)
  })

  it('ship a translated file for every template locale, with the same outline', () => {
    for (const id of NEW_IDS) {
      const en = renderTemplate(id, { title: 'T', description: '', language: 'en' })
      for (const locale of TEMPLATE_LOCALES) {
        expect(existsSync(join(ROOT, 'shared', 'templates', 'content', id, `${locale}.md`)), `${id}/${locale}.md`).toBe(true)
        const out = renderTemplate(id, { title: 'T', description: '', language: locale })
        expect(out, `${id}/${locale}`).toBeTruthy()
        if (locale !== 'en') expect(out, `${id}/${locale} is translated`).not.toBe(en)
        expect(out?.match(/^#{1,3} /gm)?.length, `${id}/${locale} headings`).toBe(en?.match(/^#{1,3} /gm)?.length)
        expect(out, `${id}/${locale}: German uses ss`).not.toContain('ß')
      }
    }
  })

  it('every template has a label + description in every UI locale', () => {
    for (const locale of TEMPLATE_LOCALES) {
      const messages: unknown = JSON.parse(readFileSync(join(ROOT, 'i18n', 'locales', `${locale}.json`), 'utf8'))
      for (const tpl of TEMPLATES) {
        const entry = child(child(messages, 'templates'), tpl.id)
        expect(typeof child(entry, 'label'), `${locale}: ${tpl.labelKey}`).toBe('string')
        expect(typeof child(entry, 'description'), `${locale}: ${tpl.descriptionKey}`).toBe('string')
      }
    }
  })

  it('the report takes the document title; the resume is a filled-in sample', () => {
    expect(renderTemplate('report', { title: 'Q3 report', description: '', language: 'en' })).toContain('# Q3 report')
    const resume = renderTemplate('resume', { title: 'My CV', description: '', language: 'de' })
    expect(resume).toContain('## Berufserfahrung')
    expect(resume).not.toContain('{{')
  })

  it('the /templates/resume page previews exactly the English template', () => {
    const page = readFileSync(join(ROOT, 'content', 'marketing', 'en', 'templates', 'resume.md'), 'utf8')
    const match = /::try-it\{[^}]*\}\n---\nsource: \|\n([\s\S]*?)\n---\n::/.exec(page)
    expect(match?.[1]).toBeTruthy()
    const source = (match?.[1] ?? '').split('\n').map(l => l.replace(/^ {2}/, '')).join('\n')
    const template = readFileSync(join(ROOT, 'shared', 'templates', 'content', 'resume', 'en.md'), 'utf8')
    expect(`${source.trim()}\n`).toBe(template)
  })

  it('the academic paper template does not promise BibTeX', () => {
    for (const locale of ['en', 'de']) {
      const body = readFileSync(join(ROOT, 'shared', 'templates', 'content', 'academic-paper', `${locale}.md`), 'utf8')
      expect(body).not.toMatch(/markdown-it-bibliography|render real reference lists|rendern echte Literaturlisten/)
    }
  })
})
