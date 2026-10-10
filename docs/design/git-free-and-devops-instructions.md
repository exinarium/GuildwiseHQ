# Design: (almost) git-free projects, and DevOps instructions from anywhere

Status: investigation and design only, nothing built. Branch `overnight/2026-10-09`. Date 2026-10-10.

Owner's words: "Currently we expect the user to have some git knowledge. I want the user to interact as little as possible with git. I also want to be able to give the devops agents instructions anywhere. In some cases he operates in a sandbox and cannot execute my commands."

Out of scope: GitHub Codespaces and forges other than GitHub, which are researched separately. Where this design needs a forge, it says **[forge]**: list repositories, create a repository, open a PR, read PR state, read branch protection, and log in. That interface is the seam for the other research.

---

## Part 1: minimise the user's git interaction

### 1.1 What we found (the short version)

- Agents already do most of the git work. The runner creates worktrees, rebases, merges, pushes, opens PRs, sweeps worktrees and runs hygiene. A rebase conflict already goes back to the builder agent as Rework (`apps/server/src/commands/rebase.ts`), not to a human.
- Git knowledge leaks out at the **edges**: the add-repository form (a raw URL, `owner/name`, a branch field), the working-branch question, the per-card completion action, "Mark merged", hygiene failure labels, and credentials (`gh auth login` or an SSH key, which the installer never sets up).
- One hygiene behaviour is risky for a non-expert. Uncommitted changes in the user's own clone are **committed to the working branch and pushed** (`docs/RUNNER.md`, "Repository hygiene").
- There is a gap in conflict handling. After a `RebaseConflict` the builder gets the card back, but builders are denied `git rebase*`, `git checkout` and `git switch` (`packages/shared/src/roles/builtin.ts` L3-11). How the builder is meant to reconcile is not defined. Part 1.4 fixes this.
- There is no forge abstraction. Repo create and PRs use `gh`, and create mode hardcodes `https://github.com/` (`ProjectSettings.tsx` L111). Clone, push, merge and the merged check are pure git.

### 1.2 Touchpoint audit

Effort: S = under 1 day, M = 2-4 days, L = a week or more.

