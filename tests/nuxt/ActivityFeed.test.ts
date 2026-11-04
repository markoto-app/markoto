// @vitest-environment nuxt
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import { CollabActivityFeed as ActivityFeed } from '#components'

// Component-level test for the Activity feed's per-row affordances.
//
// What it pins (and why each exists):
//
//   1. `restore`-row drawer mount. The component routes `restore` rows
//      through the SAME ActivityRowDiff drawer used for `edit` rows
//      (they both carry yjsDocIdBefore/After). When we shipped Tier 2
//      we added `restore` to `isExpandable()` but forgot the matching
//      branch in `expansionFor()` — the v-if then evaluated null and
//      the drawer silently never mounted. That class of regression is
//      exactly what this test catches: any future action kind whose
//      eligibility/render arms drift apart will fail here.
//
//   2. Restore button visibility gate. The Restore button rides on
//      `isRestorable()` which excludes pre-Tier-1 rows (yjsDocIdBefore
//      === null) and the read-only prop. The button is rendered as a
//      sibling of the expansion caret with `@click.stop` — clicks on
//      it must NOT toggle the row's expansion state. Both invariants
//      are easy to break during unrelated UI refactors.
//
//   3. `readOnly` prop hides the Restore button on every row. Mirrors
//      the prompt-bar's hidden-not-disabled approach for the same
//      reason (a disabled affordance teases an upgrade).

// $fetch is mocked via registerEndpoint per the project pattern. Each
// test sets `entriesResponse.current` before mount; the handler reads
// at request time so we don't have to re-register between tests.
interface ActivityEntry {
  id: number
  docId: string
  userId: number | null
  userName: string | null
  action: string
  wordCount: number | null
  linesAdded: number | null
  linesRemoved: number | null
  metadata: Record<string, unknown> | null
  yjsDocIdBefore: number | null
  yjsDocIdAfter: number | null
  // Server-enriched agent fields; null on human rows.
  actorPrincipal?: string | null
  actorAvatarSeed?: string | null
  agentKind?: 'ai' | 'mcp' | null
  createdAt: string
}

const entriesResponse: { current: ActivityEntry[] } = { current: [] }
registerEndpoint('/api/docs/doc-x/activity', () => entriesResponse.current)

// The diff drawer fetches /diff on mount when a row expands. We don't
// assert against its contents here (that's DiffView.test.ts's job) —
// we only need the request to resolve so the lazy-loaded async
// component finishes mounting. A minimal valid DiffResponse keeps the
// drawer in its happy "render hunks" state instead of an error
// branch (which still mounts, but pollutes wrapper.html() with extra
// strings that future assertions might trip on).
registerEndpoint('/api/docs/doc-x/activity/42/diff', () => ({
  activityId: 42,
  before: 'one\n',
  after: '',
  hunks: [
    {
      oldStart: 1, oldLines: 1, newStart: 1, newLines: 0,
      lines: [{ kind: 'remove', text: 'one' }]
    }
  ],
  truncated: false,
  totalHunks: 1
}))

mockNuxtImport('useToast', () => () => ({ add: vi.fn() }))

function makeRestoreEntry(over: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: 42,
    docId: 'doc-x',
    userId: 7,
    userName: 'Joel',
    action: 'restore',
    wordCount: null,
    linesAdded: null,
    linesRemoved: null,
    metadata: {
      kind: 'restore',
      restoredFromActivityId: 41,
      restoredFromTime: new Date(Date.now() - 60_000).toISOString()
    },
    yjsDocIdBefore: 100,
    yjsDocIdAfter: 110,
    createdAt: new Date().toISOString(),
    ...over
  }
}

beforeEach(() => {
  entriesResponse.current = []
})

// `useAsyncState` fires the fetch imperatively on mount (immediate:true)
// but the Promise resolves on the next macrotask — `await nextTick()`
// alone isn't enough. Helper that drains the microtask + macrotask
// queue until the loading flag flips and v-for has rendered the rows.
async function flushAsyncState() {
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 0))
    await nextTick()
  }
}

// More aggressive flush for `defineAsyncComponent` chains. The diff
// drawer's component-import + DiffView's diff-fetch + v-if flips
// settle over multiple macrotask boundaries.
async function flushDeep() {
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 0))
    await nextTick()
  }
}

