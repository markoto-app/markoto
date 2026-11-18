# The AI agentic loop and its tools

How markoto's in-editor AI works and how to add a tool to it. The MCP server exposes the same tools to external clients; see [mcp.md](mcp.md). Which models run behind each surface is in [AI-MODELS.md](../AI-MODELS.md).

## Entry points

| Path | What starts a session |
|---|---|
| `server/api/ai/prompt.post.ts` | The prompt bar (`app/components/ai/AIPromptBar.vue`), with or without an editor selection |
| `server/api/docs/[docId]/comments/[commentId]/trigger-ai.post.ts` | A comment or reply that mentions `@ai` (fired by `app/components/comments/CommentsPanel.vue`) |

Both routes are a declaration plus one call: `startEditorPrompt` (`server/utils/agentic/sessions/editorPrompt.ts`) and `startCommentTrigger` (`server/utils/agentic/sessions/commentTrigger.ts`), on the shared setup in `sessions/sessionSetup.ts` and the background runner in `sessions/runSession.ts`. Together they:

1. require edit access to the document (the routes' `allow.doc('write-content')`);
2. resolve the user's AI providers (`server/utils/aiProviders/resolve.ts`: the user's own key, else the instance default, else none) and refuse when there is no chat provider;
3. claim an `ai_sessions` row (unique per user and document, so one running session per user per document);
4. build the session's cross-boundary guard (`buildSessionGuard` in `server/utils/agentic/sessionGuard.ts`);
5. connect the AI to the document (`createAiSession` in `server/utils/ai/aiClient.ts`) and run `runAgenticLoop` (`server/utils/agentic/runLoop.ts`).

`openAiSession` (`sessions/sessionSetup.ts`) aborts a session after 5 minutes; `server/plugins/ai-session-sweep.ts` removes sessions older than 7 minutes. `POST /api/ai/abort` stops a running session (initiator only).

## The AI is a Y.js client

`createAiSession` checks a Hocuspocus provider out of the shared pool (`server/utils/mcp/yDocPool.ts`, principal `loop:{sessionId}`) with a 10-minute JWT whose `userId` is `ai:assistant:{sessionId}`. Every edit is a Y.js transaction with that origin, so collaborators see edits arrive live and the sync server attributes the activity rows to the AI principal.

Awareness reaches every participant, including read-only viewers and anonymous visitors. It carries only `user` (`isAI: true`), `aiSession` (`sessionId`, `initiatorName`, `initiatorUserId`, `commentThreadId`) and `aiStatus.phase`. Everything else (the prompt, status text, `message_to_user` answers, confirmation requests) goes to the initiator only, through `server/utils/agentic/sessionChannel.ts` (Valkey keys plus a pub/sub ping). The client follows it with the Server-Sent Events stream `GET /api/ai/sessions/:sessionId/stream`, falls back to polling `GET /api/ai/sessions/:sessionId`, and answers confirmations with `POST /api/ai/sessions/:sessionId/confirm` (`app/composables/ai/useAI.ts`). All three answer 404 to anyone but the initiator.

## The loop

`runAgenticLoop` (`runLoop.ts`) is the turn loop; its parts are under `server/utils/agentic/loop/`: `loopContext.ts` (options, per-session state, outcomes), `providerStream.ts` (opening the model stream, budget refusals, consuming a turn), `toolDispatch.ts` (one tool call: offered? → valid arguments → memory → cap → taint gate → image provenance → run → bookkeeping), `sessionBudget.ts` (interaction and per-tool caps), `salvage.ts` (prose without a tool call), `webSubCalls.ts` + `toolActivity.ts` (web tools and `ai.tool` activity rows) and `sessionTelemetry.ts`. It keeps its history in an internal content/parts shape (`server/utils/agentic/aiTypes.ts`). At the provider boundary `server/utils/agentic/messageTranslation.ts` converts messages and tool declarations to the OpenAI chat format and turns the streamed response back. Calls go through the LiteLLM proxy with `temperature: 0`, because tool choice varies between runs at the default temperature.

