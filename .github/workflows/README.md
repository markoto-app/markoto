# GitHub Actions workflows

These workflows power markoto's CI/CD:

- `ci.yml` — runs on every PR. Lint + typecheck + tests. Must be green to merge. Heavy jobs (`test-repos-integration-flows`, `sonar`) skip on docs-only PRs and Trivy image scans run only for images whose Dockerfile/deps changed — gated by the `changes` job (`dorny/paths-filter`), at job level, never workflow-level `paths:` (that would leave required checks pending forever). `.github/workflows/*.yml` changes always count as non-docs.
- `image-scan.yml` — reusable build + Trivy scan, called by `ci.yml` (PRs) and `image-scan-weekly.yml` (weekly cron + manual, all images on `main`).
- `release.yml` — runs on push to main (post-merge). Bumps version, builds + pushes images, creates Release.
- `deploy.yml` — runs on Release published. SSHes to VPS, deploys, auto-rollbacks on health failure.

See `docs/RELEASE-PROCESS.md` for the user-facing release flow + `docs/GITHUB-CONFIG.md` for required secrets.

## How to iterate on these workflows

Workflows are notoriously hard to test offline — most non-trivial bugs only surface when GitHub itself executes the YAML against the real event payload. The fast feedback loop:

### 1. Static checks (run locally, instant)

```sh
make lint-actions    # runs actionlint
```

`actionlint` catches the bulk of mistakes: YAML schema, `${{ }}` expression typos, shellcheck-flagged bash, unpinned action versions, missing required inputs, untrusted-input injection in inline scripts. The same job (`actions-lint`) runs on every PR — branch protection blocks merges that introduce a regression.

To install the binary locally:

```sh
bash <(curl -sSL https://raw.githubusercontent.com/rhysd/actionlint/v1.7.12/scripts/download-actionlint.bash) 1.7.12 ~/.local/bin
actionlint --version
```

For best results also install `shellcheck` so actionlint can lint embedded shell — `apt install shellcheck` on Debian/Ubuntu, `brew install shellcheck` on macOS.

### 2. Job-level dry-run (run locally with act, ~30s)

[`act`](https://github.com/nektos/act) runs Actions workflows in Docker containers locally:

```sh
brew install act        # macOS; see act docs for Linux
act -j lint-typecheck   # exercises the lint-typecheck job from ci.yml
act pull_request        # simulates a full PR-event run
```

Limitations:

- `act` can't authenticate as `${{ secrets.GITHUB_TOKEN }}`, so anything that pushes to GHCR or creates Releases will fail. Skip those jobs for `act`.
- Some GitHub-API-only steps (the `github-script` blocks reading PR labels, `softprops/action-gh-release`) won't behave identically. Verify those via real PR.
- The `--secret-file` flag lets you pass real secrets locally for testing: `act -j ... --secret-file .secrets`. **Don't commit `.secrets`** — it's covered by `.gitignore`.

### 3. Real-PR exercise (the canonical iteration loop)

Workflow changes that touch GitHub-API-coupled steps (release creation, deploy SSH, branch-protection bypass) need a real PR:

1. Branch from main: `git checkout -b workflow-changes`.
2. Edit `.github/workflows/*.yml`.
3. Commit + push.
4. Open a **draft** PR against main. CI runs the cheap jobs (`actions-lint`, `lint-typecheck`, `test-unit-dom`); the heavy `test-repos-integration-flows` job is skipped on drafts.
5. Iterate the YAML in the same branch — push corrections; CI re-runs.
6. When green, mark PR ready-for-review (triggers heavy integration job). Iterate.
7. To test the release+deploy path: add a `release:patch` label, merge. Pipeline fires. The first time, expect to investigate logs and push corrective commits.

## Things `actionlint` won't catch

- "This workflow uses a secret that doesn't exist in repo settings" — the secret reference is syntactically valid; `actionlint` can't know what's actually configured. First failed run on a real PR surfaces it.
- "This Action's behaviour changed in v4.2.1" — actionlint checks reference syntax, not action version semantics. Renovate handles version bumps.
- "The PAT used here doesn't have `packages:write` scope" — same. Surface only on first real run.
- Logic errors in `if:` conditions — e.g. `if: needs.foo.outputs.bar == 'true'` when `bar` is actually emitted as `True`. Test with a draft PR.

## Things to NOT do

- Don't `uses: foo/bar@main` — pin to a specific tag (`@v3` minimum, exact-sha better). Renovate won't bump unpinned floating refs.
- Don't `permissions: write-all` — declare granular permissions per workflow. Default repo `permissions` should be `contents: read`.
- Don't write inline `${{ }}` referencing user-controlled context (`github.head_ref`, `github.event.pull_request.title`, comment bodies, etc.) inside `run:` shell — that's a script-injection vector. Pipe through an `env:` block instead. `actionlint` flags this.
- Don't commit `.secrets` files used for local `act` testing — gitignored.
- Don't use `--no-verify` to skip pre-commit hooks on workflow changes; those checks exist precisely to gate workflow regressions.
