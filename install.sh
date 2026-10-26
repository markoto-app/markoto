#!/usr/bin/env bash
# markoto self-host installer.
#
#   ./install.sh                    interactive first install (or re-configure)
#   ./install.sh -y --http-port 8080 --admin-email you@example.org
#   ./install.sh -y --domain docs.example.org --acme-email you@example.org
#   ./install.sh upgrade [--tag v1.2.3]     pull (or rebuild) and restart
#   ./install.sh status | logs [service] | reembed [--dry-run] | help
#
# Safe to re-run: existing secrets in .env are never regenerated or
# printed; answers default to the current values. Full guide:
# docs/SELF-HOSTING.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${MARKOTO_ENV_FILE:-$ROOT/.env}"
# The compose files override services they `include:` from the shared base.
# Compose 2.24-2.40 reject that ("conflicts with imported resource"); it is
# allowed again since v5.0.0 (compose-go#835).
MIN_COMPOSE="5.0.0"
HEALTH_TIMEOUT="${MARKOTO_HEALTH_TIMEOUT:-900}"
ENV_MARKER="# markoto self-host configuration"

# ─── Output helpers ────────────────────────────────────────────────────
if [ -t 1 ]; then BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; RESET=$'\033[0m'
else BOLD=""; DIM=""; RED=""; GREEN=""; RESET=""; fi
info() { printf '%s\n' "${BOLD}==>${RESET} $*"; }
note() { printf '%s\n' "    $*"; }
ok() { printf '%s\n' "${GREEN}ok${RESET}  $*"; }
warn() { printf '%s\n' "${RED}!!${RESET}  $*" >&2; }
die() { printf '%s\n' "${RED}error:${RESET} $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
markoto self-host installer

Commands:
  install (default)  configure .env (asks, or takes flags) and start the stack
  upgrade            pull new images (or rebuild with --build) and restart
  status             show container status
  logs [service]     follow logs
  reembed [args]     re-embed the knowledge base after changing the
                     embeddings model (args: --dry-run, --force, ...)
  help               this text

Install options (each also readable from the environment variable shown):
  -y, --yes                     non-interactive: never prompt (MARKOTO_YES=1)
  --domain NAME                 HTTPS with Let's Encrypt for NAME (MARKOTO_DOMAIN)
  --acme-email EMAIL            Let's Encrypt account email (ACME_EMAIL)
  --http-port PORT              plain-HTTP mode on PORT (MARKOTO_HTTP_PORT)
  --public-url URL              public URL in HTTP mode, e.g. https://docs.example.org
                                when behind your own TLS proxy (MARKOTO_PUBLIC_URL)
  --trusted-proxy CIDR          your own proxy in front of this stack (TRAEFIK_TRUSTED_IPS)
  --admin-email EMAIL[,EMAIL]   instance admins (NUXT_ADMIN_USER_EMAILS)
  --github-client-id ID         GitHub OAuth app (NUXT_OAUTH_GITHUB_CLIENT_ID)
  --github-client-secret S      (NUXT_OAUTH_GITHUB_CLIENT_SECRET)
  --google-client-id ID         Google OAuth client (NUXT_OAUTH_GOOGLE_CLIENT_ID)
  --google-client-secret S      (NUXT_OAUTH_GOOGLE_CLIENT_SECRET)
  --oidc-issuer URL             your own OpenID Connect provider (NUXT_OAUTH_OIDC_ISSUER)
  --oidc-client-id ID           (NUXT_OAUTH_OIDC_CLIENT_ID)
  --oidc-client-secret S        (NUXT_OAUTH_OIDC_CLIENT_SECRET)
  --oidc-name NAME              sign-in button label, e.g. Authentik (NUXT_OAUTH_OIDC_NAME)
  --mistral-api-key KEY         Mistral as the instance AI default: chat, voice (MISTRAL_API_KEY)
  --jina-api-key KEY            knowledge-base embeddings + fetch_url tool (JINA_AI_API_KEY)
  --staan-api-key KEY           web_search tool (STAAN_API_KEY)
  --tag TAG                     image tag (IMAGE_TAG; default: checked-out release tag, else latest)
  --build                       build images from this checkout instead of pulling
  --no-backup                   don't run the encrypted backup sidecar
  --instance NAME               compose project / instance name (MARKOTO_INSTANCE, default markoto)
  --env-file PATH               where to keep the configuration (MARKOTO_ENV_FILE, default ./.env)
  --no-start                    write .env only
EOF
}

