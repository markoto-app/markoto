import { bool, csv, hostname, positiveInt, secret, string, url } from '../coerce'
import { defineNamespace, v } from '../define'

export const publish = defineNamespace({
  name: 'publish',
  title: 'Published pages and custom domains',
  intro: 'Publishing at /p/<slug> always works. A pages host of its own is required for the hosted shape; custom domains need a CNAME target that reaches this instance\'s Traefik.',
  vars: {
    pagesHost: v({
      name: 'NUXT_PUBLISH_PAGES_HOST',
      type: string,
      doc: 'Hostname published pages are served from (pages.example.org, or an https:// origin). Must differ from the app host. Empty = the app\'s own origin.',
      services: ['app'],
      scope: 'both',
      required: { when: 'NUXT_LEGAL_SURFACES_ENABLED=true' }
    }),
    domainsTarget: v({
      name: 'NUXT_PUBLISH_DOMAINS_TARGET',
      type: hostname,
      doc: 'Host customers point their CNAME at. Empty = custom domains off.',
      services: ['app'],
      scope: 'both'
    }),
    dnsServers: v({
      name: 'NUXT_PUBLISH_DNS_SERVERS',
      type: csv(),
      default: [],
      doc: 'host:port DNS servers for the custom-domain check (default: the system\'s).',
      services: ['app'],
      scope: 'test',
      notPassed: 'test stacks only'
    }),
    traefikToken: v({
      name: 'NUXT_PUBLISH_TRAEFIK_TOKEN',
      type: secret(32),
      secret: true,
      doc: 'Token Traefik\'s HTTP provider sends to /api/internal/traefik/custom-domains. Unset = the endpoint is off.',
      services: ['app', 'compose'],
      scope: 'both',
      required: { when: 'NUXT_LEGAL_SURFACES_ENABLED=true and NUXT_PUBLISH_PAGES_HOST is set' }
    }),
    traefikEntryPoint: v({
      name: 'NUXT_PUBLISH_TRAEFIK_ENTRYPOINT',
      type: string,
      default: 'websecure',
      doc: 'Traefik entry point of the generated routers.',
      services: ['app'],
      scope: 'both',
      notPassed: 'the stacks use the default'
    }),
    traefikCertResolver: v({
      name: 'NUXT_PUBLISH_TRAEFIK_CERT_RESOLVER',
      type: string,
      default: 'le',
      doc: 'Traefik certificate resolver of the generated routers.',
      services: ['app'],
      scope: 'both',
      notPassed: 'the stacks use the default'
    }),
    traefikService: v({
      name: 'NUXT_PUBLISH_TRAEFIK_SERVICE',
      type: string,
      default: 'app@docker',
      doc: 'Existing Traefik service the generated routers point at.',
      services: ['app'],
      scope: 'self-host'
    }),
    traefikUpstream: v({
      name: 'NUXT_PUBLISH_TRAEFIK_UPSTREAM',
      type: url(),
      doc: 'Upstream URL to declare a service for instead of NUXT_PUBLISH_TRAEFIK_SERVICE (test stacks).',
      services: ['app'],
      scope: 'test',
      notPassed: 'test stacks only'
    }),
    traefikMiddlewares: v({
      name: 'NUXT_PUBLISH_TRAEFIK_MIDDLEWARES',
      type: csv(),
      default: [],
      doc: 'Traefik middlewares attached to the generated routers.',
      services: ['app'],
      scope: 'both'
    }),
    traefikPagesRouter: v({
      name: 'NUXT_PUBLISH_TRAEFIK_PAGES_ROUTER',
      type: bool,
      default: false,
      doc: 'Also emit the pages host\'s router from the HTTP provider (self-host HTTPS overlay).',
      services: ['app'],
      scope: 'self-host',
      notPassed: 'set by deploy/compose/compose.selfhost.tls.yml'
    })
  }
})

