# Guildwise HQ — Spec

Oct 2, 2026 · @Pieter

## Overview and goals

Agent Org Manager runs a team of named AI agents as an organization across code and research projects and interests, for work and for yourself alike (your own organization is where your personal work lives): work arrives as cards, agents pull it asynchronously, and the human acts as engineering manager rather than implementer. The unit of work is the card, not the session; sessions are short shifts that start, do one job, write a handoff and exit.

Goals:

- One board to see every card, who holds it, and what state it is in
- One decision desk where every question and approval reaches the manager, with who asked and why
- No agent ever blocks waiting on another; testing runs in parallel with building
- Every answer is recorded once and never asked again
- The organization stays separate from company systems; nothing leaves without manager approval

Idle capacity is never wasted: when work queues are empty, agents pull side-project and research cards, and scheduled tasks always run on time.

It is a hosted, multi-user website from the start; agents run on each user's own workstation, which connects out to the site.

Non-goals for v1: cost tracking, Postgres backups (handled outside the app), and agents that pick their own work outside the board.

## Operating model

An agent is a persistent profile; a session is a disposable shift run under that profile. Hiring creates a profile; firing retires it and wipes everything it has accumulated outside the official record.

| Field | Purpose |
| --- | --- |
| Name | Handle shown on the board and decision desk |
| Role | BA/architect, builder, reviewer, tester, technical writer |
| Seniority | Junior or senior; gates permissions |
| Model | Agent runtime and provider (Claude by default), model and effort |
| Permissions | Tools, repos, branches it may touch |
| Skills | Skills and standing instructions loaded per shift |
| Capacity | Max concurrent cards (default 1) |
| Track record | Cards done, bounce rate, bugs escaped, questions per card |

Roles:

- **BA/architect** (senior): intake with the manager, investigation, specs, dependency graph, answers builder questions, finalization. One identity, two queues: interactive intake and background finalize.
- **Builder**: claims To do and Rework cards, works in the card's worktree, writes unit tests for its work, confirms the project builds and all unit tests pass, and writes a handoff.
- **Reviewer** (senior): reviews against the card spec, bounces with comments or approves to test.
- **Tester**: writes and runs Playwright E2E tests for new features on the card branch, runs full suites after finalize and regression runs, and may change E2E tests only.
- **Technical writer**: works a card after its test passes when the BA flagged it docs-needed at intake.
- **DevOps engineer**: one per user, always available, described below.

Names are handles, not personas. Official memory is the card history, ledger and vault; anything else an agent accumulates lives in its private sandbox and is disposable.

**DevOps engineer**: every user gets one dedicated DevOps engineer on each workstation. It cannot be fired, only reset, which wipes its sandbox like a firing does. It is not driven by cards alone: other agents and the manager ask it directly, and every request and action is logged as events on a thread so there is a record.

