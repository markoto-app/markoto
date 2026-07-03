import { defineConfig } from 'vitest/config'
import { defineVitestProject } from '@nuxt/test-utils/config'
import { fileURLToPath } from 'node:url'

// Test runner config.
//
// Projects:
//   - tests/unit/**        — pure function tests. No DB, no server, no Nuxt.
//                            Sub-second feedback loop. Safe to run always.
//   - tests/dom/**         — browser-ish tests on plain happy-dom. No Nuxt
//                            runtime; use for isolated utilities that need
//                            a DOM (e.g. DOMPurify on renderMarkdown output).
//   - tests/nuxt/**        — composables/components inside the full Nuxt
//                            environment. `mockNuxtImport` + `registerEndpoint`
//                            are available. Heavier boot — only use when
//                            auto-imports or Nitro endpoints are needed.
//                            Must be wrapped in `defineVitestProject` so the
//                            Nuxt env gets registered; `defineVitestConfig`
//                            cannot be used at the root while `projects` is.
//   - tests/repos/**       — DB-backed repository tests. Serialized, share
//                            the test Postgres.
//   - tests/integration/** — REST endpoints + sync-server. Need the dev
//                            Postgres from docker-compose.dev.yml and a
//                            running app. Opted-in via the `integration`
//                            project; bun run test runs unit + dom + nuxt.
export default defineConfig({
  resolve: {
    alias: {
      '~~': fileURLToPath(new URL('./', import.meta.url)),
      '~': fileURLToPath(new URL('./app', import.meta.url))
    }
  },
  // Force Vitest to use the compiled CJS build of zod via SSR's noExternal.
  // Zod v4's `index.js` does `import * as z from "./v4/classic/external.js"; export { z }`.
  // Vitest 4's SSR transform drops the re-exported namespace alias `z`, so
  // `import { z } from 'zod'` resolves to undefined and every test file that
  // loads `shared/types/theme.ts` crashes at module load with `z.string is
  // undefined`. Bypassing the SSR transform fixes the namespace re-export.
  ssr: {
    noExternal: ['zod']
  },
  test: {
    // Coverage config. V8 provider (no Istanbul transform — faster + no
    // source-map surprises).
    //
    // Scope is DELIBERATELY narrowed to code that runs in the vitest
    // process: unit + repos + nuxt projects. The integration project
    // spawns a separate Nuxt dev subprocess, and its server-side code
    // (every `server/api/*`, `server/middleware/*`, `server/plugins/*`,
    // `server/routes/*`) runs through Vite's SSR transform which records
    // coverage under the opaque URL `evalmachine.<anonymous>` — c8 can't
    // map that back to source files. See AGENTS.md §19 "coverage
    // undercounts" for the three dead ends we tried. Rather than publish
    // a misleading ~27% number that averages real gaps with subprocess
    // blind spots, we exclude the subprocess-only paths entirely.
    //
    // The 300+ tests in tests/integration/ still exercise those files at
    // runtime — they're the actual safety net for the HTTP surface. The
    // coverage report now measures what the in-process tests cover, and
    // nothing more.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      all: true,
      include: [
        'app/composables/**/*.ts',
        'app/utils/**/*.ts',
        'server/utils/**/*.ts',
        'server/repos/**/*.ts',
        'shared/**/*.ts',
        'sync-server/src/**/*.ts'
      ],
      exclude: [
        '**/*.d.ts',
        '**/*.test.ts',
        '**/*.config.{ts,mjs}',
        // Subprocess-only code — covered by integration tests but
        // invisible to the coverage recorder. Listing them here would
        // only produce false-zero rows; see the comment above.
        'server/api/**',
        'server/middleware/**',
        'server/plugins/**',
        'server/routes/**',
        'server/db/schema.ts',
        // Vue components — covered by manual/e2e UX testing, not unit.
        'app/components/**',
        'app/pages/**',
        'app/layouts/**',
        'drizzle/**',
        'scripts/**',
        'coverage/**',
        '.nuxt/**',
        '.output/**',
        'node_modules/**'
      ]
    },
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
      defineVitestProject({
        extends: true,
        test: {
          name: 'nuxt',
          include: ['tests/nuxt/**/*.test.ts'],
          // Full Nuxt runtime: auto-imports, `$fetch`, Nitro endpoint
          // stubs via `registerEndpoint`, composables/components via
          // `mountSuspended`. Heavier boot than `dom` — don't use this
          // project for pure functions.
          environment: 'nuxt',
          sequence: { groupOrder: 0 },
          testTimeout: 15_000,
          hookTimeout: 60_000
        },
        // Disable Vite's FS-allow gate ONLY for the nuxt-env test
        // project. Vite 7.3 added a per-ID security check on every
        // transformed `.svg` URL — including virtual IDs the FS gate
        // can't resolve to a real path. Nuxt's
        // `nuxt-public-asset-vite-plugin` emits `virtual:public?…svg`
        // IDs for `<img src="/foo.svg">` references (the brand
        // Wordmark + the lockup files), and those IDs cleanUrl down
        // to `virtual:public` — not a filesystem path → not in
        // `fs.allow` → denied at transform. The denial bubbles up
        // through `mountSuspended`'s app boot and breaks every nuxt
        // SFC test (the existing `ActivityFeed.test.ts` + `DiffView
        // .test.ts` have been silently red since Vite 7.3 landed,
        // even though the test code itself is fine).
        //
        // `fs.strict: false` short-circuits `isFileLoadingAllowed` to
        // always return true, which makes `checkLoadingAccess`
        // return `"allowed"` and the SVG transform proceeds. The
        // production build is unaffected — the gate only ever ran
        // in dev / test mode anyway, and prod uses the bundler's
        // baked-output path that never sees `virtual:public?...`.
        server: {
          fs: { strict: false }
        }
      }),
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
          globalSetup: ['./tests/integration/setup/globalSetup.ts']
        }
      }
    ]
  }
})
