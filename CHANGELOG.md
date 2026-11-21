# Changelog

All notable changes to Guildwise HQ are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses semantic versioning.

## [Unreleased]

Security hardening release (Guildwise 1.10.0). **Breaking for self-hosted installs:** read the entries marked BREAKING (self-hosted) under Changed before you upgrade. With the defaults nobody is locked out.

### Changed

- **BREAKING (self-hosted): runners keep working.** The new setting **Only signed runners** (Platform > Security > Security settings, env default `AOM_REQUIRE_SIGNED_RUNNERS=false`) is off by default: nothing is revoked or refused, and runners with auto-update on move to the runner that ships with 1.10.0 by themselves, normally within a day. Each workstation then needs one `guildwise-runner setup` before DevOps, deploys and other steps outside the sandbox run again; sandboxed card work goes on meanwhile. **To opt in:** sign your own runner builds (`RUNNER_RELEASE=own-key`) or use the official signed image, set `AOM_RUNNER_RELEASE_PUBKEY` for your own key, reinstall each runner from your server's installer (the old install is quarantined), then turn the setting on. With it on, unsigned and older runners are refused (`403 signed_runner_required`), unlinked and must be reinstalled; their old update path answers `410 reinstall_required`. Steps: docs/SELF-HOSTING.md, section 13.
- **BREAKING (self-hosted): two-factor logins keep working.** `AOM_TWO_FACTOR_KEY` (a separate key for the two-factor seeds) is optional, with a warning in production when it is unset. The `two-factor-reseal` data migration re-seals existing seeds at first boot; nobody enrols again and recovery codes keep working. **To opt in** to enforcement: Platform > Security > Security settings > **Require two-factor login** (env default `AOM_ENFORCE_TWO_FACTOR=false`).
- **BREAKING (self-hosted): removed.**
  - `/api/admin/workstations` (answers 410);
  - the platform account's two-factor reset of other users (users recover by email with a 24-hour wait; `superadmin-reset-password --reset-two-factor` stays for the platform account);
  - choosing the platform team in the app (`PUT /api/platform/team`): set `AOM_PLATFORM_TEAM_ORG_ID` and `AOM_PLATFORM_TEAM_PROJECT_ID`; an existing choice keeps working read-only until you do;
  - simulation tools on real organizations;
  - DevOps command text and runner error messages in the platform view (counts only);
  - the database-connected remote render worker: `AOM_VIDEO_PUSH_URL` makes the video worker refuse to start (use `video-worker --remote` with a render worker token), and the shared `AOM_VIDEO_WORKER_TOKEN` is no longer an upload credential.
- **BREAKING (self-hosted): new behaviour, on by default:** sign-in lockout, new-device mails, invitation limits, a password reset of a two-factor account needs a code, "Confirm it's you" before secrets and platform changes, platform accounts sign in once more after the upgrade (migration 3020), ownership transfers need the Owner's consent, no member reset across organizations (send a reset link instead), and a workstation serves only its owner's organizations until others are switched on under **Works for**.
- **BREAKING (self-hosted): new variables and build arguments** (all optional in core): `AOM_TWO_FACTOR_KEY`, `AOM_REQUIRE_SIGNED_RUNNERS`, `AOM_ENFORCE_TWO_FACTOR`, `AOM_PLATFORM_TEAM_ORG_ID`, `AOM_PLATFORM_TEAM_PROJECT_ID`, `AOM_STEP_UP_WINDOW_SEC` and `AOM_SUPER_ADMIN_IDLE_SEC` (above 600 and 1800 the server refuses to start in production), `AOM_INVITE_PER_ORG_HOUR`, `AOM_INVITE_PER_ACTOR_DAY`, `AOM_INVITE_PENDING_MAX`, `AOM_LOGIN_LOCKOUT`, `AOM_SIGNIN_NOTICES`, `AOM_RUNNER_RELEASE_PUBKEY`; build argument `RUNNER_RELEASE` (`official` by default, which needs a release tag; an unreleased commit needs `dev` or `own-key`).
- Operator note: `AOM_TWO_FACTOR_KEY`: set it (at least 32 characters, not equal to `AOM_SECRET_KEY`) and keep it with your backups. A key change re-seals the seeds automatically, but losing the key that sealed them means those users recover two-factor login by email.
- Operator note: Platform accounts sign in once more after the upgrade.
- Operator note: Remote render workers move to `video-worker --remote` with a worker token (`AOM_RENDER_SERVER_URL`, `AOM_RENDER_WORKER_TOKEN_FILE`); `AOM_VIDEO_PUSH_URL` is refused. GPU encoding needs the host's NVENC library for the driver (for example `libnvidia-encode-595`) and `--gpus all`; a CPU fallback is reported on the Render workers card and by mail.
- Operator note: Workstation runner: local approvals, local DevOps and sudo grants, the install allowlist, signed updates and the version floor. An unattended redeploy builds whatever is on the deployed branch; `guildwise-runner deploy pin-commit` binds it to a commit.
- Operator note: Narrow Docker mode (`deploy-compose`): an approval now records the runner user's uid and gid, and the frozen copy is read as that user. Apps approved for narrow mode before this change are refused ("run approve-app again") until you run `guildwise-admin approve-app <app> --source <folder>` again. Binds into the app folder must be read-only (`:ro`).
- Operator note: The macOS dedicated runner user and the Windows WSL distro ship with unit tests but are not yet tested on real hardware.
- Operator note: The image build verifies the runner release it serves (`RUNNER_RELEASE=official|own-key|dev`); the `release/` folder in the image is read-only.
- The server refuses a video render worker older than itself. Every video worker now reports its version; the Video page shows each worker's version and marks one older than the server (or one that reports no version) as outdated, with both versions and what to do, and the super-admins get one mail about it. An outdated worker renders nothing and the server refuses the files it pushes; the render goes back to the queue and is picked up as soon as an updated worker reports in, with no manual step. **Update the render worker together with the server:** a worker from before this release is refused until it is updated.
- The size estimate of `aom design --size --path` reaches the server. The runner's report check dropped it when it rebuilt the design report, so a project with a size unit refused every design; it now forwards the size in the repository and vault locations.
- Ship release never recommends a version at or below the newest release tag. The base is the newest release tag of the repository, also one on the main branch that the working branch has not merged back yet, or a newer dated version in CHANGELOG.md; the item shows it ("Last release: v1.8.0"). A typed version at or below it is refused under the field and by the server (409), naming the tag, and component versions are never proposed below their released version.

### Security

- Sign-in protection. Failed sign-ins are recorded (account, real IP, browser) and shown under Platform > Security > Failed sign-ins. After 5 failures an address pauses for 15 minutes, doubling up to 60; an unknown address behaves the same. 20 failures from one IP in 15 minutes lock that IP. A browser that signed in to the account in the last 30 days still gets in, a completed reset clears the lock, and private and proxy addresses are never IP-locked. Answers are uniform, so sign-in, reset and invitations reveal no accounts.
- A password reset of a two-factor account needs a two-factor or recovery code to complete; 5 wrong codes end the link, and an account gets at most 5 reset links a day. Users are mailed on every password change, reset, admin reset and two-factor reset, with the time and IP, and on a sign-in from a new device (`AOM_SIGNIN_NOTICES`).
- Every sign-in is an audit event (Platform > Security > Sign-ins). Platform sessions last at most 8 hours (30 minutes idle), and a platform session that no real sign-in created is refused on its first request and reported by mail.
- "Confirm it's you": revealing or changing secrets, keys, deploy targets, sudo, provider keys, member resets and every platform change ask for a fresh two-factor code (within 10 minutes), or the password for accounts without two-factor login.
- Two-factor seeds are encrypted with their own key (`AOM_TWO_FACTOR_KEY`, never equal to `AOM_SECRET_KEY`); reset and verification links are no longer written to logs, and the log redaction covers passwords, tokens, keys and the configuration's secrets. The CLIs take `--password-stdin`.
- An Owner or Admin can no longer reset the password or two-factor login of a member who also has access in another organization; **Email a reset link** works for everyone (3 an hour per person). Inviting a platform address answers like any other address, without a mail. Invitations are limited per organization, per inviter and in number pending. Moving an agent onto a member's workstation, and the automatic DevOps hire, need that member's consent.
- The platform account has no way into organizations' projects, cards, workstations, secrets, vaults or runner commands, nor into the platform-team tools. Ownership transfers it requests wait for the Owner (approve or veto; automatic after 7 days, never for an organization with deploy targets). Users who lose their authenticator and recovery codes recover by email with a 24-hour wait, which a normal sign-in or the mail's cancel link stops.
- The workstation decides. DevOps and sudo are granted on the machine (`guildwise-runner devops grant`, `sudo enable`), never taken from the server. New deploy scripts, recipe writes, vault set-up, secret reseals, release signing and every DevOps task not started on the machine wait for `guildwise-runner approve` there; an unchanged redeploy runs by itself. Loader variables (`NODE_OPTIONS`, `LD_PRELOAD` and others) never reach a deploy. Installs that could run repository code need the repository allowed on the workstation. Runner error text never becomes a card, and text from the organization and from outside is fenced in every prompt.
- Signed runner updates. A runner from 1.10.0 on verifies the minisign signature of every update against the key built into it and never installs or rolls back below its floor. Releases are signed offline after the build; CI never signs.
- A newly installed runner refuses to start when its user can act as root (exit 78), unless accepted on the machine with a typed confirmation; the installer creates a dedicated runner user (Linux, macOS) or a separate WSL distro (Windows).

### Added

- Security settings: **Only signed runners** and **Require two-factor login** on Platform > Security, both off by default; a hosting extension can lock them on (`lockedSecuritySettings`). With two-factor enforcement on, a user without two-factor login is sent to set it up before anything else.
- Platform > Security with four tabs: Failed sign-ins, Sign-ins, Block list (domains, addresses, IPs, checked at invitation, accept, sign-in and reset) and Security settings.
- The installer looks for an older runner first, stops it and quarantines its files, and sets up the local permissions itself (**Setting local permissions**, re-runnable with `guildwise-runner setup`): dedicated runner user, organizations the DevOps engineer may serve, sudo sealed on the machine, a narrow root-owned Docker helper (`deploy-compose`) instead of the docker group, and deploy approval defaults. Root steps go through the root-owned `guildwise-admin`.
- Passkey approvals: a redeploy at a new commit and a recipe change can be approved in the browser with a passkey the workstation trusts (`guildwise-runner passkey trust`), on the workstation's **Approvals** page. Everything else still needs the workstation.
- Runner signing per environment in the release flow: a deploy target can require a runner signed with its own key; the release sheet packages the runner for that place and has it signed on the workstation that holds the key (with a local yes) or takes an uploaded offline signature, and the deploy waits until it is signed.
- Remote render workers through a job API: no database access, a revocable token per worker from Platform > Video > Render workers, short-lived signed upload links. The remote worker encodes with NVENC on an NVIDIA GPU when it works and reports a CPU fallback (badge, mail), never silently.
- DevOps command log for the organization Owner (Org settings > DevOps commands) and for the workstation owner.

