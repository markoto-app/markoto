import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) {
  throw new Error('[auth] JWT_SECRET environment variable is required')
}

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
      const payload = jwt.verify(token, JWT_SECRET) as {
        docId: string
        userId: string
        readOnly: boolean
      }
      if (payload.docId !== documentName) {
        throw new Error('Token scope mismatch')
      }
      return { readOnly: payload.readOnly }
    } catch (e: any) {
      console.warn(`[auth] Invalid token for ${documentName}:`, e.message)
      throw new Error('Invalid token')
    }
  }
}
