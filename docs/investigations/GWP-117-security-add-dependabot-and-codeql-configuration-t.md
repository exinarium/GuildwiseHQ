# Dependabot and CodeQL configuration for GuildwiseHQ: design

Status: design, ready to build. Configuration and docs only. No application code, no dependency changes, and no repository
setting is switched on.

## Question

GuildwiseHQ has never run code scanning, and Dependabot has no version-update configuration. What repository-side
configuration lets the owner switch on Dependabot and CodeQL code scanning, with no change to the existing CI? And which
settings does the owner have to switch on?

## Findings

### What is in the repository (commit d85ae1e5, release 1.5.0)

| Area | Found | Consequence |
| --- | --- | --- |
| `.github/` | `workflows/ci.yml`, `workflows/dco.yml`, `FUNDING.yml`, `ISSUE_TEMPLATE/`, `PULL_REQUEST_TEMPLATE.md`. No `dependabot.yml`, no CodeQL workflow. | Both files are new. Nothing gets extended or duplicated. |
| Action pinning | Every action is pinned by full commit SHA with the version in a comment (`actions/checkout@3d3c42e5… # v7.0.1`). Both workflows have a header comment, top-level `permissions: contents: read`, `runs-on: ubuntu-24.04`, `timeout-minutes` and `persist-credentials: false`. | The new workflow follows the same style. |
| Default branch | `main` (ci.yml `push: branches: [main]`). | CodeQL triggers on `main`. |
| npm / pnpm | Root `package.json` (`packageManager: pnpm@12.8.1`), `pnpm-workspace.yaml` (packages `packages/*`, `apps/*`, `e2e`, plus `overrides` and `minimumReleaseAgeExclude`), `pnpm-lock.yaml` (lockfile 9.0, two YAML documents). | One `npm` entry at `/` covers the whole workspace (Dependabot uses the `npm` ecosystem for pnpm). |
| Docker | `Dockerfile` (3× `node:22.23-bookworm-slim`), `media/Dockerfile` (`node:22.23-alpine`, `caddy:2-alpine`), `apps/runner/test/fixtures/{sshd,gitssh}/Dockerfile` (`alpine:3.20`). | `docker` ecosystem. |
| Docker Compose | `docker-compose.dev.yml`, `docker-compose.prod.yml` (`postgres:18`, `axllent/mailpit:latest`, `caddy:2`, `${AOM_MEDIA_IMAGE:-aom-media:latest}`). | `docker-compose` is a separate Dependabot ecosystem and is present, so it gets an entry. |
| Others | No `*.csproj`/NuGet, Python, Go, Cargo, Ruby, Maven or Gradle manifests. No submodules (`.gitmodules` is not tracked). `.nvmrc` is not something Dependabot manages. | No more ecosystems. |
| CodeQL languages | TypeScript/JavaScript (all apps and packages) and GitHub Actions workflows. Nothing compiled in another CodeQL language. | Matrix: `actions`, `javascript-typescript`, both `build-mode: none`. |
| Security docs | `SECURITY.md` (root, links `docs/security/public-forms.md`), `docs/security/public-forms.md`. | Add `docs/security/github-settings.md` and link it from `SECURITY.md`. |

### The planner's open questions

1. **Should the Docker test fixtures be covered? Yes.** `apps/runner/test/helpers/sshd.ts` builds
   `fixtures/sshd` (and the git-over-ssh fixture) with `docker build` whenever Docker can be used. Docker can be used on the
   `ubuntu-24.04` hosted runner, so CI's "Runner tests" job builds and runs these images, and a base-image bump is
   tested before merge. `alpine:3.20` reached end of life in April 2026, so updates there are useful. The fixtures are
   listed in the same `docker` entry through a `directories` glob, and grouped minor/patch keeps them to one pull request.