### Removed

- `/api/admin/workstations`, `PUT /api/platform/team`, the platform two-factor reset of other users, simulation tools on real organizations, and the database-connected remote render worker (`AOM_VIDEO_PUSH_URL`). See the BREAKING (self-hosted) entries under Changed.

### Fixed

- A release is refused while a submodule points behind the latest release of the project repository it points to. The Ship release item lists each submodule's state (pinned, behind, not on a release tag, not checked, unknown); behind or not on a release tag greys out Approve with the reason and the fix (bump the submodule to the tag and refresh), and the server refuses approve and Retry the same way. Unknown is a warning and never blocks; repositories without project submodules ship as before.

## [1.9.0] - 2026-11-15

Runner 0.1.76.

### Added

- Release prep regenerates the assistant's knowledge. A new step, Regenerate assistant knowledge, runs after Update Help articles (ticked by default when that step is ticked) and rebuilds the assistant's knowledge pack from the Help articles on the workstation, so a release whose Help changed ships matching assistant answers. Repositories without the pack skip it; a workstation whose runner is too old skips it too instead of failing the run. Runner announces `release-docs-prep-assistant-pack:1`.

### Changed

- Handoff checks run, block and cover the whole repository. Lint, format and typecheck now run at every success handoff of a builder, a tester and a writer, over the whole repository: a problem in any file refuses the handoff, also in files the card did not change, and a check that cannot run (an error or a timeout) refuses it too, with its last output lines and what to do. Problems only in end-to-end test files are owed by the tester and do not block a builder; a tester or writer is told who can fix code it may not edit. The refusal is posted on the card, and a check that cannot run twice in a row raises a desk alert. The agent's own lint and test text is shown as its note; what the runner measured is the evidence. Deploy the server before the runners (an older server drops a newer runner's handoff report silently), then update the workstations; older runners keep the old behaviour for one release.
- Unit tests as a handoff check. A confirmed unit suite with a handoff command runs the unit tests of the files the card changed at a builder's handoff; a failing test refuses it. Suites without one run at regression. On regression and full-suite cards the runner runs every confirmed unit suite whole and each failing test file becomes one bug card. Testers never run unit tests. Unit suites are proposed from the repository and confirmed under Tests and settings. Migration 3000.

### Fixed

- The handoff checks and the worktree preparation no longer hang on the network. Package managers are kept offline in the check sandbox (pnpm, npm, yarn, corepack, uv and pip settings, `dotnet format --no-restore`, and no network namespace), so a check that needs a missing tool fails at once with its name instead of timing out after 5 minutes, and the worktree preparation installs from the shared package store (trusting the committed lockfile; runner setting `prepTrustLockfile`) or says plainly which package is missing.
- The Windows installer no longer asks for a restart at "Turning on WSL2" every time it runs. It now checks whether WSL2 works instead of whether one optional Windows feature is on, asks for a restart only when one is really pending and at most twice, and otherwise stops with a message that names what is still off. The restart for Ubuntu is also asked for only once.

## [1.8.0] - 2026-11-15

Runner 0.1.75.

### Added

- Automated apps. An organization Owner can add a GitHub App under Settings > Automated apps so agents can later act as its bot user. The private key is encrypted in the browser for each chosen workstation and stored there only after GitHub accepted it; the server keeps no key. Workstations mint and refresh short-lived installation tokens by themselves and keep them in memory only. Headless workstations use `guildwise-runner apps connect github`. Update workstations to runner 0.1.75.
- PR-only review for project repositories. The owner can switch a project repository to PR-only in the project settings, and its open pull requests are then recorded as not reviewed. Waiting pull request list requests are now replaced or expire, and a connected workstation is preferred.
- PR size check. In a PR-only repository, a pull request over the project's size budget is marked needs split and its author is asked to split it by a comment review on the pull request; nothing is added to the owner's Desk. Stacked pull requests (base branch is the branch of another open pull request) are measured together, each counting its own changes. A timeout alone never sends a pull request back. When an owner re-run times out again, the size check runs at once: over budget goes to needs split; within budget stays not reviewed and the owner gets a timed out twice item with the 2-working-day reminder. Inactive when the project has no size budget. Migration 2970; runner announces `pr-notice:1`.
- PR size exception. For an over-budget pull request the CEO agent can ask the owner for a size exception with a reason of at least 20 characters (`aom ceo act size-exception --pr <id|url> --text <reason>`); a request without a reason is refused. The owner sees the reason and the size against the budget on the Desk and approves or rejects. Approved: the pull request is exempt from needs split up to the approved size. Rejected, or no answer within 2 working days (owner's time zone, no reminder): the pull request goes to needs split and its author is notified. Requests and outcomes are kept in a Size exceptions history on the Pull requests page. Migration 2980.
- Hard size check. A project with a size budget and unit now gets a commit status named `size-budget` on every open pull request of its GitHub repositories: failed when the pull request (or the stack of pull requests it belongs to) is over the budget, passed within it, and passed with "owner exception" when the owner approved a size exception. The message names the size, the budget and the unit. Nothing is posted for a project without a budget. The owner makes the status required on the branch on GitHub (user guide 4.3d); GuildWise never changes branch protection. A workstation posts it with its own status token (`guildwise-runner status-token github`, Commit statuses: write only), kept encrypted on that workstation. Migration 2990; runner announces `commit-status:1`. Update workstations to runner 0.1.75.
- Owner reminder for pending items. When an item has been waiting on the owner for 2 working days, the owner gets one reminder. The state of the item is not changed, so nothing moves on without the owner.
- Design gate. New cards on the lean team workflow (code version 7) can stop after Investigate & design until the project owner approves the design. The gate is off by default; switch it on per project in Project settings, or for one card once its design report exists. The owner reads the existing design report on the desk item and approves it (the card moves to Build) or returns it with a note. Designs that touch high-risk paths stop at the gate even with the gate off. Cards already in flight keep their workflow.
- Second reviewer (Opus) on live PR-only pull requests. After a 20-PR replay has been recorded, the project owner can switch it on in Project settings. Both reviewers then review each pull request, their findings are merged (duplicates posted once and credited to both reviewers), the findings cap applies to the merged set, and a timeout or failure of either run posts nothing. A pair counts as one automatic review against the daily limit. Needs a runner that supports review pairs.

- Card worktrees get their submodules. When a card shift starts on a card worktree (new or reopened), the runner fills the submodules at the commits the branch pins, from the repository registered on the workstation or else from the submodule's own url, before the agent starts. No git config is written, `git status` stays clean, and a submodule that cannot be filled is reported on the card without stopping the shift. Run worktrees use the same lookup and no longer write the clone's git config.

- Industry bundles for accounting and law. Open **Industry bundles** on Rules & decisions to browse, preview, install and uninstall a bundle in one step. A bundle brings a rule pack, playbooks, knowledge templates, sample data and journey templates, so an accounting or law firm can start from ready-made material and remove it cleanly.

- Agents act as the selected app. Each project can choose which automated app its agents post as. Commits, pushes, pull requests, merges, releases, comments, and ticket and issue posts then carry the app's identity with automatically refreshed tokens. Projects with no app selected keep today's behaviour. Project settings show the identity each repository will use and warn when an app lacks access.

- First PR reviewer. In a PR-only repository an automatic reviewer now reviews each pull request in an isolated read-only checkout and posts its findings as comments only. A review stops after 10 minutes and posts nothing partial. A new **Pull requests** tab lists the reviews. Links in the checkout that point outside it are replaced before the review starts.

- Reviewer findings cap. The reviewer posts at most 1 finding per 100 changed lines, with a minimum of 1 and a maximum of 5. The rest are held back and shown on request, so pull requests are not flooded with comments.

- Daily cap on automatic reviews. Each project gets at most 20 automatic reviews per day, queued oldest first, and the used count is shown. The owner can still start a review by hand and that goes past the cap.

- Review by hand and re-run. The owner can start a review of a pull request with **Review now**, including a re-run of a timed-out or failed review. The re-run shows when the timed-out run started.

- Useful or noise marks on findings. The owner marks each posted finding as useful or noise without seeing which reviewer wrote it. A precision figure per reviewer is then shown, so you can tell which reviewer is worth keeping.

- 20-PR replay. Before the second reviewer goes live, the owner can replay 20 merged pull requests offline through both reviewers, mark the findings blind, and see the precision of each reviewer and a baseline review effort. The replay does not post anything to the pull requests.

- Review settings per project. The owner sets a size budget, a size unit and a map from paths to risk in Project settings. There are no defaults, so size and risk checks stay off until the project sets them.

- Size estimate and needs split at design time. The architect now estimates the size of a design and gives a verdict against the project's budget. Only an over-budget card goes back to the business analyst once, with the folder scope and suggested split points, and the owner decides after that. Upgrade: update workstations to runner 0.1.75 to use the needs-split step.

### Changed

- Deploy checkouts allow a local (`file://` or path) submodule url only when it is a repository registered on the workstation.

- Free hosting. Hosted pricing and billing text is removed from the product, since hosting is free.

- Video rendering uses fewer encoding threads. The renderer now limits ffmpeg to 4 threads by default so it no longer overloads the machine. Self-hosters can change this with `AOM_VIDEO_ENCODE_THREADS`.

### Fixed

- Parking or answering a discovery question no longer fails with a server error. Long display names are now shortened to the allowed length, so people with long names can park and answer questions as normal.
- The secret of a journey hook called as `POST /api/hooks/<id>/<secret>` no longer appears in the app request log or in the bundled Caddy logs; it is replaced with `[redacted]` and the hook id stays visible. Self-hosters who copied an older `deploy/Caddyfile` should copy the new global log filter from it.

- Creating a discovery session no longer fails with a server error when the owner's display name is longer than 100 characters. The name is now shortened to the allowed length.

- Package installs work in sandboxed agent shifts. The sandbox now allows the fixed lock folders that pnpm 12 uses and points pnpm 11 and later at the shared package store. Installs that used to fail in shifts now complete.

- A public form submission that expired while it was being stored is no longer answered as received. The person filling it in now learns that it was not kept instead of believing it was.

- Agent shifts that run with a cleaned process environment no longer lose their shift token. Each session now gets its own environment file, so those shifts can still talk to the platform.

- A workstation no longer replaces a stored git token file that is not a readable token file with an empty one. Your existing file is kept as it was, so tokens are not lost during the move to encrypted storage.

## [1.7.0] - 2026-11-14

Runner 0.1.74. No migrations and no new environment variables. Roles changed: tester v14, planner v3, architect v6, builder v8.

### Added

- Metrics shows where the time and money go. Two new tables on the Metrics page: **Time and cost by role** (shifts, cards, shift time, median shift, cost and cost per card, per role, seniority and model) and **Builder rework by seniority, model and card size** (cards a builder submitted, how many came back from review, rework rounds and the rate). Use them to judge, for example, whether the stronger model pays off on large cards; read a rate together with its card count. New `team` object on `GET /api/metrics`.
- Planner and architect can mark a card large (`aom risk large --reason "<why>"`) before its first build, so a senior builder takes it. They never lower a card's size; the business analyst and the manager still set either size.
- Cards that only need tests are worked by the tester. The architect marks such a card with `aom design --tests-only`; its Build stage then goes to a tester (the hire hint names the tester when none is hired) and the tester needs no test environment for it. The server refuses the flag on an investigation-only card and when no active tester may work the project. A runner older than 1.7.0 ignores the flag and the card goes to a builder as before.
- More hashtags on every social post. Facebook now takes 0 to 5 (was 3), LinkedIn 3 to 8 (was 5), X and Bluesky 1 to 3 (was 2), TikTok 3 to 8; Instagram stays at 5 and YouTube is unchanged. Besides the topical hashtags, each post gets one standing tag and one popular tag (at most two from either kind), rotated by a fixed rule so the same post always gets the same tags. Defaults: standing OpenSource, Free, FreeSoftware, SelfHosted, FOSS; popular AI, Automation, DevOps, Tech, Productivity, AIAgents, GenerativeAI, MachineLearning, Programming, SoftwareDevelopment. On X and Bluesky the standing and popular tags are dropped first when the text does not leave room for them.
- Two platform settings, `blog_writer_hashtags_standing` and `blog_writer_hashtags_popular`, replace those lists; an unset key uses the defaults and an empty list turns that kind of tag off. `PATCH /api/platform/blog/writer` accepts `hashtagPools`, and the blog writer and video status responses carry it.
- Worktree preparation. When the runner creates a card's worktree it installs the project's dependencies (pnpm, npm, dotnet, uv, go and the other toolchain steps) in the run-step sandbox before the agent starts, within 5 minutes, so the agent no longer spends its first minutes or a DevOps request on it. A failed or cut-off preparation does not fail the shift: it is noted on the card and the agent is told what was not prepared. New runner config key `prepareWorktrees` (default `true`) turns it off. **Submodules are not prepared**: a repository with submodules gets one line telling the agent to ask DevOps.
- Queue position for parked cards. A card parked on a DevOps request says where the request stands ("number 2 of 3 in the DevOps queue" or "running now") in its park messages and in `aom card facts`.

### Changed

- DevOps requests are served in a better order. Requests somebody waits on (a parked card, an agent still holding a card shift on that card, or a card held at Test deploy) go first; any request older than 30 minutes joins them, so nothing starves; the rest keep their order of arrival. While one DevOps shift has run for 5 minutes or more, a second DevOps shift may start for such a waited-on request of another card, so a short setup request no longer waits behind a 10-minute shift. At most two DevOps shifts run per engineer.
- Stop-loss: a large card gets three review rounds (was two) before it is parked; its budget is now 4 build passes, 3 review rounds and 25 shifts. An agent (the architect, when there is no CEO) may extend one card's budget at most three times; after that the owner's desk decides, and the stop-loss item shows how often the budget was extended.
- Builders run the whole unit test command of each package they changed once, after their last change, as their evidence; while working they run only the test files they touch. (Builder v8.)
- A builder is no longer stopped for editing documentation, `package.json`, lock files or configuration inside an E2E folder, or for E2E fixtures and snapshots (those count as test content); the builder's handoff checks ignore E2E test content. A tester on a tests-only card is still held to its specs.
- A read-only role (such as the reviewer) is judged on what it changed during its own shift: files that were already modified when the shift started no longer get it refused.
- `aom question --recommend` counts from 0. A number equal to the option count is read as the 1-based number of the last option, and the accept message always says how the number was read; any other wrong number is refused with the valid ones listed.
- `CHANGELOG.md` merges with git's union strategy (`.gitattributes`), so two cards' changelog entries rebase without a conflict.

### Fixed

- Instagram video uploads that ended in a processing failure are retried. A processing failure, a Graph "unsupported request" or "does not exist" answer and an answer marked transient are retried up to 4 attempts with a new container, using the existing back-off of 1, 5 and 30 minutes; an authorization or rate-limit refusal, a server error and invalid media keep their old handling, and nothing is ever published twice.
- MP4 files are written without edit lists (`-use_editlist 0`, with the index at the front): the rendered videos and the MP4 copies of help videos that Instagram refused.
- Org chart: an agent tile is named by what it shows (name, role, status, workstation), followed by where its questions go; the screen-reader name no longer differs from the visible text.
- A drifted submodule no longer blocks a card. A submodule found off its pinned commit is reported to the agent with the one command that puts it back (`git -C <path> checkout <pin>`); the runner does not reset it. If the pin is not available locally the agent asks DevOps (`aom question --topic environment`).

### Security

- The runner no longer runs a program planted in a nested repository or submodule of an agent's worktree: its own git commands stay out of them. Update workstations to runner 0.1.74.

## [1.6.2] - 2026-11-12

Runner 0.1.73.

### Fixed

- Release prep can write its changes again. Since 1.6.1 the release prep steps are written by the workstation's DevOps engineer, but its session was not allowed to create files with the file tool, so every writing step (the changelog first) ended with "the agent ended without `aom prep done` or `aom prep fail`". The DevOps engineer may now create files; what it may never touch (the runner's secrets and keys, its own settings, your Claude sign-in files) stays blocked.

