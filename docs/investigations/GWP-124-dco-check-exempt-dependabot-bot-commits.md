# GWP-124: DCO check, exempt Dependabot commits

## Question

The DCO workflow (`.github/workflows/dco.yml`) fails every Dependabot pull request, because Dependabot commits carry no
`Signed-off-by:` line. How can we exempt Dependabot without opening a bypass, while every other commit is still checked
the same way, the check name stays the same, and the runner still detects that the repository requires sign-off?

## Findings

### Step 0: what is already done

- **GuildwiseHQ, `release/1.6.0`:** `.github/workflows/dco.yml` on `origin/release/1.6.0` is byte-for-byte the same as on
  `main` (the card branch). It has **no** Dependabot exemption. The only commit that touched it is `2c1fc911` ("ci: pin
  actions to commit SHAs, add a mail catcher, a DCO check and the boundary check"). **The card is not done and must be
  built.**
- **guildwise-cloud, `release/1.6.0`:** `.github/` holds `dependabot.yml`, `workflows/bump-core.yml`, `workflows/ci.yml`
  and `workflows/codeql.yml`. None of them mentions `Signed-off-by` or DCO. **guildwise-cloud has no DCO workflow**, so
  there is no follow-up card. (`guildwise-cloud/core` is the GuildwiseHQ submodule. Its `dco.yml` is this repository's
  file, so this card fixes it too.)
- `docs/security/github-settings.md` ("Known interactions") already notes that the DCO check fails on Dependabot pull
  requests "until `.github/workflows/dco.yml` exempts `dependabot[bot]`". That note must be updated once this is built.

### The current workflow

- Trigger `pull_request` only. `permissions: contents: read`. Workflow `DCO`, job id `dco`, job name
  `Signed-off-by on every commit`. The status check is `Signed-off-by on every commit` (shown as
  `DCO / Signed-off-by on every commit`).
- One step loops over `git rev-list --no-merges "$BASE_SHA..$HEAD_SHA"` and fails each commit whose message has no line
  matching `^Signed-off-by: .+ <.+>$`.
- `actionlint .github/workflows/dco.yml` passes today. shellcheck is not installed on this workstation, so actionlint
  does not lint the inline script here.

### The runner's sign-off detection

`apps/runner/src/git/dco.ts` `detectSignOff(dir)` returns `required: true` when `.github/dco.yml` exists, **or** when any
`.github/workflows/*.y?ml` contains the text `Signed-off-by` (case-insensitive), or the GitLab CI file or CONTRIBUTING
guide mention it. In GuildwiseHQ only `dco.yml` contains `Signed-off-by` among the workflows, so the reason is
`.github/workflows/dco.yml`. CONTRIBUTING.md also names the DCO, which would be a fallback. **The edited `dco.yml` must
keep the literal text `Signed-off-by`.** The design below keeps it in the comment, the step name, the grep pattern and the
error message, so nothing changes for `commitPrepare`, `landByMerge` or `commitRelease`.

### Who can set which identity

| Signal | Who sets it | Can a fork contributor fake it? |
| --- | --- | --- |
| Commit author name and email (`%an`, `%ae`) | Whoever makes the commit (`git commit --author`) | **Yes.** Not safe on its own. |
| Branch name, PR title, label, commit message | The contributor (labels: maintainers) | Yes. Never use these. |
| `github.actor` | The account that triggered *this run* | No. But it changes per run: a human who pushes to a Dependabot branch, or re-runs the job, becomes the actor. |
| `github.event.pull_request.user.login` | GitHub: the account that **opened** the PR | **No.** A fork PR is always opened by a human account. Dependabot opens PRs only from branches in the base repository. |

## Options

**A. Job-level skip on `github.actor == 'dependabot[bot]'`** (`if:` on the job).
The job shows as *skipped*. A skipped required check counts as passing. But the actor is whoever triggered the run, so a
human commit pushed to a Dependabot branch would be checked on that push, and then skipped again on Dependabot's next
rebase. Worse, the whole PR is exempt while Dependabot is the actor. It fails requirement 4. Rejected.

**B. Per-commit exemption by commit author only.** The commit author can be set by anyone (`git commit
--author='dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>'`), including from a fork. This is a
bypass. It fails requirement 2. Rejected.

**C. Per-commit exemption, gated on the PR opener (recommended).** A commit is exempt only when **both**:

1. the pull request was opened by `dependabot[bot]` (`github.event.pull_request.user.login`, set by GitHub, not forgeable
   from a fork), **and**
2. that commit's author name is exactly `dependabot[bot]` **and** its author email is exactly
   `49699333+dependabot[bot]@users.noreply.github.com`.

Every other commit, including a human commit on a Dependabot PR, goes through the unchanged check. The job always runs
and ends green on a pure Dependabot PR (not skipped), so the required check reports normally.

**D. Also require GitHub's verified signature on the exempt commit** (Dependabot commits are signed by GitHub). This
needs a REST call per commit (`GET /repos/{owner}/{repo}/commits/{sha}`, `commit.verification.verified`) or GitHub's
public key in the job. It adds a network dependency and more to go wrong for little gain, given the residual risk below.
Not recommended now. It is listed as optional hardening.

Residual risk with C: someone who can push to a branch of the base repository (write access) could push a commit with a
faked Dependabot author onto a Dependabot PR, and it would be exempt. Such a person can already merge without the check
(admin bypass) and is a maintainer, not an outside contributor. Requirement 2 is about things a contributor can set from a
fork, which C closes. I do not require the committer to be `GitHub <noreply@github.com>`: I could not confirm that
Dependabot uses that committer in every case (rebases, security updates), and a wrong guess would turn Dependabot PRs red
again.

## Recommendation and design

Build option C. **Only `.github/workflows/dco.yml` changes**, plus two documentation sentences.

### `.github/workflows/dco.yml`

Keep `name: DCO`, job id `dco`, job `name: Signed-off-by on every commit`, the trigger, `permissions: contents: read`,
the checkout step and the pinned action SHA unchanged. Do not add `pull_request_target` or any permission.

Update the header comment to say that Dependabot's own commits are exempt on pull requests that Dependabot opened, and
why the gate is the PR opener and not the commit author.

Change the check step to this. Pass the login through `env`, never as `${{ }}` inside `run`.

```yaml
      - name: Check each commit for a Signed-off-by line
        env:
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
          # Set by GitHub to the account that opened the pull request; a fork cannot set it.
          PR_AUTHOR: ${{ github.event.pull_request.user.login }}
        run: |
          set -euo pipefail
          bot_login='dependabot[bot]'
          bot_email='49699333+dependabot[bot]@users.noreply.github.com'
          failed=0
          for sha in $(git rev-list --no-merges "$BASE_SHA..$HEAD_SHA"); do
            # Dependabot cannot sign off. Its own commits are exempt, but only on a pull request Dependabot opened:
            # the commit author alone can be set by anyone, so it never exempts a commit by itself.
            if [ "$PR_AUTHOR" = "$bot_login" ] \
              && [ "$(git log -1 --format=%an "$sha")" = "$bot_login" ] \
              && [ "$(git log -1 --format=%ae "$sha")" = "$bot_email" ]; then
              echo "Commit $sha is Dependabot's own commit on its pull request; no Signed-off-by needed."
              continue
            fi
            if ! git log -1 --format=%B "$sha" | grep -Eq '^Signed-off-by: .+ <.+>$'; then
              echo "::error::Commit $sha has no Signed-off-by line. Add one with 'git commit -s' (see CONTRIBUTING.md)."
              failed=1
            fi
          done
          if [ "$failed" -ne 0 ]; then
            echo "Fix with: git rebase --signoff <base-branch>, then force-push your branch."
          fi
          exit "$failed"
```

Notes for the builder:

- Use `%an` and `%ae`, not `%aN` and `%aE`. The capital forms apply `.mailmap`, which a contributor's PR could add to
  change how a name resolves. There is no `.mailmap` today.
- The comparisons are exact string equality (`=`) in `[ ]`. Do not use globs, `grep`, `case` patterns or regexes on the
  identity: `[bot]` is a character class in a glob or regex.
- The merge commits GitHub makes ("Update branch") are already skipped by `--no-merges`. That does not change.
- The sign-off branch of the loop is byte-for-byte the current code. The behaviour for every non-exempt commit does not
  change.

### Documentation (allowed, small)

- `docs/security/github-settings.md`, "Known interactions": replace the "DCO on Dependabot pull requests" bullet. The
  DCO check exempts Dependabot's own commits on pull requests Dependabot opened. A commit anyone else pushes onto such a
  pull request still needs a `Signed-off-by:` line.
- `CONTRIBUTING.md`, after "Every commit in a pull request needs one…": add one sentence saying that Dependabot's own
  commits on its pull requests are the only exception.

### Tests

- `actionlint .github/workflows/dco.yml`: no errors.
- Runner regression (AC 9): add one case to `apps/runner/test/dco.test.ts` that runs `detectSignOff` on the repository
  root (resolve from the test file, `../../..`) and expects
  `{ required: true, reason: '.github/workflows/dco.yml' }`. This guards against a later edit dropping the
  `Signed-off-by` text. Then run the runner unit tests (`pnpm --filter <runner package> test`, or vitest on
  `test/dco.test.ts`, `test/release-ship.test.ts` and `test/release-publish.test.ts`, plus the release-docs-prep tests
  if any).
- Script logic (AC 2 to 6), before the live check: in a scratch git repository under `$TMPDIR`, make a base commit and
  then (a) a commit with author `dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>` and no sign-off,
  (b) a human commit with no sign-off, (c) a human commit with a sign-off, and (d) a commit with the Dependabot author
  set by hand. Run the step's script body with `BASE_SHA`, `HEAD_SHA` and `PR_AUTHOR` set:
  - `PR_AUTHOR=dependabot[bot]` with only (a): exit 0.
  - `PR_AUTHOR=dependabot[bot]` with (a) and (b): exit 1, error on (b) only.
  - `PR_AUTHOR=someone` with (b): exit 1.
  - `PR_AUTHOR=someone` with (c): exit 0.
  - `PR_AUTHOR=someone` with (d), a faked author from a fork: exit 1.

  Record the results in the handoff. The script is inline YAML, so this is a manual check, not a committed test.
- Live check on GitHub (test plan step 3) and the branch protection check (step 5) are for the testers or the owner
  after merge.

## Acceptance criteria mapping

| Acceptance criterion | How the design meets it |
| --- | --- |
| Record what release/1.6.0 has | Step 0 above: no exemption in GuildwiseHQ, so it must be built. guildwise-cloud has no DCO workflow, so there is no follow-up. Also posted on the card. |
| Dependabot-only PR ends green | PR opener `dependabot[bot]` plus Dependabot author on every commit means every commit is skipped, `failed=0`, the job is green (not skipped). |
| Human PR, unsigned, still fails | `PR_AUTHOR` is not `dependabot[bot]`, so the gate is false and the unchanged check fails. |
| Human PR, signed, still passes | Same path as today. |
| Human commit on a Dependabot PR is checked | The exemption is per commit and needs the Dependabot author. A human commit falls through to the check and fails if unsigned. No job-level skip is used. |
| Only the dependabot[bot] identity | Gate on `pull_request.user.login` (set by GitHub) and an exact author name and email match. Branch, label, title and message are never read. A faked author on a fork PR fails the gate. |
| Names unchanged | `name: DCO`, job `dco` and `Signed-off-by on every commit` are untouched. |
| actionlint clean | Run on the changed file. |
| Runner detection unchanged | `Signed-off-by` stays in `dco.yml` (the comment, step name, grep and message). A new repo-root test in `dco.test.ts` asserts it. `dco.ts` is not changed. |

## Risks

- **Dependabot changes its author identity.** The exemption would stop matching and Dependabot PRs would go red again.
  That is safe (it fails closed) and easy to see. The login and email have been stable for years.
- **Residual maintainer bypass** (write access, faked author on a Dependabot branch). Accepted, see option C. Option D is
  the hardening if the owner wants it later.
- **Branch protection.** The job name is unchanged and the job still runs, so the required check keeps matching.
