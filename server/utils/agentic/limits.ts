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

import { MINUTE_MS } from '~~/shared/config/units'

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