| # | Touchpoint | What the user must know or do today | File(s) | Proposed change | Effort |
|---|---|---|---|---|---|
| 1 | Add an existing repository | Choose "existing", type a name and a **Remote URL**, and optionally a branch. | `apps/web/src/pages/ProjectSettings.tsx` (`add()` ~L96-125, form ~L262-330); `apps/runner/src/repo/clone.ts` | A **repository picker**: "Pick from your GitHub" (list via [forge]); the name is filled in. The URL field only in expert mode. | M |
| 2 | Create a new repository | Type `owner/name` matching a GitHub regex (`ProjectSettings.tsx` L101); `gh` must be logged in on the workstation; the hint says "(gh)". | `ProjectSettings.tsx`; `apps/runner/src/repo/create.ts`; `apps/server/src/commands/repo-create.ts` | Owner dropdown (your account and orgs, via [forge]); name defaults to the project name; visibility defaults to private. | S-M |
| 3 | Clone location | The installer asks for repository folders (`installer/templates/common.sh` ~L211); clones go into the first folder. | `apps/server/src/installer/templates/common.sh`; `clone.ts` | Do not ask in simple mode; default `~/src`. Expert mode keeps the question. | S |
| 4 | Working-branch fields | Project form "Working branch" field; repo "Branch (optional)", whose hint says you will be asked later. | `ProjectSettings.tsx` (general form, repo form); `apps/web/src/components/WorkingBranchControl.tsx` | Default = the remote's **default branch**, **confirmed automatically** at the first clone (the runner already knows `defaultBranch`). Fields hidden in simple mode. | S |
| 5 | `working_branch` desk question | Answer "Which branch is the working branch?" for reasons `unconfirmed`, `phase`, `intake`, `manual`, `conversion` (`packages/shared/src/hygiene/index.ts` L184). A missing branch is now created from the default branch (commit `5f88be8`), with a question only if that fails. | `apps/server/src/commands/branch-confirm.ts`, `shifts.ts` (`branchProblemEvents`), `hygiene.ts`; `WorkingBranchQuestion.tsx` | `unconfirmed`: auto-confirm the default branch plus a one-time **notice**. `intake`/`phase` "keep main?": not asked in simple mode. Branch creation failed: becomes a DevOps request first, and the desk only if DevOps fails. | S-M |
| 6 | Hygiene problems | Read labels like "Working branch not confirmed", "Uncommitted changes on another branch", "Conflict while updating", "Authentication failed" in the BA daily report. | `packages/shared/src/hygiene/index.ts` (`HygieneProblemKind`); `apps/runner/src/devops/hygiene.ts`; `apps/server/src/commands/hygiene.ts` | `needs_branch` goes away (row 5). `dirty_other_branch` and dirty work in general are saved to a **saved-work branch** (1.4). `conflict` becomes a DevOps agent attempt. `auth_failed` gets a "Reconnect GitHub" button. All shown as plain-language outcomes. | M |
| 7 | Hygiene auto-commit on the working branch | Must know that edits in their own clone get committed and pushed to `main` daily. | `apps/runner/src/devops/hygiene.ts`; USER-GUIDE 4.4 | Simple mode: commit to `guildwise/saved-work/<branch>-<date>` and push that, never to the working branch (Q7). | S |
| 8 | Worktrees | Mostly hidden. A "leftover worktree with uncommitted work" appears in reports. | `apps/runner/src/git/worktrees.ts`, `sweep.ts` | Keep hidden; reword the reports ("an unfinished change from card X was kept aside"). | S |
| 9 | Completion action per card | Required build-stage field with **no default**: the select shows "None" plus the raw values (pr / push_branch / merge). The BA picks it at intake. | `apps/web/src/components/CardFormFields.tsx` L62; `CardDetail.tsx` L429; `packages/shared/src/roles/builtin.ts` L105,124 | A **project default**, "How finished work lands": *Straight into main after review and test* (merge) or *As a pull request I approve* (pr). Per-card select and `push_branch` in expert mode only. The BA follows the project default unless it explains why. | S |
| 10 | PR without `gh` | `pr` falls back to `push_branch` plus a `pr_notice` desk item when `gh` is missing. | `apps/runner/src/git/gh.ts`, `completion.ts` | Becomes a DevOps request: "install and connect GitHub on <workstation>" (Part 2). The user sees a "Connect GitHub" step, not a git error. | S (after P3) |
| 11 | "Mark merged" | Click it when a squash merge or a deleted branch hides the merge (the pure-git ancestor check). | `apps/runner/src/git/merged.ts`; `apps/web/src/pages/Phase.tsx` ~L292-300; `apps/web/src/help/page-help-content.ts` L83 | Read the PR state from [forge] (merged = done). "Mark merged" only in expert mode, as a fallback. | M |
| 12 | Rebase conflict | Nothing to do: the runner rejects with `rebase_conflict`, and the card goes to Rework for its builder with the file list. The user sees a git-flavoured system message. | `apps/server/src/commands/rebase.ts`, `shifts.ts` L541; `apps/runner/src/git/rebase.ts` | Keep the agent path. Plain text: "Two changes touched the same files; the builder is reconciling them." A human is asked only after `loop_backoff` (existing). | S |
| 13 | Large-merge approval | Approve "Merge approval". | desk subkind `large_merge` | Keep, reworded: "Approve this big change going live on main." | S |
| 14 | Credentials | Clone `needs_manager`: "Log in on the workstation (gh auth login, or an SSH key for the host)" (`clone.ts` L192). It only shows as a "Needs you" badge in `RepoSetupStatus.tsx`, with no desk item. The installer installs git, but not `gh` and no login. `aom-runner doctor` checks only the git version. | `clone.ts`; `apps/server/src/installer/templates/*.sh`, `windows.ps1` | The installer installs `gh`. The Workstations page has **Connect GitHub**: the runner starts `gh auth login --web`, and the device code is shown in the browser. HTTPS plus gh's credential helper; no SSH keys needed. | M |
| 15 | Vaults | Type a "Git URL" (placeholder `git@github.com:...`, `apps/web/src/pages/Vaults.tsx` ~L304) with no token; set up SSH or a credential helper yourself. On a `vault_conflict` the user fixes and commits **in the clone by hand**, then clicks "I resolved it, resume" (Vaults.tsx L208-245). | `apps/runner/src/vaults/*`; `apps/server/src/routes/vaults.ts` | "Create the vault for me": DevOps creates a private repo via [forge] and registers it. `vault_conflict` becomes a DevOps attempt first. | M |
| 16 | Docs and help | USER-GUIDE 3.6 L287-296, 4.3 L391-407, 4.4 L442-455, 4.10 L607 (Mark merged), 9.5 L944-949, FAQ L995. Help articles in `apps/web/src/help/articles/`: `devops-and-hygiene.md`, `ledger-and-vaults.md`, `workstations-and-installer.md` (SSH keys), `board-and-cards.md`, `testing-and-finalization.md`, `intake-and-outbox.md` (gh login). Two are stale: the first commit goes to the working branch, not `main`; finalize is run by the runner, not "the BA". | `docs/USER-GUIDE.md`; `apps/web/src/help/*`; `docs/guide/*` | Rewrite around outcomes; move the git detail to an "Expert mode" appendix. Rebuild the illustrated guide afterwards. | M |

