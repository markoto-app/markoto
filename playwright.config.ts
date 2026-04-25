import { defineConfig, devices } from '@playwright/test'

// Project per (locale × variant). Each project records the same flow
// twice (light + dark) so the docs site can render screenshots that
// match the reader's chosen color mode without showing a jarring
// theme mismatch.
//
// Naming: `<locale>-<variant>` (e.g. `en-light`, `de-dark`). The
// fixture reads project.metadata.{locale,variant} and writes to
// tests/e2e/output/flows/<slug>/<locale>/<variant>/.
//
// CI runs `--project=en-light` only by default for speed; the docs
// publish pipeline runs `bun run flows:test` which executes ALL
// projects (parallel across locales/variants since they write to
// different subdirs).

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000'

// Pinned viewport. Full HD so screenshots embedded in docs look sharp on
// retina displays and remain readable when the docs container narrows.
// Same dimensions for every project so cursor coordinates stay comparable;
// the manifest carries it explicitly so the consumer doesn't need to know.
// Bump in lockstep across config + fixture default + FlowFrame fallback.
const VIEWPORT = { width: 1920, height: 1080 }

export default defineConfig({
  testDir: './tests/e2e/flows',
  // Flow tests are slower than unit tests (real browser, network-idle waits)
  // but should still fail fast — 60s per test is a generous ceiling.
  timeout: 60_000,
  retries: process.env.CI ? 2 : 0,
  // Sequential within a project so screenshots from concurrent tests don't
  // race over the shared output directory. Across projects we do
  // parallelise — they write to different subdirs.
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: BASE_URL,
    viewport: VIEWPORT,
    // Disable Playwright's video — the docs system has its own.
    video: 'off',
    // Trace on first retry only — debugging cursor/timing issues without
    // doubling CI cost on the happy path.
    trace: 'on-first-retry'
  },
  // Auto-spin the dev server if PLAYWRIGHT_BASE_URL isn't set externally.
  // Set `reuseExistingServer: true` so a dev server you already have
  // running gets reused (saves ~10s per local invocation).
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : {
    command: 'bun run dev',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  },
  projects: [
    {
      name: 'en-light',
      use: {
        ...devices['Desktop Chrome'],
        viewport: VIEWPORT,
        locale: 'en-US',
        // colorScheme sets prefers-color-scheme. Combined with the
        // fixture's localStorage init (sets nuxt-color-mode=light),
        // both sources of truth agree — the app renders light mode
        // even if @nuxtjs/color-mode's resolution order changes.
        colorScheme: 'light'
      },
      metadata: { locale: 'en', variant: 'light' }
    },
    {
      name: 'en-dark',
      use: {
        ...devices['Desktop Chrome'],
        viewport: VIEWPORT,
        locale: 'en-US',
        colorScheme: 'dark'
      },
      metadata: { locale: 'en', variant: 'dark' }
    }
    // Add a new locale by duplicating both blocks above — `de-light`
    // + `de-dark` etc. Each writes to its own
    // tests/e2e/output/flows/<slug>/<locale>/<variant>/ subdir.
  ]
})
