import { describe, it, expect } from 'vitest'
import { assemblePromptContext, initialUserParts, PROMPT_SYSTEM_PROMPT } from '../../../server/utils/agentic/promptAssembly'
import { COMMENT_TRIGGER_SYSTEM_PROMPT } from '../../../server/utils/agentic/commentTriggerPrompt'
import { buildDocumentContext } from '../../../server/utils/agentic/documentContextPrompt'
import { buildKnowledgeBlock, buildWorkspaceMembersBlock } from '../../../server/utils/agentic/workspacePromptBlocks'
import { wrapPromptWithEditorState } from '../../../server/utils/agentic/editorStatePrompt'
import { ALL_TOOL_DECLARATIONS, KNOWLEDGE_TOOL_DECLARATIONS, filterToolsForProviders } from '../../../server/utils/ai/tools/registry'
import { internalToOpenAIMessages, internalToOpenAITools, openAIStreamToInternalChunks } from '../../../server/utils/agentic/messageTranslation'
import type { AgenticContent } from '../../../server/utils/agentic/aiTypes'
import type { AudienceKind } from '../../../shared/audiences'
import type OpenAI from 'openai'

// Prompt caching only pays when the request PREFIX is byte-identical
// across calls (Mistral / GLM cache prefix blocks; the first differing
// byte ends the hit). These pin the layout from `promptAssembly.ts`:
//
//   static system prompt → tools  (identical for every user and document)
//   → first user message: document context → knowledge + members
//     → conversation memory → editor state + prompt
//   → loop turns (append-only, tool-call arguments replayed verbatim)
//
// Every assertion compares the serialised request body, i.e. the bytes
// LiteLLM forwards.

const PROVIDERS = { chat: { supportsVision: true }, image: null }

interface DocShape {
  title: string
  audience?: AudienceKind
  language?: string
  members?: Array<{ userId: number, name: string }>
  knowledge?: string[]
}

function contextFor(doc: DocShape): string {
  return assemblePromptContext({
    documentContextBlock: buildDocumentContext({ title: doc.title, description: `About ${doc.title}`, audience: doc.audience ?? 'business', language: doc.language ?? 'en' }),
    knowledgeBlock: buildKnowledgeBlock((doc.knowledge ?? []).map((filename, i) => ({ knowledgeId: `k${i}`, filename, sizeBytes: 2048, sourceExt: 'md', tokenCount: 300 }))),
    membersBlock: buildWorkspaceMembersBlock(doc.members ?? [])
  })
}

