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

**Sandbox warnings.** If a workstation's runner reports that agents run without an OS sandbox, the Workstations page, each affected agent card on the HR board and the Hire form show an amber warning that cannot be dismissed, and hiring onto it needs a confirmation. A workstation that cannot run agents at all shows why (for example "Native Windows: install the runner in WSL2"). The reason names the actual cause: the platform, the runtime's sandbox set to `off` in the runner config, a missing `bubblewrap` or `socat`, or (tests only) a forced state, and the advice below it fits that cause.

Each workstation also shows **Shifts running**, for example "2 of 4": how many agent shifts it runs now and the most it takes at once. That limit is the runner's `maxConcurrentShifts` setting (default 4; see `docs/RUNNER.md`). A shift offered beyond it is refused as busy and the card waits for the next free slot.

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
4. For a Code project, add repositories (by URL or by linking to one already scanned on a workstation). Research and Feed projects need no repository
5. For work domain projects, set up vaults (work/personal folders in your knowledge system)
6. Click **Create**

### Project types and workflows

Research and Feed projects need no repository and have no testing or regression controls: their project settings show no Repositories section, E2E or architectural globs, or large-merge setting, and their boards have no Regression button. Results go to the project's vault folder. (A research or feed project that already has repositories still lists them so you can remove them.)

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

### Archiving, restoring and deleting a project

**Archive** a project you no longer use: **Projects** > **Settings** > **Danger zone** > **Archive project**. The dialog lists what will stop before you confirm (active shifts, open cards, schedules, open desk items). On confirm:

- running shifts are cancelled and their worktrees removed (the branches are kept);
- open cards are closed as *archived* (they show as cancelled with the reason "Project archived", so you can tell them from cards you cancelled yourself);
- schedules are switched off and open desk items for the project are dismissed;
- the project disappears from boards, project pickers, the Schedules and Desk pages, and from intake mapping, and the dispatcher stops giving its work to agents.

Agents hired for the project are not fired; they simply stop getting its work. Cards, history and the vault folder are kept. Any member of the project (owner or manager) can archive and restore it, and members of a shared project see it as archived.

**Restore**: **Projects** > **Archived** > **Restore** (or **Settings** > **Danger zone** > **Restore project**). The project is back on the boards and pickers and takes work again. Cards that the archive closed stay closed and schedules stay off; create new cards and switch schedules back on as needed.

**Delete permanently**: only the project owner, and only for an archived project. **Projects** > **Archived** > **Delete permanently**, then type the project key to confirm. The project's cards, threads and messages, schedules, desk items, repositories, members, digests, transcripts and research notes are removed from the database and cannot be recovered. The audit log keeps a record that the project was deleted, and the vault folder is never touched. Agents that were hired for that project only are let go. The project key becomes free for a new project.

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
- **Waiting badge** (a card waiting on a bug it spawned says "waiting on bug" in the Test (waiting on bug) column; a large merge waiting for your approval stays in the Finalize column and says "Awaiting your approval")
- **Warning icon** (a card in the queue that nobody may be able to take; see below)
- **Rework round** (number of times bounced from review)
- **Blocked badge** (if waiting on a decision)

The Blocked column shows cards waiting on an answer from the decision desk.

#### The warning icon: why a card does not move

A queued card that no agent has claimed gets a warning icon on its board tile and next to its status on the card page when the dispatcher could not hand it out. Hover the icon or focus it with the keyboard to read the reason.

- **Red, "Not workable"**: nobody hired could ever take the card's current stage, so waiting will not help. Typical reasons: no builder is hired; the Review stage needs a senior reviewer and only juniors exist; the only reviewer built the card (nobody reviews their own work); a large change needs two different senior reviewers but only one is hired ("needs a second senior reviewer other than Linus"). The tooltip has a **Hire** link that opens the HR board's Hire form with the missing role and seniority already chosen.
- **Amber, "Waiting"**: agents exist but cannot work right now: their workstation is offline ("Reviewer Linus is offline"), no workstation with an eligible agent holds the card's repository, or every eligible agent has been busy for more than ten minutes. It clears by itself when the machine is back, the repository is cloned or the agent is free.

The icon follows hiring, firing, role changes and claims live, and offline workstations within about 30 seconds.

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

