# Video plan: Getting started plus one video per section

This plan replaces the single introduction video with a short set: one **Getting started** video (G) and one short video per group of sections (S1 to S17). It is a plan only. The existing introduction video and every link to it stay as they are until the new Getting started video is recorded. Nothing in the guide, the tour or Help links to a video listed here until that video exists.

Section numbers and names are those of the section inventory in `GAP-LIST.md` (1 Board … 23 Help, P Platform area).

## Length rule

- G: 120 to 180 seconds (target 2:30).
- Each S video: 60 to 120 seconds.
- The `duration` in the chapters JSON that the pipeline writes after recording makes this measurable. A video outside its range is re-cut before it is published.

## How a video is made

The existing pipeline in `e2e/video/` is used unchanged in method:

- A Playwright script drives a seeded demo stack (port 4671, database `aom_onboard_video`, organization "Acme", Owner "Alex Morgan", mock runner) and records the screen.
- The voice is Piper `en_GB-cori-high`. The narration cues are spoken first and their lengths set the pacing of the clicks.
- Output per video: WebM and MP4, VTT captions and a chapters JSON, together under 20 MB, in `apps/web/public/videos/<slug>.*`.
- Only demo data appears on screen (`@demo.local`, `example.com`, invented names). No real customer or personal data.

## Rules for every video

1. One spec file and one narration module per video: `e2e/video/<slug>.spec.ts` and `e2e/video/narration/<slug>.ts`. Output `apps/web/public/videos/<slug>.*`.
2. Each video seeds its own data through the API in its own `beforeAll`. It never relies on the recording or the state of another video.
3. It starts on its own page, reached through the sidebar (never "as we saw in…"), and ends on that page.
4. It never names or shows another section video. It may say "see the guide, chapter x".
5. Only demo data.
6. Getting started may show the sidebar but explains no section beyond one sentence.

## Prerequisite task V-0: make the pipeline and the player multi-video

Before the first section video is recorded, one separate piece of work:

- Parametrise `playwright.video.config.ts` (`testMatch` for all `*.spec.ts`) and the spec's output names and chapter source.
- Give `useVideoInfo(url)` and `GettingStartedVideo` a slug or URL prop that defaults to getting-started (the tour test mocks that URL).
- Add a way to link a video from a Help article and from a tour step.

Every video below depends on V-0 and on nothing else. Linking a finished video from the guide, the tour and Help is part of that video's own work.

## Videos

Each entry has the same fields. "Linked from" names the guide chapter, the tour step id and the Help article anchor where the link will be added once the video exists.

### G. Getting started

- **Title:** Getting started with Guildwise HQ
- **Sections covered:** none as primary; touches 1 Board, 5 Desk, 8 Projects, 9 Agents and 13 Workstations lightly.
- **Scope in:** sign in; the Get started checklist; the Add a workstation wizard (shown, not waited on); hiring a lean team; creating a project and its repository; New card; talking to the business analyst; answering on the Desk; the card moving on the Board; where Help, the tour and Ctrl K are.
- **Scope out:** any explanation of a section beyond one sentence; Backlog, Environments, Releases, CEO, Integrations, Metrics, Costs, Interests, Ledger, Vaults, Settings, Organization.
- **Target length:** 2:30 (120 to 180 s).
- **Script outline:**
  1. Sign in as the Owner; the empty organization shows the Get started button in the sidebar.
  2. Open Get started: the checklist of what is left (project, repository, workstation, team, business analyst).
  3. Workstations: Add a workstation opens the wizard; show the steps and the live progress, then continue with a workstation that is already online.
  4. Agents: Hire agent for the lean team (business analyst, planner, architect, builder, pre-reviewer, reviewer, tester), choosing the project allow-list.
  5. Projects: New project with its repository.
  6. New card from the sidebar button; talk to the business analyst until the brief is ready.
  7. Desk: answer the question that arrives; the number in the sidebar drops.
  8. Board: the card moves between columns by itself.
  9. Close: Help in the sidebar, the tour replay, and Ctrl K.
