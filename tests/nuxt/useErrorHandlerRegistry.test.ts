import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

import { useErrorHandler } from '~/composables/platform/useErrorHandler'

// Text resolution for registered error codes (shared/api/errors/): the
// code's translated text first, but never at the cost of what unconverted
// routes already show (their messageKey, their raw message, the per-feature
// plan texts).

const { translations } = vi.hoisted(() => ({ translations: {} as Record<string, string> }))

mockNuxtImport('useToast', () => () => ({ add: () => {} }))
mockNuxtImport('useI18n', () => () => ({
  t: (key: string, params?: Record<string, unknown>) =>
    (translations[key] ?? `[missing:${key}]`).replace(/\{(\w+)\}/g, (_w, n: string) => String(params?.[n] ?? '')),
  te: (key: string) => key in translations
}))

beforeEach(() => {
  for (const k of Object.keys(translations)) Reflect.deleteProperty(translations, k)
  Object.assign(translations, {
    'error.generic': 'Something went wrong.',
    'error.forbidden': 'No permission.',
    'apiErrors.share.not-allowed': 'Nicht erlaubt.',
    'apiErrors.share.expiry-too-far': 'Höchstens {maxDays} Tage.',
    'apiErrors.request.invalid': 'Ungültig.',
    'apiErrors.validation.too_small': 'Zu kurz (mindestens {minimum}).',
    'apiErrors.plan.feature-unavailable': 'Nicht im Plan.',
    'plan.feature.shareControls': 'Link-Ablauf ist Teil der bezahlten Pläne.',
    'legacy.key': 'Alte Übersetzung.'
  })
})

describe('useErrorHandler — registered codes', () => {
  it('shows the registered code\'s text, interpolated with data', () => {
    const { extractError } = useErrorHandler()
    expect(extractError({ statusCode: 403, data: { code: 'share/not-allowed', message: 'Only the owner…' } }).message).toBe('Nicht erlaubt.')
    expect(extractError({ statusCode: 400, data: { code: 'share/expiry-too-far', maxDays: 366 } }).message).toBe('Höchstens 366 Tage.')
  })

  it('falls back to the route\'s messageKey / raw message when a required param is missing (unconverted route)', () => {
    const { extractError } = useErrorHandler()
    expect(extractError({ statusCode: 400, data: { code: 'share/expiry-too-far', messageKey: 'legacy.key' } }).message).toBe('Alte Übersetzung.')
    expect(extractError({ statusCode: 400, data: { code: 'share/expiry-too-far', message: 'At most 366 days.' } }).message).toBe('At most 366 days.')
  })

  it('plan codes keep their per-feature text', () => {
    const { extractError } = useErrorHandler()
    expect(extractError({ statusCode: 409, data: { code: 'plan/feature-unavailable', feature: 'shareControls' } }).message)
      .toBe('Link-Ablauf ist Teil der bezahlten Pläne.')
    expect(extractError({ statusCode: 409, data: { code: 'plan/feature-unavailable', feature: 'unknown' } }).message).toBe('Nicht im Plan.')
  })

  it('an unregistered code still shows the server message', () => {
    const { extractError } = useErrorHandler()
    expect(extractError({ statusCode: 400, data: { code: 'nope/unknown', message: 'Raw text' } }).message).toBe('Raw text')
  })

  it('without code or message, a status-based text', () => {
    const { extractError } = useErrorHandler()
    expect(extractError({ statusCode: 403, data: {} }).message).toBe('No permission.')
  })

  it('translates validation fields', () => {
    const { extractError } = useErrorHandler()
    const r = extractError({ statusCode: 400, data: { code: 'request/invalid', field: 'a', fields: [{ path: 'a', issue: 'too_small', minimum: 3 }, { path: 'b', issue: 'unknown_issue' }] } })
    expect(r.message).toBe('Ungültig.')
    expect(r.fields).toEqual([{ path: 'a', message: 'Zu kurz (mindestens 3).' }])
  })
})
