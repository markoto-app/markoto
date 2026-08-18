# Security Policy

markoto is a hosted SaaS ([markoto.app](https://markoto.app)) and a
source-available project operated by LatentSpace Labs GmbH, Zurich.
We take vulnerability reports seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Email: [joel@latentspace-labs.ch](mailto:joel@latentspace-labs.ch)**

Please include:

- A description of the issue and its impact
- Steps to reproduce (a proof of concept helps a lot)
- The affected surface (markoto.app, staging.markoto.app, or a self-hosted deployment of this repo)

Please do **not** open a public GitHub issue for security problems.

## What to expect

- **Acknowledgement within 72 hours.** We are a small team; we read every report.
- We'll keep you informed while we validate and fix the issue, and we'll credit
  you in the release notes if you'd like (or keep you anonymous — your choice).
- There is currently no paid bug bounty program.

## Scope

In scope:

- The application code in this repository (Nuxt app, sync server, renderer,
  MCP server, infrastructure templates)
- The hosted service at markoto.app

Out of scope:

- Denial-of-service / volumetric attacks against the hosted service
- Findings that require a compromised device or physical access
- Vulnerabilities in third-party services we integrate (Stripe, Mistral, etc.) —
  please report those upstream
- Automated scanner output without a demonstrated impact

## Testing against the hosted service

Limited, non-destructive testing against your **own** account and documents on
markoto.app is fine. Do not access, modify, or delete other users' data; if a
vulnerability gives you accidental access to someone else's data, stop and
report it immediately.
