import { afterEach, beforeEach } from 'vitest'
import { setLogSink, type LogRecord } from '../../shared/logging/core'

/**
 * Capture the log records written while a test runs (they are redacted and
 * level-filtered exactly as in production; the level defaults to `info`).
 * Call once at the top of a test file or describe block:
 *
 *   const logs = captureLogs()
 *   …
 *   expect(logs.find('warn', 'sweep failed')).toMatchObject({ component: 'x' })
 */
export function captureLogs(): { records: LogRecord[], find: (level: LogRecord['level'], msg?: string) => LogRecord | undefined, all: (level?: LogRecord['level']) => LogRecord[] } {
  const records: LogRecord[] = []
  beforeEach(() => {
    records.length = 0
    setLogSink(r => records.push(r))
  })
  afterEach(() => setLogSink(null))
  return {
    records,
    find: (level, msg) => records.find(r => r.level === level && (msg === undefined || r.msg === msg)),
    all: level => (level ? records.filter(r => r.level === level) : [...records])
  }
}
