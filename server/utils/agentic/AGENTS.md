# AI agentic loop: agent rules

How the loop works and how to add a tool: `docs/contributing/ai-tools.md`. MCP delivery: `server/mcp/AGENTS.md`. Model choices: `docs/AI-MODELS.md`.

## Tool declarations

- The field `toFunctionDeclaration` (`server/utils/ai/tools/toolDefinition.ts`) writes is `parameters`, never `parametersJsonSchema`. `internalToOpenAITools` (`messageTranslation.ts`) reads `d.parameters` and silently falls back to an empty schema, and TypeScript does not catch the wrong name. Pinned by `tests/unit/ai/aiToolSchemas.test.ts`; assert on the literal field.
- Zod is the single source: a tool is one `defineDocTool` / `defineMetaTool` definition in its family module under `server/utils/ai/tools/`, listed in `registry.ts` (`CORE_TOOLS` or `KNOWLEDGE_TOOLS`, in the order the model sees them). Do not hand-write JSON Schema. Tool descriptions, schemas and their order are behaviour: `tests/unit/ai/aiToolListGolden.test.ts` pins them byte-for-byte.
- Never use `z.tuple(...)`; some providers reject the emitted schema. Use `z.array(...).min(n).max(n)`.
- Put `.trim()` before `.min(1)`. Enforce bounds with `.refine` and a clear message so the model can correct itself.
- Handlers that touch Y.js state or awareness are `defineDocTool`, the rest `defineMetaTool`. MCP's workspace- and user-bound wrappers only accept `meta` tools (`MetaToolName`).
- Binary tool output (images) goes in `ToolResult.extraParts`, appended after the `functionResponse`, never inside it.
- Add a `describeToolInput` case (`streamStatus.ts`) for every new tool.

## Cross-boundary gate

- A new tool that reaches beyond the current document needs `trustBoundary` on its definition; one that returns other people's content needs its taint case in `crossBoundary.ts` (`applyTaint`). Otherwise it bypasses the confirmation gate.
- `runAgenticLoop` requires `crossBoundary`; build it with `buildSessionGuard`. Unit tests use `tests/unit/fixtures/crossBoundary.ts`.
- A confirmation that cannot be stored or read counts as denied (fail closed). Keep it that way.
- Every URL-taking tool calls `assertSafeUrl` (`urlGuard.ts`); if the app fetches the URL itself, go through `server/utils/platform/safeFetch.ts`.

## Untrusted text and privacy of the session

- Text other people wrote (titles, descriptions, member names, knowledge filenames, comment threads) enters a prompt only through `quoteInline` / `fenceBlock` (`untrustedText.ts`). Put it in the user message, never the system prompt.
- Never put session details into awareness. Awareness reaches every viewer, including anonymous ones. Only `user.isAI`, `aiSession {sessionId, initiatorName, initiatorUserId, commentThreadId}` and the phase belong there; prompt, status text, answers and confirmations go through `AiSessionChannel` (`sessionChannel.ts`).
- Comment-trigger context goes at the start of the user message as quoted data.

## Loop behaviour

