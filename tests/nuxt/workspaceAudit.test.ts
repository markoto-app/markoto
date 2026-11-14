// @vitest-environment nuxt
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { WorkspaceAuditPanel } from '#components'
import { getQuery } from 'h3'

// Workspace audit log UI: readable labels, actor + shortened IP,
// details on click, "show older" with the cursor, export links carrying
// the filters.

type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const mounted: Wrapper[] = []
const queries: Array<Record<string, unknown>> = []

registerEndpoint('/api/workspaces/ws1/audit', (event) => {
  const q = getQuery(event)
  queries.push(q)
  if (q.before === '10') {
    return { events: [{ id: 9, at: '2026-11-01T10:00:00.000Z', actor: { id: null, name: null }, ip: null, action: 'sso.scim_user_deactivated', target: { type: 'workspace', id: 'ws1' }, before: null, after: null, details: null }], nextBefore: null, retentionDays: 730 }
  }
  return {
    events: [
      { id: 11, at: '2026-11-09T10:00:00.000Z', actor: { id: 1, name: 'Maya Chen' }, ip: '203.0.113.0', action: 'workspace.member_role_changed', target: { type: 'workspace', id: 'ws1' }, before: { role: 'editor' }, after: { role: 'viewer' }, details: { affectedUserId: 2 } },
      { id: 10, at: '2026-11-08T10:00:00.000Z', actor: { id: 5, name: null }, ip: null, action: 'custom.unknown_action', target: { type: 'doc', id: 'd1' }, before: null, after: null, details: null }
    ],
    nextBefore: 10,
    retentionDays: 730
  }
})

afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  queries.length = 0
})

/** The order of the date field's editable parts (Nuxt UI orders them by locale). */
function segmentOrder(w: Wrapper): string[] {
  return w.get('[data-testid="workspace-audit-from"]')
    .findAll('[role="spinbutton"]')
    .map((segment: { attributes: (name: string) => string | undefined }) => segment.attributes('data-reka-date-field-segment') ?? '')
}

describe('WorkspaceAuditPanel', () => {
  it('lists events readably, opens details, pages with the cursor', async () => {
    const w = await mountSuspended(WorkspaceAuditPanel, { props: { workspaceId: 'ws1' } })
    mounted.push(w)
    await vi.waitFor(() => expect(w.find('[data-testid="workspace-audit-event-11"]').exists()).toBe(true))
    const first = w.get('[data-testid="workspace-audit-event-11"]').text()
    expect(first).toContain('Role changed')
    // A change event says what changed, in the reader's words.
    expect(w.get('[data-testid="workspace-audit-event-11"] [data-testid="workspace-audit-change"]').text()).toBe('Editor → Viewer')
    expect(w.find('[data-testid="workspace-audit-event-10"] [data-testid="workspace-audit-change"]').exists()).toBe(false)
    expect(first).toContain('Maya Chen')
    expect(first).toContain('203.0.113.0')
    // Unknown action: shown as is; a deleted actor is "Deleted user".
    expect(w.get('[data-testid="workspace-audit-event-10"]').text()).toContain('custom.unknown_action')
    expect(w.get('[data-testid="workspace-audit-event-10"]').text()).toContain('Deleted user')
    expect(w.text()).toContain('730 days')

    await w.get('[data-testid="workspace-audit-event-11"] button').trigger('click')
    expect(w.get('[data-testid="workspace-audit-details"]').text()).toContain('"role": "viewer"')

    await w.get('[data-testid="workspace-audit-more"]').trigger('click')
    await vi.waitFor(() => expect(w.find('[data-testid="workspace-audit-event-9"]').exists()).toBe(true))
    expect(queries.at(-1)).toMatchObject({ before: '10' })
    expect(w.get('[data-testid="workspace-audit-event-9"]').text()).toContain('Member deprovisioned')
    expect(w.find('[data-testid="workspace-audit-more"]').exists()).toBe(false)
  })

  it('export links carry the format', async () => {
    const w = await mountSuspended(WorkspaceAuditPanel, { props: { workspaceId: 'ws1' } })
    mounted.push(w)
    await vi.waitFor(() => expect(w.find('[data-testid="workspace-audit-event-11"]').exists()).toBe(true))
    expect(w.get('[data-testid="workspace-audit-export-csv"]').attributes('href')).toBe('/api/workspaces/ws1/audit/export?format=csv')
    expect(w.get('[data-testid="workspace-audit-export-jsonl"]').attributes('href')).toBe('/api/workspaces/ws1/audit/export?format=jsonl')
    // Both downloads are the same kind of control.
    const classes = (id: string) => w.get(`[data-testid="${id}"]`).classes().sort().join(' ')
    expect(classes('workspace-audit-export-jsonl')).toBe(classes('workspace-audit-export-csv'))
  })

  it('the date fields follow the UI language, not the browser', async () => {
    const w = await mountSuspended(WorkspaceAuditPanel, { props: { workspaceId: 'ws1' } })
    mounted.push(w)
    await vi.waitFor(() => expect(w.find('[data-testid="workspace-audit-event-11"]').exists()).toBe(true))
    // English UI: month, day, year.
    expect(segmentOrder(w)).toEqual(['month', 'day', 'year'])

    // German UI: day, month, year, whatever the browser's language is.
    const i18n = useNuxtApp().$i18n
    await i18n.setLocale('de')
    try {
      await vi.waitFor(() => expect(segmentOrder(w)).toEqual(['day', 'month', 'year']))
    } finally {
      await i18n.setLocale('en')
    }
  })
})