- **Prerequisites and test data:** empty demo organization "Acme", Owner "Alex Morgan", one pre-paired mock workstation, one demo repository, mock runner that answers the BA's questions.
- **Linked from:** guide chapter 3 intro; tour step `video`; Help article `getting-started#training-video`.
- **Re-record when:** the Get started checklist, the Add a workstation wizard, Hire agent, New project, New card, answering on the Desk or the sidebar layout changes (see the re-record map).

### S1. Board and cards

- **Title:** The Board and your cards
- **Sections covered:** 1 Board.
- **Scope in:** columns that follow the workflow; the filter chips (Blocked, Rework, Waiting for my QA, Waiting for my approval); opening a card (brief, thread, shifts, cost); New card; Pause project; Archive.
- **Scope out:** the Backlog tab content, phases and follow-ups, Environments, Desk answers.
- **Target length:** 1:30.
- **Script outline:**
  1. Open Board from the sidebar: columns for the project's workflow.
  2. Use the chips to show only what is Blocked, then what is Waiting for my approval.
  3. Open a card: the brief, the thread, the shifts and what it cost.
  4. Close it and choose New card; show the fields, cancel.
  5. Pause project and resume it.
  6. Open Archive from the Board and return.
- **Prerequisites and test data:** one demo project with about eight cards across all columns, one blocked, one in rework, one waiting for QA, one waiting for approval; shift and cost history on one card.
- **Linked from:** guide 2.2 and 4.12; tour step `board`; Help `board-and-cards#reading-the-board`.
- **Re-record when:** Board layout, chips, card detail or Archive changes.

### S2. Backlog

- **Title:** The project backlog
- **Sections covered:** 2 Backlog.
- **Scope in:** quick add; flags; filters and the Newest sort; Send {n} to the BA; Drop; who may edit (Owners and Admins; every member can read).
- **Scope out:** what the BA does with the items afterwards, the Board.
- **Target length:** 1:00.
- **Script outline:**
  1. Open Backlog from the sidebar.
  2. Quick add two ideas.
  3. Set a flag on one; use the filters and sort by Newest.
  4. Select two items and choose Send 2 to the BA.
  5. Drop one item.
  6. Say who can edit and who can only read.
- **Prerequisites and test data:** demo project with eight backlog items of mixed flags; Owner signed in.
- **Linked from:** guide 4.3b; tour step `backlog`; Help `board-and-cards#backlog`.
- **Re-record when:** Backlog page, its buttons or its permissions change.

### S3. Environments

- **Title:** Environments: where your app runs
- **Sections covered:** 3 Environments.
- **Scope in:** Your app; Scan with DevOps / Not sure: let DevOps look / Use this; Add an environment; test copies and places; Check, Reconnect, Use another computer; the Releases On/Paused switch.
- **Scope out:** the Releases page, workstation setup, secrets (shown only as "technical details").
- **Target length:** 1:30.
- **Script outline:**
  1. Open Environments from the sidebar (code project).
  2. Your app: what DevOps found and Use this.
  3. Add an environment.
  4. A test copy and the place it runs on; Check.
  5. Reconnect and Use another computer, briefly.
  6. Releases switch: Pause releases? dialog, then back On.
- **Prerequisites and test data:** demo code project with a scanned app, one test copy, one environment, two workstations.
- **Linked from:** guide 4.27; tour step `environments`; Help `phases#delivery-recipes`.
- **Re-record when:** the Environments page or its Releases switch changes.

### S4. Research

- **Title:** Research
- **Sections covered:** 4 Research.
- **Scope in:** New research card; research in progress; published notes.
- **Scope out:** Ledger, Interests.
- **Target length:** 1:00.
- **Script outline:**
  1. Open Research from the sidebar.
  2. New research card: write the question.
  3. The list of research in progress.
  4. Open a published note.
  5. Where the note is kept.
