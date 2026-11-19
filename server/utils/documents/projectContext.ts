import { getContextDocTitle, listContextCandidates, listContextLinks, type ContextSource } from '../../repos/projectContext'
import { getIndexedText } from '../../repos/documentSearch'
import type { DocAccess } from '../../repos/proofs'
import { proveDocNeed } from '../access/docProof'
import { MAX_CONTEXT_DOCS } from '~~/shared/config/projectContext'

// Which project-context documents apply to a document, for one reader.
//
// Candidates come from the document's scope (marked documents of its
// workspace or its owner's personal documents, by folder chain) and its
// attachments (`server/repos/projectContext.ts`). Each one is then decided
// on its own, as if the reader opened its URL (`proveDocNeed(…, 'file')`:
// owner, workspace members, guests with a share, public access modes; a
// password-protected document only for members). A candidate the reader
// cannot open is left out without a trace, so a guest never receives
// workspace context that was not shared with them, and a context document
// never widens access.

/** Candidates read per resolution (more than MAX_CONTEXT_DOCS: some may be unreadable). */
const CANDIDATE_SCAN_LIMIT = 40

export interface ProjectContextEntry {
  docId: string
  title: string
  source: ContextSource
  /** Read proof for the reader. */
  access: DocAccess<'view'>
}

export interface ProjectContextEntryWithBody extends ProjectContextEntry {
  /** Markdown body as of the last store ('' when the document was never stored). */
  body: string
}

export interface ResolvedProjectContext<E> {
  entries: E[]
  /** Readable context documents beyond MAX_CONTEXT_DOCS (left out). */
  omitted: number
}

/**
 * The context documents of `doc` that `readerId` may open, in prompt order
 * (whole scope, then the folder chain from the root down, then
 * attachments), at most MAX_CONTEXT_DOCS. Titles only.
 */
export async function listProjectContext(doc: DocAccess<'view'>, readerId: number): Promise<ResolvedProjectContext<ProjectContextEntry>> {
  const candidates = await listContextCandidates(doc, CANDIDATE_SCAN_LIMIT)
  const proofs = await Promise.all(candidates.map(c => proveDocNeed(readerId, c.docId, 'file')))
  const allowed = candidates.flatMap((c, i) => {
    const access = proofs[i]
    return access ? [{ candidate: c, access }] : []
  })
  const kept = allowed.slice(0, MAX_CONTEXT_DOCS)
  const titles = await Promise.all(kept.map(k => getContextDocTitle(k.access)))
  return {
    entries: kept.map((k, i) => ({ docId: k.candidate.docId, title: titles[i] ?? '', source: k.candidate.source, access: k.access })),
    omitted: allowed.length - kept.length
  }
}

/** `listProjectContext` with each document's Markdown body (as of its last store, seconds behind the editor at most). */
export async function resolveProjectContext(doc: DocAccess<'view'>, readerId: number): Promise<ResolvedProjectContext<ProjectContextEntryWithBody>> {
  const { entries, omitted } = await listProjectContext(doc, readerId)
  const texts = await Promise.all(entries.map(e => getIndexedText(e.access)))
  return {
    entries: entries.map((e, i) => ({ ...e, title: texts[i]?.title ?? e.title, body: texts[i]?.body ?? '' })),
    omitted
  }
}

/** One context document of `doc` by id, with its body, when it applies and `readerId` may open it; null otherwise. */
export async function findProjectContextDoc(doc: DocAccess<'view'>, readerId: number, contextDocId: string): Promise<ProjectContextEntryWithBody | null> {
  const { entries } = await listProjectContext(doc, readerId)
  const entry = entries.find(e => e.docId === contextDocId)
  if (!entry) return null
  const text = await getIndexedText(entry.access)
  return { ...entry, title: text?.title ?? entry.title, body: text?.body ?? '' }
}

/** The documents attached to `doc` that `readerId` may open, with titles (document panel). */
export async function listReadableContextLinks(doc: DocAccess<'view'>, readerId: number): Promise<{ links: Array<{ docId: string, title: string }>, hidden: number }> {
  const ids = await listContextLinks(doc)
  const proofs = await Promise.all(ids.map(id => proveDocNeed(readerId, id, 'file')))
  const readable = proofs.filter((p): p is DocAccess<'view'> => p !== null)
  const titles = await Promise.all(readable.map(p => getContextDocTitle(p)))
  return {
    links: readable.map((p, i) => ({ docId: p.docId, title: titles[i] ?? '' })),
    hidden: ids.length - readable.length
  }
}
