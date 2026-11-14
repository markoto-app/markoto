// Pre-apply validation of client updates (Hocuspocus `beforeHandleMessage`).
//
// Every incoming WebSocket message passes through `check()` BEFORE
// Hocuspocus applies it to the shared Y.Doc. Throwing a `SyncRejection`
// makes Hocuspocus drop the message and close that document connection
// with the rejection's code + reason (the editor maps the reason to a
// user-facing message, see `shared/contracts/syncClose.ts`). Nothing of a
// rejected update reaches the document, the other clients or Postgres.
//
// Checks, in order:
//   1. message / update size  (SYNC_MAX_MESSAGE_BYTES, SYNC_MAX_UPDATE_BYTES)
//   2. resulting document size (SYNC_MAX_DOCUMENT_BYTES), pure deletions
//      always pass so an oversized document can still be trimmed
//   3. `meta` map writes, every value written into ymeta must pass the
//      same validation as `PUT /api/docs/:id/meta`
//      (`shared/utils/documents/ymetaValidation.ts`); nested Y types inside ymeta are
//      refused outright.
//
// Locating ymeta writes without applying the update. A decoded Y.js item
// only names its parent when it has no left/right neighbour; otherwise the
// parent is implied by the neighbour it was inserted next to (`origin` /
// `rightOrigin`): which is exactly the case for overwriting an existing
// map key. `placementOf` follows those references through the update
// itself and through the document's struct store until it reaches a root
// type, iteratively and memoised, so a hostile chain can't blow the stack
// or go quadratic.
//
// Updates that reference state the server doesn't have yet. Y.js parks
// such items as "pending" (`doc.store.pendingStructs`) and integrates them
// once an update supplies what they reference. Legitimate clients send
// these all the time after a sync-server restart: edits made while the
// connection was down are queued and flushed right after authentication,
// before the client's sync step 2 delivers the state the fresh process
// lost with the old one (anything received but not yet stored). Such an
// item is accepted unchecked while it can't be placed, and checked in the
// update that makes it placeable: the resolver looks through the update,
// the document AND the pending structs. A pending item that turns out to
// be an invalid ymeta write is not blamed on the connection that
// completed it: everything parked is discarded (clients that hold those
// edits resend them on their next sync).
//
// All work is synchronous so Hocuspocus keeps applying messages in order.

import * as Y from 'yjs'
import { isValidMetaValue } from '../../shared/utils/documents/ymetaValidation'
import { SYNC_CLOSE_CODES, SYNC_CLOSE_REASONS, type SyncCloseReason } from '../../shared/contracts/syncClose'
import type { SyncLimits } from './limits'
import { ByteReader, MESSAGE_TYPE, readFrameHeader } from './frame'

const META_ROOT = 'meta'

export class SyncRejection extends Error {
  // Hocuspocus reads `code` + `reason` off the thrown value when it
  // closes the connection.
  readonly code: number
  readonly reason: SyncCloseReason

  constructor(reason: SyncCloseReason, detail?: string) {
    super(`update rejected: ${reason}${detail ? ` (${detail})` : ''}`)
    this.name = 'SyncRejection'
    this.reason = reason
    this.code = reason === SYNC_CLOSE_REASONS.updateTooLarge || reason === SYNC_CLOSE_REASONS.documentTooLarge
      ? SYNC_CLOSE_CODES.payloadTooLarge
      : SYNC_CLOSE_CODES.unprocessable
  }
}

// Message framing
// Sync / SyncReply: varUint(syncType) varUint8Array(payload)
const SYNC_STEP_2 = 1
const SYNC_UPDATE = 2

/**
 * The Y.js update carried by a Sync step-2 / update message, or null for
 * every other message type (awareness, auth, step 1, stateless, …).
 */