### 1.3 Target experience

1. **Connect once.** Installing a workstation ends with "Connect GitHub" (device code in the browser). After that the user never sees a credential prompt.
2. **Pick or create.** Project settings, Repositories: *Pick a repository* (a searchable list from [forge]) or *Create a new one* (owner dropdown plus name). No URL, no branch, no path.
3. **Defaults decide.** Working branch = the default branch, confirmed automatically. Completion = the project's "How finished work lands" (default **merge after review and test**; see Q3). Clone folder = `~/src`.
4. **DevOps owns git.** Branches, worktrees, merges, rebases, conflict attempts, hygiene and PRs belong to the DevOps engineer and the runner. Problems go to an agent first and to a human only when the agent gives up.
5. **Plain outcomes.** One shared function, `plainOutcome(event)` in `packages/shared/src/outcomes/`, turns git events into sentences for card threads, notices and the phase page:
   - `CardFinalized`/merge: "Your change *Barcode scan* is live on main."
   - `RebaseConflict`: "Two changes touched the same files. The builder is reconciling them."
   - A conflict resolved: "Two changes clashed; the DevOps engineer fixed it and the tests passed again."
   - `pr`: "Ready for your review: open the pull request."
   - Hygiene saved work: "Unsaved edits on your workstation were stored safely (nothing was lost)."
6. **Git expert mode.** A per-user preference (Q9) that brings back today's controls: URL and branch fields, the per-card completion action, `push_branch`, Mark merged, raw hygiene details, and the `working_branch` questions for phases and intakes.

Desk changes in simple mode:

| Desk item today | Simple mode |
|---|---|
| `working_branch` (unconfirmed) | Gone; one notice "Agents deliver into `main`" |
| `working_branch` (intake, phase "keep?") | Gone |
| `working_branch` (creation failed) | DevOps request first; desk only if it fails |
| `pr_notice` (no `gh`) | DevOps request "connect GitHub"; then a notice |
| `finalize_failed`, `vault_conflict` | DevOps attempt first; desk on failure |
| hygiene failures (BA report) | Plain-language outcomes; blocking ones become DevOps requests |
| `large_merge`, `repo_create` (agent-asked) | Stay (real approvals), reworded |

### 1.4 Risks of automating, and guardrails

All guardrails live in **runner code**, not in prompts.

