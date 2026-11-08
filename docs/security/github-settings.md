# GitHub security settings

The settings this repository expects. The configuration is in the repository; the owner switches the settings on.

## What the repository provides

- [`.github/dependabot.yml`](../../.github/dependabot.yml): version updates for npm (the pnpm workspace), GitHub Actions,
  Docker (the server and media images and the runner's ssh test fixtures) and Docker Compose. Weekly on Monday, minor
  and patch updates grouped into one pull request per ecosystem, majors one by one, and a 3-day cooldown so updates
  clear pnpm's minimum release age.
- [`.github/workflows/codeql.yml`](../../.github/workflows/codeql.yml): CodeQL code scanning for JavaScript/TypeScript and
  the GitHub Actions workflows, on every push and pull request to `main` and once a week.

## Owner checklist

In the repository on GitHub, under Settings > Advanced Security (called "Code security" in older layouts), in this
order:

- [ ] **Dependency graph** on. It is a prerequisite and is already on for public repositories.
- [ ] **Dependabot alerts** on.
- [ ] **Dependabot security updates** on.
- [ ] Dependabot version updates need no switch: `.github/dependabot.yml` turns them on once it is on `main`. After the
      first run, check Insights > Dependency graph > Dependabot for errors in each ecosystem's update log, especially
      npm, because pnpm 12 writes the lockfile as two YAML documents.
- [ ] **Code scanning: advanced setup.** Leave "default setup" **off**. The CodeQL workflow is the advanced setup, and the
      two cannot run together. The first run on `main` or on a pull request creates the code scanning entry. Optionally
      add the CodeQL checks as required status checks in the `main` branch rule.
- [ ] **Secret scanning** on.
- [ ] **Push protection** on.
- [ ] Private vulnerability reporting is already on (see [SECURITY.md](../../SECURITY.md)).

## Known interactions

- **DCO on Dependabot pull requests.** Dependabot's commits carry no `Signed-off-by:` line, so `.github/workflows/dco.yml`
  skips a commit only when the pull request was opened by `dependabot[bot]` and the commit author is Dependabot's exact
  identity. A human commit pushed onto a Dependabot pull request is still checked and fails without a sign-off.
- **pnpm minimum release age.** Security updates ignore the cooldown. If one fails on install because the release is
  younger than pnpm's minimum release age, add the exact version to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`
  in that pull request.
- **Tokens.** Workflows that Dependabot triggers get a read-only token and no secrets. CI needs neither.
- **A red CodeQL run.** If the analysis fails to upload, check that default setup is off. A private copy of the
  repository also needs GitHub Code Security for code scanning.
