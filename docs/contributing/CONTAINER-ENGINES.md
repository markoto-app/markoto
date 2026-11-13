# Container engines: Docker and Podman

Every compose stack (dev, test, flows, local, self-host) runs on **Docker** and on **rootless Podman** (Podman's Docker-compatible API driven by `docker compose` ≥ 5). Docker needs no extra settings. Podman needs a short `.env` block and, for some stacks, an overlay file.

The hosted deployment (staging, prod) runs **only** on rootless Podman: see "Hosted deployment" below and `infra/README.md`.

## Quick start on Podman

Point the Docker CLI at Podman's socket (most Podman setups already do this, e.g. through the `podman-docker` package or `DOCKER_HOST`):

```bash
export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/podman/podman.sock
systemctl --user enable --now podman.socket
```

Add to `.env` (Compose and Bun both read it):

```bash
# Test stack: a private address of this machine (Wi-Fi / Ethernet), see below.
TEST_FAKE_OPENAI_HOST=192.168.1.54
# Only if containers can't reach the host through host.containers.internal (see "VPNs").
# CONTAINER_HOST_ADDRESS=192.168.1.54
# Local / self-host stacks: the engine socket Traefik's socket proxy reads.
CONTAINER_SOCKET=/run/user/1000/podman/podman.sock
```

Then use the usual commands:

| Stack | Command |
|---|---|
| Integration tests | `bun run test:integration:up`, `bun run test:integration`, `bun run test:integration:down` |
| Flow tests | `bun run flows:test` |
| Dev infra | `docker compose --env-file .env -f deploy/compose/compose.dev.yml -f deploy/compose/compose.podman.yml up -d` |
| Local full stack | `docker compose --env-file .env -f deploy/compose/compose.local.yml -f deploy/compose/compose.podman.yml up -d --build` |
| Self-host | `./install.sh` (detects Podman and adds the overlay itself) |

The test-stack scripts go through `scripts/test-compose.sh`, which detects Podman and adds `deploy/compose/compose.test.podman.yml`. Force a choice with `TEST_CONTAINER_ENGINE=docker|podman`.

## What differs, and why

| Difference | Symptom on Podman | Fix in the repo |
|---|---|---|
| **Seccomp profile transport.** Compose reads `seccomp=../config/renderer/seccomp.json` and sends the profile's JSON to the engine (Docker's API contract). Podman's compatible API reads that value as a file path. | `opening seccomp profile failed: open {"defaultAction":… : file name too long` | `deploy/compose/compose.podman.yml` / `deploy/compose/compose.test.podman.yml`: the renderer uses Podman's default profile (which already allows the user-namespace syscalls Chromium's sandbox needs) plus `CAP_SYS_CHROOT` (the one thing it blocks: `Check failed: sys_chroot(...)`). Podman hands that capability to the non-root `pwuser` as an ambient capability; it changes the root directory inside the container's own mount namespace and grants nothing outside it. Chromium keeps its sandbox. |
| **SELinux** (Fedora, RHEL; applies to Docker with SELinux enabled too) | `Permission denied` on bind-mounted repo files (`db-init.sh`, LiteLLM config); the socket proxy answers 503 | Bind mounts of repo files carry `:z` (relabel; ignored without SELinux). The socket proxy runs with `label=disable`, it is the only container that touches the engine socket. |
| **Unprivileged low ports.** Docker sets `net.ipv4.ip_unprivileged_port_start=0` in every container; Podman does not. | Traefik (no capabilities): `listen tcp :80: bind: permission denied` | Traefik sets the sysctl itself (`deploy/compose/compose.local.yml`, `deploy/compose/compose.selfhost.yml`, `deploy/compose/compose.prod.yml`, `deploy/compose/compose.test.yml`). |
| **Image healthchecks.** Podman builds OCI images, which drop `HEALTHCHECK`. | `container … has no healthcheck configured` on `depends_on: service_healthy` | The compose files declare the same healthchecks as the Dockerfiles (app, sync, markitdown, renderer). |
| **No host-side bridge gateway.** Rootless Podman's networks live in its own network namespace. | `rootlessport listen tcp 10.213.47.1:4120: bind: cannot assign requested address` | `TEST_FAKE_OPENAI_HOST`: publish the fake AI provider on a private host address instead. Both the app (on the host) and LiteLLM (in a container) use it, and the BYOK SSRF policy accepts it (private, not loopback). It is a test fake with no secrets; it is reachable from your LAN while the stack runs. |
| **Engine socket path.** Rootless Podman listens on `$XDG_RUNTIME_DIR/podman/podman.sock`. | Traefik finds no containers | `CONTAINER_SOCKET` (default `/var/run/docker.sock`). `install.sh` sets it; on the hosted stack `markoto-compose` exports it (required there). |
| **Client address behind published ports.** Rootless publishing goes through `rootlessport`, a userspace proxy: the container sees the proxy's address (its own IP on one of its networks), not the client's. Podman 6 has an experimental pasta forwarder (`rootless_port_forwarder`) that keeps it; Podman 5.4 (Debian 13) has none. | Every request reaches Traefik from one internal address: per-IP rate limits and audit IPs collapse | Hosted: `edge-proxy` binds 80/443 in the host network namespace and passes the client address in a PROXY protocol v2 header to Traefik, published on loopback only; Traefik trusts the header from its own two networks, whose subnets are pinned (`deploy/compose/compose.prod.yml`, `deploy/config/edge/haproxy.cfg`). Self-host on Podman: put a proxy that sets `X-Forwarded-For` in front and list it in `TRAEFIK_TRUSTED_IPS`, or accept one address for all clients. |
| **Rootless low ports on the host.** Publishing ports below `net.ipv4.ip_unprivileged_port_start` (1024 on most distributions; Fedora: 80) needs privileges. | Self-host on port 80 fails to start | `install.sh` warns. Choose a higher port or lower the sysctl on the host. |

## VPNs and `host.docker.internal`

Containers reach the host (the app during tests, the dev server) through `host.docker.internal`, which Compose maps to `host-gateway`. Rootless Podman maps that to `169.254.1.2`, which pasta forwards to the host address of the interface that carries the default route. Some VPN clients (for example the Proton VPN kill switch, interface `pvpnksintrf0`) put the default route on a dummy interface whose address nobody listens on, and every connection times out.

Fix: set `CONTAINER_HOST_ADDRESS` to a real private address of the host (your Wi-Fi or Ethernet address). Every `host.docker.internal` entry in the dev and test stacks resolves to it. The app must listen on that address (`bun run dev --host 0.0.0.0`, and the integration server binds all interfaces).

## Checking a change on both engines

`scripts/selfhost-check.sh` runs on either engine (it builds `localhost/markoto-backup-ci` with `--load`, which also works when the Docker CLI's buildx builder runs in a container). CI runs everything on Docker; when you change a compose file, a stack bring-up on Podman with the commands above is the Podman check.

## Hosted deployment

Staging and prod are Debian 13 VPSs running the stack on rootless Podman
5.4 as the unprivileged `markoto` user. Provisioning (Ansible,
`infra/playbooks/provision.yml`) installs Debian's Podman and pasta, the
pinned Docker Compose 5.7.0 binary and the `markoto-compose` wrapper; the
deploy workflow (`.github/workflows/deploy.yml`) logs in as `markoto` and
runs `markoto-compose pull` / `up -d`. The rendered `.env` sets
`COMPOSE_FILE=deploy/compose/compose.prod.yml:deploy/compose/compose.podman.yml`,
so the hosted stack gets the same renderer overlay as every other Podman
stack. What the hosted stack does differently:

- `edge-proxy` (HAProxy, `network_mode: host`) owns ports 80/443 and relays
  TCP with PROXY protocol v2 to Traefik on `127.0.0.1:10080/10443` (the
  client-address row above). The host lowers
  `net.ipv4.ip_unprivileged_port_start` to 80 for it.
- The socket proxy mounts `${CONTAINER_SOCKET}` (no default), the user's
  Podman socket.
- `traefik/acme.json` is owned by `markoto`, which is root inside the user
  namespace, so Traefik needs no `DAC_OVERRIDE`.
- The bundled Postgres runs only with `COMPOSE_PROFILES=bundled-postgres`
  (staging); prod uses the managed cluster and has no Postgres container.

To inspect the hosted shape locally, render it from the repository root
with a `.env` produced by `infra/render-env.sh` and `CONTAINER_SOCKET` set:
`CONTAINER_SOCKET=/run/user/1000/podman/podman.sock docker compose --env-file <that .env> config`.
`bash scripts/selfhost-check.sh` asserts its invariants.