- The loop is `runLoop.ts` (turns) plus `loop/` (provider stream, tool dispatch, caps, salvage, telemetry). Keep the order of side effects in `loop/toolDispatch.ts`: status before the call, caps and the taint gate before the tool runs.
- Keep `temperature: 0` on the loop call (`loop/providerStream.ts`); higher values make tool choice drift.
- Do not tell the model "every turn must call a tool". A reply without a tool call is how a session ends; that wording made it edit until `MAX_TURNS`.
- Everything the user should read goes through a tool (`message_to_user`, `reply_to_comment`). There is no chat surface for prose.
- Keep the prompt prefix byte-stable for caching (`promptAssembly.ts`): the system message is the static prompt alone, so it and the tools are identical for every user and document; per-document blocks, then per-prompt context open the first user message; history append-only, tool-call arguments replayed verbatim.
- Task guidance that only some sessions need is a skill (`skills/`): the static prompts carry only the sorted catalogue; bodies arrive preselected in the first user message or through `load_skill`. Never add per-session text to a system prompt (`docs/contributing/ai-tools.md`, "Skills").
- Runaway caps: `SESSION_INTERACTION_CAP` (`limits.ts`) aborts the session, a tool's `sessionCallCap` returns a tool error. Give a new cost-bearing tool a per-session cap.
- The session sweeper threshold (`server/plugins/ai-session-sweep.ts`, 7 min) must stay above the session deadline (5 min, `AI_SESSION_HARD_DEADLINE_MS`, armed in `sessions/sessionSetup.ts`).
- Stopping early goes through the closing turn (`loop/wrapUp.ts`): same tool list, `tool_choice` forcing the closing tool, and only that tool runs. Never drop tools from the request to force an answer (it breaks the cached prefix). The loop gets the deadline as `deadlineAt` from `openAiSession`.
- Retry a turn only while no tool of it has run (`streamTurn` retries a stream that broke mid-way, once). Never retry aborts, budget refusals or 4xx.
- Every model call goes through `streamTurn`, which writes its `ai.call.usage` record (`loop/callUsage.ts`); keep prompt and document text out of it.
- Comment bodies are plain text: AI-written comments go through `plainCommentText`, and outgoing `@ai` is stripped so the AI cannot trigger itself. Server and client use the same `@ai` regex (`commentTriggerPrompt.ts`).
- Encode Y.js anchors with `Buffer`, not `btoa` (server context).

## Providers and LiteLLM

- Build request fields with `providerRequestFields(provider)` (`server/utils/aiProviders/requestFields.ts`). Never send `api_key` with a non-`byok/` model: LiteLLM would replace the operator's provider key with it.
- Wrap calls on a user's own key in `withProviderErrors`, and the chat stream in `redactProviderStream`, so key material never reaches logs, Sentry or the user.
- Do not add a per-wrapper rate limit for `web_search` / `fetch_url`; the allowance in `server/utils/ai/webTools.ts` is the single control and is shared with MCP.
- Sampling fields of every chat call come from `modelRequestParams(fields.model, { temperature, purpose })` (`server/utils/litellm/modelParams.ts`), never a bare `temperature`: Mistral Large 4 needs `top_p: 1` and `reasoning_effort: low`. Reasoning switches of the hosted deployments stay in the LiteLLM config, so a fallback never receives a value it refuses.
- The loop opens its stream with `litellmStream(..., { callerRetries: true })`: 429s are retried only by `loop/rateLimitRetry.ts` (Retry-After or 2 s / 5 s / 10 s, max 3, within the deadline), 5xx / connection errors by `streamTurn`'s one transport retry. Do not add another retry layer.
- Call LiteLLM through the wrappers in `server/utils/litellm/createCompletion.ts` (`litellmCompletion`, `litellmStream`, `litellmImage`, `litellmTranscription`), not `litellm.chat.completions.create` with a double cast; the wrappers type the `metadata.tags` extension and retry upstream 429s.

## Dictation

- `server/routes/api/ai/dictate.ts` holds only the socket's hooks; `dictation/` has the per-connection state (`peerContext.ts`), the frames (`messageProtocol.ts`), auth (`dictationAuth.ts`), the Voxtral stream (`upstreamSession.ts`) and the billing ticks (`voiceTicks.ts`).
- Voxtral Realtime finalises nothing before the audio ends (one `transcription.done` per stream). `transcriptSegmenter.ts` decides what is `final` on the way; every path that ends a session goes through `sessionEnd.ts` (trailing `final`, `done`, close), never a bare `peer.close`.
- The dictation JWT goes in the first WebSocket message, never in the query string (access logs).
- The per-user dictation lock (`tryAcquireSessionLock`) fails closed; rate limits fail open. Do not flip either.
- `useWebSocket` needs both `immediate: false` and `autoConnect: false` for manual control, or one click opens two sockets.
- Stop every `MediaStream` track explicitly; stopping `MediaRecorder` alone keeps the microphone indicator on.
- Keep `ALLOWED_MIME` in `server/api/ai/transcribe.post.ts` in step with `pickMimeType` in `app/composables/ai/useVoicePrompt.ts` (webm / ogg / wav only; `audio/mp4` is not accepted upstream, so Safari has no voice input).
