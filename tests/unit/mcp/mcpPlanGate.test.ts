import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { MCP_SCOPES } from '../../../server/utils/mcp/mcpAuth'
import { mcpToolClass } from '../../../server/mcp/lib/toolClasses'

// Read-only MCP for plans without `mcpWrite` + the daily tool-call
// allowance (`mcpToolCallsPerDay`). Two layers:
//   - every tool's `enabled` guard hides non-read tools from `tools/list`,
//   - `admitToolCall` refuses them per call (a client that kept an old
//     tool list) and counts the daily allowance.
// The integration server can't run this shape (its MCP rate-limit suite
// needs write tools there), so it is pinned here.

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (d: unknown) => d }))

const checkRateLimit = vi.hoisted(() => vi.fn(async (_ns: string, _key: string, _max: number, _windowMs: number) => true))
vi.mock('../../../server/utils/platform/rateLimit', () => ({ checkRateLimit }))
vi.mock('../../../server/utils/rendering/renderRateLimit', () => ({ consumeRenderAllowance: vi.fn(async () => true) }))

vi.stubGlobal('createError', (opts: { statusCode: number, message?: string, data?: unknown }) =>
  Object.assign(new Error(opts.message ?? ''), { statusCode: opts.statusCode, data: opts.data }))

const { admitToolCall } = await import('../../../server/mcp/lib/wrapDocBoundTool')

type FakeEvent = { context: { mcp: { userId: number, scopes: string[], tokenId: string }, mcpPlan?: { mcpWrite: boolean, mcpToolCallsPerDay: number | null } } }

function fakeEvent(plan?: { mcpWrite: boolean, mcpToolCallsPerDay: number | null }): FakeEvent {
  return { context: { mcp: { userId: 7, scopes: [...MCP_SCOPES], tokenId: 'mkt_pat_x' }, mcpPlan: plan } }
}

const TOOLS_DIR = join(__dirname, '..', '..', '..', 'server', 'mcp', 'tools')

beforeEach(() => {
  checkRateLimit.mockReset()
  checkRateLimit.mockImplementation(async () => true)
})

describe('MCP tool list on a read-only plan', () => {
  it('lists only read tools when the plan lacks mcpWrite', async () => {
    const files = readdirSync(TOOLS_DIR).filter(f => f.endsWith('.ts'))
    for (const file of files) {
      const def = (await import(join(TOOLS_DIR, file))).default as { name: string, enabled: (e: unknown) => boolean }
      const shown = def.enabled(fakeEvent({ mcpWrite: false, mcpToolCallsPerDay: 100 }))
      expect(mcpToolClass(def.name) === 'read' || !shown, def.name).toBe(true)
    }
  })

  it('keeps read tools listed', async () => {
    const def = (await import(join(TOOLS_DIR, 'view_document.ts'))).default as { enabled: (e: unknown) => boolean }
    expect(def.enabled(fakeEvent({ mcpWrite: false, mcpToolCallsPerDay: 100 }))).toBe(true)
  })
})

describe('admitToolCall: plan checks', () => {
  it('refuses a write tool on a read-only plan with plan/feature-unavailable', async () => {
    const event = fakeEvent({ mcpWrite: false, mcpToolCallsPerDay: null })
    await expect(admitToolCall(event as never, 'replace_text', 'documents:write')).rejects.toMatchObject({
      statusCode: 409,
      data: { code: 'plan/feature-unavailable', feature: 'mcpWrite', messageKey: 'plan.feature.mcpWrite' }
    })
    expect(checkRateLimit).not.toHaveBeenCalled()
  })

  it('admits a read tool on a read-only plan', async () => {
    const event = fakeEvent({ mcpWrite: false, mcpToolCallsPerDay: null })
    await expect(admitToolCall(event as never, 'view_document', 'documents:read')).resolves.toMatchObject({ userId: 7 })
  })

  it('counts the daily allowance with the plan\'s number and refuses when it is spent', async () => {
    const event = fakeEvent({ mcpWrite: true, mcpToolCallsPerDay: 100 })
    await admitToolCall(event as never, 'view_document', 'documents:read')
    expect(checkRateLimit).toHaveBeenCalledWith('mcp-tool-user-day', '7', 100, 24 * 60 * 60_000)

    checkRateLimit.mockImplementation(async ns => ns !== 'mcp-tool-user-day')
    await expect(admitToolCall(event as never, 'view_document', 'documents:read')).rejects.toMatchObject({
      statusCode: 429,
      data: { code: 'plan/limit-reached', field: 'mcpToolCallsPerDay', limit: 100 }
    })
  })

  it('applies no daily allowance without a plan limit (self-host default)', async () => {
    const event = fakeEvent({ mcpWrite: true, mcpToolCallsPerDay: null })
    await admitToolCall(event as never, 'replace_text', 'documents:write')
    expect(checkRateLimit.mock.calls.map(c => c[0])).not.toContain('mcp-tool-user-day')
  })
})
