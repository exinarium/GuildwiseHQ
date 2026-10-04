# Agent Org Manager — User Guide for Managers

First login and setup, managing projects and agents, the board and decision desk, intake from external systems, and organization design.

## Getting started

### First login

1. Check your email for an invitation link from the admin
2. Click the link to set your password (12+ characters)
3. You are now logged in and can access the dashboard

### Pairing your first workstation

A workstation is a machine (Windows, macOS, Linux) where agents will run code and pull from git repositories.

1. Open **Workstations** in the sidebar
2. Click **Pair workstation**
3. Copy the code `XXXX-XXXX` (valid 10 minutes)
4. On your machine, install the runner and pair it:

**On Linux/macOS:**
```sh
pnpm package:runner    # or download aom-runner-X.tgz from your system
tar xzf aom-runner-*.tgz && cd aom-runner
./aom-runner pair --server https://aom.example.com --code XXXX-XXXX --name "Desktop"
./aom-runner repos add ~/src ~/work    # folders scanned (depth 3) for git repos
./aom-runner start                     # keep running; run under systemd (see below)
```

**On macOS:** the same commands as Linux. Agents run inside the built-in Seatbelt sandbox; nothing extra to install.

**On Windows:** run the runner inside WSL2 (the default and recommended setup). Windows cannot sandbox agents natively, but inside WSL2 the runner gets the same sandbox as on Linux. In short: `wsl --install -d Ubuntu`, then in Ubuntu install Node 22 (nvm), git, gh, `bubblewrap` and `socat`, Claude Code, clone repos under `~/src` (not `/mnt/c`), and run the Linux commands above. The full step-by-step guide is in `docs/RUNNER.md`, section "Windows: run the runner inside WSL2". Running natively on Windows is possible only as an explicit, unsandboxed opt-in (see "Windows workstation notes" below).

Run the runner under systemd (Linux and WSL2), launchd (macOS) so it reconnects automatically on reboot. See `docs/RUNNER.md` for service setup.

**Sandbox warnings.** If a workstation's runner reports that agents run without an OS sandbox, the Workstations page, each affected agent card on the HR board and the Hire form show an amber warning that cannot be dismissed, and hiring onto it needs a confirmation. A workstation that cannot run agents at all shows why (for example "Native Windows: install the runner in WSL2").

The Workstations page will show your repos once you create a project with one of them.

### Claude Code credentials (optional)

Agents run Claude Code by default. Set credentials in the runner config (mode 0600, never leaves your machine):

**OAuth token (preferred):**
```
aom-runner.cmd pair --server ... --code ...  # pairs once
# Edit ~/.aom-runner/config.json (Windows: %LOCALAPPDATA%\aom-runner\config.json):
{
  "runtimes": {
    "claude-code": {
      "bin": "claude",
      "authMode": "oauth",
      "oauthToken": "...from `claude setup-token`..."
    }
  }
}
```

**API key** (Data Center/self-hosted Claude):
```json
{ "runtimes": { "claude-code": { "authMode": "api_key", "apiKey": "..." } } }
```

**Local login** (default):
```json
{ "runtimes": { "claude-code": { "authMode": "default" } } }
```

With `default`, each agent gets a symlink to your `~/.claude/.credentials.json`.

## Projects

### Creating a project

1. Go to **Projects**
2. Click **Create project**
3. Enter a name and key (e.g., `WEB`, `DOCS`), type (Code/Research/Feed), and domain (Work/Personal)
4. Add repositories (by URL or by linking to one already scanned on a workstation)
5. For work domain projects, set up vaults (work/personal folders in your knowledge system)
6. Click **Create**

### Project types and workflows

| Type | Stages | Typical roles | When to use |
| --- | --- | --- | --- |
| **Code** | Spec → Build → Review → Test → Finalize | BA/architect, builder, reviewer, tester, technical writer | Feature work, bug fixes, refactors, documentation |
| **Research** | Question → Research → Fact-check → Publish | Researcher, checker | Deep dives, investigations, knowledge base articles |
| **Feed** | Scheduled → Filter → Digest | Scout, curator | Regular scans, curated digests, newsletter items |

### Vaults and shared knowledge

Vaults are git repositories that sync to your workstations automatically. Each workstation syncs every 5 minutes (configurable) and commits/pushes changes.

