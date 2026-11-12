import { asLogLevel, createLogging, formatFor, type LogLevel, type Logger } from '../../shared/logging/core'
import { syncEnv } from './env'

// The sync server's logger. Same record shape as the app's (shared/logging/core.ts):
// JSON lines in production, `LOG_LEVEL` for the minimum level.

export type { Logger } from '../../shared/logging/core'

function currentLevel(): LogLevel {
  try {
    return asLogLevel(syncEnv().core.logLevel)
  } catch {
    return 'info'
  }
}

const create = createLogging({
  level: currentLevel,
  format: () => formatFor(process.env.NODE_ENV)
})

export function useLogger(component: string): Logger {
  return create(component)
}
