import { EnvError, loadEnv } from '../../shared/env/load'
import type { RendererEnv } from '../../shared/env/registry'

// The renderer's configuration: the `renderer` view of the env registry
// (shared/env/), validated once when the first module that needs it loads
// (sentry.ts, imported first by index.ts). A misconfigured container exits
// with every problem listed instead of failing at the first render.
function load(): RendererEnv {
  try {
    return loadEnv('renderer')
  } catch (e) {
    if (!(e instanceof EnvError)) throw e
    console.error(e.message)
    process.exit(1)
  }
}

export const env: RendererEnv = load()
