import { createLogging, formatFor, type LogLevel, type Logger } from './logging-core'
import { env } from './env'

// The renderer's logger. Same record shape as the app's; the core is a
// byte-identical copy of shared/logging/core.ts (the image is built from
// renderer/ alone), pinned by tests/unit/logging/core.test.ts.

export type { Logger } from './logging-core'

function currentLevel(): LogLevel {
  return env.core.logLevel
}

const create = createLogging({
  level: currentLevel,
  format: () => formatFor(process.env.NODE_ENV)
})

export function useLogger(component: string): Logger {
  return create(component)
}
