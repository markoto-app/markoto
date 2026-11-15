import { defineConfig } from 'vitest/config'
import { defineVitestProject } from '@nuxt/test-utils/config'
import { fileURLToPath } from 'node:url'

// Test runner config.
//
// Projects:
//   - tests/unit/**: pure function tests. No DB, no server, no Nuxt.
//                            Sub-second feedback loop. Safe to run always.
//   - tests/dom/**: browser-ish tests on plain happy-dom. No Nuxt
//                            runtime; use for isolated utilities that need
//                            a DOM (e.g. DOMPurify on renderMarkdown output).
//   - tests/nuxt/**: composables/components inside the full Nuxt
//                            environment. `mockNuxtImport` + `registerEndpoint`
//                            are available. Heavier boot, only use when
//                            auto-imports or Nitro endpoints are needed.
//                            Must be wrapped in `defineVitestProject` so the
//                            Nuxt env gets registered; `defineVitestConfig`
//                            cannot be used at the root while `projects` is.
//   - tests/repos/**: DB-backed repository tests. Serialized, share
//                            the test Postgres.
//   - tests/integration/**: REST endpoints + sync-server. Need the dev
//                            Postgres from deploy/compose/compose.dev.yml and a
//                            running app. Opted-in via the `integration`
//                            project; bun run test runs unit + dom + nuxt.
//   - tests/billing-sandbox/**: the app against Stripe's real test-mode
//                            API (test clocks, real events). Skipped
//                            unless STRIPE_SANDBOX_SECRET_KEY is set.
// Node 25 defines its own global `localStorage` (Web Storage, on by
// default), which shadows the DOM test environment's and has no methods
// without `--localstorage-file` ("localStorage.setItem is not a
// function"). The flag exists since Node 22; older Node needs nothing.
const NODE_MAJOR = Number(process.versions.node.split('.')[0])
const WORKER_EXEC_ARGV = NODE_MAJOR >= 22 ? ['--no-experimental-webstorage'] : []

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
    execArgv: WORKER_EXEC_ARGV,
    // Tests hand configuration to the code under test with
    // `vi.stubEnv('NUXT_X', …)` (the typed env re-reads process.env per
    // call under Vitest, shared/env/load.ts); every stub is undone after
    // each test so no value leaks into the next one.
    unstubEnvs: true,
    // Coverage config. V8 provider (no Istanbul transform, faster + no
    // source-map surprises).
    //
    // Scope is DELIBERATELY narrowed to code that runs in the vitest
    // process: unit + repos + nuxt projects. The integration project
    // spawns a separate Nuxt dev subprocess, and its server-side code
    // (every `server/api/*`, `server/middleware/*`, `server/plugins/*`,
    // `server/routes/*`) runs through Vite's SSR transform which records
    // coverage under the opaque URL `evalmachine.<anonymous>`, c8 can't
    // map that back to source files. Averaging those blind spots into the
    // number would be misleading, so the subprocess-only paths are
    // excluded; tests/integration/ still exercises them at runtime.
    //
    // Every other first-party TypeScript dir is in `include`, also the ones
    // only partly unit-tested (server/mcp, server/legal, server/runtime,
    // app/queries, modules): SonarCloud counts each file it does not find
    // in the lcov as 0 % covered, so leaving a unit-tested dir out of the
    // report only hides the coverage it has (sonar-project.properties
    // mirrors this scope in sonar.coverage.exclusions).
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: [
        'app/composables/**/*.ts',
        'app/queries/**/*.ts',
        'app/utils/**/*.ts',
        'server/config/**/*.ts',
        'server/db/**/*.ts',
        'server/error.ts',
        'server/legal/**/*.ts',
        'server/mcp/**/*.ts',
        'server/repos/**/*.ts',
        'server/runtime/**/*.ts',
        'server/utils/**/*.ts',
        'modules/**/*.ts',
        'shared/**/*.ts',
        'sync-server/src/**/*.ts'
      ],
      exclude: [
        '**/*.d.ts',
        '**/*.test.ts',
        '**/*.config.{ts,mjs}',
        // Subprocess-only code: covered by integration tests but
        // invisible to the coverage recorder. Listing them here would
        // only produce false-zero rows; see the comment above.
        'server/api/**',
        'server/middleware/**',
        'server/plugins/**',
        'server/routes/**',
        'server/db/schema/**',
        // Vue components: covered by manual/e2e UX testing, not unit.
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
          // `mountSuspended`. Heavier boot than `dom`, don't use this
          // project for pure functions.
          environment: 'nuxt',
          sequence: { groupOrder: 0 },
          testTimeout: 15_000,
          hookTimeout: 60_000
        },
        // Disable Vite's FS-allow gate ONLY for the nuxt-env test
        // project. Vite 7.3 added a per-ID security check on every
        // transformed `.svg` URL: including virtual IDs the FS gate
        // can't resolve to a real path. Nuxt's
        // `nuxt-public-asset-vite-plugin` emits `virtual:public?…svg`
        // IDs for `<img src="/foo.svg">` references (the brand
        // Wordmark + the lockup files), and those IDs cleanUrl down
        // to `virtual:public`: not a filesystem path → not in
        // `fs.allow` → denied at transform. The denial bubbles up
        // through `mountSuspended`'s app boot and breaks every nuxt
        // SFC test (the existing `ActivityFeed.test.ts` + `DiffView
        // .test.ts` have been silently red since Vite 7.3 landed,
        // even though the test code itself is fine).
        //
        // `fs.strict: false` short-circuits `isFileLoadingAllowed` to
        // always return true, which makes `checkLoadingAccess`
        // return `"allowed"` and the SVG transform proceeds. The
        // production build is unaffected, the gate only ever ran
        // in dev / test mode anyway, and prod uses the bundler's
        // baked-output path that never sees `virtual:public?...`.
        server: {
          fs: { strict: false }
        },
        // nuxt-codemirror aliases @codemirror/{state,view} to their package
        // DIRECTORIES (dedupe). Vite resolves a directory alias through
        // `main` = the cjs build, while CodeMirror's other packages and the
        // test files get the esm build, two copies, and CM's `instanceof`
        // checks reject every extension ("multiple instances of
        // @codemirror/state"). Point the aliases at the esm entries, the
        // build the browser gets.
        resolve: {
          alias: {
            '@codemirror/state': fileURLToPath(new URL('./node_modules/@codemirror/state/dist/index.js', import.meta.url)),
            '@codemirror/view': fileURLToPath(new URL('./node_modules/@codemirror/view/dist/index.js', import.meta.url))
          }
        }
      }),
      {
        extends: true,
        test: {
          name: 'repos',
          include: ['tests/repos/**/*.test.ts'],
          environment: 'node',
          // Repos share the test DB, serialize everything. Same
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
          // Single worker: endpoints share Postgres state; parallel tests
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
      },
      {
        extends: true,
        test: {
          name: 'billing-sandbox',
          include: ['tests/billing-sandbox/**/*.test.ts'],
          environment: 'node',
          // One file per scenario, each on its own users, customers and
          // test clock: the files run side by side (the wait is Stripe's),
          // the steps inside a file in order. After the integration
          // project, which truncates the database this tier shares.
          pool: 'forks',
          sequence: { concurrent: false, groupOrder: 2 },
          // A test clock takes 10 to 15 s per advance; Stripe's events
          // follow a few seconds after the call that caused them.
          testTimeout: 300_000,
          hookTimeout: 300_000,
          globalSetup: ['./tests/billing-sandbox/setup/globalSetup.ts']
        }
      }
    ]
  }
})
