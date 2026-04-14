import { verifyJwtWithRotation } from './secrets'

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) {
  throw new Error('[auth] JWT_SECRET environment variable is required')
}
// Optional previous secret accepted during rotation windows.
const JWT_SECRET_PREVIOUS = process.env.JWT_SECRET_PREVIOUS || undefined

export const auth = {
  async onAuthenticate({ documentName, token }: { documentName: string; token: string | null }) {
    // Always require a valid JWT — no anonymous bypass.
    // The Nuxt token endpoint issues JWTs with the correct readOnly flag
    // based on document access mode and user ownership.
    // Password-protected docs get no token until password is verified,
    // so Hocuspocus rejects those connections entirely.
    if (!token) {
      throw new Error('Authentication required')
    }

    try {
      const payload = verifyJwtWithRotation<{
        docId: string
        userId: string
        userName?: string | null
        readOnly: boolean
      }>(token, JWT_SECRET, JWT_SECRET_PREVIOUS)
      if (payload.docId !== documentName) {
        throw new Error('Token scope mismatch')
      }
      // Pass userId + userName through the connection context so onChange can
      // attribute edits without guessing from awareness timestamps.
      return {
        readOnly: payload.readOnly,
        userId: payload.userId,
        userName: payload.userName ?? null
      }
    } catch (e: any) {
      console.warn(`[auth] Invalid token for ${documentName}:`, e.message)
      throw new Error('Invalid token')
    }
  }
}
