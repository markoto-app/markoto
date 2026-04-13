import type { IncomingMessage, ServerResponse } from 'node:http'

const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function readJsonBody(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(chunk as Buffer)
    if (chunks.reduce((n, c) => n + c.length, 0) > 10_000) {
      throw new Error('Body too large')
    }
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

/**
 * Handles internal HTTP requests from the Nuxt app.
 * Called by Hocuspocus's `onRequest` hook. Returns `true` if the request
 * was handled (caller should not fall through); `false` otherwise.
 */
export async function handleInternalRequest(
  request: IncomingMessage,
  response: ServerResponse,
  instance: any
): Promise<boolean> {
  const url = request.url || ''

  if (!url.startsWith('/internal/')) return false

  if (!INTERNAL_SECRET) {
    sendJson(response, 500, { error: 'Internal secret not configured' })
    return true
  }
  if (request.headers['x-internal-secret'] !== INTERNAL_SECRET) {
    sendJson(response, 401, { error: 'Invalid internal secret' })
    return true
  }

  try {
    if (url === '/internal/notify-deleted' && request.method === 'POST') {
      const body = await readJsonBody(request)
      const docId = body?.docId
      if (typeof docId !== 'string') {
        sendJson(response, 400, { error: 'Missing docId' })
        return true
      }

      // Flag the in-memory Y.Doc as deleted — connected clients observe this
      // via ymeta and handle redirect/toast on their end.
      const doc = instance.documents?.get(docId)
      if (doc) {
        const ymeta = doc.getMap('meta')
        ymeta.set('_deleted', Date.now())
        // Let Hocuspocus broadcast the update and persist nothing further.
        // Optionally unload after a short delay so clients receive the message.
        setTimeout(() => {
          try {
            instance.unloadDocument?.(doc)
          } catch { /* ignore */ }
        }, 2000)
      }

      sendJson(response, 200, { success: true, notified: !!doc })
      return true
    }

    sendJson(response, 404, { error: 'Not found' })
    return true
  } catch (e: any) {
    console.warn('[internal-http]', e.message)
    sendJson(response, 500, { error: e.message })
    return true
  }
}
