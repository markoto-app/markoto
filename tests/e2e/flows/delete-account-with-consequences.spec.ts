import { test, expect } from '../fixtures/flow'
import { Pool } from 'pg'
import { PRIVACY_VERSION, TOS_VERSION, DPA_VERSION } from '../../../shared/legal/versions'

// Tier 1 (Privacy): "Delete your account, with the consequences spelled out".
//
// User-job: a user wants to leave the platform. GDPR Article 17
// gives them the right to be forgotten; markoto's job is to make
// the consequences LEGIBLE before they confirm — which workspaces
// will be cascade-deleted, which will get a new admin (named),
// which docs go away with their content, which comments survive
// anonymised. After confirmation a 30-day grace banner appears
// across every page; the cascade itself runs as a background
// sweeper once the grace window elapses.
//
// What this flow IS: the canonical privacy-feature flow. A
// compliance reviewer landing here sees the entire deletion-request
// UX — the policies the user has accepted, the consequence preview
// with workspaces named, the typing gate, the grace banner, the
// one-click cancel — without having to assemble it from screenshots.
//
// What this flow IS NOT: the cascade itself. Once the grace ends,
// the sweeper runs offline (per-user advisory-locked, idempotent at
// the row level). That mechanism is covered by the repos test
// suite; surfacing it in a flow would mean fast-forwarding the
// 30-day clock, which doesn't add user-facing value.
//
// Single-actor flow. The story is "one user navigating their
// own settings"; spawning a second context wouldn't gain narrative.
//
// Runs on both desktop and mobile project variants — the profile
// page is responsive (mobile dl-rows stack label-above-value), the
// grace banner has a compact mobile mode (icon + short date + cancel
// button only), and the consequence modal stacks its CTA buttons
// vertically on mobile. Avatar dropdown opens via touch on the
// mobile topbar same as desktop.

