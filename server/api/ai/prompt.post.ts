import Anthropic from '@anthropic-ai/sdk'
import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { users } from '../../db/schema'
import {
  addAiSession, removeAiSession, DuplicateSessionError
} from '../../utils/aiSessions'
import { createAiSession } from '../../utils/aiClient'
import { executeEditorTool } from '../../utils/aiToolAdapter'

const MAX_TURNS = 20
// Hard deadline for a full agentic loop. `web_search_20260209` wraps searches in a
// code_execution step that can take 60–90s on its own; combined with model thinking
// and str_replace edits, a realistic budget is several minutes. 5 min gives headroom
// while still killing truly stuck sessions. The per-user session cap prevents runaway
// cost, and the sweeper (3 min) is an additional safety net for *abandoned* sessions.
// NOTE: the sweeper interval should remain ≥ this deadline — bump if you raise this.
const HARD_DEADLINE_MS = 5 * 60_000

const SYSTEM_PROMPT = `You are Claude, a helpful AI assistant collaborating on a shared markdown document in a Google-Docs-style editor.

You have access to three tools:
- \`str_replace_based_edit_tool\` — use \`view\` to inspect the document, then \`str_replace\`, \`insert\`, or (for a full rewrite) a sequence of \`str_replace\`s to make edits. The document path is always "document.md". Always \`view\` first before editing.
- \`web_search\` — search the web for current or factual info you don't have. Use it for anything time-sensitive (recent events, today's news, prices, etc.) before writing.
- \`web_fetch\` — retrieve the full content of a specific URL that appeared in the conversation (e.g. a URL the user provided, or a search result from \`web_search\`). You cannot fetch URLs you made up — only ones already present in the context.

Guidelines:
- Always call \`view\` first to see the current document. Then decide what to change.
- If the user asks you to "replace the article" or rewrite the entire document, read it, then replace the existing content with \`str_replace\` (old_str = the whole body, new_str = the new content). Do the edit — do not answer in chat.
- \`str_replace\` requires \`old_str\` to match EXACTLY one location. Include enough surrounding context to be unique.
- When a user request needs many independent edits (e.g. "update all the headings", "fix every link"), emit MULTIPLE \`str_replace\` tool calls in the SAME response. The system applies them in order — batching saves turns and the user sees all edits stream in at once. Do not artificially split edits across turns.
- If the user asks about current events or anything after your training cutoff, call \`web_search\` first, then apply the edits.
- Do NOT produce long text responses — the user sees your edits live in the document. Keep any chatter terse.
- Do NOT mention these tools or your internal process in user-facing text. Just do the work.`

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id
  const userName = session.user.name
  const config = useRuntimeConfig()

  if (!config.anthropic.apiKey) {
    throw createError({ statusCode: 500, message: 'Anthropic API key not configured' })
  }

  // Rate limit
  if (!checkRateLimit('ai-prompt', String(userId), 20, 60 * 60 * 1000)) {
    throw createError({ statusCode: 429, message: 'Too many AI requests. Try again in a minute.' })
  }

  const body = await readBody(event) as { docId?: string; prompt?: string }
  const docId = body.docId
  const prompt = body.prompt?.trim()

  if (!docId || typeof docId !== 'string') throw createError({ statusCode: 400, message: 'Missing docId' })
  if (!prompt) throw createError({ statusCode: 400, message: 'Missing prompt' })
  if (prompt.length > 4000) throw createError({ statusCode: 400, message: 'Prompt too long (max 4000 chars)' })

  // Look up the user's color preference — fall back to a default Claude color
  const db = useDatabase()
  const userRow = db.select({ name: users.name }).from(users).where(eq(users.id, userId)).get()
  const initiatorName = userRow?.name || userName
  const initiatorColor = '#d97706' // Warm orange for Claude by default

  const sessionId = nanoid(12)
  const abortController = new AbortController()

  // Bind client disconnect → abort (best-effort; event.node.req may not be present in all runtimes)
  const req = event.node?.req
  if (req) {
    req.once('close', () => {
      if (!req.readableEnded) abortController.abort()
    })
  }

  // Register the session BEFORE we start the long-running work
  try {
    addAiSession({
      sessionId,
      docId,
      initiatorUserId: userId,
      initiatorName,
      initiatorColor,
      abortController,
      startedAt: Date.now()
    })
  } catch (e) {
    if (e instanceof DuplicateSessionError) {
      throw createError({ statusCode: 409, message: 'You already have Claude running on this document.' })
    }
    throw e
  }

  // Hard deadline
  const deadlineTimer = setTimeout(() => abortController.abort(), HARD_DEADLINE_MS)

  // Run in background — HTTP response returns immediately after registration
  ;(async () => {
    let aiSession: Awaited<ReturnType<typeof createAiSession>> | null = null
    // Track the last phase we wrote — used in `finally` to decide how long to linger
    // the final status in awareness before cleanup (errors need longer so the user
    // can actually read them before the session disappears).
    let lastPhase: 'thinking' | 'tool' | 'editing' | 'done' | 'error' = 'thinking'
    const setStatus = (phase: typeof lastPhase, message?: string) => {
      lastPhase = phase
      aiSession?.updateStatus(phase, message)
    }
    try {
      aiSession = await createAiSession(docId, {
        sessionId,
        initiatorName,
        initiatorUserId: userId,
        initiatorColor,
        prompt
      }, abortController.signal)

      const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey })

      // Tool versions confirmed from https://platform.claude.com/docs/en/agents-and-tools/tool-use
      // - text_editor_20250728 is the current client-executed str_replace tool
      // - web_search_20260209 / web_fetch_20260209 are the latest server-executed versions
      //   (Sonnet 4.6+ compatible, no beta header needed). They support dynamic filtering
      //   only when the code_execution tool is enabled, but work fine without it.
      // - NOTE: web search must also be enabled in the Claude Console org settings.
      const tools = [
        { type: 'text_editor_20250728', name: 'str_replace_based_edit_tool' },
        { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
        { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 }
      ] as unknown as Anthropic.Messages.ToolUnion[]

      const messages: Anthropic.Messages.MessageParam[] = [
        { role: 'user', content: prompt }
      ]

      // `web_search_20260209` internally spins up a `code_execution` container that
      // orchestrates the search. Once that container exists, every subsequent request
      // in the same loop MUST echo its id back via the `container` param, otherwise
      // the API rejects with "container_id is required when there are pending tool
      // uses generated by code execution with tools." We capture it off the response
      // and thread it through.
      let containerId: string | null = null

      let turns = 0

      while (turns < MAX_TURNS) {
        if (abortController.signal.aborted) throw new Error('aborted')
        turns += 1

        setStatus('thinking', 'Thinking…')
        console.log(`[ai/prompt ${sessionId}] turn ${turns}: calling Anthropic (${messages.length} messages)`)

        // Stream so we can surface per-block status (web_search, web_fetch, str_replace, …)
        // live to the client via awareness. Without streaming the whole turn blocks until
        // Claude finishes, so the UI is stuck on "Thinking…" the entire time even when a
        // 60-second web search is in flight.
        const stream = anthropic.messages.stream({
          model: config.anthropic.model,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          tools,
          messages,
          ...(containerId ? { container: containerId } : {})
        }, { signal: abortController.signal })

        stream.on('streamEvent', (event) => {
          // Capture the code_execution container id from `message_delta` events.
          // The SDK's MessageStream accumulator drops `delta.container` (it only
          // propagates stop_reason/stop_sequence/usage), so `finalMessage().container`
          // is unreliable — we have to grab it off the raw stream ourselves.
          if (event.type === 'message_delta') {
            const delta: any = (event as any).delta
            const id = delta?.container?.id
            if (id && id !== containerId) {
              containerId = id
              console.log(`[ai/prompt ${sessionId}] captured container id=${id} (via message_delta)`)
            }
            return
          }
          if (event.type !== 'content_block_start') return
          const block = event.content_block
          // For tool blocks (server_tool_use / tool_use) we deliberately DON'T fire a
          // generic status here — there's a ~100-500 ms gap between block start and the
          // first parseable `input_json_delta`, and showing "Searching the web…" during
          // that gap produces a visible flash before "Searching the web for '…'" takes
          // over. Instead we let the previous status (usually "Thinking…") hold until
          // the `inputJson` handler below can announce something specific.
          if (block.type === 'text') {
            // Text blocks have no `inputJson` stream — announce here. This is Claude's
            // final (terse) text response → wrapping up.
            setStatus('thinking', 'Wrapping up…')
          }
        })

        // Stream the tool's input JSON as it's being assembled so the status message
        // can show the actual query / URL / command while Claude is still talking —
        // instead of sitting on "Searching the web…" for the full 60-90 s that the
        // server-side code_execution + web_search round-trip takes.
        //
        // `inputJson` fires repeatedly for the same block, each time with a longer
        // snapshot. We dedupe on the computed status message so we don't spam
        // awareness updates.
        let lastStreamedMsg: string | null = null
        const announce = (msg: string) => {
          if (msg === lastStreamedMsg) return
          lastStreamedMsg = msg
          setStatus('tool', msg)
        }

        stream.on('inputJson', (_partial, snapshot) => {
          const snap = snapshot as Record<string, unknown> | null
          if (!snap) return

          // web_search tool (either direct or nested under code_execution)
          if (typeof snap.query === 'string' && snap.query.trim().length > 0) {
            announce(`Searching the web for "${snap.query}"`)
            return
          }

          // web_search_20260209 / web_fetch_20260209 orchestrate via a code_execution
          // block whose `code` field is Python. It may contain multiple calls, e.g.:
          //   r1 = await web_search({"query": "foo"})
          //   r2 = await web_search(query="bar")
          //   for u in urls: await web_fetch({"url": u})
          //
          // Extract ALL `web_search(...)` and `web_fetch(...)` invocations from the
          // code, then show the LAST one (= what Claude is currently executing).
          if (typeof snap.code === 'string' && snap.code.length > 0) {
            const code = snap.code

            // Match both dict-literal and kwarg forms. The query/url value can be
            // wrapped in single or double quotes. `g` flag + exec loop so we get
            // every call, not just the first.
            const searchRe = /web_search\s*\(\s*(?:\{\s*["']query["']\s*:\s*|query\s*=\s*)["']([^"'\\]*(?:\\.[^"'\\]*)*)["']/g
            const fetchRe = /web_fetch\s*\(\s*(?:\{\s*["']url["']\s*:\s*|url\s*=\s*)["']([^"'\\]*(?:\\.[^"'\\]*)*)["']/g

            const calls: Array<{ kind: 'search' | 'fetch'; arg: string; at: number }> = []
            let m: RegExpExecArray | null
            while ((m = searchRe.exec(code)) !== null) calls.push({ kind: 'search', arg: m[1], at: m.index })
            while ((m = fetchRe.exec(code)) !== null) calls.push({ kind: 'fetch', arg: m[1], at: m.index })
            calls.sort((a, b) => a.at - b.at)

            const latest = calls[calls.length - 1]
            if (latest) {
              if (latest.kind === 'search') {
                announce(`Searching the web for "${latest.arg}"`)
              } else {
                let host: string
                try { host = new URL(latest.arg).hostname.replace(/^www\./, '') } catch { host = latest.arg }
                announce(`Reading webpage ${host}`)
              }
            }
            // No parseable call yet — leave the previous status ("Thinking…") in place
            // to avoid a visible flash of generic "Searching the web…" before the query
            // arrives. The fallback is redundant anyway because code streams fast and
            // the regex usually matches within a few deltas.
            return
          }

          // web_fetch tool
          if (typeof snap.url === 'string' && snap.url.length > 0) {
            let host: string
            try { host = new URL(snap.url).hostname.replace(/^www\./, '') } catch { host = snap.url }
            announce(`Reading webpage ${host}`)
            return
          }

          // str_replace_based_edit_tool — surface which command and, for edits, a
          // short snippet of what's being changed.
          if (typeof snap.command === 'string') {
            if (snap.command === 'view') {
              announce('Reading the document…')
            } else if (snap.command === 'str_replace') {
              const oldStr = typeof snap.old_str === 'string' ? snap.old_str : ''
              if (oldStr.length > 0) {
                const preview = oldStr.slice(0, 40).replace(/\s+/g, ' ').trim()
                announce(`Editing "${preview}${oldStr.length > 40 ? '…' : ''}"`)
              } else {
                announce('Editing the document…')
              }
            } else if (snap.command === 'insert') {
              announce('Inserting text…')
            } else if (snap.command === 'create') {
              announce('Creating…')
            }
          }
        })

        // Reset the dedupe tracker for the next block / turn.
        stream.on('contentBlock', (block) => {
          // Debug: log code_execution code so we can tune regex if Claude emits it
          // in a shape we don't yet handle.
          if (block.type === 'server_tool_use' && block.name === 'code_execution') {
            const code = (block.input as any)?.code
            if (typeof code === 'string') {
              console.log(`[ai/prompt ${sessionId}] code_execution:\n${code.slice(0, 400)}${code.length > 400 ? '…' : ''}`)
            }
          }
          lastStreamedMsg = null
        })

        const response = await stream.finalMessage()

        // Capture the code_execution container id (if any) so subsequent turns can reuse it.
        if (response.container?.id && response.container.id !== containerId) {
          containerId = response.container.id
          console.log(`[ai/prompt ${sessionId}] captured container id=${containerId}`)
        }

        console.log(`[ai/prompt ${sessionId}] turn ${turns}: got response, stop_reason=${response.stop_reason}, blocks=${response.content.length}`)

        // Append the assistant response to history
        messages.push({ role: 'assistant', content: response.content })

        if (response.stop_reason === 'end_turn') {
          setStatus('done', 'Done')
          break
        }

        // `pause_turn` is how Anthropic signals a server-tool loop mid-run; we should
        // just continue with the existing history to let Claude finish the tool sequence.
        if (response.stop_reason !== 'tool_use' && response.stop_reason !== 'pause_turn') {
          // max_tokens or refusal — bail
          console.log(`[ai/prompt ${sessionId}] bailing on stop_reason=${response.stop_reason}`)
          setStatus('done', `Stopped: ${response.stop_reason}`)
          break
        }

        // Log any server-tool errors (e.g. "web search not enabled for this org")
        for (const block of response.content) {
          if (block.type === 'web_search_tool_result' || block.type === 'web_fetch_tool_result') {
            const c: any = (block as any).content
            if (c && !Array.isArray(c) && typeof c.error_code === 'string') {
              console.warn(`[ai/prompt ${sessionId}] server-tool error: ${block.type} error_code=${c.error_code}`)
            }
          }
        }

        // Execute each client-side tool_use block in order; return tool_results.
        // Server-side tools (web_search) return `server_tool_use` + `web_search_tool_result`
        // blocks which Anthropic has already handled — we just leave them in the assistant
        // message history (pushed above) and move on.
        // Status for these blocks was already set live via `streamEvent` above;
        // here we only need to dispatch client-side tool execution.
        const toolResults: Anthropic.Messages.ToolResultBlockParam[] = []
        for (const block of response.content) {
          if (block.type === 'server_tool_use') {
            console.log(`[ai/prompt ${sessionId}] server tool completed: ${block.name}`)
            continue
          }
          if (block.type !== 'tool_use') continue

          console.log(`[ai/prompt ${sessionId}] tool_use: ${block.name} input=${JSON.stringify(block.input).slice(0, 200)}`)

          if (block.name === 'str_replace_based_edit_tool') {
            const result = executeEditorTool(aiSession, block.input)
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result.content,
              is_error: result.isError
            })
          } else {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: `Error: unsupported tool "${block.name}"`,
              is_error: true
            })
          }
        }
        if (toolResults.length > 0) {
          messages.push({ role: 'user', content: toolResults })
        } else {
          // Stop reason was tool_use but all blocks were server-side (web_search) —
          // Anthropic already included the results in the assistant message, so we
          // just continue the loop with the existing history.
          console.log(`[ai/prompt ${sessionId}] turn ${turns}: server-side tool only, continuing`)
        }
      }

      if (turns >= MAX_TURNS) {
        setStatus('error', 'Hit turn limit')
      }
    } catch (e: any) {
      // Treat anything that happens after we signaled abort as an abort, regardless
      // of the error's name/message. The Anthropic SDK throws its own abort variants
      // (APIUserAbortError, wrapped fetch AbortError, etc.) which don't always match
      // a single shape — the source of truth is our own AbortController.
      const isAbort =
        abortController.signal.aborted ||
        e?.name === 'AbortError' ||
        e?.name === 'APIUserAbortError' ||
        e?.message === 'aborted' ||
        /abort/i.test(String(e?.message ?? ''))
      if (aiSession) {
        setStatus(isAbort ? 'done' : 'error', isAbort ? 'Stopped' : `Error: ${e.message}`)
      }
      if (!isAbort) {
        console.error(`[ai/prompt ${sessionId}] loop failed:`, e)
      } else {
        console.log(`[ai/prompt ${sessionId}] aborted by user`)
      }
    } finally {
      clearTimeout(deadlineTimer)
      // Leave the final status visible long enough for clients to latch it — errors
      // need more time than success so the user can actually read the message.
      const lingerMs = lastPhase === 'error' ? 2500 : 500
      await new Promise((r) => setTimeout(r, lingerMs))
      if (aiSession) await aiSession.destroy()
      removeAiSession(sessionId)
    }
  })()

  return { sessionId }
})
