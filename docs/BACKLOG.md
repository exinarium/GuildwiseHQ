# Backlog

Logged fixes to pick up when development resumes. Newest first.

## 2026-10-10

### 1. Runners update themselves once a day

**Problem.** Installed runners never upgrade on their own. The only upgrade path is running the install command again,
and the installer only upgrades when the server offers a higher version number. The reconnect fix (`61ec871`) reached the
owner's machine only because the runner was swapped by hand; every other runner still has the hang-after-redeploy bug.

**Wanted.**
- Once a day (plus a jittered check shortly after start), the runner asks `GET /api/runner/release` for the current
  version and sha256.
- When it is newer: download, verify the sha256, unpack next to the current version, switch the `current` link
  atomically, and restart through the service manager (systemd user service / launchd / Windows scheduled task, and the
  `start-runner.sh` fallback). Keep the previous version for rollback; roll back automatically if the new one does not
  connect within a few minutes.
- Never restart in the middle of a running agent job: wait until idle (or a maximum delay), then update.
- Show the runner version, and "update pending/failed", on the Workstations page; a super admin setting or kill switch
  to pause auto-updates.
- **Prerequisite:** bump the runner version on every release that changes it (currently still `0.1.0`), otherwise
  nothing is ever "newer". Next release should be `0.1.1`.

**Where.** `apps/runner` (new updater beside `src/connection`), `apps/server/src/routes/installer.ts`
(`/api/runner/release`), installer templates in `apps/server/src/installer/templates/`, `docs/RUNNER.md`.

### 2. Verify rights fails on Arch: package manager not detected

**Problem.** "Verify now" on the Workstations page fails on Arch Linux because the rights check does not find a package
manager. `apps/runner/src/devops/rights.ts` (line ~66) only knows `apt-get` and `dnf` on Linux and `brew` on macOS; the
toolchain `Manager` type (`apps/runner/src/toolchain/types.ts:10`) has the same gap.

**Wanted.**
- Linux: also detect `pacman` (Arch, Manjaro), `zypper` (openSUSE, SLES); consider `apk` (Alpine) and `yum` (older RHEL)
  while there. Homebrew on Linux (`brew`, no root) as a fallback.
- macOS: confirm Homebrew is found on both Intel (`/usr/local/bin/brew`) and Apple Silicon (`/opt/homebrew/bin/brew`),
  even when the service's `PATH` does not include it.
- Add the matching install commands to the toolchain (`src/toolchain/stacks.ts`, `ensure.ts`) so the DevOps agent can
  actually install with the detected manager, and a clear message when none is found.
- Tests per distribution (detection with stubbed commands).
