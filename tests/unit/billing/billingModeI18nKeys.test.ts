import { describe, it, expect } from 'vitest'
import en from '../../../i18n/locales/en.json'
import de from '../../../i18n/locales/de.json'
import fr from '../../../i18n/locales/fr.json'
import es from '../../../i18n/locales/es.json'
import ja from '../../../i18n/locales/ja.json'
import zh from '../../../i18n/locales/zh.json'

// Pin the i18n keys the billing-off / coming-soon / waitlist surfaces
// reference (WP3). Every key must resolve to a non-empty string in ALL
// six locales, and non-English locales must not just copy the English
// text (a copy renders English to a German user without anyone noticing).

const KEYS: string[] = [
  'billing.comingSoonCta',
  'billing.comingSoonHint',
  'ai.exhaustedPlaceholderFree',
  'ai.budgetExhaustedResetDescription',
  'ai.budgetExhaustedComingSoonDescription',
  'knowledge.capFilesReachedFree',
  'knowledge.capBytesReachedFree',
  'knowledge.capReachedShortFree',
  'workspace.capReachedFree',
  'workspace.capReachedShortFree',
  'pricing.comingSoonSubtitle',
  'pricing.comingSoonBadge',
  'pricing.availableNow',
  'pricing.comingSoonFootnote',
  'pricing.freeFootnote',
  'pricing.selfHostedTitle',
  'pricing.selfHostedSubtitle',
  'waitlist.title',
  'waitlist.description',
  'waitlist.emailLabel',
  'waitlist.emailPlaceholder',
  'waitlist.consentLabel',
  'waitlist.privacyLink',
  'waitlist.submit',
  'waitlist.successTitle',
  'waitlist.successBody',
  'waitlist.missingToken',
  'waitlist.backHome',
  'waitlist.errors.consentRequired',
  'waitlist.errors.invalidEmail',
  'waitlist.errors.invalidToken',
  'waitlist.confirm.title',
  'waitlist.confirm.body',
  'waitlist.confirm.button',
  'waitlist.confirm.successTitle',
  'waitlist.confirm.successBody',
  'waitlist.unsubscribe.title',
  'waitlist.unsubscribe.body',
  'waitlist.unsubscribe.button',
  'waitlist.unsubscribe.successTitle',
  'waitlist.unsubscribe.successBody'
]

// Keys whose value may legitimately be identical across locales.
const MAY_MATCH_ENGLISH = new Set(['waitlist.emailPlaceholder'])

const LOCALES: Record<string, unknown> = { en, de, fr, es, ja, zh }

function resolve(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, seg) => {
    if (acc && typeof acc === 'object' && seg in acc) {
      return (acc as Record<string, unknown>)[seg]
    }
    return undefined
  }, obj)
}

describe('billing-mode + waitlist i18n keys', () => {
  for (const [locale, messages] of Object.entries(LOCALES)) {
    it(`${locale}: every key resolves to a non-empty string`, () => {
      for (const key of KEYS) {
        const value = resolve(messages, key)
        expect(typeof value, `${locale}:${key}`).toBe('string')
        expect(value, `${locale}:${key}`).not.toBe('')
      }
    })
  }

  for (const locale of ['de', 'fr', 'es', 'ja', 'zh']) {
    it(`${locale}: values are translated, not English copies`, () => {
      for (const key of KEYS) {
        if (MAY_MATCH_ENGLISH.has(key)) continue
        expect(resolve(LOCALES[locale], key), `${locale}:${key}`).not.toBe(resolve(en, key))
      }
    })
  }

  it('the email placeholder escapes "@" so vue-i18n does not parse it as a linked message', () => {
    for (const [locale, messages] of Object.entries(LOCALES)) {
      expect(resolve(messages, 'waitlist.emailPlaceholder'), locale).toContain('{\'@\'}')
    }
  })
})
