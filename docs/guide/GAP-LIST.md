# Gap list: user guide and in-app tutorial against the current app

Audited against the working branch (`main` at 38ff083d). Artefacts:

- **guide**: `docs/USER-GUIDE.md`.
- **tutorial**: the guided tour (`apps/web/src/lib/tour.ts`) and the Help-article sections its "Read more" links open (marked *tour Read more*).
- **help (follow-up)**: other Help articles and per-page help. Not part of the tutorial; recorded here, not fixed.
- **app issue**: the app is wrong, not the documentation. Raised as a backlog suggestion, not fixed.

Types: outdated, missing, wrong. "Fix made" is the change in this delivery; `figure` means a screenshot that had to be re-taken from the current app; all were re-taken in the capture run (see "Figures").

## Section inventory

Taken from `buildNav` in `apps/web/src/components/shell/nav-config.ts` (Owner, every feature on, project with environments and research), plus Help and the platform area. These names are used in the guide (Appendix A), the tour, the video plan and below.

| # | Section | Nav id | Group | Who sees it |
|---|---|---|---|---|
| 1 | Board | `board` | Work | all |
| 2 | Backlog | `backlog` | Work | all (edit: Owner, Admin) |
| 3 | Environments | `environments` | Work | code projects |
| 4 | Research | `research` | Work | projects with research |
| 5 | Desk | `desk` | Work | all |
| 6 | Intake | `intake` | Work | Owner, Admin |
| 7 | Automations | `schedules` | Work | all |
| 8 | Projects | `projects` | Work | all |
| 9 | Agents | `agents` | Organization | all |
| 10 | Org chart | `org-chart` | Organization | all |
| 11 | CEO | `ceo` | Organization | Owner, Admin |
| 12 | Roles & workflows | `org` | Organization | all |
| 13 | Workstations | `workstations` | Organization | all |
| 14 | Releases | `releases` | Organization | all (release: Owner, Admin) |
| 15 | Integrations | `integrations` | Organization | all |
| 16 | Metrics | `metrics` | Organization | all |
| 17 | Costs | `costs` | Organization | Owner, Admin |
| 18 | Interests | `interests` | Knowledge | interests feature |
| 19 | Ledger | `ledger` | Knowledge | all |
| 20 | Vaults | `vaults` | Knowledge | Owner, Admin |
| 21 | Settings | `settings` | footer | all |
| 22 | Organization | `organization` | footer | all |
| 23 | Help | `help` | footer | all |
| P | Platform area | `platform-nav-*` | separate shell | platform administrator |

## 1 Board

| Artefact | Type | Documentation says | App does | Fix made |
|---|---|---|---|---|
| guide | outdated | 2.2 and 4.12 do not mention Pause project, the Board/Backlog tabs, cost header or held badges | the board has all of these | 2.2 "Around the board" paragraph; figures `board-hero`, `board-left`, `board-qa` re-taken in the capture run |
| guide | missing | 4.12 lists the QA chip only | a "Waiting for my approval (n)" chip exists | chips "Waiting for my QA (n)" and "Waiting for my approval (n)" |
| guide | outdated | FAQ phone answer lacks phone controls | Filters, Project actions, Move to… | FAQ answer rewritten; figures `m-board`, `m-card` re-taken in the capture run |
| guide | outdated | figures `phase`, `run-panel`, `card-detail` | follow-ups pick environments; "Test copy"; reviewer risk panel | figures re-taken in the capture run |
| tutorial | no gaps | | | |
| help (follow-up) | outdated | `board-and-cards.md` reading-the-board lacks the filter chips and Pause project; page help board and card detail | | `board-and-cards.md` reading-the-board: QA and approval chips, "Board actions" with Pause project; page help board (Pause project, Archive, QA/approval chips). Blocked/Rework/Unassigned already present. Card detail page help not re-checked |

## 2 Backlog

| Artefact | Type | Documentation says | App does | Fix made |
|---|---|---|---|---|
| guide | wrong | 4.3b: Owners, Admins and Members manage the backlog | only Owners and Admins manage it; every project member can read it | corrected |
| guide | wrong | "Send selected" | "Send {n} to the BA" | corrected |
| guide | wrong | sort by "date created" | the sort is "Newest" | corrected |
| guide | missing | 4.3b sits before 4.3a, is not in the contents, has no figure, has no Appendix A row | | order fixed; figure `backlog`; Appendix A row |
| tutorial | missing | no tour step | sidebar entry Backlog | step `backlog`; Help article section `board-and-cards#backlog` (anchor added; role rule added) |
| help (follow-up) | outdated | page help backlog | | page help backlog: Owner and Admin actions (add, flag, send, drop), Owner items toggle, status chips, sort |

