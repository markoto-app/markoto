import { describe, it, expect, vi } from 'vitest'
import type { GoogleGenAI } from '@google/genai'
import { webSearch, fetchUrl } from '../../server/utils/agentic/functionTools'

// `webSearch` and `fetchUrl` are thin sub-calls wrapping Gemini's
// `googleSearch` / `urlContext` tools. They run independently of the
// main agentic loop (same isolation rationale — tool coexistence with
// functionDeclarations shifts between model versions). These tests
// pin the prompt wiring + response parsing + error/abort behaviour
// without touching the real Gemini API.

// ─── Fake Gemini ────────────────────────────────────────────────────────

/**
 * Build a fake GoogleGenAI whose `generateContent` returns whatever the
 * test programs. Captures the request shape so assertions can check
 * the prompt + tool config we sent.
 */
interface FakeResponse {
  text?: string
  candidates?: Array<{
    content?: { parts?: unknown[] }
    groundingMetadata?: {
      groundingChunks?: Array<{ web?: { uri?: string, title?: string } }>
    }
  }>
}

function makeFakeAi(respond: (args: unknown) => FakeResponse | Promise<FakeResponse>): {
  ai: GoogleGenAI
  calls: Array<unknown>
} {
  const calls: unknown[] = []
  const ai = {
    models: {
      generateContent: async (args: unknown) => {
        calls.push(args)
        return respond(args)
      }
    }
  } as unknown as GoogleGenAI
  return { ai, calls }
}

// ─── webSearch ──────────────────────────────────────────────────────────

describe('webSearch', () => {
  it('includes the query in the prompt text sent to Gemini', async () => {
    const { ai, calls } = makeFakeAi(() => ({ text: 'Short answer.' }))
    await webSearch(ai, 'gemini-test', 'gemini pricing', new AbortController().signal)
    expect(calls).toHaveLength(1)
    const req = calls[0] as { contents: Array<{ parts: Array<{ text: string }> }> }
    expect(req.contents[0].parts[0].text).toContain('gemini pricing')
  })

  it('enables the googleSearch grounding tool', async () => {
    const { ai, calls } = makeFakeAi(() => ({ text: 'ok' }))
    await webSearch(ai, 'gemini-test', 'q', new AbortController().signal)
    const req = calls[0] as { config: { tools: Array<Record<string, unknown>> } }
    expect(req.config.tools[0]).toHaveProperty('googleSearch')
  })

  it('returns just the answer when groundingMetadata is empty', async () => {
    const { ai } = makeFakeAi(() => ({ text: 'Plain answer.' }))
    const result = await webSearch(ai, 'gemini-test', 'q', new AbortController().signal)
    expect(result.text).toBe('Plain answer.')
    expect(result.text).not.toContain('Sources:')
    expect(result.sources).toEqual([])
  })

  it('appends a Sources: list when grounding chunks include URIs', async () => {
    const { ai } = makeFakeAi(() => ({
      text: 'Answer body.',
      candidates: [{
        groundingMetadata: {
          groundingChunks: [
            { web: { uri: 'https://a.com', title: 'Site A' } },
            { web: { uri: 'https://b.com', title: 'Site B' } }
          ]
        }
      }]
    }))
    const result = await webSearch(ai, 'gemini-test', 'q', new AbortController().signal)
    expect(result.text).toContain('Answer body.')
    expect(result.text).toContain('Sources:')
    expect(result.text).toContain('Site A: https://a.com')
    expect(result.text).toContain('Site B: https://b.com')
    // Structured shape mirrors the text — drives the activity drawer.
    expect(result.sources).toEqual([
      { title: 'Site A', uri: 'https://a.com' },
      { title: 'Site B', uri: 'https://b.com' }
    ])
  })

  it('deduplicates grounding chunks that repeat the same URI', async () => {
    // Regression target: grounding metadata emits one chunk per quoted
    // span, so a single source can appear many times. Without dedupe
    // the Sources list gets polluted with repeated entries.
    const { ai } = makeFakeAi(() => ({
      text: 'Answer.',
      candidates: [{
        groundingMetadata: {
          groundingChunks: [
            { web: { uri: 'https://same.com', title: 'Same' } },
            { web: { uri: 'https://same.com', title: 'Same' } },
            { web: { uri: 'https://same.com', title: 'Same' } },
            { web: { uri: 'https://other.com', title: 'Other' } }
          ]
        }
      }]
    }))
    const result = await webSearch(ai, 'gemini-test', 'q', new AbortController().signal)
    const matches = result.text.match(/https:\/\/same\.com/g) || []
    expect(matches.length).toBe(1)
    expect(result.text).toContain('https://other.com')
    // Sources array also deduplicated.
    expect(result.sources.filter(s => s.uri === 'https://same.com')).toHaveLength(1)
  })

  it('falls back to URI when a source has no title', async () => {
    const { ai } = makeFakeAi(() => ({
      text: 'Answer.',
      candidates: [{
        groundingMetadata: {
          groundingChunks: [
            { web: { uri: 'https://notitled.com' } } // no title
          ]
        }
      }]
    }))
    const result = await webSearch(ai, 'gemini-test', 'q', new AbortController().signal)
    expect(result.text).toContain('https://notitled.com: https://notitled.com')
  })

  it('returns a "no answer" fallback when Gemini emits empty text', async () => {
    // Regression target: empty response must NOT silently return "" —
    // the loop would then feed an empty functionResponse to the next
    // turn and the model wastes a round trying to figure out what
    // happened. Give it a clear message.
    const { ai } = makeFakeAi(() => ({ text: '' }))
    const result = await webSearch(ai, 'gemini-test', 'q', new AbortController().signal)
    expect(result.text).toContain('No answer returned')
    expect(result.sources).toEqual([])
  })

  it('treats whitespace-only text as empty', async () => {
    const { ai } = makeFakeAi(() => ({ text: '   \n  ' }))
    const result = await webSearch(ai, 'gemini-test', 'q', new AbortController().signal)
    expect(result.text).toContain('No answer returned')
  })

  it('throws "aborted" when called with an already-aborted signal', async () => {
    // Don't waste an API call on a caller that already gave up.
    const ctrl = new AbortController()
    ctrl.abort()
    const { ai, calls } = makeFakeAi(() => ({ text: 'ok' }))
    await expect(webSearch(ai, 'gemini-test', 'q', ctrl.signal)).rejects.toThrow('aborted')
    expect(calls).toHaveLength(0)
  })

  it('forwards the abort signal into Gemini\'s config', async () => {
    // So an in-flight Gemini call can be killed mid-response when the
    // outer AI session aborts.
    const ctrl = new AbortController()
    const { ai, calls } = makeFakeAi(() => ({ text: 'ok' }))
    await webSearch(ai, 'gemini-test', 'q', ctrl.signal)
    const req = calls[0] as { config: { abortSignal?: AbortSignal } }
    expect(req.config.abortSignal).toBe(ctrl.signal)
  })
})

