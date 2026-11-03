import { describe, it, expect } from 'vitest'
import {
  TEMPLATES,
  TEMPLATE_IDS,
  isTemplateId,
  getTemplate,
  DEFAULT_TEMPLATE_ID,
  TEMPLATE_LOCALES
} from '../../shared/templates'
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