## 3 Environments

| Artefact | Type | Documentation says | App does | Fix made |
|---|---|---|---|---|
| guide | wrong | 4.27: "Stop using guided deploys", "Recipe mode" | removed; the page has a Releases On/Paused switch with a "Pause releases?" dialog | removed; switch described |
| guide | wrong | Project settings has a "Delivery" section (4.27, 4.21, Appendix A) | no such section; secrets are under Show technical details | removed everywhere |
| guide | wrong | button names | "Not sure: let DevOps look", "Use this", "Check", "Reconnect", "Use another computer" | corrected |
| guide | missing | the Ready state, the releases-paused note, a figure | | added; figure `environments` (the Environments page, "Your app"; replaces `run-settings`, which is removed) |
| tutorial | missing | no tour step | sidebar entry Environments | step `environments`; *tour Read more* `phases#delivery-recipes`: "Delivery" paragraph replaced by the Releases switch |
| help (follow-up) | outdated | `phases.md` Change server/computer; page help environments | | `phases.md`: More menu labels (Change server/computer, not "Change place"), Move to a new server button, place in use blocks removal; page help environments (Releases switch, More menu) |

## 4 Research

| Artefact | Type | Documentation says | App does | Fix made |
|---|---|---|---|---|
| guide | no gaps | 4.13 and its figure are current; Appendix A row added | | Appendix A row |
| tutorial | missing | no tour step | sidebar entry Research | step `research` (`project-conversion#research-as-a-stage` exists) |
| help (follow-up) | wrong | page help research links `projects#project-types`, which does not describe the tab | | `projects.md` new "The Research tab" section (`#research-tab`); page help research now links to it |
| app issue | wrong | | "New research card" does not preselect the research type (`ResearchTab.tsx:65,100`, `CardNew.tsx:32`) | backlog suggestion |

## 5 Desk

| Artefact | Type | Documentation says | App does | Fix made |
|---|---|---|---|---|
| guide | missing | 4.5 | Accept recommendation, the chips Handled by CEO and CEO decisions, groups | added |
| guide | outdated | "Floor report" kind | retired: the CEO's "Daily report <date>" | replaced; figure `desk-floor-report` replaced by `desk-daily-report` |
| guide | outdated | figures `desk`, `desk-question`, `m-desk` | changed | figures re-taken in the capture run |
| tutorial | no gaps | tour step; *tour Read more* `desk#desk-items` was outdated | CEO handling, chips, Accept recommendation | `desk#desk-items` updated |
| help (follow-up) | outdated | `desk.md` BA routing, "Remember this for the CEO", kind list; page help desk | | `desk.md`: CEO triage (not BA), Remember this for the CEO step, kind badges and labels, CEO report label, Accept recommendation, filters; page help desk (Handled by CEO, CEO decisions, Accept recommendation) |
| app issue | wrong | | the Intake button shows for every role and with the integrations feature off (`Desk.tsx:191-193`) | backlog suggestion |

## 6 Intake

| Artefact | Type | Documentation says | App does | Fix made |
|---|---|---|---|---|
| guide | no gaps | 4.8 and figures current | | added the One ticket / Batch tabs and the Admin's "Start intake" wording |
| tutorial | outdated | step text omits Batch and CEO hand-over | Batch tab; "Tell your CEO" | step text; *tour Read more* `intake-and-outbox#intake` (buttons by role; "Outbox approval" → "Outbound update") |
| help (follow-up) | outdated | page help intake | | page help /intake: Tell your CEO (Owner only), Work with the BA directly label, batch project and note; article already correct |

## 7 Automations

| Artefact | Type | Documentation says | App does | Fix made |
|---|---|---|---|---|
| guide | wrong | 4.8: an interests digest | digest options are "Floor report (organization)" and "Project summary" | corrected (labels quoted as shown) |
| guide | outdated | "BA tasks"; "BA settings" in the chapter 4 table | "Ask the CEO" | corrected |
| tutorial | no gaps | | | |
| help (follow-up) | missing | page help: Send test (webhook and e-mail), Switch the secret off, "Run by the system" | | page help /automations: Send test for e-mail, Switch the secret off, Run by the system section |
| app issue | outdated | | the wizard still calls the digest "Floor report (organization)" (`ScheduleWizard.tsx:1136,1171`) | backlog suggestion (stale UI copy) |

