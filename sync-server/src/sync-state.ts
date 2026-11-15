// Per-doc state, kept in Valkey so multiple sync-server containers share it:
//   - last-editor:   primary attribution source for activity-log rows.
//   - prev-lines:    diff baseline for line-add/-remove counts (a line
//                    digest, `lineDigest` in activity-logger.ts, not the text).
//   - prev-meta:     title/theme baseline for "title.changed"/"theme.changed".
//
// Each call returns the previous value (read-modify-write callsites in
// index.ts handle their own logic).
//
// Failure mode: every helper catches errors and reports them via the
// `cause` channel back to the caller, which:
//   - logs the warn line for ops visibility,
//   - feeds the `cause` into the Sentry tag so we can distinguish
//     'valkey-miss' (cold doc / restart, normal) from 'valkey-error'
//     (Valkey down: operationally interesting).
// On error we behave the same as a miss (attribution falls back to the
// awareness heuristic; diff baseline reseeds without emitting a row).
//
// TTL: 24 h. A doc untouched for 24 h is "cold"; the next edit can
// rebuild attribution from awareness without harm. Saves Valkey memory.

import { useValkey } from './valkey'
import { DAY_SECONDS } from '../../shared/config/units'
import { syncStateKeys } from '../../shared/contracts/syncState'
import { useLogger } from './logger'

const log = useLogger('sync-state')

const TTL_SECONDS = DAY_SECONDS

export interface LastEditor {
  userName: string | null
  userId: string | null
  /** Anonymous editors only: their awareness avatar token. Absent on
   *  values written before this field existed. */
  avatarSeed?: string | null
  at: number
}

export interface PreviousMeta {
  title: string | null
  /**
   * SHA-256 of the JSON-serialised `ymeta.theme`, only compared for
   * equality, so a hash keeps a theme with up to 64 KB of custom CSS
   * from being copied into Valkey per doc.
   */
  themeHash: string | null
}

export type FetchCause = 'hit' | 'miss' | 'error'

export interface FetchResult<T> {
  value: T | null
  cause: FetchCause
  /** Populated only when cause === 'error'. */
  error?: Error
}

const KEY_LAST_EDITOR = syncStateKeys.lastEditor
const KEY_PREV_LINES = syncStateKeys.prevLines
const KEY_PREV_META = syncStateKeys.prevMeta

async function safeGet(key: string): Promise<FetchResult<string>> {
  try {
    const v = await useValkey().get(key)
    return v == null ? { value: null, cause: 'miss' } : { value: v, cause: 'hit' }
  } catch (e) {
    return { value: null, cause: 'error', error: e instanceof Error ? e : new Error(String(e)) }
  }
}

async function safeSetEx(key: string, value: string): Promise<Error | null> {
  try {
    await useValkey().set(key, value, 'EX', TTL_SECONDS)
    return null
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e))
  }
}

async function safeDel(key: string): Promise<void> {
  try {
    await useValkey().del(key)
  } catch (e) {
    // Cleanup-only path; logging is the right thing here.
    log.warn('del failed', { key, err: e })
  }
}

// last-editor

export async function getLastEditor(docId: string): Promise<FetchResult<LastEditor>> {
  const raw = await safeGet(KEY_LAST_EDITOR(docId))
  if (raw.cause !== 'hit' || !raw.value) return { value: null, cause: raw.cause, error: raw.error }
  try {
    return { value: JSON.parse(raw.value) as LastEditor, cause: 'hit' }
  } catch {
    // Treat malformed JSON as a miss, better to fall through to
    // awareness than to crash on a bad payload.
    return { value: null, cause: 'miss' }
  }
}

export async function setLastEditor(docId: string, value: LastEditor): Promise<void> {
  await safeSetEx(KEY_LAST_EDITOR(docId), JSON.stringify(value))
}

// prev-lines

export async function getPrevLines(docId: string): Promise<FetchResult<string>> {
  return safeGet(KEY_PREV_LINES(docId))
}

export async function setPrevLines(docId: string, digest: string): Promise<void> {
  await safeSetEx(KEY_PREV_LINES(docId), digest)
}

// prev-meta

export async function getPrevMeta(docId: string): Promise<FetchResult<PreviousMeta>> {
  const raw = await safeGet(KEY_PREV_META(docId))
  if (raw.cause !== 'hit' || !raw.value) return { value: null, cause: raw.cause, error: raw.error }
  try {
    return { value: JSON.parse(raw.value) as PreviousMeta, cause: 'hit' }
  } catch {
    return { value: null, cause: 'miss' }
  }
}

export async function setPrevMeta(docId: string, value: PreviousMeta): Promise<void> {
  await safeSetEx(KEY_PREV_META(docId), JSON.stringify(value))
}

// cleanup (called when the document is unloaded)

export async function dropDocState(docId: string): Promise<void> {
  await Promise.all([
    safeDel(KEY_LAST_EDITOR(docId)),
    safeDel(KEY_PREV_LINES(docId)),
    safeDel(KEY_PREV_META(docId))
  ])
}