2. **Can the CodeQL run go green before the owner enables code scanning? Yes, on a public repository, as long as CodeQL
   "default setup" is not enabled.** The repository is public (`SECURITY.md` points to private vulnerability reporting
   on `github.com/exinarium/GuildwiseHQ`; `FUNDING.yml`). On a public repository, an advanced-setup workflow can upload
   SARIF without any setting being switched on, and the first upload starts code scanning. The run fails in two
   situations: (a) default setup is enabled, which gives the error "CodeQL analyses from advanced configurations cannot
   be processed when the default setup is enabled", or (b) the repository is private and has no GitHub Code Security.
   Neither is expected, but the builder cannot push, so the PR description must say which of the two to check if the run
   is red. The workflow is validated locally either way (see the test plan).

### Things the builder and owner must know

- **DCO on Dependabot pull requests.** `dco.yml` fails every PR that has a commit without a `Signed-off-by:` line.
  Dependabot's commits have no such line, so every Dependabot PR fails the DCO check. The card forbids changing existing
  CI, so this card leaves `dco.yml` alone. The owner checklist names the issue. A follow-up to exempt `dependabot[bot]` in
  `dco.yml` is filed as a backlog suggestion.
- **pnpm minimum release age.** pnpm 11+ defaults `minimumReleaseAge` to one day, and this repository relies on that
  (see `minimumReleaseAgeExclude`). A Dependabot version update to a release younger than the policy can fail on
  install. `cooldown: default-days: 3` keeps version updates past that age. The cooldown does not apply to *security*
  updates, which may still hit the policy. When that happens, the fix is a one-line `minimumReleaseAgeExclude` entry in
  the update PR, as already done for the AI SDK pins.
- **pnpm 12 lockfile.** `pnpm-lock.yaml` is written as two YAML documents (pnpm 12 default when `packageManager` is
  pinned). GitHub's changelog says the dependency graph does not detect dependencies in that layout yet. The open
  alerts #22 and #23 show that some detection works today. This is not something the config can change. It goes in the
  owner checklist as "check the Dependabot log after enabling".
- **Fork PRs.** The CodeQL workflow uses `pull_request` (never `pull_request_target`), no secrets, and only the default
  `GITHUB_TOKEN`. That matches the rules in CONTRIBUTING.md, "Security notice for contributors and maintainers".

## Options compared

| Decision | Options | Choice and reason |
| --- | --- | --- |
| npm grouping | (a) one group of all minor+patch; (b) dev vs prod groups; (c) per-scope groups (`@ai-sdk/*`, `@biomejs/*` …) | **(a)**. One weekly PR for minor/patch, majors one by one. That is the most reviewable queue for a single maintainer. It can be split later if a grouped PR keeps failing. |
| Version-update PR limit | 5 / 10 / unlimited | **10 for npm** (majors in a large workspace), **5** for actions, docker and compose. Security updates have their own limit of 10. |
| Cooldown | none / 1 / 3 / 7 days | **3 days**. That clears pnpm's 1-day default with margin and avoids next-day yanked releases without falling far behind. |
| Docker fixtures | include / exclude | **Include** (CI builds them; the base image is EOL). |
| `docker-compose` entry | include / leave out | **Include**. It is an ecosystem that is present, and the card asks for "every other ecosystem present". `postgres:18` and `caddy:2` get major bumps as single PRs that the owner can close or `@dependabot ignore`. `mailpit:latest` and the env-var media image are not version tags, so Dependabot skips them. |
| CodeQL build mode | `autobuild` / `none` | **`none`**. JS/TS and Actions need no build, and `none` is the only mode CodeQL supports for those languages. |
| CodeQL query suite | default / `security-extended` / `security-and-quality` | **Default**. It has the fewest false positives for a first run. Raising it to `security-extended` later is a one-line `queries:` input. |
| CodeQL action version | `@v4` tag / SHA | **SHA of v4.39.3** (`33d7b85da1a04171e211befe2c739303b9a4c066`, the peeled commit of tag `v4.39.3`, the latest v4 on 2026-11-08), as in ci.yml. Dependabot's github-actions entry keeps it up to date. Use the same SHA for `init` and `analyze`. |
| Permissions | job-level only / top-level + job | **Top-level `contents: read`** (same as ci.yml) and **job-level** `actions: read`, `contents: read`, `security-events: write`. |
| Owner checklist location | PR description / `SECURITY.md` / new doc | **New `docs/security/github-settings.md`** with one link line in `SECURITY.md`. It lasts longer than a PR description and sits beside the existing security doc. |