- **Force pushes.** No force push is ever made. Add one choke point in `apps/runner/src/git/git.ts` that refuses `--force`, `--force-with-lease`, `+refspec` and `push --delete` on the working branch, whoever calls it. **Note:** the code allows `git push` in DevOps shifts (`apps/runner/src/adapters/claude-policy.ts` ~L322, `buildDevopsSettings`). `docs/RUNNER.md` L777 and L788 say it is denied, which is out of date. Proposal: deny `git push` to the DevOps model again (and fix the doc). Pushes happen only through runner verbs (`aom hygiene run`, finalize, a new `aom git deliver`) that apply the choke point.
- **Destructive resets.** `reset --hard` and `clean` only run in agent worktrees under the runner's worktrees folder (today's `roots` check), never in the user's own clone. Before any operation that could lose work, the runner writes a saved-work branch and pushes it.
- **Hygiene auto-commit.** Uncommitted user edits can contain secrets or half-done work. In simple mode they go to a saved-work branch instead of `main`. Files matching `.env*`, `*.pem` and `id_*` are skipped and a notice is posted (Q7).
- **Protected branches.** A `merge` push rejected by branch protection (GH006, "protected branch hook declined") switches the **project** to `pr`, with a notice ("main is protected, so changes now arrive as pull requests"). Later, protection is read from [forge] in advance.
- **Merging untested work.** `merge` only runs at Finalize, after review and test pass (the workflow already guarantees this). The large-tier approval stays. After a conflict fix the card goes through **review and test again**. That keeps SPEC's rule "no agent resolves conflicts silently" (SPEC L245) honest: the fix is visible and re-verified (Q2).
- **Who resolves a card conflict.** Today it is undefined (the builder may not rebase). Proposal: on `RebaseConflict` the **runner** prepares the worktree by merging the working branch in, which leaves conflict markers and is committed by the runner. The builder edits the files in Rework, and the card goes through review and test again. No agent ever runs `rebase` or `push` itself.
- **Agent conflict attempts.** Bounded: two attempts per card (or per hygiene conflict), then the human gets a desk item with what was tried. Hygiene conflicts on the working branch are fixed on a branch and delivered like a card, never directly on `main`.
- **Audit.** Every git write is already recorded (`aom devops-done --command`, `EnvironmentChanged.commands`). The new outcomes link to it.

---

## Part 2: DevOps instructions from anywhere, including when sandboxed

### 2.1 Today

How a user reaches DevOps:

- **Workstations page, DevOps panel, "Ask DevOps"** (`apps/web/src/components/DevOpsPanel.tsx`). It calls `POST /api/devops/requests` with `{workstationId, summary, cardId?}` (`packages/shared/src/api/devops.ts` L57). Only the workstation's own user may ask (`createDevOpsRequest`, `apps/server/src/commands/devops.ts` ~L301, `ws.user_id !== user.id` returns 404). A request becomes a **DevOps shift**. Access ticks, approvals (`resolveDevOpsApprovalIn` ~L470) and the sudo password are likewise gated to **the workstation's owner**, not to the org's Owner/Admin.
- **Chat drawer** (`ChatDrawer.tsx`, opened from the AppShell button and the palette item "Chat with an agent"). You can pick the DevOps engineer, but **a chat is sandboxed**. It has only `Read, Glob, Grep, Bash(aom:*)`, Edit only in scratch (`docs/RUNNER.md` ~L686-688, L794), and the IPC allow-list `CHAT_RPC` (`apps/runner/src/chat/chat.ts` L49-71) has no `devops.request` or `sudo.run`. Its network allow-list is empty (`buildChatSettings`, `claude-policy.ts` ~L386). The DevOps chat prompt even says "never try `gh` or `git push`" (`packages/shared/src/prompt/chat.ts` L38-44). So **in chat the DevOps engineer can neither run your command nor turn it into a request.** This is the owner's "he operates in a sandbox and cannot execute my commands".
- **Agents**: `aom devops "<request>"` from any shift. **Schedules**: action `devops_request`. **Hygiene**: scheduled or "Run hygiene now".
- **Desk**: `aom devops-approval --action --reason --command` puts the request in `needs_approval` and creates a "DevOps approval" item, resolved via `POST /api/devops/requests/:id/resolve`.

What a DevOps **shift** can execute:

