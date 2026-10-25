# Video plan: Getting started plus one video per section

The owner decided: **one video per section**. There is one **Getting started** video (G) and one video for each section of the sidebar inventory (sections 1 to 23 and P, the platform area): 25 videos in all. Each section video is 60 to 120 seconds and G is 120 to 180 seconds.

Section numbers and names are those of the section inventory in `docs/investigations/GWP-10-documentation-onboarding-refresh-for-gwp-many-chan.md` (decision D1) and `GAP-LIST.md`.

Labels of buttons, tabs and fields are written in `code` style when they are exactly what the app shows (checked against the web code in `apps/web/src`). Where a label contains a number or a name, `{n}` or `{CEO}` stands for it.

## Length rule

- G: 120 to 180 seconds (target 2:30).
- Each section video: 60 to 120 seconds.
- The `duration` in the chapters JSON that the pipeline writes after recording makes this measurable. A video outside its range is re-cut before it is published.
- A rough guide: the voice (Kokoro `af_heart`) speaks about 2.4 words a second in the finished video, so 60 s is about 145 words of narration and 120 s about 290, plus the pauses between passages (0.7 s each). Measured on 36 real narration passages (809 words): Kokoro 3.07 words a second of pure speech, the old Piper `en_GB-cori-high` 2.88 (about 7% slower; the 2.3 of the old guide was Piper including its pauses, so 2.3 x 3.07 / 2.88 is about 2.45).

## How a video is made

The pipeline lives in `e2e/video/` (V-0 is done, see below):

- A Playwright spec drives a seeded demo stack (default port 4671, database `aom_onboard_video`, organization "Acme", Owner "Alex Morgan", mock runner) and records the screen with a step banner and a visible pointer.
- The voice is Kokoro-82M `af_heart` (Heart), through `kokoro-onnx` on the CPU (`e2e/video/kokoro-say.py`; chosen over the `kokoro` package because that one pulls in PyTorch and needs system espeak-ng, `kokoro-onnx` brings espeak-ng inside a wheel). The narration cues are spoken first and their lengths set the pacing of the clicks. Kokoro (about 0.5 GB with the model and voices), a static ffmpeg and the speech cache live in `~/.cache/aom-video`; `e2e/video/setup-voice.sh` installs them once, after which no network is needed. `AOM_VIDEO_VOICE` picks another Kokoro voice, `AOM_VIDEO_SPEED` the speed (1 is normal), and `AOM_VIDEO_TTS=piper` the old Piper voice. Cached speech is keyed by engine, voice, speed and text, so changing the voice re-speaks every passage. Videos recorded before the switch still have the Piper voice until they are re-recorded.
- Output per video: WebM and MP4, VTT captions and a chapters JSON, together under 20 MB, in `media/videos/<slug>.*`. The videos are served by the media container (`media/Dockerfile`, see `docs/DEPLOY.md` "Help videos"); commit the files, then `scripts/media-changed.sh && scripts/media-build.sh` publishes them.
- Only demo data appears on screen (`@demo.local`, `example.com`, invented names). No real customer or personal data.
- How to record one video, a list, and several at once: `docs/guide/README.md`, "Recording a video".

## Rules for every video

1. One spec file and one narration module per video: `e2e/video/<slug>.spec.ts` and `e2e/video/narration/<slug>.ts`. Output `media/videos/<slug>.*`.
2. Each video seeds its own data through the API in its own spec (helpers in `e2e/video/seed.ts`). It never relies on the recording or the state of another video. `record.sh` gives every video a fresh stack and database.
3. It starts on its own page, reached through the sidebar (never "as we saw in…"), and ends on that page.
4. It never names or shows another section video. It may say "see the guide, chapter x".
5. Only demo data.
6. Getting started may show the sidebar but explains no section beyond one sentence.
7. The narration uses the app's exact labels, and every beat is something the screen really shows. When the page changes, the beat list is re-checked against the page help (`apps/web/src/help/page-help-content.ts`) and the code.
8. A finished video is published by setting `published: true` for its slug in `apps/web/src/lib/videos.ts` in the same commit as its four files. Nothing links to a video that has not been recorded.

## Pipeline (V-0, done)

- `e2e/video/playwright.video.config.ts` matches every `e2e/video/*.spec.ts`; `AOM_VIDEO_SLUG` picks one. `e2e/video/record.sh <slug>...` records a list, each on a fresh stack.
- Each spec writes `media/videos/<slug>.{webm,mp4,vtt,json}` through the shared harness (`harness.ts`); narration modules live in `e2e/video/narration/<slug>.ts`; seeding helpers (Acme, Alex Morgan, mock runner, demo project, agents, cards) are in `seed.ts`; the spec template is `e2e/video/template/slug.spec.ts`.
- The stack's port, database and scratch directory are set per run (`AOM_VIDEO_PORT`, `AOM_VIDEO_DB`, `AOM_VIDEO_DIR_BASE`), so recordings can run at once.
- The web app: `useVideoInfo(url)` and `VideoPlayer` take a URL or slug that defaults to getting-started; `apps/web/src/lib/videos.ts` is the registry (slug to title, sidebar entry, Help anchor and a `published` flag); a published video appears under its Help anchor, in the tour step of its section and behind a `Watch the video` button in the page help panel of its section.
- The Backlog video was recorded as the proof of the pipeline and is published.