# ─── .env access ───────────────────────────────────────────────────────
# Values are written single-quoted: compose treats them literally (no
# $-interpolation), so generated or pasted secrets can't be mangled.
env_get() {
  local key="$1" line
  [ -f "$ENV_FILE" ] || return 0
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)"
  line="${line#*=}"
  line="${line#\'}"
  line="${line%\'}"
  printf '%s' "$line"
}

env_set() {
  local key="$1" value="$2" tmp
  case "$value" in *"'"* | *$'\n'*) die "value for $key must not contain a single quote or newline" ;; esac
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  chmod 600 "$tmp"
  if [ -f "$ENV_FILE" ] && grep -qE "^${key}=" "$ENV_FILE"; then
    # Replace in place; the value travels via the environment, never argv.
    KEY="$key" VALUE="$value" awk -F= '
      BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"] }
      $1 == k { print k "='\''" v "'\''"; next }
      { print }
    ' "$ENV_FILE" > "$tmp"
  else
    if [ -f "$ENV_FILE" ]; then cat "$ENV_FILE" > "$tmp"; fi
    printf "%s='%s'\n" "$key" "$value" >> "$tmp"
  fi
  mv "$tmp" "$ENV_FILE"
}

# Generate a secret once; never touch an existing one.
ensure_secret() {
  local key="$1" kind="$2" value
  if [ -n "$(env_get "$key")" ]; then return 0; fi
  case "$kind" in
    hex) value="$(openssl rand -hex 32)" ;;
    sk) value="sk-$(openssl rand -hex 32)" ;;
    key) value="$(openssl rand -hex 16)" ;;
    *) die "unknown secret kind $kind" ;;
  esac
  env_set "$key" "$value"
}

# Set a config value: explicit flag/env wins, else keep the stored value,
# else the default.
set_config() {
  local key="$1" explicit="$2" default="${3:-}" current
  current="$(env_get "$key")"
  if [ -n "$explicit" ]; then env_set "$key" "$explicit"
  elif [ -z "$current" ] && [ -n "$default" ]; then env_set "$key" "$default"
  fi
}

