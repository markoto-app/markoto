import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

// useErrorHandler is the single entry point for surfacing $fetch errors
// to users. It lives between components and the toast system — every
// catch block in the app routes through showError / showContextualError
// rather than `console.error`. The tests here pin the extraction logic
// (messageKey > raw message > generic fallback), the auto-mapping of
// 401/403/404/429 to generic toast keys, and the 402 carve-out so
// useAI's budget-exhausted CTA keeps working.
//
// Dependencies mocked via `mockNuxtImport`:
//   - `useToast()` — captures toast.add() calls for assertions
//   - `useI18n()` — { t, te } with a translation table we control per test

const { toastAddMock, translations, missingKeys } = vi.hoisted(() => ({
  toastAddMock: { fn: (_opts: unknown) => {} },
  translations: {} as Record<string, string>,
  missingKeys: new Set<string>()
}))

mockNuxtImport('useToast', () => {
  return () => ({ add: (opts: unknown) => toastAddMock.fn(opts) })
})

mockNuxtImport('useI18n', () => {
  return () => ({
    t: (key: string) => translations[key] ?? `[missing:${key}]`,
    te: (key: string) => !missingKeys.has(key) && key in translations
  })
})

import { useErrorHandler } from '~/composables/useErrorHandler'

beforeEach(() => {
  toastAddMock.fn = vi.fn()
  for (const k of Object.keys(translations)) delete translations[k]
  missingKeys.clear()

  // Baseline translations every test implicitly relies on. Tests that
  // want a key to be MISSING add it to `missingKeys` explicitly.
  Object.assign(translations, {
    'error.generic': 'Something went wrong. Please try again.',
    'error.unauthorized': 'Please sign in to continue.',
    'error.forbidden': "You don't have permission to do that.",
    'error.notFound': 'Not found.',
    'error.rateLimited': 'Too many requests — try again later.',
    'delete.failed': 'Could not delete.',
    'ai.upgradeCta': 'Upgrade',
    'ai.budgetExhaustedDescription': 'You have used all AI actions.'
  })
})

describe('extractError — statusCode resolution', () => {
  it('prefers top-level err.statusCode (the Nuxt $fetch shape)', async () => {
    const { extractError } = useErrorHandler()
    const r = extractError({ statusCode: 404, data: { statusCode: 500 } })
    expect(r.statusCode).toBe(404)
  })

  it('falls through to err.status when statusCode is absent', async () => {
    // Some fetch wrappers (native `fetch` + ofetch variants) use
    // `status` rather than `statusCode`. Handle both.
    const { extractError } = useErrorHandler()
    expect(extractError({ status: 418 }).statusCode).toBe(418)
  })

  it('falls through to err.data.statusCode as last resort', async () => {
    const { extractError } = useErrorHandler()
    expect(extractError({ data: { statusCode: 502 } }).statusCode).toBe(502)
  })

  it('returns null when no status information is present', async () => {
    const { extractError } = useErrorHandler()
    expect(extractError({ message: 'weird' }).statusCode).toBeNull()
  })

  it('tolerates a null/undefined error object', async () => {
    // Defensive: a catch block that receives `undefined` (because the
    // thrown value was falsy for some reason) shouldn't crash the toast.
    const { extractError } = useErrorHandler()
    expect(extractError(undefined).statusCode).toBeNull()
    expect(extractError(null).statusCode).toBeNull()
  })
})

describe('extractError — message resolution priority', () => {
  it('uses data.messageKey → t(key) when present', async () => {
    translations['custom.foo'] = 'The Foo message'
    const { extractError } = useErrorHandler()
    const r = extractError({ data: { messageKey: 'custom.foo' } })
    expect(r.message).toBe('The Foo message')
  })

  it('falls back to raw data.message when messageKey is missing from i18n', async () => {
    // Server shipped a key the client doesn't know yet — rare but
    // possible across a deploy window. Show the English raw string
    // rather than `[missing:key]` nonsense.
    missingKeys.add('unknown.key')
    const { extractError } = useErrorHandler()
    const r = extractError({ data: { messageKey: 'unknown.key', message: 'Raw English' } })
    expect(r.message).toBe('Raw English')
  })

  it('falls back to generic when messageKey AND raw message are both absent', async () => {
    missingKeys.add('unknown.key')
    const { extractError } = useErrorHandler()
    const r = extractError({ data: { messageKey: 'unknown.key' } })
    expect(r.message).toBe('Something went wrong. Please try again.')
  })

  it('uses err.data.message when no messageKey is provided', async () => {
    const { extractError } = useErrorHandler()
    expect(extractError({ data: { message: 'server said no' } }).message).toBe('server said no')
  })

  it('falls back to err.message when data.message is absent', async () => {
    const { extractError } = useErrorHandler()
    expect(extractError({ message: 'boom' }).message).toBe('boom')
  })

  it('final fallback is the generic i18n key', async () => {
    const { extractError } = useErrorHandler()
    expect(extractError({}).message).toBe('Something went wrong. Please try again.')
  })
})

