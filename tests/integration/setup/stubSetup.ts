import { afterAll, beforeAll } from 'vitest'
import { startSyncStub, stopSyncStub } from './syncStub'

// vitest `setupFiles` entry — runs inside the test worker process, so
// the in-memory `calls` array in syncStub.ts is the same module instance
// the test files import. That's why the stub can't live in globalSetup:
// globalSetup runs in a separate process and the `calls` array there
// would be invisible to assertions.
//
// beforeAll/afterAll at the top level fire once per test worker. With
// our single-fork config that's once for the whole run.

beforeAll(async () => {
  await startSyncStub()
})

afterAll(async () => {
  await stopSyncStub()
})