## 8 Projects

| Artefact | Type | Documentation says | App does | Fix made |
|---|---|---|---|---|
| guide | wrong | 4.3: "Invite" | "Invite by email" and "Send invitation" | corrected |
| guide | missing | 4.3 | Workflows, Claude account, Owner approval, Manual QA, Full suite, Testing and decisions, PR branch prefix, Remove finished card branches, jump chips | added; figure `project-settings` re-taken in the capture run |
| guide | wrong | Appendix A: Delivery | none | corrected |
| tutorial | no gaps | | | |
| help (follow-up) | outdated | page help settings and projects (Paused badge; ordering disabled under a department filter) | | page help /projects (Paused badge, ordering off under a department filter) |

## 9 Agents

| Artefact | Type | Documentation says | App does | Fix made |
|---|---|---|---|---|
| guide | outdated | 3.5: the BA reports; no Planner or Pre-reviewer; no Runtime or Effort | | corrected |
| guide | wrong | 4.4: an empty list benches the agent | hiring refuses an empty list; benching is in the Projects dialog | corrected |
| guide | missing | 4.4 | Pause/Resume, Re-home, face re-roll | added |
| guide | outdated | "ignore" recommendations | Dismiss and Dismiss all (N) | corrected |
| guide | removed | "Start chat", "Send as a task" | button "Ask <CEO>" | replaced; figures `hr`, `hr-recs` re-taken in the capture run |
| tutorial | no gaps | *tour Read more* `agents#hiring` lacked Planner/Pre-reviewer | | updated (`agents.md` lists the roles) |
| help (follow-up) | wrong | `agents.md` Allow-lists: an empty list benches the agent; Pause/Resume, Re-home, Dismiss missing; page help agents | | `agents.md` "Pause and re-home" section (empty-list benching already stated); page help /agents and /hr (Pause or Resume). Dismiss: no Agents-page control found (desk only), not added |

## 10 Org chart

| Artefact | Type | Documentation says | App does | Fix made |
|---|---|---|---|---|
| guide | outdated | 4.7: you, then the BAs | you, the CEO (always there), then the BAs; filter "Allowed on project"; panel "Workstations and DevOps"; "Hire a BA" | corrected; figure `org-chart` re-taken in the capture run |
| tutorial | no gaps | *tour Read more* `org-chart-and-design#org-chart` lacked the CEO tier | | updated |
| help (follow-up) | outdated | `org-chart-and-design.md` escalation; page help | | `org-chart-and-design.md` escalation paragraph (routing: CEO before BA) and status list; page help /org-chart status. Chart "Escalates to" disagrees with routing: see report |

## 11 CEO

| Artefact | Type | Documentation says | App does | Fix made |
|---|---|---|---|---|
| guide | wrong | 4.22: a "Disable" button; Pause hands the reporter job to the BA | neither exists | removed |
| guide | wrong | moving the CEO | "Move the CEO here" on the Workstations tab | corrected |
| guide | wrong | tab names | Overview, Authority, Reporting & alerts, Persona & instructions, Memory, Tasks, Topics, Activity log, Workstations | corrected |
| guide | missing | the /ceo-chat page | New chat, Chats, "Go to the current chat" | added |
| guide | outdated | 4.11 duplicates 4.22; its `settings` figure | | 4.11 shortened to "The daily report" pointing to 4.22; figures `ceo`, `ceo-chat`, `ceo-reporting` |
| guide | wrong | 4.22 diagnostics | not available to customer organizations yet | note added |
| tutorial | missing | no tour step | sidebar entry CEO (Owner, Admin) | step `ceo` (`your-ceo#talking` exists) |
| help (follow-up) | outdated | `your-ceo.md` lines 8 and 42, `ba-reporter.md` line 39; page help /org/ceo and /ceo-chat | | `your-ceo.md` workstation wording and new "Questions from agents and escalation" section (routing, 20-minute pass-on, Accept recommendation); `ba-reporter.md` tab name and "CEO report" label, escalation link; page help /org/ceo (five missing tabs), /ceo-chat (Owner only, refused while running) |
| app issue | outdated | | `CeoChat.tsx:65` says the CEO "has to be appointed first" | backlog suggestion (stale UI copy) |