# ─── Prompts ───────────────────────────────────────────────────────────
INTERACTIVE=1
ask() { # ask VAR "question" default
  local __var="$1" question="$2" default="${3:-}" reply=""
  if [ "$INTERACTIVE" = 1 ]; then
    if [ -n "$default" ]; then read -r -p "    $question [$default]: " reply
    else read -r -p "    $question: " reply; fi
  fi
  printf -v "$__var" '%s' "${reply:-$default}"
}
ask_secret() { # ask_secret VAR "question" — input hidden, never echoed
  local __var="$1" question="$2" reply=""
  if [ "$INTERACTIVE" = 1 ]; then
    read -r -s -p "    $question (input hidden, Enter to skip): " reply
    printf '\n'
  fi
  printf -v "$__var" '%s' "$reply"
}
ask_yes_no() { # ask_yes_no "question" default(y|n) → exit status
  local question="$1" default="$2" reply=""
  if [ "$INTERACTIVE" = 1 ]; then read -r -p "    $question [$default]: " reply; fi
  reply="${reply:-$default}"
  case "$reply" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

# ─── Prerequisites ─────────────────────────────────────────────────────
version_ge() { # version_ge A B → A >= B
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" = "$2" ]
}

check_prereqs() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed (https://docs.docker.com/engine/install/)"
  docker info >/dev/null 2>&1 || die "cannot talk to the docker daemon (is it running, and may this user use it?)"
  local v
  v="$(docker compose version --short 2>/dev/null || true)"
  [ -n "$v" ] || die "docker compose v2 is required (the 'docker compose' plugin)"
  v="${v#v}"
  version_ge "$v" "$MIN_COMPOSE" || die "docker compose $v is too old; need >= $MIN_COMPOSE"
  command -v openssl >/dev/null 2>&1 || die "openssl is required to generate secrets"
  command -v curl >/dev/null 2>&1 || die "curl is required"
  ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?'), compose $v"
}

compose() {
  docker compose --project-directory "$ROOT" --env-file "$ENV_FILE" "$@"
}

# ─── Configuration ─────────────────────────────────────────────────────
# Images matching the checked-out release keep compose files and images in
# step; any other checkout falls back to `latest`.
default_tag() {
  local tag=""
  if command -v git >/dev/null 2>&1 && [ -e "$ROOT/.git" ]; then
    tag="$(git -C "$ROOT" describe --tags --exact-match 2>/dev/null || true)"
  fi
  printf '%s' "${tag:-latest}"
}

host_ip() {
  local ip=""
  if command -v hostname >/dev/null 2>&1; then ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"; fi
  printf '%s' "${ip:-localhost}"
}

configure() {
  info "Configuration (${ENV_FILE})"
  if [ ! -f "$ENV_FILE" ]; then
    (umask 077 && printf '%s\n# Written by install.sh; edit freely. Secrets: keep this file private.\n' "$ENV_MARKER" > "$ENV_FILE")
  elif ! grep -qF "$ENV_MARKER" "$ENV_FILE"; then
    die "$ENV_FILE exists but was not written by install.sh (a development .env?). Use --env-file PATH for the self-host configuration."
  fi
  chmod 600 "$ENV_FILE"

  # Mode: domain (HTTPS) or plain HTTP.
  local previous_domain domain
  previous_domain="$(env_get MARKOTO_DOMAIN)"
  domain="${OPT_DOMAIN:-$previous_domain}"
  local http_port="${OPT_HTTP_PORT:-}"
  if [ -n "$OPT_HTTP_PORT" ]; then domain=""; fi
  if [ -z "$OPT_DOMAIN" ] && [ -z "$OPT_HTTP_PORT" ] && [ "$INTERACTIVE" = 1 ]; then
    note "Public domain for HTTPS (Let's Encrypt; DNS must point here, ports 80+443 open)."
    note "Leave empty for plain HTTP (LAN, or behind your own TLS reverse proxy)."
    ask domain "Domain" "$domain"
  fi

  local public_url sync_url acme_email
  if [ -n "$domain" ]; then
    acme_email="${OPT_ACME_EMAIL:-$(env_get ACME_EMAIL)}"
    [ -n "$acme_email" ] || ask acme_email "Email for Let's Encrypt" "${OPT_ADMIN_EMAIL:-}"
    [ -n "$acme_email" ] || die "--acme-email is required with --domain"
    public_url="https://${domain}"
    env_set MARKOTO_DOMAIN "$domain"
    env_set ACME_EMAIL "$acme_email"
    env_set MARKOTO_HTTP_PORT "80"
    env_set MARKOTO_PUBLIC_URL "$public_url"
    COMPOSE_FILES="docker-compose.selfhost.yml:docker-compose.selfhost.tls.yml"
  else
    env_set MARKOTO_DOMAIN ""
    http_port="${http_port:-$(env_get MARKOTO_HTTP_PORT)}"
    [ -n "$OPT_HTTP_PORT" ] || ask http_port "HTTP port" "${http_port:-80}"
    case "$http_port" in '' | *[!0-9]*) die "invalid HTTP port: $http_port" ;; esac
    env_set MARKOTO_HTTP_PORT "$http_port"
    # Explicit --public-url wins. Otherwise keep the stored URL, unless
    # there is none, the port was given explicitly, or we are switching
    # from HTTPS mode — then derive it from this host's address.
    public_url="${OPT_PUBLIC_URL:-$(env_get MARKOTO_PUBLIC_URL)}"
    if [ -z "$OPT_PUBLIC_URL" ]; then
      if [ -z "$public_url" ] || [ -n "$OPT_HTTP_PORT" ] || [ -n "$previous_domain" ]; then
        public_url="http://$(host_ip)"
        [ "$http_port" = 80 ] || public_url="${public_url}:${http_port}"
      fi
    fi
    [ -n "$OPT_PUBLIC_URL" ] || ask public_url "Public URL users will open" "$public_url"
    public_url="${public_url%/}"
    case "$public_url" in http://* | https://*) ;; *) die "public URL must start with http:// or https://" ;; esac
    env_set MARKOTO_PUBLIC_URL "$public_url"
    COMPOSE_FILES="docker-compose.selfhost.yml"
  fi
  case "$public_url" in
    https://*) sync_url="wss://${public_url#https://}/sync" ;;
    *) sync_url="ws://${public_url#http://}/sync" ;;
  esac
  env_set MARKOTO_SYNC_URL "$sync_url"
  set_config TRAEFIK_TRUSTED_IPS "$OPT_TRUSTED_PROXY" "127.0.0.1/32"
  if [ -n "$OPT_TRUSTED_PROXY" ]; then env_set NUXT_TRUSTED_PROXY_HOPS "2"; fi

  if [ "$OPT_BUILD" = 1 ] || [ "$(env_get MARKOTO_BUILD)" = 1 ]; then
    env_set MARKOTO_BUILD "1"
    COMPOSE_FILES="${COMPOSE_FILES}:docker-compose.selfhost.build.yml"
  fi
  env_set COMPOSE_FILE "$COMPOSE_FILES"
  env_set COMPOSE_PATH_SEPARATOR ":"
  set_config MARKOTO_INSTANCE "$OPT_INSTANCE" "markoto"
  env_set COMPOSE_PROJECT_NAME "$(env_get MARKOTO_INSTANCE)"
  set_config REGISTRY "" "ghcr.io/joelbarmettleruzh"
  set_config IMAGE_TAG "$OPT_TAG" "$(default_tag)"

  local backup_profile="backup"
  if [ "$OPT_NO_BACKUP" = 1 ]; then backup_profile=""
  elif [ -f "$ENV_FILE" ] && grep -qE '^COMPOSE_PROFILES=' "$ENV_FILE"; then backup_profile="$(env_get COMPOSE_PROFILES)"
  fi
  env_set COMPOSE_PROFILES "$backup_profile"

  # Secrets — generated once, never printed, never regenerated.
  set_config POSTGRES_USER "" "markoto"
  set_config POSTGRES_DB "" "markoto"
  ensure_secret POSTGRES_PASSWORD hex
  ensure_secret VALKEY_PASSWORD hex
  set_config VALKEY_DB "" "0"
  ensure_secret NUXT_SESSION_PASSWORD hex
  ensure_secret NUXT_JWT_SECRET hex
  ensure_secret NUXT_INTERNAL_API_SECRET hex
  ensure_secret NUXT_AI_DICTATE_JWT_SECRET hex
  ensure_secret LITELLM_MASTER_KEY sk
  ensure_secret LITELLM_SALT_KEY sk
  ensure_secret NUXT_S3_ACCESS_KEY key
  ensure_secret NUXT_S3_SECRET_KEY hex
  set_config NUXT_S3_BUCKET "" "markoto-files"
  ensure_secret BACKUP_GPG_PASSPHRASE hex

  # Admins.
  local admins="${OPT_ADMIN_EMAIL:-$(env_get NUXT_ADMIN_USER_EMAILS)}"
  if [ -z "$OPT_ADMIN_EMAIL" ] && [ "$INTERACTIVE" = 1 ]; then
    note "Admin email(s): these accounts get /admin on their first login."
    ask admins "Admin email" "$admins"
  fi
  env_set NUXT_ADMIN_USER_EMAILS "$admins"

  configure_oauth "$public_url"
  configure_ai
  ok "configuration written (secrets kept private in $ENV_FILE)"
}

