# The AI agentic loop and its tools

How markoto's in-editor AI works and how to add a tool to it. The MCP server exposes the same tools to external clients; see [mcp.md](mcp.md). Which models run behind each surface is in [AI-MODELS.md](../AI-MODELS.md).

## Entry points

| Path | What starts a session |
|---|---|
| `server/api/ai/prompt.post.ts` | The prompt bar (`app/components/ai/AIPromptBar.vue`), with or without an editor selection |
| `server/api/docs/[docId]/comments/[commentId]/trigger-ai.post.ts` | A comment or reply that mentions `@ai` (fired by `app/components/comments/CommentsPanel.vue`) |

Both endpoints:

1. require edit access to the document (`requireDocEditAccess`);
2. resolve the user's AI providers (`server/utils/aiProviders/resolve.ts`: the user's own key, else the instance default, else none) and refuse when there is no chat provider;
3. claim an `ai_sessions` row (unique per user and document, so one running session per user per document);
4. build the session's cross-boundary guard (`buildSessionGuard` in `server/utils/agentic/sessionGuard.ts`);
5. connect the AI to the document (`createAiSession` in `server/utils/ai/aiClient.ts`) and run `runAgenticLoop` (`server/utils/agentic/runLoop.ts`).

`server/api/ai/prompt.post.ts` aborts a session after 5 minutes; `server/plugins/ai-session-sweep.ts` removes sessions older than 7 minutes. `POST /api/ai/abort` stops a running session (initiator only).

## The AI is a Y.js client

`createAiSession` checks a Hocuspocus provider out of the shared pool (`server/utils/mcp/yDocPool.ts`, principal `loop:{sessionId}`) with a 10-minute JWT whose `userId` is `ai:assistant:{sessionId}`. Every edit is a Y.js transaction with that origin, so collaborators see edits arrive live and the sync server attributes the activity rows to the AI principal.

Awareness reaches every participant, including read-only viewers and anonymous visitors. It carries only `user` (`isAI: true`), `aiSession` (`sessionId`, `initiatorName`, `initiatorUserId`, `commentThreadId`) and `aiStatus.phase`. Everything else (the prompt, status text, `message_to_user` answers, confirmation requests) goes to the initiator only, through `server/utils/agentic/sessionChannel.ts` (Valkey keys plus a pub/sub ping). The client follows it with the Server-Sent Events stream `GET /api/ai/sessions/:sessionId/stream`, falls back to polling `GET /api/ai/sessions/:sessionId`, and answers confirmations with `POST /api/ai/sessions/:sessionId/confirm` (`app/composables/ai/useAI.ts`). All three answer 404 to anyone but the initiator.

## The loop

`runAgenticLoop` keeps its history in an internal content/parts shape (`server/utils/agentic/aiTypes.ts`). At the provider boundary `server/utils/agentic/messageTranslation.ts` converts messages and tool declarations to the OpenAI chat format and turns the streamed response back. Calls go through the LiteLLM proxy with `temperature: 0`, because tool choice varies between runs at the default temperature.

- **Prompt layout** (`server/utils/agentic/promptAssembly.ts`): static system prompt and tools first, per-prompt context in the user message, history append-only. This keeps a byte-identical prefix for provider prompt caching.
- **Document context** (`server/utils/agentic/documentContextPrompt.ts`): title, description, language and the audience tone go into every prompt.
- **Untrusted text** (`server/utils/agentic/untrustedText.ts`): values other people wrote (titles, descriptions, member names, knowledge filenames, comment threads) enter a prompt only through `quoteInline` or `fenceBlock`. Both system prompts include `UNTRUSTED_DATA_RULE`.
- **Finishing**: a reply without a tool call ends the session. Everything the user should read goes through a tool (`message_to_user` in the prompt bar, `reply_to_comment` in a comment session). Prose without a tool call is turned into one of those only when it is the session's only answer.
- **Stalled edits** (`server/utils/agentic/editProgress.ts`): edits that change nothing, only whitespace, or revert earlier text get a note in the tool result; `STALLED_TURN_LIMIT` (3) such turns in a row end the session as done.
- **Image URLs** (`server/utils/agentic/imageProvenance.ts`): an edit may only add a Markdown image whose URL the session has seen (document, prompt or a tool result). Otherwise the edit is refused and the model is told to call `generate_image`.
- **Telemetry**: one Sentry event (`ai-session-completed`) per session from the loop's `finally` block.

### Limits

| Limit | Where | Value |
|---|---|---|
| Turns per session | `MAX_TURNS` in `runLoop.ts` | 20 |
| Interactions per session (turns plus sub-calls; `web_search` / `fetch_url` count 4) | `SESSION_INTERACTION_CAP` in `server/utils/agentic/limits.ts` | 50, then the session aborts with an error |
| Calls per tool per session | `SESSION_TOOL_CALL_CAPS` in `limits.ts` | `view_pages` 3, `generate_image` 5, `web_search` 10, `fetch_url` 10, `search_knowledge` 20, `search_activity_log` 8; over the cap the model gets a tool error |
| Requests and spend | the user's LiteLLM virtual key | `rpm_limit` 60 and the key's `max_budget` |
| Web search and page fetch | `server/utils/ai/webTools.ts` | per-user hourly and daily allowance, shared with MCP |

