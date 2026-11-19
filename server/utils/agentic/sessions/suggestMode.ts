import type { UserScope } from '../../../repos/proofs'
import type { DocAuthzRow } from '../../access/docProof'
import { getAiSuggestEdits } from '../../../repos/users'
import { mustSuggest } from '../../suggestions/suggestionAccess'

// Whether an AI session suggests instead of editing: always when the
// document requires suggestions of the person who started it (the AI must
// not get around it), else what they asked for (the prompt bar's switch,
// falling back to their setting).

export interface SessionSuggestMode {
  /** Required by the document: document settings are off limits too. */
  forced: boolean
}

export async function sessionSuggestMode(row: DocAuthzRow, self: UserScope, requested: boolean | undefined): Promise<SessionSuggestMode | null> {
  if (mustSuggest(row, self.userId)) return { forced: true }
  const wanted = requested ?? await getAiSuggestEdits(self)
  return wanted ? { forced: false } : null
}

/** The note the first user message gets in suggestion mode (never the system prompt: prefix caching). */
export function withSuggestNote(prompt: string, mode: SessionSuggestMode | null): string {
  if (!mode) return prompt
  return `${prompt}\n\n<suggestion_mode>Your text edits are recorded as suggestions that a person accepts or rejects; the document text does not change until then. Make each change once, keep changes focused, and do not try to edit text you already suggested to change. Document settings (title, theme) can't be suggested.</suggestion_mode>`
}
