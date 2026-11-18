import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { effectScope, ref, type EffectScope } from 'vue'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import type { H3Event } from 'h3'
import { setResponseStatus } from 'h3'

import { useAI as useAIComposable, type AiEventSource } from '~/composables/ai/useAI'

// Signal to a registerEndpoint handler: respond with a non-2xx status
// and the given body. We can't `throw createError({...})` from the
// handler: h3's error path serializes the body as `{ statusCode,
// statusMessage, data }`, which doesn't match the shape the composable
// reads (`err.data.message`, where `err.data` IS the response body).
// Using setResponseStatus + return gives us full control over the body.
class ApiError {
  constructor(public statusCode: number, public body: unknown) {}
}
async function respond(event: H3Event, out: unknown): Promise<unknown> {
  if (out instanceof ApiError) {
    setResponseStatus(event, out.statusCode)
    return out.body
  }
  return out
}

// Composable under test: awareness-driven AI session state + prompt /
// abort actions. See app/composables/ai/useAI.ts. Selection-scoped
// requests flow through `prompt()` with an editorSelection override;
// there is no separate rewrite endpoint.
//
// External dependencies:
//   - `useUserSession()` (auto-import): mocked via mockNuxtImport, the
//     hoisted `sessionState` lets tests toggle loggedIn + user id.
//   - `$fetch('/api/ai/prompt' | '/abort')`: stubbed with
//     registerEndpoint. Each endpoint reads from a per-test config
//     holder so tests can rewrite responses without re-registering.
//
// Awareness simulation: we build a real Awareness on a real Y.Doc for
// the composable to consume, and spawn secondary Awareness objects
// representing "other clients" (the AI, a human collaborator). Their
// state is pushed into the composable's awareness via
// encodeAwarenessUpdate / applyAwarenessUpdate: the same path
// Hocuspocus would use in prod.

const { sessionState } = vi.hoisted(() => ({
  sessionState: {
    loggedIn: { value: false },
    user: { value: null as { id: number, name?: string } | null }
  }
}))

// The error texts come from the error's code (apiErrors.<ns>.<slug>), never the
// server's English message: a translation table stands in for vue-i18n.
const TEXTS: Record<string, string> = {
  'apiErrors.common.internal': 'Text for internal',
  'apiErrors.auth.forbidden': 'Text for forbidden',
  'error.generic': 'Generic text',
  'ai.step.aiRateLimited': 'Text for the rate limit step'
}
mockNuxtImport('useToast', () => () => ({ add: vi.fn() }))
mockNuxtImport('useI18n', () => () => ({
  t: (key: string) => TEXTS[key] ?? `[missing:${key}]`,
  te: (key: string) => key in TEXTS,
  locale: ref('en')
}))

mockNuxtImport('useUserSession', () => {
  return () => ({
    loggedIn: sessionState.loggedIn,
    user: sessionState.user
  })
})

interface EndpointConfig<Req = unknown, Res = unknown> {
  // Handlers return either the response body, an `ApiError` (which
  // becomes a non-2xx response with the given body), or a Promise
  // thereof. We deliberately don't `throw`, h3's error pipeline wraps
  // the body in a shape the composable doesn't expect.
  handler: (body: Req, event: H3Event) => Res | ApiError | Promise<Res | ApiError>
}
const promptEp: EndpointConfig = {
  handler: () => ({ sessionId: 'srv-sid-1' })
}
const abortEp: EndpointConfig = {
  handler: () => ({ ok: true })
}
const promptCalls: Array<{ body: unknown }> = []
const abortCalls: Array<{ body: unknown }> = []

async function readBody(event: H3Event): Promise<unknown> {
  const { readBody } = await import('h3')
  return readBody(event)
}

registerEndpoint('/api/ai/prompt', {
  method: 'POST',
  handler: async (event) => {
    const body = await readBody(event)
    promptCalls.push({ body })
    const out = await promptEp.handler(body, event)
    return respond(event, out)
  }
})
registerEndpoint('/api/ai/abort', {
  method: 'POST',
  handler: async (event) => {
    const body = await readBody(event)
    abortCalls.push({ body })
    const out = await abortEp.handler(body, event)
    return respond(event, out)
  }
})

// Private session channel (`GET /api/ai/sessions/:id`, `POST …/confirm`).
// Tests put the snapshot for a session id into `privateStatus`; ids
// without an entry answer 404 (unknown / expired session).
const privateStatus = new Map<string, Record<string, unknown>>()
const confirmCalls: Array<{ sid: string, body: unknown }> = []
/** `GET /api/ai/sessions/:id` calls per session id (request-volume checks). */
const statusGets = new Map<string, number>()
for (const sid of ['sid-1', 'sid-mine', 'srv-sid-1']) {
  registerEndpoint(`/api/ai/sessions/${sid}`, {
    method: 'GET',
    handler: async (event) => {
      statusGets.set(sid, (statusGets.get(sid) ?? 0) + 1)
      const snap = privateStatus.get(sid)
      return respond(event, snap ?? new ApiError(404, { message: 'AI session not found' }))
    }
  })
  registerEndpoint(`/api/ai/sessions/${sid}/confirm`, {
    method: 'POST',
    handler: async (event) => {
      const body = await readBody(event)
      confirmCalls.push({ sid, body })
      return respond(event, { ok: true })
    }
  })
}

function setPrivateStatus(sid: string, patch: Record<string, unknown>) {
  privateStatus.set(sid, {
    sessionId: sid,
    prompt: '',
    phase: 'thinking',
    message: null,
    step: null,
    response: null,
    confirmation: null,
    ...patch
  })
}