- It is **unsandboxed** (RUNNER.md "DevOps shifts are unsandboxed"; `buildDevopsSettings`). It has Bash, Read and Edit anywhere, the user's real `HOME`, and the SSH, Docker and kube sockets. Only the session tools, the role's shell patterns and Read/Edit of the runner's private files are denied, and those denials are command-text rules. `git push` is allowed (see 1.4).
- `devops_access` (`allowInstall`, `allowDocker`, `allowedPaths`, `sudo`; `packages/shared/src/events/devops.ts` L6) is **prompt guidance only**. RUNNER.md says so itself. The only enforcement is in runner code: `env.ensure` honours the flags, and `aom sudo` checks `access.sudo` (`apps/runner/src/shifts/supervisor.ts` `sudoRun` L601).
- `aom sudo -- <argv>` sends IPC `sudo.run`, and the runner runs `sudo -S` with the stored password (`apps/runner/src/secrets/sudo.ts`). There is **no per-command approval**, and the audit is a 200-character progress line.

When it cannot run a command:

- In chat it simply says so.
- In a shift it may raise `aom devops-approval`.
- The toolchain reports `needs_access` with a manual command (Project settings, Development environment) and "Check again".
- There is no general "run this yourself, then check again" flow.

### 2.2 Gaps

| Gap | What is wrong | Fix |
|---|---|---|
| G1 | The DevOps chat is sandboxed and cannot hand off. | (a) and (b) below |
| G2 | Shifts are unsandboxed and the access flags are not enforced. | (b), then phase P4 |
| G3 | `aom sudo` runs anything once sudo is ticked; the audit is thin. | (b) and (d) |
| G4 | "Ask DevOps" exists only on the Workstations page, without context. | (a) |
| G5 | There is no general manual fallback. | (c) |

### 2.3 Design

**(a) "Ask DevOps" everywhere**

- **Entry points.** A header button in `apps/web/src/components/shell/AppShell.tsx` next to Chat. A palette item "Ask DevOps..." in `components/palette/CommandPalette.tsx` (keywords: install, docker, sudo, fix, environment). A button on the card detail ("Ask DevOps about this card"), on desk items, on failed environment and clone rows, and on the Workstations panel (existing).
- **One dialog, `AskDevOpsDialog`.** A free-text instruction, a workstation picker (default: the card's workstation, else the user's only workstation, else the last used), and an **attached context** chip list the user can remove: page route, project, card (ref plus the last rejection), desk item, repository, and the last error text.
- **API.** Extend `CreateDevOpsRequestSchema` additively with `origin: 'app'|'palette'|'card'|'desk'|'workstation'|'chat'` and `context: {route?, projectId?, cardId?, deskItemId?, repoId?, errorText?}`. `DevOpsRequested` gets the same optional fields, and the brief renders them.
- **Chat fix.** Add `devops.request` to `CHAT_RPC` for DevOps chats only. Change the DevOps chat prompt from "you cannot" to "turn instructions that need a command into a request with `aom devops`; the conversation shows its progress". The drawer then shows the request thread inline (the thread already exists: `DevOpsRequested.threadId`).

**(b) Instruction model: plan, then run by class**

1. The request shift reads the instruction and context, then records a **plan**: `aom devops plan --file plan.json`, with steps `{id, title, argv[], cwd, why, check?: argv[]}`. The plan shows in the request thread.
2. The **runner classifies every step itself**. The model's own label is ignored.
   - `read`: diagnostics such as `--version`, `docker ps`, `git status`, `ls` and `cat` outside credential stores. Runs at once.
   - `workspace`: changes inside the project worktrees and repository folders. Runs at once.
   - `privileged`: installs (`apt*`, `dnf`, `brew`, `winget`, `choco`, `snap`, `npm -g`, `pip install` outside a venv, `dotnet workload`), `docker`/`podman`, `systemctl`, `usermod`, anything with `sudo` or elevation, writes outside the workspace and `allowedPaths`, and network outside the registry allow-list. Rules live in a table in `apps/runner/src/devops/classify.ts`, with fixture tests (same pattern as `toolchain/stacks.ts`).
3. Privileged steps go through **`aom exec [--elevate] -- <argv>`**, IPC `exec.run`. The runner checks the workstation's **allow-list** of rules.
   - **Match**: the runner runs the exact argv itself, outside the agent sandbox, as the runner user; with `--elevate` it uses the sudo vault (as `sudo.run` does today).
   - **No match**: it returns `pending_approval` and reports `exec.approval_needed` to the server.
