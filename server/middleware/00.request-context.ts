import { randomUUID } from 'node:crypto'
import { enterRequestContext } from '../utils/platform/logger'

// One id per request, carried on every log line of that request (and on the
// calls to the sync server and the renderer: traceHeaders.ts). A caller-sent
// `x-request-id` is kept when it looks like an id (a proxy or a support
// request can quote it) — anything else would let a client forge log fields,
// so it is replaced.
const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/

export default defineEventHandler((event) => {
  const sent = getRequestHeader(event, 'x-request-id')
  const requestId = sent && SAFE_ID.test(sent) ? sent : randomUUID()
  enterRequestContext(requestId)
  setResponseHeader(event, 'x-request-id', requestId)
})