## 12 Roles & workflows

| Artefact | Type | Documentation says | App does | Fix made |
|---|---|---|---|---|
| guide | wrong | 4.7: "Start a design chat" | on the "Design with the BA" tab, needs a BA allowed on any project; the page is titled "Organization" | corrected |
| guide | outdated | 4.26 and 4.20: "Design" stage | "Investigate & design"; "Merge review" stage | corrected; figure `org-workflows` re-taken in the capture run |
| tutorial | missing | no tour step | sidebar entry Roles & workflows | step `org` (title "Roles & workflows") |
| help (follow-up) | outdated | `org-chart-and-design.md` current version, Code v6 stages, "Create department"; page help builder | | `org-chart-and-design.md` built-in Code v6 and Research stage lists, Create department, workflow/version text; `projects.md` Research stages. "Current version" statement not re-verified beyond the v6 definition; page help builder not re-checked line by line |
| app issue | outdated | | `OrgDesigner.tsx:696` "Only the organization owner designs with the BA" (Admins can); `:652,707` "HR board" | backlog suggestion (stale UI copy) |

## 13 Workstations

| Artefact | Type | Documentation says | App does | Fix made |
|---|---|---|---|---|
| guide | missing | 3.4 | Pair workstation, Pair with a code, Pair it with a code instead | added |
| guide | missing | 4.24a | Claude accounts table | added |
| guide | wrong | 9.1 wizard wording | "Waiting for you to run the command" | corrected |
| guide | outdated | 9.2 "Disconnected" | no such state | removed; figure `ws-offline` re-taken in the capture run |
| tutorial | no gaps | | | |
| help (follow-up) | outdated | `workstations-and-installer.md` (Check for updates, card contents); page help | | `workstations-and-installer.md` card contents and a "Check for updates" paragraph; page help /workstations card entry |
| app issue | wrong | | three labels for pairing (minor) | backlog suggestion (stale UI copy) |

## 14 Releases

| Artefact | Type | Documentation says | App does | Fix made |
|---|---|---|---|---|
| guide | wrong | 4.27 labels | "The standard rule", "Freeze all releases" / "Lift the freeze", "Advanced: rule sets" | corrected |
| guide | missing | no own section | Not now, "Release to N of M", the Releases paused badge, history filters | new 4.28 Releases; figure `releases` |
| tutorial | missing | no tour step | sidebar entry Releases | step `releases`; new Help section `phases#releases` |
| help (follow-up) | missing | page help releases | | already fixed on main: `/releases` page help exists; Rules entry now says Owner and Admins only and Freeze is per rule set |

## 15 Integrations

| Artefact | Type | Documentation says | App does | Fix made |
|---|---|---|---|---|
| guide | outdated | 3.4a | one Claude tile per account, Connect another account, MCP Sign in / Sign out | corrected; figure `integrations` re-taken in the capture run |
| guide | wrong | Appendix A puts integrations under Automations | own sidebar entry | corrected |
| tutorial | missing | no tour step | sidebar entry Integrations | step `integrations`; *tour Read more* `integrations#connect` brought up to date |
| help (follow-up) | missing | page help integrations | | already fixed on main: `/integrations` page help exists and its AI runtime and tile controls were re-checked against `IntegrationTile.tsx` and `AiRuntimeSection.tsx` |

## 16 Metrics

| Artefact | Type | Documentation says | App does | Fix made |
|---|---|---|---|---|
| guide | missing | only an Appendix A row | Project filter, 7/14/30/90-day range, Throughput, Time blocked on you, Bounce rate per builder, Bugs escaped past test, Duration with Shift time per agent, Queue depth per column | new 4.29 Metrics; figure `metrics` |
| tutorial | missing | no tour step | sidebar entry Metrics | step `metrics`; *tour Read more* `agents#hr-board` list fixed |
| help (follow-up) | missing | page help metrics | | already fixed on main: `/metrics` page help exists; its six section names match `pages/Metrics.tsx` |

## 17 Costs

