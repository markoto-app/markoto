import { bootSyncEnv } from './env'

// Imported first by index.ts: a misconfigured deploy exits with every
// problem listed before any other module reads its configuration.
bootSyncEnv()