- **Prompt layout** (`server/utils/agentic/promptAssembly.ts`): the static system prompt and the tools first (identical for every user and document), then the first user message: per-document context, knowledge files and members, conversation memory, the prompt. History is append-only. This keeps a byte-identical prefix for provider prompt caching.
- **Writing style** (`server/utils/agentic/writingStyle.ts`): rules against machine-sounding prose (no em-dashes, no stock AI vocabulary, formatting that follows content) in both system prompts; the document's language, audience and existing style take precedence.
- **Document context** (`server/utils/agentic/documentContextPrompt.ts`): title, description, language and the audience tone go into every prompt.
- **Untrusted text** (`server/utils/agentic/untrustedText.ts`): values other people wrote (titles, descriptions, member names, knowledge filenames, comment threads) enter a prompt only through `quoteInline` or `fenceBlock`. Both system prompts include `UNTRUSTED_DATA_RULE`.
- **Finishing**: a reply without a tool call ends the session. Everything the user should read goes through a tool (`message_to_user` in the prompt bar, `reply_to_comment` in a comment session). Prose without a tool call is turned into one of those only when it is the session's only answer.
- **Stopping early** (`loop/wrapUp.ts`): at `MAX_TURNS`, with less than 30 seconds left before the session deadline (`AI_SESSION_WRAP_UP_MARGIN_MS`), or after three turns whose tool call was cut off by the output token limit, the loop runs one closing turn: the same tool list (the cached prefix stays valid), `tool_choice` forcing `message_to_user` (`reply_to_comment` in a comment session) and a short appended instruction to say what is done and what is not. A provider that rejects a named `tool_choice` (400 / 422) gets `auto` instead. Only the closing tool runs in that turn. The session outcome still records `turn-limit`, `time-limit` or `output-limit`; the user sees the summary, or the turn-limit error when none arrived.
- **Transport failures** (`loop/providerStream.ts`, `streamTurn`): a stream that breaks after it opened is re-requested once with the same history. Tools only run after a stream completes, so the failed attempt has no side effects. Aborts, budget refusals and 4xx errors are not retried.
- **Output limit**: on `finish_reason: length` a tool call whose arguments were cut off (not a JSON object, `argsInvalid` from `messageTranslation.ts`) does not run; its result tells the model to break the work into smaller pieces. Complete calls of the same turn run normally.
- **Argument repair** (`loop/argCoercion.ts`): before Zod validation, numbers sent as strings, `null` for an optional field and objects / arrays sent as JSON strings are converted, by walking the tool's Zod schema. A value only ever becomes the type the schema asks for at that spot.
- **Stalled edits** (`server/utils/agentic/editProgress.ts`): edits that change nothing, only whitespace, or revert earlier text get a note in the tool result; `STALLED_TURN_LIMIT` (3) such turns in a row end the session as done.
- **Image URLs** (`server/utils/agentic/imageProvenance.ts`): an edit may only add a Markdown image whose URL the session has seen (document, prompt or a tool result). Otherwise the edit is refused and the model is told to call `generate_image`.
- **Telemetry**: one Sentry event (`ai-session-completed`) per session from the loop's `finally` block.

### Limits

| Limit | Where | Value |
|---|---|---|
| Turns per session | `MAX_TURNS` in `runLoop.ts` | 20, then one closing turn (`loop/wrapUp.ts`) |
| Interactions per session (turns plus sub-calls; `web_search` / `fetch_url` count 4) | `SESSION_INTERACTION_CAP` in `server/utils/agentic/limits.ts` | 50, then the session aborts with an error |
| Calls per tool per session | `sessionCallCap` on the tool definition (collected as `SESSION_TOOL_CALL_CAPS` in `server/utils/ai/tools/registry.ts`) | `view_pages` 3, `generate_image` 5, `web_search` 10, `fetch_url` 10, `search_knowledge` 20, `search_activity_log` 8, `load_skill` 4, `delegate_scan` 3, `delegate_rewrite` 6; over the cap the model gets a tool error |
| Size of one tool result | `TOOL_RESULT_CHAR_CAP` in `server/utils/agentic/limits.ts`, applied by `loop/resultCap.ts` | 24,000 characters; longer results are cut with a hint on how to read the rest. `view_document` / `view_other_document` (heading outline with line ranges plus the first lines for a long document, a continuation `view_range` for a long range), `read_comments` and `list_themes` stay below it themselves |
| Requests and spend | the user's LiteLLM virtual key | `rpm_limit` 60 and the key's `max_budget` |
| Web search and page fetch | `server/utils/ai/webTools.ts` | per-user hourly and daily allowance, shared with MCP |

