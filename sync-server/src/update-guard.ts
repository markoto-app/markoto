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
//   4. `suggestions` map writes: every value must be one valid suggestion
//      record (`shared/utils/suggestions/record.ts`) stored under its id.
//   5. suggest-only connections (JWT `suggestOnly`): they may write only
//      the `suggestions` map (records authored by themselves) and the
//      `comments` array. Text, document settings and other people's
//      suggestions are refused, as are deletions of anything else. Their
//      items must be placeable right away: a suggest-only client has no
//      reason to reference state the server lacks, and an item that can't
//      be placed can't be checked.
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
import { parseSuggestion, SUGGESTIONS_ROOT, type SuggestionRecord } from '../../shared/utils/suggestions/record'
import { SYNC_CLOSE_CODES, SYNC_CLOSE_REASONS, type SyncCloseReason } from '../../shared/contracts/syncClose'
import type { SyncLimits } from './limits'
import { ByteReader, MESSAGE_TYPE, readFrameHeader } from './frame'

const META_ROOT = 'meta'
const COMMENTS_ROOT = 'comments'
/** Roots a suggest-only connection may write. */
const SUGGEST_ONLY_ROOTS: ReadonlySet<string> = new Set([SUGGESTIONS_ROOT, COMMENTS_ROOT])

/** What the connection a message came in on may write. */
export interface ConnectionAccess {
  /** Only suggestions (its own) and comments, never the text. */
  suggestOnly: boolean
  /** The connection's JWT principal: a numeric user id, `anonymous`, or a synthetic one. */
  userId: string | number | null
}

const FULL_ACCESS: ConnectionAccess = { suggestOnly: false, userId: null }

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
type DeleteSet = ReturnType<typeof Y.decodeUpdate>['ds']
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

type PlacementOf = ReturnType<typeof createPlacementResolver>

/**
 * Throw a SyncRejection if any struct of the decoded update writes an
 * invalid value into ymeta or the suggestions map, nests a Y type inside
 * them, or (suggest-only) writes outside what the connection may write.
 * Items that can't be placed yet stay pending in Y.js and are checked by
 * the update that completes them (see the header).
 */
