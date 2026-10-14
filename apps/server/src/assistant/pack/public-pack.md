<product_facts>
## What it is

Guildwise HQ is a management layer for a crew of AI coding agents. You hire agents by role (business analyst, builder, reviewer, tester, architect, DevOps engineer and others), give them work as cards on a board, and answer the questions they cannot decide on one desk. Agents work in parallel, each on its own card. Work passes separate review and test stages before it can finish.

Tagline: "You manage. They work." The landing page also says "Many hands, one master."

## Who it is for

The person who manages the agents: the one who sets the standard, answers the hard questions and signs off the result. It does not replace developers. You need a code repository for the agents to work in, but you do not need to know git: by default cards speak in plain results ("Your change is live on main") and Guildwise HQ takes care of branches. Each person can turn on an expert mode in Settings to see branch names and the git controls. A guided installer sets up a workstation, and a Get started checklist, a guided tour and a three-minute training video walk through the first project.

## How it works

1. Hire your crew: pick roles and seniority, choose which projects each agent may work on.
2. Cards cross the board: work moves through the stages of a workflow (for example spec, build, review, test, done) by itself as agents work.
3. Decide at your desk: questions, approvals and alerts reach one desk with context, options and a recommendation. You answer once and the crew carries on.

## Where the agents run

Guildwise HQ is a hosted service: you sign up on the website and use it in the browser. The agents run on a workstation you choose, one of:

- your own computer (Linux, macOS or Windows; Windows uses WSL2), set up by a guided installer;
- a Linux server you rent (a VPS) that you can log in to over SSH: Guildwise HQ logs in once, installs the runner and pairs it; the password or key is not stored;
- a GitHub Codespace, which pairs itself, stops after 30 minutes without work, wakes when a card is queued and can keep office hours. A Codespace cannot run Docker, so Docker deploys need your own computer or a VPS.

You pay the VPS company or GitHub directly; Guildwise HQ adds no charge for them. Every cloud workstation shows an estimated monthly cost.

Code, secrets and files stay on the workstation and in your own git repositories. The Guildwise HQ server holds the board, the desk, the ledger and the records. A small helper program, the runner, connects each workstation to the server. The agent runtime is Claude Code, using your own Claude subscription or Anthropic API key, so the agents' model usage is billed by Claude to you (for a team, an API key is recommended). You choose the model per agent. Guildwise HQ never receives or stores a Claude key or token.

## Git hosts

Each repository can be on GitHub, GitLab, Bitbucket Cloud, Azure DevOps or a plain git server, and one project can mix them. The login for each host stays on the workstation (a one-line connect command, or the DevOps engineer helps in a chat). Finished work is committed and pushed to the working branch after review and test by default, or arrives as a pull request if the project prefers that or the working branch is protected (a plain git server gets a pushed branch instead of a pull request).

## What you get

- A board with every card and its stage, and a desk for decisions.
- A ledger: every decision is recorded once and given to every agent that asks later, so you are not asked the same thing twice.
- Review and test gates. Risk is assessed from the size of a change and large changes need two reviewers. Each agent works on its own copy of your code, and a change reaches your main code only after review and testing, with the checks you set up.
- Phases: group cards into a milestone; when the last card is done, follow-ups such as deploys or regression runs run in order once you approve them.
- Budgets: a monthly budget per project, a warning at 80 percent and dispatching pauses at 100 percent. Running shifts finish.
- A business analyst agent that turns tickets and ideas into cards, and writes a daily floor report: what is stuck, what was solved, what it cost.
- Intake from Jira and GitHub: the BA maps incoming tickets to projects and drafts cards with specs and test plans. It can look at a Jira ticket's screenshots and design files (downloaded on your workstation with your Jira token, which never leaves it), and cards carry file attachments for builders and testers.
- Outbox: posts to Jira, GitHub or email wait for your approval before they go out.
- Org design: roles, departments and workflows, designed in a chat with the BA and approved by the Owner.
- Standing orders and automations (formerly schedules): recurring instructions and work that starts by itself, on a time or when something happens in a workflow.
- Vaults: knowledge repositories (git) for the organization and per project that sync to your workstations.
- A DevOps engineer agent on every workstation, free: it installs tools and the project's packages, keeps repositories tidy (unsaved edits are kept in a local git stash, never pushed), tries to fix conflicting changes itself, and runs commands, Docker builds and deploys you ask for in a chat. It works as you, outside the sandbox the other agents use; privileged actions on a team member's machine need an Owner or Admin and the machine's user to agree.
- Cards explain themselves on the board: why they are blocked, a repository problem, or a budget that is nearly used up, each with a link to fix it.
- A What's new window after updates, and in-app help with articles, a glossary and a page-by-page help panel.
- Shared projects: invite people as additional managers on a single project.
- Organizations with roles Owner, Admin and Member. Two-factor login with authenticator codes and recovery codes; Owners can require it for everyone.
- An append-only audit trail: state is a log of events that is only appended to, so you can see what happened, in order, and who approved it.

## Security and hosting (say only this)

- Guildwise HQ is a hosted service you sign up for. The agents run on your own workstation, a VPS or a GitHub Codespace, and your code stays in your own repositories.
- Agents talk to the model provider you configure and to your code host. Posts to Jira, GitHub or email leave only after approval in the outbox. Vaults are kept with your own code, on your side; the Guildwise HQ server keeps the board, the desk, the ledger and the audit trail.
- The Privacy policy (`/privacy`) and the Terms and conditions (`/terms`) are on the website.
- There is no SOC 2 or ISO 27001 certification today, and the assistant must not imply one. The product is designed around controls such as approvals, audit logging, role-based access and two-factor login. A customer's own review decides whether it fits.