describe('ActivityFeed — avatars', () => {
  it('gives a human row a generated avatar seeded by user id, and never an <img> from elsewhere', async () => {
    entriesResponse.current = [makeRestoreEntry({ id: 50, userId: 7, actorPrincipal: null, agentKind: null })]
    const wrapper = await mountSuspended(ActivityFeed, { props: { docId: 'doc-x' } })
    await flushAsyncState()
    const avatar = wrapper.find('[data-activity-id="50"] [data-testid="user-avatar"]')
    expect(avatar.attributes('data-avatar-seed')).toBe('u-7')
    for (const img of wrapper.findAll('[data-activity-id="50"] img')) {
      expect(img.attributes('src') ?? '').toMatch(/^data:image\/svg\+xml/)
    }
  })

  it('seeds an anonymous row by the editor\'s presence token, so two anonymous editors look different', async () => {
    entriesResponse.current = [
      makeRestoreEntry({ id: 52, userId: null, userName: null, action: 'edit', actorPrincipal: 'anonymous', agentKind: null, actorAvatarSeed: 'TokenAAAAAAAAAAA' }),
      makeRestoreEntry({ id: 53, userId: null, userName: null, action: 'edit', actorPrincipal: 'anonymous', agentKind: null, actorAvatarSeed: 'TokenBBBBBBBBBBB' })
    ]
    const wrapper = await mountSuspended(ActivityFeed, { props: { docId: 'doc-x' } })
    await flushAsyncState()
    // Same seed the PresenceBar derives from awareness `user.avatarSeed`.
    expect(wrapper.find('[data-activity-id="52"] [data-testid="user-avatar"]').attributes('data-avatar-seed')).toBe('a-TokenAAAAAAAAAAA')
    expect(wrapper.find('[data-activity-id="53"] [data-testid="user-avatar"]').attributes('data-avatar-seed')).toBe('a-TokenBBBBBBBBBBB')
  })

  it('falls back to the name seed for an anonymous row without a token (older rows)', async () => {
    entriesResponse.current = [makeRestoreEntry({ id: 54, userId: null, userName: null, action: 'edit', actorPrincipal: 'anonymous', agentKind: null, actorAvatarSeed: null })]
    const wrapper = await mountSuspended(ActivityFeed, { props: { docId: 'doc-x' } })
    await flushAsyncState()
    expect(wrapper.find('[data-activity-id="54"] [data-testid="user-avatar"]').attributes('data-avatar-seed')).toMatch(/^x-/)
  })

  it('keeps the seal disc for an AI row', async () => {
    entriesResponse.current = [makeRestoreEntry({ id: 51, userId: null, userName: 'markoto', action: 'edit', actorPrincipal: 'ai:assistant:s1', agentKind: 'ai' })]
    const wrapper = await mountSuspended(ActivityFeed, { props: { docId: 'doc-x' } })
    await flushAsyncState()
    const card = wrapper.find('[data-activity-id="51"]')
    expect(card.find('[data-testid="user-avatar"]').exists()).toBe(false)
    expect(card.find('.mk-seal').exists()).toBe(true)
  })
})