4. The server appends `DevOpsCommandApprovalRequested` and creates a desk item, subkind `devops_command` (blocking when cards wait on it). It also pushes live to whoever has the Ask DevOps dialog or drawer open. The approver sees the exact argv, cwd, elevation, why, the plan step, and a risk line from the classifier. The choices are:
   - **Run once**
   - **Always allow on this workstation** (a pattern proposal, see below; it expires)
   - **Deny**
   - **I'll run it myself** (goes to (c))
5. **On approval** the server enqueues the **durable runner command `devops.exec`** `{approvalId, requestId, argv, cwd, elevate, argvHash, expiresAt}` in `runner_commands` (`apps/server/src/runner-gateway/commands-queue.ts`), so it survives an offline runner. The runner refuses an expired command or a hash mismatch. It runs the command with a timeout, writes the full log to `logs/devops/<requestId>.log`, redacts it (`apps/runner/src/secrets/redact.ts`), and returns `command.result` `{exitCode, durationMs, outputTail}`. The server appends `DevOpsCommandExecuted`.
6. The agent never blocks on a human. It ends the shift with the request in `needs_approval` (existing status). The result re-queues the request, and a new shift continues from the thread. Up to 5 privileged steps run per request; more need a fresh approval of the remaining plan.
7. `aom sudo` becomes an alias of `aom exec --elevate` and obeys the same approvals. That closes G3.

Allow-list patterns are argv prefixes with a single trailing `*`, for example `["apt-get","install","-y","*"]` or `["docker","compose","*"]`. These can **never** be patterns: `sh`/`bash`/`pwsh -c`, `sudo *`, interpreters with `-e`/`-c`, `curl`/`wget` piped to a shell, `rm -r*`, `chmod -R`, `dd`, `mkfs`. They can only be approved one time.

The rules are pushed to the runner (`devops.rules` durable command, plus `hello` on reconnect), and **the runner enforces them**. A local `aom-runner devops policy --max off|once|patterns` lets the machine owner cap what any server may grant.

**(c) When even that is impossible**

Cases: the runner is offline; sudo is not verified (`rights.verify` failed or no password); native Windows without elevation; an interactive step (a GUI installer, a reboot, BIOS virtualisation); or the user chose "I'll run it myself".

The agent posts `aom devops manual --step <id>`, which creates a **manual step card** in the thread and on the desk (subkind `devops_manual`). The card shows:

- **where**: the workstation and the terminal to use (for example "Ubuntu (WSL) terminal" or "PowerShell as administrator")
- the exact command in a code block with a **Copy** button
- what it changes, and what success looks like
- **Done, check again**

"Done, check again" enqueues `devops.verify`, which runs the step's read-only `check` argv (for example `docker info`). It closes the step on success or reopens the request with the output. The existing toolchain `needs_access` manual commands reuse the same card (one component).

**(d) Audit and safety**

- **Who.** Approvals, rules and manual-step confirmations are allowed only for **Owner/Admin** of the org (`isOrgManager`, `packages/shared/src/authz/index.ts` ~L62). This is a change from today's workstation-owner gate (`canManageWorkstation`): on a member's workstation, the workstation's user must also agree (Q8).
- **Per-org policy.** There is no general org settings blob today (only `organizations.features jsonb`, migration `1310_organizations.sql`). Add a column `organizations.devops_exec_policy jsonb` with: `enabled` (default on), `patterns` (default on), `maxRuleDays` (default 30, max 90), `oneTimeExpiryHours` (24), `approvers` (`owner_admin` | `owner_admin_and_workstation_user`), `extraBlocked[]`.
- **Secret-revealing commands are refused** by the runner even if approved: `env`/`printenv`, `cat` of credential stores and the runner data dir, `gh auth token`, `git config --get credential*`, `docker login -p`, `security find-*-password`, `aws configure get`, `kubectl config view --raw`. Output is redacted with the registry (sudo password, runner token) plus the generic token patterns already used by desk mail.
- **Expiry and revocation.** Rules expire. A "Allowed commands" list on the Workstations page offers Revoke and shows the use count. Every approval, run and denial is an event, with a "Command history" view per workstation.

