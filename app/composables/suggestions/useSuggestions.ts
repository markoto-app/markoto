import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { createInjectionState } from '@vueuse/core'
import { nanoid } from 'nanoid'
import { anchorRange, readSuggestions, suggestionsMap } from '~~/shared/utils/suggestions/ySuggestions'
import { parseSuggestion, suggestionAuthorKey, suggestionKind, type SuggestionKind, type SuggestionRecord } from '~~/shared/utils/suggestions/record'
import type { SuggestPlan } from '~~/shared/utils/suggestions/plan'
import type { SuggestionMark } from '~/utils/suggestions/suggestionExtension'
import { AWARENESS_PALETTE } from '~/utils/collab/colors'

// Suggestions of the open document (suggestion mode). They live in the
// Y.Doc (`suggestions` map, shared/utils/suggestions/record.ts); this
// composable derives the list the editor marks and the panel cards show,
// writes the local author's suggestions while suggesting, and asks the
// server to accept or reject (accepting applies the text as the
// suggester's edit, see server/utils/suggestions/resolveSuggestions.ts).

/** Transaction origin of the local author's suggestion writes: the document's UndoManager tracks it. */
export const SUGGEST_ORIGIN = 'markoto:suggest'

/** Colour of the AI's suggestions (shu, the AI's seal). */
export const AI_SUGGESTION_COLOR = '#C8442C'

export interface DerivedSuggestion {
  id: string
  from: number
  to: number
  kind: SuggestionKind
  text: string
  /** The struck text as the author saw it. */
  deleted: string
  /** The struck text as it is now (differs when `changed`). */
  current: string
  authorId: number | null
  authorName: string
  authorAvatarSeed: string | null
  /** Groups "accept all from X": `user:<id>`, `anon:<seed>`, `ai`. */
  authorKey: string
  isAi: boolean
  color: string
  createdAt: number
  updatedAt: number
  obsolete: boolean
  changed: boolean
  mine: boolean
  groupId: string | null
  jobId: string | null
  record: SuggestionRecord
}

interface LocalAuthor {
  id: number | null
  name: string
  avatarSeed: string | null
  color: string
}

function readLocalAuthor(awareness: Awareness): LocalAuthor {
  const u = (awareness.getLocalState()?.user ?? {}) as { id?: unknown, name?: unknown, avatarSeed?: unknown, color?: unknown }
  const id = typeof u.id === 'number' ? u.id : null
  const color = typeof u.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(u.color) ? u.color : (AWARENESS_PALETTE[0] ?? '#7A8C7E')
  return {
    id,
    name: typeof u.name === 'string' && u.name.length > 0 ? u.name.slice(0, 120) : 'Anonymous',
    avatarSeed: id === null && typeof u.avatarSeed === 'string' && /^[A-Za-z0-9]{1,32}$/.test(u.avatarSeed) ? u.avatarSeed : null,
    color
  }
}

function isMine(r: SuggestionRecord, me: LocalAuthor): boolean {
  if (r.authorPrincipal !== null) return false
  if (me.id !== null) return r.authorId === me.id
  return r.authorId === null && r.authorAvatarSeed !== null && r.authorAvatarSeed === me.avatarSeed
}

export interface SuggestionSelection {
  ids?: string[]
  authorKey?: string
}

