# markoto

Collaborative markdown editor: Y.js CRDT + Hocuspocus sync, OAuth (GitHub/Google), PostgreSQL (with pgvector), external S3, multi-lingual UI, Gemini-powered AI writing assistance with workspace knowledge-base retrieval. Single Linux VPS, Docker Compose. Login is optional — public docs work anonymously.

## Quick start

1. **Develop locally:** `make dev` (starts infra), then `make dev-app` (runs Nuxt on the host).
2. **Run tests:** `make test` (quick: lint + typecheck + unit + dom + repos) or `make test-all` (everything, ~15min).
3. **Discover commands:** `make help` for an interactive menu — every common workflow surfaces there.
4. **Deploy:** see `docs/DEPLOY-OVH.md`. Once the VPS is provisioned: `make deploy`.

If lost: `docs/CHEATSHEET.md` is the use-case-keyed flat reference.
For 3 AM problems: `docs/RUNBOOK.md`.
For architecture: `AGENTS.md` (with per-area sub-AGENTS.md files in `app/`, `server/`, `sync-server/`, etc.).

## Command discovery

| What | Where |
|---|---|
| Root task runner (dev, test, lint, deploy) | `make help` |
| Ansible/deploy subcommands | `cd infra && make help` |
| All npm-style scripts | `bun run` |
| Use-case-keyed flat reference | `docs/CHEATSHEET.md` |

## License

markoto is licensed under the Functional Source License, Version 1.1 with Apache 2.0 future grant. You can use, modify, and self-host markoto for any purpose EXCEPT competing with markoto as a commercial offering. Two years after each release, that release converts to Apache 2.0.

See [LICENSE](./LICENSE) for full terms. Learn more at https://fsl.software.
