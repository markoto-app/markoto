import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import SsoErrorPage from '~/pages/auth/sso-error.vue'

// Where a refused or failed single sign-on lands. It shows one of our fixed
// texts by code (never text from the query) and offers to start the
// sign-in of that workspace again.

const WS = 'aaaaaaaaaaaaaaaaaaaaa'
const CONNECTION = 'bbbbbbbbbbbbbbbbbbbbb'

async function mount(query: string) {
  return mountSuspended(SsoErrorPage, { route: `/auth/sso-error?${query}` })
}

describe('SSO error page', () => {
  it('says plainly that the sign-in took too long, with a button that starts it again', async () => {
    const w = await mount(`code=sso%2Fexpired&workspace=${WS}&connection=${CONNECTION}`)
    expect(w.get('[data-testid="sso-error"]').attributes('data-code')).toBe('expired')
    expect(w.text()).toContain('The sign-in took too long.')
    const retry = w.get('[data-testid="sso-error-retry"]')
    expect(retry.text()).toBe('Try again')
    expect(retry.attributes('href')).toBe(`/auth/sso/${CONNECTION}`)
  })

  it('retries an admin\'s test as a test', async () => {
    const w = await mount(`code=sso%2Ffailed&workspace=${WS}&connection=${CONNECTION}&test=1`)
    expect(w.get('[data-testid="sso-error-retry"]').attributes('href')).toBe(`/auth/sso/${CONNECTION}?test=1`)
  })

  it('offers no retry without a connection, or with something that is not a connection id', async () => {
    const none = await mount(`code=sso%2Fnot-active&workspace=${WS}`)
    expect(none.find('[data-testid="sso-error-retry"]').exists()).toBe(false)

    const forged = await mount(`code=sso%2Ffailed&connection=${encodeURIComponent('//evil.example/x')}`)
    expect(forged.find('[data-testid="sso-error-retry"]').exists()).toBe(false)
  })

  it('shows the generic text for a code it does not know, never the query text', async () => {
    const w = await mount(`code=${encodeURIComponent('<b>upstream said no</b>')}&connection=${CONNECTION}`)
    expect(w.get('[data-testid="sso-error"]').attributes('data-code')).toBe('failed')
    expect(w.text()).not.toContain('upstream said no')
    expect(w.text()).toContain('The sign-in couldn\'t be completed.')
  })
})
