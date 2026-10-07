# Guildwise HQ: User Guide for Managers

Guildwise HQ is your guild of AI agents: many hands, one master. This guide is for the master, the manager who sets the standard and answers the agents' questions.

First login and setup, managing projects and agents, the board and decision desk, intake from external systems, and organization design.

## Getting started

### First login

1. Check your email for an invitation link. It comes either from the platform administrator ("start your organization": you become its Owner) or from the Owner or an Admin of an organization ("join Acme": you become a Member or Admin)
2. Click the link, choose your name and a password (12+ characters). If you already have an account, sign in instead and confirm
3. You are now logged in and can access the dashboard

Every account belongs to an organization. There are no accounts without one, except the platform administrator.

### Pairing your first workstation

A workstation is a machine (Windows, macOS, Linux) where agents will run code and pull from git repositories.

1. Open **Workstations** in the side menu (on a phone, open the menu with the button at the top left)
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

**Sandbox warnings.** If a workstation's runner reports that agents run without an OS sandbox, the Workstations page, each affected agent card on the Agents page and the Hire form show an amber warning that cannot be dismissed, and hiring onto it needs a confirmation. A workstation that cannot run agents at all shows why (for example "Native Windows: install the runner in WSL2"). The reason names the actual cause: the platform, the runtime's sandbox set to `off` in the runner config, a missing `bubblewrap` or `socat`, or (tests only) a forced state, and the advice below it fits that cause.

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

## Organizations, roles and security

An **organization** owns projects, agents, the catalogue, the desk, the ledger and the vaults. Everyone works inside an organization, in one of these roles:

| Role | Can do |
| --- | --- |
| **Owner** | Everything an Admin can, plus: invite Admins, change roles, require two-factor login, hand ownership to an Admin. There is exactly one Owner |
| **Admin** | Create projects, add and remove people, manage vaults, hire and fire any agent, see the plan and limits |
| **Member** | Work in the projects they were added to: hire agents on their own workstations, move cards, answer the desk |
| **Guest** | Not a member. Has access to one or more projects of the organization (see below). Guests see nothing at organization level |

Only the Owner and Admins create projects and add people. There is no setting that changes this.

### Switching organizations

You can belong to several organizations. The **organization switcher** at the top of the sidebar shows the one this browser tab works in, and a different tab can work in a different one. Projects of an organization where you are only a guest carry a "Guest" label with the organization's name.

### Members, invitations and guests

Open **Settings > Organization** (Owner and Admins; Members see a read-only member list).

- **Members** lists everyone with their role. The Owner changes roles and removes people; Admins remove Members. When someone is removed, their agents are re-homed to you and claimed cards are released. Anyone except the Owner can leave. The Owner must hand over ownership first.
- **Invitations** shows pending and past invitations (resend, revoke). Invite a person as a Member (with the projects they start on) or, as Owner, as an Admin. They receive an email with a link.
- **Guests** lists the people from other organizations who have access to your projects.
- **Plan & limits** shows the plan, status, licence date, usage and feature switches. The Founding plan has no limits yet; the limit fields are empty (unlimited) until pricing is decided. To change the plan, ask your platform administrator.

**Guests.** Sharing a project (**Projects > Settings > Members**) invites an existing person who already belongs to an organization. If they have no account, invite them as a Member of your organization instead, or ask the platform administrator for a separate organization for them. A guest accepts in the **Project invitations** inbox on the Projects page, which names the inviting organization.

### Two-factor login

Anyone can switch on two-factor login (a six-digit code from an authenticator app) under **Settings > Security**: enter your password, scan the QR code, type the first code. You get ten **recovery codes**, shown once. Keep them somewhere safe: each works once if you lose your phone. At sign-in, after your password you are asked for the code (or a recovery code).

- The platform administrator must use it (it is set up at first sign-in).
- The Owner can **require it for the organization** (Organization > General). Members who have not set it up are held at the setup screen until they do. The Owner needs it on their own account first.
- If a member loses their phone and recovery codes, the Owner (or the platform administrator) resets their two-factor login on the Members tab.

### Suspension and licences

