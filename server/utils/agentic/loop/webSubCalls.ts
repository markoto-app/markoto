import { fetchUrlCitationReminder, webSearchCitationReminder } from '../citations'
import { webSearch } from '../../ai/tools/webSearch'
import { fetchUrl } from '../../ai/tools/fetchUrl'
import { isWebToolBudgetRefusal } from '../../ai/webToolCharge'
import { logAiTool } from './toolActivity'
import type { LoopContext } from './loopContext'

/**
 * web_search and fetch_url share the same shape: 2-call (Jina then
 * Mistral synthesis). Both run a session-context-aware fetch and emit
 * an ai.tool activity row on success.
 */
export async function runSubCall(
  ctx: LoopContext,
  name: 'web_search' | 'fetch_url',
  validatedArgs: unknown
): Promise<{ content: string, isError: boolean }> {
  const subCallContext = {
    workspaceId: ctx.opts.aiSession.workspaceId ?? null,
    userId: ctx.opts.aiSession.initiatorUserId ?? null,
    docId: ctx.opts.aiSession.docId ?? null,
    attributedTo: ctx.opts.billingContext.attributedTo,
    // The per-call charge (Staan / Jina, priced into the AI budget) and the
    // synthesis sub-call authenticate with the caller's virtual key (never
    // the master key). The synthesis runs on the session's chat provider,
    // the user's own key under BYOK.
    virtualKey: ctx.opts.billingContext.virtualKey,
    chatProvider: ctx.opts.aiSession.aiProviders.chat
  }

  try {
    if (name === 'web_search') {
      const { query } = validatedArgs as { query: string }
      const out = await webSearch(ctx.opts.ai, ctx.opts.model, query, ctx.opts.abortController.signal, subCallContext)
      void logAiTool(ctx.opts.aiSession.docAccess, ctx.opts.aiSession.sessionId, {
        kind: 'ai.tool',
        tool: 'web_search',
        query: query.slice(0, 200),
        sources: out.sources.slice(0, 10).map(s => ({
          title: s.title.slice(0, 200),
          uri: s.uri.slice(0, 500)
        }))
      })
      return { content: out.text + webSearchCitationReminder(out.sources), isError: false }
    }
    const { url } = validatedArgs as { url: string }
    const out = await fetchUrl(ctx.opts.ai, ctx.opts.model, url, ctx.opts.abortController.signal, subCallContext)
    void logAiTool(ctx.opts.aiSession.docAccess, ctx.opts.aiSession.sessionId, {
      kind: 'ai.tool',
      tool: 'fetch_url',
      url: out.url.slice(0, 500),
      summary: out.summary.slice(0, 600),
      images: out.images.slice(0, 6).map(i => ({
        url: i.url.slice(0, 500),
        description: i.description?.slice(0, 200)
      }))
    })
    return { content: out.text + fetchUrlCitationReminder(out.url), isError: false }
  } catch (e: unknown) {
    if (ctx.opts.abortController.signal.aborted) throw e
    const msg = e instanceof Error ? e.message : 'Unknown error'
    // The AI budget refused the call's charge: nothing ran upstream. On a
    // platform-paid chat model the next turn is refused by the same budget
    // and ends the session with the usual message; on a chat key of its
    // own the session goes on, so the model is asked to pass it on.
    if (isWebToolBudgetRefusal(e)) {
      return { content: `Error: ${name} was not run. ${msg} Tell the user, and continue without web tools.`, isError: true }
    }
    return { content: `Error: ${name} failed: ${msg}`, isError: true }
  }
}
