# Changelog

All notable changes to markoto will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The canonical release log lives in [GitHub Releases](https://github.com/joelbarmettlerUZH/markoto/releases):
every merge to `main` produces one release, named and described from the merged
PR's title + body, with the version derived from the git tag history. See
[`docs/RELEASE-PROCESS.md`](./docs/RELEASE-PROCESS.md) for the labelling guide.

## [Unreleased]

(Populated on next release. Each entry is sourced verbatim from the merged PR's title + description — see `docs/RELEASE-PROCESS.md`.)

## [0.2.0] — 2026-10-29

Security hardening release plus custom CSS, invite acceptance and AI confirmations.
Full notes: the GitHub Release for v0.2.0.

## [0.1.0] — 2026-08-18

First public release of the markoto source tree.

markoto was developed in a private repository from April 2026; this release
opens the source under the [FSL-1.1-ALv2](./LICENSE) license. Everything
described in the README shipped before this point: the collaborative CRDT
editor, paged preview + server-rendered PDF export, workspaces with a
knowledge base, the AI writing assistant (EU-resident providers via a
self-hosted LiteLLM proxy), the MCP server, Stripe billing, and the
GDPR/DSA privacy infrastructure.
