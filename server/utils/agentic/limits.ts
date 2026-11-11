// Hard-coded ceilings that gate the agentic loop independent of the
// per-user LiteLLM budget. These are runaway-loop safeties, not
// normal-usage caps — a typical session uses 3-8 interactions and makes
// 0-2 tool calls. Hitting any of these is a bug, an attack, or a
// pathological prompt.
//
// The budget is the business limit; these are the safety limits. A single
// runaway prompt should not drain a user's budget in one session, and
// cost-amplifying tools (image gen, web search) are capped per session
// even when the budget would allow more.

/**
 * Total interactions any single agentic-loop run is allowed to
 * accumulate across all turns + sub-calls. A normal session uses
 * 3-8; >50 indicates a tool-call ping-pong loop or a prompt-
 * injection attack trying to amplify cost.
 *
 * On hit: the loop ABORTS via the existing setStatus('error', …)
 * path so the user sees a meaningful "stopped: …" message rather
 * than a silent cutoff. The model never gets a chance to recover —
 * exceeding 50 interactions means the session is already off the
 * rails.
 */
export const SESSION_INTERACTION_CAP = 50

/**
 * Max calls per tool name within a single session. Hitting one of
 * these returns a TOOL ERROR (not an abort) so the model sees the
 * cap and can wrap up its response gracefully.
 *
 * Numbers are sized against what a pathological loop looks like:
 *   - view_pages: 3 calls × 5 pages each = 15 page-images, enough to
 *     inspect any document. More than 3 means the model is stuck.
 *   - generate_image: a doc never needs more than a handful of new
 *     images per session.
 *   - web_search / fetch_url: 10 each. Beyond that is research-style
 *     usage that should be split across sessions.
 *   - search_knowledge: a cheap query, but the model can loop on
 *     "checking again" every turn. 20 is plenty for one prompt.
 */
export const SESSION_TOOL_CALL_CAPS: Record<string, number> = {
  view_pages: 3,
  generate_image: 5,
  web_search: 10,
  fetch_url: 10,
  search_knowledge: 20,
  // Pure-DB tool, but bounded so the model can't loop on "search again
  // with slightly different filters". 8 covers its use cases (recall a
  // past edit, audit a restore, find the ai.tool rows behind a claim).
  search_activity_log: 8
}
