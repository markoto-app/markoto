import { decideSuggestionAccess, decideTokenAccess, docStateOf, type ActorState, type DocState, type SuggestionDecision } from '~~/shared/utils/documents/docPermissions'
import { getDocWithActorRole, type DocAuthzRow } from '../access/docProof'

// The write level (full, suggest-only, read-only) a caller holds on a
// document: the token's decision with the document's suggestion settings
// applied. The token endpoint, the AI and MCP use it, so a person who must
// suggest can't edit directly through any of them.

export function suggestionAccessOf(row: DocAuthzRow, state: DocState, actor: ActorState): SuggestionDecision {
  return decideSuggestionAccess(state, actor, row.suggestionPolicy, decideTokenAccess(state, actor))
}

/** For a signed-in user acting through a server-side path (AI, MCP): must their edits be suggestions? */
export function mustSuggest(row: DocAuthzRow, userId: number): boolean {
  const actor: ActorState = { userId, workspaceRole: row.workspaceRole, isGuest: row.isGuest }
  return suggestionAccessOf(row, docStateOf(row), actor).suggestOnly
}

/** `mustSuggest` for a document the caller has no row of yet (a cross-document write). */
export async function mustSuggestOnDoc(docId: string, userId: number): Promise<boolean> {
  const row = await getDocWithActorRole(docId, userId)
  return row !== null && mustSuggest(row, userId)
}