## Design

### Files

| File | Change |
| --- | --- |
| `.github/dependabot.yml` | **New** (below). |
| `.github/workflows/codeql.yml` | **New** (below). |
| `docs/security/github-settings.md` | **New**: the owner checklist (outline below). |
| `SECURITY.md` | One sentence added after the public-forms line in "Scope": "The GitHub security settings this repository expects (Dependabot, code scanning, secret scanning) are listed in [docs/security/github-settings.md](docs/security/github-settings.md)." |
| `.github/workflows/ci.yml`, `.github/workflows/dco.yml` | **Unchanged.** |

No data model or API change.

### `.github/dependabot.yml`

```yaml
# Dependabot version updates.
#
# Security updates are switched on in the repository settings (see docs/security/github-settings.md) and work apart from
# this file: they open as soon as an alert is raised and ignore the schedule, the groups and the cooldown below.
#
# Minor and patch updates are grouped into one pull request per ecosystem so the queue stays reviewable; a major update
# gets its own pull request. The cooldown keeps version updates clear of pnpm's minimum release age.
version: 2

updates:
  # The pnpm workspace: the root package.json, pnpm-workspace.yaml and pnpm-lock.yaml cover every workspace package.
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
      day: monday
      time: '04:00'
      timezone: Etc/UTC
    open-pull-requests-limit: 10
    cooldown:
      default-days: 3
    commit-message:
      prefix: chore(deps)
      prefix-development: chore(deps-dev)
    groups:
      npm-minor-and-patch:
        applies-to: version-updates
        patterns: ['*']
        update-types: [minor, patch]

  # The workflows in .github/workflows. Actions are pinned by commit SHA with the version in a comment; Dependabot
  # updates both.
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
      day: monday
      time: '04:00'
      timezone: Etc/UTC
    open-pull-requests-limit: 5
    cooldown:
      default-days: 3
    commit-message:
      prefix: ci(deps)
    groups:
      actions-minor-and-patch:
        applies-to: version-updates
        patterns: ['*']
        update-types: [minor, patch]

  # Base images: the server image (Dockerfile), the media image (media/Dockerfile) and the ssh fixtures the runner tests
  # build (apps/runner/test/fixtures/*/Dockerfile).
  - package-ecosystem: docker
    directories:
      - /
      - /media
      - /apps/runner/test/fixtures/*
    schedule:
      interval: weekly
      day: monday
      time: '04:00'
      timezone: Etc/UTC
    open-pull-requests-limit: 5
    cooldown:
      default-days: 3
    commit-message:
      prefix: build(deps)
    groups:
      docker-minor-and-patch:
        applies-to: version-updates
        patterns: ['*']
        update-types: [minor, patch]

  # The service images in docker-compose.dev.yml and docker-compose.prod.yml.
  - package-ecosystem: docker-compose
    directory: /
    schedule:
      interval: weekly
      day: monday
      time: '04:00'
      timezone: Etc/UTC
    open-pull-requests-limit: 5
    cooldown:
      default-days: 3
    commit-message:
      prefix: build(deps)
    groups:
      compose-minor-and-patch:
        applies-to: version-updates
        patterns: ['*']
        update-types: [minor, patch]
```

Notes:

- The commit prefixes follow the repository's conventional-commit history (`chore(release)`, `test(e2e)`, `docs(...)`).
  The builder should check them against CHANGELOG/release tooling and keep any prefix that is not shown in the changelog.
- If the schema check rejects `cooldown` or the `docker-compose` ecosystem (an outdated vendored schema), update
  check-jsonschema. Both are documented Dependabot options; do not drop them to satisfy an old schema.

### `.github/workflows/codeql.yml`

