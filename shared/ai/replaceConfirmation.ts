// The confirmation of a large `replace_all` (a rename across the document),
// as the server sends it through the initiator's session channel and the
// prompt bar shows it: how many occurrences change and the word forms with
// their counts ("Pikettdienst → Bereitschaftsdienst (10)"), Apply / Cancel.

/** Word forms listed in the confirmation at most. */
export const REPLACE_CONFIRMATION_FORMS_MAX = 8

/** A `replace_all` that changes at least this many occurrences asks the user first (in-app sessions only). */
export const REPLACE_CONFIRMATION_MIN_CHANGES = 10

export interface ReplaceConfirmationForm {
  from: string
  to: string
  count: number
}

export interface ReplaceConfirmationDetails {
  /** Occurrences that would change. */
  total: number
  /** The most frequent word forms, at most `REPLACE_CONFIRMATION_FORMS_MAX`. */
  forms: ReplaceConfirmationForm[]
}
