import { spawn, type ChildProcess } from 'node:child_process'
import {
  TEST_BASE_URL,
  TEST_DB_HOST,
  TEST_DB_NAME,
  TEST_DB_PASSWORD,
  TEST_DB_PORT,
  TEST_DB_USER,
  TEST_INTERNAL_SECRET,
  TEST_JWT_SECRET,
  TEST_VALKEY_HOST,
  TEST_VALKEY_PASSWORD,
  TEST_VALKEY_PORT
} from './env'

// A sync server of its own, run from the source tree against the test
// stack's Postgres and Valkey, for tests that restart it or need other
// limits than the shared `sync-test` container. Never point a test that
// kills its server at `sync-test`: every other suite uses that one.

export interface SyncProcess {
  readonly port: number
  readonly wsUrl: string
  /** Start (again) on the same port; resolves once /health answers. */
  start(): Promise<void>
  /** SIGKILL: a crash, nothing pending is stored. */
  kill(): Promise<void>
  /** SIGTERM: a deploy, the drain stores pending edits first. */
  stop(): Promise<void>
}

export function syncProcess(port: number, env: Record<string, string> = {}): SyncProcess {
  let child: ChildProcess | null = null
  let output = ''

  function exited(): Promise<void> {
    const c = child
    if (!c || c.exitCode !== null || c.signalCode !== null) return Promise.resolve()
    return new Promise(done => c.once('exit', () => done()))
  }

  async function waitHealthy(): Promise<void> {
    const deadline = Date.now() + 30_000
    for (;;) {
      if (child?.exitCode != null) throw new Error(`sync server exited during start:\n${output}`)
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`)
        if (res.ok) return
      } catch { /* not listening yet */ }
      if (Date.now() > deadline) throw new Error(`sync server not healthy after 30 s:\n${output}`)
      await new Promise(r => setTimeout(r, 100))
    }
  }

  async function signal(sig: NodeJS.Signals): Promise<void> {
    if (!child) return
    const done = exited()
    child.kill(sig)
    await done
    child = null
  }

  return {
    port,
    wsUrl: `ws://127.0.0.1:${port}`,
    async start() {
      if (child) throw new Error('sync server already running')
      output = ''
      child = spawn('bun', ['run', 'sync-server/src/index.ts'], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          NODE_ENV: 'test',
          PORT: String(port),
          POSTGRES_USER: TEST_DB_USER,
          POSTGRES_PASSWORD: TEST_DB_PASSWORD,
          POSTGRES_HOST: TEST_DB_HOST,
          POSTGRES_PORT: TEST_DB_PORT,
          POSTGRES_DB: TEST_DB_NAME,
          JWT_SECRET: TEST_JWT_SECRET,
          INTERNAL_API_SECRET: TEST_INTERNAL_SECRET,
          VALKEY_HOST: TEST_VALKEY_HOST,
          VALKEY_PORT: TEST_VALKEY_PORT,
          VALKEY_PASSWORD: TEST_VALKEY_PASSWORD,
          VALKEY_DB: '0',
          APP_URL: TEST_BASE_URL,
          TEST_MODE: '1',
          COMPACT_INTERVAL_MS: '0',
          LOG_LEVEL: 'warn',
          ...env
        }
      })
      const collect = (b: Buffer) => {
        output += b.toString()
      }
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)
      await waitHealthy()
    },
    kill: () => signal('SIGKILL'),
    stop: () => signal('SIGTERM')
  }
}