export function useSuggestions(ydoc: Y.Doc, awareness: Awareness, docId: string) {
  const ymap = suggestionsMap(ydoc)
  const ytext = ydoc.getText('content')
  const suggestions = shallowRef<DerivedSuggestion[]>([])

  function recompute() {
    const me = readLocalAuthor(awareness)
    const text = ytext.toString()
    suggestions.value = readSuggestions(ydoc).map((s) => {
      const r = s.record
      return {
        id: r.id,
        from: s.from,
        to: s.to,
        kind: suggestionKind(r, s.to - s.from),
        text: r.text,
        deleted: r.deleted,
        current: text.slice(s.from, s.to),
        authorId: r.authorId,
        authorName: r.authorName,
        authorAvatarSeed: r.authorAvatarSeed,
        authorKey: suggestionAuthorKey(r),
        isAi: r.authorPrincipal !== null,
        color: r.authorPrincipal !== null ? AI_SUGGESTION_COLOR : r.color,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        obsolete: s.obsolete,
        changed: s.changed,
        mine: isMine(r, me),
        groupId: r.groupId,
        jobId: r.jobId,
        record: r
      }
    })
  }

  // The map changes (suggestions) and the text changes (anchors move) both
  // change the list; one listener on the document covers both.
  const onUpdate = () => recompute()
  ydoc.on('update', onUpdate)
  // `mine` depends on who we are, which awareness learns after the token.
  const onAwareness = () => recompute()
  awareness.on('change', onAwareness)
  recompute()
  onUnmounted(() => {
    ydoc.off('update', onUpdate)
    awareness.off('change', onAwareness)
  })

  const marks = computed<SuggestionMark[]>(() => suggestions.value.map(s => ({
    id: s.id,
    from: s.from,
    to: s.to,
    text: s.text,
    color: s.color,
    mine: s.mine,
    obsolete: s.obsolete,
    authorName: s.authorName
  })))

  /** Write the suggestions a local edit was planned into (suggesting mode). */
  function applyPlan(plan: SuggestPlan): void {
    if (plan.writes.length === 0) return
    const me = readLocalAuthor(awareness)
    const now = Date.now()
    ydoc.transact(() => {
      for (const w of plan.writes) {
        if (w.kind === 'remove') {
          ymap.delete(w.id)
          continue
        }
        const anchors = anchorRange(ytext, w.from, w.to)
        const deleted = ytext.toString().slice(w.from, w.to)
        if (w.kind === 'update') {
          const prev = parseSuggestion(ymap.get(w.id))
          if (!prev) continue
          ymap.set(w.id, { ...prev, ...anchors, text: w.text, deleted, updatedAt: now })
          continue
        }
        const id = nanoid(16)
        const record: SuggestionRecord = {
          v: 1,
          id,
          ...anchors,
          text: w.text,
          deleted,
          authorId: me.id,
          authorName: me.name,
          authorAvatarSeed: me.avatarSeed,
          authorPrincipal: null,
          color: me.color,
          createdAt: now,
          updatedAt: now,
          groupId: null,
          jobId: null
        }
        ymap.set(id, record)
      }
    }, SUGGEST_ORIGIN)
  }

  /** Remove your own suggestion (allowed in suggest-only mode too). */
  function withdraw(id: string): void {
    const s = suggestions.value.find(x => x.id === id)
    if (!s?.mine) return
    ydoc.transact(() => ymap.delete(id), SUGGEST_ORIGIN)
  }

  /** Accept or reject on the server (needs edit rights). */
  async function resolve(action: 'accept' | 'reject', select: SuggestionSelection = {}): Promise<{ resolved: number }> {
    return await apiFetch('/api/docs/:docId/suggestions/resolve', {
      method: 'post',
      path: { docId },
      body: { action, ...(select.ids ? { ids: select.ids } : {}), ...(select.authorKey ? { authorKey: select.authorKey } : {}) }
    })
  }

  return { suggestions: readonly(suggestions), marks, applyPlan, withdraw, resolve }
}

export type SuggestionsApi = ReturnType<typeof useSuggestions>

// EditorLayout provides one instance; the panel and the editor read it.
const [useProvideSuggestionsState, useInjectSuggestions] = createInjectionState(
  (ydoc: Y.Doc, awareness: Awareness, docId: string) => useSuggestions(ydoc, awareness, docId)
)

export const useProvideSuggestions = useProvideSuggestionsState

export function useSuggestionsContext(): SuggestionsApi {
  const api = useInjectSuggestions()
  if (!api) throw new Error('useSuggestionsContext() called outside the editor that provides suggestions')
  return api
}
