import { describe, it, expect } from 'vitest'
import {
  AgenticFinishReason as FinishReason,
  type AgenticContent as Content,
  type AgenticFunctionDeclaration as FunctionDeclaration
} from '../../../server/utils/agentic/aiTypes'
import {
  internalToOpenAIMessages,
  internalToOpenAITools,
  openAIStreamToInternalChunks
} from '../../../server/utils/agentic/messageTranslation'

// Phase 4 boundary translator tests. The runLoop's internal
// representation stays in the historical Content[] shape
// (pre-migration: Gemini-derived); these helpers convert at the LLM
// call site so the existing chunk handler keeps working unchanged.
// Pin the wire format so a future Mistral/OpenAI shape drift trips
// a test instead of silently producing wrong behaviour.

// ─── Outbound: Content[] → OpenAI messages[] ────────────────────────────

describe('internalToOpenAIMessages', () => {
  it('translates a single user prompt with system into [system, user]', () => {
    const out = internalToOpenAIMessages(
      'You are a helper.',
      [{ role: 'user', parts: [{ text: 'Hello' }] }]
    )
    expect(out).toEqual([
      { role: 'system', content: 'You are a helper.' },
      { role: 'user', content: 'Hello' }
    ])
  })

  it('translates a model turn with text + tool_calls into an assistant message', () => {
    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'Find me an answer' }] },
      {
        role: 'model',
        parts: [
          { text: 'Working on it.' },
          { functionCall: { id: 'call_1', name: 'web_search', args: { query: 'cats' } } }
        ]
      }
    ]
    const out = internalToOpenAIMessages('sys', contents)
    expect(out).toHaveLength(3)
    expect(out[2]).toEqual({
      role: 'assistant',
      content: 'Working on it.',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'web_search', arguments: '{"query":"cats"}' }
      }]
    })
  })

  it('uses null content (not empty string) when assistant emits only tool_calls', () => {
    const contents: Content[] = [
      {
        role: 'model',
        parts: [{ functionCall: { id: 'call_1', name: 'view_document', args: {} } }]
      }
    ]
    const out = internalToOpenAIMessages('sys', contents)
    const assistant = out[1] as { content: string | null }
    expect(assistant.content).toBe(null)
  })

  it('emits a tool message per functionResponse with matching tool_call_id', () => {
    const contents: Content[] = [
      {
        role: 'model',
        parts: [{ functionCall: { id: 'call_1', name: 'view_document', args: { view_range: [1, 5] } } }]
      },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            id: 'call_1',
            name: 'view_document',
            response: { output: 'Line 1\nLine 2', isError: false }
          }
        }]
      }
    ]
    const out = internalToOpenAIMessages('sys', contents)
    // [system, assistant{tool_calls}, tool]
    expect(out).toHaveLength(3)
    expect(out[2]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'Line 1\nLine 2'
    })
  })

  it('lifts inlineData (view_image extraParts) into a follow-up image_url user message', () => {
    // The internal smuggle pattern (pre-migration: Gemini-derived):
    // a user block containing one functionResponse + sibling
    // inlineData parts. Translator splits:
    // tool message for the response, then a fresh user message with
    // image_url so Mistral sees the image attached to the right turn.
    const contents: Content[] = [
      {
        role: 'model',
        parts: [{ functionCall: { id: 'call_x', name: 'view_image', args: { src: '/api/files/x' } } }]
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { id: 'call_x', name: 'view_image', response: { output: 'OK', isError: false } } },
          { inlineData: { mimeType: 'image/png', data: 'AAAA' } }
        ]
      }
    ]
    const out = internalToOpenAIMessages('sys', contents)
    // [system, assistant{tool_calls}, tool, user{image_url}]
    expect(out).toHaveLength(4)
    expect(out[2]?.role).toBe('tool')
    const userMsg = out[3] as { role: string, content: Array<{ type: string, image_url?: { url: string } }> }
    expect(userMsg.role).toBe('user')
    expect(Array.isArray(userMsg.content)).toBe(true)
    const imgPart = userMsg.content.find(p => p.type === 'image_url')
    expect(imgPart?.image_url?.url).toBe('data:image/png;base64,AAAA')
  })
})

// ─── Tool declarations ──────────────────────────────────────────────────

describe('internalToOpenAITools', () => {
  it('translates function declarations to OpenAI tools[] with JSON-Schema parameters', () => {
    const decls: FunctionDeclaration[] = [{
      name: 'view_document',
      description: 'View a range',
      parameters: {
        type: 'object',
        properties: {
          view_range: { type: 'array', items: { type: 'integer' } }
        },
        required: ['view_range']
      } as unknown as FunctionDeclaration['parameters']
    }]
    const out = internalToOpenAITools(decls)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      type: 'function',
      function: {
        name: 'view_document',
        description: 'View a range',
        parameters: {
          type: 'object',
          properties: {
            view_range: { type: 'array', items: { type: 'integer' } }
          },
          required: ['view_range']
        }
      }
    })
  })
})

