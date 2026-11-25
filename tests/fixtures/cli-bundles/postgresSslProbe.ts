// Bundled by tests/unit/platform/cliBundles.test.ts with the Dockerfile's
// CLI flags, then run: prints the TLS settings each Postgres pool of the
// server code would connect with. Constructing a pg Pool does not connect.
import { useDatabase } from '../../../server/db/client'
import { litellmPoolConfig } from '../../../server/db/litellm'
import { useUmamiPool } from '../../../server/db/umami'

const app = useDatabase().$client as unknown as { options: { ssl: unknown } }
const umami = useUmamiPool() as unknown as { options: { ssl: unknown } }
process.stdout.write(JSON.stringify({ app: app.options.ssl, litellm: litellmPoolConfig().ssl, umami: umami.options.ssl }))
