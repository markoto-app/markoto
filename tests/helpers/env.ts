import { vi } from 'vitest'

/**
 * Provide configuration to the code under test the way an operator does:
 * raw variable names, read through the typed env (shared/env). `undefined`
 * unsets a variable. Restored after each test (`unstubEnvs`).
 */
export function stubEnv(vars: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value)
}
