import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

import { useErrorHandler } from '~/composables/platform/useErrorHandler'

// Text resolution for registered error codes (shared/api/errors/): the
// code's translated text first, then the route's messageKey, the per-feature
// plan texts, a status-based text. The server's English message is never shown.

const { translations } = vi.hoisted(() => {
  const translations: Record<string, string> = {}
  return { translations }
})

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
    'error.badRequest': 'Bad request.',
    'error.serverError': 'Our side broke.',
    'error.network': 'Offline.',
    'apiErrors.share.not-allowed': 'Nicht erlaubt.',
    'apiErrors.share.expiry-too-far': 'Höchstens {maxDays} Tage.',
    'apiErrors.request.invalid': 'Ungültig.',
    'apiErrors.validation.too_small': 'Zu kurz (mindestens {minimum}).',
    'apiErrors.plan.feature-unavailable': 'Nicht im Plan.',
    'plan.feature.shareControls': 'Link-Ablauf ist Teil der bezahlten Pläne.',
    'legacy.key': 'Alte Übersetzung.',
    'apiErrors.abuse.body-too-short': 'Bitte erklären Sie, was falsch ist (mindestens 10 Zeichen).',
    'apiErrors.ai-provider.key-required': 'Geben Sie den API-Schlüssel ein.',
    'apiErrors.moderation.restricted': 'Dieses Dokument wurde nach einer Meldung eingeschränkt.'
  })
})

describe('useErrorHandler: registered codes', () => {
  it('shows the registered code\'s text, interpolated with data', () => {
    const { extractError } = useErrorHandler()
    expect(extractError({ statusCode: 403, data: { code: 'share/not-allowed', message: 'Only the owner…' } }).message).toBe('Nicht erlaubt.')
    expect(extractError({ statusCode: 400, data: { code: 'share/expiry-too-far', maxDays: 366 } }).message).toBe('Höchstens 366 Tage.')
  })

  it('falls back to the route\'s messageKey, then the status text, when a required param is missing', () => {
    const { extractError } = useErrorHandler()
    expect(extractError({ statusCode: 400, data: { code: 'share/expiry-too-far', messageKey: 'legacy.key' } }).message).toBe('Alte Übersetzung.')
    expect(extractError({ statusCode: 400, data: { code: 'share/expiry-too-far', message: 'At most 366 days.' } }).message).toBe('Bad request.')
  })

  it('plan codes keep their per-feature text', () => {
    const { extractError } = useErrorHandler()
    expect(extractError({ statusCode: 409, data: { code: 'plan/feature-unavailable', feature: 'shareControls' } }).message)
      .toBe('Link-Ablauf ist Teil der bezahlten Pläne.')
    expect(extractError({ statusCode: 409, data: { code: 'plan/feature-unavailable', feature: 'unknown' } }).message).toBe('Nicht im Plan.')
  })

  it('an unregistered code shows the status text, never the server message', () => {
    const { extractError } = useErrorHandler()
    const r = extractError({ statusCode: 400, data: { code: 'nope/unknown', message: 'Raw text' } })
    expect(r.message).toBe('Bad request.')
    expect(r.code).toBeNull()
  })

  it('status text by class: 5xx is the server-side text, an answerless request the network text', () => {
    const { extractError } = useErrorHandler()
    expect(extractError({ statusCode: 502, data: { message: 'Bad gateway' } }).message).toBe('Our side broke.')
    expect(extractError({ name: 'FetchError', message: '[GET] "/api/x": <no response> Failed to fetch' }).message).toBe('Offline.')
    // A status with no key of its own, and a plain Error: the generic text.
    expect(extractError({ statusCode: 418, data: { message: 'Teapot' } }).message).toBe('Something went wrong.')
    expect(extractError(new Error('boom')).message).toBe('Something went wrong.')
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

// What `$fetch` really throws: the response body in `.data`, our fields one
// level down in the body's own `.data`. Routes no longer send `messageKey`
// for codes whose text is fixed; the code alone must give the translation.
describe('useErrorHandler: real $fetch errors (nested body)', () => {
  const fetchError = (statusCode: number, data: Record<string, unknown>, message = 'English server text') =>
    ({ statusCode, message: `[POST] "/api/x": ${statusCode}`, data: { statusCode, statusMessage: 'Bad Request', message, data } })

  it('resolves the code\'s translated text without a messageKey', () => {
    const { extractError } = useErrorHandler()
    expect(extractError(fetchError(400, { code: 'abuse/body-too-short' }))).toMatchObject({ code: 'abuse/body-too-short', message: 'Bitte erklären Sie, was falsch ist (mindestens 10 Zeichen).' })
    expect(extractError(fetchError(400, { code: 'ai-provider/key-required' })).message).toBe('Geben Sie den API-Schlüssel ein.')
    expect(extractError(fetchError(403, { code: 'moderation/restricted' })).message).toBe('Dieses Dokument wurde nach einer Meldung eingeschränkt.')
  })

  it('reads params, recovery and the per-occurrence key from the inner data', () => {
    const { extractError } = useErrorHandler()
    expect(extractError(fetchError(400, { code: 'share/expiry-too-far', maxDays: 30 })).message).toBe('Höchstens 30 Tage.')
    const plan = extractError(fetchError(409, { code: 'plan/feature-unavailable', feature: 'shareControls', recovery: { kind: 'link', href: '/pricing' } }))
    expect(plan.message).toBe('Link-Ablauf ist Teil der bezahlten Pläne.')
    expect(plan.recovery).toEqual({ kind: 'link', href: '/pricing' })
  })

  it('an unregistered code shows neither the body\'s message nor the fetch wrapper\'s', () => {
    const { extractError } = useErrorHandler()
    expect(extractError(fetchError(400, { code: 'nope/unknown' }, 'Raw body text')).message).toBe('Bad request.')
  })

  it('a code like "constructor" never reaches a prototype member', () => {
    const { extractError } = useErrorHandler()
    const r = extractError(fetchError(400, { code: 'constructor' }, 'Raw'))
    expect(r.message).toBe('Bad request.')
    expect(r.code).toBeNull()
  })
})
