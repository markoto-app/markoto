// Strip wrapper-injected fields from the args object before dispatching
// to the underlying tool handler. The handler must see the SAME args
// shape that the in-app AI loop passes, which never includes `doc_id`
// or `workspace_id` (those travel out-of-band on the ToolContext).
//
// Without this strip, handlers that do `{...args}`-style spread (e.g.
// `coerceThemePatch` in `update_theme`) carry the wrapper field into
// downstream merges and structural validators reject the result. This
// is shape drift between two callers of the same handler, fix it
// once at the wrapper boundary instead of N times in each handler.
//
// The wrapper-injected field names are KNOWN at compile time
// (`buildDocBoundTool` always adds doc_id; `buildWorkspaceBoundTool`
// always adds workspace_id), so there's no risk of stripping a real
// handler input. New wrappers that inject other fields must update
// their dispatch site to strip them too.
//
// Lives in its own file (no Nitro/MCP-toolkit imports) so it can be
// unit-tested without spinning up the full server runtime, see
// `tests/unit/mcp/mcpWrapperShapeIsolation.test.ts`. The wrapper-side
// wiring is verified at the integration tier
// (`tests/integration/mcp/tools-write.test.ts` runs `update_theme`
// through MCP and asserts the merged theme persists correctly).

export function stripWrapperArgs<T extends Record<string, unknown>>(
  args: T,
  ...wrapperFields: readonly string[]
): T {
  const stripped = new Set(wrapperFields)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (!stripped.has(k)) out[k] = v
  }
  return out as T
}