// ─── fetchUrl ───────────────────────────────────────────────────────────

describe('fetchUrl', () => {
  it('auto-prepends https:// when scheme is missing', async () => {
    // urlContext won't resolve scheme-less strings, so the tool
    // normalises "example.com" → "https://example.com" before asking
    // Gemini to fetch.
    const { ai, calls } = makeFakeAi(() => ({
      text: JSON.stringify({ summary: 'ok', images: [] })
    }))
    await fetchUrl(ai, 'gemini-test', 'example.com', new AbortController().signal)
    const req = calls[0] as { contents: Array<{ parts: Array<{ text: string }> }> }
    expect(req.contents[0].parts[0].text).toContain('https://example.com')
    // Should NOT double-prefix.
    expect(req.contents[0].parts[0].text).not.toContain('https://https://')
  })

  it('passes https:// URLs through unchanged', async () => {
    const { ai, calls } = makeFakeAi(() => ({
      text: JSON.stringify({ summary: 'ok', images: [] })
    }))
    await fetchUrl(ai, 'gemini-test', 'https://example.com/page', new AbortController().signal)
    const req = calls[0] as { contents: Array<{ parts: Array<{ text: string }> }> }
    expect(req.contents[0].parts[0].text).toContain('https://example.com/page')
  })

  it('passes http:// URLs through unchanged (no silent upgrade)', async () => {
    // The tool intentionally does NOT upgrade http → https (some
    // resources still serve on http-only). Pin the behaviour.
    const { ai, calls } = makeFakeAi(() => ({
      text: JSON.stringify({ summary: 'ok', images: [] })
    }))
    await fetchUrl(ai, 'gemini-test', 'http://example.com', new AbortController().signal)
    const req = calls[0] as { contents: Array<{ parts: Array<{ text: string }> }> }
    expect(req.contents[0].parts[0].text).toContain('http://example.com')
  })

  it('trims leading/trailing whitespace on the URL before checking scheme', async () => {
    const { ai, calls } = makeFakeAi(() => ({
      text: JSON.stringify({ summary: 'ok', images: [] })
    }))
    await fetchUrl(ai, 'gemini-test', '  example.com  ', new AbortController().signal)
    const req = calls[0] as { contents: Array<{ parts: Array<{ text: string }> }> }
    expect(req.contents[0].parts[0].text).toContain('https://example.com')
  })

  it('enables the urlContext tool + requests JSON output', async () => {
    const { ai, calls } = makeFakeAi(() => ({
      text: JSON.stringify({ summary: 'ok', images: [] })
    }))
    await fetchUrl(ai, 'gemini-test', 'https://example.com', new AbortController().signal)
    const req = calls[0] as {
      config: {
        tools: Array<Record<string, unknown>>
        responseMimeType?: string
        responseSchema?: unknown
      }
    }
    expect(req.config.tools[0]).toHaveProperty('urlContext')
    expect(req.config.responseMimeType).toBe('application/json')
    expect(req.config.responseSchema).toBeTruthy()
  })

  it('parses a valid JSON response into Summary + Images sections', async () => {
    const { ai } = makeFakeAi(() => ({
      text: JSON.stringify({
        summary: 'A useful article about markdown.',
        images: [
          { url: 'https://cdn.com/hero.png', description: 'Hero shot' },
          { url: 'https://cdn.com/fig1.png' }
        ]
      })
    }))
    const result = await fetchUrl(ai, 'gemini-test', 'https://example.com', new AbortController().signal)
    expect(result.text).toContain('Summary:')
    expect(result.text).toContain('A useful article about markdown.')
    expect(result.text).toContain('Images observed on the page:')
    expect(result.text).toContain('https://cdn.com/hero.png: Hero shot')
    expect(result.text).toContain('https://cdn.com/fig1.png')
    // Structured shape feeds the activity drawer's image strip.
    expect(result.summary).toBe('A useful article about markdown.')
    expect(result.images).toEqual([
      { url: 'https://cdn.com/hero.png', description: 'Hero shot' },
      { url: 'https://cdn.com/fig1.png' }
    ])
  })

  it('renders "(none found)" when images array is empty', async () => {
    const { ai } = makeFakeAi(() => ({
      text: JSON.stringify({ summary: 'Text only.', images: [] })
    }))
    const result = await fetchUrl(ai, 'gemini-test', 'https://example.com', new AbortController().signal)
    expect(result.text).toContain('Images observed on the page:')
    expect(result.text).toContain('- (none found)')
    expect(result.images).toEqual([])
  })

  it('renders "(empty)" when summary is missing or empty', async () => {
    const { ai } = makeFakeAi(() => ({
      text: JSON.stringify({ summary: '', images: [] })
    }))
    const result = await fetchUrl(ai, 'gemini-test', 'https://example.com', new AbortController().signal)
    expect(result.text).toContain('Summary:')
    expect(result.text).toContain('(empty)')
    expect(result.summary).toBe('')
  })

  it('falls back to raw text when Gemini emits non-JSON prose despite the schema', async () => {
    // Regression target: even with responseMimeType + responseSchema,
    // some model versions occasionally drop formatted text. Rather
    // than crash, the tool hands the raw text through — the outer
    // agentic loop's main model can parse free-form just fine.
    const { ai } = makeFakeAi(() => ({
      text: 'This is definitely not JSON and has no braces at all.'
    }))
    const result = await fetchUrl(ai, 'gemini-test', 'https://example.com', new AbortController().signal)
    expect(result.text).toBe('This is definitely not JSON and has no braces at all.')
    // Structured fields empty when JSON parse fails.
    expect(result.summary).toBe('')
    expect(result.images).toEqual([])
  })

  it('returns an "unable to extract" message when the response is empty', async () => {
    const { ai } = makeFakeAi(() => ({ text: '' }))
    const result = await fetchUrl(ai, 'gemini-test', 'https://example.com', new AbortController().signal)
    expect(result.text).toContain('Unable to extract content')
    expect(result.text).toContain('https://example.com')
    expect(result.images).toEqual([])
  })

  it('skips images with missing URL fields (defensive)', async () => {
    const { ai } = makeFakeAi(() => ({
      text: JSON.stringify({
        summary: 'ok',
        images: [
          { url: 'https://good.com/img.png' },
          { description: 'dangling description with no url' },
          { url: '', description: 'empty url' }
        ]
      })
    }))
    const result = await fetchUrl(ai, 'gemini-test', 'https://example.com', new AbortController().signal)
    expect(result.text).toContain('https://good.com/img.png')
    expect(result.text).not.toContain('dangling description')
    expect(result.text).not.toContain('empty url')
    // Structured images array also filters out missing URLs.
    expect(result.images).toEqual([{ url: 'https://good.com/img.png' }])
  })

  it('throws "aborted" on a pre-aborted signal without calling Gemini', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const { ai, calls } = makeFakeAi(() => ({ text: 'ok' }))
    await expect(fetchUrl(ai, 'gemini-test', 'https://example.com', ctrl.signal))
      .rejects.toThrow('aborted')
    expect(calls).toHaveLength(0)
  })

  it('forwards the abort signal into Gemini\'s config', async () => {
    const ctrl = new AbortController()
    const { ai, calls } = makeFakeAi(() => ({
      text: JSON.stringify({ summary: 'ok', images: [] })
    }))
    await fetchUrl(ai, 'gemini-test', 'https://example.com', ctrl.signal)
    const req = calls[0] as { config: { abortSignal?: AbortSignal } }
    expect(req.config.abortSignal).toBe(ctrl.signal)
  })
})
