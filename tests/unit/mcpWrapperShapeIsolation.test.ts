import { describe, it, expect } from 'vitest'
import { stripWrapperArgs } from '../../server/mcp/lib/stripWrapperArgs'

// Pin the dispatch contract — the args object that reaches the
// underlying TOOL_HANDLER must NEVER carry wrapper-injected fields
// (`doc_id`, `workspace_id`). Without this isolation, handlers that do
// `{...args}`-style spread (the original `coerceThemePatch` bug in
// `update_theme` — leaked `doc_id` into the merged DocTheme and
// failed `.strict()` validation) silently break for the MCP caller
// while the in-app loop keeps working, because the loop never injects
// these fields.
//
// The wrapper-side wiring (`buildDocBoundTool` / `buildWorkspaceBoundTool`
// passing the right field names to this helper) is verified at the
// integration tier — `tests/integration/mcp/tools-write.test.ts` runs
// `update_theme` end-to-end through MCP and asserts the merged theme
// persists correctly. If this helper passes but that integration test
// fails again, the wrapper forgot to call this helper.

describe('stripWrapperArgs — dispatch shape contract', () => {
  it('removes a single named field', () => {
    const args = { doc_id: 'doc-abc', old_str: 'a', new_str: 'b' }
    const out = stripWrapperArgs(args, 'doc_id')
    expect(out).toEqual({ old_str: 'a', new_str: 'b' })
  })

  it('removes multiple named fields', () => {
    const args = { doc_id: 'doc-abc', workspace_id: 'ws-xyz', query: 'hello' }
    const out = stripWrapperArgs(args, 'doc_id', 'workspace_id')
    expect(out).toEqual({ query: 'hello' })
  })

  it('does not mutate the original args object', () => {
    const args = { doc_id: 'doc-abc', old_str: 'a' }
    const before = { ...args }
    stripWrapperArgs(args, 'doc_id')
    expect(args).toEqual(before)
  })

  it('returns an empty object when every field is stripped', () => {
    const out = stripWrapperArgs({ doc_id: 'x', workspace_id: 'y' }, 'doc_id', 'workspace_id')
    expect(out).toEqual({})
  })

  it('is a no-op when none of the named fields are present', () => {
    const args = { query: 'hello', limit: 10 }
    const out = stripWrapperArgs(args, 'doc_id', 'workspace_id')
    expect(out).toEqual(args)
  })

  it('handles nested objects without flattening or descending into them', () => {
    // The wrapper-injected fields are always top-level scalars
    // (`doc_id: string`, `workspace_id: string`). Nested fields like
    // `body: { color: '#fff' }` must pass through untouched — they
    // ARE the handler's payload.
    const args = {
      doc_id: 'doc-abc',
      page: { margin: 30 },
      body: { color: '#123456' }
    }
    const out = stripWrapperArgs(args, 'doc_id')
    expect(out).toEqual({
      page: { margin: 30 },
      body: { color: '#123456' }
    })
    // Same reference — confirms shallow copy.
    expect((out as { page: object }).page).toBe(args.page)
  })
})
