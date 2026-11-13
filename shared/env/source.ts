// The process environment, for the few readers that parse raw values
// themselves (tier and price overrides, which shared/config parses with
// the registry's own coercers) and cannot import shared/env/load.ts
// without an import cycle. Everything else reads `useEnv()`.

import type { RawEnv } from './define'

export function processEnv(): RawEnv {
  return process.env
}