## Pricing and trial (say only this)

Three plans, per month, in US dollars:

- Starter: $19. Up to 2 members, 1 workstation and 3 projects.
- Team: $49. Up to 5 members, 3 workstations and 10 projects.
- Business: $149. Up to 20 members, 10 workstations and unlimited projects. On Business you can add extra members, workstations and projects as add-ons, priced per unit (the prices are shown on the Billing page); add-on changes start with the next billing cycle, and you cannot go below the Business base.

Every plan has every feature and no limit on agents; plans differ only in members, workstations and projects. Prices include VAT (15%, shown on every invoice). They are shown in US dollars and charged to your card in South African rand at that day's exchange rate, and each invoice shows the dollar price, the VAT and the rand charged. Guildwise HQ is sold to businesses: sign-up asks for a company name, and the Owner keeps a billing profile (company name, address, VAT number) that is printed on a printable tax invoice. Payments go through Paystack; Guildwise HQ never sees or stores the card number.

There is a 7-day free trial: sign up, confirm your email and add a card; nothing is charged until the trial ends, then monthly. You can cancel at any time: the organization stays active until the end of the paid term (or the trial), then it is paused, and nothing more is charged. A plan change takes effect at once and the difference for the rest of the month is charged or credited. The AI usage itself is billed by Claude, and a VPS or Codespace by its provider.

Do not give discounts, custom prices, other currencies' amounts or dates beyond this. For anything else about pricing or a contract, point to the Contact us page (`/contact`).

## How to get access

