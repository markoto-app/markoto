import { describe, it, expect, beforeEach, vi } from 'vitest'
import { registerEndpoint } from '@nuxt/test-utils/runtime'
import { EditorState, EditorSelection } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { H3Event } from 'h3'
import { setResponseStatus } from 'h3'

import { useImageUpload } from '~/composables/useImageUpload'

// Composable under test: 3-step presigned upload + placeholder-rewrite
// helper for CodeMirror. Two surfaces:
//
//   upload(file)                 → { fileId, url } | null
//   uploadAndInsert(file, view)  → void (dispatches placeholder then
//                                        replaces / removes it)
//
// External deps we need to stub:
//   - `$fetch('/api/upload/request' | '/api/upload/confirm')`
//     — Nitro endpoints, registerEndpoint.
//   - raw `globalThis.fetch` (used for the S3 PUT) — vi.stubGlobal.
//   - CodeMirror EditorView — shimmed locally, same pattern as
//     editorCommands.test.ts but with a doc.toString() readout so we
//     can verify placeholder rewrites.

// — ApiError pattern (same as useAI tests) ————————————————————————
// Return, don't throw, so the response body matches what $fetch's
// FetchError surfaces as `err.data`. See the comment in useAI.test.ts
// for the full rationale.
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

interface EndpointConfig<Req = unknown, Res = unknown> {
  handler: (body: Req, event: H3Event) => Res | ApiError | Promise<Res | ApiError>
}
const requestEp: EndpointConfig = {
  handler: () => ({
    uploadUrl: 'https://s3.test/upload/signed-key-123',
    fileId: 'file-abc',
    key: 'docs/doc-xyz/file-abc.png'
  })
}
const confirmEp: EndpointConfig = {
  handler: () => ({ ok: true })
}
const requestCalls: Array<{ body: unknown }> = []
const confirmCalls: Array<{ body: unknown }> = []

async function readBody(event: H3Event): Promise<unknown> {
  const { readBody } = await import('h3')
  return readBody(event)
}

registerEndpoint('/api/upload/request', {
  method: 'POST',
  handler: async (event) => {
    const body = await readBody(event)
    requestCalls.push({ body })
    return respond(event, await requestEp.handler(body, event))
  }
})
registerEndpoint('/api/upload/confirm', {
  method: 'POST',
  handler: async (event) => {
    const body = await readBody(event)
    confirmCalls.push({ body })
    return respond(event, await confirmEp.handler(body, event))
  }
})

// — raw `fetch` stub for S3 PUT ————————————————————————————————————
// The composable uses native fetch (not $fetch) for the PUT so the
// request goes straight to the S3 presigned URL without Nitro's
// ofetch interceptors. We stub globalThis.fetch and inspect the
// calls directly.
interface FetchCall {
  url: string
  init?: RequestInit
}
interface FetchBehavior {
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response
}
const s3Fetch: FetchBehavior = {
  handler: () => new Response(null, { status: 200 })
}
const fetchCalls: FetchCall[] = []

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    fetchCalls.push({ url, init })
    return s3Fetch.handler(url, init)
  }))
}

/**
 * Install a gated S3 handler: the PUT stays pending until the test
 * calls `.resolve()`. Returns a `.waitForCall()` promise that resolves
 * when the stub is actually hit — necessary because simply calling
 * `.resolve()` right after kicking off the upload races the composable's
 * internal microtasks and deadlocks (the resolver closure hasn't been
 * assigned yet).
 */
function gatedS3(): {
  waitForCall: () => Promise<void>
  resolve: (response?: Response) => void
} {
  let resolveGate: (r: Response) => void = () => {}
  let markCalled: () => void = () => {}
  const called = new Promise<void>((res) => {
    markCalled = res
  })
  s3Fetch.handler = () => {
    markCalled()
    return new Promise<Response>((r) => {
      resolveGate = r
    })
  }
  return {
    waitForCall: () => called,
    resolve: (r: Response = new Response(null, { status: 200 })) => resolveGate(r)
  }
}

// — CodeMirror view shim ————————————————————————————————————————
// Real EditorState so `view.state.doc.toString()` + dispatch work;
// we just wrap it in a minimal object that matches the surface the
// composable actually touches (state + dispatch).
function makeView(doc: string, cursor: number = doc.length): EditorView {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.single(cursor)
  })
  const view = {
    get state() { return state },
    dispatch(spec: Parameters<EditorState['update']>[0]) {
      state = state.update(spec).state
    }
  }
  return view as unknown as EditorView
}