A platform administrator can suspend an organization (unpaid, trial over, a licence date passed). Running shifts finish and nothing new starts; scheduled fires are skipped and recorded. A banner explains it. Only the Owner can still sign in, with read access plus organization settings and members. Reactivating the organization resumes everything where it stopped.

### The platform area (platform administrators only)

The platform administrator signs in at the same address and sees only the **Platform** area: organizations (status, Owner, plan, usage, limits, features), invitations to start a new organization, accounts (deactivate, reset two-factor) and the audit log. They never see an organization's cards, desk or vaults. Every platform action is recorded in the audit log, which is kept forever. The administrator can suspend, reactivate or cancel an organization and, with a written reason, move ownership to one of its Admins (for example when the Owner left the company).

## Projects

### Creating a project

1. Go to **Projects** (as Owner or Admin; Members do not see the button)
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
- **Work vault**: shared among the organization's Owner and Admins (it syncs to their workstations only; Members and guests never receive it)
- **Project vaults**: one per project, shared with all members who see that project

To configure:
1. Go to **Projects** > **Settings** > **Vaults**
2. Add URLs (SSH or HTTPS) for personal and work vaults. URLs must not contain a password or token (`https://user:token@host/...` is refused): use SSH keys or a credential helper on the workstation
3. Set sync interval (default 300 seconds)

**On Windows**, if vault URLs use SSH keys, ensure git can find them (OpenSSH or PuTTY; WSL2 recommended).

### Sharing a project

Only the Owner and Admins of the organization can add people to a project. To invite someone from another organization as a guest:

1. Go to **Projects** > **Settings** > **Members**
2. Enter their email and click **Invite**. The person must already have an account that belongs to an organization
3. They accept in their Project invitations inbox and gain access to this project only
4. They can hire agents onto their own workstations (allowed on the shared project only), see the board, and answer desk items
5. Only the organization's Owner and Admins (and the hiring manager) can change each agent. A guest's agent works only on the projects shared with them, whatever its allowed projects say

When you remove a member from a project, the cards their agents held on it are released. Their agents move to your workstation and account (they need re-homing) only if that was the member's last project in your organization; otherwise they keep working the member's other projects. Deactivating a user (platform administrator) does the same for every project they were a manager of, unlinks all of their workstations (their runners are disconnected and cannot reconnect), and parks their own agents until the account is reactivated and re-paired.

Only the project owner can add standing orders (also from a card or when answering a question); a guest manager can answer questions with decisions and requirements. Organization-wide standing orders can only come from the organization owner. An agent's permissions can be narrowed by its hiring manager but never widened beyond its role (a reviewer never commits); widening other limits (web, extra tools, risk tiers) is for the organization owner.

### Archiving, restoring and deleting a project

**Archive** a project you no longer use: **Projects** > **Settings** > **Danger zone** > **Archive project**. The dialog lists what will stop before you confirm (active shifts, open cards, schedules, open desk items). On confirm:

- running shifts are cancelled and their worktrees removed (the branches are kept);
- open cards are closed as *archived* (they show as cancelled with the reason "Project archived", so you can tell them from cards you cancelled yourself);
- schedules are switched off and open desk items for the project are dismissed;
- the project disappears from boards, project pickers, the Schedules and Desk pages, and from intake mapping, and the dispatcher stops giving its work to agents.

Agents hired for the project are not fired; they simply stop getting its work. Cards, history and the vault folder are kept. Any member of the project (owner or manager) can archive and restore it, and members of a shared project see it as archived.

**Restore**: **Projects** > **Archived** > **Restore** (or **Settings** > **Danger zone** > **Restore project**). The project is back on the boards and pickers and takes work again. Cards that the archive closed stay closed and schedules stay off; create new cards and switch schedules back on as needed.

**Delete permanently**: only the project owner, and only for an archived project. **Projects** > **Archived** > **Delete permanently**, then type the project key to confirm. The project's cards, threads and messages, schedules, desk items, repositories, members, digests, transcripts and research notes are removed from the database and cannot be recovered. The audit log keeps a record that the project was deleted, and the vault folder is never touched. Agents are never let go with a project: they belong to the organization, the project simply leaves their allowed projects. An agent that was allowed on that project only is **benched**: its allowed list is empty, so it takes no work until you give it projects again (the agent's **Projects** dialog). One notice on the desk names the benched agents so you can reassign them. The project key becomes free for a new project.

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