## [1.6.1] - 2026-11-11

Runner 0.1.72.

### Changed

- Upgrade: Node.js 26 in the container images. The server image (build, video worker and runtime stages) and the media image now build on Node.js 26 instead of Node.js 22. Self-hosters who build the images themselves or extend them should rebuild and check any additions of their own against Node.js 26.
- Build tooling: vite 8.3.7 (pinned exactly in the root and the web package; chosen over 8.3.6 because it is what the lockfile already resolved and differs only by a newer bundled rolldown) and jsdom 31 for the web unit tests. `build.rollupOptions` is now `build.rolldownOptions`. The web tests now run on the vitest and jsdom the web package declares (a stale jsdom 30 copy was removed from the lockfile), and parse5 is held at 8.1 under parse5-parser-stream, which jsdom 31 needs to parse documents. @vitejs/plugin-react 6.2.1, @tailwindcss/vite 4.3.5 and vitest 4.1.12 already support vite 8 and are unchanged. Deferred: vite 8.3.8.

### Fixed

- Discovery and boardroom sessions can hand over long documents again. The facilitator could not save a PRD or brief draft, and the Chair could not save the minutes: the agent's command was refused whenever the Markdown spanned several lines with headings, and the agent could not write the text to a file instead. Session agents now write long Markdown to a file in their own scratch folder and pass it with `--content-file`; a read-only card checkout stays read-only. Reviewers likewise put their risk analysis in a file in their scratch folder (`--risk-file`).
- Release prep steps no longer fail on a read-only checkout. The release prep work (changelog, user guide and the other ticked steps) is now always given to the workstation's DevOps engineer, who may write the release files. Before, it could go to a builder, business analyst or architect whose sandbox cannot write there, and the step failed.
- Long chat messages reach the agent. A chat message too long to pass on the command line is now handed to the agent another way, so a long mention or a big pasted text no longer makes the chat fail to start.
- Agent sessions whose final report was accepted keep their short grace to finish, even when the stop arrives together with the acceptance. Their real usage is now recorded instead of an estimate, and they are no longer labelled as stopped.
- Stopping the runner no longer hangs on an agent session whose cleanup is stuck: it waits only a short grace and then stops. A background download of the PDF browser is cancelled when the runner stops, so it no longer keeps writing into the runner's data folder afterwards.

## [1.6.0] - 2026-11-10

Runner 0.1.71.

### Added

- PDF copy of a public form's answers. Next to the `.json` and `.html` copies, the firm's storage now also gets a `.pdf` with the same base name in the same folder, made on the firm's workstation from the HTML copy it receives (the server never renders, stores or keeps it). The browser that prints it (Chrome Headless Shell through `playwright-core`) runs with scripts and network off, is installed by the Linux and macOS installers in a step that never fails the install, and is repaired by the runner after an update; `guildwise-runner pdf-renderer install|status` and a `doctor` line manage and show it. If the copy cannot be made the submission still succeeds and the desk gets one notice, "PDF copy missing", pointing to the HTML copy. The submissions list shows the PDF entry. New optional `derive` on `storage.write.open` and `derived` on `storage.write.result` (no protocol version change).
- Optional malware scan of public form uploads, set per workstation (`uploadScan`, off by default). With a clamd running on the workstation, each uploaded file is scanned before it is written to the firm's storage. An infected file, or a scan that cannot run, is never written and the whole submission is taken back; infected files are kept in an owner-only quarantine folder on the workstation. The submitter sees a plain message and keeps their answers. `doctor` and "Test connection" report whether clamd answers.

### Security

- The server no longer trusts every `X-Forwarded-For` hop. The new `AOM_TRUST_PROXY` setting decides which proxies may set the client address that every per-address limit uses: unset trusts loopback only (`127.0.0.0/8`, `::1`); `false`, `0` or `none` never trusts the header; a number from 1 to 32 trusts that many hops; a comma-separated list of IPv4/IPv6 addresses and CIDR ranges (and the names `loopback`, `linklocal`, `uniquelocal`) trusts those peers; `true` restores the old behaviour and logs a warning at startup. An invalid value stops the server at startup with a message naming the variable. **Default changed**: before, any client that reached the server directly could choose its own address and get past the per-address rate limits. A reverse proxy on the same host keeps working unchanged; a proxy in another container or on another host needs the setting, or every visitor shares the proxy's address. The bundled `docker-compose.prod.yml` sets `loopback,uniquelocal` for the app and the video worker. See docs/SELF-HOSTING.md "Running behind a reverse proxy".

### Changed

