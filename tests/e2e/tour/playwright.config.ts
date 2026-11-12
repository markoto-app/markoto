import { defineConfig, devices } from '@playwright/test'

// Product-tour captures — NOT a test suite. Drives the real app on
// the flow stack and records the stills / frame sequences the product
// page at `/` plays (tests/e2e/tour/*.capture.ts → tests/e2e/output/tour/
// → `bun scripts/capture-tour.ts` encodes them into public/tour/).
//
// 1440×900 at deviceScaleFactor 2: stills stay sharp on retina screens
// and when phones show an enlarged focus crop. One project per color
// mode; `metadata.variant` keeps the shared flow fixture happy.

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://markoto.localhost:3001'
const VIEWPORT = { width: 1440, height: 900 }

export default defineConfig({
  testDir: '.',
  // Artifacts in the gitignored root dir, with the other Playwright runs'.
  outputDir: '../../../test-results',
  testMatch: '**/*.capture.ts',
  timeout: 360_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    video: 'off',
    trace: 'off',
    permissions: ['clipboard-read', 'clipboard-write']
  },
  projects: [
    {
      name: 'tour-light',
      use: { ...devices['Desktop Chrome'], viewport: VIEWPORT, deviceScaleFactor: 2, locale: 'en-US', colorScheme: 'light' },
      metadata: { locale: 'en', variant: 'light-desktop', mode: 'light' }
    },
    {
      name: 'tour-dark',
      use: { ...devices['Desktop Chrome'], viewport: VIEWPORT, deviceScaleFactor: 2, locale: 'en-US', colorScheme: 'dark' },
      metadata: { locale: 'en', variant: 'dark-desktop', mode: 'dark' }
    }
  ]
})
