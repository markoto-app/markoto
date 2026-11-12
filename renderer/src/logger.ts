import { asLogLevel, createLogging, formatFor, type LogLevel, type Logger } from '../../shared/logging/core'
import { env } from './env'

// The renderer's logger. Same record shape as the app's (shared/logging/core.ts).

export type { Logger } from '../../shared/logging/core'

function currentLevel(): LogLevel {
  return asLogLevel(env.core.logLevel)
}

const create = createLogging({
  level: currentLevel,
  format: () => formatFor(process.env.NODE_ENV)
})

export function useLogger(component: string): Logger {
  return create(component)
}
