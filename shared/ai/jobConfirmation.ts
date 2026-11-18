// The cost confirmation of a delegated AI job (`delegate_rewrite`), as the
// server sends it through the initiator's session channel and the prompt
// bar shows it ("Translate 152 sections to English: about $0.11 (22 % of
// this month's allowance), about 5 minutes. Start / Cancel").

export const JOB_CONFIRMATION_MODES = ['rewrite', 'translate', 'terminology', 'summarise', 'comment'] as const

export interface JobConfirmationDetails {
  mode: typeof JOB_CONFIRMATION_MODES[number]
  /** Worker calls (sections or parts). */
  units: number
  /** Estimated cost on the platform budget; null on the user's own key or an unknown price. */
  usd: number | null
  minutes: number
  /** Estimated cost as a share (0..1) of what is left of the allowance; null when unknown. */
  allowanceShare: number | null
  targetLanguage: string | null
  inputTokens: number
  outputTokens: number
}