- **Prerequisites and test data:** demo project with the research stage, one published note, one in progress.
- **Linked from:** guide 4.13; tour step `research`; Help `project-conversion#research-as-a-stage`.
- **Re-record when:** the Research tab changes.

### S5. Desk

- **Title:** Your Desk
- **Sections covered:** 5 Desk.
- **Scope in:** groups and chips (including Handled by CEO and CEO decisions); answering a question; Add to ledger as; Accept recommendation; the CEO's Daily report item.
- **Scope out:** how the CEO is configured, the Ledger page.
- **Target length:** 1:30.
- **Script outline:**
  1. Open Desk from the sidebar; the number shows what is waiting.
  2. Groups and chips.
  3. Open a question, answer it, and choose Add to ledger as a standing order.
  4. An item with a recommendation: Accept recommendation.
  5. The Handled by CEO and CEO decisions chips.
  6. Open the Daily report item.
- **Prerequisites and test data:** one question, one approval, one recommendation, two items handled by the CEO, one Daily report, all from demo cards.
- **Linked from:** guide 4.5; tour step `desk`; Help `desk#desk-items`.
- **Re-record when:** Desk items, chips or answer controls change.

### S6. Intake

- **Title:** Intake: bring in tickets
- **Sections covered:** 6 Intake.
- **Scope in:** one ticket (chat); Batch; Tell your CEO; Work with the BA directly.
- **Scope out:** connecting Jira or GitHub (see Integrations).
- **Target length:** 1:00.
- **Script outline:**
  1. Open Intake from the sidebar.
  2. Paste one ticket reference and start the chat.
  3. The BA asks only what is missing.
  4. Switch to the Batch tab.
  5. Tell your CEO versus Work with the BA directly.
- **Prerequisites and test data:** demo Jira-style tickets served by the mock integration; Owner signed in.
- **Linked from:** guide 4.8; tour step `intake`; Help `intake-and-outbox#intake`.
- **Re-record when:** Intake tabs or buttons change.

### S7. Automations

- **Title:** Automations
- **Sections covered:** 7 Automations (nav id `schedules`).
- **Scope in:** New automation wizard (When, What, Details); Run now; History; Pause.
- **Scope out:** Interests schedules, webhook receivers.
- **Target length:** 1:30.
- **Script outline:**
  1. Open Automations from the sidebar.
  2. New automation: When (a weekday morning).
  3. What (create a card), then Details.
  4. Save; Run now.
  5. History of runs.
  6. Pause the automation.
- **Prerequisites and test data:** demo project; one existing automation with a short history.
- **Linked from:** guide 4.8; tour step `schedules`; Help `automations-and-integrations#triggers`.
- **Re-record when:** the wizard, History or the automations list changes.

### S8. Projects

- **Title:** Projects and their settings
- **Sections covered:** 8 Projects.
- **Scope in:** New project; priority order; project settings and its jump chips; budget; Send invitation.
- **Scope out:** Environments, Releases, agents' allow-lists.
- **Target length:** 1:30.
- **Script outline:**
  1. Open Projects from the sidebar.
  2. New project with a repository.
  3. Drag a project up in the priority order.
  4. Open project settings and use the jump chips.
  5. Set the monthly budget.
  6. Invite a member by email with Send invitation.
- **Prerequisites and test data:** three demo projects; a demo invitee `guest@demo.local`.
- **Linked from:** guide 3.6 and 4.3; tour step `projects`; Help `projects#ranking`.
- **Re-record when:** the Projects page or project settings change.

### S9. Agents and the org chart