The form shows only fields that matter to real work. The mock-runtime fields (**Mock script**, **Mock test environment**, **Mock outbound draft**, **Mock research claims**, **Mock feed items**) exist for development and the test suite: they appear, and the API accepts them, only when the server runs with `AOM_MOCK_UI=true`. Without it the API refuses them with a 422 (`mock_fields_disabled`) and the card page does not show them.

### Editing a card

The card owner and the project owner can change a card with **Edit** on its page while it is a draft (Spec) or queued and unclaimed: title, repository, completion action, priority, docs needed and the workflow's fields, with the same checks as the New card form (a queued card must keep the fields its stage needs). Empty a field to remove it. A card an agent holds (claimed) cannot be edited: the page offers no Edit and the server answers that the card is being worked on; release the claim first. Every edit appears in the card's **Timeline** ("Edited title, requirements", who, when).

### Moving and releasing cards

Clicking a card shows its detail view. Actions:

- **Move**: reassign to a different stage (manager only; used to fix stuck cards)
- **Release**: return to the queue (if an agent dropped it mid-shift or you need to reassign)
- **Release back-off**: appears only on a card showing the badge below
- **Cancel**: mark as cancelled (keeps the history, does not queue it again)

#### "Backing off until 14:32 (3 failures)"

When three shifts on the same card end without a report within 10 minutes (the agent crashed, timed out, or was stopped by a denied tool and ended with nothing), the dispatcher stops handing the card out and shows this amber badge on the board and on the card page. The wait starts at 1 minute and doubles with every further failure, up to 1 hour. A shift that reports resets it. You also get one alert on the desk per episode, and the card thread holds a single note instead of one per failure.

The usual cause is something the agent cannot do (a tool that is denied, a missing capability). Fix that, then click **Release back-off** on the card page to retry at once. If the card fails again, the next wait is longer than before. Moving the card to another stage also clears the back-off.

### Risk tier

Auto-computed from the diff size of similar PRs:
- **Small** (≤100 lines changed): one reviewer approval, one tester
- **Large** (>100 lines): two distinct senior reviewers, full test suite run after finalize

Override on the card detail if the auto-computed tier does not match the risk (e.g., a 50-line change to a critical system deserves large-tier review). The card owner and the project owner click **Change** next to the risk tier, pick small or large (or go back to the computed tier) and give a reason; the override shows as an "override" badge, the reason and who set it appear in the Timeline, and from then on the diff no longer changes it. It works like the computed tier: it sets how many reviewers must approve and whether a merge at Finalize waits for your approval. It can be changed while the card is open, except while a merge is pending.

The BA can do the same from its shift with `aom risk <small|large> --reason "<why>"`; the override is recorded with the BA as the actor.

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

#### Creating a new repository

Agents cannot create GitHub repositories themselves: their sandbox has no GitHub login and cannot push. When a project needs a new repository, the BA (in any chat or intake) or the DevOps engineer asks for it with `aom repo create`. The request appears on your desk as **Create repository `<owner/repo>`**, showing the repository name, its visibility (private or public), the project, which of your workstations will run it, and that it uses your own GitHub login (`gh`) on that workstation. Nothing is created until you click **Create repository**.

On approval your own runner creates the repository with `gh`, pushes a first commit (a `README.md` named after the project) to `main`, clones it under the first repository root of your workstation (for example `~/src/<repo>`) and reports the URL. The server adds it to the project (working branch `main`), exactly as if you had added it in the project settings, and the agent's conversation is told the result so it can go on to create cards on it. Only the project owner can approve, and your workstation must be connected (and `gh` installed and logged in); an existing GitHub repository of that name is never touched unless it is empty and yours. Any failure comes back to the desk as an alert (**Repository not created**), and nothing is added to the project. Once you have fixed the cause (for example `gh auth login`, or starting your runner), click **Retry** on the alert: the same request runs again on your connected workstation (it reuses an empty repository of yours that was already created and its own earlier clone) and the agent's conversation is told. **Dismiss** closes the alert and leaves the request failed; the agent can then ask again. Only the project owner can retry. Asking twice for the same repository never creates a second one.

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

- **What kind it is**, as a label: Question, DevOps approval, Merge approval, Outbound update, Digest to rate, Escalation, Vault conflict, Tester bottleneck and so on (the same label in the list and in the item)
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

(You can also ask the BA to create cards in any chat, not only in an intake; see "Chat with agents".)

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