// Every instance runs in its own effect scope, disposed after each test,
// so no instance keeps polling / streaming into the next test.
const scopes: EffectScope[] = []
function useAI(...args: Parameters<typeof useAIComposable>): ReturnType<typeof useAIComposable> {
  const scope = effectScope(true)
  scopes.push(scope)
  const result = scope.run(() => useAIComposable(...args))
  if (!result) throw new Error('effect scope did not run')
  return result
}
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
})

/** Poll quickly in tests; these cases exercise the polling path (no stream). */
const FAST = { pollIntervalMs: 15, createEventSource: null }

/**
 * Scriptable stand-in for the browser's EventSource. `emitStatus` plays
 * a server `status` event, `emit('end')` the end of the session, and
 * `fail(closed)` an `error` event (closed = the browser gave up).
 */
class FakeEventSource implements AiEventSource {
  static readonly instances: FakeEventSource[] = []
  readyState = 1
  onerror: ((event: Event) => void) | null = null
  closed = false
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>()

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  emit(type: string, data: unknown = '{}'): void {
    for (const l of this.listeners.get(type) ?? []) l({ data })
  }

  emitStatus(sid: string, patch: Record<string, unknown>): void {
    this.emit('status', JSON.stringify({ sessionId: sid, prompt: '', phase: 'thinking', message: null, response: null, confirmation: null, ...patch }))
  }

  fail(closed: boolean): void {
    if (closed) this.readyState = 2
    this.onerror?.(new Event('error'))
  }

  close(): void {
    this.closed = true
    this.readyState = 2
  }
}

const STREAM = { pollIntervalMs: 15, createEventSource: (url: string) => new FakeEventSource(url) }

/** The single stream the composable opened. */
function onlyStream(): FakeEventSource {
  expect(FakeEventSource.instances).toHaveLength(1)
  const es = FakeEventSource.instances[0]
  if (!es) throw new Error('no stream opened')
  return es
}

// awareness helpers,
//
// Build a side Awareness, stamp a full state, encode-and-apply it onto
// `target`. The composable's `refresh()` then sees the state as if a
// remote client published it. We keep each "remote client" on its own
// Y.Doc so the client IDs don't collide.

interface AiClientState {
  isAI?: boolean
  sessionId: string
  initiatorName: string
  initiatorUserId: number
  prompt?: string
  phase?: string
  message?: string | null
  commentThreadId?: string | null
}

function pushAiClient(target: Awareness, state: AiClientState): Awareness {
  const peer = new Awareness(new Y.Doc())
  peer.setLocalStateField('user', { isAI: state.isAI !== false, name: state.initiatorName })
  peer.setLocalStateField('aiSession', {
    sessionId: state.sessionId,
    initiatorName: state.initiatorName,
    initiatorUserId: state.initiatorUserId,
    prompt: state.prompt ?? '',
    ...(state.commentThreadId ? { commentThreadId: state.commentThreadId } : {})
  })
  if (state.phase !== undefined || state.message !== undefined) {
    peer.setLocalStateField('aiStatus', {
      phase: state.phase ?? 'thinking',
      message: state.message ?? null
    })
  }
  const update = encodeAwarenessUpdate(peer, [peer.clientID])
  applyAwarenessUpdate(target, update, 'test')
  return peer
}

function removePeer(peer: Awareness, target: Awareness) {
  // Mark the peer offline by clearing its state + re-encoding. The
  // composable's `refresh()` sees the entry disappear.
  peer.setLocalState(null)
  const update = encodeAwarenessUpdate(peer, [peer.clientID])
  applyAwarenessUpdate(target, update, 'test')
}

function pushHumanClient(target: Awareness, user: { id: number, name: string }): Awareness {
  const peer = new Awareness(new Y.Doc())
  peer.setLocalStateField('user', { id: user.id, name: user.name })
  const update = encodeAwarenessUpdate(peer, [peer.clientID])
  applyAwarenessUpdate(target, update, 'test')
  return peer
}

function makeCtx() {
  const ydoc = new Y.Doc()
  const awareness = new Awareness(ydoc)
  // Drop the default local state so our "own" client doesn't get
  // accidentally flagged as AI or collide with pushed peers.
  awareness.setLocalState(null)
  const docId = ref('doc-abc')
  return { ydoc, awareness, docId }
}

beforeEach(() => {
  sessionState.loggedIn.value = false
  sessionState.user.value = null
  promptEp.handler = () => ({ sessionId: 'srv-sid-1' })
  abortEp.handler = () => ({ ok: true })
  promptCalls.length = 0
  abortCalls.length = 0
  privateStatus.clear()
  confirmCalls.length = 0
  statusGets.clear()
  FakeEventSource.instances.length = 0
})

// activeSessions: derived from awareness entries

