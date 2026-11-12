// @vitest-environment nuxt
import { describe, it, expect, vi } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import type { NuxtError } from '#app'
import ErrorPage from '~/error.vue'

// `app/error.vue` replaces Nuxt's English default for unhandled page errors.
// The copy is chosen by status; the error's own message (which can carry
// server internals) is never rendered.

const { clearError } = vi.hoisted(() => ({ clearError: vi.fn() }))
mockNuxtImport('clearError', () => clearError)

function fail(statusCode: number, message: string): NuxtError {
  return createError({ statusCode, message })
}

describe('error page', () => {
  it('shows the localised not-found copy for a 404', async () => {
    const wrapper = await mountSuspended(ErrorPage, { props: { error: fail(404, 'Page not found: /nope') } })
    expect(wrapper.find('[data-testid="error-page-code"]').text()).toBe('404')
    expect(wrapper.find('[data-testid="error-page-title"]').text()).toBe('Page not found')
    expect(wrapper.find('[data-testid="error-page-message"]').text()).toContain('does not exist')
  })

  it('shows generic copy for a server error and never the error message', async () => {
    const secret = 'ECONNREFUSED postgres://app:hunter2@db:5432/app'
    const wrapper = await mountSuspended(ErrorPage, { props: { error: fail(500, secret) } })
    expect(wrapper.find('[data-testid="error-page-title"]').text()).toBe('Something went wrong')
    expect(wrapper.text()).not.toContain('hunter2')
    expect(wrapper.text()).not.toContain('ECONNREFUSED')
  })

  it('leaves the error state and goes home from the button', async () => {
    const wrapper = await mountSuspended(ErrorPage, { props: { error: fail(500, 'boom') } })
    await wrapper.find('[data-testid="error-page-home"]').trigger('click')
    expect(clearError).toHaveBeenCalledWith({ redirect: '/' })
  })
})
