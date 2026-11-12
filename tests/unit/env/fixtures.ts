import { EnvError, loadEnv } from '../../../shared/env/load'
import type { ValidatedService } from '../../../shared/env/define'

// A complete, valid environment per process, as the dev stack would set
// it. Tests spread their own values over it and look at what boot
// validation says.

const SECRET = 'x'.repeat(40)

export const VALID_APP_ENV: Record<string, string> = Object.freeze({
  NUXT_SESSION_PASSWORD: SECRET,
  NUXT_JWT_SECRET: SECRET,
  NUXT_INTERNAL_API_SECRET: SECRET,
  NUXT_MARKITDOWN_API_SECRET: SECRET,
  POSTGRES_USER: 'ypad',
  POSTGRES_PASSWORD: 'devpassword',
  POSTGRES_HOST: 'localhost',
  POSTGRES_PORT: '5432',
  POSTGRES_DB: 'ypad',
  VALKEY_HOST: 'localhost',
  VALKEY_PORT: '6379',
  NUXT_S3_ENDPOINT: 'http://localhost:8333',
  NUXT_S3_ACCESS_KEY: 'key',
  NUXT_S3_SECRET_KEY: 'secret',
  NUXT_S3_BUCKET: 'ypad',
  NUXT_MARKITDOWN_URL: 'http://localhost:8080',
  NUXT_SYNC_INTERNAL_URL: 'http://localhost:4001',
  NUXT_PUBLIC_SYNC_URL: 'ws://localhost:4001',
  NUXT_LITELLM_URL: 'http://localhost:4000',
  NUXT_LITELLM_MASTER_KEY: 'sk-master'
})

export const VALID_SYNC_ENV: Record<string, string> = Object.freeze({
  JWT_SECRET: SECRET,
  INTERNAL_API_SECRET: SECRET,
  POSTGRES_USER: 'ypad',
  POSTGRES_PASSWORD: 'devpassword',
  POSTGRES_HOST: 'localhost',
  POSTGRES_DB: 'ypad',
  VALKEY_HOST: 'localhost'
})

export const VALID_RENDERER_ENV: Record<string, string> = Object.freeze({
  INTERNAL_API_SECRET: SECRET,
  S3_ENDPOINT: 'http://localhost:8333',
  S3_ACCESS_KEY: 'key',
  S3_SECRET_KEY: 'secret'
})

const VALID: Record<ValidatedService, Record<string, string>> = { app: VALID_APP_ENV, sync: VALID_SYNC_ENV, renderer: VALID_RENDERER_ENV }

/** Problems boot validation reports for the valid env with `overrides` applied ([] = boots). */
export function bootProblems(overrides: Record<string, string | undefined>, service: ValidatedService = 'app'): string[] {
  try {
    loadEnv(service, { ...VALID[service], ...overrides }, { onWarning: () => {} })
    return []
  } catch (e) {
    if (e instanceof EnvError) return [...e.problems]
    throw e
  }
}

/** Warnings boot validation logs for the valid env with `overrides` applied. */
export function bootWarnings(overrides: Record<string, string | undefined>): string[] {
  const warnings: string[] = []
  loadEnv('app', { ...VALID_APP_ENV, ...overrides }, { onWarning: m => warnings.push(m) })
  return warnings
}