- Inbound webhook relay: body limit per kind. A `whatsapp_cloud` integration now accepts up to 3 MiB (Meta's payload size) without any setting, and the new `AOM_RELAY_MAX_BODY_BYTES_BY_KIND` (`kind=bytes` pairs, at most 4 MiB each) overrides the limit of any kind; other kinds keep `AOM_RELAY_MAX_BODY_BYTES`. An over-limit body is refused with 413 before it is read in full.
- Bundled Caddy: every log line, errors included, now goes through a filter that deletes token, signature and credential headers and redacts the secret part of the public relay, hook, form and invitation addresses; request body limits apply to `/relay/in/*`, `/hooks/in/*` and the public form API; the image is pinned to `caddy:2.11`. `AOM_STORAGE_MAX_FILE_BYTES`, `AOM_JOURNEY_HOOK_MAX_BYTES` and `AOM_RELAY_MAX_BODY_BYTES` now reach the app and the proxy from `.env`.
- Public forms on installs served over plain http: attachments are hashed in the background (in a worker, or a chunk at a time on the page), so a large file no longer freezes the page. When the check before sending takes longer than 3 seconds the page says so, a browser that cannot do the check at all is told the form needs a secure (https) link while the answers stay on the page, and a `403 bad_origin` now says to use the link the firm gave instead of a generic error.

### Fixed

- Runner: the temp dir of an agent whose folder was removed outside the runner (a reset of the data folder, a hand cleanup, a wipe that stopped half way) no longer stays in `/tmp` for good. Each agent temp dir now holds a small `.aom-owner` file, and at start the runner removes the temp dirs of its own agents that no longer exist (never another runner's, never a live or resumed agent's, never a dir without that file).

- Release ship recovery: Retry on a stopped release is refused once the release was dismissed or is otherwise no longer approved, and nothing is sent to the workstation. A release whose workstation went offline, was removed or lost the request while it prepared the release commit now shows as **Release stopped** with Retry and Dismiss instead of waiting forever; Retry goes back to the same workstation and makes no second commit or tag when the commit was already pushed. Dismiss removes the unpushed release commit the workstation kept for a Retry (runner capability `release-ref-cleanup:1`, new runner command `release.ref_cleanup`).

- A rebase onto the base branch that fails for a reason other than a conflict is no longer reported, shown or routed as a conflict. The runner reports a conflict only when git stopped on conflicting paths and it listed them; any other failure (a held `index.lock`, a read-only git dir, an untracked file in the way, a missing base ref) is a rebase error carrying the base ref, the git command, its exit code and git's message (secrets redacted, at most 2000 characters), sent in a new optional `rebaseError` field on the finalize result, the `shift.rejected` message (reason `worktree_failed`) and `run.status`. A branch that already contains its base is left alone (no rebase, head unchanged); only `git merge-base --is-ancestor` exit 1 leads to a rebase, other exits are errors. After a conflict or an error the runner aborts only a rebase or merge that is actually in progress and never resets, cleans or stashes, so untracked files stay as they are. The server treats a conflict without files (also from an older runner) as a failure on all three paths: finalize raises the desk escalation, a shift rejection backs off like `worktree_failed`, a test environment fails normally; the card thread names the base branch and quotes git, and the card is not sent back to Rework and gets no DevOps conflict attempt.

## [1.5.0] - 2026-11-05

Runner 0.1.68 (capability `checks:1`). Forms builder, storage connections, public forms, journeys with waits, gates and webhooks, retiring a workstation with agent handover, and release prep. Migrations 2810, 2820, 2830, 2840, 2841 and 2850. New optional environment variables `AOM_STORAGE_WRITE_TIMEOUT_MS`, `AOM_STORAGE_MAX_FILE_BYTES`, `AOM_STORAGE_MAX_IN_FLIGHT`, `AOM_STORAGE_MS_TENANT`, `AOM_STORAGE_MS_CLIENT_ID`, `AOM_STORAGE_GOOGLE_CLIENT_ID`, `AOM_STORAGE_GOOGLE_CLIENT_SECRET`, the `AOM_FORMS_*` limits (`AOM_FORMS_POW_BITS`, `AOM_FORMS_MIN_FILL_MS`, `AOM_FORMS_SESSION_TTL_MIN`, `AOM_FORMS_SUBMISSION_TTL_MIN`, `AOM_FORMS_MAX_FILES`, `AOM_FORMS_MAX_SUBMISSION_BYTES`, `AOM_FORMS_IP_PER_MIN`, `AOM_FORMS_IP_BURST`, `AOM_FORMS_IP_SUBMITS_PER_HOUR`, `AOM_FORMS_IP_SUBMIT_BURST`, `AOM_FORMS_FORM_SUBMITS_PER_MIN`, `AOM_FORMS_FORM_SUBMIT_BURST`), the offline-link settings `AOM_FORMS_OFFLINE_LINK_DAYS`, `AOM_FORMS_OFFLINE_HOLD_DAYS`, `AOM_FORMS_OFFLINE_SETTLE_SEC`, `AOM_FORMS_OFFLINE_MAX_OPEN`, `AOM_FORMS_OFFLINE_IP_PER_HOUR`, `AOM_FORMS_OFFLINE_IP_BURST` and `AOM_FORMS_OFFLINE_FORM_PER_HOUR`, and `AOM_JOURNEY_HOOK_MAX_BYTES`, `AOM_JOURNEY_HOOK_PER_MIN`, `AOM_JOURNEY_HOOK_BURST` and `AOM_JOURNEY_HOOK_TOLERANCE_SEC`. Runner capabilities `storage:1` and `shift-limit:2`; new runner commands `storage.*`, `journey.webhook.call` and `release.docs_prep`.

### Added

- Forms builder. Owners and Admins design forms under Work > Forms: drag fields from a palette (short text, long text, email, phone, number, date, dropdown, radio, checkbox, file upload) or add them with a tap or the keyboard, reorder, duplicate and delete them, and set label, required, placeholder, help text, min/max, options and upload types, size limit and destination. The form settings add a title, description, company logo, a destination for the answers and a confirmation text. A live preview shows the form as a client will see it, with the same validation messages. Every save is a new version; earlier versions stay readable. Migration 2820.

- Storage connections (Organization settings, Storage). An Owner or Admin connects the firm's own storage: OneDrive or SharePoint, Google Drive, S3-compatible storage (endpoint, bucket, region, access key), a local folder or NAS reachable from the runner's workstation, or a folder in a knowledge vault. Sign-in for OneDrive/SharePoint and Google Drive happens on the workstation with a code (device sign-in); S3 keys, the local path and the vault folder are sealed in the browser for the runner. Tokens and keys are stored encrypted on that workstation only (`secrets/storage.json`) and used only by the runner: the Guildwise server never receives, stores or logs them and knows only a connection id, its type, a display name, the workstation and the health. Each connection can be tested (the runner writes and deletes a small probe file and shows the result or a typed error), renamed and removed; removing it deletes the encrypted token from the workstation, also when the workstation was offline at the time (it is removed at the next connection). An expired or revoked sign-in shows as "Needs re-authentication" with a Reconnect action that keeps the folder settings.

- A write operation for forms and journeys. The server streams a file in 256 KiB chunks to the one runner that holds the connection, under a credit window and one deadline, without writing it anywhere: no table, file or log holds the content, and the only thing recorded is the health of the connection. The runner writes the file into the folder given by a folder and name template (for example `{journey}/{client}/{field}-{date}`), never overwrites (a clash becomes `-2`, `-3`) and answers a reference (connection id, path or object key, size, checksum) that the caller may keep. When the storage cannot be reached the write ends with a typed error (`auth_expired`, `unavailable`, `quota`, `permission`, `not_found`, `too_large`, `runner_offline`, `timeout`) in a bounded time and nothing is kept on the server. `runner_offline` is answered at once when the workstation is not connected.

- Public forms (migration 2830). An Owner or Admin publishes a form from its new **Share** tab and gets a public address (`/f/` followed by a long random id) with a QR code that encodes exactly that address, to download as PNG or SVG. **Unpublish** closes it: the address then says "This form is not available", exactly like an address that never existed. **Create a new link** replaces the address for good. Publishing is refused while the answers or a file field has no storage connection. **Publish changes** moves the address to the newest saved version.
- Personal links. Each is for one client or record (use a client number, not a name), expires in 7 to 90 days, can be revoked, and works once: the first completed submission uses it up. The link carries no personal data (a random id, an expiry and a signature) and sits after a `#` in the address, so it is not sent to any server log. An expired, revoked or used link is refused with a clear message.
- Clients fill the form without a Guildwise login, on a phone or a computer, with the company logo and the same checks as the builder's preview. Answers and files are sent to the firm's own storage through its runner: the readable HTML copy and the JSON of the answers, and every upload at the folder and name the form sets. The server keeps only the status, the times, the form version, the personal link and the storage references. If the storage fails the client sees "Your answers are still here. Try again." and only what is missing is sent again; nothing is marked complete until everything is stored. When the firm's workstation is offline the form says it cannot accept submissions right now. The Share tab lists submissions with where they were stored.
- Public form security (review in `docs/security/public-forms.md`). The server checks everything again however the browser behaves: required fields and rules, file type by extension and by content (a renamed program is refused; programs, SVG and macro-enabled documents are never accepted), file size before the file is read, and the number of files. Requests are limited per address and per form (`429`), pages carry a single-use session with a hidden field, a minimum time and a small proof of work (no third-party CAPTCHA), and the page loads no third-party script and sends a policy without inline script or style. Logs never hold an answer, a file name, a token or an address.
- New optional environment variables `AOM_FORMS_POW_BITS`, `AOM_FORMS_MIN_FILL_MS`, `AOM_FORMS_SESSION_TTL_MIN`, `AOM_FORMS_SUBMISSION_TTL_MIN`, `AOM_FORMS_MAX_FILES`, `AOM_FORMS_MAX_SUBMISSION_BYTES`, `AOM_FORMS_IP_PER_MIN`, `AOM_FORMS_IP_BURST`, `AOM_FORMS_IP_SUBMITS_PER_HOUR`, `AOM_FORMS_IP_SUBMIT_BURST`, `AOM_FORMS_FORM_SUBMITS_PER_MIN` and `AOM_FORMS_FORM_SUBMIT_BURST`. Run the server behind a reverse proxy and set `AOM_SECRET_KEY` (rotating it ends every personal link).
- Move any agent to another workstation. Owners and Admins get **Move** on every agent of the Agents page (and **Re-home** for an agent that needs a home), listing the organization's workstations with their owner and connected or offline state. `POST /api/agents/:id/rehome` no longer requires the status `needs_rehome`; it refuses a retired agent, the CEO (it moves on the CEO page), an agent in a running shift (409 `agent_busy`), an unknown or other organization's workstation, an unpaired one and the current one. `AgentRehomed` records `fromWorkstationId`. New `GET /api/agents/:id/move-targets`. The hiring manager can also move their own agent; see Changed.

- Journeys (migration 2810; a database that already has 2820 applies it too, migrations run by file name): a new object (playbooks and workflows are unchanged) for one complete process from trigger to outcome, made of existing workflows linked by handoffs, all working on one shared record (a client, matter or deal). The designer (Journeys in the Work menu) adds workflow steps, orders them with Move up and Move down (works on touch), and defines handoffs: when a step is done, cancelled or either, go to another step or to the end, with an optional condition on a field of the finished card or on the record (type, status, visits). A handoff may go back to an earlier step (a loop, such as monthly rent). A journey is versioned; an instance keeps running on the version it started on. Saving sends the version it was based on (409 when someone else saved first).
- The shared record holds only status, current step, timestamps and references (documents, form submissions, cards, playbook sessions) plus a display name and the firm's own id. Never answers or document content: the record schemas refuse unknown keys, and a reference cannot hold whitespace or inline data. Tables `journeys`, `journey_versions`, `journey_records`, `journey_record_refs`, `journey_instances`, `journey_step_runs`; card origin `journey`; events `JourneySaved`, `JourneyArchived`, `JourneyRecordCreated`, `JourneyRecordReferenceAdded`, `JourneyRecordClosed`, `JourneyInstanceStarted`, `JourneyStepEntered`, `JourneyStepCardStarted`, `JourneyStepRefused`, `JourneyStepCompleted`, `JourneyStepPlaybookStarted`, `JourneyInstanceStuck`, `JourneyInstanceCompleted`, `JourneyInstanceCancelled`.
- Instances start by hand on a record. Each workflow step starts a card in the workflow; when the card is done or cancelled the instance follows the first matching handoff. A step with no handoff ends the journey; handoffs where none matches, or a step that cannot start (workflow not enabled, person no longer a member), leave the instance stuck with a desk notice, never silent. Transitions run under a row lock and are checked against the expected visit, so they happen once, also across a server restart. At most 240 visits of one step and 1000 in all.
- A workflow step can name a playbook. "Run playbook" starts it through the existing guided-session feature and keeps the session as a reference on the step and the record.
- Wait and gate steps are placeholders until the waits and gates change: they show on the designer and stop the instance with a "Continue past this step" action.
- The rentals template (lead, viewing, application, wait for forms and documents, screening, approval gate, lease signed, deposit and first-rent invoice, move-in, monthly rent loop) built on the business workflows.
- The Journeys page lists journeys and running instances with filters by journey, step and status; the instance page shows the current step, the history with times and the references.

- Journey waits, gates and webhooks (migration 2840). Wait steps pause a journey for a time, for a date taken from a field of the previous step's card, for a form or document upload through a personal link, or for a webhook event. Every wait has a deadline that shows on the journey and exactly one timeout action: remind and keep waiting (then ask on the desk or cancel), go to a named step, ask the project owner on the desk (Extend, Continue now, Go to step, Cancel the journey) or cancel the journey. Every wait that ends, for any reason, leaves an event on the instance; none ends silently. Timers are stored rows swept by the scheduler, so they survive a server restart and fire once; a wait that fell due during downtime fires once at the next pass and plans the next reminder from then on.
- A wait for a form creates a personal link for the record and shows it on the desk (a task: "Send this link to ...") or passes it to a webhook step, and the journey goes on when the submission has been stored in the firm's storage. No e-mail address is added to the record.
- Approval gates ask a named person, a role, the project owner or the organization Owner on the desk. Approve follows the approved handoff and reject (a note is required) follows the rejected handoff; a handoff saved as done or cancelled is read as approve or reject. Only the approver decides, the first decision wins, and a gate cannot be passed with Continue. A named person who has left the project falls back to the organization Owner and it is shown.
- The journey designer has settings for every wait (what to wait for, how long, what happens on timeout), gate (who decides, an optional deadline) and webhook call (computer, URL, method, headers, body), and a Webhooks panel for inbound addresses (the secret is shown once). The instance page shows each wait and call with its deadline, reminders, link and events, and a person can extend, continue, move or cancel a wait, or decide a gate. Gates, timed-out waits and client links are desk items that can be decided there. A gate reminder raises a new question for the approver on the desk, so it is seen.
- Journeys can start from a signed webhook, `POST /hooks/in/<token>`. The signature (HMAC-SHA256 with a secret shown once, `X-Guildwise-Signature` and `X-Guildwise-Timestamp`, or `X-Hub-Signature-256` over the body) is checked on the raw bytes before anything is read; a missing or wrong signature is answered `401` and logged without the payload. A mapping picks only an external id and an optional display name from the payload; the journey starts on the record that matches the external id or on a new one (`422 ambiguous_record`, `409 record_busy`, `422 no_record` when creating is off), in the name of the person who created the trigger. A repeated `Idempotency-Key` starts nothing. No payload is stored or logged, and a webhook trigger can also resume a wait for a webhook event.
- Webhook call steps call a URL (method, headers, a body from record values) from the firm's own workstation, which adds credential headers and an optional signature from its own encrypted store, so Guildwise never holds them. A failed call is retried after 1, 5, 30 and 120 minutes; the final result shows on the journey and a journey without a handoff for a failed call is stuck with a desk notice.
- New runner command `journey.webhook.call`; new optional environment variables `AOM_JOURNEY_HOOK_MAX_BYTES` (65 536), `AOM_JOURNEY_HOOK_PER_MIN` (60), `AOM_JOURNEY_HOOK_BURST` (30) and `AOM_JOURNEY_HOOK_TOLERANCE_SEC` (300). An unconfigured wait or gate keeps its earlier behaviour and waits until someone continues it.

- Runner offline: secure upload link sent later (migration 2850). When the firm's runner is offline, a public form shows an email box instead of the fields and sends nothing but that address: no answer or file reaches the server. The journey instance shows the wait "Documents pending, runner offline" with its start time. When the runner is back online for 30 seconds, each waiting client gets one email with the firm name and a secure link (signed, single use, 7 days by default; set per form under Settings, or `AOM_FORMS_OFFLINE_LINK_DAYS`), and the desk gets one notice per case with the client, the times and the journey. The journey continues when the form arrives through the link, or from the desk with Continue journey. The held email is encrypted (AES-256-GCM, a purpose key) in its own table, never in events, logs or desk items, and is deleted when the case closes (link used, journey continued, expired or cancelled; the runner must return within `AOM_FORMS_OFFLINE_HOLD_DAYS`, default 7). An Owner or Admin can Show email (audited) or Resend link (up to three times) on the desk notice. New optional variables: `AOM_FORMS_OFFLINE_IP_PER_HOUR`, `AOM_FORMS_OFFLINE_IP_BURST`, `AOM_FORMS_OFFLINE_FORM_PER_HOUR`, `AOM_FORMS_OFFLINE_MAX_OPEN`, `AOM_FORMS_OFFLINE_HOLD_DAYS`, `AOM_FORMS_OFFLINE_LINK_DAYS`, `AOM_FORMS_OFFLINE_SETTLE_SEC`.

- Write changelog in release prep. When release prep is on, a new Write changelog step adds user-facing entries for the release's changes to the Unreleased section of each repository's `CHANGELOG.md`, keeps the entries already there and never writes one twice. The Release prep tab on the Releases page lists the entries added per repository, and a changelog the release notes cannot read stops the step with the fix to make.

- Retire a workstation with agent handover. On the Workstations page an Owner or Admin can retire a workstation and either move all its agents to another workstation or mark them as needing a new home (re-home them one by one later). Retiring is refused while one of its agents is in a running shift, and the refusal names them. A workstation that was already unpaired but still holds agents is listed under "Removed workstations with agents" with a "Hand over agents" button. The retirement and each handover are written to the audit log. New events `WorkstationRetired` and `AgentNeedsRehome`; endpoints `GET /api/workstations/:id/retire-preview` and `POST /api/workstations/:id/retire`.
- Release prep (for the people who ship a project). Under Project settings > Release prep (docs and videos) the project Owner, or an organization Owner or Admin, switches release prep on and ticks its steps: Analyse changes, Update user guide, Write changelog, Generate videos and Commit results. On the Releases page a new **Release prep** tab (it shows only for a project that uses it) has **Run release prep**, the state of each step per repository, the change summary, the guide sections changed and the commits made. While prep has not passed, **Approve release** on the Ship release item is greyed out with the reason and a **See release prep** link, and the server refuses the approval too; a failed prep offers **Retry prep** or **Skip prep for this release** (the skip is recorded with your name). Off by default. Migrations 2830 (`release_docs_prep`), 2840 and 2850 (release prep output, step report and tasks); the runner command `release.docs_prep` does the work on a workstation.
- Move all agents off an offline or removed workstation. On the Workstations and Agents pages an Owner or Admin gets **Move all agents from this workstation**. A hiring manager gets the same button for an offline or removed workstation, and moves only the agents they hired. The dialog first previews who **Will move** and who is **Blocked**, each blocked agent with its reason (in a running shift, one DevOps engineer per workstation, workstation limit reached, runtime missing on the target, the CEO moves on the CEO page) and a button to move that agent on its own. After you confirm it lists who was moved and who was not.
- The CEO can move agents between workstations. In your own chat the CEO has `aom ceo act move-workstation --agent <name|id> --to <workstation>` and `aom ceo act move-agents-off --from <workstation> --to <workstation>`; they run the same checks as the Move and Move all dialogs.
- Builder handoff checks. A project's repository checks (lint, format, typecheck) now run on `aom handoff`, by the runner, on the builder's committed change, and the handoff is refused while the change fails a check in a file it changed. The refusal prints the failing lines, the log path and, for a formatter or import sorter, the fix command; the builder fixes (or runs the fix command), commits and hands off again, and nothing reaches review in between. Checks are a new suite kind, `check`, managed like the project's test suites in the project's Environments page under Test copies > Tests and settings (a new **Checks** section): the runner proposes them from what the repository declares (package.json lint, typecheck and format scripts, the CI workflow, Biome, ESLint, Prettier, ruff and dotnet format config; for this repository `pnpm lint --max-diagnostics=none --diagnostic-level=error` and `pnpm -r --no-bail --if-present typecheck`) and the owner confirms, edits or removes them. Only confirmed checks run and block; proposed ones never do. Only failures in files the change touched block; failures only in other files are recorded as information and shown to the reviewers (a change that breaks an unchanged file is not detected yet). A check that cannot run (missing tool, timeout, no sandbox on the workstation, output cut by the tool, a failure that names no file) never passes silently and never blocks: it is recorded as a warning on the evidence, on the card thread and in the owner approval, and the reviewers see it as unverified. Checks run under the run-step sandbox profile (bubblewrap; credential folders, the runner's data and .NET user secrets masked), at most 10 minutes each and 6 minutes in total per handoff. The result is stored with the build evidence, bound to the commit, and shown to the pre-reviewer, the reviewer and the owner. A runner without the capability hands off exactly as before and the server never requires checks. Builder role version 7 tells builders about the checks. No migration; the runner needs 0.1.68 on the workstations that run builders. Checks run only where bubblewrap is available (or the sandbox is switched off in the runner config).

### Changed

- Moving an agent. The hiring manager can now move their own agent, and the Org chart agent card has **Move to workstation** next to the Agents page button. A move releases claims the agent holds without a running shift (`ClaimReleased` reason `agent_moved`) instead of refusing, and still refuses a running shift. A DevOps engineer moves only off an unpaired workstation onto one without a DevOps engineer (409 `devops_stays` / `one_devops_per_workstation`); the dialog warns first. `GET /api/agents/:id/move-targets` names the DevOps engineer on each target.
- Workstation shift limit. The setting on the Workstations page now decides how many shifts a workstation runs at once, and the runner reports the limit it enforces (runner capability `shift-limit:2`). Each workstation shows `running of limit` with where the limit comes from (workstation setting, platform cap, runner config, runner local fallback or shared with other pairings), how many chat and CEO shifts are not counted, who holds the slots when it is full ("Held by GWP-94 (Ada)"), and a warning when the runner enforces something other than what is set. A refused shift says `N shifts already running (limit N), source: ..., held by ...`. Update a runner that does not report its limit.
- A card that goes back to a build stage (rework) is offered first to the builder who worked it last.
- The runner refuses to commit leftovers that delete many tracked files or put an earlier version of the tree back, and says so on the card instead of committing.
- The phone layout keeps the tab bar fixed at the bottom, adjusts to the on-screen keyboard and keeps the open page when the window crosses the 768 px breakpoint.
- The tour has a Forms step.
- The platform Videos tab shows how many drafts are waiting (against a limit of twice the ticked days) instead of a weekly count, because the writer is limited by the waiting pile, not by the week.

### Fixed

- Unpairing a workstation now retires its DevOps engineers in the same step (history is kept and an audit event is written for each), releases the work they held, and flags the other agents on that workstation as needing a new workstation. A one-off data migration (`orphaned-devops-2026-11`) retires DevOps engineers that were already left behind. The runner clears the old workstation's saved shifts, queued reports and DevOps agent folders when it is unpaired or paired again (runner 0.1.66).
- An agent that needs a new home can be re-homed even when its old shift was never ended.
- Chat with the CEO in bypass permission mode: the CEO's `aom` commands failed because the shift variables were removed from the commands the turn ran. The shift variables now reach `aom` through a file in the turn's folder.
- The "commits on another branch" check only counts a card's own branches. A shift is no longer refused because another card's branch moved without it.
- The architect check lets merges of the base branch through, and discarding out-of-scope changes no longer reverts work that was merged in.
- The card's own `.git/worktrees/<card>` folder is writable inside the shift sandbox, which ends `index.lock` failures in git commands.

## [1.4.0] - 2026-11-01

Runner 0.1.65. Software and Business views, the six business workflows built in, any workflow as a variant base, releases from start to finish, and a clear way back when a computer is removed. Migrations 2751, 2791, 2800 and 2801. New optional environment variables `AOM_RELAY_MAX_BODY_BYTES`, `AOM_RELAY_RATE_PER_MINUTE`, `AOM_RELAY_RATE_BURST`, `AOM_RELAY_TIMEOUT_MS`, `AOM_RELAY_TIMEOUTS`, `AOM_RELAY_RETRY_AFTER_SEC`, `AOM_RELAY_MAX_IN_FLIGHT` and `AOM_RELAY_RETENTION_DAYS`.

### Added

- Software view and Business view. What used to be the organization's Developer or Business mode is now a view, and a view is presentation only: every organization has every capability (repositories, builders, reviewers, testers, DevOps, packs by git URL, business roles, rule packs, Brief playbooks, inbound webhooks, all card types and workflows), and nothing is refused because of a view. The organization has a default view (Organization, General), and each person can pick their own from the user menu (Software view, Business view or the organization default); it is stored per organization membership (`org_members.view`, event `OrgMemberViewSet`, `PUT /api/org/view`). Switching is instant, never refused, and appends only the preference event: no data, workflow, project, repository, agent, deploy or card changes. The Business view uses plain words (Rules & decisions, Knowledge, Ask for technical help), leads with the business card types, roles and project types (the software ones sit under "More"), tucks away test environments and releases (their addresses show a note with one click to the Software view), collapses the repositories of a project and keeps workstations and Ask for technical help. A project in the Business view has a **Build something** button that walks through the workstation, the software conversion (with the repository) and the builder, using the existing screens. The six business workflows (Enquiry, Follow-up, Document request, Reminder, Report, Quote) are true built-in workflows, registered once for everybody at start like Code, Research and Feed; they are enabled on every project at start and when a project is created. A later version reaches every organization at the next start.

- Inbound webhook relay, for every organization. An Owner or Admin creates an integration (WhatsApp Cloud API, form webhook, incoming webhook, calendar push or generic) and gets a public URL `/relay/in/<token>` once. The server forwards each request, raw and with its headers, over the runner's connection to a workstation that serves the integration, and gives the provider the status the runner answers. The server keeps no content: only a hash of the token and metadata per request (time, integration, size, status, latency, outcome). With no runner connected the provider gets 503 with `Retry-After` and retries; nothing is queued. The runner has a `relay` command (`list`, `add`, `remove`) and a `generic` handler that stores events in its data folder.

- Approving a Ship release now makes the release commit. A workstation that has the repository moves the Unreleased entries of CHANGELOG.md under the new version and date (an empty Unreleased stays, and the intro line gets one sentence per component, such as `Runner 0.1.63.` or `Runner 0.1.62 (unchanged).`), raises the version file of every component whose files changed, commits `chore(release): x.y.z` as the project's commit identity (signed off when the repository asks for a DCO) and pushes it to the working branch without force. Repeating it makes no second commit. A failure leaves a "Release stopped" item with git's message, Retry continues from that step, and Dismiss abandons the release. The repository row shows the state. Migration 2780; new runner command `release.ship`, capability `release-ship:1`.

- Tag and release after the release PR is merged. Once the release commit is in the release PR and the PR is merged (or Guildwise merges it when the project lands work without pull requests), Guildwise tags the merge commit `vX.Y.Z` (annotated, never moved) and creates the release: GitHub (notes are the version's changelog section, marked latest) and GitLab; Azure DevOps, Bitbucket and plain git get the tag and a notice that no release page was created. A failed step leaves a "Release stopped" item with Retry that continues from that step and makes nothing twice. The repository row shows the last release with tag and release links. New repository setting "Release name" (expert mode, defaults to the project name). Migration 2790; new runner command `release.publish`, capability `release-publish:1`.

- A merge into a submodule now moves the pin before the deploy. When a card merges into repository X and an `after_merge` environment deploys another repository D that holds X as a git submodule, the server sends the new runner command `repo.bump_submodule` (runner 0.1.64) to a workstation with D. The runner finds the submodule by url in D's `.gitmodules` (nothing to set up), commits `chore: pin <path> to <sha>` with the project's commit identity and a `Signed-off-by` line, pushes D's working branch (never forced, once more from the new tip if origin moved) and answers D's new head, which is what the environment deploys. Several merges in the two-minute window give one bump with the newest commit. A failed bump (protected branch, refused push) is a desk notice and deploys nothing; D not holding X, or a runner older than 0.1.64, deploys D as it is (the latter with a notice that the pin was not moved).

- The CEO can read logs and status in full power. In your own chat the CEO has `aom runner status` and `aom runner logs [--kind runner|service|shifts|env|audit] [--name <file>] [--lines N] [--grep text] [--since "-3 hours"]` for this workstation (the runner's log, the systemd journal, shift, environment and CEO command logs), `aom ceo diag workstation <name>` for another workstation of yours (new runner command `runner.diagnostics`, capability `ceo-diagnostics:1`, runner 0.1.65 or newer, migration 2800) and `aom ceo diag server [--kind status|logs]` for the server's status and its recent log lines. Read-only, tokens and passwords masked on the runner and again on the server, and only in the Owner's own full-power turn: a standing-order turn, a wake and a CEO on another user's machine are refused with a message saying why.

### Changed

- The six business workflows are built in, not copies in each organization. New project describes each one in plain words with its own icon, the organization page and the convert dialog show them as Built in, and a new version of one now reaches every organization (a per-organization copy never did). The boot data migration `business-builtin-2026-11` moves the copies the 1.4.0 pre-release created: an unedited copy is retired so the built-in takes over (cards in flight finish on the version they started on); a copy the owner edited is kept as a normal custom workflow under `<key>-custom` (name "... (edited)"), and the projects that used it follow. A project repointed to `<key>-custom` does not get the built-in of that key enabled again (it counts as a workflow the project had); the owner can enable it in the project's settings. Skipped with `AOM_DATA_MIGRATIONS=false`. New events `WorkflowVersionDeactivated` and `WorkflowKeyChanged`.
- Any workflow can be the base of a project variant (Customise): Code, Research, Feed, the bug-fix workflow, the business workflows and your own. Only a variant itself cannot be extended again; extend the workflow it was made from. A variant of research, feed or code-bugfix follows the rules of its base: it can only run in a project of that kind (a research project runs research and its own variants), never next to Code, and a bug-fix variant is not a project workflow.

### Fixed

- Unpairing a computer no longer breaks the places and environments that deployed from it. Each place (server or computer) and live environment that ran on the removed computer is now marked "computer removed" (new event `DeployTargetComputerRemoved`, migration 2801 `deploy_targets.computer_removed_at`; the place keeps its old computer for the record). Before, Check, Check again, Fix with DevOps, secrets, moves and deploys answered "workstation not found", the card kept offering Check and hid Reconnect. Now they answer 409 `deploying_computer_removed` ("The computer that deploys <place> was removed. Choose another computer for it."), the card and the Places panel say so and offer **Choose a computer** (a server opens Reconnect, a computer place offers your active computers), nothing probes a removed computer, and the daily server check skips it. The project owner can recover a live place. The Unpair dialog lists the places and environments that will need another computer (`GET /api/workstations/:id/unlink-impact`); unpairing still goes ahead once confirmed. The boot data migration `deploy-removed-computers-2026-11` marks places whose computer was removed earlier (events only, idempotent, skipped with `AOM_DATA_MIGRATIONS=false`). When the project's vault lived on a removed computer, saving a setup now says the vault must be moved first.

- The workflow builder kept no date format on a field: a workflow with a date field (the business workflows) lost the format when saved from the builder.
- An organization vault can take a git remote after the automatic local one exists. Registering a git URL for the organization (or editing the local organization vault) converts that same vault and keeps its content, as a project's local vault already did, instead of 409 `vault_exists` / `vault_local`; Settings > Vaults offers it.

- Decisions, standing orders, investigation notes and conversion notes follow the same vault as the rest of the knowledge: the project's git vault, then the organization vault, then the project's automatic local vault. They no longer stay in the local folder when an organization vault exists.

- The Releases page of the app moved to `/delivery/releases`, so a reload or a shared link reaches the app (the public release blog keeps `/releases` and `/releases/<version>`). `/releases` and `/deploys` still lead there inside the app.

- A business workflow an owner turned off on a project stays off. The check at start and the install on a new project only add the workflows the project has never had (read from its event history); it no longer switches a disabled one back on.

- A deploy of a repository that holds another as a git submodule (the cloud holds the core) builds again: the runner fills each submodule of the deploy checkout at its pinned commit, from this workstation's own clone of that repository when it has one (a missing commit is fetched into that clone first), and removes such a checkout afterwards without leaving a worktree entry. Before, the submodule folder stayed empty and the build failed.

- Run regression (the manual full suite) in a project with several repositories asks which repository; before, it ran on the first by id. `POST /api/projects/:id/full-suite` takes an optional `repoId` (an active repository of the project); without it a project with several repositories is refused with `choose_repo` naming them, and a project with one behaves as before. Project settings shows a repository picker (name and working branch) when there is more than one.
- The New card form of a Business mode organization offers the business card types in their own order (Enquiry first, and the default) instead of the alphabetical order of their workflow keys.
- Saving the same component version rules again no longer records a new `ProjectRepoComponentRulesSet` event: the unchanged check compared the stored rules by their serialized key order, which the database does not keep, so it never matched.
- Every `after_merge` deploy failed with `commit_unavailable` in a project whose cards merge into one repository while the environment deploys another: the merge commit of the card's repository was handed to a clone of the other. A merge commit is now only used for the deploy of its own repository (the newest merge of that repository, else the head of its working branch), in the trigger, the automated-commit allow-list and the default commit. `deploy_trigger_queue` remembers the repository of the merge (migration 2751).

- Finalize no longer sends a card back to Rework with an empty "conflict" when nothing conflicted. A card branch that is already on the working branch (merged by hand, or by an earlier finalize whose answer was lost) is reported merged straight away, before any rebase. A merge that git refuses without a conflicted file (a lock, a missing ref, a refused signature) is reported as a finalize failure with git's own message, which reaches the desk, instead of a conflict for the builder that loops back through review.
- The CEO in full power no longer fails on permission checks it should not hit. The Owner's chat runs in Claude Code's `auto` mode, whose classifier refused ordinary reads (the runner's logs, the systemd journal, `aom runner restart`, `aom ceo act ...`) without ever reaching the desk question, and the deny floor also blocked reading the runner's logs and `status.json` and every `systemctl ... aom-runner*`, even `status`. Runner 0.1.65: the floor now only blocks stopping, starting or editing the runner service (reading it is allowed), and a hook says why a command was refused and what to use instead (`aom runner logs`, `aom runner restart`). The default permission mode is unchanged (`auto`, for new and existing opt-ins); `guildwise-runner ceo full-power on --bypass` is a new explicit opt-in to Claude Code's `bypassPermissions` for the Owner's own chat, where nothing is judged or asked like in your terminal (the deny floor, its hook, the audit and the masking of secrets still apply, and the runner's provider credential is kept out of the shell's environment); `on --strict` goes back to `auto`. A standing-order turn always runs in `auto` with the desk relay. In the Owner's chat a missing citation or a reached action limit now asks him with an inline confirmation instead of a refusal, and a refusal by the policy names where the owner changes it. `CeoTurnFinished` records the turn's permission mode and the first words of its commands.

## [1.3.0] - 2026-10-29

Runner 0.1.62 (unchanged). The video schedule, Short destinations and worker roles. Migrations 2740 to 2742 and a data migration (`video-schedule-2026-10`). New optional environment variables `AOM_VIDEO_MAX_BYTES`, `AOM_VIDEO_ROLE`, `AOM_VIDEO_WORKER_TOKEN`, `AOM_VIDEO_WORKER_PORT`, `AOM_VIDEO_PUSH_URL` (now requires `AOM_VIDEO_WORKER_TOKEN`), `AOM_TIKTOK_CLIENT_KEY` and `AOM_TIKTOK_CLIENT_SECRET`.

### Added

- Video worker roles: `AOM_VIDEO_ROLE=render|publish|all` (default `all`). A server that cannot render runs `publish`; a render worker elsewhere pushes each finished file over HTTPS to `PUT /api/worker/video/renders/:id/files/:name` (bearer `AOM_VIDEO_WORKER_TOKEN`, sha256 and size checked, served by the publish worker on `AOM_VIDEO_WORKER_PORT`, behind the reverse proxy) and a render counts as done only when every file is acknowledged. The video status reports `render` and `publish` heartbeats next to the combined `worker`. A rendered video whose file has not arrived yet is waited for until its slot instead of failing.
- YouTube videos: a publishing schedule (`docs/BLOG-API.md` "YouTube"). Per format (videos, Shorts) you tick the weekdays, the local time and the time zone (default Africa/Johannesburg, daylight saving handled) and the destinations; a video goes out at the next free slot. The writer's weekly limit is the number of days ticked, and it stops while twice a week's slots wait in review or are scheduled. Slots are managed with new calls: `schedule`, `unschedule`, `move`, `swap`, `preview` and `GET /slots` under `/api/platform/video`.
- Destinations for Shorts: YouTube, Facebook (Reels), Instagram (Reels), X, LinkedIn, Bluesky and TikTok can be chosen in the schedule and per video, with a caption each (the drafter can supply default captions with the video; no caption carries a link). The publish worker posts each at the slot with back-off until 6 hours after it, then marks the destination failed and mails you; one failed destination can be retried on its own (`POST /api/platform/video/posts/{id}/shares/{network}/retry`, the Queue shows a button per failed destination). Instagram and TikTok are channels in Social sharing but not share networks of the blog. TikTok connects with OAuth (`AOM_TIKTOK_CLIENT_KEY`, `AOM_TIKTOK_CLIENT_SECRET`), posts from a signed temporary media URL (`GET /api/public/video-media/...`), needs your privacy choice and consent for every post, and posts privately until you tick that the app passed TikTok's audit. X video uses OAuth 1.0a and may need an OAuth 2.0 token (see docs/BLOG-API.md). The status strip names the render and publish workers separately.
- Events `VideoPostScheduled`, `VideoPostUnscheduled` and `VideoPreviewRequested`; `VideoPostApproved` no longer needs a render. A missed slot (not rendered 30 minutes before it) slips to the next free slot, and the super admins are mailed about it, about an offline render worker, a render that failed, an empty slot and a full video disk.

### Fixed

- A video that is not rendered 30 minutes before its slot slipped twice when the app and the worker noticed at the same time; the slip now re-checks under the slot lock. A YouTube `publishAt` is at least 15 minutes ahead (otherwise the video goes public at once) and is worked out again on a retry; a post moved or unscheduled just as its upload started is not uploaded with the old slot. Two render workers can no longer both claim a render. A re-flow no longer moves posts that are rendered, close to their render, or already on a slot of the schedule. Moving a post respects the normal minimum lead time. Unscheduling clears the TikTok options and the captions edited at scheduling. Scheduling a TikTok Short without options is refused. Share links in the video pages are shown only for https addresses. The server refuses to start with `AOM_VIDEO_PUSH_URL` and no `AOM_VIDEO_WORKER_TOKEN`; a 0-byte artifact is accepted by the push; stale push temp files are cleaned up; the data migrations take a database lock so two instances do not run them at once.

- Short destinations never post twice: a destination with saved progress counts as started (unschedule, move, slip and re-flow are refused), the request that publishes is not repeated blindly when its answer is lost, X's duplicate-content 403 no longer pauses the channel, a retry keeps TikTok's publish id, TikTok token renewals and callback states are serialized and single-use, upstream-provided upload addresses are checked against the network's hosts, disconnecting TikTok revokes its token, and an upload that ends after its slot is made public.

### Changed

- YouTube videos: the script is the review gate. Submitting or editing a script no longer renders anything; Schedule (the old Approve) gives the video its slot and the render starts `renderLeadHours` before it (48 hours for videos, 24 for Shorts), or at once for "publish now". A "Preview render" (one of the 3 renders) shows the video before you schedule it. YouTube publishes at the slot itself (`publishAt`); the limit of one upload a day is gone (one upload runs at a time).
- Storage of rendered videos: the MP4 is removed after publishing (every destination sent or skipped and the video public, or 6 hours after the slot), 3 days after a failed destination, 1 day after a rejection, 7 days after a preview in review nobody touched. A retry of a failed upload renders again. `AOM_VIDEO_MAX_BYTES` (default 5 GB) stops new renders when the disk budget is used.
- Settings `perWeek` and `shortsPerWeek` are replaced by `schedule`; until one is saved it is derived from them (3 and 3 give Monday, Wednesday and Friday at 10:00 for videos, Tuesday, Thursday and Saturday at 16:00 for Shorts).
- X: a refused video upload (401 or 403 from the media endpoints) fails that Short's X share only and no longer pauses the X channel, so articles keep posting.
- A Preview render runs while no YouTube channel is connected yet (it uploads nothing); scheduled renders still wait for the channel.
- The test suite no longer flakes under load: the media proxy's body watchdog takes an injectable clock (default `Date.now`, no behaviour change).
- Existing videos are brought over by the data migration: approved videos keep the slot they have on YouTube, ones still waiting get the next free slot, finished renders of videos in review become previews, and unfinished renders are dropped (they render when you schedule the video).

## [1.2.1] - 2026-10-29

Runner 0.1.62 (unchanged). Patch for the video weekly limit; no migration.

### Fixed

- YouTube videos: a video draft that you reject no longer uses up the week's video limit (`perWeek` and `shortsPerWeek`). Before, rejected drafts counted for seven days and could block new videos. Drafts, videos in review and approved videos still count.

## [1.2.0] - 2026-10-28

Runner 0.1.62 (unchanged). Release posts, per-network hashtags and the YouTube video worker; migrations 2720 and 2730. Videos stay off until a YouTube channel is connected and video posts are switched on.

### Added

- Blog: hashtags per social network (Facebook up to 3, LinkedIn 3 to 5, X and Bluesky 1 to 2), stored without `#` in `social.hashtags` of a post. The post editor shows a caption editor per network with a hashtag chip input, a live counter and the exact text that will be posted. X keeps its hashtags (the caption is cut first); Bluesky hashtags are clickable `#tag` facets. Caption limits live in one place (`SOCIAL_LIMITS`). Posts written before this keep their inline hashtags.
- Blog: release announcements. Platform > Blog > Releases lists each release from `CHANGELOG.md` with a post that you write (or, on a hosted installation, a drafter proposes), edit and approve; it is shared once per connected network and never without your approval. New public pages `/releases` and `/releases/<version>` (What's New plus the changelog, in the sitemap) are the link target. Optional `release:` in What's New entries pins an entry to a release. Migration 2720 (`social_posts`, `social_shares.source`).
- Blog writer setting `releasePosts` (on by default): whether a drafter creates a release post for each new release.
- YouTube push (`docs/BLOG-API.md` "YouTube"): Platform > Blog > Videos turns articles, releases and tutorials into narrated, faceless videos and uploads the ones you approve. One review gate on the rendered video (player with captions, script, title, description, tags, hashtags and privacy, edits render again, at most 3 renders), a Short per video approved separately, a YouTube channel in Social sharing (paste a refresh token; `AOM_YOUTUBE_CLIENT_ID`, `AOM_YOUTUBE_CLIENT_SECRET`), at most one upload a day at 10:00 Johannesburg time, a "kept private" warning when YouTube locks an unaudited API project, a Library import of the existing help videos, a Video topics list for new showcase videos, an optional cross-post of a tutorial, and YouTube embeds on `/blog/<slug>` and `/releases/<version>`. A separate `video-worker` container (compose profile `video`) renders and uploads. Off by default and a no-op without a connected channel. Migration 2730 (`video_posts`, `video_renders`, `video_topics`, `social_shares.detail`).
- Video renderer (`@aom/video`, `docs/VIDEO-RENDERER.md`): turns a script into a narrated 1920x1080 video or a 1080x1920 Short with captions, thumbnail and YouTube description, using the help videos' voice and clips of the help videos. Run from the command line with `node dist/video-worker.mjs --render script.json --out dir`; not used by the app yet.

### Changed

- Bluesky posts no longer repeat the link in the text: the link card carries it.
- LinkedIn posts use API version 202610 (202509 was sunset) and Facebook posts Graph API v26.0 (v21.0 ends 2027-01-21). LinkedIn captions are escaped for LinkedIn's text format.
- The X caption limit is 256 characters with its hashtags (the link is added and counts 23); Bluesky 300 characters. Before, the limits were 250 and 270 and differed between the editor and the server.
- Connecting LinkedIn: a pasted `urn:li:organization:<id>` is cut down to the id. The Social sharing panel is at the bottom of Platform > Blog (Posts tab).


## [1.1.0] - 2026-10-27

Runner 0.1.62. Workstations update themselves; pack agents on seats need 0.1.62.

### Added

- CEO: a new signal flags a high-risk card (review risk "high") that has waited more than 24 hours for approval, counted from when it started waiting. Report only; it does not wake the CEO unless you add it to the urgent signals.
- CEO: the daily report lists the day's high-risk cards finished (merged, PR or push).
- Runner: `guildwise-runner` is installed alongside `aom-runner`; both names run the same command.
- Webhooks: outgoing signed webhooks carry `X-Guildwise-Signature`. `X-AOM-Signature` is still sent with the same value until October 2027.
- Packs: agents can be hired from an approved pack onto the built-in roles as their seat (analyst, BA, planner, architect, builder, pre-reviewer, reviewer, tester, researcher, writer), one at a time or the whole pack at once (all or nothing, Owners and Admins). They keep the pack agent's name and approach, join the agents already there, and the role's rules, gates and permissions are unchanged. Owners and Admins mark which skills of a pack are agents and which are playbooks. Pack agents without a seat get a role of their own that holds none of the pack's text. API in docs/ARCHITECTURE.md section 38.14; migration 2710.
- Packs: the Claude Code plugin layout is read (`agents/*.md` as personas, `commands/*.md` as one-step playbooks, at any depth); a pack may list 1000 capabilities. Needs runner 0.1.62. Only folders that belong to a Claude Code plugin are read. A pack approved before keeps working without these items until the Owner approves them.

### Changed

- New projects use `guildwise/` card branches (existing projects keep their prefix), and the runner's temporary integration branches are `guildwise/integration/<card>`. Branch cleanup recognises the old and new names.
- New local vaults are marked `.guildwise-local-vault` (the old marker is still written for one release and both are read); agent commits to vault repositories use `agents.guildwise.invalid`.
- New environment setups default to `~/guildwise-backups`. Deploy scripts' markers are read under both their old and new names, ahead of renaming them in a later release.
- One name for the CEO's report: "Daily report", on the desk, in the e-mail digest option and subject, and in the Help.
- Wording: "Add a workstation" (with "Pair with a code" for pairing codes) everywhere; the BA designs the organization with the Owner and Admins; "Agents page" instead of "HR board".
- The in-app Help and page help were checked against the current app and updated section by section.
- Removed the unused CEO cooling-off setting (`delayMinutes`); saved policies that contain it still load.
- The retired `.aom/test-env.json` is no longer read.
- Self-hosting: a runner connecting to a server with a private certificate authority needs `NODE_EXTRA_CA_CERTS` (docs/SELF-HOSTING.md).

### Fixed

- A bare skill key that is a playbook or a persona (`release`) is no longer rewritten to a pack skill of the same name when skills are qualified, and the key migration keeps it.
- Skills given to an agent (thanks to @Creative2911, #1): the skills added to a role with Extend now reach every agent on the role, in chats, sessions and card shifts alike, as loadable skills in the `# Capabilities` index and the runtime's skills folder. Before, chats got only the skills stored on the agent at hire, and card shifts listed the extension's skills as plain text only.
- A bare pack skill name typed into the hire form or a role extension (`bmad-prd`) is stored as the pack's full key (`bmad-method:bmad-prd`) when exactly one pack has it, instead of showing as "not found in the registry". The data migration `pack-skill-keys-2026-10` does the same for existing agents and extensions.
- Hiring with an empty Skills box gives the agent its role's skills (the form sent an empty list, which hired with none).
- An agent's skills follow its role: a new role version brings its new skills, and the agent's own additions and removals stay (`AgentPermissionsRebased` carries the skills).
- Reopening a published research card marks its publication superseded: the Research tab, phase completion and interest counts no longer count it, and publishing again leaves one live note.
- Reopening a bug card that was cancelled after a test failure puts its parent back to waiting when the parent is still queued or claimed in Test; otherwise both cards get a warning and the parent is left as it is.
- Media: a paused video is no longer cut after 30 seconds. Only real upstream silence (30 seconds) cuts a stream; a client that makes no progress for 10 minutes is closed. An upstream error mid-stream ends the response instead of throwing.
- Costs: the project filter lists every project, not only the selected one.
- Settings: you see and set your own time zone; non-Owners are told the daily report follows the Owner's zone.
- Intake and vault registration are offered only to people who may use them (desk, palette, empty board, discovery, Vaults).
- New research card from the Research tab starts on the research type.
- The org chart draws escalation to the CEO when one is active, as the routing does.
- CEO chat shows the error when the CEO status cannot be loaded, instead of "not set up yet".

## [1.0.1] - 2026-10-26

### Security

- Resolved all open security advisories: 21 Dependabot alerts (5 high, 15 moderate, 1 low) and the further findings from `pnpm audit`, which now reports no known vulnerabilities. Upgrades include nodemailer 10.2.1, @fastify/static 10.1.7, fastify 5.12.6, undici 8.12.2, zod 4.6.6, vite 7.3.7 and vitest 4.1.12, plus `overrides` for transitive packages (shell-quote, fast-uri, esbuild, @vitest/mocker).

### Fixed

- Runner: the outbox no longer throws when its data directory is removed while a shift or chat is still finishing. Nothing is persisted, the frame is sent best-effort, and a warning is logged, instead of an unhandled rejection that could stop the runner.

### Changed

- The site assistant's open-source facts (repository, self-hosting, license) are on by default.

## [1.0.0] - 2026-10-26

The first public release of Guildwise HQ, a way to run an organization of AI agents (set up for software delivery by default), under the Apache License 2.0. The repository keeps the development history, with the parts specific to the hosted service removed.

### Summary of what ships

**Work and delivery**

- Board with cards that move through spec, build, review, test, finalize and QA, with filters for blocked work, rework and items waiting for you.
- Project backlog, intake of tickets, and research cards.
- Discovery: turn an idea into a PRD with an analyst agent.
- Boardroom: a multi-persona discussion run by a chair agent, with minutes and "pull into PRD".
- Documents, including PRDs and minutes, with approval and version history.
- Phases, follow-ups, a release queue, environments and delivery recipes for deploys.

**Agents and team**

- Agent roles: business analyst, planner, architect (optional), builder, pre-reviewer, reviewer, tester and DevOps engineer.
- Hiring with seniority and per-project allow-lists; pausing, resuming and changing models.
- CEO agent in each organization, with a daily report and a desk for routine items.
- Org chart, custom roles, departments and workflows.
- Ledger of decisions, requirements and standing orders.

**Runtimes**

- Claude Code, Codex CLI, Gemini CLI, opencode and direct model APIs.

**Safety and control**

- Desk for questions, approvals and go-aheads; approval gates for risky steps.
- Sandboxed sessions: bubblewrap and socat on Linux and WSL2, Seatbelt on macOS, and a separate git worktree per session.
- Budgets and cost tracking per project and organization, with CSV export.
- Governance: "What it may do" per agent, audit log with CSV export, and an offboarding checklist.
- Two-factor login; organizations are isolated from each other.

**Knowledge**

- Vaults: git repositories of notes, synced to workstations.
- Capabilities and packs from git repositories, reviewed before use; playbooks and the `/` menu.
- Interests and automations.

**Operations**

- Workstations: runner for Linux, macOS and WSL2, with a guided installer; native Windows as an explicit, unsandboxed opt-in.
- Cloud workstations: a VPS over SSH, or a GitHub Codespace.
- Integrations: git hosts (GitHub, GitLab, Azure DevOps, Bitbucket Cloud) and Jira.
- Metrics, in-app help articles and a glossary.

**Self-hosting**

- Docker Compose stack: Caddy for HTTPS, the application, Postgres 18 and a media service for help videos.
- Migrations applied on boot. Platform account and organization invitations.
- Optional: Web Push, inbound mail, a landing-page assistant and a weekly blog digest.
- Every feature is included and organizations are unlimited: a self-hosted install has no plans, trials or limits.

### Notes for self-hosters

- Set `AOM_SECRET_KEY` and keep it with your backups.
- Back up the database before every upgrade. See [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).
- Update workstation runners together with the server.