- **Project setup**: clone the project's repositories (a repository added in project settings is cloned onto the project's workstations, or created first when the manager chose a new one), make the toolchain ready before build work (it detects the stacks, installs what is missing within the rights the manager ticked, and holds back the project's build cards on that workstation until it is ready), prove the ticked rights on the machine (verified or failed with the fix; a sudo password, if needed, is encrypted in the browser for the runner and stored only there), install dependencies, start containers, seed data, and deploy the app locally so testers and builders can work
- **Vault sync**: clone the user's vaults and shared project vaults onto the workstation, pull updates on a regular interval, and commit and push changes on a regular interval (default every 5 minutes, configurable)
- **Environment management**: with the access the manager grants on that workstation, install tools and manage the machine's environment
- **Guardrails**: access is set per workstation; anything destructive or outside the granted access goes to the desk for approval first

Typical callers are a tester whose app is not running, a builder missing a tool, or the manager setting up a new project or machine.

**Private sandbox**: each agent runs with its own config and home directory (for Claude Code, its own `CLAUDE_CONFIG_DIR`). Session transcripts, auto-memory, caches, scratch files and any notes the agent writes for itself live there and nowhere else, so they can be wiped cleanly.

**Firing** is a reset, not a deletion:

1. Claimed cards are released back to their queues with the agent's last handoff attached
2. The private sandbox is deleted: transcripts, memory, caches, scratch files
3. The profile is marked retired: hidden from the HR board and dispatcher, never assigned work again
4. The official record stays intact: events, card threads, handoffs, review comments and ledger entries still show the agent's name, marked as retired

A retired name is never reused, so history stays unambiguous. To get the same role back with a clean slate, hire a new agent.

**Hiring** takes a role, seniority, model, skills and a name. The name is typed, or picked by an optional name generator that suggests a few names, skips any name in use or retired, and can draw from a themed list.

## Projects, types and scheduling

Every card belongs to a project, and the project's type decides its pipeline and which roles can claim its cards; the board, desk, ledger and dispatcher are shared by all types.

| Type | Pipeline | Roles | Examples |
| --- | --- | --- | --- |
| Code | Spec → build → review → test → finalize | BA/architect, builder, reviewer, tester, writer | Work repos, P5, side projects |
| Research | Question → research → fact-check → publish to vault | Researcher, checker | Shooting (reloading, hunting, sport shooting), education |
| Feed | Scheduled scan → filter → digest | Scout, curator | Firearm articles, AI and shooting videos |

A project has a **rank** in its organization (the Owner and Admins order the projects by drag and drop on the Projects page, or with the move up and move down buttons; a new project goes to the bottom), its repos or topics, sub-categories, and a folder in the knowledge vault of its organization or in its own project vault. There is no work/personal split: "personal" simply means your own organization. Intake maps each incoming ticket to a project; an unmapped ticket becomes a desk question.

**Scheduling rules**

1. Scheduled tasks always fire on time, whatever the project type or queue state. They emit a card that takes the next free agent of the right role ahead of normal work; if none is free, the runner starts one extra shift at a time rather than letting the schedule slip; a second late schedule waits for the next free agent.
2. Cards are taken in this order: scheduled cards first (the runs of interests and an on-demand "Research this" count as scheduled), then an agent's own rework, then the **project rank** (the project higher on the Projects page first; a focus project of the agent is a soft preference ahead of the rank), then the card's own priority, its age and its dependencies. Interests are not ranked: their scans run on their own schedule, and their budgets and the quiet cap bound how much they take.
3. A card that becomes more important waits only for the current shift to end; a claim is never preempted mid-shift.

## Expanding the organization

Each organization can grow beyond the built-in roles and workflows by designing new ones with the BA; the built-in roles and the Code, Research and Feed workflows can never be removed.

**Roles** are definitions in the user's role catalogue. A custom role has a name, purpose, instructions, permissions, tools and skills, default model, seniority levels, and which workflow stages it may claim. Once defined, it appears on the HR board's Hire form like any built-in role. Built-in roles ship with the app as versioned defaults. Only the organization's Owner and Admins can extend them (the DevOps engineer excepted: it cannot be extended) with extra instructions, skills and standing orders, and their core rules, such as test ownership and review gates, cannot be changed. When an app update ships a new default version, the owner sees it on the HR board and can reset a built-in role to the new default, which drops their extensions after showing what will be removed.

**Workflows** are pipelines of stages. Each stage names the role that claims it, the card fields required to enter it, what counts as done, and where failures route. A project's type is now its workflow, built-in or custom.

**Departments** group roles and workflows that serve one function, for example Support triage or Marketing alongside Engineering and Research, so a user's organization can grow into several functions. The HR board and board views can be filtered by department.

**Designing with the BA**

1. The manager describes the need to the BA, in intake or on the desk
2. The BA drafts the role or workflow definition and asks questions where it is unclear
3. The definition is validated: every stage has a role that can claim it, every failure path ends somewhere, no stage is unreachable
4. It lands on the desk for approval, and only then becomes available

Definitions are versioned and stored as provider-neutral files in the user's vault, with a copy registered on the site so the dispatcher can route by them. Changing a workflow never changes cards already in flight; they finish on the version they started with.

Custom roles and workflows belong to the user's own organization. A shared project runs inside its owner's organization: invited members join it as additional engineering managers for that project only. They see its board and desk, answer its desk items, and hire agents for it from the owner's role catalogue onto their own workstations, under their own provider accounts. The owner's workflows, roles and standing orders apply to every card in the project. On the project's HR board, the owner can hire, change and fire any agent; an additional manager can hire, change and fire only agents they hired themselves, and cannot change the owner's role catalogue or anyone else's agents. Outside that project, each member's own organization is unchanged and stays private.

Every agent hired for a shared project serves the whole organization for that project: any manager can direct or message it, and it can claim any card in the project. Only HR actions are limited to the hiring manager and the owner.

**Removing a member**: when the owner drops a manager from a project, the owner inherits every agent that manager hired for it. Because those agents ran on the departed manager's workstation and provider account, they are re-homed: the owner picks one of their own workstations and providers, the old sandbox stays behind and is treated as wiped, and the agent's name, track record and history carry over. Cards the agents held are released to the queue with their last handoff until re-homing is done. Cards the departed manager imported transfer to the owner, who takes over their desk items and posts their outbound updates with the owner's own access.

## Users, workstations and administration

The app is a hosted website; code, credentials and agent sessions stay on each user's own workstation, which connects out to the site.

- **Organizations.** Every user belongs to an organization (the platform administrator excepted). An organization owns its projects, agents, catalogue, desk, ledger, vaults, schedules and interests. A user may belong to several organizations and works in one per browser tab, chosen with the organization switcher. Details: `docs/design/organizations.md`.
- **Roles.** Within an organization a user is its **Owner** (exactly one; transferable), an **Admin** or a **Member**. A **Guest** is not a member but has access to specific projects of the organization, and sees nothing at organization level. Only the Owner and Admins create projects and add or remove people; no setting changes that. The Owner alone appoints Admins, changes roles, requires two-factor login and hands over ownership.
- **Users** log in with email and password, optionally with a second factor. Every organization is sandboxed: members see and act on only their organization's data (and, for Members, only the projects they were added to), never another organization's. Guest access to a project is the one exception, described below.
- **Forgot password.** The sign-in page offers a reset by email: the answer is the same whether or not the email has an account, the emailed link works once for an hour, and setting the new password signs the account out everywhere without signing it in, so a second factor is still asked at the next sign-in. A platform administrator can send the same link to any account, other platform administrators included, from Accounts (recorded in the audit log). Platform accounts may use "Forgot password" themselves; their two-factor code is still asked at the next sign-in. An organization Owner can also reset a member's password to a temporary one (shown once, passed on by hand): the member's sessions end and at next sign-in they must choose their own password before anything else (`must_change_password`), two-factor still applies, and the account is global, so the change applies in every organization the member belongs to.
- **Two-factor login (TOTP).** Any user can set up an authenticator app and receives recovery codes. It is **required** for the platform administrator, and the Owner can **require it for the organization**; a member without it is held at the setup screen. The Owner (or platform administrator) can reset a member's second factor.
- **Invitations.** There are three kinds. (1) *New organization*: the platform administrator invites an email to start an organization on a plan and becomes its Owner on accepting. (2) *Member*: the Owner or an Admin invites an email into the organization as Member (or, by the Owner, Admin), optionally with the projects to start on; a new person sets a name and password, an existing account signs in and confirms. (3) *Guest*: a project is shared with an existing account that already belongs to an organization; there are no guests without an organization, so someone with no account is invited as a Member or via a new-organization invitation instead. Invitations are single-use and expiring and can be resent or revoked.
- **Platform administrator (super admin).** One or more accounts created only by the server's command line. They belong to no organization and see organization metadata, never its work: organizations (Owner, plan, status, usage, limits, features), new-organization invitations, accounts (deactivate, reset two-factor) and an **audit log kept forever**. They can suspend, reactivate or cancel an organization and transfer its ownership to an existing Admin with a written reason; everything they do is audited.
- **Licensing.** Each organization has a plan, status (`trial`, `active`, `suspended`, `cancelled`), dates, feature switches and four limits (members, workstations, agents, projects). Invited organizations are on the free **Founding** plan (every feature, no limits) until the Owner subscribes; see **Billing** below. Guests and the DevOps engineer never count against a limit. A suspended organization finishes its running shifts, starts nothing new and lets only its Owner sign in, with read access plus organization settings and members.
- **Workstations**: each user links one or more workstations, for example a Windows machine, by installing the runner and pairing it with a one-time code from their settings. A workstation belongs to the user and may serve every organization the user belongs to. The runner connects outbound over WebSocket, so no inbound ports are opened, and reports which repos, vaults and agent runtimes it holds. Users can rename or unlink their workstations.
- **Agents** are hired onto a workstation and run there under that user's own account with the agent provider they choose: Claude is the baseline, but a user may drive their agents with OpenAI, Grok or another provider. The dispatcher gives an agent only its organization's cards, for projects whose repo is on that workstation. There is one built-in **DevOps engineer** per organization per workstation; it is free and therefore **cannot be extended** (no extra instructions, skills, tools, standing orders or custom permissions, no custom role, no workflow stages): only its model and effort change.
- **Projects** can span several repositories. The Owner or an Admin shares a project by inviting a guest; the invitee must already belong to an organization, and accepting makes them a guest engineering manager of that project only. Members of the organization are added to projects directly. A project's cards appear on every manager's board, and any agent in the project can claim any card and run it on its own workstation. Each card has a decision policy: by default only the card's owner answers its desk items and decisions, which still show on every manager's desk; the owner can open a card so any manager may answer. Outbound updates stay with the card's owner, who imported the ticket and posts with their own access.
- **Vaults** are git repositories that the DevOps engineer clones onto each workstation. There are no personal vaults: the **organization vault** (organization knowledge) syncs to the Owner's and Admins' workstations only, and a **project vault** is shared with the members and guests of that project.
- **Offline workstations**: if a runner disconnects mid-shift, its cards wait one hour, then return to their owner's queue with the last handoff attached.
- **What the site holds**: users, organizations, and each organization's cards, events, threads, handoffs and desk items, scoped to that organization (and, for Members and guests, to their projects). It never holds repo credentials, agent provider credentials or vault content.

## Billing

Billing (gateway: Paystack, with PayFast as a fallback; owner decisions of 2026-10-10, "Payment decision") turns the plan fields into a paid subscription.

- **Plans.** A catalogue the super admin edits (USD prices, limits on members, workstations and projects; **no agent limits**; the same features everywhere): Starter $19 (2/1/3), Team $49 (5/3/10), Business $149 (20/10/unlimited). **Unlimited** is assigned only by the super admin: no billing cycle, no limits. A subscription keeps the price it started at.
- **Business add-ons.** Extra members, workstations and projects at super-admin prices (placeholders $5, $10, $2). They apply from the next billing cycle and never go below the Business base.
- **Sign-up.** Self-service, with a verified email (sign-in is refused until then) and a card: a 7-day trial, the first invoice at the trial end, then monthly. Until a card is saved the new organization is paused. Invited organizations stay free until the Owner subscribes or the super admin assigns Unlimited.
- **Currency.** Prices are USD everywhere (pricing page, sign-up, Billing page, invoices): "$49.00 / month, VAT included". Each charge converts the fixed USD amount to ZAR at that day's exchange rate (pluggable source, cached per day, super-admin override) and charges the rand amount; the invoice lists the USD amount as the billed price and "charged as R x at R y / USD on <date>".
- **VAT included.** The company is VAT-registered: prices are VAT-inclusive. VAT at a configurable rate (setting, default 15%) is computed out of the inclusive price (`gross x p / (100 + p)`) and shown on every invoice, local or foreign, in USD and in ZAR ("Includes 15% VAT: $6.39 (R117.28)"). Proration amounts follow the same rule. If the accountant later confirms zero-rating for foreign customers, that is a setting change.
- **Business customers only.** Sign-up requires a company name. The Owner keeps a billing profile (company name, address, country, optional VAT number) in the Billing tab; it is printed on invoices, and a paid invoice keeps the details it was issued with.
- **Tax invoice.** Every invoice has a printable HTML page ("Tax invoice", sequential number, date, supplier name, address and VAT number from platform settings, customer details, line items, VAT in rand). The exact SARS tax-invoice format must be confirmed by the accountant. The supplier name (Example Company (Pty) Ltd, trading as Guildwise HQ) appears only on invoices and the legal pages.
- **Plan changes** are prorated for the rest of the period: a charge now, or a credit on the next invoice. A plan too small for current usage is refused.
- **Cancellation.** Active until the end of the paid term, then paused.
- **Pause.** An organization paused for billing is `suspended` with the reason `billing:setup`, `billing:payment_failed`, `billing:cancelled` or `billing:admin`: only the Owner signs in, a banner links to the Billing page, nothing is dispatched.
- **Failed payments.** Three attempts (day 0, +1, +3), an Owner mail each time, then the pause. Card-expiry notices and a trial-ending reminder are mailed once each.
- **Payment provider.** A `PaymentProvider` interface with **Paystack** (hosted checkout for the card, `charge_authorization` for merchant-initiated charges, signed webhooks; chosen by `AOM_PAYMENT_PROVIDER`), PayFast as a fallback (tokenised card, ad hoc charges, ITN webhook) and a `fake` provider when no keys are set (local and UAT). Only a token, the brand, the last four digits and the expiry are stored. Updating the card runs the same flow and the new authorization replaces the old one.
- **UI.** Owner: Organization > Billing (plan, card, billing profile, invoices with a printable tax invoice). Super admin: Platform > Billing (provider status and sandbox/live mode, catalogue, VAT rate, invoice details, exchange-rate override) and a Billing panel on each organization (pause, unpause, assign Unlimited), all audited.

## Card lifecycle

A card moves forward only by events, and every failure loops back to the builder as new work rather than holding anyone up.

&#91;embedded content: card lifecycle · 6 stages, 2 loops back to build\]

Builders never wait: after handing off to review they claim their next card, and bounced work returns as Rework or a linked bug card. A card blocked on a question sits in Blocked until the answer arrives.

## Card schema

A card cannot enter To do until every required field is filled; the card is the complete prompt a fresh builder session starts from.

| Field | Required | Filled by |
| --- | --- | --- |
| Title and type (feature, bug, support, refactor, docs) | Yes | BA |
| External reference (e.g. Jira key) | If any | BA |
| Context: why this exists, current behaviour | Yes | BA |
| Requirements | Yes | BA |
| Acceptance criteria | Yes | BA |
| Affected areas: files, modules, findings from investigation | Yes | BA |
| Constraints and linked ledger entries | Yes | BA |
| Test plan | Yes | BA |
| Completion action: PR, push branch, or merge to working branch | Yes | BA, at intake |
| Risk tier: small or large | Yes | Computed from diff, BA may override |
| Dependencies (blocking cards) | If any | BA |
| Decision policy on shared projects: owner only (default) or any manager; repo, base branch, worktree path, branch name | Yes | Dispatcher on claim |
| Assignee history | Auto | System |
| Handoff notes per stage | Yes, per transition | Agent leaving the stage |
| Thread: comments, questions, evidence | Auto | Everyone |

## Decision desk and requirements ledger

Every item needing the manager lands on one page, modelled on the work decision desk, and every answer is written to the ledger so it is never asked twice.

Each desk item shows:

- Who is asking (agent name, role) and which card
- What they were doing when the question came up
- The question, options, and a recommended default
- Blocking or non-blocking, and how many cards it affects
- Item kind: question, approval (outbound update, large-risk merge), or escalation

Alerts are in-app only: urgent items such as blockers and tester bottlenecks are pinned to the top of the desk with a badge, with no email or push notifications.

**Chat**: a Chat button on the decision desk opens an in-app conversation with the BA, the DevOps engineer, or any agent the manager may direct. It is how intake, DevOps requests and ad-hoc instructions happen, from any browser including a phone. Messages stream through the runner on the agent's workstation; if that workstation is offline, the chat says so and nothing is queued silently. Every conversation is saved to a thread, linked to any card or request it creates.

Answering an item emits an event, unblocks every card waiting on it, and writes a ledger entry.

The ledger has three scopes:

1. **Feature spec**: requirements and decisions attached to an epic or card
2. **Project decision log**: ADR-style entries per repo
3. **Standing orders**: conventions, preferences and never-do rules every agent loads at the start of a shift

Rules: an agent must search the ledger before raising a question, and the BA deduplicates incoming questions against it. The manager can also add requirements and standing orders directly on the desk without a question prompting it.

## Knowledge vault

Knowledge lives in git repos of markdown, separate from the event store: the store holds state, the vault holds what agents and the manager know. Vaults are Obsidian-compatible so the manager can browse and edit them directly. Each vault is a git repository. The DevOps engineer clones it onto every workstation that needs it, pulls updates on a regular interval, and commits and pushes local changes on a regular interval. A sync conflict it cannot resolve goes to the desk.

There is one **organization vault** (the organization's knowledge, on the Owner's and Admins' workstations only) and, optionally, a **project vault** per project (shared with the project's members and guests). An agent on a card can read only the vault of that card's project (its project vault, or the organization vault when the project has none and the shift runs on an Owner's or Admin's workstation). Interests live in the organization vault under `interests/<slug>/`. Knowledge never crosses organizations.

Layout per vault:

- `standing-orders.md`: global rules every agent loads
- `projects/<name>/PROJECT.md`: the CLAUDE.md equivalent (context, repos, rules, pointers to repo-local docs)
- `projects/<name>/decisions/`: ledger entries, one ADR-style file each
- `projects/<name>/standing-orders.md`: project rules
- `projects/<name>/<sub-category>/`: research output, e.g. `shooting/reloading/`
- `projects/<name>/taste.md`: feed preferences and examples (see Research and feeds)

Repo-local documentation stays in the repo as the source of truth; `PROJECT.md` points to it and agents load both. Answering a desk item writes the event to the store and the resulting decision file to the vault.

## Agent communication and escalation

Agents talk through messages on a card's thread, never through side channels, so every conversation stays readable on the board.

Escalation chain for a question:

1. Search the ledger
2. Ask the senior in the same role, or the agent that last held the card
3. Ask the BA/architect
4. BA raises it on the decision desk

A blocked agent files its question, parks the card in Blocked, and claims its next card instead of waiting. Reviewer and tester comments addressed to the builder travel on the same thread and are attached to the Rework or bug card they produce.

## Worktrees, testing, review and integration

Untested code stays quarantined in its card's worktree until it passes review and test; only then does it reach the working branch.

**Worktrees**

- One worktree and branch per card, created on first claim and recorded on the card
- Builder, reviewer and tester all work in that worktree at different times
- New cards branch from the working branch, never from another card's untested branch, unless the BA marks a dependency
- Worktree is removed after finalization

**Claim priority for builders**

1. Rework and bug cards they originally built
2. Any other Rework or bug card
3. New To do cards, respecting dependencies

**Review tiers**

| Tier | Trigger | Review |
| --- | --- | --- |
| Small | Under 200 changed lines, no architectural areas touched | One senior reviewer; manager reviews |
| Large | Large diff, refactor, or flagged areas | Two independent senior reviewers; manager spot-checks |

**Testing** runs asynchronously in isolation against the card's test plan. A pass carries evidence: what ran and its output. Suites run on the workstation that holds the card, against shared services, with one Couchbase bucket or scope per worktree, and heavy builds such as MAUI queue one at a time. A failure files a bug card linked to the parent and routed to the original builder.

**Staleness**: before test and again before finalize, the worktree is rebased on the working branch. A conflict becomes a Rework card. DevOps tries to resolve it first, on a temporary branch with the build and tests run, and the attempt is always visible: a note on the card's thread, a notice on the desk, and the request in the DevOps thread. The card waits for the attempt, then goes to Rework so review and test run again. After two attempts that did not hold, the conflict goes to the desk. (This replaces the earlier rule "no agent resolves conflicts silently": agents may resolve conflicts, never silently.) A builder may also run `git rebase` in its own worktree to reconcile its branch.

**Finalize**: the BA executes the card's completion action (PR, push branch, or merge to working branch) and re-runs the suite after any merge. Small-tier cards merge to the working branch without the manager; large-tier merges wait for the manager's approval on the desk, unless the project owner has turned on the per-project setting "Merge large changes without my approval" (default off; owner only; recorded with who and when). The completion action is set at intake and the BA may revise it before finalize.

## Testing strategy

Each role tests at its own level and may change only the tests it owns: builders own unit tests for their work, testers own E2E tests.

| Level | Who | When | On failure |
| --- | --- | --- | --- |
| Unit | Builder | Before handoff: project builds, all unit tests pass | Builder fixes its own work |
| Feature E2E | Tester | After review approval, on the card branch | Rework to the original builder |
| Full E2E suite | Dedicated tester, spawned automatically | After the BA's completion action | Tester triages, see below |
| Regression | Testers, via a regression card | On demand or scheduled by the manager, per platform: web, mobile or both | Bug cards, manager notified |

**Builder rules**: write unit tests for the card's work and run the full unit suite before handoff. Never modify unit tests outside the card's scope to make the work pass; a broken test means the work gets fixed. No E2E testing. The reviewer checks this, and any out-of-scope test change is an automatic bounce tagged as a quality cause.

**Tester rules**: write Playwright tests for new features, run them, and commit them to the card branch. Testers change E2E tests only, never application code or unit tests.

**Test environment**: before a tester actions a card, its adapter checks that the application is deployed and running on the workstation. If it is not, the tester asks the user's DevOps engineer to set it up. Docker is required; if it is missing and the DevOps engineer cannot install it, the card is a hard stop and goes to the desk as a blocker.

**After finalize**: a dedicated tester spawns and runs the full E2E suite on the resulting branch. Test-side causes (flaky test, data reset, environment) are fixed by the tester on that branch. A genuine bug goes to the BA, who files a new bug card. These failures and regression bugs notify the manager, who prioritises the fix or leaves it in the queue; they do not block merges, pushes or client releases unless the manager says so.

**Regression**: the manager starts a regression run per platform from the board, or schedules one. The BA creates a regression card and testers claim it.

**Tester bottleneck**: full suites and regression can hold testers for hours. When E2E work is waiting and every tester is busy, the manager is alerted on the desk immediately with a recommendation to hire more testers, applied with one click from the HR board.

## Research and feeds

Research projects and interests (the feeds) run on the same board and desk as code; what changes is the pipeline and what "done" means: a fact-checked note in the vault, or a digest the manager rates. A feed is an **interest**: there are no feed projects (the project behind an interest is hidden) and no feed schedules.

**Research cards** carry a question, scope, depth, and the sub-category they belong to. A researcher gathers and writes, a checker verifies claims against the sources (for a video or podcast source, against its transcript, saved in the same `transcripts/` folder and linked from the note), and the result is published to the project's vault folder with citations. Open questions go to the desk like any other.

**Research is a stage, and projects convert.** A research card can be created in any project: the card type picks the research workflow, whatever workflow the project runs, and the board shows the research columns next to the project's own while such cards are open. A project that is only researching (the research workflow) has no repositories. When the questions are answered, the organization's Owner or an Admin converts it to a delivery project (usually Code, or any custom workflow; any workflow converts to any other): they add or request the repositories (a new GitHub repository goes through the same desk approval as `aom repo create`), choose for each open card the new workflow cannot place whether it is kept or cancelled ("Project converted"), and the published notes are listed in `PROJECT.md` of the project's vault folder so every agent reads them. The project remembers that it started as research and keeps a Research tab (notes, citations, transcripts). The DevOps engineer asks which branch is the working branch of each repository the conversion added.

**Feeds** are the runs of an interest: it searches the last 24 hours on its run schedule (daily by default), or when the manager presses Run now. Each run emits a card; a scout collects candidates and a curator picks the best and appends them to the interest's running list. What reaches the manager follows the interest's delivery schedule (below).

**Feed and research rules**

- Searches are general for the topic; a card may list preferred sites, searched first, and otherwise the agent chooses where to look
- Each interest sets one maximum number of items per run (default 10) and the kinds it wants; the curator ranks everything across the wanted kinds (article, video, podcast) and logs the best N overall, and fewer is fine. Older cards that set a maximum per kind are read as the sum of their values
- A feed card has a short topic label and an optional description (markdown) saying in detail what the manager wants; the agents treat the description as the primary statement of intent
- Videos and podcasts come with a transcript: the scout fetches it (`aom transcript`, run by the runner), it is saved in the vault under `interests/<slug>/transcripts/` and shown on the site, and the curator writes the summary from it. When there is none the item says so; text is never invented
- Results append to the project's running list, ordered oldest to newest; a new run never drops, rewrites or reorders earlier entries
- No duplicates: a candidate is skipped if its URL is on the seen-list or it is the same story already listed from another source
- No fabrication: every logged item is a real page the agent opened during the run, with title, source, date and a summary written from that page; if nothing qualifies, the run logs nothing and says so on the card

**Feedback loop**

- Every digest item gets a quick verdict on the desk: useful, irrelevant, or boring, with an optional reason
- Verdicts are written to the interest's `taste.md` as explicit rules and examples, never an opaque score, so the manager can read and correct them
- Curators read `taste.md` before filtering and keep a seen-list by URL so nothing repeats
- A curator may propose a new taste rule from a pattern of verdicts; it lands on the desk as an approval item
- The manager can also write **explicit taste rules**, built into each interest, on its Taste tab. They are kept on the site, mirrored into `taste.md` as a managed block above the rating lines, and put in front of the curator in its brief; they come first and win when a rating line disagrees. The same role rule as the interest decides who may change them

**Interests**

- An **interest** is an organization-level statement of a topic: a name, a description, a sub-category, preferred sites, the kinds it wants (article, video, podcast), a **maximum total number of items** per run across the kinds, an active/paused tick, and its taste rules. Each interest is backed by a **hidden project** (`kind interest`) that carries its feed and research cards, its seen-list, transcripts and vault folder `interests/<slug>/`; the project never appears in project lists, pickers, the board switcher, the Research tab or the metrics
- **Run schedule and delivery schedule are separate.** The run schedule (cron or presets, time-zone aware, or manual only) says when scans happen. The **delivery schedule** says when results reach the manager: new items are held and delivered as one digest at the chosen times (for example weekdays 07:00), with nothing pushed in between, or as soon as a run finishes. An organization-level **quiet cap** limits the digest items that reach the desk per day (the last 24 hours) across all interests; items over it stay held for the next delivery. Delivery is what lands on the desk and in the floor report (an **Interests highlights** section, a count line, and the failing interests under Failures) and what the interests e-mail digest lists
- The manager may assign a preferred scout, curator, researcher and fact checker. It is a **soft preference only**: there is no claim window, and any qualified, allowed agent takes a run at once; an agent restricted to some projects still works an interest it is assigned to
- A **run log** records every scan and research run: its trigger, status, how many items it found, published and dropped, and its card, with the ratings, transcripts and shift logs joined when read
- **Research is on demand only**: "Research this" on an interest or on one of its items starts a research run; notes are published under `notes/` of the interest's folder
- **Role rule**: any active member of the interest's project sees it. Editing, deleting, pausing, running and changing its taste rules need a role in the organization at or above the creator's (Owner, then Admin, then Member, then Guest; the creator's current role counts, the stored one if they left). A guest may create any interest, private to them unless shared; the Owner and Admins share it
- Feed schedules no longer exist. A one-off migration (`restructure-2026-10`) turns every feed project into the backing project of its first interest, and its other interests and unadopted feed schedules into interests of their own, copying the seen-list, transcripts, members and taste rules

## External systems boundary

Company systems such as Jira are clients of the organization, not part of it: intake is read-only and every outbound write needs the manager's approval.

- **Inbound**: the BA reads the external ticket during intake (via the Jira skill or a GitHub/support adapter) and stores its key on the card. Nothing writes back automatically.
- **Outbound outbox**: when work finishes, the BA drafts the external update (comment, design decision, resolution) from the outcome and ledger. It lands on the decision desk as an approval item: approve, edit, or reject. Only approved drafts are posted.
- **Internal stays internal**: agent names, review comments, bounce history and question threads never leave the board. Outbound drafts are written in the manager's voice.

Each external system is an adapter with two operations, read source and post approved draft, so new sources plug in without touching the core.

## Event catalogue

State changes only through events; the board, desk and dashboard are projections of the event log.

| Event | Emitted by | Effect |
| --- | --- | --- |
| `IntakeStarted` | Manager | BA session opens with external ticket context |
| `TicketMapped` | BA | Card assigned to a project; unmapped tickets become a desk question |
| `CardSpecified` | BA | Card validated against schema, moved to To do |
| `ScheduleFired` | Scheduler | Card emitted for a recurring task, jumps the queue for its role |
| `ProjectBudgetSet`, `ProjectBudgetThresholdReached`, `ProjectBudgetOverridden`, `OrgCostSettingsChanged` | Owner or Admin, system | Monthly budget, its 80% / 100% thresholds (once per month), the override for the month, the organization's currency |
| `CardClaimed` | Dispatcher | Exclusive claim taken (fails if already held), agent assigned, worktree created or reused, shift started |
| `QuestionRaised` | Any agent | Card to Blocked, routed up the escalation chain |
| `QuestionAnswered` | Senior, BA or manager | Decision written to the vault, waiting cards unblocked |
| `HandoffWritten` | Agent leaving a stage | Note attached, card moved to next column |
| `ReviewRequested` | Builder | Card to Review |
| `ChangesRequested` | Reviewer | Card to Rework, comments attached |
| `ReviewApproved` | Reviewer | Card to Test |
| `TestPassed` | Tester | Evidence attached, card to Finalize |
| `TestFailed` | Tester | Bug card created and linked, routed to original builder |
| `RebaseConflict` | System | Card to Rework |
| `CardFinalized` | BA | Completion action executed, worktree removed |
| `ResearchPublished` | Checker | Verified note written to the project's vault folder |
| `DigestPosted` | Curator | Digest items appear on the desk for rating |
| `ItemRated` | Manager | Verdict recorded, seen-list and `taste.md` updated |
| `OutboundDrafted` | BA | Approval item on decision desk |
| `OutboundApproved` | Manager | Adapter posts to external system |
| `AgentHired` / `AgentRetired` | Manager | Profile created; or retired, sandbox wiped and claimed cards requeued |
| `ShiftEnded` | Runner | Duration, tokens and outcome recorded to track record |

Testing events:

| Event | Emitted by | Effect |
| --- | --- | --- |
| `FullSuiteStarted` | System, after `CardFinalized` | Dedicated tester spawned on the resulting branch |
| `FullSuiteFailed` | Tester | Tester triages: fixes test-side causes or reports a bug |
| `BugReported` | Tester | BA files a bug card; manager notified, nothing blocked |
| `RegressionRequested` | Manager or scheduler | BA creates a regression card for web, mobile or both |
| `TesterBottleneck` | System | Desk alert recommending more testers |

DevOps events:

| Event | Emitted by | Effect |
| --- | --- | --- |
| `DevOpsRequested` | Any agent or manager | Request queued for that user's DevOps engineer, thread opened |
| `EnvironmentChanged` | DevOps engineer | Setup or change on the workstation logged with what was done |
| `DevOpsApprovalNeeded` | DevOps engineer | Destructive or out-of-access action waits on the desk |
| `RepoCloneRequested` / `RepoCloneReported` | Manager adds a repository / DevOps engineer | A repository is being cloned (or created) onto a workstation; the result (cloned, created, failed with a reason, needs the manager) shows in project settings |
| `EnvironmentPrepareRequested` / `EnvironmentPrepared` | System / DevOps engineer | The project's toolchain on a workstation is checked and installed; build and test cards wait there until it is ready |
| `DevOpsRightsVerified` | DevOps engineer | The rights the manager ticked were checked on the machine (verified or failed with the fix) |
| `DevOpsSudoPasswordSet` / `DevOpsSudoPasswordCleared` | Manager | A sudo password was sent (encrypted for the runner) or forgotten; the password itself is never in an event |
| `ProjectShared` | Project owner | Existing user added as a project member |

## Architecture

A hosted Node service with Postgres at the centre, plus a runner on each user's workstation; nothing talks to anything else except through events.

&#91;embedded content: architecture · 6 components around one event store\]

The dispatcher reacts to events and assigns cards; the runner on the agent's workstation starts a session through the agent's runtime adapter (headless Claude Code as the baseline) in the card's worktree and records its outcome when the shift ends.

**One claim per card**: a card can be held by only one agent at a time, across all users and workstations. Claiming is a single atomic Postgres operation (a conditional update, or `SELECT … FOR UPDATE SKIP LOCKED` on the queue), so two agents racing for the same card cannot both win; the loser simply takes the next card. The claim is a lease kept alive by the runner's heartbeat and released when the agent hands off, is fired or reset, or its workstation stays offline past the one-hour timeout.

| Component | v1 choice |
| --- | --- |
| Runtime | Node, TypeScript |
| Event store and projections | Postgres: append-only events table plus projections, LISTEN/NOTIFY for subscriptions |
| UI | Hosted web app with email and password login, over WebSocket and REST |
| Agent runtime | Pluggable runtime adapters: Claude Code or the Claude Agent SDK as baseline, other providers' coding agents through the same contract |
| Git | `git worktree` per card, one branch per card |

**Runtime adapter contract**: every agent runtime is wrapped by an adapter on the runner with the same operations, so the dispatcher, board and HR board never know which provider did the work.

- `start(card prompt, worktree, permissions, instructions)` starts a session
- `events()` streams progress, questions and the handoff back as standard events
- `stop()` ends the shift
- `usage()` reports tokens for the HR board
- `capabilities` declares what the runtime supports (skills, MCP tools, sandbox config), so the dispatcher can avoid giving a card to a runtime that lacks a tool it needs

Standing orders, `PROJECT.md` and skills are kept provider-neutral in the vault; the adapter writes them into whatever instruction file its runtime reads (for example `CLAUDE.md` or `AGENTS.md`). Model recommendations on the HR board stay within the providers that user has linked.

Core entities: User, Invitation, Workstation, Project membership, Agent, Card, Event, Thread message, Desk item, Ledger entry, Worktree, Shift.

Two further components sit beside the core: a scheduler that emits `ScheduleFired` events for recurring tasks, and the knowledge vaults (git repos of markdown) that sessions read at shift start and write decisions and research to.

**Event store choice**: Postgres from the start, to support multiple users and workstations: an append-only events table, projections for the board, desk and HR board, and LISTEN/NOTIFY to push events to browsers and runners. A dedicated store such as KurrentDB (formerly EventStoreDB) adds a server for features this volume doesn't need. The store sits behind a small interface (`append`, `read(stream)`, `subscribe`) so it can move to Kurrent later without touching the rest.

**Deployment**: one VPS running the app and Postgres with Docker Compose.

## Manager dashboard

Three views make up the manager's day: the board, the decision desk, and a team view that says when to hire, fire or change a role's model.

- **Board**: columns per lifecycle stage, each card showing assignee, age, risk tier and blocked state
- **Decision desk**: open questions and approvals, sorted by blocking count then age
- **Team view**: the HR board, described below
- **Org chart**: roles, seniority, escalation and reporting lines, described below
- **Costs**: what the agents cost, by project, agent, model and day, and per-project monthly budgets (Owner and Admin), described below

Metrics:

- Throughput: cards finalized per day
- Time blocked on the manager
- Bounce rate per builder (review and test)
- Bugs escaped past test
- Duration per card and per agent
- Queue depth per column

## HR board

The HR board is where agents are hired, tuned and fired: one card per agent, with the stats and recommendations that say whether it is earning its model.

&#91;embedded content: HR board · one agent card, illustrative numbers\]

**Agent card**: avatar (generated from the name), name, role, seniority, model and effort, status (idle, on shift, blocked) with the current card, the manager who hired it, what the agent cost this month and in total, and actions to change model, change role or fire. A Hire button opens a form for role, seniority, model, skills and a name, typed or generated.

**Stats** over a rolling window, each shown against the team average for the role:

| Stat | Meaning |
| --- | --- |
| Cards done | Cards the agent moved out of its stage |
| Blocked rate | Share of the agent's cards that raised a question |
| Rework rate | Share of its cards sent back by review |
| Bugs escaped | Share of its cards that later failed test |
| Utilisation | Share of time on shift versus idle |
| Tokens per card | Average tokens used per completed card |

**Recommendations** are rule-based, show the evidence that triggered them, and apply with one click:

- **Blocked**: if its questions were already answered in the ledger, ledger search is failing; if they cluster on one topic, propose a standing order; if they trace back to thin specs, the fix is the BA's spec quality, not the builder.
- **Rework**: group review comments by reason; a recurring reason becomes a proposed standing order. High rework concentrated on large cards suggests a stronger model.
- **Model up**: high rework or bug rate on complex cards.
- **Model down**: low rework and bugs on mostly small cards, where a cheaper model would do the same work with fewer tokens.
- **Split the role**: when cards vary widely in complexity, run a strong-model senior for large cards and a light-model junior for small ones; the dispatcher routes by risk tier.
- **Fire or reassign**: sustained low utilisation in a role with an empty queue.

Idle agents use no tokens, since sessions only exist during shifts; the waste to target is a strong model doing simple work. Failures are attributed to the stage that caused them: a reviewer who bounces everyone or a BA writing thin specs shows up on their own card, and sub-par building shows up on the builder's.

**Work quality** gets its own panel on every builder's card, because a builder can be fast, rarely blocked and still produce poor work.

- **Reviewer quality score**: the reviewer scores each card 1 to 5 against the spec and conventions, with a reason; shown as a rolling average
- **Rework by reason**: each bounce tagged by cause (missed requirement, broke convention, no or weak tests, poor structure, spec unclear); everything except spec unclear counts against the builder
- **Rework rounds per card**: one bounce is normal, three on the same card is a pattern
- **Bugs escaped**: test failures and later regressions traced back to the builder's cards
- **Acceptance criteria missed**: criteria the reviewer or tester found unmet at handoff
- **Test coverage of its changes**: whether the builder wrote or updated tests with the code

The recommendations act on these too: a recurring cause becomes a proposed standing order, low scores on large cards suggest a stronger model, and low scores across all card sizes suggest firing, which also clears any cached context that may be causing the failures, and hiring a fresh profile.

## Costs and budgets

**Cost tracking.** Every shift records the tokens it used (input, output, cache read, cache write) and the model, taken from the runtime's own session output; a shift that is stopped, times out or crashes keeps what it had spent so far. Chats are shifts too. The server prices each ended shift at the **list price of its model family** (a price table in shared configuration, marked as defaults, to be editable by the platform administrator; an unknown model is priced like Sonnet) and stores one cost row per shift with its project (a card's project, a chat's project, a BA task's project; none means **org overhead**). Spend is rolled up per agent, card, phase, project and interest (an interest's hidden backing project carries its cost). Amounts are shown in the organization's currency (USD by default, with a rate for others); costs are estimates, not invoices. The mock runtime reports synthetic usage so the whole path is testable.

**Budgets.** An Owner or Admin sets a **monthly budget** per project (and per interest, which sets it on its backing project). The month is the calendar month in the organization's time zone, so it resets on the 1st. At **80%** the manager gets a desk notice and the BA reporter a budget signal; at **100%** dispatching for that project **pauses**: running shifts finish, nothing new starts (cards, the BA's tasks for the project, interest runs), a banner says so on the board and the project, and a desk item offers **Raise budget** and **Override for this month**. Raising the budget above the spend, or overriding, resumes work at once; the pause is a function of the month's spend, so the 1st lifts it by itself. Spend shows in the project settings and header, the board header, the HR board (per agent), the phase page, the floor report and a **Costs** page (Owner and Admin) with the breakdown and a CSV export.

## Org chart

A page under Organization that draws the organization as a tree: the manager (Owner, with the Admins), the business analysts, then each department with its roles, seniors above juniors. The lines are the escalation chain (a senior of the same role, then the BA, then the manager's desk), and each agent's card names the manager it reports to and, through them, the Owner. Agents show their generated faces, what they are doing in words and their workstation; filters narrow the chart to the agents allowed on a project; clicking an agent opens its allowed projects, focus, spend and recent work. The DevOps engineer of each workstation is shown apart from the tree. It is visible to organization members, responsive (a grouped list on phones) and accessible.

## Blog

Guildwise HQ has a platform-level blog about AI agents and AI automation, run by the super admin (full requirements:
`docs/design/blog-prd.md`; decisions: `docs/design/open-questions-2026-10-09.md`; API: `docs/BLOG-API.md`).

- **Posts** have a slug, title, summary, restricted-Markdown body (no raw HTML), a branded cover per tag, 1 to 5 tags,
  sources, search texts and social captions. The byline is always "The Guildwise HQ team" and every article says it was
  written by an AI agent. Statuses: draft, in review, published, rejected, unpublished (an unpublished address answers 410).
- **Public pages** `/blog`, `/blog/:slug`, `/blog/tag/:tag`, the RSS feed, `sitemap.xml` and `robots.txt` are rendered by the
  server with a cache; the landing header and footer link to the blog. Signed-in people read the same articles under Help > Blog.
- **Agent API** `/api/v1` with super-admin managed Bearer keys: hashed, shown once, scoped (`blog:read`, `blog:write`,
  `blog:publish`, `social:write`), with last-used, an audit, rate limits, idempotent submits and a hard cap of 8 new posts
  per key in 24 hours.
- **Moderation.** The owner reviews each post for the first two weeks (approve, edit or reject with a reason); after that a
  post without content warnings publishes by itself after a 3-hour hold (switch date and hold are settings).
- **Kill switch.** The super admin can switch the blog off: creating (the API answers 503) and publishing (manual, automatic),
  the digest and social posts all stop. Public articles stay readable.
- **The writer agent** runs inside Guildwise: a schedule creates a card for a writer agent, which posts through the API with a key
  held in the workstation's environment (set-up steps and the prompt are in `docs/BLOG-API.md`).
- **Weekly digest** on Mondays at 08:00 Africa/Johannesburg: organization Owners get it unless they opt out, everyone else
  opts in (checkbox at invitation acceptance, Settings); users whose organizations are all suspended are skipped; unsubscribe
  link with a confirm button (the mail program's one-click unsubscribe also works); sent once per week, not at all in a week without new posts.
- **Facebook Page and LinkedIn organization** sharing on publish once a token is configured: encrypted tokens, retries with
  backoff, never twice, a status per post and network, an alert before a token expires. No Buffer or Zapier. Unpublishing does
  not delete the social posts.

## Build plan and open questions

Build the smallest loop that removes terminal juggling first, then let the team build the rest of itself.

1. **Core loop**: Postgres event store, login and invitations, runner pairing for one workstation, card schema, projects, dispatcher with exclusive claims, builders and a reviewer running headless in worktrees, a bare board; first runs capped at two builders and one of each other role
2. **Decision desk, ledger, vaults and DevOps**: questions, answers, standing orders, dedup check, the organization and project vaults, DevOps engineer with vault sync
3. **Tester and bug loop**: unit test rules, Playwright feature E2E, bug cards, rebase step, post-finalize full suite, regression runs, bottleneck alert
4. **Scheduler and feeds**: recurring tasks, scout and curator, digests, ratings and `taste.md`
5. **Research projects**: researcher and checker, publishing to the vault
6. **BA intake**: Jira skill integration, ticket-to-project mapping, investigation, spec validation, completion actions
7. **Outbox and adapters**: gated Jira updates, GitHub issues
8. **HR board and metrics**: track records, hire and fire
9. **Organization designer**: custom roles, workflows and departments drafted with the BA

From phase 2 onward, new work is fed through the tool itself.

Decisions taken and what is still open:

- [x] Risk tiers: small is under 200 changed lines with no architectural areas touched
- [x] Merges: only large-tier merges to the working branch need manager approval; branch name is set per project
- [x] First runs: two builders, one of each other role
- [x] Completion action: set at intake, BA may revise
- [x] Heavy test suites: the card's workstation, app deployed there by DevOps, Docker required
- [x] Technical writer: per card when flagged docs-needed
- [x] Schedules: at most one extra shift at a time
- [x] Feeds: general search per topic with optional preferred sites, daily over the last 24 hours or run on demand, narrowed later through ratings
- [x] Login: email and password, via invitation links
- [x] Isolation: every user is sandboxed except within shared projects they manage
- [x] Shared projects: span several repos, shared by email invite to existing users, who join the owner's organization as additional managers for that project
- [x] Shared project cards: any project agent may claim them; decisions are owner-only by default; outbound updates belong to the card's owner
- [x] Shared project HR: owner manages all agents, others only their own; agents serve the whole project; a removed manager's agents and cards pass to the owner
- [x] DevOps: one dedicated engineer per user, reset rather than fired
- [x] Built-in roles: extended only by the organization's owner, never changed or removed; resettable to the latest app default
- [x] Alerts: in-app desk only
- [x] Offline workstations: cards requeued after one hour
- [x] Hosting: one VPS with Docker Compose