### Usage records

Every model call of the loop (each turn, each retry, the closing turn) writes one structured log line at info level, component `ai-loop`, message `ai.call.usage` (`CALL_USAGE_EVENT`), with these fields (`CallUsageRecord` in `server/utils/agentic/loop/callUsage.ts`, which has no Nitro dependency):

| Field | Meaning |
|---|---|
| `sessionId`, `docId` | The session and its document |
| `turn`, `phase` | 1-based turn; `turn` or `closing` |
| `requestedModel`, `providerModel` | The model / LiteLLM alias the request named; the model the response reported (null when none) |
| `promptTokens`, `cachedTokens`, `outputTokens`, `reasoningTokens` | Token counts the provider reported (0 when it reported none) |
| `latencyMs`, `firstTokenMs` | Request start to stream end; to the first streamed chunk (null when none arrived) |
| `finishReason` | Internal finish reason (`STOP`, `MAX_TOKENS`, ...), `error` for a stream that failed |
| `retry` | The call re-requested a turn whose stream failed |

No prompt or document text is ever in a record. The records are also kept on `SessionTelemetry.calls`, and the `ai-session-completed` event carries their sums as `callTotals` (`calls`, `retries`, the four token counters, `latencyMs`; `sumCallUsage`).

## Taint and confirmation

The loop acts with the invoker's identity, so text written by someone else could try to steer it into the invoker's other documents, knowledge or the web. `server/utils/agentic/crossBoundary.ts` tracks this per session:

- A session starts tainted when the document is not solo for the invoker (others can edit it, or its content history includes other people; `server/repos/docProvenance.ts`), or when an `@ai` thread has other participants.
- It becomes tainted after a tool returns other people's content: `web_search`, `fetch_url`, external `view_image`, `list_workspace_documents` in a shared workspace, `view_other_document` of a non-solo document, `read_comments` with other authors, and the knowledge tools when a file comes from someone else.
- Once tainted, the tools with `trustBoundary: 'confirm'` (`list_my_documents`, `list_workspace_documents`, `view_other_document`, `search_knowledge`, `get_knowledge_file`, `create_document`, `duplicate_document`, `web_search`) wait for the invoker's Allow in the prompt bar (`app/components/ai/AIConfirmPanel.vue`). `fetch_url` and external `view_image` (`trustBoundary: { urlArg }`) run without asking only for a URL the invoker typed in the prompt. No answer within 90 seconds counts as Deny. With Deny the invoker may type a short note ("No, search for X instead", at most 300 characters, `CONFIRM_NOTE_MAX_LENGTH`); it reaches the model in the decline as the invoker's own instruction (`declineMessage` in `crossBoundary.ts`).
- `ai_session_provenance` (`server/utils/agentic/sessionProvenance.ts`) records whether a session stayed clean, so a later session can tell whether an `ai:assistant:` edit counts as the invoker's own text. This is intended: the owner's typing and live dictation (committed by their own editor connection) are theirs, so is text from their clean AI sessions; text an AI session wrote after reading web or other people's content is not, because it can carry injected instructions, so the document stays non-solo and later sessions ask first.

MCP calls are not gated; see [mcp.md](mcp.md).

## Tools