### 2.4 Mapping to existing protocol pieces, and what is new

| Need | Reuse | New |
|---|---|---|
| Request from anywhere | `POST /api/devops/requests`, `DevOpsRequested`, request thread | `origin`, `context` fields (additive) |
| Chat handoff | `CHAT_RPC`, `aom devops` | `devops.request` in `CHAT_RPC` for DevOps chats |
| Plan | `shift.report` outcomes | IPC `devops.plan`; event `DevOpsPlanProposed` |
| Privileged run | IPC `sudo.run`, sudo vault, `runner_commands` durable queue, `command.result`, `DevOpsRequestStatus.needs_approval` | IPC `exec.run`; runner to server `exec.approval_needed`; durable `devops.exec`, `devops.rules`; events `DevOpsCommandApprovalRequested`, `DevOpsCommandApproved`, `DevOpsCommandDenied`, `DevOpsCommandExecuted`, `DevOpsCommandRuleAdded`, `DevOpsCommandRuleRevoked` |
| Can it elevate at all? | `rights.verify`, `DevOpsSudoPasswordSet` | none (used to choose (b) or (c)) |
| Manual fallback | toolchain `needs_access` manual command, "Check again" | IPC `devops.manual`; durable `devops.verify`; events `DevOpsManualStepPosted`, `DevOpsManualStepConfirmed` |
| Record of changes | `EnvironmentChanged.commands`, `aom devops-done` | link to `DevOpsCommandExecuted` |
| Redaction | `apps/runner/src/secrets/redact.ts` | refused-command list in `classify.ts` |

New tables (projections):
- `devops_command_approvals` (id, org_id, request_id, workstation_id, argv jsonb, argv_hash, cwd, elevate, class, status, requested_at, decided_by, decided_at, expires_at, result jsonb)
- `devops_command_rules` (id, org_id, workstation_id, pattern jsonb, elevate, created_by, created_at, expires_at, revoked_at, uses)
- `devops_manual_steps` (id, request_id, workstation_id, step jsonb, status, confirmed_by, confirmed_at, check_result jsonb)

New web pieces: `AskDevOpsDialog`, `CommandApprovalCard` (desk plus drawer), `ManualStepCard`, and the Workstations "Allowed commands" and "Command history" panels, plus the org settings section.

---

## Part 3: phased plan

| Phase | Content | Effort | Depends on |
|---|---|---|---|
| **P0 Quick wins** | Auto-confirm the default branch at clone. Project default "How finished work lands". Expert-mode toggle hiding rows 1-4, 9 and 11 controls. `plainOutcome()` for the five main events. `devops.request` in the DevOps `CHAT_RPC` plus the prompt change (closes G1 in its basic form). Saved-work branch for hygiene in simple mode. | 3-4 d | none |
| **P1 Ask DevOps everywhere** | Header button, palette item, card, desk and environment entry points; the context payload; the request thread in the drawer; manual step cards with Copy and "Done, check again" (`devops.verify`), reusing the toolchain manual commands. | 4-5 d | P0 |
| **P2 Privileged command channel** | Classifier, `aom exec`, approvals, rules, durable `devops.exec`, logs, redaction, refused list, org policy, `aom sudo` routed through it, Workstations panels. | 1.5-2 wk | P1 |
| **P3 Forge connection** | Installer installs `gh`; "Connect GitHub" (device code relayed); repository picker and owner dropdown; PR-state merged detection (Mark merged to expert mode); protected-branch fallback to `pr`; vault "create for me". | 1-1.5 wk | [forge] abstraction from the separate research |
| **P4 Close the residual risk** | Put DevOps shifts back in a sandbox profile (network to registries and the forge, read the home folder minus credential stores, write the repo folders), so the access flags become real enforcement. DevOps conflict attempts for hygiene and finalize conflicts. Docs and guide rewrite. | 1-2 wk | P2 |

