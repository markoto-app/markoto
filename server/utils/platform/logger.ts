import { AsyncLocalStorage } from 'node:async_hooks'
import { asLogLevel, createLogging, formatFor, type LogLevel, type Logger } from '~~/shared/logging/core'
import { useEnv } from '~~/shared/env/load'

// The app's logger: `const log = useLogger('stripe-webhook')`, then
// `log.info('subscription updated', { subscriptionId, plan })`. Levels,
// fields and what never to log: docs/contributing/logging.md. The
// implementation (JSON lines, redaction) is shared/logging/core.ts.

export type { Logger } from '~~/shared/logging/core'

function currentLevel(): LogLevel {
  try {
    return asLogLevel(useEnv().core.logLevel)
  } catch {
    // An invalid LOG_LEVEL is reported by boot validation; logging itself
    // must not depend on it.
    return 'info'
  }
}

// The request id of the request being handled, set by
// server/middleware/00.request-context.ts. AsyncLocalStorage.enterWith keeps
// it across the awaits of one request (verified under Bun with concurrent
// requests); outside a request (sweepers, boot) there is none and records
// simply carry no `requestId`.
const requestContext = new AsyncLocalStorage<{ requestId: string }>()

export function enterRequestContext(requestId: string): void {
  requestContext.enterWith({ requestId })
}

export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId
}

const create = createLogging({
  level: currentLevel,
  format: () => formatFor(process.env.NODE_ENV),
  context: () => {
    const requestId = currentRequestId()
    return requestId ? { requestId } : undefined
  }
})

/** A logger whose records carry `component`. One stable name per module or domain. */
export function useLogger(component: string): Logger {
  return create(component)
}