configure_oauth() {
  local public_url="$1" gh_id gh_secret go_id go_secret oidc_issuer oidc_id oidc_secret oidc_name
  gh_id="${OPT_GH_ID:-$(env_get NUXT_OAUTH_GITHUB_CLIENT_ID)}"
  gh_secret="${OPT_GH_SECRET:-$(env_get NUXT_OAUTH_GITHUB_CLIENT_SECRET)}"
  go_id="${OPT_GO_ID:-$(env_get NUXT_OAUTH_GOOGLE_CLIENT_ID)}"
  go_secret="${OPT_GO_SECRET:-$(env_get NUXT_OAUTH_GOOGLE_CLIENT_SECRET)}"
  oidc_issuer="${OPT_OIDC_ISSUER:-$(env_get NUXT_OAUTH_OIDC_ISSUER)}"
  oidc_id="${OPT_OIDC_ID:-$(env_get NUXT_OAUTH_OIDC_CLIENT_ID)}"
  oidc_secret="${OPT_OIDC_SECRET:-$(env_get NUXT_OAUTH_OIDC_CLIENT_SECRET)}"
  oidc_name="${OPT_OIDC_NAME:-$(env_get NUXT_OAUTH_OIDC_NAME)}"

  if [ "$INTERACTIVE" = 1 ] && [ -z "$gh_id$go_id$oidc_issuer" ]; then
    info "Login (optional)"
    note "markoto signs users in with your own OpenID Connect provider (Authentik,"
    note "Keycloak, Authelia, Pocket ID, Zitadel, ...) and/or GitHub / Google OAuth."
    note "Without any, the instance is anonymous-only: documents work, but owning"
    note "documents, workspaces and AI need an account. Redirect / callback URLs:"
    note "  OpenID Connect: ${public_url}/auth/oidc   (scopes: openid email profile)"
    note "  GitHub: ${public_url}/auth/github   (github.com/settings/developers)"
    note "  Google: ${public_url}/auth/google   (console.cloud.google.com/apis/credentials)"
    case "$public_url" in http://localhost* | https://*) ;; *)
      warn "Login needs HTTPS (or http://localhost): browsers drop the secure OAuth cookies on plain http." ;;
    esac
    if ask_yes_no "Configure an OpenID Connect provider now?" "n"; then
      ask oidc_issuer "Issuer URL (as in its /.well-known/openid-configuration)" ""
      ask oidc_id "Client ID" ""
      ask_secret oidc_secret "Client secret"
      ask oidc_name "Button label (e.g. Authentik; empty = \"single sign-on\")" ""
    fi
    if ask_yes_no "Configure GitHub login now?" "n"; then
      ask gh_id "GitHub client ID" ""
      ask_secret gh_secret "GitHub client secret"
    fi
    if ask_yes_no "Configure Google login now?" "n"; then
      ask go_id "Google client ID" ""
      ask_secret go_secret "Google client secret"
    fi
  fi
  if [ -n "$gh_id" ] && [ -z "$gh_secret" ]; then die "GitHub client ID given without a secret"; fi
  if [ -n "$go_id" ] && [ -z "$go_secret" ]; then die "Google client ID given without a secret"; fi
  if [ -n "$oidc_issuer$oidc_id$oidc_secret" ] && { [ -z "$oidc_issuer" ] || [ -z "$oidc_id" ] || [ -z "$oidc_secret" ]; }; then
    die "OpenID Connect needs issuer, client ID and client secret together"
  fi
  case "$oidc_issuer" in "" | https://*) ;; *) die "the OpenID Connect issuer must be an https:// URL" ;; esac
  env_set NUXT_OAUTH_GITHUB_CLIENT_ID "$gh_id"
  env_set NUXT_OAUTH_GITHUB_CLIENT_SECRET "$gh_secret"
  env_set NUXT_OAUTH_GOOGLE_CLIENT_ID "$go_id"
  env_set NUXT_OAUTH_GOOGLE_CLIENT_SECRET "$go_secret"
  env_set NUXT_OAUTH_OIDC_ISSUER "$oidc_issuer"
  env_set NUXT_OAUTH_OIDC_CLIENT_ID "$oidc_id"
  env_set NUXT_OAUTH_OIDC_CLIENT_SECRET "$oidc_secret"
  env_set NUXT_OAUTH_OIDC_NAME "$oidc_name"
}

