# Backlog

Logged fixes to pick up when development resumes. Newest first.

## 2026-10-14

Owner's bug and wish list from a day of real use (production, P4 / Flow-Web). Root causes are being investigated; each
item gets its findings and fix when built.

### 48. Authorise MCP servers from the web

The BA needed the Atlassian plugin MCP authorised (OAuth) and the owner could not do that from the web. Wanted: the
runner reports each server's auth state; the app shows "needs sign-in" per workstation with a clear action, and if possible
starts the sign-in from the web. Fits the Integrations page (#34).

### 50. Claude login expiry stops agents

When the workstation's Claude Code login (OAuth) expires, agents fail until the owner runs `/login`. Wanted: find out why
it expires (refresh not written back from the sandbox?), detect it, pause that workstation's work, tell the owner
("run `claude /login` on <workstation>"), and resume by itself once the login works again.

### 58. Start action: run the project on a branch

An easy way to start the project on a chosen branch to try it. Build/run instructions per project: if a repository has a
`BUILD.md`, the agent uses it; otherwise instructions can be given in Project settings. For a multi-repository project,
choose which services to start. Needs design: where it runs (the workstation), who may start it, ports and logs, how it
is stopped.

### 59. Integration and E2E tests per project, run by testers

**Owner decision (2026-10-14):** whether integration and E2E tests run is a per-project setting. They need networking, so
builders and reviewers never run them (unit tests only; the handoff names the suites left out). Dedicated tester agents
run them, when enabled, against a **local** environment (started on the workstation, see the start action #58) or a
**remote** one (a URL configured in the project). The tester's sandbox then allows exactly that host (localhost ports or
the remote host), nothing else.

### 60. Claude sign-in from the web

**Owner request (2026-10-14):** sign in to Claude (and MCP servers, #48) from the web instead of the terminal. Idea: the
runner starts `claude setup-token` (or the login flow) itself, sends the sign-in URL to the app, the owner opens it and
pastes the code back on the Integrations page (#34); the runner finishes the flow and keeps the token on the workstation
(it never reaches the server). MCP OAuth uses a localhost callback, so it works directly only when the browser is on the
workstation; otherwise needs the same paste-the-code relay. Part of the #34 design.

## Direction (owner, 2026-10-13)

Guildwise started as a tool for software teams (the owner built it for his own work), but the aim is **running a whole
organisation with AI**: that is why departments, custom roles, custom workflows and automations exist. Items #35–#44 come
from a look at rebelzero.ai (a Cape Town / New York AI consultancy that builds and runs business agents for clients:
voice, front office, back office, follow-ups, pipeline). To be discussed with the owner before building.

### 35. Trust page and POPIA notice

We have Privacy and Terms but no Trust or POPIA page. The substance exists: an event log of every action (who, what,
when), sandboxed agents, secrets that stay on the workstation, human approval steps, data not used for training (state the
model provider's terms accurately). Wanted: a public `/trust` page (security, data handling, approvals, audit, sub-processors,
where data is hosted) and a `/popia` notice (Information Officer, purposes, rights, cross-border transfer), linked from the
footer and sign-up. Legal wording to be checked by the owner.

### 36. Savings calculator on the landing page

An estimator in the spirit of rebelzero.ai's admin-cost calculator: team size × hourly cost × share of work that is routine
(tickets, bug fixes, reviews, reports) × share agents could take → hours a month, money a year, full-time equivalents,
set against the Guildwise plan price. Clearly labelled an estimate. Later variants per department (support, finance,
marketing) as the non-software side grows.

### 37. Value report per organisation

Turn what we already record (cards done, time in each stage, shift cost and tokens, rework rounds) into "this month your
agents finished 42 cards, about X hours of work, for $Y of usage". Needs an estimate of human time per card (by size /
type, adjustable per organisation, or the owner's own estimate on the card). On the Metrics/Costs pages, in the weekly
briefing (#38) and exportable for a manager. Include "next best actions": stuck cards, agents that fail often, projects
without work.

### 38. Weekly briefing

A Monday summary per member (e-mail and push, opt-out per person): cards done and shipped, what is waiting on you (desk
items, approvals, questions), blocked or failing work, spend against budget, agent and workstation health, and the value
figures of #37. Per organisation and per project for managers; a short version for members.

### 39. Paid setup package

A fixed-price onboarding service: connect repositories and integrations, design departments, roles and workflows, hire
the right agents, run the first cards together, and hand over a 90-day plan. Rebelzero.ai sells a $799 two-week "AI
roadmap" with a "pays for itself" guarantee; decide price, scope and guarantee. Mostly an offer, a page and a booking /
payment flow (Paystack); possibly a request form that becomes a card in the platform's own organisation.

### 40. Pages per audience

Landing pages per buyer: agencies, .NET / Java shops, SaaS teams with a Jira backlog, and later non-software
departments and industries (professional services, property, hospitality) as #42 lands. Each with its own problem,
example workflow, and savings figures.

### 41. More ways in: WhatsApp, web forms, one inbox

Cards and requests come in by e-mail today (inbound mail, automations). Wanted: WhatsApp (Business API) and an embeddable
web form as intake channels, with the same untrusted-input handling, per-sender limits (#19) and draft-first rules; a
unified inbox per organisation across channels with replies from inside Guildwise (#15).

### 42. Business-operations departments and agents

Grow beyond software with ready-made departments, roles and workflows (templates in the Org Designer):
- **Front office:** answer enquiries, qualify, draft proposals and quotes for approval.
- **Back office:** invoice reconciliation, payment matching, reports.
- **Relationships:** follow-ups and nurturing of clients and leads.
- **Growth:** pipeline forecast, deals at risk, next actions.
Needs connectors to CRM, accounting, bookings and spreadsheets (through the integrations page, #34, and MCP servers, #20),
approval steps for anything that sends money or messages (#16), and agents that run without a code repository (the
workstation/sandbox model today assumes a repo for card work).

### 43. Voice agent

Answer and place calls around the clock, qualify callers with the organisation's own questions, book meetings, and log a
call summary to the card / CRM. Needs a telephony provider (Twilio or a South African one), speech-to-text and
text-to-speech, recording consent (POPIA), and a hand-over to a human. Large; after #41 and #42.

### 44. Client table and "who are our clients" view

A client / contact list per organisation, fed by intake channels and connected systems (CRM, finance, bookings), so cards,
threads, invoices and calls hang off a client. Base for #41–#43 and for the value report per client.

## 2026-10-13

Follow-ups from the 2026-10-12 release (items #1–#13).

Leftovers on done items: #20 (MCP tool names per server are not listed; refreshed OAuth tokens are not written back when
a configured token is used) and #27 (a reopened research card keeps its published status; a reopened cancelled bug child
does not put its resumed parent back to waiting).

### 34. Integrations page: set up a workstation's integrations and API keys in one place

**Owner request (2026-10-13):** an easy way to add the API keys for Bitbucket, GitHub, Jira and whatever integrations
follow. Keys are probably per workstation; a dedicated **Integrations** page in the app is the wanted shape.

**Today** each integration has its own path, mostly on the command line of the workstation:
- Forges: `aom-runner git-connect` (Bitbucket API token, Azure DevOps PAT, GitLab PAT into
  `<data dir>/secrets/git-tokens.json`, `apps/runner/src/forge/tokens.ts`), the forge CLIs' own logins (`gh`, `glab`), or
  SSH keys (`apps/runner/src/forge/connect.ts`, `ssh.ts`). The status shows on Workstations and in Project settings.
- Jira: `aom-runner jira-connect` (`apps/runner/src/external/jira-store.ts`).
- Plugin MCP servers: configured in Claude Code itself; Guildwise only sees the report (#20).
- Platform-level keys (Paystack, Postmark) are server env, not part of this.

**Wanted (design first):**
- An **Integrations** page per workstation (reachable from Workstations, and from the "not connected" warnings in
  Project settings and on cards): one tile per integration with its status (connected, as whom, scopes, last checked,
  expiry where known), **Connect / Replace / Test / Remove**, and step-by-step help with links to where the token is made
  and which scopes it needs (the Jira scopes question showed this is needed).
- A **registry of integration kinds** (id, label, fields, required scopes, help text, test call, where the runner keeps
  it), so a new integration is one entry plus its adapter, not a new CLI command and a new screen.
- **Secrets stay on the workstation** (the current rule: the server stores connected / not connected, never the token).
  Decide how a key typed in the browser reaches the runner: relayed over the runner's websocket and never stored or logged
  on the server (end-to-end encrypted to the runner's key would be better), or a local-only page the runner serves on
  localhost. The CLI commands stay for headless machines.
- Who may set them: the workstation's own user (it is their machine and their credentials); org Owners see status only.
- Optional later: organisation-wide keys (one Jira service account for all workstations) stored encrypted, if the owner
  wants that; and OAuth sign-in where a provider offers it (Atlassian, GitHub app) instead of pasted tokens.
- Help docs and What's new, runner version bump, tests in runner, server and web.

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

### 19. Per-sender limit for inbound e-mail

Inbound mail has a per-organisation hourly limit (`AOM_INBOUND_RATE_PER_HOUR`). Add an optional per-sender limit so one
noisy or looping sender cannot use up an organisation's allowance.

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

The details of each done item follow this list, by date.

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
- #22: Agents read the vault in chats. Done 2026-10-13.
- #23: Faster agent builds: shared package caches, dotnet in the sandbox. Done 2026-10-13.
- #24: Agent toolchain registry (DevOps registers tools for agents). Done 2026-10-13.
- #25: Working branch from the wrong base; concurrent worktree lock. Done 2026-10-13.
- #26: Hygiene must not undo a rewritten working branch. Done 2026-10-13.
- #27: Reopen a done or cancelled card. Done 2026-10-13 (leftovers noted on the item).
- #28: Card branches stay local; hygiene removes finished card branches. Done 2026-10-13.
- #29: Hired agents keep stale role permissions. Done 2026-10-13.
- #30: Cards inherit the project's completion action. Done 2026-10-13.
- #31: Builders stuck: MSBuild nodes and don't-ask Bash denials. Done 2026-10-13 (runner 0.1.9).
- #32: Cap or summarise the handoff notes in shift instructions. Done 2026-10-13.
- #18: Working-branch question lists saved-work branches. Done 2026-10-13.
- #33: .NET builds in a repository without `.gitmodules`. Done 2026-10-13.
- #45: No Guildwise trace in repositories: saved work in stashes. Done 2026-10-13.
- #46: Branch prefix per project for pull-request branches. Done 2026-10-13.
- #56: The board shows $0.00 spend this month. Done 2026-10-14.
- #54: Change priority and completion action on a card at any time. Done 2026-10-14.
- #52: Agents may not set the completion action. Done 2026-10-14.
- #47: The BA must not read the code during intake. Done 2026-10-14.
- #49: The BA knows the runner's Jira integration (prompts; the runner command is separate). Done 2026-10-14.
- #51: Archive done cards after a day. Done 2026-10-14.
- #53: Unstick an agent: stop shift, stop the running command, idle watchdog. Done 2026-10-14.
- #55: Agents stuck running unit tests: per-command time limits and test instructions. Done 2026-10-14.
- #57: The local working branch falls behind origin: sync, status and Sync now. Done 2026-10-14.
- #63: Batch intake: hand the BA a list of tickets. Done 2026-10-14.

## 2026-10-14 (done)

### 63. Batch intake: hand the BA a list of tickets

**Owner request (2026-10-14):** "Intake works well now, but I want to point it at a bunch of tickets at once without
starting a single chat per ticket. Do what I do now, but also just post a bunch of tickets to spec and the BA should just
run with it."

**Done (2026-10-14).** The Intake page has a **Batch** mode next to the chat: one ticket per line (Jira keys or URLs,
GitHub issues), an optional project for all of them, a note for all of them. `POST /api/intake/batches` (Owner and Admins,
as for a chat intake; at most 50 tickets; lines that are no ticket are refused, repeats ignored) creates an event-sourced
batch (`IntakeBatchCreated`, ..., projections `intake_batches` and `intake_batch_items`, migration 1867) with one item per
ticket. A ticket that already has a card (matched on the card's `externalRef`) or an intake is recorded as `skipped:
already P4-12`. Each other item becomes a BA task of the new kind `batch_intake`: a background BA shift (not a chat) whose
prompt gives the ticket, the optional project and the note, and tells the BA to do what it does in an intake chat: read the
ticket (`aom source read`, attachments), map it, write the spec and create the cards with the same verbs and flags
(`aom card create|update|specify`, designNeeded, investigationOnly, mergeMainFirst; never completionAction). The shift
works in a real intake of the ticket (created with the first card verb, started by the batch's creator), so cards are
linked to it and the ticket's chat thread exists. The shift ends with `aom batch done|ask|skip|fail`; `done` is refused
while no card exists or a card is still a draft. At most 2 items of one batch are with a BA at once (`BATCH_MAX_IN_FLIGHT`,
checked in `baTaskPass`), and batch tasks queue behind every other BA task, so phase reports and reporter work still flow.
Statuses per item: queued, reading, waiting, done, skipped, failed (Retry), cancelled; batch: running, done, cancelled
(Cancel stops queued and waiting items; shifts in flight finish).

*Questions go to the desk, one desk item per blocked ticket* (owner decision): `aom batch ask` raises a desk question
(subkind `batch_question`, data = batch and item, text starting with the ticket key) and the item goes to `waiting`; the
shift ends and other items carry on. Answering the desk item queues a new BA task for exactly that item, with the whole
question and answer history in its prompt (routing by the item named in the desk item's data, so there is no guessing which
ticket an answer is for). Dismissing the question fails the item (Retry asks again). A task nobody can take fails its item.
The runner gives a batch shift `aom source read|attachments|attachment` (ticket credentials stay on the workstation, only
the batch ticket's attachments) and `aom card attach`. The web shows the batch list and a detail view (ticket links, card
links, the question with a link to its desk item, Retry, Cancel), refreshed every 5 seconds while a batch runs. Tests:
server `intake-batch.test.ts`, web `intake-batch.test.tsx`, shared `batch.test.ts`, runner `batch-cli.test.ts`.

### 47. Intake: the BA tries to read the code itself

During intake the BA tried to read the repositories and asked for reference repositories. The owner refused: reading
code is the Architect's job (BA spec → Architect → build, #9). The BA's intake instructions and permissions must keep it
on the ticket, the requirements and the spec, and hand code questions to the Architect step.

**Done (2026-10-14).** The BA no longer reads code during intake. Its intake step 3 and the intake chat instructions now say: use PROJECT.md, the vault, the ledger and the ticket; never read source code and never ask the manager for repository or reference-repository access; put code questions into the card and set `designNeeded` (or `investigationOnly`) so the Architect investigates. The same rule is in the BA core rules. Hard enforcement in `chat/relay.ts`: a chat with the BA (role key `ba`) gets no `readRepos`, no `localReadRepos` and no card worktree path; other roles are unchanged. USER-GUIDE 4.18 says so. BA role version 13 (one bump with #49 and #52; hired agents follow it, #29).

### 49. The BA does not know the runner's Jira integration

The runner has a Jira API connection (`aom-runner jira-connect`, `aom source attachments`), but the BA did not know it and
could not use it when MCP was unavailable. The BA's instructions must name it, and the BA should be able to read a ticket
(fields, description, comments, attachments) through it.

**Done (2026-10-14), prompt part.** The BA instructions (intake steps 1 and 1a), the intake chat instructions and the Jira skill text now name the workstation's Jira connection: `aom source read --ref <KEY>` (fields, description, comments, links), `aom source attachments <KEY>` and `aom source attachment <KEY> ...`; the Atlassian MCP server is only a fallback; when the runner says Jira is not connected the BA asks the manager to run `aom-runner jira-connect` on the workstation. The runner side (`aom source read` for a Jira key) is built separately in `apps/runner/src/external/jira.ts` and `aom-cli.ts`. BA role version 13.

### 51. Archive done cards after a day

Done cards should leave the board a day after they are done, into an archive that stays searchable and findable (card
search, filters by project / date / agent), and from which a card can still be opened and reopened (#27).

**Done (2026-10-14).** Done and cancelled cards leave the board 24 hours after they were finished (`CARD_ARCHIVE_AFTER_HOURS` in `@aom/shared`). New projection column `cards.finished_at` (migration 1840), kept by a trigger so every path that finishes or reopens a card (finalize, feed, testing, research, cancel, reopen, a projection rebuild) sets and clears it; existing cards are backfilled. The board query hides cards with `finished_at` older than the cutoff. New `GET /api/archive?projectId=` (any member of the project): done and cancelled cards past the cutoff, newest first, search by reference prefix, title or ticket key, filters for status, agent (any handoff of the card) and finished-from/until dates, paging (`page`, `pageSize`). Web: an **Archive** button in the board header opens `/p/<KEY>/archive` with the search, the filters and paging; each row opens the card, and Reopen (#27) works there and puts the card back on the board. The command palette search still finds archived done cards. Metrics, costs and reports read the cards table and still count archived cards. Not done: an organization setting for the 24 hours; a cross-project archive; cancelled cards were already off the board and stay off it.

### 52. A card finalised as a pull request against the project's completion action

Cards inherit the project's completion action (#30), but one card still opened a pull request. The BA must not set or
override the completion action; only people may change it on a card.

**Done (2026-10-14).** An agent can no longer set the completion action. The server refuses it with a message that teaches ("agents may not set the completion action: ... the project's default applies ... ask the manager to change it on the card page"): in the intake `card.create` and `card.update` RPCs, and in `createCardIn`/`patchCardIn` for any agent actor. The draft schemas keep the optional key so the refusal can name it instead of silently dropping it. Spawned cards (finalize, regression, sub-workflows) are system actors and are unaffected. Prompts: `completionAction` is gone from the BA draft field lists and from the intake chat step, BA step 6 now reads "Never set completionAction", and it is a core rule. The runner's mock agent no longer sends it. Finalize too: `aom finalize` takes no `--action` any more (the CLI and the server refuse it with the same teaching message); the BA's finalize always runs the card's effective completion action (a person's override, else the project default), and an investigation-only card with its report in the vault ends without a git step by itself. The #30 BA revision of the action is gone. BA role version 13.

### 54. Change priority and completion action on a card at any time

Priority and completion action should be editable in every card status (handled sanely while a finalise is running).

**Done (2026-10-14).** `priority` and `completionAction` are "light" keys: they change on any open card, also while it is claimed or in any stage; other fields keep their guards (draft or queued and unclaimed). The completion action is refused with `finalize_pending` only while a finalise awaits approval or runs (the finalise message carries the action captured at queue time); a done card takes a priority but not a completion action; a cancelled card takes neither (`card_closed`). The card query has `permissions.canEditPriority` and `canEditCompletion`. The card page shows inline selects for Priority and Completion action (project default option included, hint "Applies to the next finalise"), patching straight away with the server's refusal next to the control. The Edit dialog stays for draft and queued cards. The dispatcher reads `cards.priority` live in its candidate query, so a new priority applies from the next pick.

### 56. The board shows $0.00 spend this month

The board's spend figure shows $0.00 this month instead of the real total.

**Done (2026-10-14).** `budgetsFor` loaded the month's spend only when some project of the organization had a budget, so a project without one showed $0.00. It now always loads the spend (one query per organization). The board header shows the real figure ("$4.25 this month"); the budget meter and card notices still render nothing budget related without a monthly amount. The per-card budget notice was not affected (it needs a budget).

### 53. Unstick an agent

A way to free an agent whose running processes hang: from the card / agent / workstation page, stop the running command
or restart the shift (kill the whole process tree in the sandbox, keep the work), plus an automatic watchdog when a shift
shows no progress for a set time.

**Done (2026-10-14).** Web: the live-shift panel of a card shows "Running N min" and "last activity N min ago" with **Stop the
running command** and **Stop shift** (for the card's owner and the project owner). Stop shift asks: **Stop and re-queue**
(the card goes back in the queue, as Release did) or **Stop, keep the card with this agent** (`POST /api/shifts/:id/stop` with
`keepCard: true`; the shift row remembers it in `shifts.stop_keep_card`, the release is followed by the dispatcher giving the
card to the same agent first, `Dispatcher.prefer`, so it starts a fresh shift). The Agents page shows the same badge and
buttons on an agent that is running a shift; the Workstations page lists running shifts without a card (DevOps work, chats)
with the same stop controls. The Release dialog no longer says work is not kept: the runner commits the worktree when the
shift ends (the card's branch keeps it). Protocol (additive): `shift.kill_tools` (server to runner) via
`POST /api/shifts/:id/kill-tools`; the runner walks `/proc` from the agent process and sends SIGTERM, then SIGKILL after 3 s,
to its shell children (`bash`, `sh`, `bwrap`, ...) and everything below them, so MCP servers and the sandbox's `socat` helpers
live on and the agent sees its command fail (`apps/runner/src/adapters/proc-tree.ts`). The agent process now leads its own
process group (`detached`); `stop()` sends SIGTERM to the group and SIGKILL after 10 s, and the runner's exit hook kills
live groups. Idle watchdog (`ShiftSupervisor.idleCheck`, `IDLE_LIMITS`): a turn that finished (result line) and then 8 min of
silence, or 20 min of silence during a turn, kills the running commands and posts "no activity for N min; stopped the running
command" on the shift; 5 min later, still silent, the shift is stopped (outcome `timeout`, so the loop breaker counts it)
and the usual end-of-shift code commits the work and notes what was unreported. Tests: `proc-tree.test.ts`,
`supervisor.test.ts` (kill_tools, both watchdog limits), server `shift-stop-sync.test.ts`, web `shift-stop-sync.test.tsx`.

### 55. Agents get stuck running unit tests of broken projects

Builders hang while running the unit tests of projects that do not build or whose tests hang (.NET). Needs per-command
time limits and hang detection for test runs (e.g. `dotnet test --blame-hang-timeout`), and instructions on what to do
when a project's tests are broken before the agent touched it.

**Done (2026-10-14).** Evidence: shifts a42271ec and e85e17fc on P4-11 started two full `dotnet test` runs of an
integration suite (needs a live server; the sandbox only allows registry domains) as background tasks with
`timeout=3600000` and polled them with `sleep` loops for 12+ minutes. Claude Code's per-command timeout was defeated because
nothing capped it. Agent sessions now get `BASH_DEFAULT_TIMEOUT_MS=300000` (5 min) and `BASH_MAX_TIMEOUT_MS=900000`
(15 min); both names are in the installed Claude Code binary's environment-variable list (checked in 2.1.299), set in
`sessionEnv` (`apps/runner/src/adapters/claude-code.ts`). The builder/tester instructions (`packages/shared/src/prompt/instructions.ts`,
"Boundaries") now say: unit tests only, in the foreground, with a hang limit (`dotnet test ... --blame-hang-timeout 2m
--blame-hang-dump-type none`, any other long command under `timeout <seconds>`); never integration or end-to-end suites
(anything that needs a running server, network or services; those are for the testers, see #59) and name in the handoff the suites
left out; never two full suites at once and never background tasks polled with `sleep`; tests that already fail on the base
commit are checked once, noted in the handoff and not fixed. `DOTNET_PROCESSOR_COUNT=1` stays: MSBuild sizes its worker
nodes from it and the nodes' named pipes cannot start in the sandbox (#31), so raising it to 2 for test hosts is not safe to do
blindly; left as it is. The idle watchdog of #53 is the second line of defence.

### 57. The local working branch falls behind origin

After a pull request is merged, origin moves but the local working branch stays behind. Agents must always start from
the latest code (fetch and fast-forward before work), and the app should show "out of sync" for a repository's working
branch with a "Sync now" action.

**Done (2026-10-14).** Facts: card worktrees already fetched and branched from `origin/<base>`; what stayed stale was the local
working-branch ref and the owner's own checkout (on this machine the runner clone is the owner's checkout). New
`syncWorkingBranch` (`apps/runner/src/git/sync-branch.ts`): fetches `origin <branch>` only; checkout on the branch and clean:
`merge --ff-only`; branch not checked out: `update-ref` with the expected old value, only when local is an ancestor of
origin; diverged, dirty, checked out in another worktree, or a card shift running in the repository (the same busy-worktree
guard hygiene uses): nothing is touched and the state says why (`synced`, `updated`, `behind`, `ahead`, `diverged`, `dirty`,
`busy`, ...). It never forces and never touches uncommitted work. It runs best effort after the fetch of a new card worktree
(project working branch only), after a finalize with `pr` or `merge`, on a server request ("Sync now", command `repo.sync`)
and every 10 minutes for the repositories the runner knows a working branch for (`SyncService`, targets remembered in
`sync-targets.json`; the server seeds them with a `repo.sync` at each hello for confirmed working branches). The runner reports
`repo.sync_status` {repoId, workingBranch, state, ahead, behind, dirty, onBranch, checkedOutBranch, detail, checkedAt};
the server stores it in `repo_sync_status` (migration 1860; a separate table, not `repo_clones`, which only has rows for
clones the DevOps engineer set up, while `workstation_repos` is rewritten at every hello). Web: Workstations (repositories) and
Project settings show "pieter/dev is 3 commits behind origin", "has diverged from origin" or "... and has uncommitted
changes" with **Sync now** (the workstation's owner; `POST /api/workstations/:id/repos/:repoId/sync`). Tests:
`sync-branch.test.ts`, server `shift-stop-sync.test.ts`, web `shift-stop-sync.test.tsx`.

## 2026-10-13 (done)

### 46. Branch prefix per project for pull-request branches

**Owner request (2026-10-13):** a pull request branch must not carry `aom/`; it is `<project prefix>/<ticket>`, for example
`pieter/DCPL-4276`.

**Done (2026-10-13).** New project setting **Pull request branch prefix** (`prBranchPrefix`, migration 1830, edited in
Project settings by those who may change the project; validated as a safe ref path, 40 characters, empty means `feature`).
`finalize.execute` carries `prBranchPrefix`, `ticket` (the tracker key of the card's intake when it is a key such as
`DCPL-4276`, else the card ref) and `remoteBranch` (the name a card used before, read from `finalize_result.pushedBranch`).
The runner pushes `<local>:refs/heads/<remote name>`, adds `-2`, `-3` when origin already has the name, opens the pull request
from the remote name and returns it as `pushedBranch`, so rework updates the same branch and pull request. The local card
branch is unchanged. Hygiene removes the finished card's remote branch by the stored name only (`finishedCards[].remoteBranch`),
never by prefix. Old open pull requests keep their `aom/...` branch (their stored `pushedBranch` is reused). Only the `pr`
action and the protected-branch fallback use the new name; "push the branch" keeps the card branch name.

### 45. No Guildwise trace in repositories: saved work in stashes

**Owner request (2026-10-13):** nothing with the product's name may end up in the user's repositories, local or remote.

**Done (2026-10-13).** Saved work no longer uses `guildwise/saved-work/*` branches and is never pushed. Uncommitted edits
(also untracked files, minus secret-looking ones) become a stash entry `saved work <ISO date>: N file(s) not committed`
built from throwaway indexes (W with parents HEAD and I, a third parent for untracked files, then `git stash store`), so
`git stash list/show/apply` work and the checkout and index are untouched. Local commits that were never on origin when a
rewritten working branch is realigned are kept as a stash entry whose first parent is the old tip (`git branch <name>
stash@{n}^1` recovers them). Every hygiene run migrates older runners' `guildwise/saved-work/*` branches: local ones are
stored as a stash and deleted, ones on origin are fetched, kept and deleted from origin (that exact prefix only). Runner-made
merges and rebases use the repository's own `user.name`/`user.email` (fallback to the runner identity only when none is
set), the merge messages no longer say "aom", and the leftovers commit no longer starts with `aom:`. Tests in
`apps/runner/test/hygiene.test.ts`, `repo-identity.test.ts`, `completion.test.ts` and `sync-main.test.ts`.
Left as they are, for a decision: agent commits are authored as the agent (`<name> (aom)`, `<id>@agents.aom.invalid`,
`apps/runner/src/sandbox/sandbox.ts`), and the knowledge vault repositories get `aom: ...` commit messages.

Agents share the clone's stash list, so `git stash drop`, `pop` and `clear` are denied for every agent role (`STASH_REMOVING_DENIED` in `claude-policy.ts`) and the instructions say to `git stash apply` only their own entry.

### 33. .NET builds in a repository without `.gitmodules`

Seen while testing #31: in a repository that has no `.gitmodules` file, a .NET build in the sandbox can fail with
"Access to .gitmodules is denied" (SourceLink / the git task probes the file, and the sandbox refuses the read of a path
that does not exist under the worktree's protected git paths). The owner's repositories have the file, so nobody is
affected today. Wanted: reproduce in the sandbox with a repo without `.gitmodules`, then allow reading that path
(read-only) in the policy (`apps/runner/src/adapters/claude-policy.ts`) or set `EnableSourceLink=false` /
`EnableSourceControlManagerQueries=false` for agent builds (`apps/runner/src/sandbox/sandbox.ts`); a runner test either way.

**Done (2026-10-13).** Reproduced in a bubblewrap sandbox with a fresh `dotnet new classlib` in a git repository
without `.gitmodules`: the sandbox runtime protects `<repo>/.gitmodules` and, when the file does not exist, masks it with
`/dev/null`; the SDK's `Microsoft.Build.Tasks.Git` then fails with "Error reading git repository information: Access to
the path '.../.gitmodules' is denied". A policy change could not fix this (the path is on the runtime's own deny list), so
the sandbox env now sets `EnableSourceControlManagerQueries=false` (`dotnetEnv` in `apps/runner/src/sandbox/sandbox.ts`);
`EnableSourceLink=false` alone does not stop the probe (tried). Verified by hand and in `apps/runner/test/sandbox-caches.test.ts`
(a build with the mask passes; without the variable it fails on `.gitmodules`). Note: on this machine those real-sandbox
tests, and the older ones beside them, fail at baseline with a .NET `NuGet-Migrations` mutex error when `/tmp/.dotnet` is a
bind mount; they pass where that works.

### 32. Cap or summarise the handoff notes in shift instructions

Every shift prompt carries **all** previous handoffs of the card in full (`packages/shared/src/prompt/shift-prompt.ts`,
section "Previous handoffs"). A card that goes round review/rework or test several times (P4-3, P4-7) collects a long
tail of notes, most of them superseded, and the prompt keeps growing (it already pushed reviewer prompts past the argv
limit before 0.1.7 moved them to stdin). Wanted: keep the latest few handoffs in full and the rest as one line each
(stage / agent / outcome / date), or a rolling summary written at handoff time; a size budget for the section with the
oldest notes trimmed first; the full history stays on the card page. Tests in `packages/shared` for the trimming.

**Done (2026-10-13).** `renderHandoffs` in `packages/shared/src/prompt/shift-prompt.ts` builds the "Previous handoffs"
section: the latest 4 handoffs stay in full, older ones become one line each (`- stage / agent / outcome (at): first
line, 160 characters`) under a line that says how many were shortened and that the full history is on the card page. The
section has a budget of 12,000 characters: the oldest full notes are shortened first, and the latest handoff is never
dropped, only cut with a "[… truncated, full note on the card page]" marker when it alone is too long. Tests in
`packages/shared/test/prompt.test.ts`. `aom card <REF>` in a BA task (`ba-tasks.ts`) returns the handoffs as data for the
BA, not as prompt text, so it is unchanged.

### 18. Working-branch question lists saved-work branches

The hygiene question "Keep trunk as working branch?" also offers the automatic `guildwise/saved-work/<date>` branches as
choices. Leave them out of the options.

**Done (2026-10-13).** The working-branch question and the automatic default (`defaultWorkingBranch`) leave out
runner-owned branches (`guildwise/saved-work/`, `conflict/`, `aom-integration/`) and agent card branches (`aom/`). The
predicate is shared (`isRunnerOwnedBranch`, `isNotWorkingBranchCandidate` in `packages/shared/src/hygiene`); the runner's
post-shift guard uses the same list. Tests in `apps/server/test/simple-mode-branch.test.ts` and
`packages/shared/test/prompt.test.ts`.

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

### 31. Builders stuck: MSBuild nodes and don't-ask Bash denials

**Done (2026-10-13).** Production evidence (card P4-7, builder shifts on runner 0.1.7 and 0.1.8): every builder shift
ended `no_report`, 8 times in a row.

1. **`dotnet build`/`test` crashed in the sandbox.** Stack: `NamedPipeServerStream.SharedServer..ctor` /
   `SocketException (13): Permission denied` in `MSBuildApp.StartLocalNode`. A build of more than one project starts one
   MSBuild worker node per CPU; .NET implements their named pipes as Unix sockets at the **hard-coded** path
   `/tmp/MSBuild<pid>` (not under `TMPDIR`). The Linux sandbox refuses `socket(AF_UNIX)` (seccomp) and its `/tmp` is
   read-only. Reproduced in the real sandbox (Claude Code with the generated builder policy): `-m:1` built, a plain build
   failed. Opening Unix sockets (`allowAllUnixSockets`) only moves the failure to `bind()` on the read-only `/tmp`
   (the build then hangs), and `/tmp` cannot be made writable without exposing other sessions' files. Fix:
   `DOTNET_PROCESSOR_COUNT=1` in the agent env (`dotnetEnv`, `sandbox/sandbox.ts`): MSBuild sizes its node count from the
   processor count, so a plain `dotnet build`/`test` runs in one process (verified: 4-project solution and two xunit
   projects built and tested through `claude -p` in the sandbox). `MSBUILDCORELIMIT` does not help. Side effect: .NET
   processes of the agent (also the test host) see one CPU. An explicit `-m:N` (N above 1) still fails; the shared
   instructions say so.
2. **Bash "denied in don't ask mode".** After a successful run the builder's call
   `cd <subfolder> && python3 - <<'E' ... E` followed on a new line by `VAR=1 VAR2=0 dotnet test ... 2>&1 | grep ... | tail`
   was denied, and the agent stopped to ask the user. Not a policy gap: builders have the bare `Bash` allow and the deny
   list only holds `git push`, `git reset --hard`, `sudo`, `rm -rf /*`. Claude Code 2.1.296's own command analysis forces
   an "ask" for some `cd <other directory>` compounds (reproduced: `cd sub && echo a; FOO=1 ls` is denied, the same
   without `cd`, with `&&`, or with `cd` into the cwd itself is allowed), and `dontAsk` turns every ask into a denial. No
   setting overrides it: `Bash(*)`, a `PreToolUse` allow hook, a `PermissionRequest` hook and turning the sandbox off were
   all tried, the call stayed denied. The denial is per command: the next call in the same session was allowed (verified),
   so nothing is "poisoned"; the agent simply stopped. Fix: the shared instructions (`# How to report`) now say: never end
   a shift without a terminal command, and after a denial retry with simpler equivalents (one command per call, no
   `cd` chains or heredocs, `git -C`, the Edit/Write tools), then `aom question`/`aom handoff` with the state.
3. **Work was invisible after a silent shift.** A shift that ends without a report (also crashed or timed out) while the
   worktree has changes now gets a card note from the runner listing the files (and the leftovers commit the runner
   already makes), so the next shift and the owner see them (`unreportedWorkNote`, `shifts/autocommit.ts`).

Tests: `sandbox-caches.test.ts` (env, and a real bubblewrap multi-project build that fails without the variable),
`supervisor.test.ts` (note), `claude-args.test.ts` (shell roles keep the bare `Bash` allow), `prompt.test.ts`. The runner
version is not bumped. **Noticed, not fixed:** in the real sandbox a repository without a `.gitmodules` file made
`Microsoft.Build.Tasks.Git` (SourceLink) fail with "Access to the path .../.gitmodules is denied" (Claude Code masks that
protected file); repositories that have one build fine.

### 30. Cards inherit the project's completion action

**Done (2026-10-13).** Owner requirement: "Cards should inherit their project completion action unless specifically
overwritten." Cause: card creation copied `projects.default_completion` onto the card, and the BA/intake path set one as
well, so a later change to the project never reached existing cards (production P4: project default `merge`, every card
`pr`). Now `cards.completion_action` NULL means "inherit" and is stored only for a deliberate override (create or edit
with a value, or a finalize that picks a different action than the card would get). The effective value (card value, else
the project's `default_completion` at the time of use) is resolved in one helper (`commands/completion.ts`) and used by
finalize (manager button and BA `aom finalize`, the large-merge approval, the finalize result), the runner brief
(`brief.card.completionAction`, which gates the architect push and card-branch pushes from #28), the Finalize panel and
phase task reports. The card DTO keeps `completionAction` (stored, nullable) and adds `effectiveCompletionAction` and
`completionActionSource` (`project` or `card`). A card no longer needs its own completion action to be specified
(`requiredMissing` skips it). Web: the expert-mode select reads "Project default (Merge)" and sends a value only when
changed; the card page and plain outcome text show the effective value. BA role version 12: do not set `completionAction`
unless the manager asked for a different landing for that card. Data migration `card-completion-inherit-2026-10`: one
`CardUpdated` (system actor, reason "follow the project default") per open card that had a value, logged per card and
recorded in `data_migrations`; done and cancelled cards keep their recorded value. The runner did not change.

### 29. Hired agents keep stale role permissions

**Done (2026-10-13).** Bug: a hire stored a full copy of its role's `permissions` and never followed the role again, so
builders Ada and Ken still denied `git rebase*`, `git checkout*` and `git switch*` long after builder v2 allowed them
(and the owner's "allow rebase" desk answers could not help). Fix: agents follow the current version of their role.
`AgentPermissionsRebased {agentId, roleKey, fromRoleVersion, toRoleVersion, previous, permissions}` re-derives the
agent's permissions as `newRole + (agent - oldRole)` (`rebasePermissions`, `packages/shared/src/roles/follow.ts`): the
agent's own deviations (extra denied shell patterns, narrowed tools / write scope / risk tiers, `mcp:<server>` tools an
Owner added, browser or org-repo changes) are kept, everything the agent merely inherited moves with the role. Values
any earlier version of the role carried are never deviations, so hires of unknown vintage come out clean. It runs at
server boot after the built-ins are registered (`rebaseAgentsToCurrentRoles`, `apps/server/src/hr/follow-role.ts`; this is
the data fix for existing agents, no SQL migration) and when an organization role version is approved. `roleVersion`
moves with it, so the agent's instructions follow too. Narrowing rules, the Owner-only widening rules and the `mcp:` rule
in `patchAgent` are unchanged: they now compare against a current baseline. Builder v4 instructions say rebase,
cherry-pick, checkout and switch are allowed in the worktree and to use `git reset --keep` (not `--hard`) or ask. The
Agents page shows "Follows role Builder v4" and lists the agent's own changes. The runner is unchanged (it already uses
the shift's agent permissions).

### 28. Card branches stay local; hygiene removes finished card branches

**Done (2026-10-13).** Owner decision: no agent card branch (`aom/<ref>-...`) on origin unless the card's completion
action needs it. `pr` and `push_branch` push the card branch (as before); `merge` merges it into the working branch on
the workstation and pushes only the working branch. Audit result: the completion code and sync-main already pushed
only the working branch; the leak was the architect's `aom git push`, now refused for a `merge` card (and one with no
action yet; the design commits stay in the worktree until finalize). The protected-working-branch fallback still
pushes the card branch (it is a pull request). Second half: repository hygiene now deletes the branch of a **done or
cancelled** card (origin, the clone and its worktree) when its commits are in the working branch (merged), or every
commit's patch is already in the working branch or main (`git cherry`: rebased or cherry-picked), or its pull request
was merged (a declined one only when the commits are elsewhere too) (forge `changeState`, answered by the runner through the new rpc `hygiene.change_state`).
Never: an open pull request, a branch with commits found nowhere else, a branch of an open or reopened card (the
server leaves it out), a worktree with edits or a running shift, anything outside `aom/`, `aom-integration/` and the
project's prefix. Origin is deleted with a lease on the fetched SHA. Each deletion is logged on the card and one desk
notice sums up the run; the per-project setting **Remove finished card branches** (default on) switches it off. A
reopened card whose branch is gone gets it back: `ensureWorktree` in `reuse` mode now recreates the branch from
origin's copy or the working branch instead of failing. The production leftovers (`aom/p4-*` of Flow-Server, Flow-Web,
Flow-Client) are handled by the next hygiene run on these rules (P4-5, PR #661 merged: removed; P4-3, PR #660 open:
kept). Also fixed on the way: the IPC schema did not know `hygiene.busy_worktrees`, so the "defer while a shift runs"
check from #26 silently never ran; it is now an allowed rpc method.

### 27. Reopen a done or cancelled card

**Done (2026-10-13).** Production need: P4-3 was done (finalized with `pr`, PR open on Bitbucket, branch repaired by hand)
and had to go back to Build, but `moveCard` refuses closed cards. New `POST /api/cards/:id/reopen { toStage, reason }`
(card owner and project owner, like a move; only `done`/`cancelled` cards; `toStage` an agent or manual stage of the
card's pinned workflow). Event `CardReopened {cardId, fromStage, fromStatus, toStage, status, reason, by}`: the projection
sets stage and status (queued / draft), clears `finalized_at`, a pending or failed finalize, the claim and the back-off,
and keeps branch, worktree path and `finalize_action` / `finalize_result` (the PR url) as history. Timeline row
(`card_activity` kind `reopened`) and a card thread note naming the earlier PR. The dependency gate already holds open
dependents (it only lets `done`/`cancelled` through); dependents that already started get a thread note. Phase membership
is derived from the card status, so an open phase is incomplete again; a phase that already completed is not reopened.
Runner: `ensureWorktree` continues from `origin/<card branch>` when the local branch is gone (reuse and create); the forge
adapters (GitHub, GitLab, Bitbucket, Azure) return the open change for the same head and base instead of creating a second
one. Web: **Reopen** button, stage picker (default the first agent stage) and required reason on the card page.
**Not done:** an interest run of a reopened research card keeps its published status; a reopened cancelled bug child does
not put its resumed parent back to waiting.

### 26. Hygiene must not undo a rewritten working branch

**Done (2026-10-13).** Production evidence: the owner's coordinator repaired Flow-Web's `pieter/dev` with a force-push
(13 stale `master` commits removed). The owner's checkout still had the old commit, so repository hygiene saw local and
`origin/pieter/dev` diverged, filed a DevOps conflict request, and DevOps merged the remote into the old branch and
pushed it: the removed commits were back. Fixed: hygiene detects a **rewritten remote** (an earlier value of
`origin/<branch>`, from the remote-tracking reflog, that the branch no longer contains and that the local branch is
at, behind or on top of) and realigns the local branch to the remote (`git reset --keep` when checked out, uncommitted
changes kept; `git branch -f` otherwise). Local commits that were never on the remote go to
`guildwise/saved-work/<date>` and a desk notice lists them. Nothing is merged and nothing is pushed to the working
branch; the DevOps conflict request no longer pushes the working branch and says a remote rewrite is not a conflict.
Same release, the post-shift guard: it no longer rejects an agent with `commits_on_other_branch` for housekeeping in the
shared `.git` (`guildwise/saved-work/*`, `conflict/*`, `aom-integration/*`, and branches whose new commits are all on
a remote-tracking ref or were already on the branch at shift start, i.e. a pull or fast-forward); commits that are on no
remote ref still count. And hygiene defers a repository while a card shift has a worktree in it (`aom hygiene run` asks
the runner; the next run tidies it).

### 25. Working branch from the wrong base; concurrent worktree lock

**Done (2026-10-13).** Production evidence: on Flow-Web (Bitbucket, a live `main` and a 14 month old `master`) with no main
branch set, `pieter/dev` was cut from `master` because the runner trusted the clone's `origin/HEAD`, set at clone time.
And P4-4's shift start failed with "could not lock config file .git/config" when two shifts added worktrees to one clone at
once. Fixed in the runner: with no main branch set it asks the host (`git ls-remote --symref origin HEAD`, with the repo's
git auth) and repairs `origin/HEAD`; when the host cannot be asked and the clone has more than one of
main/master/develop/trunk it refuses (shift start, `repo.open_pr`, merge-main) with "Set the main branch for <repo> in
Project settings". Every change to a clone (worktree add/remove, branch create, fetch, sync-main, merge completion) runs
under one per-clone lock (re-entrant), and git retries a few times on "could not lock" / `index.lock`. Server and web: the
"Created working branch" card note says the main branch was unset, plus a desk notice (`main_branch_unset`); project
settings warn "Main branch not set"; the add form pre-fills the main branch from the picker's default branch.
`project_repos.known_branches` no longer goes stale: a created working branch is added to it, `shift.started` carries
origin's branch list (`ProjectRepoBranchesObserved`, `known_branches_at`), and the "working branch does not exist yet" hint
now says "not seen yet" and shows only for a dated list.

### 24. Agent toolchain registry (DevOps registers tools for agents)

**Done (owner, 2026-10-13: "we cannot code for every possible path").** Some projects need .NET 10, others .NET 8, and the
`dotnet` first on the runner PATH (`/usr/local/bin/dotnet`, SDK 8 only) hid `~/.dotnet` (8 and 10) from sandboxed agents;
more generally a tool the DevOps engineer installed was invisible to them. The runner now keeps one list of **agent
toolchains** (`{name, binDirs, readDirs, env, source}`): detected (.NET roots, nvm, pyenv/uv, Go, `~/.cargo/bin`, sdkman,
mise/asdf, `~/.local/bin`), configured (`toolchainPaths`, `dotnetRoot`) and registered by the DevOps engineer with
`aom toolchain add|list|remove` (`toolchains.json`, 0600). Sandboxed agents get every entry on PATH, readable, with its
variables (credentials refused); DevOps shifts get the same PATH. .NET: the root with the most SDKs wins (config
`dotnetRoot` overrides), `DOTNET_ROOT` is set, and the environment check reads `global.json` and the target frameworks
against it ("missing SDK 10.0", "missing runtime 8.0") and installs into that root with `dotnet-install.sh`. The agent
instructions list the toolchains and send missing tools to DevOps. Workstations page: "Agent toolchains" with Remove for
registered ones (additive `toolchains.report` message, `workstations.toolchains`, `toolchain.remove` command). Verified
net8.0 and net10.0 builds in the real bubblewrap sandbox with `/home` hidden. See `docs/RUNNER.md` "Agent toolchains".
Runner and server change. **Open:** no automatic install-and-register for tools the environment check does not know; the
version of detected tools other than .NET, Go and nvm Node is not read.

### 23. Faster agent builds: shared package caches, dotnet in the sandbox

**Done (owner complaint, 2026-10-13: agents are very slow on a .NET project).** Three causes, from the production shift
logs: (1) each agent's private HOME started with empty package caches, so every shift restored every package; (2)
`dotnet build`/`test` failed in the sandbox with `IOException ... NuGet-Migrations` because .NET's named-mutex files live
in `/tmp/.dotnet`, which the read-only `/tmp` of the sandbox refused, so agents asked DevOps to build outside it; (3)
every shell command of a reviewer failed with `bwrap: Can't create file <worktree>/.gitconfig: Read-only file system`,
caused by masking the data dir (a parent of the read-only worktree). Fixed in the runner: shared per-runner caches under
`<data dir>/cache` (NuGet, npm, pnpm, yarn, pip, Gradle, Maven, Go) with the user's `~/.nuget/packages` as a read-only
NuGet fallback; `/tmp/.dotnet` writable plus `DOTNET_*`/MSBuild variables (no build servers left behind); read-only shifts
mask the data dir entry by entry; NuGet hosts added to the network allowlist; one line in the agent instructions. Verified
in the real bubblewrap sandbox and with Claude Code. See `docs/RUNNER.md` "Shared package caches and .NET". Runner
change: needs the next runner version. Follow-up: several .NET versions and a generic tool registry, see #24. **Open:** cargo is not shared (its home holds credentials); private package feeds
that need credentials from the user's `NuGet.Config` stay unavailable to sandboxed agents.

### 22. Agents read the vault in chats

**Done (owner decision, 2026-10-13).** Agents can read the knowledge vault in chats and in question and BA task shifts,
not only in card shifts. The server adds `vault` to `chat.start` (`context.vault`) and to question and BA task
`shift.start` (`vaultForConversation`, `shiftVault`): the project's vault, else the organization vault on the workstations
of the organization's Owner and Admins; a chat with no project gets the organization vault (no folder); never another
organization's. The runner opens the clone as a read-only folder (Edit denied, sandbox `denyWrite`, the secret-file deny
list of reference repositories), adds PROJECT.md and the standing orders to the chat instructions (clipped), and says so
when the vault is not cloned on the workstation. "Folders you can read" lists the vault and sends writes through `aom`
commands. See `docs/RUNNER.md` "Vault access". Runner change: needs the next runner version.

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
