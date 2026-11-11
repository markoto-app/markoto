# AI agentic loop — agent rules

How the loop works and how to add a tool: `docs/contributing/ai-tools.md`. MCP delivery: `server/mcp/AGENTS.md`. Model choices: `docs/AI-MODELS.md`.

## Tool declarations

- The field `decl()` writes is `parameters`, never `parametersJsonSchema`. `internalToOpenAITools` (`messageTranslation.ts`) reads `d.parameters` and silently falls back to an empty schema, and TypeScript does not catch the wrong name. Pinned by `tests/unit/ai/aiToolSchemas.test.ts`; assert on the literal field.
- Zod is the single source: add the schema to `TOOL_SCHEMAS` and the declaration to `ALL_TOOL_DECLARATIONS` (or `KNOWLEDGE_TOOL_DECLARATIONS`) in `functionTools.ts`. Do not hand-write JSON Schema.
- Never use `z.tuple(...)`; some providers reject the emitted schema. Use `z.array(...).min(n).max(n)`.
- Put `.trim()` before `.min(1)`. Enforce bounds with `.refine` and a clear message so the model can correct itself.
- Handlers that touch Y.js state or awareness go in `DOC_TOOL_HANDLERS`, the rest in `META_TOOL_HANDLERS` (`toolHandlers.ts`). MCP wrappers depend on that split.
- Binary tool output (images) goes in `ToolResult.extraParts`, appended after the `functionResponse`, never inside it.
- Add a `describeToolInput` case (`streamStatus.ts`) for every new tool.

## Cross-boundary gate

- A new tool that reads other people's content or reaches beyond the current document must be added to `crossBoundary.ts` (`CONFIRM_WHEN_TAINTED` and/or the taint cases in `afterTool`). Otherwise it bypasses the confirmation gate.
- `runAgenticLoop` requires `crossBoundary`; build it with `buildSessionGuard`. Unit tests use `tests/unit/fixtures/crossBoundary.ts`.
- A confirmation that cannot be stored or read counts as denied (fail closed). Keep it that way.
- Every URL-taking tool calls `assertSafeUrl` (`urlGuard.ts`); if the app fetches the URL itself, go through `server/utils/platform/safeFetch.ts`.

## Untrusted text and privacy of the session

- Text other people wrote (titles, descriptions, member names, knowledge filenames, comment threads) enters a prompt only through `quoteInline` / `fenceBlock` (`untrustedText.ts`). Put it in the user message, never the system prompt.
- Never put session details into awareness. Awareness reaches every viewer, including anonymous ones. Only `user.isAI`, `aiSession {sessionId, initiatorName, initiatorUserId, commentThreadId}` and the phase belong there; prompt, status text, answers and confirmations go through `AiSessionChannel` (`sessionChannel.ts`).
- Comment-trigger context goes at the start of the user message as quoted data.

## Loop behaviour

- Keep `temperature: 0` on the loop call in `runLoop.ts`; higher values make tool choice drift.
- Do not tell the model "every turn must call a tool". A reply without a tool call is how a session ends; that wording made it edit until `MAX_TURNS`.
- Everything the user should read goes through a tool (`message_to_user`, `reply_to_comment`). There is no chat surface for prose.
- Keep the prompt prefix byte-stable for caching (`promptAssembly.ts`): static system prompt and tools first, per-prompt context in the first user message, history append-only, tool-call arguments replayed verbatim.
- Runaway caps live in `limits.ts`: `SESSION_INTERACTION_CAP` aborts the session, `SESSION_TOOL_CALL_CAPS` returns a tool error. Give a new cost-bearing tool a per-session cap.
- The session sweeper threshold (`server/plugins/ai-session-sweep.ts`, 7 min) must stay above the prompt deadline (5 min, `server/api/ai/prompt.post.ts`).
- Comment bodies are plain text: AI-written comments go through `plainCommentText`, and outgoing `@ai` is stripped so the AI cannot trigger itself. Server and client use the same `@ai` regex (`commentTriggerPrompt.ts`).
- Encode Y.js anchors with `Buffer`, not `btoa` (server context).

## Providers and LiteLLM

- Build request fields with `providerRequestFields(provider)` (`server/utils/aiProviders/requestFields.ts`). Never send `api_key` with a non-`byok/` model: LiteLLM would replace the operator's provider key with it.
- Wrap calls on a user's own key in `withProviderErrors`, and the chat stream in `redactProviderStream`, so key material never reaches logs, Sentry or the user.
- Do not add a per-wrapper rate limit for `web_search` / `fetch_url`; the allowance in `server/utils/ai/webTools.ts` is the single control and is shared with MCP.
- Call LiteLLM through the wrappers in `server/utils/litellm/createCompletion.ts` (`litellmCompletion`, `litellmStream`, `litellmImage`, `litellmTranscription`), not `litellm.chat.completions.create` with a double cast; the wrappers type the `metadata.tags` extension and retry upstream 429s.

## Dictation

- The dictation JWT goes in the first WebSocket message, never in the query string (access logs).
- The per-user dictation lock (`tryAcquireSessionLock`) fails closed; rate limits fail open. Do not flip either.
- `useWebSocket` needs both `immediate: false` and `autoConnect: false` for manual control, or one click opens two sockets.
- Stop every `MediaStream` track explicitly; stopping `MediaRecorder` alone keeps the microphone indicator on.
- Keep `ALLOWED_MIME` in `server/api/ai/transcribe.post.ts` in step with `pickMimeType` in `app/composables/ai/useVoicePrompt.ts` (webm / ogg / wav only; `audio/mp4` is not accepted upstream, so Safari has no voice input).