## The 25 videos

| # | Slug | Section | Length | Status |
|---|---|---|---|---|
| G | `getting-started` | Getting started | 2:30 | recorded once (to be re-recorded, see G) |
| 1 | `board` | Board | 1:30 | to record |
| 2 | `backlog` | Backlog | 1:00 | recorded (proof) |
| 3 | `environments` | Environments | 1:30 | to record |
| 4 | `research` | Research | 1:00 | to record |
| 5 | `desk` | Desk | 1:30 | to record |
| 6 | `intake` | Intake | 1:00 | to record |
| 7 | `automations` | Automations | 1:30 | to record |
| 8 | `projects` | Projects | 1:30 | to record |
| 9 | `agents` | Agents | 1:30 | to record |
| 10 | `org-chart` | Org chart | 1:00 | to record |
| 11 | `ceo` | CEO | 1:30 | to record |
| 12 | `roles-and-workflows` | Roles & workflows | 1:30 | to record |
| 13 | `workstations` | Workstations | 1:30 | to record |
| 14 | `releases` | Releases | 1:00 | to record |
| 15 | `integrations` | Integrations | 1:30 | to record |
| 16 | `metrics` | Metrics | 1:00 | to record |
| 17 | `costs` | Costs | 1:15 | to record |
| 18 | `interests` | Interests | 1:30 | to record |
| 19 | `ledger` | Ledger | 1:15 | to record |
| 20 | `vaults` | Vaults | 1:00 | to record |
| 21 | `settings` | Settings | 1:15 | to record |
| 22 | `organization` | Organization | 1:30 | to record |
| 23 | `help` | Help | 1:00 | to record |
| P | `platform-area` | Platform area | 2:00 | to record |
| 24 | `discovery` | Discovery | 1:45 | recorded |
| 25 | `documents` | Documents | 1:05 | recorded |
| 26 | `boardroom` | Boardroom | 2:05 | recorded |
| 27 | `capabilities` | Capabilities | 2:15 | recorded |
| 28 | `ai-runtimes` | Integrations > AI runtime and Settings > Model providers | 2:00 | recorded |
| 30 | `overview` | Overview of the whole product (video/overview-script.md; teaser: `overview-teaser`) | 12:52 | recorded |
| 29 | `governance` | Approvals, What it may do, audit export, offboarding | 2:00 | recorded |

## Videos

Each entry has the same fields. "Linked from" names the guide chapter, the tour step id and the Help article anchor where the video is shown once it exists (the tour step and the Help anchor are wired by the registry; the guide link is added by hand).

### G. Getting started

- **Slug:** `getting-started`
- **Title:** Getting started with Guildwise HQ
- **Sections covered:** none as primary; touches 1 Board, 5 Desk, 8 Projects, 9 Agents and 13 Workstations lightly.
- **Scope in:** sign in; the `Get started` checklist; the `Add a workstation` wizard (shown, not waited on); hiring a lean team; creating a project and its repository; `New card`; talking to the business analyst; answering on the Desk; the card moving on the Board; where Help, the tour and Ctrl K are.
- **Scope out:** any explanation of a section beyond one sentence; Backlog, Environments, Releases, CEO, Integrations, Metrics, Costs, Interests, Ledger, Vaults, Settings, Organization.
- **Target length:** 2:30 (120 to 180 s).
- **Script outline:**
  1. Sign in as the Owner; the empty organization shows `Get started` in the sidebar.
  2. Open `Get started`: the checklist of what is left (project, repository, workstation, team, business analyst).
  3. Workstations: `Add a workstation` opens the wizard; show the steps and the live progress, then continue with a workstation that is already online.
  4. Agents: `Hire agent` for the lean team (business analyst, planner, architect, builder, pre-reviewer, reviewer, tester), choosing the project allow-list.
  5. Projects: `New project` with its repository.
  6. `New card` from the sidebar button; talk to the business analyst until the brief is ready.
  7. Desk: answer the question that arrives; the number in the sidebar drops.
  8. Board: the card moves between columns by itself.
  9. Close: `Help` in the sidebar, the tour replay, and Ctrl K.
- **Prerequisites and test data:** empty demo organization "Acme", Owner "Alex Morgan", one pre-paired mock workstation, one demo repository, mock runner that answers the BA's questions (the reply map of `prepareVideo`).
- **Start from:** the existing `getting-started.spec.ts` and `narration/getting-started.ts` (five steps: project, agents, cards, talk to the BA, test the result). They already run on the new harness with unchanged output; the re-recording rewrites the beats above.
- **Linked from:** guide chapter 3 intro; tour step `video`; Help article `getting-started#training-video` (already wired).
- **Re-record when:** the `Get started` checklist, the `Add a workstation` wizard, `Hire agent`, `New project`, `New card`, answering on the Desk or the sidebar layout changes (see the re-record map).

### 1. Board

