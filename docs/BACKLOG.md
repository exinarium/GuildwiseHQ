# Backlog

Logged fixes to pick up when development resumes. Newest first.

## 2026-10-13

Follow-ups from the 2026-10-12 release (items #1–#13).

### 14. Incoming webhooks as an automation trigger

**Decided (owner, 2026-10-12): later.** The `webhook_in` trigger kind exists in the schema (`packages/shared/src/schedules`)
but the server refuses it (`trigger_not_available`). Wanted: a per-automation URL with a secret (stored hashed), payload
fields as mapping tokens, the payload treated as untrusted (`renderUntrusted`), cards start as drafts unless the Owner
allows otherwise, rate limits and an audit run per call. See `docs/design/workflow-builder.md`.

### 15. Reply to an e-mail thread from inside Guildwise

`sendInThread` (`apps/server/src/mail/inbound/reply.ts`) sends into an inbox thread with the right Message-ID,
In-Reply-To and a `Reply-To` of `<address>+<thread token>`, but nothing calls it. Wanted: a "Reply" action on a card that
came from e-mail (and on the thread view), permissions (who may reply as the organisation), the reply stored on the
thread and the card, optional agent-drafted reply that a human sends.

### 16. "Owner approves" step kind in workflows

**Decided (owner, 2026-10-12): later.** A workflow step that waits for the Owner (or a named member) to approve on the
desk, with approve / send back routes, in the workflow builder and the validator.

### 17. Stale figures in the user guide

6 of the 87 figures in `docs/guide` still show old screens (`desk-branch`, the test-stage, conflict and large-merge
scenes, the phases-in-reporting scenes, desk items with the simple-mode / saved-work hygiene wording). The guide's seed
steps in the Playwright `guide` project fail on simple mode (phase reporting 409 `phase_not_open`, the hygiene
working-branch question, test-stage scenes, the edited-card step). Fix the seeds the way the e2e specs were fixed
(expert mode where needed), re-capture, rebuild `guide.html` and the PDF.

### 18. Working-branch question lists saved-work branches

The hygiene question "Keep trunk as working branch?" also offers the automatic `guildwise/saved-work/<date>` branches as
choices. Leave them out of the options.

### 19. Per-sender limit for inbound e-mail

Inbound mail has a per-organisation hourly limit (`AOM_INBOUND_RATE_PER_HOUR`). Add an optional per-sender limit so one
noisy or looping sender cannot use up an organisation's allowance.

### 20. Plugin MCP servers for sandboxed agents

**Problem (owner, 2026-10-13):** the MCP servers of the owner's Claude Code setup (on this workstation they come from
Claude Code **plugins**, for example Atlassian; user-scope `mcpServers` in `~/.claude.json` is empty) are not available
to sandboxed agents. Every agent starts with its own `CLAUDE_CONFIG_DIR` and `HOME` and `--strict-mcp-config --mcp-config
<configDir>/mcp.json`, which was always `{ "mcpServers": {} }` (only the BA intake chat had `intake.mcpConfig`). Roles can
be given `mcp:<name>` permissions, but no server was ever provided.

**Decided (owner, 2026-10-13):**
- Scope: **plugin MCP servers** (installed and enabled Claude Code plugins). Not claude.ai connectors, not hand-added
  servers; designed so those can be added later (`discoverPluginMcpServers` is the one source).
- Granting: **per project**. Project settings, "MCP servers" lists the servers the project's agents may use, picked from
  what that workstation's runner reports. A role **also** needs the `mcp:<server>` permission. Both are required.
- Safety: **only the organization Owner grants** servers to a project (server-enforced). The settings screen marks servers
  whose tools can write, send or delete (heuristic from tool names when the runner lists tools, otherwise a per-server
  warning) and advises read-only use. The tools agents call are logged on the card (server and tool names per shift). The
  DevOps engineer's behaviour stays unchanged.

