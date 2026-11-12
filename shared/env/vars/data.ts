import { bool, csv, hostname, nonNegativeInt, oneOf, port, secret, string, url } from '../coerce'
import { defineNamespace, v } from '../define'

export const database = defineNamespace({
  name: 'database',
  title: 'PostgreSQL',
  intro: 'Connection parts (shared/utils/runtime/connectionStrings.ts builds the URL). Dev: the values below match docker-compose.dev.yml; the containerised stacks set the host themselves.',
  vars: {
    user: v({
      name: 'POSTGRES_USER',
      type: string,
      required: 'always',
      example: 'ypad',
      doc: 'Role the app and sync server connect as (the compose files substitute POSTGRES_APP_USER when set). Also the admin role of db-init and backups.',
      services: ['app', 'sync', 'backup', 'compose'],
      scope: 'both'
    }),
    password: v({
      name: 'POSTGRES_PASSWORD',
      type: string,
      required: 'always',
      secret: true,
      example: 'devpassword',
      doc: 'Password of POSTGRES_USER.',
      services: ['app', 'sync', 'backup', 'compose'],
      scope: 'both'
    }),
    host: v({
      name: 'POSTGRES_HOST',
      type: string,
      required: 'always',
      example: 'localhost',
      doc: 'Database host (compose: `postgres`, or the managed cluster endpoint).',
      services: ['app', 'sync', 'backup', 'compose'],
      scope: 'both'
    }),
    port: v({
      name: 'POSTGRES_PORT',
      type: port,
      default: 5432,
      example: '5432',
      doc: 'Database port.',
      services: ['app', 'sync', 'backup', 'compose'],
      scope: 'both'
    }),
    db: v({
      name: 'POSTGRES_DB',
      type: string,
      required: 'always',
      example: 'ypad',
      doc: 'Database of the app (LiteLLM uses its own `litellm` database).',
      services: ['app', 'sync', 'backup', 'compose'],
      scope: 'both'
    }),
    ssl: v({
      name: 'PGSSL',
      type: oneOf(['disable']),
      doc: '`disable` turns TLS to Postgres off (otherwise on in production). No other value is accepted.',
      services: ['app', 'sync'],
      scope: 'both'
    }),
    sslRootCert: v({
      name: 'PGSSLROOTCERT',
      type: string,
      doc: 'Path of a CA PEM the Postgres server certificate is verified against (default: system CA bundle). Unreadable = boot fails.',
      services: ['app', 'sync', 'backup'],
      scope: 'hosted',
      notPassed: 'hosted only: prod compose passes it; self-host runs Postgres in the stack without TLS'
    }),
    sslMode: v({
      name: 'POSTGRES_SSLMODE',
      type: oneOf(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']),
      doc: 'libpq sslmode for LiteLLM\'s DATABASE_URL, db-init and the backup sidecar (managed Postgres: require).',
      services: ['compose'],
      scope: 'hosted'
    }),
    appUser: v({
      name: 'POSTGRES_APP_USER',
      type: string,
      doc: 'Least-privilege role the app and sync server connect as (db-init creates it). Empty = POSTGRES_USER.',
      services: ['compose'],
      scope: 'both'
    }),
    appPassword: v({
      name: 'POSTGRES_APP_PASSWORD',
      type: string,
      secret: true,
      doc: 'Password of POSTGRES_APP_USER.',
      services: ['compose'],
      scope: 'both'
    }),
    litellmUser: v({
      name: 'POSTGRES_LITELLM_USER',
      type: string,
      doc: 'Role LiteLLM connects as (owner of the litellm database only). Empty = POSTGRES_USER.',
      services: ['compose'],
      scope: 'both'
    }),
    litellmPassword: v({
      name: 'POSTGRES_LITELLM_PASSWORD',
      type: string,
      secret: true,
      doc: 'Password of POSTGRES_LITELLM_USER.',
      services: ['compose'],
      scope: 'both'
    })
  }
})

export const valkey = defineNamespace({
  name: 'valkey',
  title: 'Valkey',
  intro: 'Rate limits, locks and the sync server\'s per-document state.',
  vars: {
    host: v({
      name: 'VALKEY_HOST',
      type: string,
      required: 'always',
      example: 'localhost',
      doc: 'Valkey host (compose: `valkey`).',
      services: ['app', 'sync'],
      scope: 'both'
    }),
    port: v({
      name: 'VALKEY_PORT',
      type: port,
      default: 6379,
      example: '6379',
      doc: 'Valkey port.',
      services: ['app', 'sync'],
      scope: 'both'
    }),
    password: v({
      name: 'VALKEY_PASSWORD',
      type: string,
      secret: true,
      example: 'devpassword',
      doc: 'Valkey password (empty = no auth; the containerised stacks require one).',
      services: ['app', 'sync', 'compose'],
      scope: 'both'
    }),
    db: v({
      name: 'VALKEY_DB',
      type: nonNegativeInt,
      default: 0,
      example: '0',
      doc: 'Logical database index.',
      services: ['app', 'sync'],
      scope: 'both'
    }),
    tlsEnabled: v({
      name: 'VALKEY_TLS_ENABLED',
      type: bool,
      default: false,
      doc: 'TLS to Valkey (rediss://) — for a managed or remote Valkey.',
      services: ['app', 'sync'],
      scope: 'both',
      notPassed: 'opt-in for a managed Valkey; the stacks run Valkey on the internal network'
    }),
    tlsCaPath: v({
      name: 'VALKEY_TLS_CA_PATH',
      type: string,
      doc: 'CA PEM for a provider with a private CA (default: system CA store).',
      services: ['app', 'sync'],
      scope: 'both',
      notPassed: 'opt-in for a managed Valkey'
    })
  }
})

export const storage = defineNamespace({
  name: 'storage',
  title: 'Object storage (S3)',
  intro: 'Image uploads, knowledge originals and render artefacts. The renderer reads the same values without the NUXT_ prefix.',
  vars: {
    endpoint: v({
      name: 'NUXT_S3_ENDPOINT',
      type: url(),
      required: 'always',
      example: 'http://localhost:8333',
      doc: 'S3 API endpoint the app (and renderer) talk to.',
      services: ['app', 'renderer'],
      scope: 'both',
      aliases: { renderer: 'S3_ENDPOINT' }
    }),
    publicEndpoint: v({
      name: 'NUXT_S3_PUBLIC_ENDPOINT',
      type: url(),
      doc: 'Base URL browsers use for presigned URLs when it differs from NUXT_S3_ENDPOINT (self-host: the public origin). SigV4 signs the host.',
      services: ['app', 'renderer'],
      scope: 'self-host',
      aliases: { renderer: 'S3_PUBLIC_ENDPOINT' }
    }),
    accessKey: v({
      name: 'NUXT_S3_ACCESS_KEY',
      type: string,
      required: 'always',
      secret: true,
      example: 'ypad-access-key',
      doc: 'S3 access key.',
      services: ['app', 'renderer', 'backup'],
      scope: 'both',
      aliases: { renderer: 'S3_ACCESS_KEY', backup: 'S3_ACCESS_KEY' }
    }),
    secretKey: v({
      name: 'NUXT_S3_SECRET_KEY',
      type: string,
      required: 'always',
      secret: true,
      example: 'ypad-secret-key',
      doc: 'S3 secret key.',
      services: ['app', 'renderer', 'backup'],
      scope: 'both',
      aliases: { renderer: 'S3_SECRET_KEY', backup: 'S3_SECRET_KEY' }
    }),
    bucket: v({
      name: 'NUXT_S3_BUCKET',
      type: string,
      default: 'ypad',
      example: 'ypad',
      doc: 'Bucket name.',
      services: ['app', 'renderer', 'backup'],
      scope: 'both',
      aliases: { renderer: 'S3_BUCKET', backup: 'S3_BUCKET' }
    }),
    sse: v({
      name: 'S3_SSE',
      type: string,
      default: 'AES256',
      emptyIsValue: true,
      doc: 'Server-side encryption header on render artefacts and backups; `none` (or set but empty) for backends without SSE-S3 (SeaweedFS).',
      services: ['renderer', 'backup'],
      scope: 'self-host',
      notPassed: 'hosted keeps the AES256 default (OVH supports SSE-S3)'
    }),
    imageGcRetentionDays: v({
      name: 'NUXT_IMAGE_GC_RETENTION_DAYS',
      type: nonNegativeInt,
      default: 30,
      doc: 'Days a confirmed image must stay unreferenced before it is deleted (0 = image GC off).',
      services: ['app'],
      scope: 'both'
    })
  }
})

export const markitdown = defineNamespace({
  name: 'markitdown',
  title: 'Import converter (markitdown)',
  intro: 'Imports, knowledge uploads and design extraction. The converter refuses requests without the shared secret.',
  vars: {
    url: v({
      name: 'NUXT_MARKITDOWN_URL',
      type: url(),
      required: 'always',
      example: 'http://localhost:8080',
      doc: 'Internal URL of the markitdown service.',
      services: ['app'],
      scope: 'both'
    }),
    apiSecret: v({
      name: 'NUXT_MARKITDOWN_API_SECRET',
      example: '',
      type: secret(32),
      required: 'always',
      secret: true,
      doc: 'Shared secret the app sends to markitdown.',
      services: ['app', 'markitdown'],
      scope: 'both',
      aliases: { markitdown: 'MARKITDOWN_API_SECRET' }
    }),
    timeoutSeconds: v({
      name: 'MARKITDOWN_TIMEOUT_SECONDS',
      type: string,
      doc: 'Wall-clock budget of one conversion (markitdown-server/server.py).',
      services: ['markitdown'],
      scope: 'both',
      notPassed: 'converter default'
    }),
    childMemoryMb: v({
      name: 'MARKITDOWN_CHILD_MEMORY_MB',
      type: string,
      doc: 'Memory cap of the conversion child process.',
      services: ['markitdown'],
      scope: 'both',
      notPassed: 'converter default'
    }),
    maxUncompressedMb: v({
      name: 'MARKITDOWN_MAX_UNCOMPRESSED_MB',
      type: string,
      doc: 'Largest inflated size of an uploaded archive (default 200).',
      services: ['markitdown'],
      scope: 'both',
      notPassed: 'converter default'
    }),
    maxArchiveEntries: v({
      name: 'MARKITDOWN_MAX_ARCHIVE_ENTRIES',
      type: string,
      doc: 'Most entries in an uploaded archive (default 10000).',
      services: ['markitdown'],
      scope: 'both',
      notPassed: 'converter default'
    }),
    maxCompressionRatio: v({
      name: 'MARKITDOWN_MAX_COMPRESSION_RATIO',
      type: string,
      doc: 'Highest compression ratio of an archive (default 100).',
      services: ['markitdown'],
      scope: 'both',
      notPassed: 'converter default'
    }),
    archiveCheckTimeoutSeconds: v({
      name: 'MARKITDOWN_ARCHIVE_CHECK_TIMEOUT_SECONDS',
      type: string,
      doc: 'Budget of the archive inflate check (default 20).',
      services: ['markitdown'],
      scope: 'both',
      notPassed: 'converter default'
    })
  }
})

export const renderer = defineNamespace({
  name: 'renderer',
  title: 'Renderer (PDF / PNG)',
  intro: 'Playwright sidecar that renders documents. Internal-only.',
  vars: {
    internalUrl: v({
      name: 'NUXT_RENDERER_INTERNAL_URL',
      type: url(),
      default: 'http://localhost:9000',
      example: 'http://localhost:9000',
      emptyIsValue: true,
      doc: 'Internal URL of the renderer; set but empty disables PDF download and the AI\'s view_pages tool.',
      services: ['app'],
      scope: 'both'
    }),
    allowedOrigins: v({
      name: 'RENDERER_ALLOWED_ORIGINS',
      type: csv(url()),
      default: [],
      doc: 'Extra origins the renderer\'s Chromium may load (beyond the app and S3). Mirrored into the print page CSP: set it on app AND renderer.',
      services: ['app', 'renderer'],
      scope: 'both'
    }),
    port: v({
      name: 'PORT',
      internal: true,
      type: port,
      default: 9000,
      doc: 'Port the renderer listens on.',
      services: ['renderer'],
      scope: 'both'
    }),
    appUrl: v({
      name: 'APP_URL',
      internal: true,
      type: url(),
      default: 'http://app:3000',
      doc: 'Internal URL the renderer loads the print page from.',
      services: ['renderer'],
      scope: 'both'
    }),
    chromiumSandbox: v({
      name: 'RENDERER_CHROMIUM_SANDBOX',
      type: bool,
      default: true,
      doc: 'Chromium\'s own sandbox; false only on hosts without unprivileged user namespaces.',
      services: ['renderer'],
      scope: 'both',
      notPassed: 'escape hatch, documented in docs/SECURITY-HARDENING.md'
    }),
    localhostTarget: v({
      name: 'RENDERER_LOCALHOST_TARGET',
      type: hostname,
      default: 'host.docker.internal',
      doc: 'Where Chromium resolves `localhost` (dev/test: the SeaweedFS container).',
      services: ['renderer'],
      scope: 'dev',
      notPassed: 'dev/test stacks only'
    })
  }
})
