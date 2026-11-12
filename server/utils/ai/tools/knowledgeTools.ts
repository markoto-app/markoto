import { z } from 'zod'
import { defineMetaTool, pickStringArg, toolError, toolOk, type ToolResult } from './toolDefinition'
import type { MetaToolContext } from '../../agentic/toolContext'
import { getKnowledgeWithMarkdown, searchKnowledge } from '../../../repos/knowledge'
import { getMemberRole } from '../../../repos/workspaceMembers'
import { embedQuery } from '../../knowledge/embeddings'
import { assertKnowledgeEmbeddingsReady } from '../../knowledge/knowledgeEmbeddingsStatus'

// Workspace knowledge base: search_knowledge (hybrid semantic + lexical
// search over the chunks) and get_knowledge_file (one file's parsed
// Markdown). Only offered when the document is in a workspace with ready
// files (see the prompt endpoints).

// Only exposed when the current document is inside a workspace that the
// initiator is a member of — the runtime tool filter in prompt.post.ts
// drops these from the declarations otherwise, so the model isn't told
// about capabilities it can't actually use.
const SearchKnowledgeArgs = z.object({
  query: z.string().trim().min(1).max(500)
    .describe('Natural-language query. Semantic match, so ask the way you would ask a colleague — full phrases, not keyword salads. Example: "what does the procurement policy say about vendor onboarding timelines" rather than "procurement vendor timeline".'),
  top_k: z.number().int().min(1).max(15).optional()
    .describe('How many chunks to return. Default 5. Use 10–15 for research-style queries where you want to survey; use 3 when you want the single best hit.')
}).describe('Search the workspace knowledge base (uploaded PDFs, DOCX, etc.) by meaning and return the most relevant chunks with their source filename. Use BEFORE writing when the user references uploaded material ("what did the grant proposal say about X?", "summarise the research brief"), or when asked to write something grounded in workspace context. Only available when the document is in a workspace that has knowledge files.')

const GetKnowledgeFileArgs = z.object({
  knowledge_id: z.string().trim().min(1).max(64)
    .describe('The exact knowledge_id from the <knowledge_files> block in the system prompt. Do NOT guess — only pass ids that are listed there.')
}).describe('Retrieve the full parsed markdown of a single knowledge file. Use after `search_knowledge` when the returned chunks are insufficient and you need the whole document, or when the user asks to read / summarise a specific file by name (match it to the right knowledge_id from <knowledge_files>). Response may be truncated for very large files — an explicit marker is appended if so.')

// Max chars returned to the model for `get_knowledge_file`. Matches the
// inline-rewrite window — enough to fit a ~15-20k-token document, which
// covers most workspace uploads. Anything larger gets truncated with a
// marker so the model knows to re-query via `search_knowledge` for the
// rest of the content.
const KNOWLEDGE_FILE_CHAR_CAP = 40_000
// We no longer floor by raw cosine similarity — the hybrid fusion can
// surface a low-sim chunk that's a strong BM25 match (e.g. "section 4.3"
// queries) and that's the point of having BM25. Drop obvious junk via
// the per-source candidate pool size instead.

/**
 * Per-call membership recheck for knowledge tools. AI sessions are
 * long-lived (up to 5 min hard deadline) and session.workspaceId is
 * resolved ONCE at /api/ai/prompt time. If an admin demotes the
 * initiator to viewer — or removes them from the workspace entirely —
 * mid-session, we'd otherwise keep serving knowledge until the loop
 * ends. One cheap getMemberRole call per tool invocation closes that
 * window at tool-call granularity.
 *
 * Viewer role still passes: viewers can read knowledge (same as the
 * REST list endpoint). We reject only on "no membership at all".
 */
/** The document's workspace when the invoker is (still) a member of it, else the refusal. */
async function verifyWorkspaceMembership(session: MetaToolContext): Promise<{ workspaceId: string, denied?: undefined } | { denied: string }> {
  if (!session.workspaceId) {
    return { denied: 'Error: this tool is only available for documents inside a workspace.' }
  }
  const role = await getMemberRole(session.workspaceId, session.initiatorUserId)
  if (!role) {
    return { denied: 'Error: your membership in this workspace has been revoked. Knowledge tools are unavailable.' }
  }
  return { workspaceId: session.workspaceId }
}