export function extractSyncUpdate(message: Uint8Array): Uint8Array | null {
  const r = new ByteReader(message)
  try {
    r.bytes(r.varUint()) // document name
    const type = r.varUint()
    if (type !== MESSAGE_TYPE.sync && type !== MESSAGE_TYPE.syncReply) return null
    const syncType = r.varUint()
    if (syncType !== SYNC_STEP_2 && syncType !== SYNC_UPDATE) return null
    return r.bytes(r.varUint())
  } catch {
    throw new SyncRejection(SYNC_CLOSE_REASONS.invalidUpdate, 'malformed sync message')
  }
}

// ymeta placement

interface Placement {
  /** Root type name (`content`, `meta`, `comments`, …). */
  root: string
  /** Map key on the root type, when the item sits directly on it. */
  key: string | null
  /** True when the item lives inside a nested Y type, not on the root. */
  nested: boolean
}
/**
 * 'missing': references a struct the server doesn't have (yet), Y.js
 * keeps the item pending. 'unresolvable': the walk gave up (a crafted
 * reference chain, a broken store); such an update is refused.
 */
type Resolution = Placement | 'gc' | 'missing' | 'unresolvable'

/** Hard ceiling on references followed for one item. Legit documents
 *  nest two levels deep (comments → replies); this only trips on a
 *  crafted chain, which is rejected. */
const MAX_REFERENCE_STEPS = 10_000

function placementOfType(type: Y.AbstractType<unknown>, parentSub: string | null): Resolution {
  let t = type
  let nested = false
  let steps = 0
  while (t._item !== null) {
    if (steps > MAX_REFERENCE_STEPS) return 'unresolvable'
    const parent: unknown = t._item.parent
    if (!(parent instanceof Y.AbstractType)) return 'gc'
    nested = true
    t = parent
    steps++
  }
  let root: string
  try {
    root = Y.findRootTypeKey(t)
  } catch {
    return 'unresolvable'
  }
  return { root, key: nested ? null : parentSub, nested }
}

type DecodedStruct = Y.Item | Y.GC | Y.Skip
type StructIndex = Map<number, Array<Y.Item | Y.GC>>

/** Structs per client, in clock order (decodeUpdate emits them that way). */
function indexStructs(structs: ReadonlyArray<DecodedStruct>): StructIndex {
  const index: StructIndex = new Map()
  for (const s of structs) {
    if (s instanceof Y.Skip) continue
    const list = index.get(s.id.client) ?? []
    list.push(s)
    index.set(s.id.client, list)
  }
  return index
}

function findIn(index: StructIndex, id: Y.ID): Y.Item | Y.GC | null {
  const list = index.get(id.client)
  if (!list) return null
  let lo = 0
  let hi = list.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = list[mid]
    if (!s) return null
    if (id.clock < s.id.clock) hi = mid - 1
    else if (id.clock >= s.id.clock + s.length) lo = mid + 1
    else return s
  }
  return null
}

