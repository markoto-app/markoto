import { describe, it, expect } from 'vitest'
import { assemblePromptSystemPrompt, initialUserParts, PROMPT_SYSTEM_PROMPT } from '../../../server/utils/agentic/promptAssembly'
import { COMMENT_TRIGGER_SYSTEM_PROMPT } from '../../../server/utils/agentic/commentTriggerPrompt'
import { buildDocumentContext } from '../../../server/utils/agentic/documentContextPrompt'
import { buildKnowledgeBlock, buildWorkspaceMembersBlock } from '../../../server/utils/agentic/workspacePromptBlocks'
import { wrapPromptWithEditorState } from '../../../server/utils/agentic/editorStatePrompt'
import { ALL_TOOL_DECLARATIONS, KNOWLEDGE_TOOL_DECLARATIONS, filterToolsForProviders } from '../../../server/utils/ai/tools/registry'
import { internalToOpenAIMessages, internalToOpenAITools, openAIStreamToInternalChunks } from '../../../server/utils/agentic/messageTranslation'
import type { AgenticContent } from '../../../server/utils/agentic/aiTypes'
import type OpenAI from 'openai'

// Prompt caching only pays when the request PREFIX is byte-identical
// across calls (Mistral / GLM cache prefix blocks; the first differing
// byte ends the hit). These pin the layout from `promptAssembly.ts`:
//
//   static system prompt → tools → per-doc / per-workspace context
//   ─ end of system ─ → conversation memory + editor state + prompt
//   → loop turns (append-only, tool-call arguments replayed verbatim)
//
// Every assertion compares the serialised request body, i.e. the bytes
// LiteLLM forwards.

const PROVIDERS = { chat: { supportsVision: true }, image: null }

function docContext(title: string, language = 'en') {
  return buildDocumentContext({ title, description: `About ${title}`, audience: 'business', language })
}

function systemFor(title: string, members: Array<{ userId: number, name: string }> = []) {
  return assemblePromptSystemPrompt(PROMPT_SYSTEM_PROMPT, {
    documentContextBlock: docContext(title),
    knowledgeBlock: '',
    membersBlock: buildWorkspaceMembersBlock(members)
  })
}

function firstRequest(system: string, history: string, prompt: string) {
  const contents: AgenticContent[] = [{
    role: 'user',
    parts: initialUserParts(history, wrapPromptWithEditorState(prompt, { kind: 'none' }))
  }]
  return {
    tools: internalToOpenAITools(filterToolsForProviders(ALL_TOOL_DECLARATIONS, PROVIDERS)),
    messages: internalToOpenAIMessages(system, contents)
  }
}

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