```yaml
# CodeQL code scanning (advanced setup).
#
# Safe for pull requests from forks: the trigger is `pull_request` (not `pull_request_target`), no secrets are used and
# the token only gets what the analysis needs. Nothing is built: JavaScript/TypeScript and the workflow files are
# analysed from source (build-mode none). Results appear under Security > Code scanning.
#
# Every action is pinned to the full commit SHA of a release (the version is in the comment), as in ci.yml.
name: CodeQL

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    # Weekly, so new queries also run over code that has not changed.
    - cron: '27 3 * * 1'

permissions:
  contents: read

concurrency:
  group: codeql-${{ github.event_name }}-${{ github.event.pull_request.number || github.sha }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  analyze:
    name: Analyze (${{ matrix.language }})
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    permissions:
      actions: read
      contents: read
      security-events: write
    strategy:
      fail-fast: false
      matrix:
        language: [actions, javascript-typescript]
    steps:
      - name: Check out
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - name: Initialize CodeQL
        uses: github/codeql-action/init@33d7b85da1a04171e211befe2c739303b9a4c066 # v4.39.3
        with:
          languages: ${{ matrix.language }}
          build-mode: none

      - name: Analyze
        uses: github/codeql-action/analyze@33d7b85da1a04171e211befe2c739303b9a4c066 # v4.39.3
        with:
          category: /language:${{ matrix.language }}
```

Before committing, the builder re-checks that the SHA is still the latest v4 release:
`git ls-remote --tags --sort=-v:refname https://github.com/github/codeql-action 'v4*'`. Use the peeled `^{}` commit, not the
annotated tag object. On 2026-11-08 tag `v4.39.3` is object `f3bbb056…` and commit `33d7b85d…`.

### `docs/security/github-settings.md` (outline)

Title: "GitHub security settings". Status line: "The settings this repository expects. The configuration is in the
repository; the owner switches the settings on." Sections:

1. **What the repository provides**: `.github/dependabot.yml` (npm/pnpm, GitHub Actions, Docker, Docker Compose; weekly;
   minor/patch grouped; 3-day cooldown) and `.github/workflows/codeql.yml` (CodeQL for JavaScript/TypeScript and Actions on
   push and pull requests to `main` and weekly).
2. **Owner checklist** (Settings > Advanced Security, called "Code security" on older UIs), in this order:
   - [ ] **Dependency graph** on (a prerequisite; already on for public repositories).
   - [ ] **Dependabot alerts** on.
   - [ ] **Dependabot security updates** on.
   - [ ] (Dependabot version updates need no switch: `.github/dependabot.yml` turns them on once it is on `main`.) After the
         first run, check Insights > Dependency graph > Dependabot for errors in each ecosystem's update log, especially the
         npm/pnpm one (pnpm 12 lockfile layout).
   - [ ] **Code scanning: advanced setup.** Do *not* enable "default setup". This workflow is the advanced setup, and the
         two cannot run together. The first run on `main` (or on a pull request) creates the code scanning entry.
         Optionally add the CodeQL check as a required status check in the `main` branch rule.
   - [ ] **Secret scanning** on.
   - [ ] **Push protection** on.
   - [ ] (Already on: private vulnerability reporting, see SECURITY.md.)