export const deploy = defineNamespace({
  name: 'deploy',
  title: 'Deployment (compose only)',
  intro: 'Interpolated by the compose files; no process reads them directly.',
  vars: {
    domain: v({ name: 'DOMAIN', example: '', type: hostname, doc: 'Hosted: apex domain (app at https://<DOMAIN>).', services: ['compose'], scope: 'hosted' }),
    acmeEmail: v({ name: 'ACME_EMAIL', example: '', type: string, doc: 'Hosted: Let\'s Encrypt account email.', services: ['compose'], scope: 'hosted' }),
    registry: v({ name: 'REGISTRY', example: '', type: string, doc: 'Image registry prefix (ghcr.io/<owner>).', services: ['compose'], scope: 'hosted' }),
    imageTag: v({ name: 'IMAGE_TAG', example: '', type: string, doc: 'Image tag to run (pin a version; no implicit latest).', services: ['compose'], scope: 'both' }),
    edgeBasicAuthUsers: v({ name: 'EDGE_BASIC_AUTH_USERS', type: string, doc: 'Hosted staging: htpasswd line (`user:<bcrypt>`) for the Traefik login in front of the app and pages hosts; empty (prod) = no login. Machine-to-machine paths stay outside it (deploy/compose/compose.prod.yml).', services: ['compose'], scope: 'hosted' }),
    litellmConfigHash: v({ name: 'LITELLM_CONFIG_HASH', type: string, doc: 'Hash of deploy/config/litellm/*: recreates the proxy when its config changes (set by every deploy path).', services: ['compose'], scope: 'both' }),
    productTourEnabled: v({ name: 'NUXT_PRODUCT_TOUR_ENABLED', type: bool, doc: 'Deprecated alias of NUXT_MARKETING_SITE_ENABLED, resolved by deploy/compose/compose.prod.yml.', services: ['compose'], scope: 'hosted' }),
    instance: v({ name: 'MARKOTO_INSTANCE', type: string, doc: 'Self-host: instance name (Traefik constraint, network names).', services: ['compose'], scope: 'self-host' }),
    publicUrl: v({ name: 'MARKOTO_PUBLIC_URL', type: url(), doc: 'Self-host: public URL (becomes NUXT_SITE_URL).', services: ['compose'], scope: 'self-host' }),
    syncUrl: v({ name: 'MARKOTO_SYNC_URL', type: url(['ws', 'wss']), doc: 'Self-host: browser WebSocket URL (becomes NUXT_PUBLIC_SYNC_URL).', services: ['compose'], scope: 'self-host' }),
    markotoDomain: v({ name: 'MARKOTO_DOMAIN', type: hostname, doc: 'Self-host TLS overlay: domain of the Let\'s Encrypt certificate.', services: ['compose'], scope: 'self-host' }),
    httpPort: v({ name: 'MARKOTO_HTTP_PORT', type: positiveInt, doc: 'Self-host: published HTTP port.', services: ['compose'], scope: 'self-host' }),
    httpBind: v({ name: 'MARKOTO_HTTP_BIND', type: string, doc: 'Self-host: address the HTTP port binds.', services: ['compose'], scope: 'self-host' }),
    httpsPort: v({ name: 'MARKOTO_HTTPS_PORT', type: positiveInt, doc: 'Self-host TLS overlay: published HTTPS port.', services: ['compose'], scope: 'self-host' }),
    httpsBind: v({ name: 'MARKOTO_HTTPS_BIND', type: string, doc: 'Self-host TLS overlay: address the HTTPS port binds.', services: ['compose'], scope: 'self-host' }),
    trustedIps: v({ name: 'TRAEFIK_TRUSTED_IPS', type: string, doc: 'Self-host: proxies whose X-Forwarded-* Traefik trusts.', services: ['compose'], scope: 'self-host' }),
    ovhPgHost: v({ name: 'OVH_PG_HOST', type: hostname, doc: 'Hosted deploy (infra/render-env.sh): managed Postgres host; set = verify its TLS against OVH_PG_CA_REMOTE_PATH.', services: ['compose'], scope: 'hosted', notPassed: 'read by the deploy paths only, which turn it into PGSSLROOTCERT' }),
    ovhPgCaRemotePath: v({ name: 'OVH_PG_CA_REMOTE_PATH', type: string, default: '/opt/markoto/secrets/ovh-pg-ca.pem', doc: 'Hosted deploy: path of the managed Postgres CA certificate on the server.', services: ['compose'], scope: 'hosted', notPassed: 'read by the deploy paths only, which turn it into PGSSLROOTCERT' }),
    containerSocket: v({ name: 'CONTAINER_SOCKET', type: string, doc: 'Docker / Podman socket path for the socket proxy. Hosted: exported by the markoto-compose wrapper (the markoto user\'s rootless Podman socket), not set in .env.', services: ['compose'], scope: 'both' })
  }
})

export const backup = defineNamespace({
  name: 'backup',
  title: 'Backups',
  intro: 'The backup sidecar (`pg_dump | gzip | gpg → S3`). Its storage defaults to the app\'s NUXT_S3_* bucket and credentials.',
  vars: {
    interval: v({ name: 'BACKUP_INTERVAL_SECONDS', type: positiveInt, example: '86400', doc: 'Seconds between backups.', services: ['backup'], scope: 'both' }),
    retention: v({ name: 'BACKUP_RETENTION_COUNT', type: positiveInt, example: '30', doc: 'Backups kept.', services: ['backup'], scope: 'both' }),
    passphrase: v({ name: 'BACKUP_GPG_PASSPHRASE', example: '', type: secret(), secret: true, doc: 'Symmetric gpg passphrase; rotating it makes older backups unrestorable without the old one.', services: ['backup'], scope: 'both' }),
    s3Endpoint: v({ name: 'BACKUP_S3_ENDPOINT', example: '', type: url(), doc: 'Dedicated backup endpoint (empty = NUXT_S3_ENDPOINT).', services: ['backup', 'compose'], scope: 'both' }),
    s3Bucket: v({ name: 'BACKUP_S3_BUCKET', example: '', type: string, doc: 'Dedicated backup bucket (empty = NUXT_S3_BUCKET).', services: ['backup', 'compose'], scope: 'both' }),
    s3AccessKey: v({ name: 'BACKUP_S3_ACCESS_KEY', example: '', type: string, secret: true, doc: 'Key scoped to the backup bucket (empty = NUXT_S3_ACCESS_KEY).', services: ['backup', 'compose'], scope: 'both' }),
    s3SecretKey: v({ name: 'BACKUP_S3_SECRET_KEY', example: '', type: string, secret: true, doc: 'Secret of BACKUP_S3_ACCESS_KEY.', services: ['backup', 'compose'], scope: 'both' }),
    s3Region: v({ name: 'BACKUP_S3_REGION', example: '', type: string, doc: 'Region of the backup bucket.', services: ['backup', 'compose'], scope: 'both' }),
    s3Prefix: v({ name: 'BACKUP_S3_PREFIX', example: '', type: string, doc: 'Key prefix of the backups (default backups/postgres).', services: ['backup', 'compose'], scope: 'both' })
  }
})