- **Personal vault**: knowledge base for your org, visible only to you
- **Work vault**: shared among your team (if you share a project, members see your work vault)
- **Project vaults**: one per project, shared with all members who see that project

To configure:
1. Go to **Projects** > **Settings** > **Vaults**
2. Add URLs (SSH or HTTPS) for personal and work vaults. URLs must not contain a password or token (`https://user:token@host/...` is refused): use SSH keys or a credential helper on the workstation
3. Set sync interval (default 300 seconds)

**On Windows**, if vault URLs use SSH keys, ensure git can find them (OpenSSH or PuTTY; WSL2 recommended).

### Sharing a project

Only the project owner can share. To invite another manager:

1. Go to **Projects** > **Settings** > **Members**
2. Enter their email and click **Invite**
3. They accept in their Invitations inbox and gain access to this project only
4. They can hire agents onto their own workstations, see the board, and answer desk items
5. Only the owner (and the hiring manager) can change each agent; only the owner can hire/change/fire shared project agents

When you remove a member, their agents are re-homed to your workstation and account automatically; claimed cards are released. Deactivating a user (administrator) does the same for every project they were a manager of, unlinks all of their workstations (their runners are disconnected and cannot reconnect), and parks their own agents until the account is reactivated and re-paired.

Only the project owner can add standing orders (also from a card or when answering a question); a guest manager can answer questions with decisions and requirements. Organization-wide standing orders can only come from the organization owner. An agent's permissions can be narrowed by its hiring manager but never widened beyond its role (a reviewer never commits); widening other limits (web, extra tools, risk tiers) is for the organization owner.

### Decision policy

By default, only the card's owner (who created it) can answer questions and approve decisions on it. To let any manager answer:

1. Go to **Projects** > **Settings** > **Decision policy**
2. Toggle **Allow any manager to answer decisions**

## The board

### Reading the board

The board shows all cards in a workflow, from left to right by stage. Each card tile shows:

- **Card ref** (e.g., `TOY-1`). Refs are unique only within one organization: if two of your projects (your own and a shared one) both have a `TOY-1`, the ref link asks which one you mean, and the board always links by card id
- **Title and type** (feature, bug, support, refactor, docs)
- **Assignee** (the agent working on it, if claimed)
- **Age** (time in current stage)
- **Risk tier** (small/large; auto-computed from diff, overridable)
- **Rework round** (number of times bounced from review)
- **Blocked badge** (if waiting on a decision)

The Blocked column shows cards waiting on an answer from the decision desk.

### Creating and specifying a card

1. Click **Create card** or go to the project and click **New card**
2. Fill in the form:
   - **Title and type**: the work (e.g., "Fix login timeout – bug")
   - **Context**: why this exists, current behaviour
   - **Requirements**: what must be done
   - **Acceptance criteria**: what "done" looks like
   - **Affected areas**: which files/modules/systems
   - **Constraints**: limits and linked past decisions
   - **Test plan**: E2E test scenarios
   - **Completion action**: how to merge/publish (PR, branch push, merge to main)
   - **Docs needed**: whether a technical writer should document it
3. Save as draft or click **Specify** to move it to To do (requires all fields)

Cards can stay as drafts until you are ready. The BA can also draft cards via intake.

### Moving and releasing cards

Clicking a card shows its detail view. Actions:

- **Move**: reassign to a different stage (manager only; used to fix stuck cards)
- **Release**: return to the queue (if an agent dropped it mid-shift or you need to reassign)
- **Cancel**: mark as cancelled (keeps the history, does not queue it again)

### Risk tier

Auto-computed from the diff size of similar PRs:
- **Small** (≤100 lines changed): one reviewer approval, one tester
- **Large** (>100 lines): two distinct senior reviewers, full test suite run after finalize

Override on the card detail if the auto-computed tier does not match the risk (e.g., a 50-line change to a critical system deserves large-tier review).

## Hiring and firing agents

### Hiring an agent