| Artefact | Type | Documentation says | App does | Fix made |
|---|---|---|---|---|
| guide | wrong | 4.6 "Value report" | panel "What the agents delivered"; "Currency and prices" panel | corrected |
| tutorial | wrong | "by project, agent and day"; budgets changed on this page | by project, agent, model and day; budgets are set in each project's settings | step text; *tour Read more* `budgets-and-costs#monthly-budgets` (BA Budget signal → the CEO's daily report) |
| help (follow-up) | outdated | `budgets-and-costs.md` value and code-map panels, Org overhead and Management rows; page help | | `budgets-and-costs.md` "The Costs page" section; page help /costs (overhead, management, code map) |
| app issue | wrong | | the Project dropdown is built from the report and shrinks to the selected project (`Costs.tsx:164,229`) | backlog suggestion |

## 18 Interests

| Artefact | Type | Documentation says | App does | Fix made |
|---|---|---|---|---|
| guide | wrong | 8.3: a vault choice | interests live in the organization vault | removed |
| guide | missing | 4.9 | Deliver N now, Archive / Restore / Delete permanently, list filters | added |
| tutorial | no gaps | | | |
| help (follow-up) | wrong | page help /interests/:id "vault is fixed" wording | | page help /interests/:id Settings tab: vault folder shown on Overview, not changed here (the "fixed once run" rule has no trace in code) |

## 19 Ledger

| Artefact | Type | Documentation says | App does | Fix made |
|---|---|---|---|---|
| guide | missing | 4.5 | Project filter | added; figure `ledger` re-taken in the capture run |
| tutorial | outdated | *tour Read more* `ledger-and-vaults#ledger` | Retire, Show retired, the "May contradict another order" badge | updated |
| help (follow-up) | outdated | "Editing a standing order", "Which vault an agent reads"; page help | | "Editing a standing order" and "Which vault an agent reads" already in `ledger-and-vaults.md`; page help /ledger (Show retired, Retire, Edit and History, contradiction badge) |

## 20 Vaults

| Artefact | Type | Documentation says | App does | Fix made |
|---|---|---|---|---|
| guide | no gaps | local folders already covered | | figure `vaults` re-taken in the capture run |
| tutorial | outdated | step: "sync to your workstations … Secrets stay on the machines you choose" | git vaults sync; a project vault can be a local folder | step text; *tour Read more* `ledger-and-vaults#vaults` |
| help (follow-up) | outdated | the article does not say how a local-folder vault is created; page help | | `ledger-and-vaults.md` automatic local folder vault and how to sync it; page help /settings/vaults (local folder badge) |
| app issue | wrong | | the empty state shows "Register a vault" to users who cannot register; the dialog opens empty (`Vaults.tsx:74-77,293`) | backlog suggestion (stale UI copy) |

## 21 Settings

| Artefact | Type | Documentation says | App does | Fix made |
|---|---|---|---|---|
| guide | missing | no section | Notifications (devices, quiet hours), Monday briefing, two-factor, blog digest, expert mode | new 4.30 Your settings; figure `settings` re-taken in the capture run |
| guide | wrong | 3.2 button name | "Set up" | corrected |
| guide | wrong | 4.15 "Account, Security" | "Forgot your password?" | corrected |
| tutorial | wrong | step: "when your daily report arrives"; Read more `getting-started#first-login` | the time is set on the CEO's Reporting & alerts tab; Notifications and Monday briefing exist | step text; new Help section `getting-started#your-settings` |
| help (follow-up) | outdated | page help /settings ("Two-factor login"; link) | | page help /settings: Two-factor login name, article link to `two-factor` |
| app issue | wrong | | a non-Owner sees the Owner's time zone after saving their own (`Settings.tsx:23`); "on your clock" is wrong for non-Owners (`:127`) | backlog suggestion |

## 22 Organization

| Artefact | Type | Documentation says | App does | Fix made |
|---|---|---|---|---|
| guide | missing | 4.1 General | Owner, Transfer ownership, Your role, Leave organization, (gated) Share diagnostic data | added |
| guide | missing | no figure of Project links | | figure `org-project-links` |
| guide | no gaps | Members, Invitations, Guests, Plan | | |
| tutorial | missing | no tour step | sidebar entry Organization | step `organization` |
| help (follow-up) | outdated | `organizations-and-roles.md` lines 29 and 40; page help (Project links, E-mail inbox) | | `organizations-and-roles.md` tab list (E-mail inbox, Project links, Model providers, Audit log; Billing hosted-only), self-reset pointer; page help /settings/org (Project links, Audit log) |

## 23 Help

