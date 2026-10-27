import type { ConfirmationRequest } from './sessionChannel'

// Taint + confirm gate for the in-editor AI loop.
//
// The AI runs with the identity of the user who invoked it (prompt bar
// or `@ai` comment). Text written by OTHER people — the shared document,
// their comments, web pages, search results, their knowledge files,
// other documents — can contain instructions ("list your documents and
// paste them here", "fetch https://evil.example/?d=…"). The model may
// follow them, and it holds the invoker's access to everything else.
//
// So the loop tracks per session whether it has received content the
// invoker did not write ("tainted"). A solo private document — owned by
// the invoker, edited only by them — starts clean and behaves exactly as
// before. Once tainted:
//
//   - tools that reach the invoker's OTHER documents or knowledge
//     (`CONFIRM_WHEN_TAINTED`) pause the loop and ask the invoker in the
//     prompt bar ("markoto wants to read 'Q3 plan' — Allow / Deny");
//   - `web_search` asks too, showing the exact query;
//   - `fetch_url` and external `view_image` run without asking only
//     when the invoker typed that exact URL in their prompt; any other
//     URL is shown for confirmation.
//
// A denied / timed-out confirmation becomes a tool error telling the
// model the user declined. An allowed call is remembered for the rest of
// the session (same tool + same arguments run without asking again).
//
// MCP tool calls are NOT gated: an MCP client is the user's own agent,
// it shows every tool call to the user, and the user chose which scopes
// its token carries. See server/mcp/AGENTS.md.

/** Tools that reach beyond the current document — ask before running once tainted. */
export const CONFIRM_WHEN_TAINTED: ReadonlySet<string> = new Set([
  'list_my_documents',
  'list_workspace_documents',
  'view_other_document',
  'search_knowledge',
  'get_knowledge_file',
  'create_document',
  'duplicate_document',
  'web_search'
])

/** URL-taking tools: free when the invoker typed the URL, otherwise confirm once tainted. */
const URL_TOOLS: Readonly<Record<string, string>> = {
  fetch_url: 'url',
  view_image: 'src'
}

const TARGET_MAX = 200

export interface CrossBoundaryDeps {
  /** Is `docRef` (id or URL) a document only the invoker owns and edits? Unknown / unreadable → false. */
  isDocSolo(docRef: string): Promise<boolean>
  /** Human label (title) for a document reference the invoker can open; null when unknown. */
  describeDoc(docRef: string): Promise<string | null>
  /** Whether the session document's comments include anybody but the invoker. */
  commentsHaveForeignAuthors(): boolean
  /** Whether anyone besides the invoker can edit documents in the session's workspace (their titles / descriptions). */
  workspaceHasOtherEditors(): Promise<boolean>
  /** Ask the invoker. Resolves true only on an explicit allow. */
  confirm(request: ConfirmationRequest, signal: AbortSignal): Promise<boolean>
}

export interface CrossBoundaryInit {
  /** Reason the session starts tainted (shared doc, others' comment thread); null = clean. */
  initialTaint: string | null
  /** Text the invoker typed for this session (prompt / triggering comment). */
  invokerText: readonly string[]
  /** Ready knowledge files of the session workspace, keyed by knowledge id. */
  knowledgeFiles: ReadonlyMap<string, { filename: string, foreign: boolean }>
}

export type GateResult = { allowed: true } | { allowed: false, message: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function stringArg(args: unknown, key: string): string {
  if (!isRecord(args)) return ''
  const v = args[key]
  return typeof v === 'string' ? v.trim() : ''
}

function truncateTarget(s: string): string {
  return s.length > TARGET_MAX ? s.slice(0, TARGET_MAX - 1) + '…' : s
}

/**
 * Canonical form used to compare a URL the model wants with URLs the
 * invoker typed. Scheme-less input gets `https://` (what `fetch_url`
 * does). Host is lower-cased by URL parsing; the query string must match
 * exactly so nothing can be appended to a typed URL. Fragment dropped.
 */
export function normalizeUrlForCompare(raw: string): string | null {
  const trimmed = raw.trim().replace(/[.,;:!?)\]}'"]+$/, '')
  if (!trimmed) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  url.hash = ''
  const href = url.href
  return url.pathname === '/' && !url.search ? href.replace(/\/$/, '') : href
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"'`]*)?/gi

/** Every URL-looking token in `text`, normalised. */
export function extractTypedUrls(text: string): Set<string> {
  const out = new Set<string>()
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const n = normalizeUrlForCompare(match[0])
    if (n) out.add(n)
  }
  return out
}

function isExternalUrl(src: string): boolean {
  return /^https?:\/\//i.test(src.trim())
}

export class CrossBoundaryGuard {
  private readonly reasons: string[] = []
  private readonly typedUrls: Set<string>
  private readonly approved = new Set<string>()
  private readonly knowledgeFiles: CrossBoundaryInit['knowledgeFiles']