## Taint and confirmation

The loop acts with the invoker's identity, so text written by someone else could try to steer it into the invoker's other documents, knowledge or the web. `server/utils/agentic/crossBoundary.ts` tracks this per session:

- A session starts tainted when the document is not solo for the invoker (others can edit it, or its content history includes other people; `server/repos/docProvenance.ts`), or when an `@ai` thread has other participants.
- It becomes tainted after a tool returns other people's content: `web_search`, `fetch_url`, external `view_image`, `list_workspace_documents` in a shared workspace, `view_other_document` of a non-solo document, `read_comments` with other authors, and the knowledge tools when a file comes from someone else.
- Once tainted, the tools in `CONFIRM_WHEN_TAINTED` (`list_my_documents`, `list_workspace_documents`, `view_other_document`, `search_knowledge`, `get_knowledge_file`, `create_document`, `duplicate_document`, `web_search`) wait for the invoker's Allow in the prompt bar (`app/components/ai/AIConfirmPanel.vue`). `fetch_url` and external `view_image` run without asking only for a URL the invoker typed in the prompt. No answer within 90 seconds counts as Deny.
- `ai_session_provenance` (`server/utils/agentic/sessionProvenance.ts`) records whether a session stayed clean, so a later session can tell whether an `ai:assistant:` edit counts as the invoker's own text.

MCP calls are not gated; see [mcp.md](mcp.md).

## Adding a tool

1. **Schema and declaration** in `server/utils/agentic/functionTools.ts`: define the arguments with Zod, add the schema to `TOOL_SCHEMAS`, and add a `decl(name, description, schema)` entry to `ALL_TOOL_DECLARATIONS` (or `KNOWLEDGE_TOOL_DECLARATIONS` for tools that only make sense with ready workspace knowledge). `decl()` writes the JSON Schema into the field `parameters`, which `internalToOpenAITools` reads; `tests/unit/ai/aiToolSchemas.test.ts` checks it. The loop validates every call against the same schema and returns validation errors to the model.
2. **Handler** in `server/utils/agentic/toolHandlers.ts`: put it in `DOC_TOOL_HANDLERS` if it reads or writes the document's Y.js state or awareness, otherwise in `META_TOOL_HANDLERS`. The loop dispatches through `executeFunctionByName` (`server/utils/ai/aiToolAdapter.ts`). Return a `ToolResult`; binary data such as images goes in `extraParts`, which the loop appends after the function response.
3. **Status label**: add a case to `describeToolInput` in `server/utils/agentic/streamStatus.ts` (shown to the initiator while the tool runs).
4. **Cross-boundary**: if the tool reads other people's content or reaches beyond the current document, add it to `CONFIRM_WHEN_TAINTED` and/or to the taint cases in `crossBoundary.ts`.
5. **Cost**: if the tool costs money or renderer time, add a per-session cap to `SESSION_TOOL_CALL_CAPS`. If it depends on a provider or operator key, handle it in `filterToolsForProviders`.
6. **URLs**: a tool that takes a URL must call `assertSafeUrl` (`server/utils/agentic/urlGuard.ts`); if the app itself fetches the URL, use `server/utils/platform/safeFetch.ts`.
7. **MCP**: add a wrapper in `server/mcp/tools/` and a class in `server/mcp/lib/toolClasses.ts` if external clients should have it ([mcp.md](mcp.md)).
8. **Privacy**: a tool that sends personal data to a new provider needs registry updates ([privacy-registries.md](privacy-registries.md)).

Schema tips: some providers reject Zod tuples, so use `z.array(...).min(n).max(n)`; put `.trim()` before `.min(1)`; prefer a `.refine` with a clear message over a runtime check in the handler, so the model can correct itself.

## Comment sessions (`@ai`)

`trigger-ai.post.ts` runs the same loop with the system prompt from `server/utils/agentic/commentTriggerPrompt.ts`: no `create_comment`, a closing `reply_to_comment` is required, and the thread arrives as quoted data at the start of the user message. The comment's anchor becomes an editor selection, so "rewrite this" targets the anchored text. The caller must have written the triggering message, and it must mention the AI. AI-authored messages (`isAiCommentAuthor`, `shared/ai/author.ts`) never trigger a session, and AI replies have `@ai` stripped so they cannot trigger one.

## Voice

- **Voice prompt**: `POST /api/ai/transcribe` (`server/api/ai/transcribe.post.ts`) takes base64 audio up to 5 MiB in one of the types in `ALLOWED_MIME` and returns text, which the prompt bar submits as a normal prompt.
- **Live dictation**: a WebSocket at `/api/ai/dictate` (`server/routes/api/ai/dictate.ts`). The client gets a 60-second JWT from `POST /api/ai/dictate/token` and sends it as the first message (never in the query string). One session per user (Valkey lock, fails closed), 10 minutes per session, 30 seconds idle timeout. Partials render as ghost text at the caret (`app/utils/editor/dictationExtensions.ts`); finals are committed as Y.js transactions. When the platform's Mistral key is used, a billing tick on the `voxtral-realtime-tick` LiteLLM model charges each minute to the user's budget; an exhausted budget closes the socket with code 1011 `budget_exhausted`. `TEST_MODE=1` with `NUXT_VOXTRAL_REALTIME_MOCK=1` replaces the speech client with a fake.