function firstRequest(doc: DocShape, history: string, prompt: string, system = PROMPT_SYSTEM_PROMPT) {
  const contents: AgenticContent[] = [{
    role: 'user',
    parts: initialUserParts({ context: contextFor(doc), preamble: history }, wrapPromptWithEditorState(prompt, { kind: 'none' }))
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

const HISTORY = '<conversation_history>\nuser: Summarise the key figures.\nassistant: Done.\n</conversation_history>'

describe('prompt-cache prefix stability', () => {
  it('the static system prompt contains no volatile values (dates, times)', () => {
    expect(PROMPT_SYSTEM_PROMPT).not.toMatch(/\b20\d\d-\d\d-\d\d\b/)
    expect(PROMPT_SYSTEM_PROMPT).not.toMatch(/\b\d\d:\d\d:\d\d\b/)
    expect(COMMENT_TRIGGER_SYSTEM_PROMPT).not.toMatch(/\b20\d\d-\d\d-\d\d\b/)
  })

  it('tool definitions serialise identically for every session (fixed order, deterministic JSON)', () => {
    const a = JSON.stringify(firstRequest({ title: 'A' }, '', 'x').tools)
    const b = JSON.stringify(firstRequest({ title: 'B' }, 'history', 'y').tools)
    expect(a).toBe(b)
    // The workspace-gated knowledge tools are APPENDED, so the shared tools stay a prefix.
    const withKnowledge = JSON.stringify(internalToOpenAITools(filterToolsForProviders([...ALL_TOOL_DECLARATIONS, ...KNOWLEDGE_TOOL_DECLARATIONS], PROVIDERS)))
    expect(withKnowledge.startsWith(a.slice(0, -1))).toBe(true)
  })

  it('system message + tools are byte-identical across documents, workspaces, audiences, knowledge and members', () => {
    const a = firstRequest({ title: 'Recipe book', audience: 'casual', language: 'en' }, '', 'Add a dessert.')
    const b = firstRequest({
      title: 'Annual report',
      audience: 'academic',
      language: 'de',
      members: [{ userId: 1, name: 'Ada' }, { userId: 2, name: 'Grace' }],
      knowledge: ['q3-figures.md']
    }, HISTORY, 'Fix the table.')
    expect(a.messages[0]).toEqual({ role: 'system', content: PROMPT_SYSTEM_PROMPT })
    expect(b.messages[0]).toEqual(a.messages[0])
    const prefixA = JSON.stringify({ tools: a.tools, messages: [a.messages[0]] })
    const prefixB = JSON.stringify({ tools: b.tools, messages: [b.messages[0]] })
    expect(prefixB).toBe(prefixA)
    // Nothing per document in the system message (the static prompt names
    // the blocks, it never carries their content).
    for (const marker of ['Annual report', 'Ada', 'q3-figures.md', 'Audience guidance:', 'knowledge_id=']) {
      expect(String(b.messages[0]?.content)).not.toContain(marker)
    }
  })

  it('the first user message opens with the per-document blocks, then memory, then the prompt', () => {
    const { messages } = firstRequest({ title: 'Q3 report', members: [{ userId: 1, name: 'Ada' }], knowledge: ['notes.md'] }, HISTORY, 'Now add a conclusion.')
    const user = String(messages[1]?.content)
    expect(user.startsWith('<document_context>')).toBe(true)
    const order = ['<document_context>', '<knowledge_files>', '<workspace_members>', '<conversation_history>', 'Now add a conclusion.'].map(m => user.indexOf(m))
    expect(order.every(i => i >= 0)).toBe(true)
    expect([...order].sort((x, y) => x - y)).toEqual(order)
  })

  it('two prompts on the same document share system, tools and the per-document blocks', () => {
    const doc = { title: 'Q3 report', members: [{ userId: 1, name: 'Ada' }] }
    const first = firstRequest(doc, '', 'Summarise the key figures.')
    const second = firstRequest(doc, HISTORY, 'Now add a conclusion.')
    expect(first.messages[0]).toEqual(second.messages[0])
    const a = JSON.stringify({ tools: first.tools, messages: first.messages })
    const b = JSON.stringify({ tools: second.tools, messages: second.messages })
    const shared = commonPrefixLength(a, b)
    // Everything up to and including the per-document blocks is identical.
    const docPrefix = JSON.stringify({ tools: first.tools, messages: [first.messages[0]] }).length + contextFor(doc).length
    expect(shared).toBeGreaterThanOrEqual(docPrefix)
    // ...and the conversation memory is NOT in the system message.
    expect(String(second.messages[0]?.content)).not.toContain('assistant: Done.')
    expect(String(second.messages[1]?.content)).toContain('<conversation_history>\nuser: Summarise the key figures.')
  })

  it('the comment-trigger system message is the static prompt alone, its context in the user message', () => {
    const { messages } = firstRequest({ title: 'Q3 report', knowledge: ['notes.md'] }, '', '<comment_trigger>...</comment_trigger>\nFix this.', COMMENT_TRIGGER_SYSTEM_PROMPT)
    expect(messages[0]).toEqual({ role: 'system', content: COMMENT_TRIGGER_SYSTEM_PROMPT })
    const user = String(messages[1]?.content)
    expect(user.indexOf('<document_context>')).toBe(0)
    expect(user.indexOf('<knowledge_files>')).toBeLessThan(user.indexOf('<comment_trigger>'))
  })

  it('an empty context or preamble adds no part', () => {
    expect(initialUserParts({ context: '', preamble: '  ' }, 'p')).toEqual([{ text: 'p' }])
    expect(initialUserParts({ context: 'c', preamble: 'm' }, 'p')).toEqual([{ text: 'c\n\n' }, { text: 'm\n\n' }, { text: 'p' }])
  })

  it('within a session the history only appends, and tool-call arguments replay byte-for-byte', async () => {
    const system = PROMPT_SYSTEM_PROMPT
    const contents: AgenticContent[] = [{ role: 'user', parts: initialUserParts({ context: contextFor({ title: 'Q3 report' }) }, 'Fix the typo.') }]
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
