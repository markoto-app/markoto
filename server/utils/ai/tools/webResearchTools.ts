import { z } from 'zod'
import { defineMetaTool, type ToolResult } from './toolDefinition'
import type { MetaToolContext } from '../../agentic/toolContext'
import { webSearch } from './webSearch'
import { fetchUrl } from './fetchUrl'
import { workerProviderFor } from '../../aiProviders/resolve'

// web_search (Staan search + synthesis) and fetch_url (Staan Fetch +
// synthesis). The in-app loop runs both itself (`agentic/loop/webSubCalls.ts`:
// its abort signal, its model, citation reminders and an activity row);
// `run` here serves MCP and the test route through the same surface as
// every other tool.

export const WebSearchArgs = z.object({
  query: z.string().min(1)
    .describe('Natural-language search query.')
}).describe('Search the web for up-to-date information with cited sources.')

const FetchUrlArgs = z.object({
  url: z.string().trim().min(1).max(2048)
    .describe('The URL to fetch. Any public web page (article, blog, docs, portfolio). A missing scheme is treated as https://. Do not pass /api/files/... paths, use view_image for those.'),
  question: z.string().trim().max(500).optional()
    .describe('Mode "answer": what you need from the page. The answer is extracted from the page instead of a general summary.'),
  mode: z.enum(['answer', 'extract']).optional()
    .describe('"answer" (default): a summary, or the answer to `question`, plus image URLs. "extract": the page\'s Markdown itself, about 8000 characters per page; use it when you need exact wording, tables or code.'),
  page: z.number().int().min(1).max(50).optional()
    .describe('Mode "extract": which page of the Markdown to return (1 = first). The result says how many pages there are.')
}).describe('Fetch a specific URL and extract its readable text content plus any image URLs visible on the page. Use when the user names or links a source to draw information from. Returns both synthesised text AND a list of image URLs you can then inspect with view_image or embed verbatim via insert_text.')

// MCP tool calls have no in-flight abort signal (no equivalent of the
// loop's 5-min deadline), so web_search / fetch_url get a never-aborts
// signal and rely on the underlying SDKs' own timeouts.
function neverAbortSignal(): AbortSignal {
  return new AbortController().signal
}

/** Spend context of a web tool call made outside the loop: the caller's key, provider and tags. */
function spendContext(ctx: MetaToolContext) {
  return {
    workspaceId: ctx.workspaceId,
    userId: ctx.initiatorUserId,
    docId: ctx.docId,
    attributedTo: ctx.attributedTo,
    // Authenticate the charge and the synthesis with the caller's virtual key and run
    // the synthesis on their worker model (BYOK: their key), matching the in-app loop.
    virtualKey: ctx.virtualKey,
    chatProvider: ctx.aiProviders.chat,
    workerProvider: workerProviderFor(ctx.aiProviders, 'utility')
  }
}

export const webSearchTool = defineMetaTool({
  name: 'web_search',
  description: 'Search the web for up-to-date or factual information. Use for time-sensitive queries (current events, prices, recent news) before writing. Returns a synthesised answer with cited sources; the model can then cite or quote them in the document.',
  schema: WebSearchArgs,
  requires: 'webSearch',
  // Research-style usage beyond 10 calls should be split across sessions.
  sessionCallCap: 10,
  trustBoundary: 'confirm',
  handler: async (ctx, { query }): Promise<ToolResult> => {
    const result = await webSearch(undefined, '', query, neverAbortSignal(), spendContext(ctx))
    return { content: result.text, isError: false }
  }
})

export const fetchUrlTool = defineMetaTool({
  name: 'fetch_url',
  description: 'Fetch a specific URL and extract both its readable text content AND a list of image URLs visible on the page. Use when the user names or links a source to draw information from (e.g. "write about me based on myportfolio.com"). Differs from `web_search`, that one searches the web for a topic; this one reads a URL you already have. Pass `question` to get just the answer from the page; use `mode: "extract"` (with `page`) to read the page Markdown verbatim. The returned image URLs can be passed to `view_image` to inspect them or embedded directly via `insert_text` as `![alt](https://...)`.',
  schema: FetchUrlArgs,
  requires: 'webFetch',
  sessionCallCap: 10,
  trustBoundary: { urlArg: 'url' },
  handler: async (ctx, { url, question, mode, page }): Promise<ToolResult> => {
    const result = await fetchUrl(undefined, '', url, neverAbortSignal(), spendContext(ctx), { question, mode, page })
    return { content: result.text, isError: false }
  }
})