configure_ai() {
  local mistral="${OPT_MISTRAL:-$(env_get MISTRAL_API_KEY)}"
  local jina="${OPT_JINA:-$(env_get JINA_AI_API_KEY)}"
  local staan="${OPT_STAAN:-$(env_get STAAN_API_KEY)}"
  if [ "$INTERACTIVE" = 1 ] && [ -z "$mistral$jina$staan" ]; then
    info "AI (optional — everything else works without it)"
    note "Users can always bring their own key (Settings -> AI provider). Optionally"
    note "set instance-wide providers now; more options in docs/SELF-HOSTING.md#ai."
    ask_secret mistral "Mistral API key (instance default for chat + voice)"
    ask_secret jina "Jina API key (knowledge-base embeddings + fetch_url)"
    ask_secret staan "Staan API key (web_search)"
  fi
  env_set MISTRAL_API_KEY "$mistral"
  env_set JINA_AI_API_KEY "$jina"
  env_set STAAN_API_KEY "$staan"
  if [ -n "$mistral" ]; then
    set_config NUXT_AI_DEFAULT_CHAT_MODEL "" "mistral-small-2603"
    set_config NUXT_AI_DEFAULT_TRANSCRIBE_MODEL "" "voxtral-mini-transcribe"
  fi
}

# ─── Lifecycle ─────────────────────────────────────────────────────────
pull_or_build() {
  if [ "$(env_get MARKOTO_BUILD)" = 1 ]; then
    info "Building images from $ROOT (this takes a while the first time)"
    compose build
    return
  fi
  info "Pulling images (${DIM}$(env_get REGISTRY)/markoto-*:$(env_get IMAGE_TAG)${RESET})"
  if ! compose pull --quiet; then
    warn "Pulling failed (images not published for this tag, or the registry needs a login)."
    warn "Falling back to building from this checkout. Make it permanent with --build."
    env_set MARKOTO_BUILD "1"
    env_set COMPOSE_FILE "$(env_get COMPOSE_FILE):docker-compose.selfhost.build.yml"
    compose build
  fi
}

