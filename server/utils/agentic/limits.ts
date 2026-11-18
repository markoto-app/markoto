// Hard-coded ceilings that gate the agentic loop independent of the
// per-user LiteLLM budget. These are runaway-loop safeties, not
// normal-usage caps: a typical session uses 3-8 interactions and makes
// 0-2 tool calls. Hitting any of these is a bug, an attack, or a
// pathological prompt.
//
// The budget is the business limit; these are the safety limits. A single
// runaway prompt should not drain a user's budget in one session, and
// cost-amplifying tools (image gen, web search) are capped per session
// even when the budget would allow more.

import { MINUTE_MS, SECOND_MS } from '~~/shared/config/units'

/**
 * Total interactions any single agentic-loop run is allowed to
 * accumulate across all turns + sub-calls. A normal session uses
 * 3-8; >50 indicates a tool-call ping-pong loop or a prompt-
 * injection attack trying to amplify cost.
 *
 * On hit: the loop ABORTS via the existing setStatus('error', …)
 * path so the user sees a meaningful "stopped: …" message rather
 * than a silent cutoff. The model never gets a chance to recover,
 * exceeding 50 interactions means the session is already off the
 * rails.
 */
export const SESSION_INTERACTION_CAP = 50

// The per-tool call caps live on the tool definitions
// (`sessionCallCap`, collected in `ai/tools/registry.ts`).

/**
 * Hard deadline for a full agentic loop (editor prompt or comment trigger).
 * Web search, model thinking and multi-edit sequences take minutes; 5 min
 * kills truly stuck sessions. The stale-session sweeper
 * (`SWEEPS.aiSessions.staleAfterMs`, 7 min) must stay longer than this.
 */
export const AI_SESSION_HARD_DEADLINE_MS = 5 * MINUTE_MS

/**
 * With less than this left before the hard deadline the loop starts no
 * further work turn: it runs one closing turn that tells the user what is
 * done and what is not (`loop/wrapUp.ts`), instead of being cut off.
 */
export const AI_SESSION_WRAP_UP_MARGIN_MS = 30 * SECOND_MS

/**
 * Most characters one tool result may put into the conversation (about 6-7k
 * tokens). Every later model call resends the whole history, so one
 * unbounded read (a book-length document, a long comment list) is paid for
 * on every turn after it. Longer results are cut by the loop with a hint
 * on how to read the rest (`loop/resultCap.ts`); the reading tools keep
 * their own output below it and say how to continue.
 */
export const TOOL_RESULT_CHAR_CAP = 24_000

/**
 * In-session pruning of old read results (`loop/historyPruning.ts`). A
 * read result outside the latest `PRUNE_KEEP_RECENT_TURNS` turns is
 * prunable when it is at least `PRUNE_LARGE_RESULT_CHARS` long (about 4-5k
 * tokens), or at least `PRUNE_SUPERSEDED_MIN_CHARS` long and superseded (a
 * later edit of the document, or a later read of the same target). Pruning
 * only runs once the prunable total passes `PRUNE_BATCH_CHARS`, so the
 * conversation prefix (and the provider's prompt cache) changes rarely.
 */
export const PRUNE_LARGE_RESULT_CHARS = 16_000
export const PRUNE_SUPERSEDED_MIN_CHARS = 2_000
export const PRUNE_BATCH_CHARS = 40_000
export const PRUNE_KEEP_RECENT_TURNS = 2