describe('useAI: activeSessions derivation', () => {
  it('returns an empty list when no awareness entries exist', () => {
    const { awareness, docId } = makeCtx()
    const ai = useAI(docId, awareness)
    expect(ai.activeSessions.value).toEqual([])
  })

  it('ignores non-AI clients (human collaborators)', () => {
    const { awareness, docId } = makeCtx()
    pushHumanClient(awareness, { id: 1, name: 'Alice' })
    const ai = useAI(docId, awareness)
    expect(ai.activeSessions.value).toEqual([])
  })

  it('ignores AI-flagged entries without an aiSession block', () => {
    // Defensive: malformed awareness state shouldn't crash the UI.
    const { awareness, docId } = makeCtx()
    const peer = new Awareness(new Y.Doc())
    peer.setLocalStateField('user', { isAI: true, name: 'Ghost' })
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peer, [peer.clientID]), 'test')
    const ai = useAI(docId, awareness)
    expect(ai.activeSessions.value).toEqual([])
  })

  it('ignores AI entries whose aiSession is missing sessionId', () => {
    const { awareness, docId } = makeCtx()
    const peer = new Awareness(new Y.Doc())
    peer.setLocalStateField('user', { isAI: true, name: 'Ghost' })
    peer.setLocalStateField('aiSession', { initiatorName: 'Bob', initiatorUserId: 7 })
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peer, [peer.clientID]), 'test')
    const ai = useAI(docId, awareness)
    expect(ai.activeSessions.value).toEqual([])
  })

  it('surfaces a well-formed AI session with all fields populated', () => {
    const { awareness, docId } = makeCtx()
    pushAiClient(awareness, {
      sessionId: 'sid-1',
      initiatorName: 'Alice',
      initiatorUserId: 1,
      prompt: 'Draft a haiku',
      phase: 'tool',
      message: 'Searching the web'
    })
    const ai = useAI(docId, awareness)
    expect(ai.activeSessions.value).toHaveLength(1)
    // Only the public fields. Even if a (legacy / hostile) awareness
    // entry carries prompt or status text, the composable doesn't
    // surface it: that belongs to the initiator's private channel.
    expect(ai.activeSessions.value[0]).toEqual({
      sessionId: 'sid-1',
      initiatorName: 'Alice',
      initiatorUserId: 1,
      phase: 'tool',
      // commentThreadId is null for non-comment-trigger sessions; the
      // useAI composable surfaces it as null (not undefined) to keep
      // the field always-present for downstream consumers.
      commentThreadId: null
    })
  })

  it('passes commentThreadId through when the session was triggered from a comment', () => {
    const { awareness, docId } = makeCtx()
    pushAiClient(awareness, {
      sessionId: 'sid-thread',
      initiatorName: 'Joel',
      initiatorUserId: 7,
      prompt: '@ai please rewrite',
      phase: 'thinking',
      commentThreadId: 'cmt_abc123'
    })
    const ai = useAI(docId, awareness)
    expect(ai.activeSessions.value[0]?.commentThreadId).toBe('cmt_abc123')
  })

  it('defaults phase to "thinking" when aiStatus is absent', () => {
    const { awareness, docId } = makeCtx()
    // Omit status entirely.
    const peer = new Awareness(new Y.Doc())
    peer.setLocalStateField('user', { isAI: true })
    peer.setLocalStateField('aiSession', {
      sessionId: 'sid-1', initiatorName: 'A', initiatorUserId: 1
    })
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peer, [peer.clientID]), 'test')
    const ai = useAI(docId, awareness)
    expect(ai.activeSessions.value[0]?.phase).toBe('thinking')
  })

  it('reacts to awareness changes (new client appears → list updates)', async () => {
    const { awareness, docId } = makeCtx()
    const ai = useAI(docId, awareness)
    expect(ai.activeSessions.value).toHaveLength(0)

    pushAiClient(awareness, {
      sessionId: 'sid-1', initiatorName: 'A', initiatorUserId: 1
    })
    // Awareness 'change' events fire synchronously, refresh() already ran.
    expect(ai.activeSessions.value).toHaveLength(1)
  })

  it('reacts to awareness changes (client disappears → list shrinks)', () => {
    const { awareness, docId } = makeCtx()
    const peer = pushAiClient(awareness, {
      sessionId: 'sid-1', initiatorName: 'A', initiatorUserId: 1
    })
    const ai = useAI(docId, awareness)
    expect(ai.activeSessions.value).toHaveLength(1)

    removePeer(peer, awareness)
    expect(ai.activeSessions.value).toHaveLength(0)
  })

  it('surfaces multiple concurrent AI sessions', () => {
    const { awareness, docId } = makeCtx()
    pushAiClient(awareness, { sessionId: 'sid-a', initiatorName: 'Alice', initiatorUserId: 1 })
    pushAiClient(awareness, { sessionId: 'sid-b', initiatorName: 'Bob', initiatorUserId: 2 })
    const ai = useAI(docId, awareness)
    const ids = ai.activeSessions.value.map(s => s.sessionId).sort()
    expect(ids).toEqual(['sid-a', 'sid-b'])
  })
})

// mySession / mySessionId / otherSessions, user-relative derivations