wait_healthy() {
  info "Starting; waiting for the app to become healthy (first boot runs migrations)"
  local waited=0 cid status=""
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    cid="$(compose ps -q app 2>/dev/null || true)"
    if [ -n "$cid" ]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)"
      if [ "$status" = "healthy" ]; then break; fi
    fi
    sleep 5
    waited=$((waited + 5))
  done
  if [ "$status" != "healthy" ]; then
    compose ps
    die "the app did not become healthy within ${HEALTH_TIMEOUT}s — inspect: ./install.sh logs app"
  fi
  ok "app container healthy"

  # /api/health is the gating probe (Postgres, Valkey, sync, renderer,
  # markitdown, LiteLLM). The per-component /api/health/deep needs a login.
  # Traefik runs its own health check on the app (every 10 s) before it
  # routes to it, and a certificate may still be being issued: retry.
  local url probe
  url="$(env_get MARKOTO_PUBLIC_URL)"
  if [ -n "$(env_get MARKOTO_DOMAIN)" ]; then probe="$url/api/health"
  else probe="http://127.0.0.1:$(env_get MARKOTO_HTTP_PORT)/api/health"; fi
  waited=0
  until curl -fsS --max-time 10 "$probe" >/dev/null 2>&1; do
    if [ "$waited" -ge 120 ]; then
      if [ -n "$(env_get MARKOTO_DOMAIN)" ]; then
        warn "not reachable at $url yet (certificate issuance can take a minute; check DNS + ports 80/443)"
      else
        warn "health check through Traefik ($probe) failed — ./install.sh logs traefik"
      fi
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
  done
  ok "serving at $url"
}

