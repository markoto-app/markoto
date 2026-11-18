import { describe, expect, it } from 'vitest'
import { estimateJob, needsConfirmation, exceedsBudget, maxTokensFor, callCostUsd } from '../../../../server/utils/ai/jobs/estimate'
import { checkGlossary } from '../../../../server/utils/ai/jobs/glossaryCheck'
import { addStableAnchors, documentHeadingSlugs, headingInlineText } from '../../../../server/utils/ai/jobs/anchors'
import { WORKER_PRICES } from '../../../../server/utils/litellm/workerPrices'

describe('estimateJob', () => {
  const price = WORKER_PRICES['markoto-worker']
  it('sums prompt and unit tokens with the retry overhead and prices them', () => {
    const e = estimateJob({ mode: 'rewrite', unitTokens: [1000, 1000], systemChars: 3600, jobChars: 1800, contextTokensPerUnit: 0, price })
    // (1000 + 500 + 1000) per unit in, 1000 out, x 1.15.
    expect(e.inputTokens).toBe(Math.round(2 * 2500 * 1.15))
    expect(e.outputTokens).toBe(2300)
    expect(e.usd).toBeCloseTo(5750 * price.input + 2300 * price.output, 4)
    expect(e.units).toBe(2)
  })

  it('uses per-mode output ratios and is time-bound by 40 rpm', () => {
    const units = Array.from({ length: 152 }, () => 850)
    const de2en = estimateJob({ mode: 'translate', unitTokens: units, systemChars: 4000, jobChars: 5000, price, sourceLanguage: 'de', targetLanguage: 'en' })
    const en2de = estimateJob({ mode: 'translate', unitTokens: units, systemChars: 4000, jobChars: 5000, price, sourceLanguage: 'en', targetLanguage: 'de' })
    expect(en2de.outputTokens).toBeGreaterThan(de2en.outputTokens)
    expect(de2en.minutes).toBeGreaterThanOrEqual(152 / 40)
    expect(de2en.usd!).toBeLessThan(0.3)
    expect(estimateJob({ mode: 'summarise', unitTokens: [10_000], systemChars: 0, jobChars: 0, price }).outputTokens).toBe(Math.round(150 * 1.15))
    expect(maxTokensFor('comment', 3000)).toBe(256)
    expect(maxTokensFor('rewrite', 1000)).toBe(2000)
    // A scan answer lists up to 300 items of a 15k-token chunk.
    expect(maxTokensFor('scan', 15_000)).toBe(4000)
  })

  it('BYOK: tokens only', () => {
    const e = estimateJob({ mode: 'rewrite', unitTokens: [1000], systemChars: 0, jobChars: 0, price: null })
    expect(e.usd).toBeNull()
    expect(needsConfirmation(e, null)).toBe(false)
    expect(exceedsBudget(e, 0)).toBe(false)
    expect(callCostUsd(null, { promptTokens: 1, cachedTokens: 0, outputTokens: 1 })).toBeNull()
  })

  it('confirmation thresholds: $0.05, 10 % of the remaining budget, 30 units', () => {
    const base = { units: 5, inputTokens: 0, outputTokens: 0, minutes: 1 }
    expect(needsConfirmation({ ...base, usd: 0.06 }, 10)).toBe(true)
    expect(needsConfirmation({ ...base, usd: 0.02 }, 0.1)).toBe(true)
    expect(needsConfirmation({ ...base, usd: 0.02 }, 10)).toBe(false)
    expect(needsConfirmation({ ...base, units: 31, usd: 0.001 }, 10)).toBe(true)
    expect(exceedsBudget({ ...base, usd: 0.2 }, 0.1)).toBe(true)
    expect(exceedsBudget({ ...base, usd: 0.2 }, null)).toBe(false)
  })

  it('prices cached input at the cached rate', () => {
    expect(callCostUsd(price, { promptTokens: 1000, cachedTokens: 800, outputTokens: 100 }))
      .toBeCloseTo(200 * price.input + 800 * price.cachedInput + 100 * price.output, 10)
  })
})

describe('checkGlossary', () => {
  const glossary = [{ source: 'Netzleitstelle', target: 'network control centre' }, { source: 'E-Mail', target: 'e-mail' }]
  it('flags source terms left, missing targets and variant spellings; ignores code', () => {
    const flagged = checkGlossary([
      { ordinal: 0, source: 'Die Netzleitstelle schreibt eine E-Mail.', output: 'The network control centre sends an e-mail.' },
      { ordinal: 1, source: 'Die Netzleitstelle ruft an.', output: 'The Netzleitstelle calls.' },
      { ordinal: 2, source: 'Eine E-Mail geht raus.', output: 'An email goes out.' },
      { ordinal: 3, source: 'Die Netzleitstelle prüft.', output: 'The control room checks.' },
      { ordinal: 4, source: 'Siehe `Netzleitstelle.cfg`.', output: 'See `Netzleitstelle.cfg`.' }
    ], glossary, 'translate')
    expect(flagged).toEqual([
      { ordinal: 1, violations: [{ kind: 'source_term_left', source: 'Netzleitstelle', target: 'network control centre' }] },
      { ordinal: 2, violations: [{ kind: 'target_variant', source: 'E-Mail', target: 'e-mail' }] },
      { ordinal: 3, violations: [{ kind: 'target_missing', source: 'Netzleitstelle', target: 'network control centre' }] }
    ])
  })
})

describe('stable anchors', () => {
  it('computes the preview slugs with duplicate numbering and explicit ids', () => {
    const doc = '# Methoden\n\n## Ergebnisse {#res}\n\n# Methoden\n\n## 2024 **Zahlen** [Link](x)\n'
    expect(documentHeadingSlugs(doc).map(h => h.slug)).toEqual(['methoden', 'res', 'methoden-1', 'h-2024-zahlen-link'])
    expect(headingInlineText('A `code` and *em* ![img](x)')).toBe('A code and em')
  })

  it('pins the old slug on renamed headings only', () => {
    const before = '# Methoden\n\nText.\n\n## Ergebnisse {#res}\n\n## Gleich ##\n\nSetext\n------\n'
    const after = '# Methods\n\nText.\n\n## Results {#res}\n\n## Gleich ##\n\nSetext en\n------\n'
    const slugs = documentHeadingSlugs(before).map(h => h.slug)
    const out = addStableAnchors(before, after, slugs)
    expect(out.added).toBe(2)
    expect(out.text).toBe('# Methods {#methoden}\n\nText.\n\n## Results {#res}\n\n## Gleich ##\n\nSetext en {#setext}\n------\n')
    expect(documentHeadingSlugs(out.text).map(h => h.slug)).toEqual(slugs)
  })
})
