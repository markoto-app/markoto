import { defineConfig, devices } from '@playwright/test'

// Project per (locale × theme × form-factor). Each flow runs FOUR
// times — light/dark × desktop/mobile — so docs render screenshots
// matching the reader's color mode AND device. Mobile capture also
// doubles as a responsive-design smoke test: if a flow can't drive
// the UI at 390px wide, we find out before users do.
//
// Naming: `<locale>-<theme>-<form>` (e.g. `en-light-desktop`,
// `en-dark-mobile`). The fixture reads `project.metadata.{locale,
// variant}` and writes to tests/e2e/output/flows/<slug>/<locale>/
// <variant>/. `variant` is the composite `<theme>-<form>` string.
//
// CI defaults to `--project=en-light-desktop` for speed; the docs
// publish pipeline runs `bun run flows:test` (hermetic — brings up
// infra + prod build via scripts/flows-ephemeral.ts) which executes
// ALL projects (sequential within, since they share the dev server).

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000'

// Desktop viewport. The docs site caps embedded flows at ~1100px
// wide; capturing at 1280 keeps the downscaled UI legible (16px text
// → ~14px displayed) and sits well above the 640px mobile breakpoint.
const DESKTOP_VP = { width: 1280, height: 800 }

// Mobile viewport — 390×720. Width matches iPhone 14 (so the app's
// mobile branch fires below the 640px breakpoint), but the height
// is intentionally shorter than iPhone 14's full 844 so the captured
// frames fit on real phones when readers browse the docs from their
// device. At 844 the slideshow's aspect ratio nearly matched the
// reader's own viewport and they had to scroll to see the bottom of
// each shot. 390×720 leaves enough headroom for the docs-page chrome
// (topbar, breadcrumb) AND the slideshow controls below the frame.
//   • `isMobile: true` + `hasTouch: true` switches Chromium's UA and
//     pointer model so touch-only behaviors trigger as they would
//     on a real device.
const MOBILE_VP = { width: 390, height: 720 }

export default defineConfig({
  testDir: './tests/e2e/flows',
  // Honour the leading-underscore convention for throwaway / scratch
  // specs (e.g. `_inspect-mermaid.spec.ts` — diagnostics that are
  // useful to keep around but shouldn't run on every flow build).
  testIgnore: '**/_*.spec.ts',
  timeout: 120_000,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: BASE_URL,
    video: 'off',
    trace: 'on-first-retry',
    permissions: ['clipboard-read', 'clipboard-write']
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: 'bun run dev',
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000
      },
  projects: [
    {
      name: 'en-light-desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: DESKTOP_VP,
        locale: 'en-US',
        colorScheme: 'light'
      },
      metadata: { locale: 'en', variant: 'light-desktop' }
    },
    {
      name: 'en-dark-desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: DESKTOP_VP,
        locale: 'en-US',
        colorScheme: 'dark'
      },
      metadata: { locale: 'en', variant: 'dark-desktop' }
    },
    {
      name: 'en-light-mobile',
      use: {
        ...devices['Desktop Chrome'],
        viewport: MOBILE_VP,
        isMobile: true,
        hasTouch: true,
        locale: 'en-US',
        colorScheme: 'light'
      },
      metadata: { locale: 'en', variant: 'light-mobile' }
    },
    {
      name: 'en-dark-mobile',
      use: {
        ...devices['Desktop Chrome'],
        viewport: MOBILE_VP,
        isMobile: true,
        hasTouch: true,
        locale: 'en-US',
        colorScheme: 'dark'
      },
      metadata: { locale: 'en', variant: 'dark-mobile' }
    }
    // Add a new locale by duplicating all four blocks — each writes
    // to its own tests/e2e/output/flows/<slug>/<locale>/<variant>/.
  ]
})