next_steps() {
  local url
  url="$(env_get MARKOTO_PUBLIC_URL)"
  info "markoto is running"
  note "Open:        ${BOLD}${url}${RESET}"
  if [ -z "$(env_get NUXT_OAUTH_GITHUB_CLIENT_ID)$(env_get NUXT_OAUTH_GOOGLE_CLIENT_ID)$(env_get NUXT_OAUTH_OIDC_ISSUER)" ]; then
    note "Login:       not configured (anonymous-only). Add an IdP or OAuth app: docs/SELF-HOSTING.md#login"
  fi
  note "Configure:   edit $ENV_FILE, then: docker compose up -d   (from $ROOT)"
  note "Upgrade:     ./install.sh upgrade [--tag vX.Y.Z]"
  note "Backups:     docs/SELF-HOSTING.md#backups (copy them off this machine)"
  note "Status:      ./install.sh status"
}

cmd_install() {
  check_prereqs
  configure
  if [ "$OPT_NO_START" = 1 ]; then ok "--no-start: configuration only"; return; fi
  pull_or_build
  compose up -d
  wait_healthy
  next_steps
}

cmd_upgrade() {
  check_prereqs
  [ -f "$ENV_FILE" ] || die "no $ENV_FILE — run ./install.sh first"
  grep -qF "$ENV_MARKER" "$ENV_FILE" || die "$ENV_FILE was not written by install.sh"
  if [ -n "$OPT_TAG" ]; then env_set IMAGE_TAG "$OPT_TAG"; fi
  # Secrets introduced by newer versions get generated; existing ones stay.
  ensure_secret NUXT_AI_DICTATE_JWT_SECRET hex
  ensure_secret BACKUP_GPG_PASSPHRASE hex
  info "Upgrading to image tag $(env_get IMAGE_TAG)"
  note "Database migrations run automatically when the app starts. Back up first:"
  note "docs/SELF-HOSTING.md#backups"
  pull_or_build
  compose up -d
  wait_healthy
  next_steps
}

# ─── Argument parsing ──────────────────────────────────────────────────
COMMAND="install"
OPT_DOMAIN="${MARKOTO_DOMAIN:-}"
OPT_ACME_EMAIL="${ACME_EMAIL:-}"
OPT_HTTP_PORT="${MARKOTO_HTTP_PORT:-}"
OPT_PUBLIC_URL="${MARKOTO_PUBLIC_URL:-}"
OPT_TRUSTED_PROXY="${TRAEFIK_TRUSTED_IPS:-}"
OPT_ADMIN_EMAIL="${NUXT_ADMIN_USER_EMAILS:-}"
OPT_GH_ID="${NUXT_OAUTH_GITHUB_CLIENT_ID:-}"
OPT_GH_SECRET="${NUXT_OAUTH_GITHUB_CLIENT_SECRET:-}"
OPT_GO_ID="${NUXT_OAUTH_GOOGLE_CLIENT_ID:-}"
OPT_GO_SECRET="${NUXT_OAUTH_GOOGLE_CLIENT_SECRET:-}"
OPT_OIDC_ISSUER="${NUXT_OAUTH_OIDC_ISSUER:-}"
OPT_OIDC_ID="${NUXT_OAUTH_OIDC_CLIENT_ID:-}"
OPT_OIDC_SECRET="${NUXT_OAUTH_OIDC_CLIENT_SECRET:-}"
OPT_OIDC_NAME="${NUXT_OAUTH_OIDC_NAME:-}"
OPT_MISTRAL="${MISTRAL_API_KEY:-}"
OPT_JINA="${JINA_AI_API_KEY:-}"
OPT_STAAN="${STAAN_API_KEY:-}"
OPT_TAG="${IMAGE_TAG:-}"
OPT_INSTANCE="${MARKOTO_INSTANCE:-}"
OPT_BUILD=0
OPT_NO_BACKUP=0
OPT_NO_START=0
if [ "${MARKOTO_YES:-0}" = 1 ] || [ ! -t 0 ]; then INTERACTIVE=0; fi


