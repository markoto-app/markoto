// Hocuspocus wire frame: varString(documentName) varUint(messageType) …
// Minimal, allocation-light reader shared by the update guard and the
// pre-auth guard. Both read untrusted client bytes BEFORE Hocuspocus
// handles them, so every read is bounds-checked and throws RangeError on
// malformed input.

/** Hocuspocus `MessageType` values the guards care about. */
export const MESSAGE_TYPE = {
  sync: 0,
  awareness: 1,
  auth: 2,
  queryAwareness: 3,
  syncReply: 4,
  stateless: 5,
  broadcastStateless: 6
} as const

export class ByteReader {
  private pos = 0
  constructor(private readonly buf: Uint8Array) {}

  varUint(): number {
    let n = 0
    let mult = 1
    for (;;) {
      if (this.pos >= this.buf.length) throw new RangeError('unexpected end of message')
      const byte = this.buf[this.pos++]
      if (byte === undefined) throw new RangeError('unexpected end of message')
      n += (byte & 0x7f) * mult
      if (byte < 0x80) return n
      mult *= 128
      if (mult > Number.MAX_SAFE_INTEGER) throw new RangeError('varUint overflow')
    }
  }

  bytes(len: number): Uint8Array {
    if (this.pos + len > this.buf.length) throw new RangeError('unexpected end of message')
    const out = this.buf.subarray(this.pos, this.pos + len)
    this.pos += len
    return out
  }
}

const utf8 = new TextDecoder()

/** Document name + message type of a frame; throws RangeError when malformed. */
export function readFrameHeader(message: Uint8Array): { documentName: string, type: number } {
  const r = new ByteReader(message)
  const documentName = utf8.decode(r.bytes(r.varUint()))
  return { documentName, type: r.varUint() }
}
