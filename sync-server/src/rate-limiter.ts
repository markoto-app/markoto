// Minimal shape of Hocuspocus's onConnect/onDisconnect payload — only the
// fields this limiter actually reads. Avoids importing Hocuspocus's internal
// types (which shift between v3 patch releases).
interface HookData {
  request?: { headers?: Record<string, string | string[] | undefined> }
  requestHeaders?: Record<string, string | string[] | undefined>
  socketId?: string
  connection?: { readyState?: { toString?: () => string } }
  __rateLimitSocketId?: string
}

const connectionsPerIP = new Map<string, number>()
const connectionIPs = new Map<string, string>() // socketId → IP
const LIMITS = { maxConnectionsPerIP: 20, maxActiveRooms: 5000 }

function extractIp(data: HookData): string {
  const request = data.request || { headers: data.requestHeaders }
  const headers = request?.headers || {}
  const xff = headers['x-forwarded-for']
  const raw = Array.isArray(xff) ? xff[0] : xff
  if (typeof raw === 'string' && raw.length > 0) {
    return raw.split(',')[0]!.trim()
  }
  return 'unknown'
}

export const rateLimiter = {
  onConnect(data: HookData) {
    try {
      const ip = extractIp(data)

      const current = connectionsPerIP.get(ip) || 0
      if (current >= LIMITS.maxConnectionsPerIP) {
        console.warn(`[rate-limiter] Too many connections from ${ip}`)
        throw new Error('Too many connections')
      }
      connectionsPerIP.set(ip, current + 1)

      // Track IP by socket ID if available
      const socketId = data.socketId || data.connection?.readyState?.toString?.() || String(Date.now())
      connectionIPs.set(socketId, ip)
      data.__rateLimitSocketId = socketId
    } catch (e) {
      if (e instanceof Error && e.message === 'Too many connections') throw e
      // Don't crash on unexpected data shape
      console.warn('[rate-limiter] onConnect error:', e instanceof Error ? e.message : e)
    }
  },

  onDisconnect(data: HookData) {
    try {
      const socketId = data.__rateLimitSocketId || data.socketId || ''
      const ip = connectionIPs.get(socketId)
      if (ip) {
        connectionIPs.delete(socketId)
        const n = (connectionsPerIP.get(ip) || 1) - 1
        if (n <= 0) {
          connectionsPerIP.delete(ip)
        } else {
          connectionsPerIP.set(ip, n)
        }
      }
    } catch (e) {
      console.warn('[rate-limiter] onDisconnect error:', e instanceof Error ? e.message : e)
    }
  }
}