**Built:** runner discovery and `mcp.servers` report, `ProjectMcpServersSet`, `shift.start` / `chat.start` `mcpServers`
(names only), local `mcp.json` and credentials handling, project settings panel, role builder picker, card "External tools
used". See `docs/RUNNER.md` "Plugin MCP servers".

**Follow-up decided (owner, 2026-10-13): per hired agent, Owner-only.** Built-in roles cannot be edited and have no `mcp:` tool, so built-in agents could not use any server. The Agents page now has, on each agent card, an "External tools (MCP)" section: one switch per reported server (with the write/send warning and a note that the project must also grant it), visible to everyone who sees the agent, editable by the org **Owner** only. Server: `PATCH /api/agents/:id` with `permissions` refuses new `mcp:` entries unless the caller is the org Owner (Admins and the hiring manager get 403), and the name must be reported by one of the Owner's workstations (400 `invalid_mcp_server`); removing stays open to Owner and Admins; DevOps stays fixed (`devops_fixed`). Hiring takes no permissions (they come from the role), so there is nothing to check there. No runner change: it already gates on the hired agent's `allowedTools`.

**Open:** tool names are not listed by the runner yet (needs starting the server or a cached tool list), so the warning is
the general one per server; refreshed OAuth tokens are not written back when a configured token (`oauth` / `api_key`) is used.

### 21. Jira attachments for agents and card attachments

**Problem (owner, production, 2026-10-13):** during intake the BA read Jira ticket DCPL-4276 through the Atlassian plugin
MCP server but could not see its screenshots or the attached `SlideOutHistory.svg`. Agent sandboxes have no network (a
shell reaches registries and `extraAllowedDomains`, a chat nothing: `apps/runner/src/adapters/claude-policy.ts`) and agents
hold no Jira credentials; the remote MCP server keeps the sign-in and its tools return attachment metadata, not content.
Guildwise cards also had no attachments, so the BA could not pass files on to the builders.

