import { EnvError, loadEnv, primeEnv } from '~~/shared/env/load'
import { publishPagesErrors } from '../utils/publish/pagesHost'

// Fail-fast at boot: every variable of the app is parsed and checked
// against the registry (shared/env) — types, required values and the
// cross-field rules — and all problems are reported at once. Runs right
// after `00-db-migrate` so a misconfigured deploy crashes visibly during
// startup instead of 500-ing later when a request reaches the broken path.
//
// Policy: dev and prod enforce the same surface; no silent boot with
// degraded features. Test mode (TEST_MODE=1 on a non-deployment) relaxes
// required values and presence rules, never types. A stray TEST_MODE=1 on
// a real deployment refuses to boot (shared/env/rules/core.ts).

export default defineNitroPlugin(() => {
  // `bun run build` boots Nitro in prerender mode (PWA workbox needs `/`
  // pre-rendered) without the runtime environment — images are built
  // without it. Validation runs at every real container start instead.
  if (import.meta.prerender) return

  let env
  try {
    env = loadEnv('app', process.env, {
      // Checks that need server code (internal-hostname list, custom-domain
      // name rules): the pages host must be a public name of its own.
      extraChecks: () => publishPagesErrors()
    })
  } catch (e) {
    // A container prints the operator-facing list and stops, without a
    // stack trace around it; in development the error surfaces as usual.
    if (e instanceof EnvError && process.env.NODE_ENV === 'production') {
      console.error(e.message)
      process.exit(1)
    }
    throw e
  }
  primeEnv('app', env)
})