Every tool is one definition (`server/utils/ai/tools/toolDefinition.ts`): name, the description the model reads, the Zod schema (runtime validator and source of the JSON Schema), the handler, and its policy (`sessionCallCap`, `trustBoundary`, `requires` a provider capability, `activity` row). One module per family under `server/utils/ai/tools/`: `documentTools.ts` (view / replace / insert / set_title), `themeTools.ts` (+ `themeSchema.ts`, `themeMerge.ts`), `crossDocumentTools.ts`, `libraryTools.ts` (create / duplicate / export), `commentTools.ts`, `knowledgeTools.ts`, `webResearchTools.ts` (+ `webSearch.ts`, `fetchUrl.ts`), `imageTools.ts` (+ `imageFetch.ts`, `imageGeneration.ts`), `renderTools.ts`, `activityTools.ts`, `messageTools.ts`. `registry.ts` lists them in the order the model sees them (part of the cacheable prompt prefix) and is the only dispatch: the loop and the test-only exec route call `executeFunctionByName`, MCP's wrappers `executeFunctionByName` / `executeMetaTool`. Descriptions, schemas and order are pinned byte-for-byte by `tests/unit/ai/aiToolListGolden.test.ts`.

## Adding a tool

1. **Definition** in the family module: the Zod arguments, `defineDocTool` (reads or writes the document's Y.js state or awareness) or `defineMetaTool` (rows and external APIs only; MCP can run it without a document), the description and the handler. `toFunctionDeclaration` writes the JSON Schema into the field `parameters`, which `internalToOpenAITools` reads; `tests/unit/ai/aiToolSchemas.test.ts` checks it. The loop validates every call against the same schema and returns validation errors to the model. Return a `ToolResult`; binary data such as images goes in `extraParts`, which the loop appends after the function response.
2. **Registry**: add it to `CORE_TOOLS` (or `KNOWLEDGE_TOOLS` for tools that only make sense with ready workspace knowledge) in `registry.ts`, and regenerate the golden list (`UPDATE_GOLDEN=1`).
3. **Status label**: add a case to `describeToolInput` in `server/utils/agentic/streamStatus.ts` (shown to the initiator while the tool runs).
4. **Cross-boundary**: if the tool reaches beyond the current document, give it `trustBoundary`; if it returns other people's content, add its taint case in `crossBoundary.ts` (`applyTaint`).
5. **Cost**: if the tool costs money or renderer time, give it a `sessionCallCap`. If it depends on a provider or operator key, give it `requires` (`filterToolsForProviders` drops it otherwise).
6. **URLs**: a tool that takes a URL must call `assertSafeUrl` (`server/utils/agentic/urlGuard.ts`); if the app itself fetches the URL, use `server/utils/platform/safeFetch.ts`.
7. **MCP**: add a wrapper in `server/mcp/tools/` and a class in `server/mcp/lib/toolClasses.ts` if external clients should have it ([mcp.md](mcp.md)).
8. **Privacy**: a tool that sends personal data to a new provider needs registry updates ([privacy-registries.md](privacy-registries.md)).
9. **By hand**: everything the AI can do, a user can do manually. Give the editor a control that calls a route running the tool's own code, not a copy: Insert → "Generate image with AI" (`POST /api/docs/:docId/images/generate`) runs `generateDocumentImage`, the core of `generate_image`, with the same provider, plan, budget and quota checks.

Schema tips: some providers reject Zod tuples, so use `z.array(...).min(n).max(n)`; put `.trim()` before `.min(1)`; prefer a `.refine` with a clear message over a runtime check in the handler, so the model can correct itself.

## Skills

Task guidance that only some sessions need (long documents, translation, review, academic papers) is a skill in `server/utils/agentic/skills/`, not text in the static prompt. A skill is `{ id, title, when, body }`; `when` is one line. Both static prompts carry only the catalogue (`SKILL_CATALOGUE`: one line per skill, sorted by id, built at module load); the editor prompt also carries `TASK_PLAYBOOK` (`taskPlaybook.ts`), whose details live in the `long-document` skill. A body reaches the model in two ways:

- **Preselected**: `preselectSkills` (a keyword classifier over what the user typed, in English, German, French and Spanish, plus the document size from `parseSectionsCached`) picks at most two; `runSession.ts` puts their bodies as `<skill id="...">` blocks into the first user message, after the per-document context and before the conversation memory (`initialUserParts`). `long-document` is picked for a document over 12,000 tokens, or for "throughout / überall / partout / en todo el documento" on one over 2,000 tokens.
- **Loaded**: the model calls `load_skill({ id })` (cap 4 per session); the body comes back as a normal tool result.

To add a skill: write `skills/<id>.ts` (English, no em-dash, about 250 to 600 tokens, consistent with `WRITING_STYLE_RULES`), add it to `SKILLS` in `skills/index.ts` in id order, add trigger words to `TASK_TRIGGERS` if a request names the task clearly, and update the catalogue string in `tests/unit/ai/skills.test.ts` and the tool golden (`UPDATE_GOLDEN=1`, the `load_skill` enum changes). Never put a skill body, or anything else chosen per session, into a system prompt: the system message and the tools are the prefix every user shares in the prompt cache (`tests/unit/ai/promptCachePrefix.test.ts`).

## Comment sessions (`@ai`)

`startCommentTrigger` runs the same loop with the system prompt from `server/utils/agentic/commentTriggerPrompt.ts`: no `create_comment`, a closing `reply_to_comment` is required, and the thread arrives as quoted data at the start of the user message. The comment's anchor becomes an editor selection, so "rewrite this" targets the anchored text. The caller must have written the triggering message, and it must mention the AI. AI-authored messages (`isAiCommentAuthor`, `shared/ai/author.ts`) never trigger a session, and AI replies have `@ai` stripped so they cannot trigger one.

## Voice

- **Voice prompt**: `POST /api/ai/transcribe` (`server/api/ai/transcribe.post.ts`) takes base64 audio up to 5 MiB in one of the types in `ALLOWED_MIME` and returns text, which the prompt bar submits as a normal prompt.
- **Live dictation**: a WebSocket at `/api/ai/dictate` (`server/routes/api/ai/dictate.ts`, the socket's hooks; the protocol, auth, upstream stream and billing ticks are in `server/utils/agentic/dictation/`). The client gets a 60-second JWT from `POST /api/ai/dictate/token` and sends it as the first message (never in the query string). One session per user (Valkey lock, fails closed), 10 minutes per session, 30 seconds idle timeout. Partials render as ghost text at the caret (`app/utils/editor/dictationExtensions.ts`); finals are committed as Y.js transactions. Voxtral Realtime itself sends only append-only text and one final text after the audio ended, so the relay finalises as it goes (`dictation/transcriptSegmenter.ts`): a sentence is final when the next one starts or one second after it ended, and only the open tail stays interim. A session ends in order (`dictation/sessionEnd.ts`): after the client's `stop`, the idle timeout or the session cap the relay ends the upstream input, sends the trailing `final`, then `done`, then closes (4 s deadline); billing stops when the audio stops. The client keeps the ghost text until `done` and commits it itself if the session ends any other way (`useVoiceDictation`). When the platform's Mistral key is used, a billing tick on the `voxtral-realtime-tick` LiteLLM model charges each minute to the user's budget; an exhausted budget closes the socket with code 1011 `budget_exhausted`. `TEST_MODE=1` with `NUXT_VOXTRAL_REALTIME_MOCK=1` replaces the speech client with a fake that behaves like the service (text deltas while chunks arrive, the end text 600 ms after the input ended).
- **Web tools**: `web_search` (Staan) and `fetch_url` (Jina Reader) are HTTP calls the app makes with the operator's keys. Before each, `chargeWebToolCall` (`server/utils/ai/webToolCharge.ts`) sends one completion on the `web-search-tick` / `web-fetch-tick` LiteLLM model with the caller's virtual key (also under BYOK), so the call lands in the same budget as all other AI and is refused with the usual 402 codes when that is used up. Other tick failures are logged and the call goes ahead (still bounded by the per-user web-tool rate limit, checked first). Prices and reasoning: `docs/AI-MODELS.md`.
