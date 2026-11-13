import { describe, expect, it } from 'vitest'
import { COMPOSE_ENV_STACKS, renderComposeEnv } from '../../../scripts/lib/composeEnv'

// The generated passthrough regions of the prod / self-host compose files.
// `bun run check:env` holds the committed files to the generator; these
// pin the generator itself.

const prod = COMPOSE_ENV_STACKS.find(s => s.file.endsWith('compose.prod.yml'))!
const selfhost = COMPOSE_ENV_STACKS.find(s => s.file.endsWith('compose.selfhost.yml'))!

const compose = (handWritten: string[]): string => [
  'services:',
  '  app:',
  '    environment:',
  '      # BEGIN env:gen app',
  '      - STALE_LINE=${STALE_LINE:-}',
  '      # END env:gen app',
  ...handWritten.map(l => `      ${l}`),
  ''
].join('\n')

const generated = (text: string): string[] => {
  const lines = text.split('\n')
  return lines.slice(lines.findIndex(l => l.includes('BEGIN env:gen')) + 1, lines.findIndex(l => l.includes('END env:gen')))
    .map(l => l.trim())
}

describe('renderComposeEnv', () => {
  it('passes registry variables through and drops lines the registry does not know', () => {
    const lines = generated(renderComposeEnv(selfhost, compose([])))
    expect(lines).toContain('- NUXT_SESSION_PASSWORD=${NUXT_SESSION_PASSWORD:-}')
    expect(lines.some(l => l.includes('STALE_LINE'))).toBe(false)
  })

  it('makes variables required at boot fail fast in the hosted stack only', () => {
    expect(generated(renderComposeEnv(prod, compose([])))).toContain('- NUXT_SESSION_PASSWORD=${NUXT_SESSION_PASSWORD:?NUXT_SESSION_PASSWORD required}')
    expect(generated(renderComposeEnv(selfhost, compose([])))).toContain('- NUXT_SESSION_PASSWORD=${NUXT_SESSION_PASSWORD:-}')
  })

  it('leaves a variable written by hand below the markers alone', () => {
    const text = renderComposeEnv(prod, compose(['- NUXT_SITE_URL=https://${DOMAIN:?DOMAIN required}']))
    expect(generated(text).some(l => l.startsWith('- NUXT_SITE_URL='))).toBe(false)
    expect(text).toContain('      - NUXT_SITE_URL=https://${DOMAIN:?DOMAIN required}')
  })

  it('is stable: rendering its own output changes nothing', () => {
    const once = renderComposeEnv(prod, compose([]))
    expect(renderComposeEnv(prod, once)).toBe(once)
  })

  it('refuses a BEGIN without its END', () => {
    expect(() => renderComposeEnv(prod, 'services:\n  app:\n    environment:\n      # BEGIN env:gen app\n')).toThrow(/no matching END/)
  })
})
