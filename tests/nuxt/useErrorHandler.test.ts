import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

import { useErrorHandler } from '~/composables/platform/useErrorHandler'

// useErrorHandler contract tests. Only tests that encode a non-obvious cross-file contract live here, not
// mechanical branch coverage (which would catch a typo, not a design error).
//
// What we keep, and why each exists:
//
//   1. The 402 carve-out contract. useAI.ts relies on showContextualError
//      NOT intercepting 402 so its specialised budget-exhausted toast
//      with upgrade CTA can run. If we ever add `case 402:` here, useAI
//      silently loses its feature.
//
//   2. Server description preserved on mapped-status toasts. If every
//      404 shows "Not found." with no description, users can't tell
//      WHICH resource is missing, broken UX that looks like a correct
//      toast.
//
//   3. messageKey-unknown-at-client fallback. The error contract says
//      server ships messageKey, client translates. During a deploy
//      window the server may ship a key the client doesn't know yet.
//      Must not show "[missing:key]", must fall back to the raw
//      server message.
//
//   4. Null/undefined error tolerates without crash. A catch block
//      that receives `undefined` (thrown literal, Promise rejection
//      with no value) must not crash the toast system.
//
//   5. showError returns the extraction. AIPromptBar.vue reads the
//      returned `.recovery.href` after toasting to route the user to
//      `/pricing`. Without this return value, the upgrade CTA silently
//      breaks.

const { toastAddMock, translations, missingKeys } = vi.hoisted(() => {
  const translations: Record<string, string> = {}
  return {
    toastAddMock: { fn: (_opts: unknown) => {} },
    translations,
    missingKeys: new Set<string>()
  }
})

mockNuxtImport('useToast', () => {
  return () => ({ add: (opts: unknown) => toastAddMock.fn(opts) })
})

mockNuxtImport('useI18n', () => {
  return () => ({
    t: (key: string) => translations[key] ?? `[missing:${key}]`,
    te: (key: string) => !missingKeys.has(key) && key in translations
  })
})

beforeEach(() => {
  toastAddMock.fn = vi.fn()
  for (const k of Object.keys(translations)) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete translations[k]
  }
  missingKeys.clear()
  Object.assign(translations, {
    'error.generic': 'Something went wrong.',
    'error.unauthorized': 'Please sign in.',
    'error.forbidden': 'No permission.',
    'error.notFound': 'Not found.',
    'error.rateLimited': 'Too many requests.',
    'delete.failed': 'Could not delete.'
  })
})

describe('useErrorHandler: load-bearing contracts', () => {
  it('402 status DOES NOT intercept, caller title wins (useAI owns the budget-CTA)', async () => {
    // If someone adds `case 402:` to showContextualError, useAI's
    // AIPromptBar special-cased toast with the /pricing upgrade link
    // never runs. This test fails the moment that happens.
    const { showContextualError } = useErrorHandler()
    showContextualError({ statusCode: 402 }, 'delete.failed')
    expect(toastAddMock.fn).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Could not delete.'
    }))
  })

  it('a registered code\'s text is the description even on MAPPED-status toasts', async () => {
    // Generic title, specific description (from the code, in the reader's
    // language). Without this, every 404 looks identical ("Not found.") and
    // users can't tell WHICH resource is missing.
    translations['apiErrors.docs.not-found'] = 'That document does not exist.'
    const { showContextualError } = useErrorHandler()
    showContextualError(
      { statusCode: 404, data: { code: 'docs/not-found', message: 'Document abc123 not found' } },
      'delete.failed'
    )
    expect(toastAddMock.fn).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Not found.',
      description: 'That document does not exist.'
    }))
  })

  it('the server\'s English message is never shown: without a usable code it is the status text', async () => {
    const { showContextualError } = useErrorHandler()
    showContextualError(
      { statusCode: 404, data: { message: 'Document abc123 not found' } },
      'delete.failed'
    )
    expect(toastAddMock.fn).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Not found.',
      description: 'Not found.'
    }))
  })

  it('messageKey unknown to client falls back to the status text (deploy-window safety)', async () => {
    // Server ships new key `foo.bar`; client hasn't deployed its
    // translation yet. Must NOT show "[missing:foo.bar]" and not the raw
    // English message either: the status text (or the generic one).
    missingKeys.add('foo.bar')
    const { extractError } = useErrorHandler()
    const r = extractError({ data: { messageKey: 'foo.bar', message: 'Raw English explanation' } })
    expect(r.message).toBe('Something went wrong.')
  })

  it('null/undefined error does not crash (defensive for weird throwables)', async () => {
    // A Promise rejected with `undefined` or a `throw null` in
    // third-party code reaches our catch block as a falsy value.
    // The toast system still needs to fire cleanly, with the
    // generic message.
    const { extractError, showError } = useErrorHandler()
    expect(() => extractError(undefined)).not.toThrow()
    expect(() => extractError(null)).not.toThrow()
    expect(extractError(null).message).toBe('Something went wrong.')
    expect(() => showError('delete.failed', undefined)).not.toThrow()
  })

  it('showError RETURNS the extracted error (AIPromptBar reads recovery.href from this)', async () => {
    // AIPromptBar.vue's budget-CTA handler: `const { recovery } =
    // showError(...)`. If this ever returns void, the /pricing link
    // silently breaks with no other test failure.
    const { showError } = useErrorHandler()
    const r = showError('delete.failed', {
      statusCode: 402,
      data: {
        code: 'ai/budget-exhausted',
        recovery: { kind: 'link', href: '/pricing', labelKey: 'ai.upgradeCta' }
      }
    })
    expect(r.statusCode).toBe(402)
    expect(r.code).toBe('ai/budget-exhausted')
    expect(r.recovery).toEqual({ kind: 'link', href: '/pricing', labelKey: 'ai.upgradeCta' })
  })

  it('401/403/404/429 all map to distinct titles (wrong mapping = wrong UX)', async () => {
    // One bulk check that the status-to-title mapping hasn't collapsed
    // into using one title for multiple cases (a refactor hazard).
    // Each title must be distinct, and each status must map.
    const { showContextualError } = useErrorHandler()
    const titles = new Set<string>()
    for (const sc of [401, 403, 404, 429]) {
      toastAddMock.fn = vi.fn()
      showContextualError({ statusCode: sc }, 'delete.failed')
      const call = (toastAddMock.fn as unknown as { mock: { calls: Array<[{ title: string }]> } }).mock.calls[0]
      titles.add(call![0].title)
    }
    expect(titles.size).toBe(4)
  })
})
