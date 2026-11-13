import { defineConfig, devices } from '@playwright/test'
import { EDITOR_TOUR_DONE, EDITOR_TOUR_STORAGE_KEY } from '../../app/utils/editor/editorTour'

// Staging/prod SMOKE suite: deliberately separate from the flow-docs
// system (playwright.config.ts). Flows need TEST_MODE (login shim, AI
// mocks, /api/_test/*); smoke runs the PUBLIC/anonymous surface against a
// REAL deployed environment (prod-parity, no test hooks). It exists to
// catch the class of prod-only drift the flow gate structurally can't:
// Docker-image COPY gaps, insecure-context APIs, CSP, the mobile <dialog>
// collapse: every bug that shipped broken this session.
//
// Target any environment via PLAYWRIGHT_BASE_URL (defaults to staging).
//   bun run smoke                                  # → staging
//   PLAYWRIGHT_BASE_URL=https://markoto.app bun run smoke   # → prod
//
// No webServer: smoke ALWAYS runs against an already-running deployment.
// Desktop specs are *.spec.ts; mobile specs are *.mobile.spec.ts and run
// only on the touch/390px project (the drawer regression is mobile-only).

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'https://staging.markoto.app'

export default defineConfig({
  testDir: '.',
  // Artifacts in the gitignored root dir, with the other Playwright runs'.
  outputDir: '../../test-results',
  // Creates the run's two shared anonymous documents once (hosted
  // anonymous creation is rate-limited per network; specs + retries
  // reuse them). See tests/smoke/globalSetup.ts.
  globalSetup: './globalSetup.ts',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  // Retry once (twice in CI), smoke runs against a live network + the
  // renderer/sync have real latency; a transient blip shouldn't red the
  // whole gate, but a genuine break fails every retry.
  retries: process.env.CI ? 2 : 1,
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    video: 'off',
    // The editor's first-run tour counts as seen (app/utils/editor/editorTour.ts):
    // its popover would sit over the controls the specs click.
    storageState: {
      cookies: [],
      origins: [{ origin: new URL(BASE_URL).origin, localStorage: [{ name: EDITOR_TOUR_STORAGE_KEY, value: EDITOR_TOUR_DONE }] }]
    }
  },
  projects: [
    {
      name: 'smoke-desktop',
      testIgnore: '**/*.mobile.spec.ts',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } }
    },
    {
      name: 'smoke-mobile',
      testMatch: '**/*.mobile.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 720 },
        isMobile: true,
        hasTouch: true
      }
    }
  ]
})
