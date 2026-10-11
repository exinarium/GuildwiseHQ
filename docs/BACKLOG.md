# Backlog

Logged fixes to pick up when development resumes. Newest first.

## 2026-10-11

### 3. Affiliate programme for influencers

**Idea (owner).** Influencers get a personal code. A customer enters it at sign-up/checkout, and the influencer earns
commission on that subscription for as long as it keeps running (recurring, lifetime of the subscription).

**To design when we pick it up.**
- **Affiliates:** who can become one (invite-only by the super admin vs. an application form), their own login/dashboard
  showing referred sign-ups, active subscriptions, commission earned, paid and pending.
- **Codes:** one or more per affiliate, entered at sign-up or in billing; optional customer discount attached to the code
  (e.g. first month off) or commission only. Code also usable as a link (`guildwisehq.com/?ref=CODE`, cookie for N days).
  One code per organization, locked once the first payment succeeds.
- **Commission:** percentage of each successful payment (excluding VAT, since VAT is on every invoice), per affiliate or
  default rate; stops when the subscription is cancelled, and is reversed on refunds/chargebacks. Hold period (e.g. 30
  days) before a commission becomes payable.
- **Payouts:** monthly statement per affiliate; paid manually (EFT) at first, with a minimum payout; Paystack transfers
  later. Affiliates outside South Africa and their tax details (who invoices whom) need the accountant's view.
- **Rules:** no self-referral (same email/domain/card as the affiliate), audit trail of code changes, super admin can
  suspend an affiliate and their codes; terms for affiliates (a short Affiliate Terms page).
- **Where it touches:** billing (Paystack charge webhooks already drive invoices: hook commission on each paid invoice),
  sign-up flow and checkout, Platform > Billing (affiliates, codes, rates, payouts), events/projections, emails
  (monthly statement), legal pages.
- **Depends on:** Paystack live (no real payments until then).

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