// ─── Inbound: OpenAI stream chunks → internal-shape ─────────────────────

// Synthesise a fake OpenAI streaming response. Pin the accumulator
// behaviour: text deltas pass through, tool-call args fragment across
// chunks and accumulate by index.

type OAIChunk = {
  choices?: Array<{
    index?: number
    delta?: {
      content?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: string
        function?: { name?: string, arguments?: string }
      }>
    }
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

async function* mockStream(chunks: OAIChunk[]): AsyncGenerator<OAIChunk> {
  for (const c of chunks) yield c
}

describe('openAIStreamToInternalChunks', () => {
  it('passes text deltas through as internal text-part chunks', async () => {
    const stream = mockStream([
      { choices: [{ delta: { content: 'Hello ' } }] },
      { choices: [{ delta: { content: 'world' } }] },
      { choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }
    ])
    const out: Array<{ text?: string }> = []
    for await (const c of openAIStreamToInternalChunks(stream as never)) {
      const text = c.candidates?.[0]?.content?.parts?.[0]?.text
      if (text) out.push({ text })
    }
    expect(out.map(o => o.text).join('')).toBe('Hello world')
  })

  it('accumulates fragmented tool_calls by index and emits a complete functionCalls array on finish', async () => {
    const stream = mockStream([
      // Chunk 1: tool call header
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'view_document' } }] } }] },
      // Chunk 2: args fragment
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"view_' } }] } }] },
      // Chunk 3: more args
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'range":' } }] } }] },
      // Chunk 4: final args
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '[1,5]}' } }] } }] },
      // Chunk 5: terminal
      { choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 15 } }
    ])
    const allChunks: Array<unknown> = []
    let finalCall: { id?: string, name?: string, args?: Record<string, unknown> } | undefined
    for await (const c of openAIStreamToInternalChunks(stream as never)) {
      allChunks.push(c)
      if (c.functionCalls && c.functionCalls.length > 0) {
        finalCall = c.functionCalls[0]
      }
    }
    expect(finalCall).toBeDefined()
    expect(finalCall?.id).toBe('call_a')
    expect(finalCall?.name).toBe('view_document')
    expect(finalCall?.args).toEqual({ view_range: [1, 5] })
  })

  it('handles two concurrent tool_calls indexed separately', async () => {
    const stream = mockStream([
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: 'call_a', type: 'function', function: { name: 'a', arguments: '{"x":1}' } },
        { index: 1, id: 'call_b', type: 'function', function: { name: 'b', arguments: '{"y":2}' } }
      ] } }] },
      { choices: [{ finish_reason: 'tool_calls' }] }
    ])
    let calls: Array<{ id?: string, name?: string }> = []
    for await (const c of openAIStreamToInternalChunks(stream as never)) {
      if (c.functionCalls) calls = c.functionCalls
    }
    expect(calls).toHaveLength(2)
    expect(calls.map(c => c.name).sort()).toEqual(['a', 'b'])
  })

  it('maps OpenAI finish_reason to the internal FinishReason enum', async () => {
    const cases = [
      { input: 'stop', expected: FinishReason.STOP },
      { input: 'length', expected: FinishReason.MAX_TOKENS },
      { input: 'content_filter', expected: FinishReason.SAFETY }
    ]
    for (const { input, expected } of cases) {
      const stream = mockStream([{ choices: [{ delta: { content: 'x' } }] }, { choices: [{ finish_reason: input }] }])
      let finish: FinishReason | undefined
      for await (const c of openAIStreamToInternalChunks(stream as never)) {
        const r = c.candidates?.[0]?.finishReason
        if (r) finish = r
      }
      expect(finish).toBe(expected)
    }
  })

  it('emits usageMetadata in promptTokenCount / candidatesTokenCount on the terminal chunk', async () => {
    const stream = mockStream([
      { choices: [{ delta: { content: 'x' } }] },
      { choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 42, completion_tokens: 7 } }
    ])
    let lastUsage: { promptTokenCount?: number, candidatesTokenCount?: number } | undefined
    for await (const c of openAIStreamToInternalChunks(stream as never)) {
      if (c.usageMetadata) lastUsage = c.usageMetadata
    }
    expect(lastUsage?.promptTokenCount).toBe(42)
    expect(lastUsage?.candidatesTokenCount).toBe(7)
  })

  it('parses corrupt args buffer into empty object (loop\'s Zod will reject)', async () => {
    const stream = mockStream([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'badtool', arguments: '{not-json' } }] } }] },
      { choices: [{ finish_reason: 'tool_calls' }] }
    ])
    let calls: Array<{ args?: Record<string, unknown> }> = []
    for await (const c of openAIStreamToInternalChunks(stream as never)) {
      if (c.functionCalls) calls = c.functionCalls
    }
    expect(calls[0]?.args).toEqual({})
  })
})
