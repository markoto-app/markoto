import type * as Y from 'yjs'
import type { DocTheme } from '~~/shared/types/theme'
import { defaultTheme } from '~~/shared/utils/theme/defaultTheme'
import { isValidTheme } from '~~/shared/utils/theme/themeValidation'
import { readThemeFromYmeta, canEditTheme as computeCanEditTheme } from '~~/shared/utils/documents/documentHelpers'
import { clampMetaString } from '~~/shared/utils/documents/ymetaValidation'
import { isAudienceKind, type AudienceKind } from '~~/shared/audiences'
import type { DocAccessState } from './docAccessState'

/**
 * The `ymeta` bridge of an open document: title, theme, document context and
 * the deletion flag, mirrored into Vue refs (`ymeta.get()` isn't tracked by
 * Vue), with setters that write Y.js and, for the owner, seed the documents
 * row. Part of `useDocument`; Y.js stays the live source of truth.
 */
export function useDocumentMeta(docId: string, ymeta: Y.Map<unknown>, access: DocAccessState) {
  // Document settings are not suggestions: a suggest-only connection
  // can't write them (the sync server would close it).
  const metaLocked = () => access.isReadOnly.value || access.suggestOnly.value
  // The live title is empty until a client sets one: a doc created via the
  // new-document dialog carries it only on the DB row (from /token), which
  // the computed `title` falls back to.
  const ymetaTitle = ref((ymeta.get('title') as string) || '')
  // Set by the sync server when the owner deletes the doc; every connected client redirects away.
  const isDeleted = ref(!!ymeta.get('_deleted'))
  // True while THIS client's own delete request is in flight. The sync server
  // broadcasts `_deleted` before the DELETE response lands, so without this
  // the deleter would see "deleted by the owner".
  const deletingHere = ref(false)
  const deletedByOther = computed(() => isDeleted.value && !deletingHere.value)
  function setDeletingHere(active: boolean) {
    deletingHere.value = active
  }
  // The theme lives on ymeta.theme as plain JSON so it broadcasts like the
  // title; `defaultTheme` until /token seeds the DB value or sync delivers it.
  const themeRef = ref<DocTheme>(defaultTheme)
  // Document context: same dual source as the theme (/token first, then ymeta).
  const descriptionRef = ref<string>((ymeta.get('description') as string) ?? '')
  const audienceRef = ref<string>((ymeta.get('audience') as string) ?? 'casual')
  const languageRef = ref<string>((ymeta.get('language') as string) ?? 'en')
  ymeta.observe(() => {
    ymetaTitle.value = (ymeta.get('title') as string) || ''
    if (ymeta.get('_deleted')) isDeleted.value = true
    themeRef.value = readThemeFromYmeta(ymeta)
    const d = ymeta.get('description')
    if (typeof d === 'string') descriptionRef.value = d
    const a = ymeta.get('audience')
    if (typeof a === 'string') audienceRef.value = a
    const l = ymeta.get('language')
    if (typeof l === 'string') languageRef.value = l
  })

  const title = computed({
    get: () => ymetaTitle.value || access.initialTitle.value || 'Untitled',
    set: (v: string) => {
      // Clamped to the sync server's ymeta bounds; an over-long value would close the connection.
      if (!metaLocked()) ymeta.set('title', clampMetaString('title', v))
    }
  })

  /**
   * Read-only: no. Owned by someone else: no. Ownerless (anonymous-created):
   * yes, matching its open-edit content. `PUT /meta` is owner-gated, so
   * ownerless docs skip persisting and rely on Y.js sync alone.
   */
  const canEditTheme = computed(() => computeCanEditTheme({
    isReadOnly: metaLocked(),
    isOwner: access.isOwner.value,
    hasOwner: access.hasOwner.value
  }))

  /**
   * The DB write (debounced PUT /meta, owned docs only) is a best-effort
   * seed so a fresh visitor sees the right theme before the sync server
   * replays the update history; Y.js stays the live source of truth.
   */
  const persistTheme = useDebounceFn((next: DocTheme) => {
    apiFetch('/api/docs/:docId/meta', {
      method: 'put',
      path: { docId },
      body: { theme: next }
    }).catch(() => {})
  }, 800)

  // Same pattern as `persistTheme`: owner-only DB writes; non-owners on
  // open-edit docs still change ymeta, and Y.js sync is then the only
  // persistence.
  //
  // Changes are MERGED before the debounced PUT because `useDebounceFn` only
  // runs the last call's arguments: setting audience then language within
  // 800 ms would otherwise persist only the language, and the AI reads
  // these fields from the row.
  type DocContextPatch = { description?: string, audience?: AudienceKind, language?: string, templateId?: string }
  let pendingDocContext: DocContextPatch = {}
  const flushDocContext = useDebounceFn(() => {
    const body = pendingDocContext
    pendingDocContext = {}
    apiFetch('/api/docs/:docId/meta', {
      method: 'put',
      path: { docId },
      body
    }).catch(() => {})
  }, 800)
  function persistDocContext(next: DocContextPatch) {
    pendingDocContext = { ...pendingDocContext, ...next }
    // The debounced body swallows its own failure (best-effort seed).
    void flushDocContext()
  }

  function setTheme(next: DocTheme) {
    if (!canEditTheme.value) return
    if (!isValidTheme(next)) return
    ymeta.set('theme', next) // the observer above updates themeRef
    if (access.isOwner.value) void persistTheme(next)
  }

  // Clears the ymeta entry and, for owned docs, nulls the DB column; everyone falls back to `defaultTheme`.
  function resetTheme() {
    if (!canEditTheme.value) return
    ymeta.delete('theme')
    themeRef.value = defaultTheme
    if (access.isOwner.value) {
      apiFetch('/api/docs/:docId/meta', {
        method: 'put',
        path: { docId },
        body: { theme: null }
      }).catch(() => {})
    }
  }

  // Same write semantics as the theme: editors change them, viewers cannot.
  const description = computed({
    get: () => descriptionRef.value,
    set: (v: string) => {
      if (metaLocked()) return
      const next = clampMetaString('description', v)
      ymeta.set('description', next)
      if (access.isOwner.value) persistDocContext({ description: next })
    }
  })
  const audience = computed({
    get: () => audienceRef.value,
    set: (v: string) => {
      if (metaLocked()) return
      ymeta.set('audience', v)
      // The route accepts only the known audiences; anything else would be a 400 it swallows.
      if (access.isOwner.value && isAudienceKind(v)) persistDocContext({ audience: v })
    }
  })
  const language = computed({
    get: () => languageRef.value,
    set: (v: string) => {
      if (metaLocked()) return
      const next = clampMetaString('language', v)
      ymeta.set('language', next)
      if (access.isOwner.value) persistDocContext({ language: next })
    }
  })

  /**
   * Template the doc started from. Not in ymeta (it only seeds the first
   * body); the Markdown import restores it from the file's frontmatter,
   * persisted for owners like the other context fields.
   */
  function setTemplateId(next: string) {
    if (metaLocked()) return
    access.templateId.value = next
    if (access.isOwner.value) persistDocContext({ templateId: next })
  }

  // Seeds the theme + document-context refs from the DB values (/token, or
  // /meta after a password unlock) so the preview and Document tab paint
  // before sync settles; the ymeta observers take over afterwards.
  function applyInitialSeeds() {
    if (access.initialTheme.value && isValidTheme(access.initialTheme.value)) {
      themeRef.value = access.initialTheme.value
    }
    descriptionRef.value = access.initialDescription.value
    audienceRef.value = access.initialAudience.value
    languageRef.value = access.initialLanguage.value
  }

  return {
    isDeleted,
    deletedByOther,
    setDeletingHere,
    title,
    theme: readonly(themeRef),
    description,
    audience,
    language,
    setTemplateId,
    canEditTheme,
    setTheme,
    resetTheme,
    applyInitialSeeds
  }
}