describe('ActivityFeed — restore-row affordances', () => {
  it('renders both the View change caret and the Restore button on a restore row', async () => {
    entriesResponse.current = [makeRestoreEntry()]
    const wrapper = await mountSuspended(ActivityFeed, { props: { docId: 'doc-x' } })

    // useAsyncState fires immediately + microtask resolves the registered
    // endpoint synchronously inside the same tick. Two `nextTick`s
    // settles both the fetch resolution and the v-for re-render.
    await flushAsyncState()

    const card = wrapper.find('[data-activity-id="42"]')
    expect(card.exists()).toBe(true)

    // The chevron-down icon is the View-change toggle. Pin its presence
    // via the icon name string (Lucide names are stable).
    expect(card.html()).toContain('i-lucide:chevron-down')

    // Restore button — has the title attribute we i18n'd for the tooltip.
    // Using the title attribute (rather than the visible label) is more
    // robust to surrounding whitespace + line-clamp truncation.
    const restoreBtn = card.find('button[title]')
    expect(restoreBtn.exists()).toBe(true)
    expect(restoreBtn.html()).toContain('i-lucide:history')
  })

  it('clicking the card toggles data-expanded and mounts the diff drawer', async () => {
    entriesResponse.current = [makeRestoreEntry()]
    const wrapper = await mountSuspended(ActivityFeed, { props: { docId: 'doc-x' } })
    await flushAsyncState()

    const card = wrapper.find('[data-activity-id="42"]')
    expect(card.attributes('data-expanded')).toBe('false')

    await card.trigger('click')
    await nextTick()

    expect(card.attributes('data-expanded')).toBe('true')

    await flushDeep()

    // The drawer's container is the v-if-gated div with the
    // `border-t bg-muted/30` classes. It only renders when
    // `expansionFor(entry)` returns non-null AND `isExpanded(entry)`
    // is true. THIS is the regression target: the original Tier 2
    // bug added `restore` to `isExpandable` but forgot the matching
    // `expansionFor` branch — the drawer host div never mounted.
    // Asserting on the host (and not the lazy ActivityRowDiff inner
    // content) keeps the test independent of the async-import timing
    // and the /diff endpoint behaviour, which have their own tests.
    const drawer = card.find('.border-t')
    expect(drawer.exists()).toBe(true)
  })

  it('clicking the Restore button does NOT toggle expansion (click.stop)', async () => {
    entriesResponse.current = [makeRestoreEntry()]
    const wrapper = await mountSuspended(ActivityFeed, { props: { docId: 'doc-x' } })
    await flushAsyncState()

    const card = wrapper.find('[data-activity-id="42"]')
    expect(card.attributes('data-expanded')).toBe('false')

    const restoreBtn = card.find('button[title]')
    await restoreBtn.trigger('click')
    await nextTick()

    // Click on the restore button MUST stop propagation. If a future
    // refactor drops `@click.stop`, the card would expand on every
    // restore click — visually weird and tracked as a regression here.
    expect(card.attributes('data-expanded')).toBe('false')
  })

  it('hides the Restore button when readOnly is true', async () => {
    entriesResponse.current = [makeRestoreEntry()]
    const wrapper = await mountSuspended(ActivityFeed, {
      props: { docId: 'doc-x', readOnly: true }
    })
    await flushAsyncState()

    const card = wrapper.find('[data-activity-id="42"]')
    expect(card.exists()).toBe(true)
    // The View-change caret stays — read-only viewers can still inspect
    // diffs, they just can't apply restores.
    expect(card.html()).toContain('i-lucide:chevron-down')
    // No restore button. We pin via the title attribute (the only
    // button[title] on the card).
    expect(card.find('button[title]').exists()).toBe(false)
  })

  it('hides the Restore button when yjsDocIdBefore is null (pre-Tier-1 row)', async () => {
    // A `restore` row without a boundary id couldn't be restored — the
    // endpoint would 410. Hiding the button matches the prompt-bar's
    // hidden-not-disabled rule.
    entriesResponse.current = [makeRestoreEntry({ yjsDocIdBefore: null })]
    const wrapper = await mountSuspended(ActivityFeed, { props: { docId: 'doc-x' } })
    await flushAsyncState()

    const card = wrapper.find('[data-activity-id="42"]')
    expect(card.exists()).toBe(true)
    expect(card.find('button[title]').exists()).toBe(false)
  })

  it('still renders the View-change caret when yjsDocIdBefore is null (drawer is the value)', async () => {
    // Tier 1 (View change) gracefully degrades on null-boundary rows
    // (the drawer shows "Diff unavailable") — the affordance is still
    // useful UI. This invariant catches accidental coupling between
    // the restore gate and the diff gate.
    entriesResponse.current = [makeRestoreEntry({ yjsDocIdBefore: null })]
    const wrapper = await mountSuspended(ActivityFeed, { props: { docId: 'doc-x' } })
    await flushAsyncState()

    const card = wrapper.find('[data-activity-id="42"]')
    expect(card.html()).toContain('i-lucide:chevron-down')
  })

  it('an `edit` row also routes through the same diff drawer', async () => {
    // Sanity check that edits still work after the restore branch was
    // bolted on. If someone restructures `expansionFor()` and breaks
    // the edit branch, this fails alongside the restore tests.
    const editRow: ActivityEntry = {
      id: 42,
      docId: 'doc-x',
      userId: 7,
      userName: 'Joel',
      action: 'edit',
      wordCount: 42,
      linesAdded: 3,
      linesRemoved: 1,
      metadata: null,
      yjsDocIdBefore: 100,
      yjsDocIdAfter: 110,
      createdAt: new Date().toISOString()
    }
    entriesResponse.current = [editRow]
    const wrapper = await mountSuspended(ActivityFeed, { props: { docId: 'doc-x' } })
    await flushAsyncState()

    const card = wrapper.find('[data-activity-id="42"]')
    await card.trigger('click')
    await flushDeep()

    expect(card.attributes('data-expanded')).toBe('true')
    expect(card.find('.border-t').exists()).toBe(true)
  })
})
