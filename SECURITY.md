# Security Policy

markoto is a source-available project and a hosted service ([markoto.app](https://markoto.app)), operated by LatentSpace Labs GmbH, Zurich. We take vulnerability reports seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Please report vulnerabilities privately. Do not open a public issue, discussion or pull request for a security problem.**

Preferred: GitHub private vulnerability reporting.

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability** (direct link: <https://github.com/joelbarmettlerUZH/markoto.app/security/advisories/new>).
3. Describe the issue.

Alternative: email **[joel@latentspace-labs.ch](mailto:joel@latentspace-labs.ch)**.

Please include:

- A description of the issue and its impact
- Steps to reproduce (a proof of concept helps a lot)
- The affected surface: markoto.app, staging.markoto.app, or a self-hosted deployment of this repository (and the release tag or commit)
- Whether the issue is already public

## What to expect

- **Acknowledgement within 72 hours.** We are a small team, but we read every report.
- We will confirm the issue, keep you informed while we fix it, and coordinate a disclosure date with you. We aim to ship fixes for confirmed high-severity issues quickly and to publish a GitHub security advisory once a fix is available.
- We credit reporters in the advisory and release notes unless you prefer to stay anonymous.
- There is currently no paid bug bounty program.

## Supported versions

Security fixes are made for:

| Version | Supported |
|---|---|
| The latest release (and `main`) | Yes |
| Older releases | No. Upgrade to the latest release ([upgrade guide](./docs/SELF-HOSTING.md#upgrades)). |

markoto is pre-1.0 and ships forward-only database migrations, so we do not backport fixes to older release lines.

## Scope

In scope:

- The application code in this repository (Nuxt app, sync server, renderer, MCP server, installer, compose files, infrastructure templates)
- The hosted service at markoto.app

Out of scope:

- Denial-of-service and volumetric attacks against the hosted service
- Findings that require a compromised device, physical access, or an already-compromised host or Docker daemon
- Misconfiguration of your own self-hosted deployment that contradicts [docs/SELF-HOSTING.md](./docs/SELF-HOSTING.md) (for example exposing internal ports that the compose files keep private)
- Vulnerabilities in third-party services markoto integrates with (AI providers, Stripe, Resend, ...); report those upstream
- Automated scanner output without a demonstrated impact
- Missing security headers or best-practice hardening without a concrete exploit

## Testing against the hosted service

Limited, non-destructive testing against your **own** account and documents on markoto.app is fine. Do not access, modify or delete other users' data, do not run load or automated scanning tools against the service, and do not use social engineering. If a vulnerability gives you accidental access to someone else's data, stop and report it immediately.

## Safe harbour

We will not pursue legal action against researchers who follow this policy, act in good faith, avoid privacy violations and data destruction, and give us reasonable time to fix an issue before disclosing it.