describe('useAI: mySession / otherSessions', () => {
  it('mySessionId is null when anonymous (loggedIn false)', () => {
    const { awareness, docId } = makeCtx()
    pushAiClient(awareness, { sessionId: 'sid-1', initiatorName: 'A', initiatorUserId: 1 })
    const ai = useAI(docId, awareness)
    expect(ai.mySessionId.value).toBe(null)
    expect(ai.mySession.value).toBe(null)
  })

  it('mySessionId is null when logged-in but no AI matches my user id', () => {
    sessionState.loggedIn.value = true
    sessionState.user.value = { id: 99 }
    const { awareness, docId } = makeCtx()
    pushAiClient(awareness, { sessionId: 'sid-1', initiatorName: 'A', initiatorUserId: 1 })
    const ai = useAI(docId, awareness)
    expect(ai.mySessionId.value).toBe(null)
    expect(ai.mySession.value).toBe(null)
  })

  it('mySessionId matches the AI whose initiatorUserId equals my id', () => {
    sessionState.loggedIn.value = true
    sessionState.user.value = { id: 7 }
    const { awareness, docId } = makeCtx()
    pushAiClient(awareness, { sessionId: 'sid-mine', initiatorName: 'Me', initiatorUserId: 7 })
    pushAiClient(awareness, { sessionId: 'sid-theirs', initiatorName: 'Other', initiatorUserId: 8 })
    const ai = useAI(docId, awareness)
    expect(ai.mySessionId.value).toBe('sid-mine')
    expect(ai.mySession.value?.sessionId).toBe('sid-mine')
  })

  it('otherSessions excludes my session when logged in', () => {
    sessionState.loggedIn.value = true
    sessionState.user.value = { id: 7 }
    const { awareness, docId } = makeCtx()
    pushAiClient(awareness, { sessionId: 'sid-mine', initiatorName: 'Me', initiatorUserId: 7 })
    pushAiClient(awareness, { sessionId: 'sid-theirs', initiatorName: 'Other', initiatorUserId: 8 })
    const ai = useAI(docId, awareness)
    const ids = ai.otherSessions.value.map(s => s.sessionId).sort()
    expect(ids).toEqual(['sid-theirs'])
  })

  it('otherSessions equals activeSessions when anonymous', () => {
    // Anonymous viewers see everyone's AI work, there is no "mine".
    const { awareness, docId } = makeCtx()
    pushAiClient(awareness, { sessionId: 'sid-1', initiatorName: 'A', initiatorUserId: 1 })
    pushAiClient(awareness, { sessionId: 'sid-2', initiatorName: 'B', initiatorUserId: 2 })
    const ai = useAI(docId, awareness)
    expect(ai.otherSessions.value.length).toBe(ai.activeSessions.value.length)
    expect(ai.otherSessions.value.length).toBe(2)
  })
})

// Private session channel: status text, errors, answers, confirmations