function checkItemWrites(doc: Y.Doc, structs: ReadonlyArray<DecodedStruct>, placementOf: PlacementOf, pending: ReadonlyArray<DecodedStruct>, access: ConnectionAccess): void {
  for (const s of structs) {
    if (!(s instanceof Y.Item) || isIntegrated(doc, s)) continue
    const placement = placementOf(s)
    if (access.suggestOnly) checkSuggestOnlyItem(doc, s, placement, access)
    checkMetaItem(s, placement)
    checkSuggestionItem(s, placement)
  }
  // Pending items this update makes placeable integrate together with it.
  for (const s of pending) {
    if (!(s instanceof Y.Item) || isIntegrated(doc, s)) continue
    try {
      const placement = placementOf(s)
      checkMetaItem(s, placement)
      checkSuggestionItem(s, placement)
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

// Suggestions

/** The single JSON value a map item stores, or undefined for anything else (a nested type, a deletion, several values). */
function itemValue(s: Y.Item): unknown {
  const content: unknown = s.content
  if (!(content instanceof Y.ContentAny || content instanceof Y.ContentJSON)) return undefined
  return content.arr.length === 1 ? content.arr[0] : undefined
}

/** A write to the suggestions map must be one valid record stored under its own id. */
function checkSuggestionItem(s: Y.Item, placement: Resolution): void {
  if (typeof placement !== 'object' || placement.root !== SUGGESTIONS_ROOT) return
  if (s.content instanceof Y.ContentDeleted) return
  if (placement.nested || placement.key === null) {
    throw new SyncRejection(SYNC_CLOSE_REASONS.invalidSuggestion, 'nested value')
  }
  const record = parseSuggestion(itemValue(s))
  if (record?.id !== placement.key) {
    throw new SyncRejection(SYNC_CLOSE_REASONS.invalidSuggestion, `key ${placement.key.slice(0, 64)}`)
  }
}

/** Whether a stored record was written by this connection's author (a person, never the AI). */
function isOwnRecord(record: SuggestionRecord | null, access: ConnectionAccess): boolean {
  if (!record || record.authorPrincipal !== null) return false
  const n = typeof access.userId === 'number' ? access.userId : Number(access.userId)
  if (Number.isSafeInteger(n) && n > 0) return record.authorId === n
  // An anonymous connection: only anonymous records (all anonymous
  // visitors share the principal, so they can't be told apart here).
  return record.authorId === null && access.userId === 'anonymous'
}

function checkSuggestOnlyItem(doc: Y.Doc, s: Y.Item, placement: Resolution, access: ConnectionAccess): void {
  if (typeof placement !== 'object') {
    throw new SyncRejection(SYNC_CLOSE_REASONS.invalidSuggestion, `unplaceable item (${placement})`)
  }
  if (!SUGGEST_ONLY_ROOTS.has(placement.root)) {
    throw new SyncRejection(SYNC_CLOSE_REASONS.invalidSuggestion, `write to ${placement.root.slice(0, 32)}`)
  }
  if (placement.root !== SUGGESTIONS_ROOT || placement.key === null || s.content instanceof Y.ContentDeleted) return
  if (!isOwnRecord(parseSuggestion(itemValue(s)), access)) {
    throw new SyncRejection(SYNC_CLOSE_REASONS.invalidSuggestion, 'record of another author')
  }
  // Overwriting an existing entry: it has to be this author's too.
  // getMap, not `doc.share`: a root that arrived through updates is a
  // plain AbstractType until something asks for it as a map.
  const existing: unknown = doc.getMap(SUGGESTIONS_ROOT).get(placement.key)
  if (existing !== undefined && !isOwnRecord(parseSuggestion(existing), access)) {
    throw new SyncRejection(SYNC_CLOSE_REASONS.invalidSuggestion, 'overwrites another author')
  }
}

/**
 * Suggest-only: every item the update deletes must sit in a root the
 * connection may write, and a deleted suggestion must be its own.
 * Already deleted (or garbage-collected) items are a no-op and pass.
 */
function checkSuggestOnlyDeletions(doc: Y.Doc, ds: DeleteSet, update: StructIndex, placementOf: PlacementOf, access: ConnectionAccess): void {
  for (const [client, ranges] of ds.clients) {
    for (const range of ranges) {
      let clock = range.clock
      const end = range.clock + range.len
      while (clock < end) {
        const id = Y.createID(client, clock)
        let s: Y.Item | Y.GC | null
        try {
          s = Y.getState(doc.store, client) > clock ? Y.getItem(doc.store, id) as Y.Item | Y.GC : findIn(update, id)
        } catch {
          s = null
        }
        if (s === null) throw new SyncRejection(SYNC_CLOSE_REASONS.invalidSuggestion, 'deletes unknown state')
        if (s instanceof Y.Item && !s.deleted) checkSuggestOnlyDeletion(s, placementOf(s), access)
        clock = s.id.clock + s.length
      }
    }
  }
}

function checkSuggestOnlyDeletion(s: Y.Item, placement: Resolution, access: ConnectionAccess): void {
  if (typeof placement !== 'object' || !SUGGEST_ONLY_ROOTS.has(placement.root)) {
    throw new SyncRejection(SYNC_CLOSE_REASONS.invalidSuggestion, 'deletion outside suggestions and comments')
  }
  if (placement.root === SUGGESTIONS_ROOT && placement.key !== null && !isOwnRecord(parseSuggestion(itemValue(s)), access)) {
    throw new SyncRejection(SYNC_CLOSE_REASONS.invalidSuggestion, 'deletes a suggestion of another author')
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
    /**
     * Throws SyncRejection when `message` must not be applied to `doc`.
     * `access` describes a writable connection (suggest-only or not);
     * omitted means unrestricted.
     */
    check(doc: Y.Doc, message: Uint8Array, readOnly: boolean, access: ConnectionAccess = FULL_ACCESS): void {
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
      let ds: DeleteSet
      try {
        ({ structs, ds } = Y.decodeUpdate(update))
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

      const pending = pendingStructsOf(doc)
      const updateIndex = indexStructs(structs)
      const placementOf = createPlacementResolver(doc, updateIndex, indexStructs(pending))
      checkItemWrites(doc, structs, placementOf, pending, access)
      if (access.suggestOnly) checkSuggestOnlyDeletions(doc, ds, updateIndex, placementOf, access)
      sizes.set(doc, size + update.byteLength)
    }
  }
}