1. Go to **Agents** or click **Hire** on the Board
2. Fill in:
   - **Role**: builder, reviewer, tester, technical writer, or custom roles you have designed
   - **Seniority**: junior or senior (affects permissions and queue priority)
   - **Workstation**: where they run (must have the project's repos)
   - **Model**: Claude Opus 4, Sonnet 4.5, etc., and effort level
   - **Name**: autocomplete suggests unused names; type to override
   - **Skills**: special knowledge (e.g., "Playwright", "database migrations")
   - **Capacity**: max concurrent cards (default 1; larger for routine roles like DevOps)
3. Click **Hire**

First-run limits (removed after you see the HR board):
- 2 builders
- 1 of each other role (reviewer, tester, writer, DevOps)

Name suggestions skip retired agents and names already in use.

### The DevOps engineer

You get one DevOps agent per workstation automatically. It cannot be fired, only **reset** (which wipes its sandbox like a firing, but keeps it assigned). It is not driven by cards; agents and you ask it directly via the `aom devops` command in a shift or the **Ask DevOps** button on the Workstations page.

DevOps is always available and outside the queue. It handles:
- Cloning and setting up projects
- Installing tools and dependencies
- Starting containers and databases
- Pulling/pushing vault changes
- Granting access to internal systems (with your approval on the desk)

### Firing an agent

1. Go to **Agents** and click the agent's row
2. Click **Fire** (with confirmation)

What happens:
- Cards the agent holds are released to the queue with the last handoff attached
- The agent's private sandbox is deleted (transcripts, memory, caches)
- The agent is marked retired: hidden from hiring, never gets new work
- The official record stays intact (events, card history, handoffs)

To hire the same role again, create a new agent. Retired names are never reused, so history stays unambiguous.

## Decision desk

The decision desk is where every question and approval reaches you. Cards do not move forward until you answer.

### Desk items

A desk item shows:

- **Who asked**: agent name and role
- **What they're doing**: card, stage, workflow context
- **The question**: options and recommendation
- **Blocking**: how many cards are waiting on this answer
- **Urgency**: age, count of affected cards, and whether it blocks progress

### Answering a question

1. Click the desk item
2. Choose an option or type an answer
3. Click **Answer** (the recommendation is pre-selected)

The answer is recorded in the ledger (shared with future agents), the card is unblocked, and the asking agent's next shift includes the answer.

### Standing orders

Standing orders are recurring instructions that appear in every agent's next shift. Use them for:
- Team policies ("all PRs must have unit tests")
- Context ("we are migrating from X to Y")
- Decisions that affect multiple cards ("use the new auth system")

To add a standing order:

1. Go to **Ledger**
2. Click **Add standing order**
3. Enter the text and scope (whole org, specific project, specific role)

Standing orders land in the agent's shift prompt automatically.

### Adding to the ledger

When answering a desk question, you can also add it to the ledger as:
- **Requirement** (a permanent rule)
- **Standing order** (a team-wide instruction)
- **Decision** (a one-time choice, recorded for history)

## Intake from Jira and GitHub

The BA handles intake: reading tickets from Jira or GitHub, mapping them to projects, and drafting cards with full specs.

### Intake workflow

1. Click **Intake** on the desk (or go to Projects > Intake)
2. Paste a Jira key or GitHub issue URL
3. Chat with the BA (Claude-powered):
   - It reads the ticket via MCP skill (Jira) or GitHub API
   - You answer questions about the scope and project
   - It drafts a card with context, requirements, acceptance criteria, test plan and completion action
4. Review the card and click **Specify** when it is ready

Cards drafted via intake start in the To do queue and follow the normal workflow.

### Unmapped tickets

If a ticket does not match a project (e.g., a support request for an untracked system):
1. The BA asks on the desk
2. You can map it to an existing project or decide it is out of scope
3. If out of scope, it lands as a desk notice for your records

### Jira and GitHub credentials

- **Jira**: set up in runner config via MCP (stays on your machine)
- **GitHub**: uses your machine's `gh` login (configured via `gh auth login`)

Neither credential leaves the runner.

## Outbox and posting updates

Outbox items are draft updates to be posted back to tickets (Jira, GitHub).

### Outbox workflow

1. An agent or the BA drafts an outbox update via the shift (e.g., `aom outbound draft --kind comment --body "...fix..."`)
2. The update lands on the desk as an **Outbox approval** card
3. You review it:
   - **Approve**: posts immediately
   - **Edit**: make changes and approve (only the manager's edits are posted)
   - **Reject**: discards it
4. The post is made with your account and credentials

### Guardrails

Outbox items are scrubbed before posting:
- No agent names (replaced with role descriptions)
- No internal process details (review scores, rework reasons, testing step counts)

If a draft violates these rules, it is rejected by the runner; the author can revise and resubmit.

## Testing and finalization

### Test stage

Once a reviewer approves, the card moves to Test. A tester:
- Runs E2E tests from the test plan
- If tests pass: card moves to Finalize (or Docs if docs-needed)
- If tests fail: a bug card is created on the same branch, linked to the original card

The original card waits ("waiting on bug") until the bug passes review and the tester re-runs the full suite.

### Finalization

On the Finalize stage, the BA chooses the completion action:

| Action | What happens |
| --- | --- |
| **PR** | Push branch to origin, create a PR (if `gh` is available) or ask the desk |
| **Push branch** | Push to origin without PR |
| **Merge to main** | Merge the working branch (small cards only) or ask the desk for approval |

The branch is then removed and the card moves to Done. If docs are needed, a tech writer card is spawned.

### Full suite and regression

After finalize, a full suite card is spawned for testers to run the entire E2E suite once. If it fails, a bug card is created and desk notice is posted.

**Regression runs**: on the Projects page, click **Run regression** to test the entire suite on all platforms (web, mobile).

## Ledger and search

The ledger is the shared memory of your org. It records:

- **Decisions**: choices made on desk items (who decided what, when)
- **Standing orders**: recurring instructions
- **Questions**: blocking questions and their answers
- **Features**: documented changes (from finishing cards)

### Searching the ledger

1. Go to **Ledger**
2. Type a query (e.g., "authentication", "login timeout")
3. Optionally filter by scope (all, features, decisions, standing orders)

Results show matching entries with context. Agents can search the ledger during their shifts via `aom ledger search "<query>"`.

## Schedules and feeds

### Schedules

Scheduled work runs on a timer and jumps the queue.

1. Go to **Schedules** (or create a project with type Feed)
2. Add a schedule:
   - **Cron expression**: e.g., "every day at 7:00 AM"
   - **Project**: the scout/curator will run this
   - **Card title**: description of what to do
3. At the scheduled time, a card is created and claimed immediately (ahead of normal work)

If all scouts are busy, an overflow shift starts; a second late schedule waits for the next free slot.

### Feeds

Feed projects run curated scans (e.g., daily news, AI articles, research opportunities) and post digests.

1. Create a project with type **Feed**
2. Add a **Schedule** to run the scout (scan for items)
3. The scout appends to a project feed file in your vault
4. A curator reads the feed, filters and rates items, posts a digest
5. You rate digest items (useful, irrelevant, boring) and add your taste preferences
6. Future curators learn from your ratings

Feed rules (added to vault):
- General search patterns
- Preferred sources (prioritize these)
- Deduplication
- Per-type limits

See `docs/SPEC.md` §5 for the full feed design.

## The HR board

Once you have hired agents, the HR board shows:

- **Agent cards**: name, status (idle, working), current card, hiring manager, quick actions
- **Performance stats**: cards done, bounce rate, bugs escaped, utilisation, tokens per card vs role average
- **Recommendations**: model changes, role splits, hiring, standing orders (one-click apply)
- **Metrics dashboard**: team throughput, time blocked, queue depth, time-to-finish

Recommendations are rule-based; you can apply them directly or adjust and post a standing order to the desk.

## Organization design

Expand your organization beyond built-in roles and workflows.

### Custom roles

1. Go to **Organization** > **Roles**
2. Click **Design** (or chat with the BA in Intake)
3. Define:
   - **Name and purpose**: what they do
   - **Instructions**: behavior, guardrails, allowed tools
   - **Permissions**: which repos, branches, tools
   - **Skills**: special knowledge or expertise
   - **Model**: default provider and model
   - **Stages**: which workflow stages this role can claim
4. The BA validates it and submits to the desk
5. You approve on the desk, then hire the role

Built-in roles (builder, reviewer, tester, etc.) cannot be removed, but you can extend them with extra instructions and standing orders (owner only). When the app updates with new default versions, you can reset a role to the new default.

### Custom workflows

1. Go to **Organization** > **Workflows**
2. Define a new workflow:
   - **Stages**: name, role, required fields, success criteria, failure routing
   - **Paths**: where cards go on success vs failure
3. Validate: no unreachable stages, failure paths terminate, every stage has a claimable role
4. Submit to the desk for approval

Once approved, custom workflows appear on the Projects page as project types.

### Departments

Group roles by function (Engineering, Support, Research, Marketing) so you can filter the HR board and board by department.

## Chat with agents

Click an agent card on the board to open its detail, then click **Chat**. This opens a live conversation with the agent (if the workstation is connected). You can:

- Ask questions about the card
- Offer suggestions
- Discuss blockers or decisions

Chat is saved to a thread and appears in the card's history. A chat that belongs to a project is marked "visible to this project's managers". Rights are checked on every message: if you are removed from the project, you can no longer talk to its agents through an old chat.

## Windows workstation notes

### Default: WSL2

Install the runner inside a WSL2 Ubuntu distribution and follow the Linux instructions: `docs/RUNNER.md`, section
"Windows: run the runner inside WSL2" (enable WSL2, install Ubuntu, Node 22 via nvm, git, gh, bubblewrap and socat, Claude
Code, clone repos in the WSL filesystem rather than `/mnt/c`, pair, and run the runner as a systemd user service). This is
the only Windows setup where agents run inside an OS sandbox.

### Native Windows (unsandboxed, not recommended)

Native Windows cannot sandbox agents. By default the runtime then reports itself unavailable and no agent is scheduled.
To run agents there anyway, set `"sandbox": "best_effort", "allowUnsandboxed": true` under `runtimes.claude-code` in
`%LOCALAPPDATA%\aom-runner\config.json`. A prompt-injected agent could then read any file your Windows user can read,
including the runner token. The web UI warns about it everywhere the workstation and its agents appear.

### Installation (native)

1. Download `aom-runner-*.tgz` from the system
2. Extract to `C:\Users\you\aom-runner` (or your preferred location)
3. Run `aom-runner.cmd pair --server ... --code ... --name Desktop`
4. Run `aom-runner.cmd repos add C:\Users\you\src`

### SSH for vaults

If your vault URLs use SSH:
- Ensure `git` can reach your SSH keys (configure `OpenSSH` in Windows or use `PuTTY` with Pageant)
- Or use HTTPS URLs with a GitHub PAT stored in `~/.git-credentials`

### Run as a service (native)

Use **Task Scheduler** to run `aom-runner.cmd start` on login:
1. Task Scheduler > Create Task
2. Trigger: "At log on"
3. Action: `C:\Users\you\aom-runner\aom-runner.cmd`
4. Arguments: `start --data-dir C:\Users\you\AppData\Local\aom-runner`

## Troubleshooting

**Q: A workstation shows "Disconnected"**

The runner process stopped or the connection timed out. Check:
```
aom-runner status               # shows process state and connection
aom-runner doctor               # checks node, git, claude, server connectivity
```

Restart it: `aom-runner start` or check logs in `~/.aom-runner/logs/runner.log`.

**Q: An agent finished but I don't see a handoff**

The shift may have timed out (server killed it after 1 hour offline) or the runner crashed. Check:
- **Board**: card should be back in its queue with the last handoff attached
- **Workstations**: is the runner connected?
- **Logs**: `~/.aom-runner/logs/shifts/<shiftId>.jsonl` shows what happened

**Q: "The runner is running: stop it first" (rotate-token)**

`aom-runner rotate-token` replaces the token. Stop the runner first:
```
# Kill the running process or press Ctrl+C
aom-runner rotate-token
aom-runner start              # restart with the new token
```

**Q: Vault sync is paused with a conflict**

Vault sync stops if a local change conflicts with a remote change. Go to the Vaults settings and resolve manually, then restart sync.

**Q: Card does not match available agents**

Check the Workstations page: the repo must be listed under the workstation, and the agent must have the role and workstation assigned. If you just added a repo, agents see it after they reconnect (next heartbeat).

**Q: Out of scope when I expected to run**

The agent reported work outside the scope of its role. Review the shift log in `~/.aom-runner/logs/shifts/<shiftId>.jsonl` and the card's comment thread. Adjust the card spec or agent skills and try again.

## See also

- `docs/RUNNER.md`: full runner reference, data directory, CLI, config
- `docs/DEPLOY.md`: server deployment, scaling, backups
- `docs/SPEC.md`: complete product spec and organization design
- `docs/ARCHITECTURE.md`: technical design, event store, dispatcher, protocol
