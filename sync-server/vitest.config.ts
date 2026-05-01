import { defineConfig } from 'vitest/config'

// Standalone vitest config for sync-server unit tests. The repo-root
// vitest config doesn't reach in here because the sync-server has its
// own deps (ioredis, ypg-persistence) that the root project doesn't
// share. Run with `bun run --filter` style or `bun x vitest run` from
// inside `sync-server/`.
export default defineConfig({
  test: {
    name: 'sync-server-unit',
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 5000
  }
})