describe('useAI: private session channel', () => {
  it('merges my private status text into mySession; awareness alone has none', async () => {
    sessionState.loggedIn.value = true
    sessionState.user.value = { id: 7 }
    const { awareness, docId } = makeCtx()
    setPrivateStatus('sid-mine', { prompt: 'Draft a haiku', phase: 'tool', message: 'Reading "Q3 plan"…' })
    pushAiClient(awareness, { sessionId: 'sid-mine', initiatorName: 'Me', initiatorUserId: 7, phase: 'tool' })
    const ai = useAI(docId, awareness, FAST)
    await vi.waitFor(() => expect(ai.mySession.value?.message).toBe('Reading "Q3 plan"…'))
    expect(ai.mySession.value?.prompt).toBe('Draft a haiku')
  })

  it('never polls another person\'s session', async () => {
    sessionState.loggedIn.value = true
    sessionState.user.value = { id: 7 }
    const { awareness, docId } = makeCtx()
    setPrivateStatus('sid-1', { phase: 'error', message: 'Not yours' })
    pushAiClient(awareness, { sessionId: 'sid-1', initiatorName: 'Other', initiatorUserId: 8 })
    const ai = useAI(docId, awareness, FAST)
    await new Promise(r => setTimeout(r, 80))
    expect(ai.mySession.value).toBe(null)
    expect(ai.lastError.value).toBe(null)
  })

  it('captures an error from the channel, without the "Error: " prefix', async () => {
    sessionState.loggedIn.value = true
    sessionState.user.value = { id: 7 }
    const { awareness, docId } = makeCtx()
    setPrivateStatus('sid-mine', { phase: 'thinking' })
    pushAiClient(awareness, { sessionId: 'sid-mine', initiatorName: 'Me', initiatorUserId: 7 })
    const ai = useAI(docId, awareness, FAST)
    setPrivateStatus('sid-mine', { phase: 'error', message: 'Error: Rate limit exceeded' })
    await vi.waitFor(() => expect(ai.lastError.value).toBe('Rate limit exceeded'))
  })

  it('an error with a step code reads in the UI language, not the server\'s English', async () => {
    sessionState.loggedIn.value = true
    sessionState.user.value = { id: 7 }
    const { awareness, docId } = makeCtx()
    setPrivateStatus('sid-mine', { phase: 'thinking' })
    pushAiClient(awareness, { sessionId: 'sid-mine', initiatorName: 'Me', initiatorUserId: 7 })
    const ai = useAI(docId, awareness, FAST)
    setPrivateStatus('sid-mine', { phase: 'error', message: 'Error: Too many AI requests in a short time.', step: { key: 'aiRateLimited' } })
    await vi.waitFor(() => expect(ai.lastError.value).toBe('Text for the rate limit step'))
    expect(ai.mySession.value?.step).toEqual({ key: 'aiRateLimited' })
  })

  it('reads the final state once more after the session leaves awareness, and keeps the error', async () => {
    sessionState.loggedIn.value = true
    sessionState.user.value = { id: 7 }
    const { awareness, docId } = makeCtx()
    setPrivateStatus('sid-mine', { phase: 'thinking' })
    const peer = pushAiClient(awareness, { sessionId: 'sid-mine', initiatorName: 'Me', initiatorUserId: 7 })
    const ai = useAI(docId, awareness, { pollIntervalMs: 5_000, createEventSource: null })
    // The error lands between polls; the session then leaves.
    setPrivateStatus('sid-mine', { phase: 'error', message: 'Kaboom' })
    removePeer(peer, awareness)
    await vi.waitFor(() => expect(ai.lastError.value).toBe('Kaboom'))
    expect(ai.mySession.value).toBe(null)
  })

  it('does NOT set lastError when the session completes normally', async () => {
    sessionState.loggedIn.value = true
    sessionState.user.value = { id: 7 }
    const { awareness, docId } = makeCtx()
    setPrivateStatus('sid-mine', { phase: 'done', message: 'Done' })
    pushAiClient(awareness, { sessionId: 'sid-mine', initiatorName: 'Me', initiatorUserId: 7 })
    const ai = useAI(docId, awareness, FAST)
    await vi.waitFor(() => expect(ai.mySession.value?.message).toBe('Done'))
    expect(ai.lastError.value).toBe(null)
  })

  it('records how my session ended, done', async () => {
    sessionState.loggedIn.value = true
    sessionState.user.value = { id: 7 }
    const { awareness, docId } = makeCtx()
    setPrivateStatus('sid-mine', { phase: 'thinking' })
    pushAiClient(awareness, { sessionId: 'sid-mine', initiatorName: 'Me', initiatorUserId: 7 })
    const ai = useAI(docId, awareness, FAST)
    expect(ai.lastOutcome.value).toBe(null)
    setPrivateStatus('sid-mine', { phase: 'done', message: 'Done' })
    await vi.waitFor(() => expect(ai.lastOutcome.value).toEqual({ sessionId: 'sid-mine', phase: 'done', message: 'Done' }))
  })

  it('records how my session ended, error, kept after the session leaves awareness', async () => {
    sessionState.loggedIn.value = true
    sessionState.user.value = { id: 7 }
    const { awareness, docId } = makeCtx()
    setPrivateStatus('sid-mine', { phase: 'thinking' })
    const peer = pushAiClient(awareness, { sessionId: 'sid-mine', initiatorName: 'Me', initiatorUserId: 7 })
    const ai = useAI(docId, awareness, { pollIntervalMs: 5_000, createEventSource: null })
    setPrivateStatus('sid-mine', { phase: 'error', message: 'Hit turn limit' })
    removePeer(peer, awareness)
    await vi.waitFor(() => expect(ai.lastOutcome.value).toEqual({ sessionId: 'sid-mine', phase: 'error', message: 'Hit turn limit' }))
  })

  it('latches a message_to_user answer from the channel', async () => {
    sessionState.loggedIn.value = true
    sessionState.user.value = { id: 7 }
    const { awareness, docId } = makeCtx()
    setPrivateStatus('sid-mine', { response: { message: 'Section 2 repeats section 1.', isQuestion: false, ts: 42 } })
    pushAiClient(awareness, { sessionId: 'sid-mine', initiatorName: 'Me', initiatorUserId: 7 })
    const ai = useAI(docId, awareness, FAST)
    await vi.waitFor(() => expect(ai.lastResponse.value?.message).toBe('Section 2 repeats section 1.'))
    expect(ai.lastResponse.value).toMatchObject({ sessionId: 'sid-mine', isQuestion: false, ts: 42 })
  })

  it('starts polling as soon as /api/ai/prompt returns, before the AI joins awareness', async () => {
    sessionState.loggedIn.value = true
    sessionState.user.value = { id: 7 }
    const { awareness, docId } = makeCtx()
    setPrivateStatus('srv-sid-1', { phase: 'error', message: 'No chat provider' })
    const ai = useAI(docId, awareness, FAST)
    await ai.prompt('hello')
    await vi.waitFor(() => expect(ai.lastError.value).toBe('No chat provider'))
  })

  it('exposes a pending confirmation and posts the answer', async () => {
    sessionState.loggedIn.value = true
    sessionState.user.value = { id: 7 }
    const { awareness, docId } = makeCtx()
    const confirmation = { id: 'conf-1', tool: 'view_other_document', target: 'Q3 plan', expiresAt: Date.now() + 60_000 }
    setPrivateStatus('sid-mine', { phase: 'tool', confirmation })
    pushAiClient(awareness, { sessionId: 'sid-mine', initiatorName: 'Me', initiatorUserId: 7, phase: 'tool' })
    const ai = useAI(docId, awareness, FAST)
    await vi.waitFor(() => expect(ai.pendingConfirmation.value).toEqual(confirmation))

    // Server clears the request once answered.
    setPrivateStatus('sid-mine', { phase: 'tool' })
    await ai.answerConfirmation(false)
    expect(confirmCalls).toEqual([{ sid: 'sid-mine', body: { confirmationId: 'conf-1', allow: false } }])
    expect(ai.pendingConfirmation.value).toBe(null)
  })

  it('a deny carries the typed note; an allow never does', async () => {
    sessionState.loggedIn.value = true
    sessionState.user.value = { id: 7 }
    const { awareness, docId } = makeCtx()
    const confirmation = { id: 'conf-2', tool: 'web_search', target: 'q', expiresAt: Date.now() + 60_000 }
    setPrivateStatus('sid-mine', { phase: 'tool', confirmation })
    pushAiClient(awareness, { sessionId: 'sid-mine', initiatorName: 'Me', initiatorUserId: 7, phase: 'tool' })
    const ai = useAI(docId, awareness, FAST)
    await vi.waitFor(() => expect(ai.pendingConfirmation.value).toEqual(confirmation))
    await ai.answerConfirmation(false, '  search the knowledge base  ')
    expect(confirmCalls).toEqual([{ sid: 'sid-mine', body: { confirmationId: 'conf-2', allow: false, note: 'search the knowledge base' } }])

    confirmCalls.length = 0
    setPrivateStatus('sid-mine', { phase: 'tool', confirmation: { ...confirmation, id: 'conf-3' } })
    await vi.waitFor(() => expect(ai.pendingConfirmation.value?.id).toBe('conf-3'))
    await ai.answerConfirmation(true, 'ignored')
    expect(confirmCalls).toEqual([{ sid: 'sid-mine', body: { confirmationId: 'conf-3', allow: true } }])
  })
})

