import {
  ANON_GATE_CODES,
  ANON_GATE_RETRYABLE_CODES,
  type AnonGateChallengeResponse,
  type AnonGatePurpose
} from '~~/shared/config/anonGate'
import {
  encodeAltchaPayload,
  solveAltchaChallenge,
  solverConcurrency,
  type AltchaChallenge,
  type WorkerLike
} from '~/utils/platform/altchaSolver'
import { useAnonTermsPrompt } from '~/composables/account/useAnonTermsPrompt'

// Client side of the anonymous gate (shared/config/anonGate.ts):
//   - `useAnonBotCheck(purpose)` fetches an ALTCHA challenge and solves it
//     invisibly in web workers; `take()` hands out a single-use payload
//     and starts the next solve in the background.
//   - `useAnonDocCreate()` is the one way the UI creates a document:
//     signed in / gate off → plain POST; anonymous → terms dialog (only
//     when this browser hasn't accepted the current terms yet) + a fresh
//     bot-check payload, with one automatic retry on an expired/used one.
// The dialog (`DocumentAnonGateDialog`) is driven by `useAnonTermsPrompt()`,
// which lives in its own file so CommonAppOverlays doesn't pull this module
// and its solver into every page's entry chunk.

function createSolverWorker(): WorkerLike {
  return new Worker(new URL('../../workers/altchaPbkdf2.worker.ts', import.meta.url), { type: 'module' })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isChallenge(value: unknown): value is AltchaChallenge {
  return isRecord(value) && isRecord(value.parameters)
}

/** Error code from a `$fetch` error (`data.data.code` / `data.code`). */
export function fetchErrorCode(e: unknown): string | null {
  if (!isRecord(e)) return null
  const data = e.data
  if (!isRecord(data)) return null
  if (typeof data.code === 'string') return data.code
  const inner = data.data
  return isRecord(inner) && typeof inner.code === 'string' ? inner.code : null
}

/** i18n key the server attached to a `$fetch` error (`data.data.messageKey`). */
export function fetchErrorMessageKey(e: unknown): string | null {
  if (!isRecord(e)) return null
  const data = e.data
  const inner = isRecord(data) ? data.data : null
  return isRecord(inner) && typeof inner.messageKey === 'string' ? inner.messageKey : null
}

/** Server message from a `$fetch` error (4xx bodies pass through the sanitiser). */
export function fetchErrorMessage(e: unknown): string | null {
  if (!isRecord(e)) return null
  const data = e.data
  if (isRecord(data) && typeof data.message === 'string' && data.message) return data.message
  return null
}

export function useAnonBotCheck(purpose: AnonGatePurpose) {
  const termsAccepted = ref(false)
  const solving = ref(false)
  const failed = ref(false)
  let next: Promise<string | null> | null = null

  async function solveOnce(): Promise<string | null> {
    solving.value = true
    failed.value = false
    try {
      const res = await $fetch<AnonGateChallengeResponse>('/api/anon-gate/challenge', { query: { purpose } })
      termsAccepted.value = res.termsAccepted
      if (!res.enabled) return null
      const challenge = res.challenge
      if (!isChallenge(challenge)) throw new Error('no challenge')
      const solution = await solveAltchaChallenge(challenge, {
        createWorker: createSolverWorker,
        concurrency: solverConcurrency(globalThis.navigator?.hardwareConcurrency)
      })
      if (!solution) throw new Error('unsolved')
      return encodeAltchaPayload(challenge, solution)
    } catch {
      failed.value = true
      return null
    } finally {
      solving.value = false
    }
  }

  /** Start solving in the background (idempotent while a solve is pending). */
  function prepare(): void {
    if (import.meta.server || next) return
    next = solveOnce()
  }

  /** A single-use payload (waits for the pending solve); the next one starts right away. */
  async function take(): Promise<string | null> {
    prepare()
    const current = next
    next = null
    const payload = current ? await current : null
    prepare()
    return payload
  }

  return { termsAccepted, solving, failed, prepare, take }
}

/** Thrown when the visitor closes the terms dialog — not an error to toast. */
export class AnonGateCancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'AnonGateCancelled'
  }
}

let sharedDocCheck: ReturnType<typeof useAnonBotCheck> | null = null

export function useAnonDocCreate() {
  const { loggedIn } = useUserSession()
  const { anonGate } = useInstanceConfig()
  const prompt = useAnonTermsPrompt()
  // One solver per tab, reused by the landing page, dialog and File → New.
  // Never shared across SSR requests: the server gets a throw-away instance.
  const check = import.meta.server
    ? useAnonBotCheck('doc-create')
    : (sharedDocCheck ??= useAnonBotCheck('doc-create'))

  const gated = computed(() => anonGate.value && !loggedIn.value)

  function prepare(): void {
    if (gated.value) check.prepare()
  }

  async function post(body: Record<string, unknown>): Promise<string> {
    const res = await $fetch<{ docId: string }>('/api/docs', { method: 'POST', body })
    return res.docId
  }

  /** Create a document; resolves to its id. Throws AnonGateCancelled when the visitor backs out. */
  async function createDocument(body: Record<string, unknown> = {}): Promise<string> {
    if (!gated.value) return post(body)
    check.prepare()
    // Two rounds at most: a stale remembered acceptance (terms version bumped)
    // re-asks; an expired / used / unsolved bot check fetches a fresh one.
    for (let round = 0; ; round++) {
      let acceptTerms = false
      if (!check.termsAccepted.value) {
        if (!(await prompt.ask())) throw new AnonGateCancelled()
        acceptTerms = true
      }
      try {
        const docId = await post({ ...body, altcha: await check.take(), acceptTerms })
        check.termsAccepted.value = true
        return docId
      } catch (e) {
        const code = fetchErrorCode(e)
        if (round > 0 || !code) throw e
        if (code === ANON_GATE_CODES.termsRequired) {
          check.termsAccepted.value = false
        } else if (ANON_GATE_RETRYABLE_CODES.includes(code) || code === ANON_GATE_CODES.botCheckRequired) {
          // The server checks the terms before the bot check, so a fresh
          // acceptance is already remembered (cookie) for the retry.
          if (acceptTerms) check.termsAccepted.value = true
        } else {
          throw e
        }
      }
    }
  }

  return { gated, prepare, createDocument, solving: check.solving }
}
