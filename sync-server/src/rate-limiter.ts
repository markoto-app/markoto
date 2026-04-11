const connectionsPerIP = new Map<string, number>()
const connectionIPs = new Map<string, string>()  // socketId → IP
const LIMITS = { maxConnectionsPerIP: 20, maxActiveRooms: 5000 }

export const rateLimiter = {
  onConnect(data: any) {
    try {
      const request = data.request || data.requestHeaders
      const headers = request?.headers || request || {}
      const ip = (typeof headers === 'object' && headers['x-forwarded-for'])
        ? headers['x-forwarded-for'].split(',')[0].trim()
        : 'unknown'

      const current = connectionsPerIP.get(ip) || 0
      if (current >= LIMITS.maxConnectionsPerIP) {
        console.warn(`[rate-limiter] Too many connections from ${ip}`)
        throw new Error('Too many connections')
      }
      connectionsPerIP.set(ip, current + 1)

      // Track IP by socket ID if available
      const socketId = data.socketId || data.connection?.readyState?.toString() || String(Date.now())
      connectionIPs.set(socketId, ip)
      ;(data as any).__rateLimitSocketId = socketId
    } catch (e: any) {
      if (e.message === 'Too many connections') throw e
      // Don't crash on unexpected data shape
      console.warn('[rate-limiter] onConnect error:', e.message)
    }
  },

  onDisconnect(data: any) {
    try {
      const socketId = (data as any).__rateLimitSocketId
        || data.socketId
        || ''
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
    } catch (e: any) {
      console.warn('[rate-limiter] onDisconnect error:', e.message)
    }
  }
}