describe('useAI: push stream (SSE) for my session', () => {
  function mine() {
    sessionState.loggedIn.value = true
    sessionState.user.value = { id: 7 }
    const ctx = makeCtx()
    const peer = pushAiClient(ctx.awareness, { sessionId: 'sid-mine', initiatorName: 'Me', initiatorUserId: 7, phase: 'thinking' })
    return { ...ctx, peer }
  }

  it('follows my session through the stream, no polling while it works', async () => {
    const { awareness, docId } = mine()
    const ai = useAI(docId, awareness, STREAM)
    expect(FakeEventSource.instances.map(e => e.url)).toEqual(['/api/ai/sessions/sid-mine/stream'])
    const es = onlyStream()
    es.emitStatus('sid-mine', { prompt: 'Draft a haiku', phase: 'tool', message: 'Reading "Q3 plan"…' })
    expect(ai.mySession.value?.message).toBe('Reading "Q3 plan"…')
    expect(ai.mySession.value?.prompt).toBe('Draft a haiku')
    const confirmation = { id: 'conf-1', tool: 'web_search', target: 'q', expiresAt: Date.now() + 60_000 }
    es.emitStatus('sid-mine', { phase: 'tool', confirmation })
    expect(ai.pendingConfirmation.value).toEqual(confirmation)
    es.emitStatus('sid-mine', { phase: 'tool', response: { message: 'Here you go.', isQuestion: true, ts: 9 } })
    expect(ai.lastResponse.value).toMatchObject({ sessionId: 'sid-mine', message: 'Here you go.', isQuestion: true, ts: 9 })
    es.emitStatus('sid-mine', { phase: 'error', message: 'Error: Kaboom' })
    expect(ai.lastError.value).toBe('Kaboom')
    await new Promise(r => setTimeout(r, 60))
    expect(statusGets.get('sid-mine') ?? 0).toBe(0)
  })

  it('ignores malformed events', () => {
    const { awareness, docId } = mine()
    const ai = useAI(docId, awareness, STREAM)
    const es = onlyStream()
    es.emit('status', 'not json')
    es.emit('status', JSON.stringify({ phase: 'tool' }))
    expect(ai.mySession.value?.message).toBe(null)
  })

  it('closes the stream on `end` and does not reconnect', async () => {
    const { awareness, docId } = mine()
    useAI(docId, awareness, STREAM)
    const es = onlyStream()
    es.emitStatus('sid-mine', { phase: 'done', message: 'Done' })
    es.emit('end')
    expect(es.closed).toBe(true)
    await new Promise(r => setTimeout(r, 60))
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(statusGets.get('sid-mine') ?? 0).toBe(0)
  })

  it('falls back to polling when the browser gives up on the stream', async () => {
    const { awareness, docId } = mine()
    setPrivateStatus('sid-mine', { phase: 'tool', message: 'From the poll' })
    const ai = useAI(docId, awareness, STREAM)
    const es = onlyStream()
    es.fail(true)
    expect(es.closed).toBe(true)
    await vi.waitFor(() => expect(ai.mySession.value?.message).toBe('From the poll'))
    expect(statusGets.get('sid-mine') ?? 0).toBeGreaterThan(0)
  })

  it('keeps the stream through transient errors, falls back after repeated ones', async () => {
    const { awareness, docId } = mine()
    setPrivateStatus('sid-mine', { phase: 'tool', message: 'From the poll' })
    const ai = useAI(docId, awareness, STREAM)
    const es = onlyStream()
    es.fail(false)
    es.fail(false)
    es.emitStatus('sid-mine', { phase: 'tool', message: 'Streamed' }) // resets the error count
    es.fail(false)
    es.fail(false)
    expect(es.closed).toBe(false)
    expect(ai.mySession.value?.message).toBe('Streamed')
    es.fail(false)
    expect(es.closed).toBe(true)
    await vi.waitFor(() => expect(ai.mySession.value?.message).toBe('From the poll'))
  })

  it('never opens a stream for another person\'s session', async () => {
    sessionState.loggedIn.value = true
    sessionState.user.value = { id: 7 }
    const { awareness, docId } = makeCtx()
    pushAiClient(awareness, { sessionId: 'sid-1', initiatorName: 'Other', initiatorUserId: 8 })
    useAI(docId, awareness, STREAM)
    await new Promise(r => setTimeout(r, 40))
    expect(FakeEventSource.instances).toHaveLength(0)
    expect(statusGets.get('sid-1') ?? 0).toBe(0)
  })

  it('reads the final state once more after the session leaves awareness', async () => {
    const { awareness, docId, peer } = mine()
    const ai = useAI(docId, awareness, STREAM)
    const es = onlyStream()
    setPrivateStatus('sid-mine', { phase: 'error', message: 'Late error' })
    removePeer(peer, awareness)
    await vi.waitFor(() => expect(es.closed).toBe(true))
    await vi.waitFor(() => expect(ai.lastError.value).toBe('Late error'))
    expect(statusGets.get('sid-mine')).toBe(1)
  })

  it('request volume: one stream instead of a request every 600 ms', async () => {
    // The same 3-second session (an update every 300 ms), followed once
    // with the default 600 ms polling and once with the stream.
    const SESSION_MS = 3_000
    const UPDATE_MS = 300
    async function runSession(options: Parameters<typeof useAI>[2]): Promise<{ gets: number, streams: number }> {
      statusGets.clear()
      FakeEventSource.instances.length = 0
      const { awareness, docId, peer } = mine()
      setPrivateStatus('sid-mine', { phase: 'thinking' })
      useAI(docId, awareness, options)
      for (let t = UPDATE_MS; t <= SESSION_MS; t += UPDATE_MS) {
        await new Promise(r => setTimeout(r, UPDATE_MS))
        const patch = { phase: 'tool', message: `step ${t}` }
        setPrivateStatus('sid-mine', patch)
        for (const es of FakeEventSource.instances) es.emitStatus('sid-mine', patch)
      }
      removePeer(peer, awareness)
      await new Promise(r => setTimeout(r, 50))
      return { gets: statusGets.get('sid-mine') ?? 0, streams: FakeEventSource.instances.length }
    }
    const polled = await runSession({ createEventSource: null })
    const streamed = await runSession({ createEventSource: (url: string) => new FakeEventSource(url) })
    // Polling: one request on start + one per 600 ms + one final read.
    expect(polled.streams).toBe(0)
    expect(polled.gets).toBeGreaterThanOrEqual(5)
    // Stream: one long-lived request + the final read after the session left.
    expect(streamed).toEqual({ gets: 1, streams: 1 })
    console.info(`[useAI request volume] ${SESSION_MS} ms session: polling ${polled.gets} requests, stream ${streamed.streams} stream + ${streamed.gets} request`)
  }, 15_000)
})