need_arg() {
  if [ $# -lt 2 ] || [ -z "$2" ]; then die "$1 needs a value"; fi
}
# Options may come before or after the command; everything after `logs` /
# `reembed` is passed through to them.
EXTRA_ARGS=()
COMMAND_SEEN=0
while [ $# -gt 0 ]; do
  if [ "$COMMAND" = logs ] || [ "$COMMAND" = reembed ]; then EXTRA_ARGS+=("$1"); shift; continue; fi
  case "$1" in
    install | upgrade | status | logs | reembed)
      [ "$COMMAND_SEEN" = 0 ] || die "only one command at a time (got '$COMMAND' and '$1')"
      COMMAND="$1"; COMMAND_SEEN=1 ;;
    help) usage; exit 0 ;;
    -y | --yes) INTERACTIVE=0 ;;
    --domain) need_arg "$@"; OPT_DOMAIN="$2"; shift ;;
    --acme-email) need_arg "$@"; OPT_ACME_EMAIL="$2"; shift ;;
    --http-port) need_arg "$@"; OPT_HTTP_PORT="$2"; shift ;;
    --public-url) need_arg "$@"; OPT_PUBLIC_URL="$2"; shift ;;
    --trusted-proxy) need_arg "$@"; OPT_TRUSTED_PROXY="$2"; shift ;;
    --admin-email) need_arg "$@"; OPT_ADMIN_EMAIL="$2"; shift ;;
    --github-client-id) need_arg "$@"; OPT_GH_ID="$2"; shift ;;
    --github-client-secret) need_arg "$@"; OPT_GH_SECRET="$2"; shift ;;
    --google-client-id) need_arg "$@"; OPT_GO_ID="$2"; shift ;;
    --google-client-secret) need_arg "$@"; OPT_GO_SECRET="$2"; shift ;;
    --oidc-issuer) need_arg "$@"; OPT_OIDC_ISSUER="$2"; shift ;;
    --oidc-client-id) need_arg "$@"; OPT_OIDC_ID="$2"; shift ;;
    --oidc-client-secret) need_arg "$@"; OPT_OIDC_SECRET="$2"; shift ;;
    --oidc-name) need_arg "$@"; OPT_OIDC_NAME="$2"; shift ;;
    --mistral-api-key) need_arg "$@"; OPT_MISTRAL="$2"; shift ;;
    --jina-api-key) need_arg "$@"; OPT_JINA="$2"; shift ;;
    --staan-api-key) need_arg "$@"; OPT_STAAN="$2"; shift ;;
    --tag) need_arg "$@"; OPT_TAG="$2"; shift ;;
    --instance) need_arg "$@"; OPT_INSTANCE="$2"; shift ;;
    --env-file) need_arg "$@"; ENV_FILE="$2"; shift ;;
    --build) OPT_BUILD=1 ;;
    --no-backup) OPT_NO_BACKUP=1 ;;
    --no-start) OPT_NO_START=1 ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option: $1 (see ./install.sh help)" ;;
  esac
  shift
done
if [ -n "$OPT_DOMAIN" ] && [ -n "$OPT_HTTP_PORT" ]; then die "--domain and --http-port are exclusive"; fi
case "$ENV_FILE" in /*) ;; *) ENV_FILE="$PWD/$ENV_FILE" ;; esac

case "$COMMAND" in
  install) cmd_install ;;
  upgrade) cmd_upgrade ;;
  status) compose ps ;;
  logs) compose logs -f --tail 200 "${EXTRA_ARGS[@]}" ;;
  reembed) compose exec app bun cli/reembed-knowledge.js "${EXTRA_ARGS[@]}" ;;
esac