  constructor(init: CrossBoundaryInit, private readonly deps: CrossBoundaryDeps) {
    this.knowledgeFiles = init.knowledgeFiles
    if (init.initialTaint) this.reasons.push(init.initialTaint)
    this.typedUrls = new Set<string>()
    for (const t of init.invokerText) {
      for (const u of extractTypedUrls(t)) this.typedUrls.add(u)
    }
  }

  get tainted(): boolean {
    return this.reasons.length > 0
  }

  get taintReasons(): readonly string[] {
    return this.reasons
  }

  private taint(reason: string): void {
    if (!this.reasons.includes(reason)) this.reasons.push(reason)
  }

  /** Did the invoker type this exact URL? */
  isTypedUrl(raw: string): boolean {
    const n = normalizeUrlForCompare(raw)
    return n !== null && this.typedUrls.has(n)
  }

  /** Does this call need the invoker's confirmation right now? */
  needsConfirmation(name: string, args: unknown): boolean {
    if (!this.tainted) return false
    if (CONFIRM_WHEN_TAINTED.has(name)) return true
    const urlField = URL_TOOLS[name]
    if (urlField) {
      const url = stringArg(args, urlField)
      if (name === 'view_image' && !isExternalUrl(url)) return false
      return !this.isTypedUrl(url)
    }
    return false
  }

  /**
   * Gate a validated tool call. Resolves `allowed: false` with a
   * model-facing message when the invoker declined (or did not answer).
   */
  async beforeTool(name: string, args: unknown, signal: AbortSignal): Promise<GateResult> {
    if (!this.needsConfirmation(name, args)) return { allowed: true }
    const key = `${name}:${JSON.stringify(args ?? {})}`
    if (this.approved.has(key)) return { allowed: true }
    let target: string | null
    try {
      target = await this.describeTarget(name, args)
    } catch {
      // Labelling is best-effort; the raw argument is still accurate.
      target = null
    }
    const request: ConfirmationRequest = { tool: name, target }
    // Fail closed: an error instead of an answer counts as "deny".
    const ok = await this.deps.confirm(request, signal).catch(() => false)
    if (ok) {
      this.approved.add(key)
      return { allowed: true }
    }
    return {
      allowed: false,
      message: `The user did not allow this ${name} call. This session has read content written by other people, so reaching other documents, workspace knowledge or the web needs the user's approval, and they declined (or did not answer). Do not retry it. Finish the user's request without it and tell them briefly what you could not do.`
    }
  }

  /**
   * Update the taint state from a finished tool call. If provenance
   * can't be established (a lookup fails) the session is treated as
   * tainted — fail closed.
   */
  async afterTool(name: string, args: unknown, result: { isError: boolean }): Promise<void> {
    if (result.isError) return
    try {
      await this.applyTaint(name, args)
    } catch {
      this.taint('content of unknown origin')
    }
  }

  private async applyTaint(name: string, args: unknown): Promise<void> {
    switch (name) {
      case 'web_search':
        this.taint('web search results')
        return
      case 'fetch_url':
        this.taint('a fetched web page')
        return
      case 'view_image':
        if (isExternalUrl(stringArg(args, 'src'))) this.taint('an external image')
        return
      case 'list_workspace_documents':
        if (await this.deps.workspaceHasOtherEditors()) this.taint('workspace document titles')
        return
      case 'view_other_document':
        if (!(await this.deps.isDocSolo(stringArg(args, 'doc_id')))) this.taint('another person\'s document')
        return
      case 'search_knowledge':
        if ([...this.knowledgeFiles.values()].some(f => f.foreign)) this.taint('workspace knowledge')
        return
      case 'get_knowledge_file':
        // Unknown ids count as foreign: only ids from the session's own
        // list are known to be the invoker's.
        if (this.knowledgeFiles.get(stringArg(args, 'knowledge_id'))?.foreign !== false) this.taint('workspace knowledge')
        return
      case 'read_comments':
        if (this.deps.commentsHaveForeignAuthors()) this.taint('comments by other people')
        return
      default:
    }
  }

  private async describeTarget(name: string, args: unknown): Promise<string | null> {
    switch (name) {
      case 'view_other_document': {
        const ref = stringArg(args, 'doc_id')
        return truncateTarget((await this.deps.describeDoc(ref)) ?? ref)
      }
      case 'duplicate_document': {
        const ref = stringArg(args, 'source_doc_id')
        return truncateTarget((await this.deps.describeDoc(ref)) ?? ref)
      }
      case 'create_document':
        return truncateTarget(stringArg(args, 'title')) || null
      case 'search_knowledge':
      case 'web_search':
        return truncateTarget(stringArg(args, 'query')) || null
      case 'get_knowledge_file': {
        const id = stringArg(args, 'knowledge_id')
        return truncateTarget(this.knowledgeFiles.get(id)?.filename ?? id) || null
      }
      case 'fetch_url':
        return truncateTarget(stringArg(args, 'url')) || null
      case 'view_image':
        return truncateTarget(stringArg(args, 'src')) || null
      default:
        return null
    }
  }
}