Click "Start free trial" on the landing page (or a plan's button under Pricing) to sign up at `/signup`. Existing users sign in at `/login`. Questions, a demo or sales go to the Contact us page (`/contact`).

## The blog

The Guildwise HQ blog at `/blog` has practical articles on AI agents and automation, written by an AI agent and reviewed before they go public; the author is always "The Guildwise HQ team". It has an RSS feed at `/blog/rss.xml`, and signed-in users can get a weekly digest by email (Owners get it unless they opt out).

## What the assistant does not do

- It answers only questions about Guildwise HQ. It does not write code, give general advice or chat about other topics.
- It does not compare Guildwise HQ with other products or make claims about them.
- It gives no legal, compliance or security-certification advice and no promises about delivery dates, service levels or custom work. For those it points to the Terms and Privacy pages and to Contact us.
- It cannot see anyone's account, data or tickets, and it does not collect personal details. For account problems, sales or support it points to Contact us.
</product_facts>

<help_outline>
An outline of the in-app help articles, to answer how things work. Do not quote it as a manual.

### Getting started
The training video, signing up or in, the guided tour, the Get started checklist, the sidebar, the command palette and keyboard shortcuts.
- The training video: On the Help page, the Getting started in five steps video is a spoken tutorial of about three minutes. A friendly voice walks you through the five steps while you watch them happen on screen:
- First login: There are two ways in:
- Forgot your password: On the sign-in page click Forgot your password? and type your email. We send a link that works once and expires after an hour. Choose a new password (12 or more characters); you are signed out everywhere else, then sign in with the new one. If you use two-factor login you still enter your code.…
- The tour: The first time you sign in, Guildwise HQ starts a guided tour. Its first step is the getting-started video described above, right in the tour card, with captions and the chapter buttons; press Next: take the tour (or Skip tour) when you are done, and the video pauses.…
- The Get started checklist: Until your organization is set up, the sidebar shows a Get started button with your progress (for example 2/5). Click it for the list:
- The sidebar: The left side of the app is split into areas. Each area groups related pages. From the top:
- Command palette: Press Ctrl K (Windows, Linux) or Cmd K (macOS) anywhere in the app to open the command palette: a search box that finds pages, actions and help topics.
- Keyboard shortcuts: Press ? anywhere (when you are not typing in a field) to see a list of all keyboard shortcuts. A few essential ones:
- What's on this page: Many pages in Guildwise HQ have a What's on this page panel. Open it with the ? button in the top bar (or choose What is on this page in the command palette). The panel lists every control and area of the page and what it does: useful when you first visit a page or need a reminder about a button.
- Privacy and terms: The Privacy policy (/privacy) says what data Guildwise HQ keeps and how it is handled. The Terms and conditions (/terms) cover using the service, the free trial and billing. Both are linked from the footer of the website and from the sign-in, sign-up and invitation pages;…

### Organizations and roles
Four roles, what each can do, members, invitations, guests, temporary passwords, suspension and the platform area.
- Roles: Each role has different permissions. Here is what each can do:
- Switching organizations: You can belong to several organizations. Each browser tab can work in a different organization.
- Members and invitations: To manage people in your organization, open Organization at the bottom of the sidebar, then the Members tab (Members see the list but cannot change it; the Invitations, Guests and Plan & limits tabs are for Owner and Admins, and the Billing tab is for the Owner).
- Guests: Guests are people from other organizations who have access to one or more of your projects. You invite a guest by sharing a project with them. To do this:
- Suspension: A platform administrator can suspend your organization. Running shifts finish and nothing new starts. Scheduled actions are skipped and recorded. A banner at the top explains the suspension.
- Platform area: Platform administrators sign in at the same address but see only the Platform area instead of organizations. They can view and manage all organizations, accounts, invitations, billing, the blog, the audit log and support requests. They never see a specific organization's cards, desk or vaults.…

### Two-factor login
Setting up two-factor authentication, recovery codes, enforcement and owner reset.
- Setting up: To set up two-factor login on your own account:
- Recovery codes: When you turn on two-factor login, you receive ten recovery codes, shown once. Each code can be used once if you lose your phone or cannot access your authenticator app.
- Enforcement: The Owner can require two-factor login for everyone in the organization. This means every Member and Admin must set it up themselves. You need it on your own account first, otherwise the switch refuses.
- Turning off: To turn off two-factor login on your own account:
- Owner reset: If someone loses their phone and recovery codes and cannot sign in, the Owner (or a platform administrator, under Accounts) can reset their two-factor login. Admins cannot. As Owner:

### Projects
Creating projects, the priority order, project types and workflows, research cards, sharing, archiving and decision policy.
- Creating a project: 1. Go to Projects and click New project (Owner and Admin only). 2. Enter a Name and a Key. The key is a short code (2 to 10 characters, letters and digits, starting with a letter, like WEB or DOCS) that labels cards from this project. It is suggested from the name. 3.…
- Architect settings: Under Architect in the project settings the owner decides whether new cards are investigated and designed by an architect before the builder starts (off by default), whether the latest main branch is merged first (on by default), and where the architect's reports go (a folder in the repository, or the knowledge…
- Reference repositories: By default an agent only sees the folder of the card it is working on (and, in a chat about a project, the project's own repositories). To let a project's agents read other code, for example to compare two repositories or look up how a library is used, the project owner adds Reference repositories in the project…
- MCP servers: External tools such as Jira or Confluence reach your agents through MCP servers from the Claude Code plugins installed and enabled on your workstation. Agents do not see your own Claude Code setup, so each server must be handed over deliberately, and two things are needed:
- Workflows of a project: A project has one primary workflow (its type) and can enable more. Open the project's settings, Workflows (organization Owners and Admins can change it; everyone on the project can see it).
- The priority order: Your organization's projects are ranked: the project at the top of the Projects page is the most important. When an agent looks for its next card, it takes work in this order:
- Project types: Code projects are for building: features, bug fixes, refactors and documentation. They have stages like Spec, Build, Review, Test and Finalize. They need repositories and can run test suites and regression tests.
- Sharing a project: To let people from other organizations access a project:
- Archiving: Archive a project you no longer use: open its settings, go to Archive (the Danger zone) and click Archive project. The dialog shows what will stop: running shifts, open cards, schedules and desk items. On archive:
- Decision policy: Each card has its own decision policy, shown on the card page under Who answers its questions. By default only the card owner (the person who created it) can answer questions and approve decisions on it, and others see the desk item read only. To let any manager of the project answer:

### Board and cards
Reading the board and its warning banners, creating and editing cards, moving cards, backing off, risk tiers and search.
- Reading the board: The board shows one column per stage (for a Code project: Spec, To do, Rework, In progress, Blocked, Review, Test, Docs, Finalize and Done). Empty columns fold into a small strip; click one to open it. At the top you can search cards, filter by Blocked, Rework or Unassigned, and filter by priority.…
- Why a card does not move: If a queued card has a warning icon, no agent can pick it up right now. Hover the icon, focus it with the keyboard or click or tap it to see why (Esc closes the explanation):
- Creating a card: To create a card:
- Attachments: A card can carry files: screenshots, a design (SVG, PDF), a specification, a log. Use Attachments, Add files on the New card form, or the Attachments section of an open card, where you can also drag files in. Images show as previews; Download saves a file and Remove deletes it.…
- Editing a card: You can edit a card while it is a draft or queued and unclaimed:
- Moving cards: To move a card to a different stage (for example to fix a stuck card):
- Run a branch: Run this branch (card) or Run branch... (board) has the workstation's DevOps engineer start the project so you can try it; it stops by itself after the time in Project settings > Run and test, or when you click Stop. The first start is worked out by the engineer and saved as a plan;…
- Backing off: When three shifts on the same card end with no report within ten minutes (the agent crashed or timed out), the card shows an amber badge such as "backing off until 14:32 (3 failures)", and a "keeps failing" item lands on your desk. Guildwise HQ waits 1 minute before offering it again;…
- Risk tier: Risk is computed when the builder hands off. A card is large when 200 or more lines changed, when the change touches the project's architectural paths (set in Project settings > Basics as architectural globs), or when it is a refactor; otherwise it is small.…

### Agents
Hiring agents, seniority, runtime and model, allowed projects, focus, firing and the HR board.
- Hiring an agent: To hire an agent:
- Allow-lists: An allow-list is where an agent is allowed to work. For each agent you decide:
- Focus: Focus (a star next to a project in the allow-list) is a soft preference. When a card from a starred project and a card from another project are both waiting, the agent takes the starred one first, even when the other project is higher in your priority order.…
- Seniority: Agents are junior or senior. Some stages are for seniors only: Review needs a senior reviewer and Finalize needs a senior BA. If you hire only juniors for a role that a stage needs, its cards wait (the board shows a red warning with a Hire link).…
- Runtime and model: Every agent runs on a Claude model that you choose when you hire it. The model affects cost and capability.
- Firing an agent: To fire an agent:
- External tools (MCP): Each agent card has an External tools (MCP) section listing the plugin MCP servers (Jira, Confluence, ...) your workstations report, as switches with a plain-language note. Switch one on to let that agent call its tools. Everyone who can see the agent reads the switches;…
- HR board: The HR board is the Agents page. It shows at a glance:

### DevOps and repository hygiene
The DevOps engineer and Ask DevOps, approvals, conflicts, repository hygiene and saved work, the toolchain, the working branch and new repositories.
- The DevOps engineer: You get one DevOps engineer per workstation automatically. It cannot be fired, only reset (which clears its sandbox but keeps it assigned). It does not take cards from the queue.
- When two branches conflict: If a card's branch conflicts with the working branch (before testing or when finishing), or hygiene cannot combine your working branch with its remote, the DevOps engineer tries to fix it first, on a temporary branch, and runs the build and tests before it moves anything.…
- Repository hygiene: Once a day per workstation by default, the DevOps engineer tidies the repositories on that machine. On the Workstations page, open the workstation and find Repository hygiene: Run sets how often (off, every hour, every 6 hours, every 12 hours, daily or weekly) and Run hygiene now starts a run at once.…
- New repositories and the toolchain: When you add a repository in Project settings, Repositories, the DevOps engineer of each workstation of the project puts it there. Pick An existing repository and it is cloned into the workstation's first repository folder (aom-runner repos add); a folder that already holds something else is never overwritten.…
- Fix with DevOps: Next to every item that failed or is missing there is a Fix button: a tool of the Development environment (missing, failed or needs access), a ticked right on the Workstations page that failed Verify now, and a repository under Repositories that failed to clone.…
- Rights and the sudo password: A ticked right is checked on the machine itself. On the Workstations page each ticked right shows verified or failed with the reason and how to fix it (for Docker: add the runner user to the docker group, start the daemon; for sudo: enter the password or allow passwordless sudo). Verify now checks again.
- The working branch: The working branch is where finished work is combined: the repository's default branch (usually main) unless you name another such as develop, which is created from the main branch (where pull requests go; default: the repository's default branch) and pushed when it does not exist.…
- Creating a new repository: Agents cannot create repositories themselves: their sandbox has no login for your git host. You can create one on any host yourself from the project settings (see above). When an agent needs a new repository, it asks, on GitHub, GitLab, Azure DevOps or Bitbucket Cloud:

### The Decision desk
Desk items and kinds, blocking, answering questions, standing orders and adding to the ledger.
- Desk items: Each item shows:
- Blocking: An item is blocking when cards cannot move until you answer it. For example, a large merge waits for your approval, or an agent needs a decision before it can continue.
- Answering a question: To answer a desk item:
- Standing orders: Standing orders are recurring instructions that show up in every agent's shift. Use them for: - Team policies (e.g., "all PRs must have unit tests"). - Context (e.g., "we are migrating from X to Y"). - Decisions that affect multiple cards (e.g., "use the new auth system").
- Adding to the ledger: When you answer a desk question, Add to ledger as decides how it is saved:

### Ledger and vaults
The ledger, searching it, vaults and shared knowledge, vault conflicts.
- Ledger: The ledger keeps three kinds of entry:
- Searching the ledger: To find something in the ledger:
- Vaults: Vaults are git repositories of markdown notes that your DevOps engineers keep in sync on your workstations. By default each workstation syncs every 300 seconds (5 minutes); you can set another interval per vault.
- Which vault an agent reads: Agents only ever read a vault, never write it directly. What they can read depends on the work:
- Shared knowledge: Agents read your vaults during shifts to find shared knowledge. Research interests store their notes in the interest's folder in the organization vault (interests/<name>/) under notes/. Converted projects keep their research notes in PROJECT.md of the project vault.
- Vault conflicts: If a local change conflicts with a remote change, sync of that vault pauses on that workstation. The Vaults page shows a Sync paused: conflict badge with the conflicting files, and a desk item of kind Vault conflict appears.

### Intake and outbox
Intake from Jira and GitHub, unmapped tickets, credentials, the outbox and guardrails.
- Intake: To bring a ticket into Guildwise HQ:
- Unmapped tickets: If a ticket does not match a project (for example it is a support request for a system you do not track):
- Jira attachments: The tool your BA reads Jira with shows the names of a ticket's attachments, but not the screenshots or design files themselves, and agents have no internet. So the BA asks your workstation's runner to download them with your Jira login.…
- Credentials: - Jira: on the workstation run aom-runner jira-connect. It asks for your Jira address, your Atlassian e-mail and an API token (create one at id.atlassian.com, Security, API tokens; for Jira Data Center use a personal access token and no e-mail), checks them and saves the token on that computer only.…
- Outbox: When an agent drafts an update to post back to a ticket (a comment, a status change, etc.), it lands on your desk as an Outbox approval.
- Guardrails: Before posting, your runner checks the text against your organization's agent names and internal terms. A draft that mentions an agent by name, or gives away internal process details (review scores, rework reasons and similar), is refused even if you approved it. The agent can revise and resubmit.

### The architect: investigate and design
The optional design step before build, investigation-only cards, where reports go, the main branch merge, and what the architect may touch.
- Turning it on: 1. Hire an architect (Agents, Hire agent, role Architect). It costs more per shift than a builder. 2. Open the project's settings, Architect, tick Investigate & design before build on new cards and Save. Without an architect the page and your desk warn you: cards would wait in the Design column.
- Investigation-only cards: Tick Investigation only for an answer, not a change (a comparison, "how should we ...", a spike). Nothing is built: the architect writes the report, the BA records the result in the ledger and in the project's PROJECT.md, and the card is done. It needs only a title, context, requirements and a repository.…
- Where the report goes: By default a markdown file in the repository, docs/investigations/<ref>-<title>.md, merged with the card. In the Architect settings you can change the folder or choose the knowledge vault instead (nothing is committed; the card finishes without a merge). A card can name its own Report path, or vault:<path>.…
- Merge the latest main branch first: When a repository has a main branch and a different working branch, the runner merges main into the working branch before work starts (on by default; a project or card can switch it off). If the working branch is protected or changed meanwhile, the card branch takes the merge. A conflict is resolved by the architect;…
- What the architect may touch: - It writes only documentation and its report; the runner checks this after each shift. - It reads the card's repository and every repository of the organization's projects cloned on its workstation, read-only, secret files blocked.…
- Organisation source folder: Open Workstations, expand your workstation and find the row Organisation source folder (only the workstation's owner sees it; it is set per organization, for the one you are working in). The architect may read every repository in the folder, read-only; secret files stay blocked.

### Testing and finalization
The test stage, how finished work lands (working branch or pull request), the main and working branch, expert mode, the full suite and regression runs.
- Test stage: When a card reaches Test, a tester runs the E2E tests from the test plan. If tests pass:
- Finalization: At the Finalize stage, your BA ships the work the way the project says. Every project repository has two branches, named in the project's repository settings:
- Simple mode and expert mode: You do not need to know git to use Guildwise HQ. By default (simple mode) cards and the desk speak in results: *"Goes into the working branch after review and test"*, *"Your change is live on the working branch"*, *"Waiting for you to merge the pull request"*.…
- Manual QA: After a card is finalized it goes to QA (when the project has it on, which is the default): the person who started the card gets a desk item and an agent writes test steps on the card.…
- Full suite and regression: After finalization, a full suite card is created for testers to run the entire E2E suite once. A test-side failure (a flaky test, data or environment) is fixed by the tester; a genuine bug becomes a new bug card and you get a notice. These failures do not block merges.

### Phases and follow-ups
Creating phases, adding cards, when a phase is done, follow-ups, deploy and regression.
- Setting up: To set up what can happen after a phase is done, open the project's settings (the gear on its board) and go to Phases and deploys. There you configure:
- Creating a phase: To create a phase:
- Phase done: A phase is done when:
- The "phase done" desk item: When all cards are done, your BA writes a report and the desk shows a Phase done item titled like "PH-1 Autosave is done: approve 2 follow-ups?".
- What runs after you approve: Once you approve, the follow-ups are locked and run one at a time in order:

### Your BA reporter
What goes through the BA, signals the server watches for, daily floor report and time zone.
- What goes through the BA: With routing on (the default; the Owner and Admins can turn it off in Settings):
- Signals the server watches for: The server checks the floor every minute without using tokens. The BA only works when something fires. Here are the signals it watches:
- Floor report: At 08:00 on your clock, the BA posts one Floor report on your desk (only on days with something to say; urgent notices never wait).
- Time zone and report time: Under Settings, Your time zone sets the clock for your own account (the app takes it from your browser the first time you sign in; until one is set, reports use UTC). The daily floor report follows the Owner's time zone.

### Interests
Topics you watch, who can see them, creating and editing, run and delivery schedules, taste rules.
- Who can see: - Owners and Admins see every interest. - Members and guests see interests they created and ones shared with them by an Owner or Admin. - An interest a Member or guest creates is private to them (and to the Owner and Admins) until an Owner or Admin shares it, with Share with under Who can see it on the interest's…
- Creating and editing: To create an interest:
- Run and delivery schedule: - Run schedule: when the agents scan for new content. A scan can happen on a preset or custom cron schedule, or only when you press Run scan on the interest page. - Delivery: when you get the results on your desk. Either as one digest at set times (e.g., weekdays at 07:00) or as soon as a scan finishes.
- Daily quiet cap: On the Interests page, the Daily quiet cap panel sets the most digest items that may reach your desk in 24 hours across all interests (by default there is no limit; click Change and enter Items per day, 1 to 1000). Items over the cap stay held and arrive with the next delivery that has room.
- Research this: Research is on demand only. Click Research this on an interest or on an item in its digest:
- Taste rules: Besides ratings that grow from your feedback, write explicit rules under Explicit rules on the Taste tab:
- Archiving: Under More actions, Archive stops the interest's runs and hides it. Restore brings it back with a fresh schedule. Delete permanently (archived interests only) removes its cards, items, ratings and run log. The vault folder is never touched.

### Automations and integrations
Creating automations (formerly schedules), triggers and actions, feeds, how scans work, integrations and webhooks.
- Automations: To create an automation:
- Triggers: A trigger is when the automation fires:
- Actions: An action is what happens:
- How a scan works: When an interest runs, a scout agent collects candidates, then a curator picks the best N overall (any mix of articles, videos and podcasts). The server:
- Integrations and webhooks: Automations can integrate with GitHub, Jira, Slack, Microsoft Teams, n8n, Zapier and more.
- History: Click History on an automation to see every run: when, what triggered it, what it did, and the reason if it failed. For webhooks and e-mails, see the Deliveries log with every try, HTTP status and duration.
- E-mail inbox: An inbox is an address that turns incoming mail into cards. The Owner or an Admin makes one under Organization > E-mail inbox; it looks like acme-k3x9p2m7qd@in.guildwisehq.com. Copy gives you the address; New address replaces it (the old one stops working at once, and mail sent to it is shown as skipped).
- Starting a workflow automatically: In the workflow builder, Starts automatically when lists the automations that create cards in that workflow and lets you add one. It opens the same automation form with the workflow already chosen.

### Budgets and costs
Where spend shows, monthly budgets, budget limit handling, override and currency.
- Where spend shows: You can see costs in several places:
- Monthly budgets: An Owner or Admin sets a project's budget in the project's settings under Budget (the Monthly budget panel: type an amount and click Save budget, or Remove budget), or an interest's budget on its Settings tab.
- Override: When a project hits 100% of its budget, a desk item offers:
- Currency: To change how costs appear:

### Organization chart and design
The org chart, custom roles, custom workflows and departments.
- Org chart: Go to Org chart in the sidebar (Organization section) to see:
- Custom roles: Built-in roles (builder, reviewer, tester, technical writer, and the architect that investigates and designs before build) cover most work, but you can create custom ones.
- Custom workflows: The built-in workflows (Code: Spec, Build, Review, Test, Docs, Finalize; Research: Question, Research, Fact check, Publish) cover standard work. To add a custom workflow, use the workflow builder: open the Workflows tab and click New custom workflow (or use Design with the BA).…
- Departments: A department groups the roles and workflows of one function (the built-in ones are Delivery and Research; you can add your own, such as Support or Marketing), so the Agents and Projects pages can be filtered by department. Departments are optional.

### Workstations and the installer
What a workstation is, the Add a workstation wizard, installing by hand, Claude sign-in, Windows and connecting git hosts.
- What is a workstation: A workstation is your own machine: a laptop, desktop or server. It holds your git repositories and is where agents run their work. You can have one workstation or many. Each agent is assigned to one workstation and only that one.
- Add a workstation: First choose where your agents should run: My computer (below), A VPS (SSH) or GitHub Codespaces. The last two are explained in Cloud workstations.
- Claude sign-in: The installer asks how agents should use Claude:
- Installing by hand: Only needed when the guided setup is not an option:
- Health checks: While the installer runs, this page lists the health checks as they finish: Node, git, Claude, the sandbox, Docker, yt-dlp, your repositories and server connectivity. Each shows ok, warn or fail. A fail means something is missing or broken and the line says what. A warn (Docker, yt-dlp) is optional.
- Shared package caches: Agents of one workstation share its package caches (NuGet, npm, pnpm, pip, Gradle, Maven, Go), kept in the runner's data folder, so each package is downloaded once. Packages already restored in your own NuGet folder are reused too, read-only.…
- Agent toolchains: Agents use the tools found under your home (several .NET SDKs, Node, Go, Python, Java) and any the DevOps engineer registers. The Workstations page lists them; you can remove a registered one. A tool you want agents to have, such as .NET 10, is installed by asking DevOps.
- Windows: Default: WSL2 (recommended). Install the runner inside a WSL2 Ubuntu distribution and follow the Linux instructions. The installer turns on WSL2 for you; you just follow the steps. Agents run sandboxed inside WSL2 just like on Linux.
- Git hosts: Each repository of a project has a git host: GitHub, GitLab, Bitbucket Cloud, Azure DevOps, or a plain git server. For pull requests, the repository list and creating new repositories, the workstation must be connected to that host. Your login or token stays on the workstation;…
- Runner updates: The runner on a workstation keeps itself up to date. A few minutes after it starts, and then once a day, it asks the server which runner version is current. When a newer one exists it downloads it, checks that the file is intact, and waits until no agent is working on that workstation before it restarts into the new…
- Unpairing: If a workstation goes away (you sold the computer, decommissioned a server), go to Workstations and click Unpair on its card, then confirm. Its runner token stops working and the runner shuts down, cards claimed there go back to the queue, and its agents wait until you re-home them.…

### Cloud workstations (VPS and Codespaces)
Run your agents on a server (VPS over SSH) or a GitHub Codespace instead of your own computer, with automatic pairing, sleeping when idle and a cost estimate.
- A VPS over SSH: 1. Click Add a workstation and choose A VPS (SSH). 2. Enter the server's address, the SSH port (usually 22), the user, and either a password or an SSH key. Give it a name, and optionally what it costs a month so the page can show an estimate. 3. Click Install and pair.…
- GitHub Codespaces: 1. Click Add a workstation and choose GitHub Codespaces. 2. Connect GitHub: create a token on GitHub with the codespace scope and paste it. Guildwise keeps it encrypted, only to wake and stop your codespace. 3. Enter the repository (owner/name), choose a machine type and see the estimated monthly cost. 4.…
- Sleeping and waking: - A Codespace stops after 30 minutes with no agent working (choose 15 minutes to 2 hours with Settings on its card on the Workstations page). - It wakes by itself when a card is queued that its agents can take. - Optional office hours (days, hours and time zone) keep it asleep outside working time.…
- What it costs: Every cloud workstation shows an estimated monthly cost. For a VPS it is the price you entered. For a Codespace it is the running hours (your office hours, or about 8 hours on working days) times GitHub's hourly rate, plus disk. It is an estimate, not a bill.
- Signing in to Claude: The recommended way is your own Anthropic API key. It stays on the cloud machine; Guildwise never receives or stores it.

### Installing a workstation: if something goes wrong
Installer troubleshooting: expired links, restart, permissions, git version, sandbox.
- It says the link has expired or the pairing code was refused: For safety the command works for 30 minutes and its pairing code can be used once. Open Workstations, click Add a workstation and copy the new command. Only the newest command works: starting the wizard again cancels the earlier one.
- This page keeps saying "Waiting for you to run the command": The installer has not reported in yet. Check that you ran the command on the computer that will host your agents, and that it can open this site in a browser (a company firewall or VPN may block it). If the installer printed an error, the line starting with [x] says what to fix.
- Windows asked me to restart: Say yes. Turning on WSL2 (Linux inside Windows) needs one restart. Sign in as usual: the installer opens again by itself, and Windows may ask you to allow it. If it does not come back, run the command again.
- Ubuntu asks me for a user name and password (Windows): That is the Linux inside your PC, not your Windows login. Choose any name and a password you will remember: the installer asks for it again when it adds tools. Nothing shows on screen while you type a password; that is normal.
- It says systemd is not running: The runner starts by itself from a systemd service. On Windows the installer switches systemd on in Ubuntu (it writes systemd=true to /etc/wsl.conf); if you see this message, run wsl --shutdown in PowerShell and run the install command again.…
- It says I need administrator rights: Installing git, bubblewrap and socat uses your administrator (sudo) password once. Ask whoever manages your computer to install them, or to add you to the sudoers, and run the command again.
- git is too old: The runner needs git 2.40 or newer. The installer upgrades it on Ubuntu (from the official git PPA) and on Debian (it builds a recent git into your home folder, which takes a few minutes). On other systems install a newer git yourself and run the command again.
- The health check "sandbox" is not "enforced": Agents (all except the DevOps engineer) run inside a sandbox so they cannot read your SSH keys or other projects. On Linux and WSL2 it needs bubblewrap and socat; on Ubuntu 24.04 and newer an AppArmor setting can block bubblewrap (the Claude Code sandboxing documentation shows the one-line fix). macOS needs nothing.…
- Which Claude sign-in should I choose?: A Claude subscription (Pro, Max, Team or Enterprise): you sign in with your Claude account in a browser and the agents' work counts against your plan, with no per-use bill. An Anthropic API key: you pay for exactly what the agents use. Use whatever your organization gave you.…
- Docker or yt-dlp show a warning: Both are optional. Docker is only needed if your testers run containers; yt-dlp lets agents read video transcripts. Run the command again and say yes when it asks, or ignore the warning.
- I still need help: If the workstation is already paired, Ask DevOps on it can often fix the problem for you. Otherwise use Contact us and say which system you use and which step stopped. The form attaches the details we need. For a server or Codespace, see Cloud workstations.

### Integrations
Connect Claude, git hosts, Jira and MCP servers from the web.
- Connect: Click Connect on a tile. Your token is encrypted in your browser for that workstation.
- Greyed out: The tile says why. From a terminal shows the command instead.

### Converting a project
Converting from research to code or another workflow, what is kept, and the conversion process.
- Converting: Only the organization's Owner and Admins can convert. To convert a project:
- What is kept: When you convert:
- Research as a stage: Step 1: Workflow. Pick the target: Code (the usual next step from research), or any custom workflow of your organization. Any workflow can convert to any other, including back to research.

### Chat with agents
Starting a chat with an agent, threads, asking the BA and archiving chats.
- Starting a chat: 1. Click Chat in the top bar (or Chat on the Desk page, or choose Chat with an agent in the command palette). 2. Pick an agent you may talk to (the BA, a DevOps engineer, builders and so on) and click Start chat. 3. Type your message. Replies stream in while the agent's workstation is connected;…
- Threads: Each chat is a thread. You can ask questions, offer suggestions and discuss blockers or decisions. Threads are saved. A thread that is linked to a card also shows in that card's history.
- What the agent can read: In a chat about a project, the agent can read (never change) the project's own repositories when they are cloned on its workstation, plus the project's reference repositories. In a chat about a card, it reads the card's work folder if that is on the workstation, plus the reference repositories;…
- Asking the BA: Start a chat with the BA the same way. Ask the BA to:
- Archiving chats: Click the menu on a thread and choose Close chat to tidy it away. Closed chats move to the Archived view of the chat list, and Restore to the list brings one back. Delete chat removes a conversation for good, but a chat linked to a card cannot be deleted: it stays in the card's history.

### Writing to us
How to contact us, where to see your requests, what we receive with your message.
- Contact us: Open Contact us from:
- What we send with your message: Open What we send with your request to see exactly what goes along:
- My requests: We answer by email, and the answer also appears under Help > My requests.
- Cannot sign in: If you cannot sign in:

### Troubleshooting
Day-to-day problems: offline workstations, missing handoffs, vault conflicts, mismatched agents, waiting projects and cloud workstations.
- A workstation shows "Offline": The runner process stopped or the connection timed out. On that computer, check the state:
- An agent finished but I do not see a handoff: The shift may have run past its time limit (an hour by default; the server stops it) or the runner crashed. Check:
- "The runner is running: stop it first": When rotating the runner's token to refresh the connection:
- Vault sync is paused with a conflict: Vault sync stops if a local change conflicts with a remote change. Open Vaults in the sidebar, find the vault (it shows Sync paused: conflict and the conflicting files), and resolve it:
- Card does not match available agents: The repository must be listed under the workstation, and the agent must have the role and workstation assigned. Check:
- Every card of a project is waiting: Before agents build on a workstation, its DevOps engineer installs the tools and packages the project needs. Until that is done, every agent card of the project waits and says why.…
- A cloud workstation needs attention: A Codespace that cannot start (credits or spending limit used up on GitHub) shows Needs attention and leaves a notice on your desk. Fix it on GitHub and press Wake. See Cloud workstations.
- Cards wait in Design with no architect hired: A project has Investigate & design before build turned on in the Architect settings, but you haven't hired an architect yet. Cards move into the Design stage and wait because nobody can claim it.
- Main branch merge was skipped or conflicted: When your repository has a main branch and a different working branch, the runner tries to merge the latest main into the working branch before a card's work starts (on by default). In the project's Architect settings, Merge the latest main branch first controls this.
- A workflow variant is waiting for approval: You submitted a project variant (custom steps added to Code or another workflow for one project) and it is waiting on your desk.
- An agent says the work is out of scope: The agent reported work outside the scope of its role. Check:
- Git host says "Token refused": The badge on the Workstations page shows Token refused for a git host where you expected to be connected.
- SSH says "refused the key", "host key changed" or "not reachable": On Workstations, open the workstation, click SSH on the git host and press Check SSH. The state tells you what to do:
- Runner update rolled back: The runner tried to update to a new version but rolled back automatically because the new version did not connect within a few minutes. The label on the runner shows Update rolled back.
- Working branch could not be created or pushed: A card shows Last attempt failed: working branch 'X' could not be created or pushed or names a reason like "protected repository".
- An agent says it cannot read a repository: In a chat or on a card, the agent says it cannot find or read a code repository (for example to compare two or look up how something is used elsewhere).

### Plans and billing
Plans and limits, the 7-day free trial, cards and invoices, changing plan, Business add-ons, cancelling and what happens when a payment fails.
- Plans: Every plan has every feature and no limit on agents. Plans differ only in how many members, workstations and projects you can have.
- Signing up and the free trial: 1. Click Start free trial on the website (or a plan's button under Pricing), choose a plan and enter your company name (Guildwise HQ is sold to businesses), your name, email and a password. 2. Open the link in the email we send you. Signing in needs the confirmed email. 3.…
- Cards and invoices: We never see or keep your card number. You enter your card on Paystack's secure page; a small amount is charged to check the card and refunded straight away. Only a secure token is kept, with the card brand, the last four digits and the expiry date, which the Billing page shows (we also email you before the card…
- Billing profile and tax invoices: Guildwise HQ is sold to businesses, so sign-up asks for your company name. Under Billing > Billing profile the Owner can edit the company name, address, country and VAT number (optional). They are printed on your invoices; an invoice that is already paid keeps the details it was issued with.
- Changing plan: Pick another plan under Change plan. The change takes effect at once. If the new plan costs more you pay the difference for the rest of the month now; if it costs less the difference is kept as a credit on your next invoice. During the trial a change costs nothing.…
- Business add-ons: On Business you can add members, workstations and projects on top of the plan, each at a small monthly price shown on the page. Changes apply from your next billing cycle, and you can never go below the Business base. To go lower, change plan.
- Cancelling: Cancel subscription keeps your organization active until the end of what you have paid for (or the end of the trial), then pauses it. Nothing more is charged. Changed your mind before then? Use Keep my subscription.
- When a payment fails: If a charge fails we try again after one day and again after three days (three attempts in all) and email you each time. Update your card on the Billing page to fix it. If the third attempt fails, the organization is paused.
- When payments are not available yet: While a server has no real payment provider set up, the Billing page says Payments are not available yet and hides choosing a plan, adding or updating a card and changing plan. Nothing is charged, and your organization keeps working.…
- For platform administrators: Under Platform > Billing you see which payment provider is active and whether it is in sandbox (test keys) or live mode, and you edit the plan prices and limits (US dollars, VAT included), the add-on prices, the VAT percentage (15 by default;…

### The blog and the weekly digest
Where to read the Guildwise HQ blog, how to get (or stop) the weekly digest, and how the platform administrator runs the blog.
- Reading the blog: - Inside the app, open Help and choose the Blog tab. You read the articles without leaving your work, and the search box on the Help centre also finds them under From the blog. - On the public site, go to /blog. You can follow the RSS feed at /blog/rss.xml, and every article has a share link.
- The weekly digest: Once a week, on Monday at 08:00 (Johannesburg time), you can get one email with the new articles. In a week with nothing new, nothing is sent.
- Running the blog (platform administrator): This part is for the platform administrator. The blog is managed under Blog and API keys in the platform area.

### What's new
The popup that tells you about new features after an update, and how to read the list again.
- Closing the window: Click Got it (or close the window) and the changes you were shown are marked as seen. They are remembered for your account, not for your browser, so they do not come back on your phone or another computer.
- Who sees what: You only see changes that matter for your role in the organization you are working in. Some changes are for everyone, some only for Owners, some for Owners and Admins. Platform administrators see the changes for the platform area.…
- Read the list again: Open Help and choose See what's new on the What's new card. The list shows every change for your role, including the ones you have already seen. Closing it there does not change anything.

### Simulation organizations
A safe sandbox for tests and demos: agents run on a simulated workstation, nothing real is built or billed, and the whole organization can be deleted.
- What is different: - A Simulation banner is shown to everyone in the organization on every page, and the organization has a Simulation badge in the platform list. - Agents run on a simulated workstation. Guildwise hosts it for you. It uses scripted "mock" agents, so no model is called, no tokens are used and nothing costs money.…
- Making an organization a simulation: A platform administrator can invite a new organization as a simulation, or switch an existing one over, but only while it is empty: no projects (archived ones count) and no active billing subscription. Otherwise Guildwise explains why and nothing changes. A simulation organization cannot be switched back;…
- Pace: The platform administrator sets how fast the simulated workstation works: Fast (good for tests), Normal or Slow (good for demos, so people can watch a card move).
- Starting a demo: On a simulation organization, the platform administrator can choose Load demo scenario. It adds two projects with repositories, a hired team for each, cards in several stages, a few desk questions and a schedule, so a demo starts from a busy board. It only adds to an empty organization.
- Deleting a simulation organization: The platform administrator can choose Delete simulation organization on the organization's page and type its name to confirm. This removes the organization and everything in it for good, including its history.…
</help_outline>
