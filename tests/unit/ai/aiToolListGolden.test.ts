import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test, vi } from 'vitest'
import { z, type ZodRawShape } from 'zod'
import { ALL_TOOL_DECLARATIONS, KNOWLEDGE_TOOL_DECLARATIONS, CONTEXT_TOOL_DECLARATIONS, filterToolsForProviders, isToolName, toolSchema } from '../../../server/utils/ai/tools/registry'
import { internalToOpenAITools } from '../../../server/utils/agentic/messageTranslation'

// What the model and MCP clients read about our tools: names, order,
// descriptions and JSON Schemas. Tool descriptions are behaviour (the model
// decides from them), the order is part of the cacheable prompt prefix, and
// the runtime validators must accept exactly what the declarations promise.
// Pinned byte-for-byte as SHA-256 per section; a deliberate change
// regenerates the file with `UPDATE_GOLDEN=1 bun run test:unit
// tests/unit/ai/aiToolListGolden.test.ts`.

// The MCP toolkit pulls in Nitro internals; `defineMcpTool` is an identity
// passthrough (see mcpToolSchemas.test.ts).
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (d: unknown) => d }))

const GOLDEN_PATH = fileURLToPath(new URL('./aiToolList.golden.json', import.meta.url))
const MCP_TOOLS_DIR = join(__dirname, '..', '..', '..', 'server', 'mcp', 'tools')

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

interface McpToolDef {
  name: string
  title: string
  description: string
  inputSchema: ZodRawShape
  annotations: unknown
}

async function mcpCatalog(): Promise<unknown[]> {
  const files = readdirSync(MCP_TOOLS_DIR).filter(f => f.endsWith('.ts')).sort((a, b) => a.localeCompare(b))
  const out: unknown[] = []
  for (const file of files) {
    const def = (await import(join(MCP_TOOLS_DIR, file))).default as McpToolDef
    out.push({
      file,
      name: def.name,
      title: def.title,
      description: def.description,
      annotations: def.annotations,
      inputSchema: z.toJSONSchema(z.object(def.inputSchema), { target: 'draft-7' })
    })
  }
  return out
}

async function computeAll(): Promise<Record<string, string>> {
  const all = [...ALL_TOOL_DECLARATIONS, ...KNOWLEDGE_TOOL_DECLARATIONS, ...CONTEXT_TOOL_DECLARATIONS]
  const schemaNames = all.map(d => d.name ?? '').filter(isToolName).sort((a, b) => a.localeCompare(b))
  const filtered = filterToolsForProviders(ALL_TOOL_DECLARATIONS, { chat: { supportsVision: false }, image: null }, { search: false, fetch: true })
  return {
    'order:main': ALL_TOOL_DECLARATIONS.map(d => d.name).join(','),
    'order:knowledge': KNOWLEDGE_TOOL_DECLARATIONS.map(d => d.name).join(','),
    'declarations:main': sha(ALL_TOOL_DECLARATIONS),
    'declarations:knowledge': sha(KNOWLEDGE_TOOL_DECLARATIONS),
    'order:context': CONTEXT_TOOL_DECLARATIONS.map(d => d.name).join(','),
    'declarations:context': sha(CONTEXT_TOOL_DECLARATIONS),
    'openai:tools': sha(internalToOpenAITools(all)),
    'filtered:noVisionNoImageNoSearch': filtered.map(d => d.name).join(','),
    'validators:names': schemaNames.join(','),
    'validators:jsonSchema': sha(schemaNames.map(n => [n, z.toJSONSchema(toolSchema(n)!, { target: 'draft-7' })])),
    'mcp:catalog': sha(await mcpCatalog())
  }
}

describe('AI tool list golden output', async () => {
  const actual = await computeAll()

  if (process.env.UPDATE_GOLDEN === '1') {
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(actual, null, 2)}\n`)
  }

  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, string>

  test.each(Object.keys(golden))('%s is unchanged', (key) => {
    expect(actual[key]).toBe(golden[key])
  })
})
