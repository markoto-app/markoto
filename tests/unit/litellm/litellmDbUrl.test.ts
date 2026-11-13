import { describe, it, expect } from 'vitest'
import { litellmDbUrl } from '../../../server/db/litellm'

// The app reaches LiteLLM's own database for the spend-log sweep and the
// admin per-axis spend query. With separate Postgres roles
// (deploy/config/postgres/db-init.sh) the app role has no CONNECT on `litellm`, so
// these paths must use LiteLLM's role when the deployment configures one.

const base = {
  POSTGRES_USER: 'markoto_app',
  POSTGRES_PASSWORD: 'app-pw',
  POSTGRES_HOST: 'postgres',
  POSTGRES_PORT: '5432'
}

describe('litellmDbUrl', () => {
  it('falls back to the app credentials when no LiteLLM role is configured', () => {
    expect(litellmDbUrl({ ...base })).toBe('postgres://markoto_app:app-pw@postgres:5432/litellm')
  })

  it('uses the LiteLLM role when NUXT_LITELLM_DB_USER is set', () => {
    expect(litellmDbUrl({ ...base, NUXT_LITELLM_DB_USER: 'litellm', NUXT_LITELLM_DB_PASSWORD: 'll-pw' }))
      .toBe('postgres://litellm:ll-pw@postgres:5432/litellm')
  })

  it('never pairs the LiteLLM user with the app password', () => {
    expect(litellmDbUrl({ ...base, NUXT_LITELLM_DB_USER: 'litellm' }))
      .toBe('postgres://litellm:@postgres:5432/litellm')
  })

  it('treats empty values (compose `${VAR:-}`) as unset', () => {
    expect(litellmDbUrl({ ...base, NUXT_LITELLM_DB_USER: '', NUXT_LITELLM_DB_PASSWORD: '', NUXT_LITELLM_DB_URL: '' }))
      .toBe('postgres://markoto_app:app-pw@postgres:5432/litellm')
  })

  it('URL-encodes credentials', () => {
    expect(litellmDbUrl({ ...base, NUXT_LITELLM_DB_USER: 'lite@llm', NUXT_LITELLM_DB_PASSWORD: 'p/w:#' }))
      .toBe('postgres://lite%40llm:p%2Fw%3A%23@postgres:5432/litellm')
  })

  it('honours the database-name and full-URL overrides', () => {
    expect(litellmDbUrl({ ...base, NUXT_LITELLM_DB_NAME: 'litellm_test' }))
      .toBe('postgres://markoto_app:app-pw@postgres:5432/litellm_test')
    expect(litellmDbUrl({ ...base, NUXT_LITELLM_DB_URL: 'postgres://x:y@db:6543/l' })).toBe('postgres://x:y@db:6543/l')
  })
})
