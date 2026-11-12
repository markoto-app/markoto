import { loadRendererEnv, type RendererEnv } from './env.generated'

// The renderer's configuration, validated once when the first module that
// needs it loads (sentry.ts, imported first by index.ts). A misconfigured
// container exits with every problem listed instead of failing at the
// first render.
function load(): RendererEnv {
  try {
    return loadRendererEnv()
  } catch (e) {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  }
}

export const env: RendererEnv = load()