test('Delete account with consequences', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  // Seed: Alice with two workspaces of contrasting fate
  // Two workspaces is the minimum that makes the consequence preview
  // tell a story:
  //   1. "Personal notes" — Alice is the sole member. Cascade-delete
  //      on her account deletion. Demonstrates "your sole-member
  //      workspaces will be removed".
  //   2. "Engineering library" — Alice + Bob both admin. On her
  //      deletion, Bob is auto-promoted (or stays admin, with
  //      provenance ownership repointed to him). Demonstrates "co-
  //      member workspaces survive; we name the receiving admin".
  // Three workspaces would make the modal scroll and bury the hero;
  // two is enough to land both fates side-by-side.
  const pool = new Pool({
    connectionString: 'postgres://ypad:testpassword@localhost:5433/ypad_test',
    max: 1
  })

  let aliceUserId: number
  let bobUserId: number
  let wsSoloId: string
  let wsCoadminId: string
  const wsSoloName = 'Personal notes'
  const wsCoadminName = 'Engineering library'

  try {
    async function insertUser(name: string): Promise<number> {
      // Seed onboarding columns so the OnboardingGate modal doesn't
      // block the app shell (it's overlay-rendered above the topbar
      // and intercepts every avatar/menu click). Same shape as
      // `Editor.loginAsTestUser`. Versions read from
      // `shared/legal/versions.ts` so a future bump can't desync the
      // gate's "needs re-acceptance" check from this seed.
      const r = await pool.query<{ id: number }>(
        `INSERT INTO users (
           github_id, name, email, locale, plan,
           age_confirmed_at,
           privacy_version_accepted, privacy_version_accepted_locale,
           tos_version_accepted, tos_version_accepted_locale,
           dpa_version_accepted, dpa_version_accepted_locale
         )
         VALUES ($1, $2, $6, 'en', 'free', NOW(), $3, 'en', $4, 'en', $5, 'en')
         ON CONFLICT (github_id) DO UPDATE SET
           name = EXCLUDED.name,
           age_confirmed_at = EXCLUDED.age_confirmed_at,
           privacy_version_accepted = EXCLUDED.privacy_version_accepted,
           privacy_version_accepted_locale = EXCLUDED.privacy_version_accepted_locale,
           tos_version_accepted = EXCLUDED.tos_version_accepted,
           tos_version_accepted_locale = EXCLUDED.tos_version_accepted_locale,
           dpa_version_accepted = EXCLUDED.dpa_version_accepted,
           dpa_version_accepted_locale = EXCLUDED.dpa_version_accepted_locale
         RETURNING id`,
        // A real-looking address + language: the profile page shows both.
        [`flow-priv-${name.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name, PRIVACY_VERSION, TOS_VERSION, DPA_VERSION, `${name.toLowerCase()}@studio.example`]
      )
      return r.rows[0].id
    }
    async function insertWorkspace(ownerId: number, name: string): Promise<string> {
      const wsId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      await pool.query(
        `INSERT INTO workspaces (workspace_id, owner_id, name) VALUES ($1, $2, $3)`,
        [wsId, ownerId, name]
      )
      await pool.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`,
        [wsId, ownerId]
      )
      return wsId
    }
    async function addAdmin(wsId: string, userId: number): Promise<void> {
      await pool.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'admin'`,
        [wsId, userId]
      )
    }

    aliceUserId = await insertUser('Alice')
    bobUserId = await insertUser('Bob')
    wsSoloId = await insertWorkspace(aliceUserId, wsSoloName)
    wsCoadminId = await insertWorkspace(aliceUserId, wsCoadminName)
    await addAdmin(wsCoadminId, bobUserId)
  } finally {
    await pool.end()
  }

  await editor.page.loginAsExistingUser(aliceUserId, 'Alice')

  // Open from the dashboard so the avatar menu is the entry point —
  // mirrors how a real user would navigate, not a deep-link.
  await page.goto('/')

  // Chapter 1: Open your profile
  await flow.heading('Open your profile', 3)
  await flow.narrate(
    'Your profile page lives under your avatar in the topbar. It is '
    + 'one page covering your account, your data (export + download), '
    + 'account deletion, and the legal record of policies you have '
    + 'accepted.'
  )

  const avatarButton = page.locator('[data-testid="user-menu-trigger"]')
  await flow.click(
    'Click your avatar',
    avatarButton,
    {
      result: 'A menu opens — Profile is the one you want.',
      // Menu-item selector falls back to getByRole+name (tests/e2e/AGENTS.md
      // selector preference) — Nuxt UI's UDropdownMenu items array doesn't
      // accept per-item data-testid declaratively. Same pattern as
      // delete-document.spec.ts uses for File-menu items.
      after: () => page.getByRole('menuitem', { name: /profile/i }).first().waitFor({ state: 'visible' })
    }
  )

  await flow.click(
    'Click "Profile"',
    page.getByRole('menuitem', { name: /profile/i }).first(),
    {
      annotations: [
        { label: 'profile', selector: 'role=menuitem[name=/profile/i]', kind: 'arrow' }
      ],
      result: 'Your profile page opens — account info, your data (export), the delete-account zone, and the legal record of accepted policies.',
      after: () => page.waitForURL(/\/settings\/profile/)
    }
  )

  // Page sentinel — the delete button depends on the account-status
  // fetch, so its visibility means the page is fully hydrated.
  await page.locator('[data-testid="delete-account-button"]').waitFor({ state: 'visible', timeout: 10_000 })

  // ─── Chapter 2: See your accepted policies (transparency anchor) ─
  await flow.heading('See what you have accepted', 3)
  await flow.narrate(
    'Before doing anything destructive, the page shows you which '
    + 'version of the Privacy Policy, Terms of Service, and Data '
    + 'Processing Addendum you accepted, and in which language. If '
    + 'we update any document materially we bump its version, you '
    + 'see "needs re-acceptance" here, and we re-prompt before any '
    + 'further action — so the consent record is never out of date.'
  )

  await flow.shot(
    'The Legal section is the audit trail you have with markoto. '
    + 'Every signed-in user can read it directly — no support ticket '
    + 'required.',
    {
      annotations: [
        { label: 'legal record', selector: '[data-testid="profile-legal-section"]', kind: 'box' }
      ]
    }
  )

  // Chapter 3: Open the consequence preview
  await flow.heading('Preview the consequences', 3)
  await flow.narrate(
    'Account deletion is irreversible after the 30-day grace window '
    + 'ends. So before you confirm, markoto shows exactly what will '
    + 'happen: which workspaces are cascade-deleted because you are '
    + 'the only member, which ones auto-promote a co-admin (named, '
    + 'so you can verify), which comments are anonymised on other '
    + 'people\'s docs, what gets retained for legal reasons. The '
    + 'modal makes the destructive action legible before it runs.'
  )

  await flow.click(
    'Click "Request account deletion"',
    page.locator('[data-testid="delete-account-button"]'),
    {
      result: 'The modal lists every workspace by name and what will happen to it: '
        + 'deleted along with you (you are its only member), or handed to a named '
        + 'member who becomes admin.',
      after: async () => {
        await page.locator('[data-testid="deletion-consequences-modal"]').waitFor({ state: 'visible', timeout: 5_000 })
        await page.locator('[data-testid="ws-cascade-block"]').waitFor({ state: 'visible', timeout: 10_000 })
        await page.locator('[data-testid="ws-promote-block"]').waitFor({ state: 'visible', timeout: 5_000 })
      },
      highlights: [
        { label: 'deleted with you', selector: '[data-testid="ws-cascade-block"]' },
        { label: 'gets a new admin', selector: '[data-testid="ws-promote-block"]' }
      ]
    }
  )

  await page.locator('[data-testid="ws-cascade-block"]').waitFor({ state: 'visible', timeout: 10_000 })
  await page.locator('[data-testid="ws-promote-block"]').waitFor({ state: 'visible', timeout: 5_000 })

  // Asserts — the modal renders both fates with the right names.
  // Acts as the spec: a future refactor that drops the workspace
  // name from the preview would fail here.
  const cascadeBlock = page.locator('[data-testid="ws-cascade-block"]')
  await expect(cascadeBlock).toContainText(wsSoloName)
  const promoteBlock = page.locator('[data-testid="ws-promote-block"]')
  await expect(promoteBlock).toContainText(wsCoadminName)
  await expect(promoteBlock).toContainText('Bob')

  // Chapter 4: Read the named consequences
  await flow.heading('Read the named consequences', 3)
  await flow.narrate(
    'Every workspace and every new admin is named. Want to keep a '
    + 'workspace that would be deleted? Close the modal, invite a '
    + 'co-admin to it first, and come back: it moves into the "new '
    + 'admin" group. Nothing is lost by accident, and nobody is surprised.'
  )

  // Chapter 5: Type the confirm phrase
  await flow.heading('Type the phrase to confirm', 3)
  await flow.narrate(
    'The destructive button is gated behind a phrase you have to '
    + 'type. Same shape as GitHub repo deletion or AWS account '
    + 'closure — irreversible actions should never be one click '
    + 'away. The button stays disabled until your input matches '
    + '"delete my account" exactly.'
  )

  const confirmInput = page.locator('[data-testid="deletion-confirm-input"]')
  await flow.type(
    'Type "delete my account"',
    confirmInput,
    'delete my account',
    { result: 'The Schedule deletion button enables.' }
  )

  // Chapter 6: Submit → grace banner takes over
  await flow.heading('Submit — the grace banner takes over', 3)
  await flow.narrate(
    'The 30-day grace clock starts. Until it elapses, a banner sits '
    + 'pinned across the top of every page in markoto with a one-click '
    + 'cancel. The page itself flips into "scheduled for deletion" '
    + 'state too — same cancel button, same date. Either path '
    + 'restores your account exactly as it was.'
  )

  await flow.click(
    'Click "Schedule deletion"',
    page.locator('[data-testid="deletion-confirm-submit"]'),
    {
      result: 'The modal closes; the delete-account section now says your account is scheduled for deletion, with the date and a Cancel button.',
      after: async () => {
        await page.locator('[data-testid="deletion-grace-banner"]').waitFor({ state: 'visible', timeout: 10_000 })
        await page.locator('[data-testid="deletion-pending-card"]').waitFor({ state: 'visible', timeout: 5_000 })
      }
    }
  )

  // The click left the page scrolled down at the delete section; the
  // banner pins to the top of the page. Scroll up so the hero frame
  // shows it.
  await page.evaluate(() => window.scrollTo(0, 0))
  await expect(page.locator('[data-testid="deletion-grace-banner"]')).toBeInViewport()
  // The "scheduled" toast sits on top of the banner's Cancel button.
  await editor.page.dismissToasts()

  await flow.shot(
    'Top of every page for the next 30 days: the grace banner, with '
    + 'the deletion date and a one-click cancel.',
    {
      hero: true,
      highlights: [
        { label: 'grace banner (every page)', selector: '[data-testid="deletion-grace-banner"]' }
      ]
    }
  )

  // Chapter 7: Cancel — restored to normal
  await flow.heading('Change your mind? Cancel from the banner', 3)
  await flow.narrate(
    'During the grace window you can cancel from any page — click '
    + '"Cancel deletion" in the banner and the deletion request is '
    + 'cleared on the spot. No data lost, no collaborators surprised. '
    + 'Your account is back to the state it was in before the click.'
  )

  const cancelBtn = page.locator('[data-testid="grace-banner-cancel"]')
  await flow.click(
    'Click "Cancel deletion" in the banner',
    cancelBtn,
    {
      result: 'The banner disappears and your account is back to normal — nothing was deleted.',
      after: () => page.locator('[data-testid="deletion-grace-banner"]').waitFor({ state: 'detached', timeout: 5_000 })
    }
  )

  await expect(page.locator('[data-testid="deletion-pending-card"]')).toBeHidden()
  await expect(page.locator('[data-testid="delete-account-button"]')).toBeVisible()

  // Reference seeds so eslint doesn't flag them; they're load-
  // bearing in the assertions above.
  expect(wsSoloId).toBeTruthy()
  expect(wsCoadminId).toBeTruthy()

  flow.next({
    slug: 'data-export',
    why: 'Want a copy of your work first? Export everything as a ZIP before you delete'
  })
})