// prompt(): submit gating + POST shape + error capture

describe('useAI: prompt()', () => {
  it('rejects an empty string without hitting the server', async () => {
    const { awareness, docId } = makeCtx()
    const ai = useAI(docId, awareness)
    const ok = await ai.prompt('')
    expect(ok).toBe(false)
    expect(promptCalls).toHaveLength(0)
  })

  it('rejects a whitespace-only string without hitting the server', async () => {
    const { awareness, docId } = makeCtx()
    const ai = useAI(docId, awareness)
    const ok = await ai.prompt('   \n\t  ')
    expect(ok).toBe(false)
    expect(promptCalls).toHaveLength(0)
  })

  it('trims the prompt before sending', async () => {
    const { awareness, docId } = makeCtx()
    const ai = useAI(docId, awareness)
    await ai.prompt('   hello there   ')
    expect(promptCalls).toHaveLength(1)
    expect((promptCalls[0]!.body as { prompt: string }).prompt).toBe('hello there')
  })

  it('forwards docId.value in the POST body (not the ref itself)', async () => {
    const { awareness, docId } = makeCtx()
    docId.value = 'doc-xyz'
    const ai = useAI(docId, awareness)
    await ai.prompt('hi')
    expect((promptCalls[0]!.body as { docId: string }).docId).toBe('doc-xyz')
  })

  it('returns true on success', async () => {
    const { awareness, docId } = makeCtx()
    const ai = useAI(docId, awareness)
    const ok = await ai.prompt('hi')
    expect(ok).toBe(true)
  })

  it('returns false and captures the code\'s text from a server error, not its English message', async () => {
    promptEp.handler = () => new ApiError(500, { message: 'Service unavailable', code: 'internal' })
    const { awareness, docId } = makeCtx()
    const ai = useAI(docId, awareness)
    const ok = await ai.prompt('hi')
    expect(ok).toBe(false)
    expect(ai.lastError.value).toBe('Text for internal')
  })

  it('falls back to the generic text when the error carries no code', async () => {
    promptEp.handler = () => new ApiError(418, { message: 'English only' })
    const { awareness, docId } = makeCtx()
    const ai = useAI(docId, awareness)
    await ai.prompt('hi')
    expect(ai.lastError.value).toBe('Generic text')
  })

  it('blocks a second submit while the first is in flight', async () => {
    // Gate the handler on a resolvable promise so the first call stays
    // pending while we fire the second.
    let resolveGate: () => void = () => {}
    const gate = new Promise<void>((res) => {
      resolveGate = res
    })
    promptEp.handler = async () => {
      await gate
      return { sessionId: 'done' }
    }

    const { awareness, docId } = makeCtx()
    const ai = useAI(docId, awareness)
    const firstPromise = ai.prompt('one')
    // `submitting` flips true synchronously in the composable, so the
    // second call bails on the guard before fetching, `second === false`
    // without waiting for any HTTP round trip.
    expect(ai.submitting.value).toBe(true)
    const second = await ai.prompt('two')
    expect(second).toBe(false)

    resolveGate()
    await firstPromise
    // Only ONE request ever reached the server.
    expect(promptCalls).toHaveLength(1)
  })

  it('blocks a new prompt while I already have a live session on the doc', async () => {
    sessionState.loggedIn.value = true
    sessionState.user.value = { id: 7 }
    const { awareness, docId } = makeCtx()
    pushAiClient(awareness, {
      sessionId: 'sid-1', initiatorName: 'Me', initiatorUserId: 7
    })
    const ai = useAI(docId, awareness)
    // The per-user-per-doc cap is enforced server-side, but the client
    // shouldn't even try: it skips when mySessionId is already set.
    const ok = await ai.prompt('new request')
    expect(ok).toBe(false)
    expect(promptCalls).toHaveLength(0)
  })

  it('clears lastError on a fresh submit', async () => {
    promptEp.handler = () => new ApiError(500, { message: 'first failure', code: 'internal' })
    const { awareness, docId } = makeCtx()
    const ai = useAI(docId, awareness)
    await ai.prompt('one')
    expect(ai.lastError.value).toBe('Text for internal')

    promptEp.handler = () => ({ sessionId: 'ok' })
    await ai.prompt('two')
    expect(ai.lastError.value).toBe(null)
  })

  it('calls getEditorSelection exactly once per prompt and forwards the snapshot', async () => {
    const snapshot = { kind: 'selection', fromLine: 1, toLine: 1, text: 'foo', truncated: false } as const
    const getter = vi.fn(() => snapshot)
    const { awareness, docId } = makeCtx()
    const ai = useAI(docId, awareness, { getEditorSelection: getter })
    await ai.prompt('hi')
    expect(getter).toHaveBeenCalledTimes(1)
    expect((promptCalls[0]!.body as { editorSelection: unknown }).editorSelection)
      .toEqual(snapshot)
  })

  it('omits editorSelection when no getter is provided', async () => {
    const { awareness, docId } = makeCtx()
    const ai = useAI(docId, awareness)
    await ai.prompt('hi')
    const body = promptCalls[0]!.body as Record<string, unknown>
    // `editorSelection` is sent as `undefined`; JSON.stringify drops it, so
    // the received body simply doesn't include it.
    expect(body).not.toHaveProperty('editorSelection')
  })
})

