import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Test runner config.
//
// Two suites:
//   - tests/unit/**     — pure function tests. No DB, no server, no Nuxt.
//                         Sub-second feedback loop. Safe to run always.
//   - tests/integration/** — REST endpoints + sync-server. Need the dev
//                            Postgres from docker-compose.dev.yml and a
//                            running app. Opted-in via the `integration`
//                            project; bun run test runs unit by default.
export default defineConfig({
  resolve: {
    alias: {
      '~~': fileURLToPath(new URL('./', import.meta.url)),
      '~': fileURLToPath(new URL('./app', import.meta.url))
    }
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
          // Run the fast unit suite first so a green quick pass is
          // visible before the heavyweight Nuxt boot kicks off.
          sequence: { groupOrder: 0 }
        }
      },
      {
        extends: true,
        test: {
          name: 'dom',
          include: ['tests/dom/**/*.test.ts'],
          // Happy-dom gives DOMPurify a window to bind to. renderMarkdown
          // is a browser module; without this env the dynamic import of
          // `dompurify` returns the Node factory and `purify.sanitize`
          // isn't callable.
          environment: 'happy-dom',
          sequence: { groupOrder: 0 }
        }
      },
      {
        extends: true,
        test: {
          name: 'repos',
          include: ['tests/repos/**/*.test.ts'],
          environment: 'node',
          // Repos share the test DB — serialize everything. Same
          // groupOrder as integration so they don't race for the DB.
          pool: 'forks',
          isolate: false,
          fileParallelism: false,
          maxConcurrency: 1,
          sequence: { concurrent: false, groupOrder: 1 },
          testTimeout: 15_000,
          hookTimeout: 30_000,
          globalSetup: ['./tests/repos/setup/globalSetup.ts']
        }
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          // Single worker — endpoints share Postgres state; parallel tests
          // (either across files or within a file) race on the same rows
          // without schema isolation. Force everything serial.
          pool: 'forks',
          isolate: false,
          fileParallelism: false,
          maxConcurrency: 1,
          sequence: { concurrent: false, groupOrder: 1 },
          testTimeout: 30_000,
          hookTimeout: 120_000,
          globalSetup: ['./tests/integration/setup/globalSetup.ts'],
          setupFiles: ['./tests/integration/setup/stubSetup.ts']
        }
      }
    ]
  }
})
