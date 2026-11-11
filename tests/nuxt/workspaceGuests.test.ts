// @vitest-environment nuxt
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { SharingGuestShares, WorkspaceUsagePanel } from '#components'
import { readBody } from 'h3'

// Workspace guests UI: the share dialog's guest section and the
// admins' usage tab.

type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const mounted: Wrapper[] = []
const puts: unknown[] = []
const deletes: string[] = []
let shares: Array<{ userId: number, name: string, email: string | null, access: 'view' | 'edit' }> = []

registerEndpoint('/api/docs/doc1/shares', async (event) => {
  if (event.method === 'PUT') {
    const body = await readBody<{ userId: number, access: 'view' | 'edit' }>(event)
    puts.push(body)
    shares = [...shares.filter(s => s.userId !== body.userId), { userId: body.userId, name: 'Gus Guest', email: 'gus@client.example', access: body.access }]
    return { ok: true }
  }
  return { shares, guests: [{ userId: 7, name: 'Gus Guest', email: 'gus@client.example' }, { userId: 8, name: 'Ola Other', email: null }] }
})
registerEndpoint('/api/docs/doc1/shares/7', { method: 'DELETE', handler: () => {
  deletes.push('7')
  shares = shares.filter(s => s.userId !== 7)
  return { ok: true }
} })
registerEndpoint('/api/workspaces/ws1/usage', () => ({
  aiBudgetShared: true,
  members: [
    { userId: 1, name: 'Maya Admin', role: 'admin', documents: 3, sharedDocuments: 0, knowledgeFiles: 2, knowledgeBytes: 2 * 1024 * 1024, imageBytes: 512 * 1024, aiSpendUsd: 1.25 },
    { userId: 7, name: 'Gus Guest', role: 'guest', documents: 0, sharedDocuments: 2, knowledgeFiles: 0, knowledgeBytes: 0, imageBytes: 0, aiSpendUsd: null }
  ]
}))

afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  puts.length = 0
  deletes.length = 0
  shares = []
})

describe('SharingGuestShares', () => {
  it('shares with a guest and stops sharing', async () => {
    shares = [{ userId: 7, name: 'Gus Guest', email: 'gus@client.example', access: 'edit' }]
    const w = await mountSuspended(SharingGuestShares, { props: { docId: 'doc1' } })
    mounted.push(w)
    await vi.waitFor(() => expect(w.find('[data-testid="share-guest-7"]').exists()).toBe(true))
    expect(w.get('[data-testid="share-guest-7"]').text()).toContain('Gus Guest')
    // Only guests not yet shared with are offered.
    expect(w.find('[data-testid="share-guest-pick"]').exists()).toBe(true)
    await w.get('[data-testid="share-guest-remove-7"]').trigger('click')
    await vi.waitFor(() => expect(deletes).toEqual(['7']))
    await vi.waitFor(() => expect(w.find('[data-testid="share-guest-7"]').exists()).toBe(false))
  })

  it('stays hidden when the workspace has no guests', async () => {
    registerEndpoint('/api/docs/doc2/shares', () => ({ shares: [], guests: [] }))
    const w = await mountSuspended(SharingGuestShares, { props: { docId: 'doc2' } })
    mounted.push(w)
    await new Promise(r => setTimeout(r, 20))
    expect(w.find('[data-testid="share-guests"]').exists()).toBe(false)
  })
})

describe('WorkspaceUsagePanel', () => {
  it('lists members with storage and AI spend, guests apart without spend', async () => {
    const w = await mountSuspended(WorkspaceUsagePanel, { props: { workspaceId: 'ws1' } })
    mounted.push(w)
    await vi.waitFor(() => expect(w.find('[data-testid="workspace-usage-row-1"]').exists()).toBe(true))
    const row = w.get('[data-testid="workspace-usage-row-1"]').text()
    expect(row).toContain('Maya Admin')
    expect(row).toContain('2 files · 2.0 MB')
    expect(row).toContain('512.0 KB')
    expect(row).toContain('$1.25')
    expect(w.find('[data-testid="workspace-usage-row-7"]').exists()).toBe(false)
    expect(w.get('[data-testid="workspace-usage-guest-7"]').text()).toContain('2 shared documents')
  })
})
