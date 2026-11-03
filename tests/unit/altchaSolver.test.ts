import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { solveChallenge, type Challenge } from 'altcha-lib'
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2'
import {
  encodeAltchaPayload,
  solveAltchaChallenge,
  solverConcurrency,
  type WorkerLike
} from '../../app/utils/altchaSolver'
import {
  TEST_DIFFICULTY,
  createAnonChallenge,
  deriveAltchaSecrets,
  verifyAnonSolution
} from '../../server/utils/anonGate/altcha'
import { buildAppCsp } from '../../server/utils/csp'

// Browser solver (app/utils/altchaSolver.ts) against the real server
// verifier: an in-process stand-in speaks the ALTCHA worker protocol
// (`work` with counterStart/counterStep, `abort`), so the pool logic and
// the payload encoding are exercised end to end.

const ROOT = resolve(__dirname, '../..')
const secrets = deriveAltchaSecrets('solver-test-master-key-0123456789abcdef')

function inProcessWorker(log: string[], challenge: Challenge): WorkerLike {
  const listeners: Array<(event: { data?: unknown }) => void> = []
  let controller: AbortController | null = null
  return {
    addEventListener(type, listener) {
      if (type === 'message') listeners.push(listener)
    },
    postMessage(message) {
      if (typeof message !== 'object' || message === null) return
      const m = message as Record<string, unknown>
      log.push(String(m.type))
      if (m.type === 'abort') {
        controller?.abort()
        return
      }
      controller = new AbortController()
      void solveChallenge({
        challenge,
        deriveKey,
        controller,
        counterStart: Number(m.counterStart),
        counterStep: Number(m.counterStep)
      }).then(solution => listeners.forEach(l => l({ data: solution })))
    },
    terminate() {
      log.push('terminate')
      controller?.abort()
    }
  }
}

describe('solveAltchaChallenge', () => {
  it('solves a real challenge with a worker pool and the server accepts the payload', async () => {
    const challenge = await createAnonChallenge(secrets, 'doc-create', TEST_DIFFICULTY)
    const log: string[] = []
    const solution = await solveAltchaChallenge(challenge, { createWorker: () => inProcessWorker(log, challenge), concurrency: 3 })
    expect(solution).not.toBeNull()
    if (!solution) return
    const payload = encodeAltchaPayload(challenge, solution)
    const used = new Set<string>()
    const outcome = await verifyAnonSolution(payload, 'doc-create', secrets, {
      claimOnce: async (id) => {
        if (used.has(id)) return false
        used.add(id)
        return true
      }
    })
    expect(outcome).toEqual({ ok: true })
    // every worker got work, all were stopped once one found the key
    expect(log.filter(e => e === 'work')).toHaveLength(3)
    expect(log.filter(e => e === 'terminate')).toHaveLength(3)
  })

  it('resolves null when every worker gives up', async () => {
    const quitter: () => WorkerLike = () => {
      const listeners: Array<(event: { data?: unknown }) => void> = []
      return {
        addEventListener: (type, l) => {
          if (type === 'message') listeners.push(l)
        },
        postMessage: (m) => {
          if (typeof m === 'object' && m !== null && 'type' in m && m.type === 'work') {
            queueMicrotask(() => listeners.forEach(l => l({ data: null })))
          }
        },
        terminate: () => {}
      }
    }
    const challenge = await createAnonChallenge(secrets, 'doc-create', TEST_DIFFICULTY)
    expect(await solveAltchaChallenge(challenge, { createWorker: quitter, concurrency: 2 })).toBeNull()
  })

  it('picks a modest worker count', () => {
    expect(solverConcurrency(undefined)).toBe(1)
    expect(solverConcurrency(1)).toBe(1)
    expect(solverConcurrency(8)).toBe(4)
    expect(solverConcurrency(32)).toBe(4)
  })
})

describe('ALTCHA worker under our CSP', () => {
  it('the bundled solver is the official PBKDF2 worker, imported (not fetched from a CDN)', () => {
    const src = readFileSync(resolve(ROOT, 'app/workers/altchaPbkdf2.worker.ts'), 'utf8')
    expect(src).toMatch(/import 'altcha\/workers\/pbkdf2'/)
  })

  it('the worker code needs no eval and loads nothing remote', () => {
    const worker = readFileSync(resolve(ROOT, 'node_modules/altcha/dist/workers/pbkdf2.js'), 'utf8')
    expect(worker).not.toMatch(/\beval\s*\(/)
    expect(worker).not.toMatch(/new Function\s*\(/)
    expect(worker).not.toMatch(/importScripts\s*\(/)
    expect(worker).not.toMatch(/https?:\/\//)
    expect(worker).toContain('crypto.subtle.deriveBits')
  })

  it('the app policy lets a same-origin worker run, without unsafe-eval', () => {
    const policy = buildAppCsp({ nonce: 'dGVzdC1ub25jZS0xMjM0NTY3OA==' })
    const directive = (name: string) => policy.split('; ').find(d => d.startsWith(`${name} `)) ?? ''
    expect(directive('worker-src').split(' ')).toContain('\'self\'')
    expect(directive('script-src')).not.toContain('\'unsafe-eval\'')
    // the challenge + verification endpoints are same-origin
    expect(directive('connect-src').split(' ')).toContain('\'self\'')
  })
})