- **Title:** Your agents and the org chart
- **Sections covered:** 9 Agents, 10 Org chart.
- **Scope in:** Hire agent dialog; allow-list; Pause and Resume; Change model; recommendations (Dismiss, Dismiss all); the org chart, its Allowed on project filter and Workstations and DevOps panel.
- **Scope out:** the CEO page, roles and workflows.
- **Target length:** 2:00.
- **Script outline:**
  1. Open Agents from the sidebar.
  2. Hire agent: role, seniority, Runtime, Effort, allow-list.
  3. Pause and Resume an agent.
  4. Change model.
  5. A recommendation: act on it, and Dismiss.
  6. Open Org chart from the sidebar: you, the CEO, the BAs.
  7. Filter by Allowed on project; open the Workstations and DevOps panel.
- **Prerequisites and test data:** six demo agents, one recommendation, a CEO appointed.
- **Linked from:** guide 3.5, 4.4 and 4.7; tour steps `agents` and `org-chart`; Help `agents#hiring` and `org-chart-and-design#org-chart`.
- **Re-record when:** the Hire agent dialog, the agent list controls or the org chart change.

### S10. Your CEO

- **Title:** Your CEO
- **Sections covered:** 11 CEO.
- **Scope in:** Overview; Authority; Reporting & alerts; Ask {CEO} chat (New chat, Chats list); Activity log with Undo.
- **Scope out:** Persona & instructions, Memory, Topics (named in one sentence), Desk.
- **Target length:** 1:30.
- **Script outline:**
  1. Open CEO from the sidebar: Overview.
  2. Authority: what the CEO may decide.
  3. Reporting & alerts: when the daily report arrives.
  4. Ask {CEO}: start a chat and ask a question.
  5. Activity log: Undo one action.
  6. Workstations tab: Move the CEO here, shown once.
- **Prerequisites and test data:** appointed demo CEO with a short activity log and one chat.
- **Linked from:** guide 4.22; tour step `ceo`; Help `your-ceo#talking`.
- **Re-record when:** any CEO tab or the CEO chat changes.

### S11. Roles and workflows

- **Title:** Roles and workflows
- **Sections covered:** 12 Roles & workflows (nav id `org`; the page is titled "Organization").
- **Scope in:** Roles; Workflows (view, compare); the workflow builder; Create department; Design with the BA (Investigate & design).
- **Scope out:** the Board, agent hiring.
- **Target length:** 1:30.
- **Script outline:**
  1. Open Roles & workflows from the sidebar.
  2. Roles tab.
  3. Workflows tab: open Code, then compare two versions.
  4. The builder: add a stage, save.
  5. Create department.
  6. Design with the BA: start a design chat.
- **Prerequisites and test data:** the default workflows plus one custom workflow; a BA allowed on a project.
- **Linked from:** guide 4.7 and 4.26; tour step `org`; Help `org-chart-and-design#custom-workflows`.
- **Re-record when:** the Roles, Workflows or Design with the BA tabs change.

### S12. Workstations and integrations

- **Title:** Workstations and integrations
- **Sections covered:** 13 Workstations, 15 Integrations.
- **Scope in:** Add a workstation wizard; Pair workstation / Pair with a code; health; Shifts at once; Check for updates; Integrations tiles (one Claude tile per account, Connect another account); git hosts, Jira, MCP Sign in and Sign out.
- **Scope out:** Environments, DevOps requests.
- **Target length:** 2:00.
- **Script outline:**
  1. Open Workstations from the sidebar.
  2. Add a workstation: the wizard steps and "Waiting for you to run the command".
  3. Pair with a code.
  4. A workstation card: health, Shifts at once.
  5. Check for updates.
  6. Open Integrations from the sidebar: the Claude account tiles.
  7. Connect another account; a git host and an MCP server.
- **Prerequisites and test data:** two demo workstations (one online, one offline), two demo Claude accounts, one demo MCP server.
- **Linked from:** guide 3.4, 3.4a and 4.19; tour steps `workstations` and `integrations`; Help `workstations-and-installer#add-a-workstation` and `integrations#connect`.
- **Re-record when:** the workstation wizard, workstation card or Integrations tiles change.

### S13. Releases