- **Red, "Not workable"**: nobody hired could ever take the card's current stage, so waiting will not help. Typical reasons: no builder is hired; the Review stage needs a senior reviewer and only juniors exist; the only reviewer built the card (nobody reviews their own work); a large change needs two different senior reviewers but only one is hired ("needs a second senior reviewer other than Linus"). The tooltip has a **Hire** link that opens the Agents page's Hire form with the missing role and seniority already chosen.
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
   - **Where may this agent work?**: **Any project** (Owners and Admins) or **Selected projects**, ticked one by one. The form starts with the project you worked on last. Star the projects the agent should prefer. See "Where an agent works" below
   - **Model**: Claude Opus 4, Sonnet 4.5, etc., and effort level
   - **Name**: autocomplete suggests unused names; type to override
   - **Skills**: special knowledge (e.g., "Playwright", "database migrations")
   - **Capacity**: max concurrent cards (default 1; larger for routine roles like DevOps)
3. Click **Hire**

First-run limits (removed after you see the Agents page):
- 2 builders
- 1 of each other role (reviewer, tester, writer, DevOps)

Name suggestions skip retired agents and names already in use.

### Where an agent works

Agents belong to your organization, not to one project. For each agent you decide where it may work:

- **Allowed projects**: **Any project** of the organization, or only the projects you tick. The agent is only offered cards of those projects. Click **Projects** on the agent's card on the **Agents** page to change it at any time; the card shows a "Works on" line with the projects (a star marks the preferred ones) or "any project". An empty list benches the agent. Owners and Admins can allow any project; a Member or guest manager can only pick projects they are on.
- **Preferred projects (focus)**: the star next to a project. It is a soft preference inside the allowed projects: when a card of a starred project and a card of another project are both waiting, the agent takes the starred one first (before the project's priority tier). Up to 10 projects. Removing a project from the allowed list also removes it from the preferred ones.
- **Whose projects**: the agent also needs the person who owns its workstation to be on the project. Owners and Admins are on every project of the organization; a guest is only on the projects shared with them, so a guest's agent never works the owner's other projects, whatever its allowed projects say.
- **Hiring**: the Hire form sets the default allow-list of the new agent. Without a choice it starts with the project you worked on last (not "any project").
- **Projects that go away**: deleting a project keeps its agents. Removing a person from their last project hands their agents back to you (they need re-homing).
- **Limit simultaneous shifts**: **Projects** > **Settings** > **Simultaneous shifts** sets an optional cap on how many shifts may run at once on that project, whatever the number of agents allowed on it. It is off by default. At the cap, the project's other cards wait in the queue. Any project member can change it.

### The DevOps engineer

You get one DevOps agent per workstation automatically. It cannot be fired, only **reset** (which wipes its sandbox like a firing, but keeps it assigned). It is not driven by cards; agents and you ask it directly via the `aom devops` command in a shift or the **Ask DevOps** button on the Workstations page.

The DevOps engineer is free (it does not count against the agent limit) and one exists per organization per workstation. Allowed projects do not apply to it: it works DevOps requests and repository checks only, and has no Projects button. Because it is free it cannot be extended: no extra instructions, skills, tools, standing orders or custom permissions, it cannot be cloned into a custom role or given workflow stages. Only its model and effort can change.

DevOps is always available and outside the queue. It handles:
- Cloning and setting up projects
- Installing tools and dependencies
- Starting containers and databases
- Pulling/pushing vault changes
- Granting access to internal systems (with your approval on the desk)

#### Repository hygiene and the working branch

Once a day per workstation (you can change that, or switch it off, under **Workstations**, **Repository hygiene**, and start one with **Run hygiene now**) the DevOps engineer tidies the project repositories on that machine. For each repository it fetches and pulls, **commits any uncommitted changes to the working branch** and pushes them, pushes commits that were not pushed yet, and removes branches and worktrees of cards that are finished and merged. The same pass cleans up leftover card worktrees (the runner also does that when it starts). Everything it did is logged in the request on the Workstations page.

**The working branch is something you confirm, it is never guessed.** While a repository has no confirmed working branch (the project settings show *not confirmed*), the DevOps engineer does not commit, pull or push in it. It only reports the uncommitted changes and asks you on the desk, **Which branch is the working branch of `<repository>`?**, with the repository's branches as options and *Another branch* (type its name). The question is pinned and blocking when changes are waiting for the answer. Your answer is stored on the repository, written to the ledger so nobody asks again, and the DevOps engineer commits and pushes right away. You can also set or change it any time in the project settings, in the repository row (**Change**). The project owner decides.

When something changes, you are asked again: when a new intake starts for the project, and when a new phase is created or activated, the DevOps engineer asks **Keep `<branch>` as the working branch ... or use another branch?** (a normal item: your BA may look at it first). A phase can have its own working branch; hygiene then uses the active phase's branch.

What hygiene cannot resolve it does not force: a conflict while pulling, uncommitted changes on a branch that is not the working branch, an authentication failure, a missing clone, a leftover worktree with uncommitted changes (never deleted). These show up as a failure in your BA's daily report until a later run finds the repository in order.

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

## Phases and follow-ups

A **phase** is a named slice of a project's work ("Phase 2: autosave"): the cards you want to ship and check together. When all of them are done and merged, the BA tells you, and you decide what happens next: deploy, run the regression suite, do something custom. Nothing runs until you approve. Every active member of a project can do everything described here.

### Setting up (project settings)

- **Deploy targets**: where a phase can be deployed. A **local Docker stack** is deployed on *every workstation of every project member* (one DevOps request each, and the deploy only counts as successful when all succeed). A **remote host** names the workstation whose DevOps engineer deploys over SSH, the SSH host alias (from that user's `~/.ssh/config`) and, optionally, the app URL. The notes ("how to deploy": the compose file, the script, the environment) are what the DevOps engineer reads. No passwords or keys are stored in the site: SSH keys and Docker stay on the workstation, and anything destructive still goes through the DevOps approval on your desk.
- **Default follow-ups**: the list every new phase starts with, for example *Deploy to local*, then *Regression run (web) against local*.

### Creating a phase and putting cards in it

Create a phase from **Project settings > Phases > New phase**, or let the BA propose one in an intake chat ("this is phase 2"): it proposes the phase, the cards and the follow-ups, and you confirm them on the desk (**Phase proposal**). Put a card in a phase from the phase page (**Add a card**) or the card page (**Phase** select). A card belongs to at most one phase; suite and regression cards and bug fixes that ride on another card's branch cannot be members. The board has a phase filter and a chip on each card; a "proposed" mark means the BA suggested it and you have not confirmed it yet. A bug card filed after finalize (for example by the full E2E suite) joins the phase it came from automatically, and the phase waits for it.

### When is a phase done?

When every card is **finalized and its work is in the project's working branch**, closed by hand, or cancelled. A card finalized with *merge* counts at once. A card finalized with *PR* or *push branch* counts once the runner finds its branch merged into the working branch (it checks with git every few minutes; no GitHub status is needed) and then deletes the branch. If the check cannot see it (a squash merge, a branch that was deleted), click **Mark merged** on the phase page. A card that ends without a merge (cancelled, closed by hand) gives its worktree back; its branch is kept and listed in the report. Full E2E suites that run after a merge never delay the phase: the report lists them as passed, failed or still running.

### The "phase done" desk item

The BA writes a report (what was delivered with the merge commits, what was cancelled, what is outstanding) and the desk shows **Phase done: approve N follow-ups?**. You can **Edit follow-ups** (add, remove, reorder, change targets) before you decide, **Approve all**, **Reject** (nothing runs), or **Reopen the phase** (it waits for its cards again; possible until you approve). With no follow-ups the item is just an acknowledgement. If no BA is available (none hired, or none online for 15 minutes) the server writes a template report ("Your BA was not available; this summary was generated.") so you are never left waiting.

### What runs after you approve

The follow-ups are frozen. The BA writes the instructions for each delegate, then the server runs them **in order, one at a time**: a deploy becomes DevOps request(s) with the target's details; a regression run becomes a regression card pinned to the workstation that was just deployed, testing the target URL (the tester gets it in the card and as `AOM_TARGET_URL`); a custom item goes to DevOps, a tester or the BA. **If any follow-up fails, the ones after it are skipped.** At the end a **Phase results** notice lists each result with its evidence (pinned when something failed). The phase page shows live status, the DevOps requests, the regression cards and the progress thread. Archiving a project cancels its phases and their pending follow-ups.

## Your BA reports to you

Your BA is your eyes and ears on the floor and your one consolidated voice. It reports in three ways, and it never slows an agent down.

### What goes through the BA

With **routing** on (it is on for every new organization; **Settings > Your BA reports to you**), what agents and the system raise goes to your BA first:

- **Urgent items reach your desk at once, unchanged**: blocking questions, approvals (DevOps, merges, outbound updates, new repositories, roles and workflows), pinned alerts and a card that keeps failing. The BA adds a **BA note** under the item a little later: how often it was asked, what the ledger says, what it recommends.
- **Everything else** (for example a "bug reported" or "posting failed" alert) is held for the BA for up to **10 minutes**. The BA passes it on (often with a note), folds duplicates into one item, or dismisses noise it can show is already covered. You see the result: "Your BA looked at this first and passed it on", and what the BA resolved itself is listed in the daily report.
- **A non-blocking question** reaches your BA before any colleague. It answers from the ledger when it can, otherwise it escalates with the context you need.
- **The BA never blocks anyone.** An item it has not looked at within ten minutes reaches you unchanged ("Your BA had not looked at this in time"), and with no BA online nothing is held at all. The BA can only dismiss or merge non-urgent alerts, never a question or an approval.

Turn routing off in Settings to see everything as it is raised, exactly as before.

### Signals the server watches for

The server checks the floor every minute, without using any tokens (the BA only works when something fires):

| Signal | Threshold | How you hear about it |
| --- | --- | --- |
| A card keeps failing (shift loop) | 3 failed shifts on one card in 10 minutes | At once: the loop alert gets the BA's analysis as a note |
| The same approval asked again and again | The same DevOps or approval action 3 times in 24 hours (at once if it was rejected before) | In the daily report (at once when it was rejected before) |
| Blocked too long | A blocked card waits more than 4 hours | Daily report |
| Nobody can take it | A queued card nobody is able to take for more than 30 minutes | Daily report |
| Repeated failures | A card in rework round 3, or a failed finalize twice | Daily report |
| Repository hygiene problem | The DevOps engineer could not resolve something in a repository (conflict, changes on the wrong branch, authentication, missing clone) or found a leftover worktree with uncommitted changes | Daily report, under Failures |

A signal appears once however long it lasts, and clears by itself when the cause is gone (a notice the BA posted is then acknowledged for you).

### The daily floor report

At **08:00 on your clock** the BA posts one **Floor report** on your desk (only on days with something to say; urgent notices never wait for it, at any hour). It lists:

1. phases waiting or open, and the ones held open by late bug cards;
2. stuck, blocked and backing-off cards;
3. repeated approvals;
4. failures;
5. DevOps requests that are open;
6. what the BA resolved itself without bothering you.

Open **The facts behind this report** for the same lists straight from the server, with links. Every report links to your standing **BA reports** chat (one per organization): ask "why?" there. The desk item stays the record; the chat holds the discussion. With no BA available (none hired, or none online for 15 minutes) the server posts the same report from a template, and passes items on unchanged.

### Settings: your time zone and the report time

**Settings** (bottom of the side menu) holds your **time zone**, which the app takes from your browser the first time you sign in (change it any time; until it is set, reports use UTC), the **routing** switch and the **time of the daily report** (default 08:00).

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

## Interests

The **Interests** page (side menu, Knowledge: Interests) is the one place that says what you care about, across all your feed and research projects. An interest is a topic with a name and a description. It owns the feed schedule that scans for it, it prefills research cards about it, it carries your explicit taste rules, and it shows what came of it: scans, items, your ratings and published notes.

Anyone who is a member of the projects an interest links to can create, edit, pause and delete it, and set its taste rules (the same "any member" rule as phases). Someone who is a member of only one of its two projects can see it, run it and research it but not edit it.

### Reading the page

Each interest is a card with its name, whether it is active or paused, its feed and research project, and its sub-category. Below that:

- **The scan**: when it runs ("Daily at 07:00 (Africa/Johannesburg)"), how many hours back it looks, how many items the digest holds, or "Manual only".
- **The last scan** (a link to its card, with the number of items) and the next one.
- **Ratings**: how many items you rated useful, irrelevant and boring, and how many are still unrated. On a phone this is the compact `U12 I3 B5 ?2`.
- **Notes**: how many research notes were published for it and how many research cards are still open.
- A red **Cannot run** badge, with the reason, when its schedule keeps failing (it retries with growing pauses, like any schedule).

Buttons: **Run now** (scan once, straight away), **Research this**, **Digests** (the feed page filtered to this interest), **Notes** (recent scans and published notes), **Pause/Resume** and **Edit**. The filters above the list narrow it by project, status and search text.

### Creating and editing an interest

**+ New** (or **Edit**) opens a panel on the right (a full-screen sheet on a phone). Fields:

- **Name**: a short label. It is also the feed topic and the title of the scan cards.
- **Description**: markdown. The angle, what to include or leave out, the level. The scout and curator follow this first.
- **Feed project**: the feed project that scans for it, or **+ New feed project** (a key, a name and a domain; it uses the Feed workflow and the default vault folder). Leave it empty for a research-only interest.
- **Research project**: where "Research this" creates cards. Optional.
- **Sub-category** and **Preferred sites**.
- **Scan**: a preset or a custom cron expression, the time zone, the **window** in hours (empty: derived from the cadence, 1 hour for hourly, 24 for daily and weekdays, 168 for weekly), **max items** (the best N overall, whatever the kind) and **Manual only**.
- **Taste rules for this interest**, and **Status** (Active or Paused).

An interest always has exactly one feed schedule when it has a feed project. You change the schedule by changing the interest: the description, sites, window and max items rewrite the schedule's card template; a new cadence recomputes the next run; pausing (or Manual only) disables it and resuming gives it a fresh next run. Moving the interest to another feed project replaces its schedule; removing the feed project deletes it. Deleting an interest asks whether to **keep the schedule as a plain schedule**.

On the **Schedules** page a schedule that belongs to an interest says "Managed by interest ..." with a link to it. Its Edit, Pause and Delete are gone (the server refuses them with a 409); **Run now** still works.

### Adopting the schedules you already have

If you have feed schedules that are not interests, a banner says so ("3 feed schedules are not interests yet") and the **Adopt** button lists them. **Adopt selected** makes one interest per schedule, named after its topic (a duplicate name gets " (2)"), and leaves the schedule as it is; the first time you edit the interest its template is normalized. Earlier scans of an adopted schedule count for the interest. A schedule that cannot be adopted (for instance its project is archived) shows the reason next to it; the others are adopted anyway.

### Research this

**Research this** opens a research card prefilled from the interest: the title ("Research: Rust async"), the question ("What should I know now about Rust async?"), the description as the scope, the sub-category and the sites. Edit anything, then **Create and queue** (the card goes to the researcher at once) or **Save as draft**. If the interest has no research project, choose one; tick "Remember this project for the interest" to keep it. The published note appears under the interest's **Notes**.

### Taste rules

Besides the rules that grow from your ratings, you can write **explicit taste rules**: a sentence each, such as "Skip beginner tutorials". The curators follow them first and they win when a rating line disagrees. A rule written as `skip "Exact title"` drops the item with exactly that title.

- Rules are stored per feed project. A rule set in an interest's panel only reaches scans of that interest; a rule in **Project taste rules** (the panel at the bottom of the page, **Edit taste rules**) reaches every scan of the project.
- They are written to the project's `taste.md` in your vault as a single block under the heading **Explicit rules**, above the rating lines (headed by comment markers that say it is managed by the site). **Edits you make inside that block in Obsidian are overwritten**; the rating lines below it stay yours to edit. If the project has no vault, or no workstation holds a clone, nothing is written and the panel says so; the curators still get the rules.
- The `taste.md` preview on the feed page lists explicit rules first.

## Schedules and feeds

### Schedules

A schedule is **a trigger and one action**. The **Schedules** page (side menu, Work) lists them grouped by project, with the ones for the whole organization first. **New schedule** opens a three-step wizard: **When**, **What**, **Details**.

**When (the trigger)**

| Trigger | What it does |
| --- | --- |
| **On a schedule** | A cron time with a preset ("Weekdays at 07:00", "Mondays at 07:00", "Every hour", ...) or your own five-field cron expression, in a time zone you choose. Missed fires (the server was down) happen once, not many times. |
| **When something happens** | A phase is completed, a card is finalized, an interest run is done or a project is converted, optionally only in one project. The server watches for these itself: no agent polls, and the same event never runs a schedule twice. |
| **When an issue is labelled** | A GitHub or Jira issue gets a label. One of your workstations polls on the cadence you pick, with its own `gh` login or Jira token; the credentials never leave it. Each new issue runs the action once. |
| **Only when I run it** | No automatic trigger: use **Run now**. |

**What (the action)**

- **Create a card** from a template. A title without `{date}` or `{week}` gets the date appended; `{ref}`, `{project}` and `{issue.title}` work when an event or an issue ran it. The card is queued ahead of normal work.
- **Run a regression**: one regression card per platform, queued at Test.
- **Ask DevOps**: a request to the DevOps engineer of one of your workstations, or a repository hygiene run.
- **Ask the BA**: free-text instructions. The BA reads (ledger, desk, vault, repositories; it changes nothing) and posts one report on your desk, with the BA chat open if you chose that. If no BA is available the desk gets a notice with your instructions instead.
- **Poll GitHub or Jira issues**: new issues of a repository (or a JQL filter) go into **intake** with the BA, one conversation each. An issue is taken once.
- **Send a webhook**: POST JSON to a URL. Formats: generic (n8n, Zapier, your own code), Slack incoming webhook and Microsoft Teams (both get a formatted `text`). You may append the floor report or a project summary. Each request is signed: the header `X-AOM-Signature` is `sha256=` plus the HMAC-SHA256 of `<X-AOM-Timestamp>.<body>` with the schedule's secret, which is shown **once** when you create it (**New secret** replaces it). A failed delivery (a 5xx, 429 or a network error) is retried after 1 minute, 5 minutes, 30 minutes and 2 hours, five tries in all; another 4xx answer is final. Addresses on this machine or a private network are refused unless the deployment allows them.
- **E-mail a digest**: the floor report (the whole organization) or a project summary, sent at the time you set from the site's mail account. A failing mail server is retried like a webhook. Interest digests will join once interests move to the organization.

**History.** **History** on a schedule shows every run: when, what triggered it, what it did, a link to the card or the intakes it made, and the reason when it failed. For a webhook or an e-mail the **Deliveries** view is the delivery log with every try, its HTTP status and its duration. **Send test** (webhooks and e-mails) sends one signed test delivery now; it is logged but never retried and is not counted as a run of the schedule.

**System rows.** Under **Run by the system** two jobs are listed read-only: the repository hygiene of each of your workstations and the BA floor report. They show when they run and last ran, with a **Configure** link to where you change them.

**Who may do what.** A schedule tied to a project can be created, changed and run by any member of that project, guests on a shared project included. A schedule that acts for the whole organization (a BA task or an integration without a project, repository hygiene, the floor report digest) is for the Owner and Admins only; others see a note and must choose a project. A schedule that runs on a workstation (DevOps, issue polling) needs the workstation's user to create or change it, and it runs as the person who created it. A member may e-mail a digest to their own address only. If its owner loses access to the project, the schedule stops and a notice appears on the desk. A suspended organization skips its schedules and records it.

**Feeds.** New feed schedules are not created here any more: feeds are [Interests](#interests). Feed schedules that already exist keep running and stay listed (those that belong to an interest are changed on the Interests page).

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
