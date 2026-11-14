import { defineConfig, devices } from '@playwright/test'

// Demo-video captures (scripts/demo-video/): scenes the product tour
// lacks, recorded with the tour's recorder (tests/e2e/tour/fixture.ts).
// NOT a test suite. Light mode only: the video is light throughout.
// Same viewport and scale as the tour, so the clips cut together.

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://markoto.localhost:3001'

export default defineConfig({
  testDir: '.',
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
    trace: 'off'
  },
  projects: [
    {
      name: 'video-light',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'en-US', colorScheme: 'light' },
      metadata: { locale: 'en', variant: 'light-desktop', mode: 'light' }
    }
  ]
})
