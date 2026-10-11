# Backlog

Logged fixes to pick up when development resumes. Newest first.

## 2026-10-11

### 3. Affiliate programme for influencers

**Idea (owner).** Influencers get a personal code. A customer enters it at sign-up/checkout, and the influencer earns
commission on that subscription for as long as it keeps running (recurring, lifetime of the subscription).

**Decided (owner, 2026-10-11).**
- **Customer discount:** a valid affiliate code gives the customer **10% off their first month**.
- **Who can join:** anyone, through a public **application form** (name, email, channels/audience, how they will promote,
  payout details). Applications are **reviewed by the super admin**, who **approves or rejects** each one (with an
  optional reason, emailed to the applicant). Only approved affiliates get a code and a dashboard.
- **Tax:** affiliates handle their own tax. Guildwise HQ is not responsible for affiliates' taxes; this goes into the
  **Affiliate Terms** (and a reference in the main Terms), accepted when applying.
- **Payout report:** the super admin gets a report of the payouts due **per affiliate** (per month: referred
  subscriptions, payments received, commission earned, held, payable, already paid), to monitor and pay them; mark a
  payout as paid (date, reference); export to CSV.

- **Commission:** **20%** of each payment (excluding VAT), the same default for every affiliate, for as long as the
  subscription runs.
- **Hold (refund) period:** **30 days**; a commission becomes payable 30 days after the payment it came from (reversed if
  refunded within that time).
- **Payout window:** payouts are made **between the 25th and 30th of every month**, covering everything that became
  payable by then; the payout report is ready for the super admin before the 25th (e.g. on the 24th, with an email).
- **Minimum payout:** **$100**; a smaller balance rolls over to the next month.
- **Discount timing:** the 10% applies to the **first paid month after the trial**.

- **Payout method:** **USD to the affiliate's PayPal account** (PayPal email collected on the application form).
  **South African affiliates may request a direct bank transfer (EFT)** instead; bank details collected and stored
  encrypted, shown only to the super admin in the payout report. Assumed: EFT payouts in ZAR at the exchange rate on the
  payout day (shown on the statement).
- **Fees:** **Guildwise HQ pays the sending fee** (PayPal payout fee, ~2% capped at $20; or the EFT fee), so the
  affiliate receives the full commission. Fees the affiliate's own PayPal/bank charges for receiving, converting or
  withdrawing, and their taxes, are the affiliate's responsibility (Affiliate Terms). Keep a USD balance in PayPal to
  avoid double conversion. Wise as an extra method only if affiliates ask for it.
- **Later:** PayPal Payouts API to pay all PayPal affiliates in one batch from the payout report.

**Design notes.**
- **Codes:** one per approved affiliate (more later), entered at sign-up or checkout, or via link
  `guildwisehq.com/?ref=CODE` (cookie for N days). One code per organization, locked once the first payment succeeds.
- **Commission mechanics:** stops on cancellation; reversed on refunds/chargebacks within the hold period.
- **Affiliate dashboard:** referred sign-ups, active subscriptions, commission earned, held, payable and paid; their own
  monthly statement.
- **Rules:** no self-referral (same email/domain/card as the affiliate); audit trail of approvals, code and rate
  changes; super admin can suspend an affiliate and their codes.
- **Where it touches:** public application page, Platform > Affiliates (applications queue, affiliates, codes, payout
  report), billing (Paystack charge webhooks already drive invoices: commission per paid invoice, discount on the first
  paid invoice), sign-up/checkout, events/projections, emails (application received/approved/rejected, monthly
  statement), legal pages (Affiliate Terms; tax clause).
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