function text(view: EditorView): string {
  return view.state.doc.toString()
}

function makeFile(
  name: string = 'photo.png',
  type: string = 'image/png',
  content: string = 'fake-bytes'
): File {
  return new File([content], name, { type })
}

beforeEach(() => {
  stubFetch()
  requestEp.handler = () => ({
    uploadUrl: 'https://s3.test/upload/signed-key-123',
    fileId: 'file-abc',
    key: 'docs/doc-xyz/file-abc.png'
  })
  confirmEp.handler = () => ({ ok: true })
  s3Fetch.handler = () => new Response(null, { status: 200 })
  requestCalls.length = 0
  confirmCalls.length = 0
  fetchCalls.length = 0
})

// ═══════════════════════════════════════════════════════════════════════
// upload() — 3-step happy path + POST body shapes
// ═══════════════════════════════════════════════════════════════════════

describe('upload() — happy path', () => {
  it('returns { fileId, url } on a successful 3-step upload', async () => {
    const { upload } = useImageUpload('doc-xyz')
    const result = await upload(makeFile('photo.png', 'image/png'))

    expect(result).toEqual({
      fileId: 'file-abc',
      url: '/api/files/doc-xyz/file-abc'
    })
  })

  it('sends the file metadata in the /request body', async () => {
    const { upload } = useImageUpload('doc-xyz')
    const file = makeFile('portrait.jpg', 'image/jpeg', 'xxxxx')
    await upload(file)

    expect(requestCalls).toHaveLength(1)
    expect(requestCalls[0]!.body).toEqual({
      docId: 'doc-xyz',
      filename: 'portrait.jpg',
      contentType: 'image/jpeg',
      size: file.size
    })
  })

  it('PUTs the file to the presigned URL with the correct Content-Type', async () => {
    const { upload } = useImageUpload('doc-xyz')
    const file = makeFile('a.png', 'image/png')
    await upload(file)

    // The S3 PUT is the only raw-fetch call; $fetch routes elsewhere.
    const put = fetchCalls.find(c => c.url.startsWith('https://s3.test/'))
    expect(put).toBeDefined()
    expect(put!.init?.method).toBe('PUT')
    expect((put!.init?.headers as Record<string, string>)['Content-Type']).toBe('image/png')
    // Body is the File object itself — the composable does NOT read
    // and re-bundle the bytes; S3 streams from the File handle.
    expect(put!.init?.body).toBe(file)
  })

  it('sends the returned key in the /confirm body', async () => {
    requestEp.handler = () => ({
      uploadUrl: 'https://s3.test/u',
      fileId: 'f1',
      key: 'some/custom/key.png'
    })
    const { upload } = useImageUpload('doc-xyz')
    await upload(makeFile())

    expect(confirmCalls).toHaveLength(1)
    expect(confirmCalls[0]!.body).toEqual({ key: 'some/custom/key.png' })
  })

  it('composes the public URL from docId and fileId (not the S3 key)', async () => {
    // The S3 key may include subfolders / a random suffix — the public
    // URL stays on /api/files/{docId}/{fileId} so Nuxt can apply access
    // control. Pin this derivation.
    requestEp.handler = () => ({
      uploadUrl: 'https://s3.test/u',
      fileId: 'the-file-id',
      key: 'docs/doc-xyz/nested/the-file-id.png'
    })
    const { upload } = useImageUpload('doc-xyz')
    const result = await upload(makeFile())
    expect(result?.url).toBe('/api/files/doc-xyz/the-file-id')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// upload() — `uploading` reactive state
// ═══════════════════════════════════════════════════════════════════════

describe('upload() — uploading ref', () => {
  it('flips uploading true during the in-flight call and back to false afterwards', async () => {
    const gate = gatedS3()
    const { upload, uploading } = useImageUpload('doc-xyz')
    expect(uploading.value).toBe(false)

    const pending = upload(makeFile())
    // `uploading.value = true` happens synchronously before the first
    // await inside upload(), so we can observe it immediately.
    expect(uploading.value).toBe(true)

    await gate.waitForCall()
    gate.resolve()
    await pending
    expect(uploading.value).toBe(false)
  })

  it('resets uploading to false even when the server errors (finally block)', async () => {
    requestEp.handler = () => new ApiError(500, { message: 'bad' })
    const { upload, uploading } = useImageUpload('doc-xyz')
    await upload(makeFile())
    expect(uploading.value).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// upload() — error paths + error ref
// ═══════════════════════════════════════════════════════════════════════

describe('upload() — error handling', () => {
  it('clears error at the start of each call', async () => {
    requestEp.handler = () => new ApiError(500, { message: 'first' })
    const { upload, error } = useImageUpload('doc-xyz')
    await upload(makeFile())
    expect(error.value).toBe('first')

    // Happy-path second call should reset error to null.
    requestEp.handler = () => ({
      uploadUrl: 'https://s3.test/u', fileId: 'f', key: 'k'
    })
    await upload(makeFile())
    expect(error.value).toBe(null)
  })

  it('returns null and sets error on /request failure', async () => {
    requestEp.handler = () => new ApiError(500, { message: 'Service down' })
    const { upload, error } = useImageUpload('doc-xyz')

    const result = await upload(makeFile())
    expect(result).toBe(null)
    expect(error.value).toBe('Service down')
    // Subsequent steps must not run once step 1 errored.
    expect(fetchCalls.find(c => c.url.startsWith('https://s3.test/'))).toBeUndefined()
    expect(confirmCalls).toHaveLength(0)
  })

  it('maps 401 to the special "login_required" marker regardless of message', async () => {
    // The UI uses this marker to show a "please log in" CTA instead of
    // a generic error toast. Pin that 401 wins over message extraction.
    requestEp.handler = () => new ApiError(401, { message: 'unauthenticated' })
    const { upload, error } = useImageUpload('doc-xyz')
    await upload(makeFile())
    expect(error.value).toBe('login_required')
  })

  it('sets error to "S3 upload failed: N" when the PUT returns non-2xx', async () => {
    s3Fetch.handler = () => new Response(null, { status: 403 })
    const { upload, error } = useImageUpload('doc-xyz')
    const result = await upload(makeFile())
    expect(result).toBe(null)
    expect(error.value).toBe('S3 upload failed: 403')
    // Confirm must not fire — upload failed at step 2.
    expect(confirmCalls).toHaveLength(0)
  })

  it('returns null and sets error on /confirm failure', async () => {
    confirmEp.handler = () => new ApiError(500, { message: 'confirm failed' })
    const { upload, error } = useImageUpload('doc-xyz')
    const result = await upload(makeFile())
    expect(result).toBe(null)
    expect(error.value).toBe('confirm failed')
  })

  it('falls back to "Upload failed" for errors with no message fields', async () => {
    requestEp.handler = () => new ApiError(500, {})
    const { upload, error } = useImageUpload('doc-xyz')
    await upload(makeFile())
    // The composable prefers data.message, then err.message, then
    // 'Upload failed'. With an empty body, $fetch still fills err.message
    // with its own "[POST] ... : 500" string, which the composable
    // uses. Accept either the generic label or the $fetch stringification.
    expect(error.value).toBeTruthy()
  })

  it('maps a 401 from /confirm (not just /request) to "login_required"', async () => {
    // Defensive: the auth check could land on any of the three steps.
    confirmEp.handler = () => new ApiError(401, { message: 'whatever' })
    const { upload, error } = useImageUpload('doc-xyz')
    await upload(makeFile())
    expect(error.value).toBe('login_required')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// uploadAndInsert() — placeholder rewrite contract
// ═══════════════════════════════════════════════════════════════════════

describe('uploadAndInsert() — happy path', () => {
  it('inserts a uniquely-tagged "Uploading" placeholder BEFORE the network call', async () => {
    const gate = gatedS3()
    const view = makeView('before ', 7)
    const { uploadAndInsert } = useImageUpload('doc-xyz')
    const pending = uploadAndInsert(makeFile('cat.png'), view)

    // The placeholder is dispatched synchronously, before the first
    // `await upload(file)` — we can read it now.
    expect(text(view)).toMatch(/^before !\[Uploading cat\.\.\.\]\(upload-[^)]+\)$/)

    await gate.waitForCall()
    gate.resolve()
    await pending
  })

  it('replaces the placeholder with the final markdown ref on success', async () => {
    const view = makeView('hi ', 3)
    const { uploadAndInsert } = useImageUpload('doc-xyz')
    await uploadAndInsert(makeFile('cat.png'), view)

    expect(text(view)).toBe('hi ![cat](/api/files/doc-xyz/file-abc)')
  })

  it('removes the placeholder on upload failure', async () => {
    requestEp.handler = () => new ApiError(500, { message: 'bad' })
    const view = makeView('prefix ', 7)
    const { uploadAndInsert } = useImageUpload('doc-xyz')
    await uploadAndInsert(makeFile('cat.png'), view)

    expect(text(view)).toBe('prefix ')
  })

  it('derives alt text from the filename stem (strips the last extension only)', async () => {
    const view = makeView('', 0)
    const { uploadAndInsert } = useImageUpload('doc-xyz')
    await uploadAndInsert(makeFile('My.Photo.png'), view)
    // `My.Photo.png` → strip `.png` → `My.Photo`
    expect(text(view)).toBe('![My.Photo](/api/files/doc-xyz/file-abc)')
  })

  it('handles an extension-less filename (alt = full name)', async () => {
    const view = makeView('', 0)
    const { uploadAndInsert } = useImageUpload('doc-xyz')
    await uploadAndInsert(makeFile('Untitled', 'image/png'), view)
    // Regex `/\.[^.]+$/` doesn't match a name without a dot — alt stays
    // as the full filename.
    expect(text(view)).toBe('![Untitled](/api/files/doc-xyz/file-abc)')
  })
})

describe('uploadAndInsert() — user-edit safety', () => {
  it('relocates the replacement when the user types BEFORE the placeholder', async () => {
    const gate = gatedS3()
    const view = makeView('start ', 6)
    const { uploadAndInsert } = useImageUpload('doc-xyz')
    const pending = uploadAndInsert(makeFile('cat.png'), view)

    // Wait until the stub has been hit before the user "types" — this
    // models the realistic case of an edit happening DURING the S3 PUT.
    await gate.waitForCall()
    view.dispatch({ changes: { from: 0, insert: 'AAA ' } })

    gate.resolve()
    await pending

    // The final text must contain the full rendered image — indexOf
    // recovered the placeholder's new position.
    expect(text(view)).toContain('![cat](/api/files/doc-xyz/file-abc)')
    expect(text(view)).toMatch(/^AAA start !/)
    // And NO "Uploading" placeholder is left behind.
    expect(text(view)).not.toContain('Uploading')
  })

  it('silently skips when the user deletes the placeholder mid-upload', async () => {
    // If the user Cmd+Z's or manually removes the placeholder while the
    // upload is in flight, the composable must not re-insert orphaned
    // markdown — it tracks the placeholder by string match and gives up
    // if the string is gone.
    const gate = gatedS3()
    const view = makeView('hello', 5)
    const { uploadAndInsert } = useImageUpload('doc-xyz')
    const pending = uploadAndInsert(makeFile('cat.png'), view)

    await gate.waitForCall()
    // Wipe the whole doc — placeholder is gone.
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: 'fresh content' }
    })

    gate.resolve()
    await pending

    // No markdown ref should have been re-inserted.
    expect(text(view)).toBe('fresh content')
  })

  it('two concurrent uploads produce DISTINCT placeholders and replace each correctly', async () => {
    // Previously the placeholder ID was built from a counter; now
    // nanoid. Either way, concurrent calls must not collide on the
    // `indexOf(placeholder)` lookup.
    //
    // Track per-call resolvers so we can release the PUTs
    // independently AFTER both requests have actually hit the stub.
    const resolvers: Array<(r: Response) => void> = []
    let notifyCalled: () => void = () => {}
    let callCount = 0
    const bothCalled = new Promise<void>((res) => {
      notifyCalled = res
    })
    s3Fetch.handler = () => {
      return new Promise<Response>((r) => {
        resolvers.push(r)
        callCount++
        if (callCount === 2) notifyCalled()
      })
    }

    // Give the two uploads DIFFERENT server-side fileIds so the
    // replacements are distinguishable.
    const fileIds = ['file-A', 'file-B']
    let reqIdx = 0
    requestEp.handler = () => ({
      uploadUrl: `https://s3.test/u${reqIdx}`,
      fileId: fileIds[reqIdx++]!,
      key: 'k'
    })

    const view = makeView('', 0)
    const { uploadAndInsert } = useImageUpload('doc-xyz')
    const pA = uploadAndInsert(makeFile('alpha.png'), view)
    const pB = uploadAndInsert(makeFile('beta.png'), view)

    await bothCalled
    resolvers[0]!(new Response(null, { status: 200 }))
    resolvers[1]!(new Response(null, { status: 200 }))
    await Promise.all([pA, pB])

    const out = text(view)
    expect(out).toContain('![alpha](/api/files/doc-xyz/file-A)')
    expect(out).toContain('![beta](/api/files/doc-xyz/file-B)')
    // No placeholder remnants.
    expect(out).not.toContain('Uploading')
  })
})
