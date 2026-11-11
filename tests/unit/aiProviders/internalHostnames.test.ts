import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { INTERNAL_HOSTNAMES, isInternalHostname } from '../../../server/utils/aiProviders/urlPolicy'

// The BYOK internal-hostname denylist (app) and the `byok/*` api_base
// regex (LiteLLM, infra/litellm/config.yaml) must name every host the
// compose files create: service names, container names and network
// aliases. This test reads the compose files, so adding a service without
// updating both lists fails here instead of silently widening the SSRF
// surface. (Regression: `markoto-app`, `litellm-db-init` and `s3-init`
// were missing, and a trailing dot bypassed both lists.)

const ROOT = join(__dirname, '..', '..', '..')

/** Service names, container names, hostnames and aliases of one compose file. */
function composeHostnames(text: string): string[] {
  const names: string[] = []
  let inServices = false
  let inAliases = false
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) inServices = /^services:\s*$/.test(line)
    if (!inServices) continue
    const service = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line)
    if (service?.[1]) names.push(service[1])
    const named = /^\s+(?:container_name|hostname):\s*["']?([^"'\s]+)/.exec(line)
    if (named?.[1]) names.push(named[1])
    if (/^\s+aliases:\s*$/.test(line)) {
      inAliases = true
      continue
    }
    if (inAliases) {
      const alias = /^\s+-\s*["']?([^"'\s]+)/.exec(line)
      if (alias?.[1]) names.push(alias[1])
      else inAliases = false
    }
  }
  return names
}

const composeFiles = readdirSync(ROOT).filter(f => /^docker-compose.*\.ya?ml$/.test(f))
const allNames = [...new Set(composeFiles.flatMap(f => composeHostnames(readFileSync(join(ROOT, f), 'utf8'))))].sort()

function litellmApiBaseRegex(): RegExp {
  const config = readFileSync(join(ROOT, 'infra', 'litellm', 'config.yaml'), 'utf8')
  const match = /- api_base: '([^']+)'/.exec(config)
  if (!match?.[1]) throw new Error('api_base regex not found in infra/litellm/config.yaml')
  return new RegExp(match[1])
}

describe('internal hostnames vs the compose files', () => {
  it('finds the compose services (sanity check of the parser)', () => {
    expect(composeFiles.length).toBeGreaterThanOrEqual(4)
    expect(allNames).toEqual(expect.arrayContaining(['app', 'litellm', 'postgres', 'valkey', 'markoto-app', 's3-init']))
  })

  it.each(allNames)('%s is on the app denylist', (name) => {
    expect(INTERNAL_HOSTNAMES.has(name)).toBe(true)
    expect(isInternalHostname(`${name}.`)).toBe(true)
    expect(isInternalHostname(name.toUpperCase())).toBe(true)
  })

  it.each(allNames)('%s is refused by the LiteLLM api_base regex (plain, trailing dot, with port)', (name) => {
    const re = litellmApiBaseRegex()
    expect(re.test(`http://${name}/v1`)).toBe(false)
    expect(re.test(`http://${name}./v1`)).toBe(false)
    expect(re.test(`http://${name}:4000/v1`)).toBe(false)
    expect(re.test(`http://${name}.:4000/v1`)).toBe(false)
  })

  it('the LiteLLM regex still accepts real provider URLs and look-alike public names', () => {
    const re = litellmApiBaseRegex()
    expect(re.test('https://api.mistral.ai/v1')).toBe(true)
    expect(re.test('https://api.openai.com/v1')).toBe(true)
    expect(re.test('https://sync.example.com/v1')).toBe(true)
    expect(re.test('https://app.example.com/v1')).toBe(true)
    expect(re.test('http://172.17.0.1:4120/v1')).toBe(true)
  })
})