- **Slug:** `board`
- **Title:** The Board and your cards
- **Sections covered:** 1 Board (with card detail, `New card`, Archive).
- **Scope in:** columns that follow the workflow; the filters (`Blocked`, `Rework`, `Waiting for my QA`, `Waiting for my approval`); opening a card (brief, thread, shifts, cost); `New card`; `Pause project`; `Archive`.
- **Scope out:** the Backlog tab content, phases and follow-ups, Environments, Desk answers.
- **Target length:** 1:30.
- **Script outline:**
  1. Open Board from the sidebar: columns for the project's workflow.
  2. Use the chips to show only what is `Blocked`, then what is `Waiting for my approval`.
  3. Open a card: the brief, the thread, the shifts and what it cost.
  4. Close it and choose `New card`; show the fields, cancel.
  5. `Pause project` and resume it.
  6. Open `Archive` from the Board and return.
- **Prerequisites and test data:** one demo project with about eight cards across all columns, one blocked, one in rework, one waiting for QA, one waiting for approval; shift and cost history on one card. The cards are created through the API and moved by the mock runner (or inserted in the needed stage by the spec's own helper).
- **Linked from:** guide 2.2 and 4.12; tour step `board`; Help `board-and-cards#reading-the-board`.
- **Re-record when:** Board layout, chips, card detail or Archive changes.

### 2. Backlog

- **Slug:** `backlog` (recorded, the proof video)
- **Title:** The project backlog
- **Sections covered:** 2 Backlog.
- **Scope in:** quick add (`Add to the backlog`); the star flag; search and the `Sort` menu (`Newest`); the filters; `Drop`; selecting items and `Send {n} to the BA`; who may edit (Owners and Admins; every member can read).
- **Scope out:** what the BA does with the items afterwards, the Board.
- **Target length:** 1:00 (recorded: 61 s).
- **Script outline:**
  1. Open Backlog from the sidebar.
  2. Quick add an idea: type a title, press Enter.
  3. Flag one with the star; sort by `Newest`.
  4. Search by title; the filters.
  5. Drop one item from its actions menu.
  6. Tick two items: `Send {n} to the BA`; say who can edit and who can only read.
- **Prerequisites and test data:** demo project "Web shop" (SHOP) with four backlog items of mixed priority; Owner signed in.
- **Linked from:** guide 4.3b; tour step `backlog`; Help `board-and-cards#backlog`.
- **Re-record when:** Backlog page, its buttons or its permissions change.

### 3. Environments

- **Slug:** `environments`
- **Title:** Environments: where your app runs
- **Sections covered:** 3 Environments.
- **Scope in:** `Your app`; what DevOps found and `Use this`; `Add an environment`; test copies and `Places`; `Check`, `Reconnect`, `Use another computer`; the Releases `On`/`Paused` switch.
- **Scope out:** the Releases page, workstation setup, secrets (shown only as "technical details").
- **Target length:** 1:30.
- **Script outline:**
  1. Open Environments from the sidebar (code project).
  2. `Your app`: what DevOps found and `Use this`.
  3. `Add an environment`.
  4. A test copy and the place it runs on; `Check`.
  5. `Reconnect` and `Use another computer`, briefly.
  6. The Releases switch: the pause dialog, then back on.
- **Prerequisites and test data:** demo code project with a scanned app, one test copy, one environment, two workstations (two mock runners).
- **Linked from:** guide 4.27; tour step `environments`; Help `phases#delivery-recipes`.
- **Re-record when:** the Environments page or its Releases switch changes.

### 4. Research

- **Slug:** `research`
- **Title:** Research
- **Sections covered:** 4 Research.
- **Scope in:** `New research card`; research `In progress`; `Published notes`.
- **Scope out:** Ledger, Interests.
- **Target length:** 1:00.
- **Script outline:**
  1. Open Research from the sidebar.
  2. `New research card`: write the question.
  3. The list of research `In progress`.
  4. Open a published note.
  5. Where the note is kept.
- **Prerequisites and test data:** demo project that started as research (or has published notes), one published note, one card in progress.
- **Linked from:** guide 4.13; tour step `research`; Help `project-conversion#research-as-a-stage`.
- **Re-record when:** the Research tab changes.

### 5. Desk

- **Slug:** `desk`
- **Title:** Your Desk
- **Sections covered:** 5 Desk.
- **Scope in:** the filters and groups (including `Handled by CEO` and `CEO decisions`); answering a question; `Add to ledger as`; `Accept recommendation`; the CEO's `Daily report` item.
- **Scope out:** how the CEO is configured, the Ledger page.
- **Target length:** 1:30.
- **Script outline:**
  1. Open Desk from the sidebar; the number shows what is waiting.
  2. Filters and groups.
  3. Open a question, answer it, and choose `Add to ledger as` a standing order.
  4. An item with a recommendation: `Accept recommendation`.
  5. The `Handled by CEO` and `CEO decisions` chips.
  6. Open the `Daily report` item.
- **Prerequisites and test data:** one question, one approval, one recommendation, two items handled by the CEO, one Daily report, all from demo cards (created by the mock runner or seeded through the API).
- **Linked from:** guide 4.5; tour step `desk`; Help `desk#desk-items`.
- **Re-record when:** Desk items, chips or answer controls change.

### 6. Intake

- **Slug:** `intake`
- **Title:** Intake: bring in tickets
- **Sections covered:** 6 Intake.
- **Scope in:** one ticket (the chat, `Start intake`); `Batch`; `Tell your CEO`; `Work with the BA directly`.
- **Scope out:** connecting Jira or GitHub (see Integrations).
- **Target length:** 1:00.
- **Script outline:**
  1. Open Intake from the sidebar.
  2. Paste one ticket reference and start the chat.
  3. The BA asks only what is missing.
  4. Switch to the `Batch` tab.
  5. `Tell your CEO` versus `Work with the BA directly`.
- **Prerequisites and test data:** demo Jira-style tickets served by the mock integration; Owner signed in.
- **Linked from:** guide 4.8; tour step `intake`; Help `intake-and-outbox#intake`.
- **Re-record when:** Intake tabs or buttons change.

### 7. Automations

- **Slug:** `automations`
- **Title:** Automations
- **Sections covered:** 7 Automations (nav id `schedules`).
- **Scope in:** `New automation` wizard (When, What, Details); `Run now`; `History`; Pause.
- **Scope out:** Interests schedules, webhook receivers.
- **Target length:** 1:30.
- **Script outline:**
  1. Open Automations from the sidebar.
  2. `New automation`: When (a weekday morning).
  3. What (create a card), then Details.
  4. Save; `Run now`.
  5. `History` of runs.
  6. Pause the automation.
- **Prerequisites and test data:** demo project; one existing automation with a short history.
- **Linked from:** guide 4.8; tour step `schedules`; Help `automations-and-integrations#triggers`.
- **Re-record when:** the wizard, History or the automations list changes.

### 8. Projects

- **Slug:** `projects`
- **Title:** Projects and their settings
- **Sections covered:** 8 Projects.
- **Scope in:** `New project`; the priority order; project settings and its jump chips; the budget; `Send invitation` to a project.
- **Scope out:** Environments, Releases, agents' allow-lists.
- **Target length:** 1:30.
- **Script outline:**
  1. Open Projects from the sidebar.
  2. `New project` with a repository.
  3. Drag a project up in the priority order.
  4. Open project settings and use the jump chips.
  5. Set the monthly budget.
  6. Invite a member by email with `Send invitation`.
- **Prerequisites and test data:** three demo projects; a demo invitee `guest@demo.local`.
- **Linked from:** guide 3.6 and 4.3; tour step `projects`; Help `projects#ranking`.
- **Re-record when:** the Projects page or project settings change.

### 9. Agents

- **Slug:** `agents`
- **Title:** Your agents
- **Sections covered:** 9 Agents.
- **Scope in:** `Hire agent` (role, seniority, Runtime, Effort, the project allow-list); Pause and Resume an agent; `Change model`; the recommendations (`Dismiss`, `Dismiss all`); the Project and Department filters.
- **Scope out:** the Org chart, the CEO page, roles and workflows.
- **Target length:** 1:30.
- **Script outline:**
  1. Open Agents from the sidebar.
  2. `Hire agent`: role, seniority, `Runtime`, `Effort`, allow-list.
  3. Pause and Resume an agent.
  4. `Change model`.
  5. A recommendation: act on it, then `Dismiss`.
  6. The Project filter.
- **Prerequisites and test data:** six demo agents on a mock workstation, one recommendation (seeded through the API), a CEO appointed.
- **Linked from:** guide 3.5 and 4.4; tour step `agents`; Help `agents#hiring`.
- **Re-record when:** the `Hire agent` dialog or the agent list controls change.

### 10. Org chart

- **Slug:** `org-chart`
- **Title:** The org chart
- **Sections covered:** 10 Org chart.
- **Scope in:** the chart (you, the CEO, the BAs, the teams by department); the `Chart view` and `List view` toggle; `Allowed on project`; an agent's details; the `Workstations and DevOps` panel.
- **Scope out:** hiring (Agents), the CEO page, roles and workflows.
- **Target length:** 1:00.
- **Script outline:**
  1. Open Org chart from the sidebar: who reports to whom.
  2. Click an agent for its details.
  3. Filter by `Allowed on project`.
  4. Switch between `Chart view` and `List view`.
  5. The `Workstations and DevOps` panel: one DevOps engineer per machine.
- **Prerequisites and test data:** the six demo agents of the Agents video on two projects, a CEO appointed, one workstation with its DevOps engineer.
- **Linked from:** guide 4.7; tour step `org-chart`; Help `org-chart-and-design#org-chart`.
- **Re-record when:** the org chart, its filter or its DevOps panel changes.

### 11. CEO

- **Slug:** `ceo`
- **Title:** Your CEO
- **Sections covered:** 11 CEO.
- **Scope in:** `Overview`; `Authority`; `Reporting & alerts`; Ask {CEO} (`New chat`, earlier chats); `Activity log` with `Undo`; the `Workstations` tab (`Move the CEO here`).
- **Scope out:** `Persona & instructions`, `Memory`, `Topics` (named in one sentence), Desk.
- **Target length:** 1:30.
- **Script outline:**
  1. Open CEO from the sidebar: `Overview`.
  2. `Authority`: what the CEO may decide.
  3. `Reporting & alerts`: when the daily report arrives.
  4. Ask {CEO}: start a chat and ask a question.
  5. `Activity log`: `Undo` one action.
  6. `Workstations` tab: `Move the CEO here`, shown once.
- **Prerequisites and test data:** appointed demo CEO with a short activity log and one chat (the mock runner answers).
- **Linked from:** guide 4.22; tour step `ceo`; Help `your-ceo#talking`.
- **Re-record when:** any CEO tab or the CEO chat changes.

### 12. Roles & workflows

- **Slug:** `roles-and-workflows`
- **Title:** Roles and workflows
- **Sections covered:** 12 Roles & workflows (nav id `org`; the page is titled "Organization").
- **Scope in:** the `Roles` tab; the `Workflows` tab (view, compare); the workflow builder; `Departments` and `Create department`; `Design with the BA`.
- **Scope out:** the Board, agent hiring.
- **Target length:** 1:30.
- **Script outline:**
  1. Open Roles & workflows from the sidebar.
  2. The `Roles` tab.
  3. The `Workflows` tab: open Code, then compare two versions.
  4. The builder: add a stage, save.
  5. `Create department`.
  6. `Design with the BA`: start a design chat.
- **Prerequisites and test data:** the default workflows plus one custom workflow; a BA allowed on a project.
- **Linked from:** guide 4.7 and 4.26; tour step `org`; Help `org-chart-and-design#custom-workflows`.
- **Re-record when:** the Roles, Workflows, Departments or Design with the BA tabs change.

### 13. Workstations

- **Slug:** `workstations`
- **Title:** Workstations
- **Sections covered:** 13 Workstations.
- **Scope in:** `Add a workstation` wizard; `Pair workstation` and `Pair with a code`; the workstation card (health, `Shifts at once`); `Check for updates`; git hosts in one sentence.
- **Scope out:** Integrations (Claude accounts, MCP servers), Environments, DevOps requests.
- **Target length:** 1:30.
- **Script outline:**
  1. Open Workstations from the sidebar.
  2. `Add a workstation`: the wizard steps and "Waiting for you to run the command".
  3. `Pair with a code`.
  4. A workstation card: health, `Shifts at once`.
  5. `Check for updates`.
- **Prerequisites and test data:** two demo workstations (one online, one offline) from mock runners.
- **Linked from:** guide 3.4 and 3.4a; tour step `workstations`; Help `workstations-and-installer#add-a-workstation`.
- **Re-record when:** the workstation wizard or the workstation card changes.

### 14. Releases

- **Slug:** `releases`
- **Title:** Releases
- **Sections covered:** 14 Releases.
- **Scope in:** the queue (`Release`, `Not now`, `Release to {n} of {m}`); what is live; history and its filters; `The standard rule`; `Freeze all releases` and `Lift the freeze`; advanced rule sets.
- **Scope out:** Environments setup.
- **Target length:** 1:00.
- **Script outline:**
  1. Open Releases from the sidebar.
  2. The queue: `Release` one item, `Not now` for another.
  3. What is live.
  4. History and its filters.
  5. `The standard rule`; the advanced rule sets.
  6. `Freeze all releases`, then `Lift the freeze`.
- **Prerequisites and test data:** two queued demo releases, one live, a short history.
- **Linked from:** guide 4.28; tour step `releases`; Help `phases#releases`.
- **Re-record when:** the Releases page changes.

### 15. Integrations

- **Slug:** `integrations`
- **Title:** Integrations
- **Sections covered:** 15 Integrations.
- **Scope in:** the workstation chooser; the tiles (one Claude Code tile per account, `Connect another account`); how a tile connects (`Start sign-in`, `Test`, `Remove`); git hosts, Jira, MCP `Sign in` and sign out.
- **Scope out:** adding a workstation, Environments, DevOps requests.
- **Target length:** 1:30.
- **Script outline:**
  1. Open Integrations from the sidebar and choose the workstation.
  2. The Claude Code tiles: the main account and one more.
  3. `Connect another account`: the connect dialog ("How do you want to connect?"); cancel.
  4. A git host tile and the Jira tile: what each is for.
  5. An MCP server: `Sign in` and sign out.
- **Prerequisites and test data:** two demo workstations, two demo Claude accounts (state seeded through the API, no real login), one demo MCP server.
- **Linked from:** guide 4.19; tour step `integrations`; Help `integrations#connect`.
- **Re-record when:** the Integrations tiles or the connect dialog change.

### 16. Metrics

- **Slug:** `metrics`
- **Title:** Metrics
- **Sections covered:** 16 Metrics.
- **Scope in:** the Project filter and the range (`7 days`, `14 days`, `30 days`, `90 days`); the panels `Throughput`, `Time blocked on you`, `Bounce rate per builder`, `Bugs escaped past test`, `Duration`, `Queue depth`.
- **Scope out:** costs (see Costs).
- **Target length:** 1:00.
- **Script outline:**
  1. Open Metrics from the sidebar; choose a range and a project.
  2. `Throughput` and `Time blocked on you`.
  3. `Bounce rate per builder` and `Bugs escaped past test`.
  4. `Duration` and `Queue depth` per column.
- **Prerequisites and test data:** 30 days of generated demo activity across two projects (cards, transitions and shifts inserted by the spec's own seed helper, since a mock run does not span days).
- **Linked from:** guide 4.29; tour step `metrics`; Help `agents#hr-board`.
- **Re-record when:** the Metrics panels change.

### 17. Costs

- **Slug:** `costs`
- **Title:** Costs and budgets
- **Sections covered:** 17 Costs.
- **Scope in:** the range (`This month`, `Last 30 days`, `Last month`) and the Project filter; `Total spend`; costs `By day`, `By project`, `By agent` and `By model`; the budget meter and `Organization budget`; `What the agents delivered`; `Export CSV`; `Currency and prices`.
- **Scope out:** setting a project budget (shown in project settings, see Projects), Metrics.
- **Target length:** 1:15.
- **Script outline:**
  1. Open Costs from the sidebar (Owners and Admins only); choose `Last 30 days`.
  2. `Total spend` and the daily chart.
  3. `By project`, `By agent`, `By model`.
  4. The budget meter and `Organization budget`.
  5. `What the agents delivered`.
  6. `Export CSV`; where `Currency and prices` are set.
- **Prerequisites and test data:** 30 days of demo shift costs across two projects (inserted by the spec), one project with a budget at about 80 percent.
- **Linked from:** guide 4.6; tour step `costs`; Help `budgets-and-costs#monthly-budgets`.
- **Re-record when:** the Costs page changes.

### 18. Interests

- **Slug:** `interests`
- **Title:** Interests
- **Sections covered:** 18 Interests.
- **Scope in:** `New interest`; the look and digest schedules; `Deliver now`; taste rules; the `Quiet cap`; archive and restore.
- **Scope out:** Automations.
- **Target length:** 1:30.
- **Script outline:**
  1. Open Interests from the sidebar.
  2. `New interest` with a topic.
  3. Set the schedules for looking and for the digest.
  4. The `Taste` tab and the `Quiet cap`.
  5. `Deliver now`.
  6. Archive and restore.
- **Prerequisites and test data:** the interests feature on; two demo interests with delivered digests (mock runner).
- **Linked from:** guide 4.9; tour step `interests`; Help `interests#run-and-delivery`.
- **Re-record when:** the Interests list or detail page changes.

### 19. Ledger

- **Slug:** `ledger`
- **Title:** The Ledger
- **Sections covered:** 19 Ledger.
- **Scope in:** `Search`; the scope and Project filters; `Add entry`; standing orders; the entry kinds (requirement, decision, standing order); edit, history and retire; `Show retired`.
- **Scope out:** Desk's `Add to ledger as`, Vaults.
- **Target length:** 1:15.
- **Script outline:**
  1. Open Ledger from the sidebar and search.
  2. `Add entry` as a standing order.
  3. Edit and the history of an entry.
  4. Retire an entry; `Show retired`.
- **Prerequisites and test data:** about twelve demo entries including one retired.
- **Linked from:** guide 4.5; tour step `ledger`; Help `ledger-and-vaults#ledger`.
- **Re-record when:** the Ledger page changes.

### 20. Vaults

- **Slug:** `vaults`
- **Title:** Vaults
- **Sections covered:** 20 Vaults.
- **Scope in:** `Register a vault` (git URL or local folder); `Sync interval`; a vault card; `Edit`; the conflict state `Sync paused: conflict` and `I resolved it, resume`.
- **Scope out:** the Ledger.
- **Target length:** 1:00.
- **Script outline:**
  1. Open Vaults from the sidebar.
  2. `Register a vault`: a git vault, then a local folder.
  3. The vault card and its sync interval; `Edit`.
  4. What a paused sync looks like and how to resume it.
- **Prerequisites and test data:** one demo git vault (a throwaway bare repository on the stack's scratch directory), one demo project.
- **Linked from:** guide 4.3a; tour step `vaults`; Help `ledger-and-vaults#vaults`.
- **Re-record when:** the Vaults page changes.

### 21. Settings

- **Slug:** `settings`
- **Title:** Your settings
- **Sections covered:** 21 Settings.
- **Scope in:** `Your picture` and `Change picture`; `Your time zone`; two-factor security; `Monday briefing`; `Notifications`; `Weekly blog digest`; `Expert mode for code changes`.
- **Scope out:** organization-wide settings (see Organization), the daily report time (CEO).
- **Target length:** 1:15.
- **Script outline:**
  1. Open Settings from the sidebar: picture and time zone.
  2. Two-factor security: where it is set up (do not enrol on camera).
  3. `Monday briefing` and `Notifications`.
  4. `Weekly blog digest`.
  5. `Expert mode for code changes`: off by default.
- **Prerequisites and test data:** Owner signed in.
- **Linked from:** guide 4.30; tour step `settings`; Help `getting-started#your-settings`.
- **Re-record when:** the Settings page changes.

### 22. Organization

- **Slug:** `organization`
- **Title:** Your organization
- **Sections covered:** 22 Organization.
- **Scope in:** the tabs `General`, `Members`, `Invitations`, `Guests`, `E-mail inbox`, `Project links`, `Plan & limits` and `Billing`; `Invite member` and `Send invitation`; `Revoke`; the role of each member.
- **Scope out:** billing detail, the platform area.
- **Target length:** 1:30.
- **Script outline:**
  1. Open Organization from the sidebar: `General` and your role.
  2. `Members`: roles, then `Invite member` and `Send invitation`.
  3. `Invitations`: `Resend` and `Revoke`.
  4. `Guests`.
  5. `E-mail inbox` and `Project links`, one sentence each.
  6. `Plan & limits`: what is used and the limits.
- **Prerequisites and test data:** Owner signed in; two demo members, one pending invitation to `guest@demo.local`.
- **Linked from:** guide 4.1 and 4.2; tour step `organization`; Help `organizations-and-roles#members-and-invitations`.
- **Re-record when:** the Organization tabs change.

### 23. Help

- **Slug:** `help`
- **Title:** The Help centre
- **Sections covered:** 23 Help.
- **Scope in:** the Help page: `Search the help articles`; `Articles`, `Glossary`, `Blog`; `What’s new`; `Contact us` and `My requests`; the tour replay; the `?` button for the page behind you.
- **Scope out:** the content of any article, the platform Help.
- **Target length:** 1:00.
- **Script outline:**
  1. Open Help from the sidebar.
  2. Search for "budget" and open an article.
  3. The `Glossary`.
  4. `What’s new` and `Blog`.
  5. `Contact us` and `My requests`.
  6. The `?` button in the top bar and the tour replay.
- **Prerequisites and test data:** Owner signed in; one answered demo request in `My requests`.
- **Linked from:** guide chapter 10; tour step `help`; Help `getting-started#the-sidebar`.
- **Re-record when:** the Help centre layout changes.

### P. Platform area

- **Slug:** `platform-area`
- **Title:** The platform area
- **Sections covered:** P Platform area (platform administrator; separate shell).
- **Scope in:** `Organizations`, `Invitations`, `Accounts`, `Billing`, `Support`, `Blog`, `API keys`, `Runners`, `Platform team`, `Inbound mail`, `Audit log`.
- **Scope out:** everything inside an organization.
- **Target length:** 2:00.
- **Script outline:** 1. `Organizations`; 2. `Invitations`; 3. `Accounts`; 4. `Billing`; 5. `Support` and `Blog`; 6. `API keys`, `Runners`, `Platform team`, `Inbound mail`; 7. `Audit log`.
- **Prerequisites and test data:** platform administrator login (the stack's `platform@e2e.test`, which sets up two-factor login at first sign-in: the spec completes that before the camera rolls), two demo organizations.
- **Linked from:** guide chapter 7; platform tour step `welcome`; Help `organizations-and-roles#platform-area`.
- **Re-record when:** any platform page changes.

### 24. Discovery

- **Slug:** `discovery`. **Title:** Discovery: from an idea to a PRD. **Section:** Discovery (sidebar, Work).
- **Scope in:** `New discovery` (title, starting idea, project, `How should the analyst work?`: Facilitator, Partner, Ideate for me; the `CEO` choices; `Time limit`; `Cost limit in USD (optional)`), the question card with its quick answers, the phase stepper and the panel, a proposal and `Apply`, the PRD in the `Draft` panel, `Validate against the checklist`, `Approve`, `Hand to BA`, `Pause`.
- **Scope out:** the Boardroom hand-over (`Pull into PRD`), documents list, time-up choices (`Extend`, `Wrap up now`).
- **Prerequisites and test data:** a mock workstation with an analyst (Ana) and a BA (Ben); the mock analyst asks its fixed run of questions (about invoicing), so the title and idea are an invoicing idea.
- **Linked from:** Help `discovery#start`; the tour step and page help of Discovery.
- **Re-record when:** the New discovery dialog or the session page layout changes.

### 25. Documents

- **Slug:** `documents`. **Title:** Documents. **Section:** Documents (sidebar, Knowledge).
- **Scope in:** the list (newest first), the kind chips (`PRD`, `Minutes`, ...) and the status chips, opening a PRD, the version picker, `Approve` (with the copy to the project vault), `Reopen`, the link back to `All documents`.
- **Prerequisites and test data:** a project with a mock workstation (its project vault), three documents created through the API: an approved brief, a PRD with two versions in review, draft minutes.
- **Linked from:** Help `discovery#documents`; page help of Documents.

### 26. Boardroom

- **Slug:** `boardroom`. **Title:** Boardroom: a debate with a Chair. **Section:** Boardroom (sidebar, Work).
- **Scope in:** `New boardroom` (topic, brief, format, the fixed Optimist and Devil's Advocate, library personas, a persona cast from a brief, `Suggest a cast`, `Round cap`, cost and time limit, models), the sealed first round, the whiteboard, the Chair's decision point with an `@` mention and `Decide`, a note added, voted and moved, `End session`, the minutes, `Pull into PRD`.
- **Prerequisites and test data:** a mock workstation with an analyst (for the PRD session). The mock Chair pauses for a decision through the runner switch `AOM_MOCK_BOARD_DECIDE=1` (so the topic does not carry the test markers); the mock step is 7 s so the sealed round can be seen.
- **Linked from:** Help `boardroom#start`; the tour step and page help of Boardroom.

### 27. Capabilities

- **Slug:** `capabilities`. **Title:** Capabilities and packs. **Section:** Capabilities (sidebar, Knowledge; Settings > Capabilities).
- **Scope in:** the `Registry` and its filters, the `Starter gallery`, `Add a pack by git URL` (and the private repository box), `Review and approve` with the flagged script, `Hire from this pack`, `My capabilities` (`New pack`, `Start writing`, the editor that checks as you type, `Save to workstation`), `Project skills` (`Mark reviewed`, `Block`), `Skill grants`.
- **Prerequisites and test data:** a local git repository stands in for the public one: a `git` wrapper first on the runner's PATH maps `https://github.com/acme/release-skills.git` to it (the runner clones packs in an isolated git environment; `AOM_PACKS_ALLOW_LOCAL=1`). A skill is pushed to the toy repository (`.claude/skills/release-checklist`) and a card is run so the runner reads the project's skills.
- **Linked from:** Help `capabilities#packs`; the tour step and page help of Capabilities.

### 28. AI runtimes and model providers

- **Slug:** `ai-runtimes`. **Title:** AI runtimes and model providers. **Section:** Integrations > AI runtime and Settings > Model providers (no sidebar entry of its own: the registry entry has `nav: null` and `paths: ['/settings/providers']`).
- **Scope in:** the tiles (installed or not with the install command, signed in, key in effect), `Sign in` / `Sign in again`, `Set key`, `Add a named account`, `Make main`, `Allow projects to use my accounts`, the link to `Settings, Model providers`, the organization key (`Set key`, workstations that get it, `Monthly cap (USD)`, `Not shared`, `Revoke`).
- **Prerequisites and test data:** Codex is reported as installed with one signed-in main account by writing the runner's runtime report into the database (the mock runner has no Codex); the key flows are real with an obviously fake key (`sk-ant-demo-...`).
- **Linked from:** Help `ai-runtimes#accounts`; page help of Model providers.

### 29. Governance

- **Slug:** `governance`. **Title:** Governance: approvals, grants, audit and offboarding. **Section:** none of its own (`nav: null`): Desk notifications, Agents, Organization.
- **Scope in:** the approval buttons of a notification and the confirm page they open (`Approve`; once, 15 minutes, only for you), `What it may do` on an agent's card, `Approval gates` (`Ask me before: merge and push`), Organization > `Audit log` (`Download`, CSV), removing a member (`Remove from organization`, the offboarding checklist and its report).
- **Prerequisites and test data:** a DevOps approval on the Desk; the notification link is made with the server's own signing key (the recording browser has no push service); a second member (Jamie Lee) to remove.
- **Linked from:** Help `organizations-and-roles#audit-log`.

## Re-record map

Each section belongs to exactly one video. G is also re-recorded for the five sections whose first-run flow it shows.

| # | Section | Video (slug) | Also re-record G when |
|---|---|---|---|
| 1 | Board | `board` | New card (the dialog or sidebar button) changes |
| 2 | Backlog | `backlog` | never |
| 3 | Environments | `environments` | never |
| 4 | Research | `research` | never |
| 5 | Desk | `desk` | answering a question on the Desk changes |
| 6 | Intake | `intake` | never |
| 7 | Automations | `automations` | never |
| 8 | Projects | `projects` | New project (the dialog or its repository step) changes |
| 9 | Agents | `agents` | the Hire agent dialog changes |
| 10 | Org chart | `org-chart` | never |
| 11 | CEO | `ceo` | never |
| 12 | Roles & workflows | `roles-and-workflows` | never |
| 13 | Workstations | `workstations` | the Add a workstation wizard or the Get started checklist changes |
| 14 | Releases | `releases` | never |
| 15 | Integrations | `integrations` | never |
| 16 | Metrics | `metrics` | never |
| 17 | Costs | `costs` | never |
| 18 | Interests | `interests` | never |
| 19 | Ledger | `ledger` | never |
| 20 | Vaults | `vaults` | never |
| 21 | Settings | `settings` | never |
| 22 | Organization | `organization` | never |
| 23 | Help | `help` | the Get started button or the tour entry point changes |
| 24 | Discovery | `discovery` | never |
| 25 | Documents | `documents` | never |
| 26 | Boardroom | `boardroom` | never |
| 27 | Capabilities | `capabilities` | never |
| 28 | AI runtimes, Model providers | `ai-runtimes` | never |
| 29 | Governance | `governance` | never |
| P | Platform area | `platform-area` | never |

A change to the sidebar itself (labels, order, a new entry) re-records G and every video whose first beat opens a changed entry.

## Decisions taken

1. Grouping: one video per section (the owner's decision), so 24 section videos plus G. The earlier plan of 17 grouped videos is dropped.
2. Platform area: recorded as its own video (`platform-area`).
3. Order of recording: Getting started first, then by how often the section changes.
4. All 25 earlier videos were re-recorded with the Kokoro `af_heart` voice at the default speed against the current UI (2026-10-25). All 31 videos are published.
5. The two cross-cutting videos (`ai-runtimes`, `governance`) have no sidebar entry, so they are not in the tour. They show in their Help article (`videosForArticle` no longer needs a nav id) and, for `ai-runtimes`, behind `Watch the video` on the Model providers page (`paths` in the registry). Decided by default (the owner was asleep).
6. A pack is shown from a local git repository mapped to a public-looking https URL by a `git` wrapper on the recorded runner's PATH; the mock Chair has a runner switch (`AOM_MOCK_BOARD_DECIDE=1`) instead of topic markers. Neither touches product code.