- **Title:** Releases
- **Sections covered:** 14 Releases.
- **Scope in:** the queue (Release, Not now, Release to N of M); what is live; history and its filters; The standard rule; Freeze all releases and Lift the freeze; Advanced: rule sets.
- **Scope out:** Environments setup.
- **Target length:** 1:00.
- **Script outline:**
  1. Open Releases from the sidebar.
  2. The queue: Release one item, Not now for another.
  3. What is live.
  4. History and its filters.
  5. The standard rule; Advanced: rule sets.
  6. Freeze all releases, then Lift the freeze.
- **Prerequisites and test data:** two queued demo releases, one live, a short history.
- **Linked from:** guide 4.28; tour step `releases`; Help `phases#delivery-recipes`.
- **Re-record when:** the Releases page changes.

### S14. Metrics and costs

- **Title:** Metrics and costs
- **Sections covered:** 16 Metrics, 17 Costs.
- **Scope in:** the Project filter and 7/14/30/90-day range; the panels (Throughput, Time blocked on you, Bounce rate per builder, Bugs escaped past test, Duration, Queue depth); Costs by project, agent, model and day; the budget meter; What the agents delivered.
- **Scope out:** setting budgets (shown in project settings, S8).
- **Target length:** 1:30.
- **Script outline:**
  1. Open Metrics from the sidebar; choose a range and a project.
  2. Throughput and Time blocked on you.
  3. Bounce rate per builder, Bugs escaped past test.
  4. Duration and Queue depth per column.
  5. Open Costs from the sidebar: by project, agent, model and day.
  6. The budget meter and What the agents delivered.
- **Prerequisites and test data:** 30 days of generated demo activity and cost data across two projects.
- **Linked from:** guide 4.29 and 4.6; tour steps `metrics` and `costs`; Help `agents#hr-board` and `budgets-and-costs#monthly-budgets`.
- **Re-record when:** the Metrics panels or the Costs page change.

### S15. Interests

- **Title:** Interests
- **Sections covered:** 18 Interests.
- **Scope in:** New interest; look and digest schedules; Deliver N now; taste rules; quiet cap; Archive, Restore, Delete permanently.
- **Scope out:** Automations.
- **Target length:** 1:30.
- **Script outline:**
  1. Open Interests from the sidebar.
  2. New interest with a topic.
  3. Set the schedules for looking and for the digest.
  4. Taste rules and the quiet cap.
  5. Deliver N now.
  6. Archive and Restore.
- **Prerequisites and test data:** the interests feature on; two demo interests with delivered digests.
- **Linked from:** guide 4.9; tour step `interests`; Help `interests#run-and-delivery`.
- **Re-record when:** the Interests list or detail page changes.

### S16. Ledger and vaults

- **Title:** The Ledger and vaults
- **Sections covered:** 19 Ledger, 20 Vaults.
- **Scope in:** search and the Project filter; Add entry; standing orders; Edit, History, Retire, Show retired; registering a vault (git or local folder).
- **Scope out:** Desk's Add to ledger as.
- **Target length:** 1:30.
- **Script outline:**
  1. Open Ledger from the sidebar and search.
  2. Add entry as a standing order.
  3. Edit and History of an entry.
  4. Retire an entry; Show retired.
  5. Open Vaults from the sidebar.
  6. Register a vault: git, then a local folder.
- **Prerequisites and test data:** about twelve demo entries including one retired; one demo git vault.
- **Linked from:** guide 4.5 and 4.3a; tour steps `ledger` and `vaults`; Help `ledger-and-vaults#ledger` and `#vaults`.
- **Re-record when:** the Ledger page or the Vaults page changes.

### S17. Your settings, organization and Help

