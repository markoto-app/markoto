import type { AiStatusStep } from '~~/shared/ai/statusSteps'

// Session types shared by `useAI` and its helper modules. They live in this
// leaf module so the helpers don't import back from `useAI.ts`, which
// re-exports them as part of its API. A sub-folder of app/types on purpose:
// Nuxt auto-imports the top level of app/types, which would register every
// name a second time next to the `useAI` re-export.

/**
 * What EVERY participant of the document can see about an AI session
 * (from Y.js awareness): who started it, its coarse phase, and the
 * comment thread for `@ai` sessions. The prompt, status text and
 * answers are private to the initiator, see `MyAiSessionInfo`.
 */
export interface AiSessionInfo {
  sessionId: string
  initiatorName: string
  initiatorUserId: number
  // Known phases: 'thinking' | 'tool' | 'editing' | 'done' | 'error'.
  // The wider `string` accepts upstream phase additions without forcing
  // this union to drift.
  phase: string
  /**
   * Set when the session was triggered by an `@ai` mention in a
   * comment thread: carries the thread id so the comments panel can
   * render a "AI is working on this thread" indicator on the matching
   * card. Undefined for normal prompt-bar / selection-popup sessions.
   */
  commentThreadId?: string | null
}

/** A confirmation the server is waiting for (taint gate). */
export interface AiConfirmationRequest {
  id: string
  /** Tool the AI wants to run (`view_other_document`, `web_search`, …). */
  tool: string
  /** Human-readable target: document title, query, URL, filename. */
  target: string | null
  /** Server wall-clock ms after which an unanswered request counts as "deny". */
  expiresAt: number
}

/**
 * The initiator's own session: the public fields plus what only they
 * receive through `GET /api/ai/sessions/:id` (prompt, status message,
 * pending confirmation).
 */
export interface MyAiSessionInfo extends AiSessionInfo {
  prompt: string
  message: string | null
  /** The status as a step code, rendered in the UI language (`ai.step.*`). */
  step: AiStatusStep | null
  confirmation: AiConfirmationRequest | null
}

/** Response surface for the AI prompt bar's response panel. */
export interface AiResponseEntry {
  /** Identifier of the session that produced this response. */
  sessionId: string
  /** Body: short text or lightweight markdown, max 600 chars from the server. */
  message: string
  /** Sticky-on-screen when true; auto-collapses when false. */
  isQuestion: boolean
  /** Server-stamped wall-clock ms; drives dedup + the 2s collapse timer. */
  ts: number
}

/** How my most recent session ended, `error` is what the failure toast reports. */
export interface AiSessionOutcome {
  sessionId: string
  phase: 'done' | 'error'
  message: string | null
}

/** The slice of `EventSource` the composable uses (injectable for tests). */
export interface AiEventSource {
  readonly readyState: number
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void
  onerror: ((event: Event) => void) | null
  close(): void
}