// Selection-scoped requests flow through prompt() with an
// editorSelection override: covered by `passes editorSelection
// through to the request body` above. No separate rewrite path.

// abort(): 404 race tolerance + no-session guard

describe('useAI: abort()', () => {
  it('is a no-op when there is no active session of mine', async () => {
    const { awareness, docId } = makeCtx()
    const ai = useAI(docId, awareness)
    await ai.abort()
    expect(abortCalls).toHaveLength(0)
  })

  it('POSTs /api/ai/abort with my sessionId when I have one', async () => {
    sessionState.loggedIn.value = true
    sessionState.user.value = { id: 7 }
    const { awareness, docId } = makeCtx()
    pushAiClient(awareness, {
      sessionId: 'sid-mine', initiatorName: 'Me', initiatorUserId: 7
    })
    const ai = useAI(docId, awareness)

    await ai.abort()
    expect(abortCalls).toHaveLength(1)
    expect(abortCalls[0]!.body).toEqual({ sessionId: 'sid-mine' })
  })

  it('swallows a 404 (session already finished between read and send)', async () => {
    sessionState.loggedIn.value = true
    sessionState.user.value = { id: 7 }
    const { awareness, docId } = makeCtx()
    pushAiClient(awareness, {
      sessionId: 'sid-mine', initiatorName: 'Me', initiatorUserId: 7
    })
    abortEp.handler = () => new ApiError(404, { message: 'Session not found' })
    const ai = useAI(docId, awareness)

    await ai.abort()
    expect(ai.lastError.value).toBe(null)
  })

  it('captures non-404 errors in lastError', async () => {
    sessionState.loggedIn.value = true
    sessionState.user.value = { id: 7 }
    const { awareness, docId } = makeCtx()
    pushAiClient(awareness, {
      sessionId: 'sid-mine', initiatorName: 'Me', initiatorUserId: 7
    })
    abortEp.handler = () => new ApiError(403, { message: 'Not the initiator', code: 'auth/forbidden' })
    const ai = useAI(docId, awareness)

    await ai.abort()
    expect(ai.lastError.value).toBe('Text for forbidden')
  })
})

// clearLastError + submitting + general state contract

describe('useAI: clearLastError + submitting', () => {
  it('clearLastError resets lastError to null', async () => {
    promptEp.handler = () => new ApiError(500, { message: 'boom', code: 'internal' })
    const { awareness, docId } = makeCtx()
    const ai = useAI(docId, awareness)
    await ai.prompt('hi')
    expect(ai.lastError.value).toBe('Text for internal')

    ai.clearLastError()
    expect(ai.lastError.value).toBe(null)
  })

  it('submitting flips true during in-flight prompt and back to false afterwards', async () => {
    // Gate the handler on a promise we resolve from the test. We can't
    // capture `release` inside the handler factory and call it from the
    // test body: $fetch is async, so the handler hasn't run yet when
    // the test reaches `release()`. Instead, the handler awaits a
    // module-scoped gate that the test can resolve at any point.
    let resolveGate: () => void = () => {}
    const gate = new Promise<void>((res) => {
      resolveGate = res
    })
    promptEp.handler = async () => {
      await gate
      return { sessionId: 'ok' }
    }

    const { awareness, docId } = makeCtx()
    const ai = useAI(docId, awareness)
    expect(ai.submitting.value).toBe(false)

    const pending = ai.prompt('hello')
    // `submitting` flips true synchronously in the composable (before
    // the first `await`), so we can read it immediately.
    expect(ai.submitting.value).toBe(true)

    resolveGate()
    await pending
    expect(ai.submitting.value).toBe(false)
  })

  it('submitting returns to false even when the server errors', async () => {
    promptEp.handler = () => new ApiError(500, { message: 'boom', code: 'internal' })
    const { awareness, docId } = makeCtx()
    const ai = useAI(docId, awareness)
    await ai.prompt('hi')
    expect(ai.submitting.value).toBe(false)
  })
})
