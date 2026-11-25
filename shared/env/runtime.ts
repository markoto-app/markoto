// Whether this process runs as production, decided when the code runs.
//
// The literal expression `process.env.NODE_ENV` is a build-time constant
// to every bundler: Nitro replaces it with the NODE_ENV of `nuxt build`
// ('production'), and `bun build` (the operator CLIs bundled into the app
// image, see the Dockerfile) with the NODE_ENV of the image build, which is
// unset, so it becomes 'development'. A CLI that decided Postgres TLS that
// way connected without TLS in production, and managed Postgres refused it.
//
// So the running process's NODE_ENV is read from the environment record
// (`source.NODE_ENV` on a parameter is a plain property read no bundler
// rewrites), and a production build stays production as before:
//
//   - Nitro output (`nuxt build`): always production, as it was when every
//     caller compared the inlined constant (also when a test stack runs
//     `.output` without NODE_ENV).
//   - Bundled CLIs and plain `bun scripts/x.ts`: the NODE_ENV of the
//     process that runs them (`docker compose exec app` inherits the app
//     container's NODE_ENV=production).
//   - Vitest / `nuxt dev`: the live NODE_ENV ('test' / 'development'),
//     which `vi.stubEnv('NODE_ENV', …)` changes as before.
//
// Code under server/ and shared/ asks these helpers instead of reading
// `process.env.NODE_ENV` (ESLint `markoto/no-raw-env`); the bundled CLIs are
// checked by tests/unit/platform/cliBundles.test.ts.

import type { RawEnv } from './define'

/** NODE_ENV of the running process; 'production' for a production build. */
export function nodeEnv(source: RawEnv = process.env): string | undefined {
  // Replaced by the bundler: 'production' only in a production build.
  const built = process.env.NODE_ENV
  if (built === 'production') return built
  return source.NODE_ENV
}

/** True in production: a production build, or a process run with NODE_ENV=production. */
export function isProduction(source: RawEnv = process.env): boolean {
  return nodeEnv(source) === 'production'
}