Testers run browsers (Playwright/Chromium). For that, a tester's sandbox allows Unix sockets, while Docker, WSL interop, the desktop session bus, keyrings and ssh-agent sockets stay hidden from it. A custom role that needs a browser opts in with the **runs browsers** option in the role editor (granting it to a single agent beyond its role is for the organization owner). Playwright's `test-results/`, `playwright-report/` and `blob-report/` folders are treated as scratch output: they are discarded after the shift and never committed. Details and the trade-off: docs/RUNNER.md, "Browser roles (testers) and Unix sockets".

Reviewers, business analysts and other roles that cannot edit or commit work in a read-only worktree: their shell cannot write to it. A reviewer who needs a build or tests runs them in a copy under its scratch directory. Anything that still changes the worktree is rolled back after the shift and recorded as a guard violation.

### Finalization

A large merge waits for your approval on the desk; until you answer, its card stays in the Finalize column with an "Awaiting your approval" badge.

**Owner override: merge large changes without waiting for you.** In **Project settings**, the **Large changes** panel has the setting **Merge large changes without my approval** (off by default). Only the project owner can change it; additional managers see its state read-only. Turning it on asks for a confirmation, because from then on a large change is merged into the working branch as soon as it is finalized: only the two reviews, the tests and the full suite that runs after the merge stand in between. The card's timeline then says "Large change merged without manager approval (project setting)". Every change of the setting is recorded with who made it and when (shown in the panel and its history). Turning it on does not touch approvals already waiting on the desk: they stay, show a hint that the project setting now allows merging without your approval, and **Approve merge** still works with one click. Turn it off again and large merges wait for you as before.

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
2. Add a **Schedule** to run the scout (scan for items). The form has:
   - **Topic**: a short label for the feed
   - **Description**: markdown, optional but encouraged. Say in detail what you want: the angle, what to include or leave out, the level. The scout and curator treat it as the main statement of what you want, ahead of the topic. Schedules created before this field existed keep working without it
   - **Max items**: one number (default 10). The curator ranks everything the scout found, whatever the kind (article, video, podcast), and posts the best N overall. Older schedules that set a maximum per kind are read as the sum of their numbers
   - **Preferred sites**: searched first
3. The scout collects a few more candidates than Max items; the curator picks the best and appends them to the project feed file in your vault
4. You rate digest items (useful, irrelevant, boring) and add your taste preferences
5. Future curators learn from your ratings

Feed rules (added to vault):
- General search patterns
- Preferred sources (prioritize these)
- Deduplication
- One top-N limit across kinds

**Transcripts for videos and podcasts.** Every video or podcast in a digest comes with its transcript so you can read it quickly instead of watching it. On the desk rating item and on the feed project page each such item has a **Transcript** button that shows the text (or "No transcript available"). The transcript is also saved in your vault as `projects/<name>/transcripts/<date>-<title>.md`, and the curator writes the item's summary from it. Research cards do the same for video and podcast sources: the transcript is saved in the same folder, the fact checker verifies claims against it, and the published note links it.

Transcripts for YouTube and other video sites need **yt-dlp** on the workstation. If it is missing, the scout reports "transcript tool missing: yt-dlp" and asks the DevOps engineer to install it (you can also ask DevOps yourself: "install yt-dlp"); `aom-runner doctor` lists it as an optional tool. Podcasts use the transcript the episode page or feed publishes, when there is one. Where no transcript exists the item shows "No transcript available"; text is never made up.

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

A chat with the business analyst (BA) is also how you get work specified: ask the BA in any chat, including one you started from the desk's **Chat** button, to create cards. The BA maps the project (or uses the project the chat is tied to), drafts and specifies the cards, and the conversation is linked to every card it creates (the chat becomes an intake with no external ticket). The BA works with your rights: it can only use projects you are a member of. Other agents cannot create cards from chat.

In any chat the agent may write notes and drafts in its own scratch folder; it still cannot change your repositories, the vault or its configuration from a chat.

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

## Known gap: Couchbase isolation and heavy-build queue

The spec's testing section asks for one Couchbase bucket or scope per worktree and for heavy builds (for example MAUI) to queue one at a time per workstation. Neither is built yet. Until it is, keep Couchbase-backed or MAUI projects to one tester and one builder per workstation.