Main risks:
- **The classifier misses a privileged command** (it runs at once). Mitigation: default-deny for unknown binaries that write outside the workspace once P4 sandboxes the shift; until then P2 lowers the risk but does not remove it, because the shift is still unsandboxed.
- **A hostile server pushes rules.** Mitigation: the local runner policy cap, and the rules are shown on the Workstations page.
- **Auto-confirming the wrong branch** (repos whose real integration branch is `develop`). Mitigation: a notice with "Change", and expert mode.
- **Approval fatigue.** Mitigation: patterns with expiry; read and workspace steps never ask.
- **Saved-work branches pile up.** Mitigation: hygiene deletes them after 30 days once merged or empty.

## Open questions for the owner

- **Q1. Should the DevOps chat execute commands?**
  - Options: (a) The chat stays sandboxed; it files requests, and privileged steps go through approved runner-run commands. (b) Make DevOps chats unsandboxed like their shifts. (c) The chat may only create a DevOps request card.
  - **Recommendation: (a).** P0 gives basic handoff, P2 the full flow.
- **Q2. Agent conflict resolution.** Today the builder already reconciles card conflicts in Rework.
  - Options: (a) Extend this to hygiene and finalize conflicts: DevOps tries on a branch, the result goes through review and test again, and the user gets a notice (two attempts, then the desk). (b) Keep "conflict means a human decides" for anything outside a card.
  - **Recommendation: (a).** It is visible and re-verified, so not "silent".
- **Q3. Default "How finished work lands" for new projects.**
  - Options: (a) merge into the default branch after review and test; (b) pull request you approve; (c) push branch.
  - **Recommendation: (a)**, with automatic fallback to (b) when the branch is protected.
- **Q4. Approval scope for privileged commands.**
  - Options: (a) Once per command, plus optional per-workstation patterns that expire (30 days by default). (b) Per request or session. (c) Always ask.
  - **Recommendation: (a).**
- **Q5. Put DevOps shifts back in a sandbox (P4) once the channel exists?**
  - Options: (a) yes, phased; (b) no, keep them unsandboxed and rely on approvals.
  - **Recommendation: (a).** Otherwise the access flags stay advisory.
- **Q6. Where do forge credentials live?**
  - Options: (a) On the workstation (`gh` login started from the browser), which keeps the promise "tokens stay on your workstation" (USER-GUIDE L995). (b) A server-side OAuth app that lists repositories and opens PRs centrally.
  - **Recommendation: (a)** now; revisit with the forge research (Codespaces may need (b)).
- **Q7. Hygiene and the user's uncommitted edits.**
  - Options: (a) Simple mode commits them to a saved-work branch and skips secret-looking files. (b) Keep committing them to the working branch (today). (c) Only report them.
  - **Recommendation: (a).**
- **Q8. Who approves commands on a member's own workstation?**
  - Options: (a) An Owner/Admin, and the workstation's user must also be an Owner/Admin or agree. (b) Owner/Admin alone. (c) The workstation's user alone.
  - **Recommendation: (a).** Nobody gets commands run on a machine they did not agree to.
- **Q9. Expert-mode scope.**
  - Options: (a) Per-user preference: off for new users, on for existing users who have set branches or completion actions (migration). (b) Per-project setting. (c) Org-wide.
  - **Recommendation: (a).** The project-level defaults (Q3) stay owner settings.
- **Q10. Installer folder question.**
  - Options: (a) Drop it in simple mode and default `~/src`. (b) Keep asking.
  - **Recommendation: (a).**
- **Q11. `git push` for the DevOps model.** The code allows it; the docs say it is denied.
  - Options: (a) Deny it again; pushes happen only through runner verbs with the no-force choke point. (b) Keep it allowed and fix the docs.
  - **Recommendation: (a)**, in P0 (small change in `buildDevopsSettings` plus a test).
- **Q12. How a builder reconciles a rebase conflict** (builders may not rebase).
  - Options: (a) The runner merges the working branch into the card branch, leaving conflict markers; the builder resolves them in Rework; review and test run again. (b) Allow `git rebase` for builders inside their worktree.
  - **Recommendation: (a).** Git history operations stay in runner code.
