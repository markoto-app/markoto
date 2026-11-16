# GitHub Actions workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | every pull request (opened, synchronize, reopened, ready for review) | Release-label check, semantic PR title, actionlint, gitleaks, self-host compose check, lint (fast rules + type-aware rules as parallel jobs) + type checks, knip, dependency-cruiser, schema/migration drift, docs path + link checks, shellcheck + hadolint, ruff + pyright, migration guard, unit + DOM tests; on ready-for-review PRs that touch code also the repos + integration tiers with coverage (`test-repos-integration-flows`, which runs no Playwright flows despite its name), SonarCloud and Trivy scans of the images whose inputs changed; when billing code changed, the Stripe sandbox suite (`billing-sandbox`, not required, skips itself without the `STRIPE_SANDBOX_SECRET_KEY` repository secret). |
| `image-scan.yml` | called by `ci.yml` and `image-scan-weekly.yml` | Reusable image build + Trivy scan. |
| `release.yml` | push to `main` | Releases only when the merged PR carries `release:patch`, `release:minor` or `release:major`: bumps the version tag, builds, pushes and cosign-signs the five images, runs the full flow suite (skipped for docs-only releases), creates the GitHub Release from the PR title and body. |
| `publish-flow-shots.yml` | after every `release.yml` run, or manual | Opens a `release:none` PR that refreshes `public/flows/` from the release run's `flow-output` artifact. |
| `staging-gate.yml` | after a `release.yml` run that published a release, or manual | Deploys `latest` to staging through `deploy.yml`, then runs the public smoke suite. |
| `deploy.yml` | manual (`environment` + `tag`), or called by `staging-gate.yml` | SSHes to the VPS with pinned host keys (`.github/actions/setup-ssh`), renders `.env`, deploys and rolls back on a failed health check. |
| `sonar.yml`, `image-scan-weekly.yml` | weekly cron, or manual | SonarCloud and Trivy baselines on `main`. |

Path gating lives in the `changes` job of `ci.yml` (`dorny/paths-filter`) and is applied with job-level `if:`, never workflow-level `paths:`, because a workflow skipped by `paths:` leaves required checks pending forever while a skipped job satisfies them. Markdown, `docs/**`, `LICENSE` and the issue templates count as docs; workflow YAML always counts as code. Jobs that need high-value secrets bind a main-only Environment (`release`, `staging`, `prod`).

The release flow, the required secrets and the branch rules are described in the operator runbook, kept outside this repository; the required checks are listed in `CONTRIBUTING.md`.

## How to iterate on these workflows

Most workflow bugs only show up when GitHub runs the YAML against a real event payload. The feedback loop, from fastest to slowest:

### 1. Static checks (run locally, instant)

```sh
make lint-actions    # runs actionlint
```

`actionlint` catches most mistakes: YAML schema, `${{ }}` expression typos, shellcheck-flagged bash, missing required inputs, untrusted-input injection in inline scripts. The same check (`actions-lint`) runs on every PR and is required to merge. CI installs actionlint 1.7.12 from the release tarball and checks its SHA-256 first (`ACTIONLINT_SHA256` in `ci.yml`). The same on Linux x86-64:

```sh
curl --proto '=https' -fsSL -o /tmp/actionlint.tar.gz \
  https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz
echo "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8  /tmp/actionlint.tar.gz" | sha256sum -c -
tar -xzf /tmp/actionlint.tar.gz -C ~/.local/bin actionlint
actionlint --version
```

For best results also install `shellcheck` so actionlint can lint embedded shell, `apt install shellcheck` on Debian/Ubuntu, `brew install shellcheck` on macOS.

### 2. Job-level dry run with act

[`act`](https://github.com/nektos/act) runs Actions workflows in Docker containers locally:

```sh
brew install act        # macOS; see act docs for Linux
act -j lint-typecheck   # exercises the lint-typecheck job from ci.yml
act pull_request        # simulates a full PR-event run
```

Limitations:

- `act` can't authenticate as `${{ secrets.GITHUB_TOKEN }}`, so anything that pushes to GHCR or creates Releases will fail. Skip those jobs for `act`.
- GitHub-API steps (the `github-script` blocks that read PR labels, `softprops/action-gh-release`) don't behave the same. Check those on a real PR.
- `act -j ... --secret-file .secrets` passes secrets locally. `.secrets` is gitignored; never commit it.

### 3. A real pull request

Changes to steps that talk to the GitHub API (release creation, deploy over SSH) need a real PR:

1. Branch from main: `git checkout -b workflow-changes`.
2. Edit `.github/workflows/*.yml`.
3. Commit + push.
4. Open a **draft** PR against main. CI runs the cheap jobs (`actions-lint`, `lint-typecheck`, `test-unit-dom`); the heavy `test-repos-integration-flows` job is skipped on drafts.
5. Iterate the YAML in the same branch, push corrections; CI re-runs.
6. When green, mark the PR ready for review; that starts the heavy jobs.
7. The release and deploy path only runs after a maintainer merges a PR labelled `release:patch` (or `minor` / `major`); watch the `release` and `staging-gate` runs.

## Things `actionlint` won't catch

- "This workflow uses a secret that doesn't exist in repo settings", the secret reference is syntactically valid; `actionlint` can't know what's actually configured. First failed run on a real PR surfaces it.
- "This Action's behaviour changed in v4.2.1", actionlint checks reference syntax, not action behaviour. Dependabot moves the pinned versions; read the changelog when it does.
- "The token used here lacks the `packages:write` scope", same; it shows on the first real run.
- Logic errors in `if:` conditions, e.g. `if: needs.foo.outputs.bar == 'true'` when `bar` is actually emitted as `True`. Test with a draft PR.

## Things not to do

- Don't `uses: foo/bar@v3` or `@main`, pin every third-party action to its full commit SHA with a `# vX.Y.Z` comment (Dependabot moves the pins).
- Don't `permissions: write-all`: every workflow starts from `permissions: {}` and each job grants itself only what it needs.
- Don't put a high-value secret at repo level or in job-wide `env:`, use a main-only Environment and bind it to the step that needs it (the operator runbook, kept outside this repository).
- Don't `ssh-keyscan` or `StrictHostKeyChecking=no` in a deploy path, host keys come from the pinned `DEPLOY_KNOWN_HOSTS`.
- Don't write inline `${{ }}` referencing user-controlled context (`github.head_ref`, `github.event.pull_request.title`, comment bodies, etc.) inside `run:` shell, that's a script-injection vector. Pipe through an `env:` block instead. `actionlint` flags this.