- **Title:** Your settings, your organization and Help
- **Sections covered:** 21 Settings, 22 Organization, 23 Help.
- **Scope in:** Settings (picture, time zone, two-factor login, Notifications, Monday briefing); Organization tabs (members, invitations, guests, plan); Help centre in one beat.
- **Scope out:** billing detail, platform area.
- **Target length:** 1:30.
- **Script outline:**
  1. Open Settings from the sidebar: picture and time zone.
  2. Set up two-factor login.
  3. Notifications and Monday briefing.
  4. Open Organization: Members, then Send invitation.
  5. Guests and Plan.
  6. Open Help: the tour replay and search.
- **Prerequisites and test data:** Owner signed in; demo members and one pending invitation.
- **Linked from:** guide 4.30, 4.1, 4.2 and 10; tour steps `settings`, `organization` and `help`; Help `getting-started#your-settings`, `organizations-and-roles#members-and-invitations` and `getting-started#the-sidebar`.
- **Re-record when:** Settings, Organization or the Help centre layout changes.

### P. Platform area (optional)

- **Title:** The platform area
- **Sections covered:** P Platform area.
- **Scope in:** organizations, invitations, accounts, billing, support, blog, API keys, runners, team, inbound mail, audit log.
- **Scope out:** everything inside an organization.
- **Target length:** 2:00.
- **Script outline:** 1. Organizations; 2. Invitations; 3. Accounts; 4. Billing; 5. Support and Blog; 6. API keys, Runners, Team, Inbound; 7. Audit log.
- **Prerequisites and test data:** platform administrator login, two demo organizations.
- **Linked from:** guide chapter 7; platform tour step `welcome`; Help `organizations-and-roles#platform-area`.
- **Re-record when:** any platform page changes.
- Only recorded if the owner asks for it (see the decisions below).

## Re-record map

Each section belongs to exactly one section video. G is also re-recorded for the five sections whose first-run flow it shows.

| # | Section | Section video | Also re-record G when |
|---|---|---|---|
| 1 | Board | S1 | New card (the dialog or sidebar button) changes |
| 2 | Backlog | S2 | never |
| 3 | Environments | S3 | never |
| 4 | Research | S4 | never |
| 5 | Desk | S5 | answering a question on the Desk changes |
| 6 | Intake | S6 | never |
| 7 | Automations | S7 | never |
| 8 | Projects | S8 | New project (the dialog or its repository step) changes |
| 9 | Agents | S9 | the Hire agent dialog changes |
| 10 | Org chart | S9 | never |
| 11 | CEO | S10 | never |
| 12 | Roles & workflows | S11 | never |
| 13 | Workstations | S12 | the Add a workstation wizard or the Get started checklist changes |
| 14 | Releases | S13 | never |
| 15 | Integrations | S12 | never |
| 16 | Metrics | S14 | never |
| 17 | Costs | S14 | never |
| 18 | Interests | S15 | never |
| 19 | Ledger | S16 | never |
| 20 | Vaults | S16 | never |
| 21 | Settings | S17 | never |
| 22 | Organization | S17 | never |
| 23 | Help | S17 | the Get started button or the tour entry point changes |
| P | Platform area | P (if recorded) | never |

A change to the sidebar itself (labels, order, new entry) re-records G and every video whose first beat opens a changed entry.

## Alternative: one video per sidebar entry

If the owner prefers one video per section, the set is G plus 23 section videos (sections 1 to 23, plus P if wanted), each 60 to 120 seconds. The same fields, rules and prerequisites apply; the entries above are split at the section boundaries (S9 into Agents and Org chart, S12 into Workstations and Integrations, S14 into Metrics and Costs, S16 into Ledger and Vaults, S17 into Settings, Organization and Help). The re-record map then becomes strictly one section to one video, plus G for the same five first-run flows. Splitting needs no further analysis, only the beat lists cut at those boundaries.

## Decisions for the owner

1. Grouping: approve the 17 grouped section videos above, or choose one video per sidebar entry (23 plus G).
2. Platform area: record video P, or leave the platform administrator with the tour and the guide only.
3. Order of recording: Getting started first, then by how often the section changes.
