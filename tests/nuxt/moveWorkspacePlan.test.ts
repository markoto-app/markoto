// @vitest-environment nuxt
import { describe, it, expect, afterEach, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mountSuspended, mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { DocumentMoveWorkspaceModal } from '#components'

// Moving a document out of a Team / Business workspace: the modal
// warns that the doc's features then follow the new place's plan, but
// only on a step down (Business → Team, or out of any plan).

// The workspace list is the signed-in caller's (a session-gated query).
mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(true),
  user: ref({ id: 1, name: 'Maya' }),
  session: ref({}),
  fetch: vi.fn(),
  clear: vi.fn()
}))

registerEndpoint('/api/user/workspaces', () => [
  { workspaceId: 'ws-biz', name: 'Acme', role: 'admin', plan: 'business' },
  { workspaceId: 'ws-team', name: 'Studio', role: 'editor', plan: 'team' },
  { workspaceId: 'ws-free', name: 'Side project', role: 'admin', plan: null }
])

type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const mounted: Wrapper[] = []

afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  document.body.innerHTML = ''
})

async function mountModal(currentWorkspaceId: string | null): Promise<void> {
  // The modal loads its workspaces when it opens, like in the editor.
  const open = ref(false)
  const Host = defineComponent({
    setup() {
      return () => h(DocumentMoveWorkspaceModal, {
        'docId': 'doc1',
        'docTitle': 'Report',
        currentWorkspaceId,
        'open': open.value,
        'onUpdate:open': (v: boolean) => { open.value = v }
      })
    }
  })
  mounted.push(await mountSuspended(Host, { attachTo: document.body }))
  open.value = true
  await vi.waitFor(() => {
    if (!findButton('Side project')) throw new Error('workspaces not loaded')
  })
}

function findButton(name: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll('button')).find(b => b.textContent?.includes(name))
}

async function pick(name: string): Promise<void> {
  findButton(name)?.click()
  await flushPromises()
}

function warning(): string | null {
  return document.body.querySelector('[data-testid="move-leaves-plan"]')?.textContent ?? null
}

describe('MoveWorkspaceModal — leaving a plan', () => {
  it('warns when a doc leaves a Business workspace for one without a plan, or for Team', async () => {
    await mountModal('ws-biz')
    expect(warning()).toBeNull()
    await pick('Side project')
    expect(warning()).toContain('Business')
    await pick('Studio')
    expect(warning()).toContain('Business')
    await pick('Personal')
    expect(warning()).toContain('Business')
  })

  it('says nothing for a step up, or when the doc is not in a paid workspace', async () => {
    await mountModal('ws-team')
    await pick('Acme')
    expect(warning()).toBeNull()
  })

  it('says nothing when the doc is personal', async () => {
    await mountModal(null)
    await pick('Side project')
    expect(warning()).toBeNull()
  })
})