describe('prompt-cache prefix stability', () => {
  it('the static system prompt contains no volatile values (dates, times)', () => {
    expect(PROMPT_SYSTEM_PROMPT).not.toMatch(/\b20\d\d-\d\d-\d\d\b/)
    expect(PROMPT_SYSTEM_PROMPT).not.toMatch(/\b\d\d:\d\d:\d\d\b/)
    expect(COMMENT_TRIGGER_SYSTEM_PROMPT).not.toMatch(/\b20\d\d-\d\d-\d\d\b/)
  })

  it('tool definitions serialise identically for every session (fixed order, deterministic JSON)', () => {
    const a = JSON.stringify(firstRequest(systemFor('A'), '', 'x').tools)
    const b = JSON.stringify(firstRequest(systemFor('B'), 'history', 'y').tools)
    expect(a).toBe(b)
    // The workspace-gated knowledge tools are APPENDED, so the shared tools stay a prefix.
    const withKnowledge = JSON.stringify(internalToOpenAITools(filterToolsForProviders([...ALL_TOOL_DECLARATIONS, ...KNOWLEDGE_TOOL_DECLARATIONS], PROVIDERS)))
    expect(withKnowledge.startsWith(a.slice(0, -1))).toBe(true)
  })

  it('two prompts on the same document share the whole system message — history, editor state and prompt are in the user message', () => {
    const system = systemFor('Q3 report', [{ userId: 1, name: 'Ada' }])
    const first = firstRequest(system, '', 'Summarise the key figures.')
    const second = firstRequest(system, '<conversation_history>\nuser: Summarise the key figures.\nassistant: Done.\n</conversation_history>', 'Now add a conclusion.')

    expect(first.messages[0]).toEqual(second.messages[0])
    const a = JSON.stringify({ tools: first.tools, messages: first.messages })
    const b = JSON.stringify({ tools: second.tools, messages: second.messages })
    const shared = commonPrefixLength(a, b)
    // Everything up to the first user message is identical.
    const systemJson = JSON.stringify({ tools: first.tools, messages: [first.messages[0]] })
    expect(shared).toBeGreaterThanOrEqual(systemJson.length - 2)
    // ...and the conversation memory is NOT in the system message.
    expect(String(second.messages[0]?.content)).not.toContain('assistant: Done.')
    expect(String(second.messages[1]?.content)).toContain('<conversation_history>\nuser: Summarise the key figures.')
  })

  it('two different documents (and users) still share the static prompt + tools', () => {
    const a = firstRequest(systemFor('Recipe book'), '', 'Add a dessert.')
    const b = firstRequest(systemFor('Annual report'), 'history', 'Fix the table.')
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools))
    const shared = commonPrefixLength(String(a.messages[0]?.content), String(b.messages[0]?.content))
    expect(shared).toBeGreaterThanOrEqual(PROMPT_SYSTEM_PROMPT.length)
    expect(String(a.messages[0]?.content).startsWith(PROMPT_SYSTEM_PROMPT)).toBe(true)
  })

  it('the comment-trigger system prompt is static-first too', () => {
    const sys = assemblePromptSystemPrompt(COMMENT_TRIGGER_SYSTEM_PROMPT, {
      documentContextBlock: docContext('Q3 report'),
      knowledgeBlock: buildKnowledgeBlock([{ knowledgeId: 'k1', filename: 'notes.md', sizeBytes: 2048, sourceExt: 'md', tokenCount: 300 }]),
      membersBlock: ''
    })
    expect(sys.startsWith(COMMENT_TRIGGER_SYSTEM_PROMPT)).toBe(true)
    expect(sys.indexOf('<document_context>')).toBeGreaterThan(COMMENT_TRIGGER_SYSTEM_PROMPT.length)
  })

  it('within a session the history only appends, and tool-call arguments replay byte-for-byte', async () => {
    const system = systemFor('Q3 report')
    const contents: AgenticContent[] = [{ role: 'user', parts: initialUserParts('', 'Fix the typo.') }]
    const turn1 = JSON.stringify(internalToOpenAIMessages(system, contents))

    // The model streams a tool call with its own spacing / key order.
    const raw = '{"old_str": "teh",  "new_str":"the"}'
    async function* stream(): AsyncGenerator<OpenAI.Chat.Completions.ChatCompletionChunk> {
      yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'replace_text', arguments: raw.slice(0, 10) } }] }, finish_reason: null }] }
      yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: raw.slice(10) } }] }, finish_reason: 'tool_calls' }] }
    }
    const modelParts: NonNullable<AgenticContent['parts']> = []
    for await (const chunk of openAIStreamToInternalChunks(stream())) modelParts.push(...(chunk.candidates?.[0]?.content?.parts ?? []))
    contents.push({ role: 'model', parts: modelParts })
    contents.push({ role: 'user', parts: [{ functionResponse: { id: 'call_1', name: 'replace_text', response: { output: 'ok' } } }] })

    const turn2Messages = internalToOpenAIMessages(system, contents)
    const turn2 = JSON.stringify(turn2Messages)
    // Turn 1's messages are an exact prefix of turn 2's (minus the closing bracket).
    expect(turn2.startsWith(turn1.slice(0, -1))).toBe(true)
    const assistant = turn2Messages[2] as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam
    const call = assistant.tool_calls?.[0]
    expect(call?.type === 'function' ? call.function.arguments : null).toBe(raw)
  })

  it('a malformed argument buffer is not replayed raw (it would make the next request invalid)', async () => {
    async function* stream(): AsyncGenerator<OpenAI.Chat.Completions.ChatCompletionChunk> {
      yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'replace_text', arguments: '{"old_str": "a' } }] }, finish_reason: 'tool_calls' }] }
    }
    const parts: NonNullable<AgenticContent['parts']> = []
    for await (const chunk of openAIStreamToInternalChunks(stream())) parts.push(...(chunk.candidates?.[0]?.content?.parts ?? []))
    const call = parts.find(p => p.functionCall)?.functionCall
    expect(call?.rawArgs).toBeUndefined()
    const messages = internalToOpenAIMessages('s', [{ role: 'model', parts }])
    const assistant = messages[1] as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam
    const tc = assistant.tool_calls?.[0]
    expect(tc?.type === 'function' ? tc.function.arguments : null).toBe('{}')
  })
})

describe('stream usage (cache measurement)', () => {
  it('reads usage from the final chunk even though it carries no choices, incl. cached + reasoning tokens', async () => {
    async function* stream(): AsyncGenerator<OpenAI.Chat.Completions.ChatCompletionChunk> {
      yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: 'stop' }] }
      yield {
        id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [],
        usage: { prompt_tokens: 3480, completion_tokens: 48, total_tokens: 3528, prompt_tokens_details: { cached_tokens: 2304 }, completion_tokens_details: { reasoning_tokens: 30 } }
      }
    }
    const chunks = []
    for await (const chunk of openAIStreamToInternalChunks(stream())) chunks.push(chunk)
    expect(chunks.at(-1)?.usageMetadata).toEqual({
      promptTokenCount: 3480,
      candidatesTokenCount: 48,
      thoughtsTokenCount: 30,
      cachedContentTokenCount: 2304
    })
  })
})