**Decided (owner, 2026-10-13): build both now.**
- **Runner-mediated Jira download.** `aom source attachments <KEY>` lists and `aom source attachment <KEY> [<file|id> | --all]`
  downloads: the runner calls Jira's REST API with its own credentials and writes the files to
  `<agent scratch>/attachments/<KEY>/`, returning the local paths for the Read tool. Only the ticket of the intake (or the
  card in context's `externalRef`); 20 MB per file, 60 MB per call; the token never reaches an agent. Credentials:
  `aom-runner jira-connect` (base URL, e-mail, API token) stores them in `secrets/jira.json` (0600); the old `jira` block in
  `config.json` is still read. The Workstations page shows Jira connected / not connected / refused (`jira.report`, never
  the token). The Atlassian plugin's OAuth sign-in lives inside the MCP client and cannot be reused for the runner's REST
  calls, so the API token is the supported way.
- **Card attachments.** Bytes in Postgres (`card_attachment_data`, migration 1780, operational: not in the event log, kept
  over a rebuild); `CardAttachmentAdded` / `CardAttachmentRemoved` carry metadata only. 20 MB per file, 100 MB and 50 files
  per card; images, svg, pdf, zip, Office and text; programs and scripts refused; type and content checked; SVG and HTML
  served sandboxed (CSP `sandbox`, `nosniff`, HTML as a text download). Whoever may edit the card adds and removes; every
  project member views. Web: Attachments section on the card (drag and drop, previews, download, remove) and on the New
  card form. Agents: `aom card attach <path> [--card REF]` (the BA, for the cards of its intake), `aom card attachments`;
  the runner copies a card's attachments read-only into `<agent tmp>/card-attachments/` at the start of every card shift
  (builders, reviewers, testers) and on demand for the DevOps engineer and chats.
- BA role v11: downloads and looks at the ticket's attachments, attaches the relevant ones to the cards it writes and
  says which.

**Built:** see `docs/RUNNER.md` "Jira on the runner" and "Attachments", `docs/USER-GUIDE.md` 3.7 and 4.8, help
(Board and cards, Intake and outbox, Workstations). Needs runner 0.1.3 and `aom-runner jira-connect` on the workstation.

## 2026-10-12

Owner's list of 2026-10-12. Item 8 of that list (reference repositories per project) is #4 below. The affiliate
programme (#3) waits until these are done.

**Build order (owner, 2026-10-12):** fixes first (#5, #7, #2, #12, #11), then repository access (#4, #6, #8), then the
architect (#9) and multiple workflows (#10), then design and build the workflow builder (#13). Runner self-update (#1)
alongside.

### 5. Bitbucket shows "not available" although it is connected

**Problem.** The connection check reports Bitbucket as not available on a workstation where Bitbucket was connected.
`BitbucketCloudForge.status()` (`apps/runner/src/forge/bitbucket.ts:52`) only checks that a token is saved, then calls
`GET /user`. Any failure there, including a 401/403 for a missing scope, a network error, or a saved token without the
account e-mail (`call()` needs `t.user`; git itself only needs the token, so clones keep working), is reported as
`not_connected`. Pull requests then fall back to "unavailable" (`forge/index.ts:72`).

**Wanted.**
- Seen in the **project settings** (owner, 2026-10-12).
- Reproduce on the owner's workstation (where it shows, the exact detail text) and fix the actual cause.
- Separate states: no token / token refused (with the HTTP status and the missing scope) / API unreachable / connected.
  Do not call it "not available" when git access works.
- If the check needs a scope the documented token does not have, either drop that need (check with a repository call
  instead of `/user`) or document the scope in the connect helper.
- Tests for each state.

### 6. SSH as an alternative to API tokens for repository access

**Problem.** Clones, fetches and pushes use HTTPS with the forge's token or CLI login (`GitAuth`, `forge/*.ts`). Some
owners already have SSH keys set up and do not want to create API tokens. `ensureSshKey()` (`forge/connect.ts:30`) and
`RepoRef.sshUrl` exist but nothing uses them for git.

**Wanted.**
- Per repository (default per workstation): access method **API token** or **SSH**. SSH uses a key the runner generates
  (`~/.ssh/aom_<provider>`, shown so the owner can add it to the host) or a key the owner points to.
- Git commands get `GIT_SSH_COMMAND` with that key and a pinned `known_hosts`; agents never read the key (the sandbox still
  denies `~/.ssh`; the runner runs git for them, or the key path is allowed for the git process only).
- The REST features (pull requests, branch rules, repository list) still need the token or CLI. With SSH only, the
  completion falls back to push and the manager opens the PR, and the UI says so.
- Tests: URL rewriting https to ssh, the env the runner passes, and the fallback.

### 7. The development environment check ignores a project in a sub directory

**Problem.** The environment check (`apps/runner/src/toolchain/ensure.ts:62`) scans each repository from its root
(depth 3), and the install steps assume the root (e.g. `dotnetRestoreTarget()` in `stacks.ts:59` only looks at root
files). A project whose code lives in a sub directory of the repository (monorepo, `src/app/`) is detected badly or fails
to install. There is no field for the project's path in the repository.

**Wanted.**
- A **project path** per project repository (`ProjectRepoAdded` / `ProjectRepoDto` / `EnvEnsurePayload.repos[]`), set in the
  project settings, default the repository root.
- Detection and install steps run from that path; card agents get it in their brief (where to build and test).
- Optional: detect several stacks in a monorepo and let the owner pick.
- Tests with a fixture repository whose app is in a sub directory.

### 8. Commit and push to the working branch, without a pull request

**Problem.** Card work always happens on a card branch, then the completion action is merge, pull request or push the card
branch (`CompletionAction`, `packages/shared/src/cards/types.ts:18`). The difference between the branch a pull request
targets and the branch the work lands on is not clear in the UI, and there is no "just commit and push" option.

**Wanted.**
- Two named branches per project repository, explained in the settings: the **main branch** (where pull requests go, e.g.
  `main`) and the **working branch** (where card work is integrated, e.g. `develop`). When the working branch does not exist it
  is created from the main branch and pushed (today `createWorkingBranch()` in `git/worktrees.ts:138` already does this
  for the base; make it the documented behaviour and show it).
- **Decided (owner, 2026-10-12):** agents keep working on a card branch; this option merges it into the working branch
  and pushes, with no pull request (today's `merge` action, renamed and made explicit).
- A completion action **Commit and push to the working branch**: no pull request; the card's commits land on the working
  branch and are pushed. The pull request (when used) goes from the working branch to the main branch, on request.
- Project default and per-card override; the user guide explains the three options.

### 9. Architect role and an investigation and design step

**Problem.** Investigation is a paragraph of the BA's instructions; a "code researcher" role was drafted to read code,
compare and investigate. The owner prefers an architect.

**Wanted.**
- A built-in **Architect** role (default model Opus). It investigates and designs: reads the code, writes a summary and design
  for the card, then hands off to the builders. It writes no product code but **may commit and push** (its documents) and
  **merge** (e.g. the main branch into the card or working branch, conflict resolution).
- **Decided (owner, 2026-10-12):** the BA keeps intake and the spec; the architect's stage follows the spec.
- An **investigation and design** stage in the code workflow between spec and build, claimed by the architect. It can also be
  placed after other work in a workflow. Scope includes comparisons (between repositories, against best practice), design
  and merging from main.
- **Merge latest main first:** a project setting (on by default) under which the BA always instructs the architect to merge the
  latest main branch before card work starts.
- **Investigation-only cards:** a card flag. The card ends after the investigation; the BA writes the result to the ledger
  and the project context. The report goes to the project docs by default, or to a location set on the card or project.
- **Read access:** the architect may read every repository under the organization's source folder on the workstation
  (read-only except its own card/working branch). Ties in with #4.

### 10. More than one workflow per project; custom steps in existing workflows

**Problem.** A project has exactly one workflow (`projects.workflow_key`); custom stages cannot be added to a built-in or
existing workflow.

**Wanted.**
- A project can enable several workflows; each card picks one (default by card type).
- Add custom steps to an existing project workflow (a project-level copy of a built-in workflow with extra stages, versioned);
  running cards keep their version.

### 11. "Fix" button that sends the DevOps engineer to fix an environment problem

**Problem.** Failed environment checks show "Check again" (project settings) or "Try again" (workstation repositories);
the owner has to write the DevOps request by hand.

**Wanted.**
- A **Fix** button next to every failed or missing item (environment check, verify rights, clone failures, tool reports with a
  `fix`). It files a `DevOpsRequested` with the error text, workstation, project and repository as context, and shows the
  request's progress; the check reruns when DevOps reports done.

### 12. DevOps cannot read or update the card it is working for

**Problem.** A DevOps request from a card carries only the card id/title (`DevOpsRequestContext`,
`packages/shared/src/events/devops.ts:40`). The DevOps shift has no card brief and no command to read card fields,
comments or attachments, or to update the card.

**Wanted.**
- When a request has a card, the DevOps brief includes the card (fields, context, latest comments, attachments).
- DevOps can read the card (`aom card show`) and comment on it / update the fields its task needs, scoped to that card.
- Tests: brief contents and the permission scope.

### 13. Workflow and role builder; sub-workflows and event triggers

**Problem.** Custom roles and workflows can only be made by asking the BA, who writes JSON in the Org Designer chat. This
is hard to use. Workflows cannot call other workflows, and nothing starts a workflow from an event.

**Wanted (design first).**
- A visual builder for workflows (stages, roles, transitions, fields) and roles (purpose, instructions, tools, model), with
  the BA as an optional helper instead of the only way in. Templates to start from.
- **Sub-workflows:** a stage can start another workflow (a child card) and wait for or continue past its result.
- **Triggers:** start a workflow from an event: e-mail received or replied to, ticket logged (intake), card done, schedule.
- Design doc and UI design before building.

### 4. Agents cannot read code outside their card worktree (chats, comparing repositories)

**Problem.** Sandboxed agents only read their card's worktree (`<runner>/worktrees/...`), their scratch dir and the
vault (Claude Code `blockReadsOutsideWorkingDirectories` plus the sandbox `denyRead`; `apps/runner/src/adapters/claude-policy.ts`).
`repoRoots` in the runner's `config.json` only says where repositories are discovered and cloned; it grants no read
access, and there is no setting that does. Consequences seen on 2026-10-12:
- **Chats** run in the agent's empty scratch dir unless they are about a card whose worktree exists on this
  workstation (`apps/runner/src/chat/chat.ts`, `chatWorktree`): a chat with an agent about a project, or about a card not
  started here yet, sees no code at all. Agents then guessed at a non-existent `config.json` setting.
- Agents cannot **compare repositories** (the owner needs this).
- Harmless noise: card agents' Read/Grep on the main repo's git metadata (`<repo>/.git/worktrees/<card>/HEAD`) is refused.
- Workaround today: chat with the workstation's DevOps engineer (unsandboxed, reads anywhere; also writes anywhere, so
  ask for read-only work).

**Wanted.**
- **Reference repositories per project:** in the project settings pick other repositories on the workstation that the
  project's agents may **read** (read-only: `--add-dir` + sandbox `allowRead`, `Edit`/`Write` denied, `denyWrite` in the
  sandbox), in card shifts and chats. Every other repo stays blocked; never open all of `repoRoots` (other projects,
  `.env` files, this platform's own code).
- **Chats with project context:** read-only access to the project's own repository (and its reference repos) when the
  repository is on this workstation; same fallback for a card whose worktree is not here yet.
- Allow Read on the card's own git metadata dir (the worktree's `gitdir`), read-only.
- Agent instructions: say which folders are readable and that the owner manages reference repos in the project settings
  (stop agents inventing config keys).
- Tests in the runner (policy builder, chat cwd/add-dirs) and the server/web (project settings, protocol field).

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
  encrypted, shown only to the super admin in the payout report. **EFT payouts are in ZAR, fixed from the client's
  invoice:** each commission is 20% of the invoice's rand amount excluding VAT (invoices already store `zar_cents` and
  `fx_rate`), so there is no exchange-rate risk at payout time. The $100 minimum is checked on the USD value; the
  statement shows both.
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

## Done

- #1: Runners update themselves once a day. Done 2026-10-12.
- #2: Verify rights fails on Arch: package manager not detected. Done 2026-10-12.
- #5: Bitbucket shows "not available" although it is connected. Done 2026-10-12.
- #6: SSH as an alternative to API tokens for repository access. Done 2026-10-12.
- #7: The development environment check ignores a project in a sub directory. Done 2026-10-12.
- #8: Commit and push to the working branch, without a pull request. Done 2026-10-12.
- #11: "Fix" button that sends the DevOps engineer to fix an environment problem. Done 2026-10-12.
- #4: Agents cannot read code outside their card worktree (chats, comparing repositories). Done 2026-10-12.
- #12: DevOps cannot read or update the card it is working for. Done 2026-10-12.
- #9: Architect role and an investigation and design step. Done 2026-10-12.
- #13: Workflow and role builder; sub-workflows and event triggers (incl. inbound e-mail). Done 2026-10-12; incoming webhooks later.
- #10: More than one workflow per project; custom steps in existing workflows. Done 2026-10-12.
- #20: Plugin MCP servers for sandboxed agents. Done 2026-10-13.
- #21: Jira attachments for agents and card attachments. Done 2026-10-13.

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
