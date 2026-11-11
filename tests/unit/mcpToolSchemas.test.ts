import { describe, it, expect, vi } from 'vitest'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ZodTypeAny, ZodRawShape } from 'zod'
import { MCP_SCOPES } from '../../server/utils/mcp/mcpAuth'

// `@nuxtjs/mcp-toolkit/server` transitively pulls in Nitro internals that
// can't resolve in a plain vitest environment. `defineMcpTool` itself is
// an identity passthrough (verified at node_modules/.../tools.js:59), so
// replacing it with `d => d` preserves the definition shape we're testing
// against without booting Nitro.
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: (d: unknown) => d
  // Type-only re-exports — the wrappers in `server/mcp/lib/wrapDocBoundTool.ts`
  // import these as types, so the mock just needs the names to exist for
  // `import type { ... } from '@nuxtjs/mcp-toolkit/server'` to resolve.
  // No runtime body needed; `import type` is stripped at transpile time.
}))

// Tool modules also import from `../lib/mcpToolContext`, which only uses
// Nuxt's auto-imported `createError` inside `requireMcpAuth` (called at
// handler time, not at module load) — so the import resolves cleanly.

// Shape invariants for every server/mcp/tools/*.ts. Dynamic-discovery
// pattern: every new tool added to that directory automatically gets
// pulled into these tests — no per-tool maintenance.
//
// Pinned invariants:
//   1. Wire name is snake_case (matches the in-app loop convention).
//      The toolkit auto-derives kebab-case from the filename otherwise.
//   2. Description is non-empty (clients display it in tool catalogs).
//   3. `enabled` guard exists — unauthenticated callers must NEVER see a
//      tool (soft-auth contract; without `enabled` the tool would leak
//      into anonymous tools/list).
//   4. Every Zod inputSchema field carries `.describe(...)` — the model
//      can't pick the right field without per-field hints.
//   5. Read-only tools advertise `readOnlyHint: true`; clients use this
//      to skip confirmation prompts.

const TOOLS_DIR = join(__dirname, '..', '..', 'server', 'mcp', 'tools')

interface ToolModule {
  filename: string
  // The default export shape is whatever `defineMcpTool(...)` returns
  // (identity passthrough). We narrow at use-sites — kept loose here
  // because the toolkit's generic-shape type is unwieldy in a test
  // harness.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  def: any
}

async function loadAllTools(): Promise<ToolModule[]> {
  const entries = readdirSync(TOOLS_DIR).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  const loaded: ToolModule[] = []
  for (const filename of entries) {
    const module = await import(join(TOOLS_DIR, filename))
    loaded.push({ filename, def: module.default })
  }
  return loaded
}

describe('MCP tool definitions — discovery', () => {
  it('finds at least one tool', async () => {
    const tools = await loadAllTools()
    expect(tools.length).toBeGreaterThan(0)
  })

  it('every tool exports a default', async () => {
    const tools = await loadAllTools()
    for (const { filename, def } of tools) {
      expect(def, `${filename}: missing default export`).toBeDefined()
      expect(typeof def, `${filename}: default export must be an object`).toBe('object')
    }
  })
})

describe('MCP tool definitions — shape invariants', () => {
  it('name is set and snake_case', async () => {
    for (const { filename, def } of await loadAllTools()) {
      expect(def.name, `${filename}: missing explicit name (toolkit would auto-derive kebab-case)`).toBeTypeOf('string')
      expect(def.name, `${filename}: name must be snake_case`).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  it('name matches the filename (modulo .ts)', async () => {
    for (const { filename, def } of await loadAllTools()) {
      const expected = filename.replace(/\.ts$/, '')
      expect(def.name, `${filename}: name "${def.name}" should match filename "${expected}"`).toBe(expected)
    }
  })

  it('description is set and non-empty', async () => {
    for (const { filename, def } of await loadAllTools()) {
      expect(def.description, `${filename}: missing description`).toBeTypeOf('string')
      expect(def.description.length, `${filename}: description is empty`).toBeGreaterThan(0)
    }
  })

  it('has an `enabled` guard (soft-auth contract)', async () => {
    for (const { filename, def } of await loadAllTools()) {
      expect(def.enabled, `${filename}: missing enabled guard — unauthenticated callers would see this tool`).toBeTypeOf('function')
    }
  })

  it('annotations field is set', async () => {
    for (const { filename, def } of await loadAllTools()) {
      expect(def.annotations, `${filename}: missing annotations (readOnlyHint / destructiveHint hints)`).toBeTypeOf('object')
    }
  })

  it('every inputSchema scalar field has a .describe(...) hint', async () => {
    // Scalar fields (string, number, boolean, enum, array of those)
    // MUST carry per-field descriptions — without them the model can't
    // pick the right shape. Nested `z.object({...})` fields are
    // exempt: their inner fields carry their own descriptions, and
    // the outer object's description is more naturally the top-level
    // tool description (e.g. `update_theme`'s `page` / `body` /
    // `headings` groupings).
    for (const { filename, def } of await loadAllTools()) {
      if (!def.inputSchema) continue
      const shape = def.inputSchema as ZodRawShape
      for (const [fieldName, field] of Object.entries(shape)) {
        const f = field as ZodTypeAny
        // Unwrap `.optional()` to inspect the underlying type.
        const inner = (f as ZodTypeAny & { _def?: { innerType?: ZodTypeAny } })._def?.innerType ?? f
        if (inner instanceof z.ZodObject) continue
        const description = f.description
        expect(
          description,
          `${filename}: inputSchema.${fieldName} missing .describe(...)`
        ).toBeTypeOf('string')
        expect(
          description!.length,
          `${filename}: inputSchema.${fieldName} description is empty`
        ).toBeGreaterThan(0)
      }
    }
  })

  it('inputSchema is a Zod raw shape (object of ZodTypes), not a wrapped ZodObject', async () => {
    // `defineMcpTool` expects the raw-shape form (`{ field: z.string() }`),
    // not a wrapped `z.object({...})`. Wrapping breaks the SDK's schema
    // generation; the toolkit doesn't currently catch this at registration.
    for (const { filename, def } of await loadAllTools()) {
      if (!def.inputSchema) continue
      expect(
        def.inputSchema instanceof z.ZodObject,
        `${filename}: inputSchema must be a raw shape ({field: z.string()}), not z.object({...})`
      ).toBe(false)
    }
  })
})

describe('MCP tool definitions — scope membership', () => {
  // Every tool's `enabled` guard reads from `event.context.mcp?.scopes`.
  // We don't introspect the function body, but we can sanity-check that
  // the file references at least one of the valid scope strings (catches
  // typos like `documents:reads`).
  it('source references a valid scope when enabled is scope-gated', async () => {
    const { readFileSync } = await import('node:fs')
    for (const { filename } of await loadAllTools()) {
      const source = readFileSync(join(TOOLS_DIR, filename), 'utf-8')
      // Tools may also gate on bare auth presence (no scope check). Only
      // assert when the file mentions hasScope/scopes.
      const mentionsScope = /hasScope|scopes\b/.test(source)
      if (!mentionsScope) continue
      const referenced = MCP_SCOPES.filter(s => source.includes(`'${s}'`) || source.includes(`"${s}"`))
      expect(
        referenced.length,
        `${filename}: references hasScope/scopes but no valid MCP_SCOPES string found (typo?)`
      ).toBeGreaterThan(0)
    }
  })
})
