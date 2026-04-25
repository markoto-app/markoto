import { defineConfig, devices } from '@playwright/test'

// One Playwright project per locale we want screenshots for. Each project
// sets FLOW_LOCALE so the fixture writes to the right subdirectory.
//
// Add a new locale: copy a project block, update `name` + `FLOW_LOCALE` +
// `extraHTTPHeaders`/`storageState` if locale switching needs auth.
//
// CI runs `--project=en` only by default; the docs publish pipeline runs
// `bun run flows:test` which executes ALL projects in parallel.

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000'

// Pinned viewport. Full HD so screenshots embedded in docs look sharp on
// retina displays and remain readable when the docs container narrows.
// Same dimensions for every locale so cursor coordinates stay comparable;
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
  // race over the shared output directory. Across projects (locales) we
  // do parallelise — they write to different subdirs.
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: BASE_URL,
    viewport: VIEWPORT,
    // Force a stable color scheme so light/dark variants don't drift
    // between runs. If you want both, add separate projects.
    colorScheme: 'light',
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
      name: 'en',
      use: {
        ...devices['Desktop Chrome'],
        viewport: VIEWPORT,
        // Locale is set via the `ypad_locale` cookie at test startup
        // (see fixture). We do NOT use storageState here because that
        // pre-seeds the cookie jar empty-aside-from-locale and clobbers
        // any session cookie the app might depend on later.
        locale: 'en-US'
      },
      metadata: { locale: 'en' }
    },
    // Uncomment + duplicate per locale to add more languages. Each gets
    // its own subdir under tests/e2e/output/flows/<slug>/<locale>/.
    // {
    //   name: 'de',
    //   use: {
    //     ...devices['Desktop Chrome'],
    //     viewport: VIEWPORT,
    //     storageState: {
    //       cookies: [{ name: 'ypad_locale', value: 'de', /* ... */ }],
    //       origins: []
    //     }
    //   },
    //   metadata: { locale: 'de' }
    // }
  ]
})