3. **Known interactions**:
   - Dependabot commits carry no `Signed-off-by:` line, so the DCO check fails on Dependabot pull requests until `dco.yml`
     exempts `dependabot[bot]`. Until then, the maintainer reviews and merges those pull requests knowing the check is red.
   - Security updates ignore the cooldown. If one fails on install because of pnpm's minimum release age, add the exact
     version to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` in that pull request.
   - Workflows that Dependabot triggers get a read-only token and no secrets. CI needs neither.

Follow the house style: plain sentences, no marketing, no mention of tools or assistants.

## Risks

| Risk | Mitigation |
| --- | --- |
| DCO check red on every Dependabot PR | Documented. Backlog follow-up to exempt `dependabot[bot]` (out of scope: existing CI unchanged). |
| Dependabot cannot parse the pnpm 12 two-document lockfile | Documented as "check the update log". No config change can fix it. |
| Security update blocked by pnpm minimum release age | Documented workaround (`minimumReleaseAgeExclude`). |
| CodeQL run red because default setup is on or the repo has no Code Security | PR states both causes. The workflow is validated locally. |
| Weekly major-version PRs for `postgres:18`/`caddy:2` that the owner does not want | Single PRs, easy to `@dependabot ignore this major version`. Optional `ignore` entries can follow later. |
| Large grouped npm PR that fails CI | Majors are excluded from the group. The group can be split by scope later. |

## Acceptance criteria → design

| Criterion | Met by |
| --- | --- |
| `dependabot.yml` exists, valid (version 2), covers npm root, github-actions and every other present ecosystem | The file above: `npm` `/`, `github-actions` `/`, `docker` (`/`, `/media`, fixtures), `docker-compose` `/`. No other manifests exist (see Findings). Validated with `check-jsonschema --builtin-schema vendor.dependabot`. |
| `codeql.yml` uses github/codeql-action, analyses javascript-typescript and actions, push + pull_request to default branch + weekly, least privilege | The workflow above: `init`/`analyze` v4.39.3, matrix `[actions, javascript-typescript]`, triggers `push`/`pull_request` on `main` plus cron Monday 03:27 UTC, `contents: read` top level, job `actions: read`, `contents: read`, `security-events: write`. |
| YAML lint and actionlint pass with no errors | Test plan steps 1–3. |
| CodeQL runs green on the PR, or the PR says why and the workflow is validated locally | Public repo, so the run is expected green. The PR text names the two failure causes. Local validation in steps 2–3. |
| Existing CI unchanged | Only new files plus docs. Step 4 checks `git diff --stat main -- .github/workflows/ci.yml .github/workflows/dco.yml` is empty. |
| Owner checklist in docs or PR | `docs/security/github-settings.md`, linked from `SECURITY.md`. |

## Test plan for the builder

These checks run from the worktree. PyPI and the npm registry can be reached from the sandbox. GitHub release downloads
cannot (`release-assets.githubusercontent.com` is blocked).

1. Tools in a throwaway venv: `python3 -m venv "$TMPDIR/v"`, then `"$TMPDIR/v/bin/pip" install check-jsonschema yamllint`.
2. Schema checks (offline, vendored schemas; check-jsonschema 0.39.0 already passes the existing ci.yml and dco.yml):
   - `"$TMPDIR/v/bin/check-jsonschema" --builtin-schema vendor.dependabot .github/dependabot.yml`
   - `"$TMPDIR/v/bin/check-jsonschema" --builtin-schema vendor.github-workflows .github/workflows/codeql.yml`
3. Lint:
   - `"$TMPDIR/v/bin/yamllint" -d "{extends: default, rules: {line-length: {max: 120}, document-start: disable, truthy: {check-keys: false}, comments: {min-spaces-from-content: 1}}}" .github/dependabot.yml .github/workflows/codeql.yml`
     (`min-spaces-from-content: 1` matches ci.yml's `@<sha> # vX` pin comments; without it yamllint gives three
     warnings, not errors.)

   Design-time check (2026-11-08) of the two snippets above: both pass the vendored schemas (`ok -- validation done`) and
   yamllint with no errors. The 2022 wasm actionlint reports nothing except its stale runner-label check.
   - `actionlint .github/workflows/codeql.yml`. DevOps has been asked (2026-11-08) to install the current actionlint binary
     as a toolchain. If it is not there yet, ask with `aom devops`. Do not use the npm `actionlint@2.0.6` wasm build: it
     is from 2022 and falsely reports `ubuntu-24.04` as an unknown label, even on the existing ci.yml.
4. `git diff --stat main -- .github/workflows/ci.yml .github/workflows/dco.yml` prints nothing.
5. Put the outputs of steps 2–4 in the handoff. The workflow run link exists only after the runner pushes the PR. State
   that in the handoff, and give the two causes of a red run (default setup on, or a private repo without Code
   Security).