describe('extractError — code + recovery passthrough', () => {
  it('surfaces data.code as-is', async () => {
    const { extractError } = useErrorHandler()
    expect(extractError({ data: { code: 'ai/budget-exhausted' } }).code).toBe('ai/budget-exhausted')
  })

  it('returns code=null when absent', async () => {
    const { extractError } = useErrorHandler()
    expect(extractError({ data: { message: 'x' } }).code).toBeNull()
  })

  it('surfaces data.recovery object as-is', async () => {
    const recovery = { kind: 'link' as const, href: '/pricing', labelKey: 'ai.upgradeCta' }
    const { extractError } = useErrorHandler()
    expect(extractError({ data: { recovery } }).recovery).toEqual(recovery)
  })
})

describe('showError — toast wiring', () => {
  it('adds an error-color toast with the translated title and extracted message', async () => {
    translations['delete.failed'] = 'Could not delete.'
    const { showError } = useErrorHandler()
    showError('delete.failed', { data: { message: 'rls denied' } })
    expect(toastAddMock.fn).toHaveBeenCalledOnce()
    expect(toastAddMock.fn).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Could not delete.',
      description: 'rls denied',
      color: 'error'
    }))
  })

  it('forwards an action (Upgrade-link style CTA) into toast.actions', async () => {
    const onClick = vi.fn()
    const { showError } = useErrorHandler()
    showError('delete.failed', {}, { label: 'Upgrade', onClick, color: 'primary' })
    expect(toastAddMock.fn).toHaveBeenCalledWith(expect.objectContaining({
      actions: [{ label: 'Upgrade', onClick, color: 'primary' }]
    }))
  })

  it('omits actions entirely when no action is passed', async () => {
    const { showError } = useErrorHandler()
    showError('delete.failed', {})
    const call = (toastAddMock.fn as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls[0]
    expect(call![0].actions).toBeUndefined()
  })

  it('returns the extracted error object so callers can read code/recovery', async () => {
    // AIPromptBar.vue leans on this to read `recovery.href` after
    // surfacing the toast — so the contract is "always return the
    // extraction, never void".
    const { showError } = useErrorHandler()
    const r = showError('delete.failed', { statusCode: 402, data: { code: 'ai/budget-exhausted' } })
    expect(r.statusCode).toBe(402)
    expect(r.code).toBe('ai/budget-exhausted')
  })
})

describe('showContextualError — status-code mapping', () => {
  it('401 → error.unauthorized (no custom title)', async () => {
    const { showContextualError } = useErrorHandler()
    showContextualError({ statusCode: 401 }, 'delete.failed')
    expect(toastAddMock.fn).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Please sign in to continue.'
    }))
  })

  it('403 → error.forbidden', async () => {
    const { showContextualError } = useErrorHandler()
    showContextualError({ statusCode: 403 }, 'delete.failed')
    expect(toastAddMock.fn).toHaveBeenCalledWith(expect.objectContaining({
      title: "You don't have permission to do that."
    }))
  })

  it('404 → error.notFound', async () => {
    const { showContextualError } = useErrorHandler()
    showContextualError({ statusCode: 404 }, 'delete.failed')
    expect(toastAddMock.fn).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Not found.'
    }))
  })

  it('429 → error.rateLimited', async () => {
    const { showContextualError } = useErrorHandler()
    showContextualError({ statusCode: 429 }, 'delete.failed')
    expect(toastAddMock.fn).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Too many requests — try again later.'
    }))
  })

  it('402 FALLS THROUGH to caller title (budget-CTA owned by useAI)', async () => {
    // This is the deliberate carve-out. useAI.ts has specialised UX for
    // 402 (custom title "ai.budgetExhaustedTitle" + context-aware CTA).
    // If showContextualError intercepted 402, useAI would never see it.
    translations['delete.failed'] = 'Could not delete.'
    const { showContextualError } = useErrorHandler()
    showContextualError({ statusCode: 402 }, 'delete.failed')
    expect(toastAddMock.fn).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Could not delete.'
    }))
  })

  it('unknown status codes fall through to the default title', async () => {
    const { showContextualError } = useErrorHandler()
    showContextualError({ statusCode: 500 }, 'delete.failed')
    expect(toastAddMock.fn).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Could not delete.'
    }))
  })

  it('still surfaces the server description even on a mapped status', async () => {
    // The title is generic ("Not found.") but the description should
    // carry the server's specific message so users know WHICH resource
    // is missing. Lose this and every 404 looks identical.
    const { showContextualError } = useErrorHandler()
    showContextualError(
      { statusCode: 404, data: { message: 'Document abc123 not found' } },
      'delete.failed'
    )
    expect(toastAddMock.fn).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Not found.',
      description: 'Document abc123 not found'
    }))
  })
})