async function handleSearchKnowledge(session: MetaToolContext, input: z.output<typeof SearchKnowledgeArgs>): Promise<ToolResult> {
  const membership = await verifyWorkspaceMembership(session)
  if (membership.denied !== undefined) return toolError(membership.denied)
  const { workspaceId } = membership
  const topK = input.top_k ?? 5

  session.updateStatus('tool', `Searching workspace knowledge for "${input.query.slice(0, 80)}"…`)

  let queryEmbedding: number[]
  try {
    await assertKnowledgeEmbeddingsReady()
    queryEmbedding = await embedQuery(input.query)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return toolError(`Error: failed to embed query: ${msg}`)
  }

  const hits = await searchKnowledge({
    workspaceId,
    queryText: input.query,
    queryEmbedding,
    topK
  })

  if (hits.length === 0) {
    return toolOk('No relevant chunks found in the workspace knowledge base for this query. The knowledge base may not contain information on this topic — consider web_search, fetch_url, or asking the user.')
  }

  // Format: show semantic + lexical signals so the model can tell a
  // "paraphrased near-miss" (high sim, zero textScore) from an "exact
  // phrase hit" (low sim, high textScore). Keeps RRF transparent.
  const lines: string[] = [
    `Found ${hits.length} relevant chunk${hits.length === 1 ? '' : 's'}:`,
    ''
  ]
  for (const h of hits) {
    const sim = h.similarity > 0 ? h.similarity.toFixed(3) : '—'
    const bm25 = h.textScore > 0 ? h.textScore.toFixed(3) : '—'
    lines.push(
      `--- ${h.filename} (chunk ${h.chunkIndex}, semantic=${sim} lexical=${bm25}) ---`,
      h.content,
      ''
    )
  }
  return toolOk(lines.join('\n'))
}

async function handleGetKnowledgeFile(session: MetaToolContext, input: z.output<typeof GetKnowledgeFileArgs>): Promise<ToolResult> {
  const membership = await verifyWorkspaceMembership(session)
  if (membership.denied !== undefined) return toolError(membership.denied)

  session.updateStatus('tool', `Reading knowledge file ${input.knowledge_id}…`)

  const row = await getKnowledgeWithMarkdown(input.knowledge_id)
  if (!row) {
    return toolError(`Error: knowledge_id "${input.knowledge_id}" not found. Use only ids from the <knowledge_files> block in the system prompt.`)
  }
  // Scope check — knowledge is workspace-scoped, session is workspace-scoped.
  if (row.workspaceId !== session.workspaceId) {
    return toolError(`Error: knowledge_id "${input.knowledge_id}" belongs to a different workspace.`)
  }
  if (row.status !== 'ready') {
    const errTail = row.errorMessage ? `: ${row.errorMessage}` : ''
    return toolError(`Error: knowledge file "${row.filename}" is currently in status "${row.status}"${errTail}.`)
  }
  if (!row.markdownCache) {
    return toolError(`Error: knowledge file "${row.filename}" has no cached content. Try search_knowledge instead.`)
  }

  const md = row.markdownCache
  if (md.length <= KNOWLEDGE_FILE_CHAR_CAP) {
    return toolOk(`# ${row.filename}\n\n${md}`)
  }
  const head = md.slice(0, KNOWLEDGE_FILE_CHAR_CAP)
  return toolOk(
    `# ${row.filename}\n\n${head}\n\n[… truncated at ${KNOWLEDGE_FILE_CHAR_CAP} characters of ${md.length}. Use search_knowledge with a targeted query to retrieve the remaining content. …]`
  )
}

export const searchKnowledgeTool = defineMetaTool({
  name: 'search_knowledge',
  description: 'Semantic search over this workspace\'s uploaded knowledge (PDFs, DOCX, etc.). Returns the top-K most relevant chunks with filename, chunk index, similarity score, and content. Use BEFORE writing when the user references uploaded files ("based on the grant proposal…", "what does the policy say about…"). Prefer this over `web_search` for workspace-private info. Only call for queries you actually intend to use — the model pays for each call.',
  schema: SearchKnowledgeArgs,
  // A cheap query, but the model can loop on "checking again" every
  // turn. 20 is plenty for one prompt.
  sessionCallCap: 20,
  trustBoundary: 'confirm',
  activity: args => ({ kind: 'ai.tool', tool: 'search_knowledge', query: pickStringArg(args, 'query', 200) }),
  handler: handleSearchKnowledge
})

export const getKnowledgeFileTool = defineMetaTool({
  name: 'get_knowledge_file',
  description: 'Retrieve the full parsed markdown of one specific knowledge file, given its knowledge_id from the <knowledge_files> block. Use when chunks from `search_knowledge` are insufficient and you need the whole document, or when the user asks to summarise / quote a specific file by name. Large files may be truncated with an explicit marker — re-chunk your reasoning instead of asking again.',
  schema: GetKnowledgeFileArgs,
  trustBoundary: 'confirm',
  activity: args => ({ kind: 'ai.tool', tool: 'get_knowledge_file', knowledgeId: pickStringArg(args, 'knowledge_id', 64) }),
  handler: handleGetKnowledgeFile
})