function createPlacementResolver(doc: Y.Doc, update: StructIndex, pending: StructIndex) {
  const memo = new Map<Y.Item, Resolution>()

  function lookup(id: Y.ID): Y.Item | 'gc' | 'missing' | 'unresolvable' {
    if (Y.getState(doc.store, id.client) > id.clock) {
      try {
        const s: unknown = Y.getItem(doc.store, id)
        return s instanceof Y.Item ? s : 'gc'
      } catch {
        return 'unresolvable'
      }
    }
    const s = findIn(update, id) ?? findIn(pending, id)
    if (s === null) return 'missing'
    return s instanceof Y.Item ? s : 'gc'
  }

  /**
   * One step of the walk: the item's placement when it is known from the
   * item itself (memoised), or the item its parent is implied by.
   */
  function resolveStep(cur: Y.Item): { result: Resolution } | { next: Y.Item, intoNested: boolean } {
    const parent: unknown = cur.parent
    let result: Resolution
    let next: Y.Item | 'gc' | 'missing' | 'unresolvable'
    let intoNested = false
    if (typeof parent === 'string') {
      result = { root: parent, key: cur.parentSub, nested: false }
    } else if (parent instanceof Y.AbstractType) {
      result = placementOfType(parent, cur.parentSub)
    } else {
      if (parent instanceof Y.ID) {
        // Parent is a nested type; `parent` is the id of the item holding it.
        next = lookup(parent)
        intoNested = true
      } else {
        // Parent implied by the neighbour this item was inserted next to.
        const ref = cur.origin ?? cur.rightOrigin
        next = ref ? lookup(ref) : 'missing'
      }
      if (next instanceof Y.Item) return { next, intoNested }
      result = next
    }
    memo.set(cur, result)
    return { result }
  }

  return function placementOf(start: Y.Item): Resolution {
    // Walk references until something resolves, remembering for each
    // step whether it descended into a nested type.
    const chain: Array<{ item: Y.Item, intoNested: boolean }> = []
    let cur = start
    let result: Resolution
    for (;;) {
      const known = memo.get(cur)
      if (known !== undefined) {
        result = known
        break
      }
      if (chain.length > MAX_REFERENCE_STEPS) {
        result = 'unresolvable'
        break
      }
      const step = resolveStep(cur)
      if ('result' in step) {
        result = step.result
        break
      }
      chain.push({ item: cur, intoNested: step.intoNested })
      cur = step.next
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      const step = chain[i]
      if (!step) continue
      if (step.intoNested && typeof result !== 'string') {
        result = { root: result.root, key: null, nested: true }
      }
      memo.set(step.item, result)
    }
    return result
  }
}

/** Already integrated (a resend): Y.js skips it on apply. */
function isIntegrated(doc: Y.Doc, s: Y.Item): boolean {
  return Y.getState(doc.store, s.id.client) >= s.id.clock + s.length
}

// Decoded pending structs, per pending update. Y.js replaces
// `pendingStructs.update` whenever the pending set changes, so the cache
// decodes each version once instead of once per incoming message.
const decodedPending = new WeakMap<Uint8Array, DecodedStruct[]>()

function pendingStructsOf(doc: Y.Doc): DecodedStruct[] {
  const pending = doc.store.pendingStructs
  if (!pending) return []
  let structs = decodedPending.get(pending.update)
  if (!structs) {
    structs = Y.decodeUpdateV2(pending.update).structs
    decodedPending.set(pending.update, structs)
  }
  return structs
}

/**
 * Throw a SyncRejection if any struct of the decoded update writes an
 * invalid value into ymeta or nests a Y type inside it. Items that can't
 * be placed yet stay pending in Y.js and are checked by the update that
 * completes them (see the header).
 */
function checkMetaWrites(doc: Y.Doc, structs: ReadonlyArray<DecodedStruct>): void {
  const pending = pendingStructsOf(doc)
  const placementOf = createPlacementResolver(doc, indexStructs(structs), indexStructs(pending))
  for (const s of structs) {
    if (!(s instanceof Y.Item) || isIntegrated(doc, s)) continue
    checkMetaItem(s, placementOf(s))
  }
  // Pending items this update makes placeable integrate together with it.
  for (const s of pending) {
    if (!(s instanceof Y.Item) || isIntegrated(doc, s)) continue
    try {
      checkMetaItem(s, placementOf(s))
    } catch (e) {
      if (!(e instanceof SyncRejection)) throw e
      // Sent earlier, possibly by another connection: drop what is parked
      // (structs and the deletions that came with them) rather than close
      // the connection that happened to complete it.
      doc.store.pendingStructs = null
      doc.store.pendingDs = null
      return
    }
  }
}

