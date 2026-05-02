// Hard-coded ceilings that gate the agentic loop independent of the
// per-user monthly interaction budget. These are runaway-loop safeties,
// not normal-usage caps — a typical session uses 3-8 interactions and
// makes 0-2 tool calls. Hitting any of these is a bug, an attack, or a
// pathological prompt. The model should see the cap as a tool error so
// it can wrap up cleanly.
//
// Why per-session caps in addition to the per-user monthly budget:
//   1. The monthly budget is the BUSINESS limit (revenue / margin).
//      These are the SAFETY limits — a single runaway prompt should
//      never drain a Max user's $50/mo budget on one session.
//   2. Per-tool caps gate cost-amplifying tools (image gen, web
//      search) at the loop level, not just at the user level. Even
//      if a user has unlimited interactions, no single session
//      should burn 50 image generations.

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
 * cap and can wrap up its response gracefully — most loops can
 * still finish their reply without further tool use.
 *
 * Numbers chosen from "what does a pathological loop look like":
 *   - view_pages: 3 calls × 5 pages each = 15 page-images. More than
 *     enough to inspect any document. >3 is "model is stuck".
 *   - generate_image: 5 × $0.045 = $0.22 worst-case session cost.
 *     A doc never legitimately needs more than a handful of new
 *     images per session.
 *   - web_search / fetch_url: 10 each. Past the 5000/mo grounded-
 *     search free tier, that's ~$0.14/session at $14/1k. Above 10
 *     is research-style usage that should be split across sessions.
 *   - search_knowledge: cheap embedding query, but unbounded loops
 *     were possible (model "checks again" every turn). 20 is
 *     plenty for any single research-style prompt.
 */
export const SESSION_TOOL_CALL_CAPS: Record<string, number> = {
  view_pages: 3,
  generate_image: 5,
  web_search: 10,
  fetch_url: 10,
  search_knowledge: 20,
  // Pure-DB tool, but bounded so the model can't loop on
  // "search again with slightly different filters" forever. 8 is
  // plenty for the user-facing patterns this tool exists to serve
  // (recall a specific past edit, audit a recent restore, find
  // recent ai.tool rows that backed a claim).
  search_activity_log: 8
}
