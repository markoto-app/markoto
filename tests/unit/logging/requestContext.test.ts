import { describe, expect, it } from 'vitest'
import { captureLogs } from '../../helpers/logs'
import { currentRequestId, enterRequestContext, useLogger } from '../../../server/utils/platform/logger'
import { injectTraceHeaders } from '../../../server/utils/platform/traceHeaders'

const logs = captureLogs()

describe('request correlation', () => {
  it('has no request id outside a request', () => {
    expect(currentRequestId()).toBeUndefined()
    useLogger('unit').info('boot')
    expect(logs.records[0]).not.toHaveProperty('requestId')
    expect(injectTraceHeaders({ a: 'b' })).not.toHaveProperty('x-request-id')
  })

  it('stamps every record and outbound call of a request with its id, across awaits and between concurrent requests', async () => {
    const log = useLogger('unit')
    const handle = async (id: string) => {
      await Promise.resolve()
      enterRequestContext(id)
      await new Promise(r => setTimeout(r, Math.random() * 10))
      log.info('handled', { id })
      return injectTraceHeaders({})['x-request-id']
    }
    // Each "request" starts in its own async context, as the server's does.
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => new Promise<string | undefined>(resolve => setTimeout(() => void handle(`req-${String(i).padStart(8, '0')}`).then(resolve), 0))))
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => `req-${String(i).padStart(8, '0')}`))
    for (const r of logs.records) expect(r.requestId).toBe(r.id)
  })
})