function checkMetaItem(s: Y.Item, placement: Resolution): void {
  // Not placeable yet: Y.js keeps it pending, it is checked once it is.
  if (placement === 'missing') return
  if (placement === 'unresolvable') {
    throw new SyncRejection(SYNC_CLOSE_REASONS.invalidUpdate, 'unresolvable reference chain')
  }
  if (placement === 'gc' || placement.root !== META_ROOT) return
  if (s.content instanceof Y.ContentDeleted) return
  if (placement.nested || placement.key === null) {
    throw new SyncRejection(SYNC_CLOSE_REASONS.invalidMeta, 'nested value')
  }
  const content: unknown = s.content
  const values = content instanceof Y.ContentAny || content instanceof Y.ContentJSON ? content.arr : null
  if (values?.length !== 1 || !isValidMetaValue(placement.key, values[0])) {
    throw new SyncRejection(SYNC_CLOSE_REASONS.invalidMeta, `key ${placement.key.slice(0, 64)}`)
  }
}

// Stateless messages

/**
 * Refuse stateless messages from a read-only connection. Hocuspocus relays
 * a `BroadcastStateless` frame to EVERY connection of the document, so a
 * viewer could otherwise push arbitrary strings to all editors; plain
 * `Stateless` frames go to the `onStateless` hook. The app itself sends
 * neither (no `sendStateless` anywhere in the editor, AI or MCP clients),
 * so only a non-standard client is affected. Rejecting closes that
 * document connection and drops the message before it is relayed; writer
 * connections keep the stock behaviour.
 */
function rejectReadOnlyStateless(message: Uint8Array): void {
  let type: number
  try {
    type = readFrameHeader(message).type
  } catch {
    throw new SyncRejection(SYNC_CLOSE_REASONS.invalidUpdate, 'malformed message')
  }
  if (type === MESSAGE_TYPE.stateless || type === MESSAGE_TYPE.broadcastStateless) {
    throw new SyncRejection(SYNC_CLOSE_REASONS.invalidUpdate, 'stateless message from a read-only connection')
  }
}

// Guard

export function createUpdateGuard(limits: SyncLimits) {
  // Upper estimate of each live document's encoded size: advanced by the
  // size of every accepted update, and replaced by the exact size only
  // when the estimate would cross the cap, so the common path never
  // encodes the whole document.
  const sizes = new WeakMap<Y.Doc, number>()

  function measure(doc: Y.Doc): number {
    const n = Y.encodeStateAsUpdate(doc).byteLength
    sizes.set(doc, n)
    return n
  }

  return {
    /** Throws SyncRejection when `message` must not be applied to `doc`. */
    check(doc: Y.Doc, message: Uint8Array, readOnly: boolean): void {
      if (message.byteLength > limits.maxMessageBytes) {
        throw new SyncRejection(SYNC_CLOSE_REASONS.updateTooLarge, `${message.byteLength} bytes`)
      }
      const update = extractSyncUpdate(message)
      if (readOnly) {
        rejectReadOnlyStateless(message)
        // Read-only connections never get their updates applied
        // (Hocuspocus acks them without applying), so there is nothing
        // else to validate.
        return
      }
      if (update === null) return
      if (update.byteLength > limits.maxUpdateBytes) {
        throw new SyncRejection(SYNC_CLOSE_REASONS.updateTooLarge, `${update.byteLength} bytes`)
      }

      let structs: DecodedStruct[]
      try {
        structs = Y.decodeUpdate(update).structs
      } catch {
        throw new SyncRejection(SYNC_CLOSE_REASONS.invalidUpdate, 'undecodable update')
      }

      const addsContent = structs.some(s => s instanceof Y.Item && !(s.content instanceof Y.ContentDeleted))
      let size = sizes.get(doc) ?? measure(doc)
      if (addsContent && size + update.byteLength > limits.maxDocumentBytes) {
        size = measure(doc)
        if (size + update.byteLength > limits.maxDocumentBytes) {
          throw new SyncRejection(SYNC_CLOSE_REASONS.documentTooLarge, `${size} + ${update.byteLength} bytes`)
        }
      }

      checkMetaWrites(doc, structs)
      sizes.set(doc, size + update.byteLength)
    }
  }
}