| Artefact | Type | Documentation says | App does | Fix made |
|---|---|---|---|---|
| guide | missing | ch. 11 and Appendix A | training video, Blog, What's new, tour replay, setup checklist | added |
| tutorial | outdated | `help` step | also Blog and My requests | step text |
| tutorial | outdated | *tour Read more* `getting-started#the-sidebar` lists a short, old sidebar | the full sidebar | list rewritten |
| tutorial | outdated | welcome step "about two minutes" | the tour has about 30 steps | "about three minutes" |
| app issue | wrong | | platform Help says "the sidebar, the desk, the agents" and shows the work getting-started video (`Help.tsx:111,277`) | backlog suggestion (stale UI copy) |

## P Platform area

| Artefact | Type | Documentation says | App does | Fix made |
|---|---|---|---|---|
| guide | missing | ch. 7 | Billing, API keys (own page, keys for `/api/v1`), Runners (pause automatic updates), Inbound mail | new 7.10 to 7.13 |
| guide | wrong | 7.7 platform Help | the full Help centre without Contact us or My requests | corrected |
| tutorial | missing | platform tour | 4 of 11 entries missing; the blog step mentions API keys | steps `platform-api-keys`, `platform-runners`, `platform-team`, `platform-inbound`; blog text trimmed |
| tutorial | outdated | *tour Read more* `organizations-and-roles#platform-area` | 11 entries | list rewritten |

## Cross-cutting tour fixes

| Artefact | Type | Documentation says | App does | Fix made |
|---|---|---|---|---|
| tutorial | wrong | Ask DevOps step: a direct request | requests go through the CEO; the button is "Ask <CEO>" | step text; *tour Read more* `devops-and-hygiene#devops-engineer` ("Start chat", "Send as a task" removed) |
| tutorial | outdated | tour order | sidebar order | one list in sidebar order for Owner, Admin and Member |
| tutorial | missing | no guard that steps point at real elements | a missing target silently shows a centred card | unit tests derive the sidebar from `buildNav` and check every step target |

## Figures

Done in the GWP-11 follow-up capture run. The nine missing figures are taken and linked again: `backlog` (4.3b), `org-project-links` (Project links, 4.1), `desk-daily-report` (4.11), `ceo`, `ceo-reporting` and `ceo-chat` (4.22), `environments` (4.27), `releases` (4.28) and `metrics` (4.29). The figures of changed screens listed above are re-taken in the same run. `run-settings` and `desk-floor-report` are removed (their screens are gone; `environments` and `desk-daily-report` replace them). `guide.html` and the PDF are rebuilt.

Open points from the run:
- The seed step "test stage: bug loop, conflict, review queue, ..." stops when the manager moves a card straight to Test: on the lean flow such a card is never claimed (no Test deploy ran, so `test_deploy_state` is never `skipped`), which looks like an app bug. The rest of that step (Grace's long build, the bug sent back, the to-do cards, the drafts and the tester bottleneck alert) and the step "an edited card and a risk override" do not run, so the board figures show fewer cards than intended.
- `desk-large-merge` is removed (file and link). Section 4.12 now describes the owner approval after the review in words only: there is no figure of the owner approval (its desk item with **Show the diff**, **Approve** and **Send back**) yet. Take one in the next capture run and add it to 4.12 after the "Owner approval" paragraph.

## Intro video: what is outdated (no fix; input for the video plan)

- It hires only a business analyst, builder, reviewer and tester (not the lean team: planner, architect, pre-reviewer).
- It has no workstation step: the runner is paired off camera and the Get started checklist is not shown.
- It opens New card by URL instead of the sidebar button.
- It shows none of Backlog, Environments, Releases, CEO, Integrations, Metrics, Desk, Intake, Research or Roles & workflows.
- Step 5 says "test" but shows no environment or release.
- "Five steps" is fixed in the player text, the tour video step and `getting-started.md`. These stay until the new video exists.

## App issues raised (not fixed here)

1. Costs: the Project dropdown shrinks to the selected project.
2. Settings: a non-Owner sees the Owner's time zone after saving their own.
3. Desk: the Intake button is shown to every role and with the integrations feature off.
4. Sidebar: Board stays highlighted on the Environments, Research, Archive and Phase pages.
5. Research tab: "New research card" does not preselect the research type.
6. Stale UI copy (CEO chat, Design with the BA, "HR board", the wizard's "Floor report (organization)" digest option, platform Help, vault empty state, pairing labels).
