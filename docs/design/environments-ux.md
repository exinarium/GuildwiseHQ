# Environments: one place to say where your app runs

Status: design proposal, 2026-10-21. Replaces the three-way split (Run and test / Phases and deploys / Deploys page) with one model.
Inputs: `docs/design/deploy-run-ux-design.md` (+ section 14 build notes), `deploy-run-ux-requirements.md`, `docs/USER-GUIDE.md`
(Run and test, Integration tests, Phases, 4.27 Delivery), and the current code. Semantics that do NOT change: the recipe
bundle hash and Owner approval, drift refusal, dry-run-before-approve, gates, release queue, `deploy.exec` pinned to the approved hash.

---

## 0. What is wrong today (from code and the owner's P5 experience)

Observed in the code and a screenshot of Project settings (a single scroll of about 7000 px at 900 px width):

1. **Three concepts for one idea.** "Run and test" (run steps, integration tests), "Deploy targets" (a form that is always open), "Set up
   deploys" (a wizard with environments), "Delivery" (mode, lint, approve), "Default follow-ups", and the org-level "Deploys" page. A
   non-coder cannot tell a *target* from an *environment* from a *recipe*. The same thing (a server) is entered in the target form and again in the wizard.
2. **Hard-wired two slots.** The wizard only knows `uat` and `production` (`DeployWizard.tsx` lines 174, 289, 616; the button says
   "Add a test copy" or "Add the live site" and is replaced by nothing once both exist). That is why P5 could not add a third place, or a second server for the same role.
3. **No removal.** Targets have a small "Remove" in the always-open Deploy targets panel; environments, old setups, drafts and the
   duplicate targets the wizard creates (it creates or patches a target at the end of "Where") have no remove path in the guided view.
4. **"Answer" does not answer.** `ProposalReview` questions show an **Answer** button that only opens the part and marks it checked
   (design 14, v1a item 4). The question text ("Which part is your app?") has no field.
5. **Servers are not first-class.** A server is connected inside a deploy target flow; there is no list of "my servers", so adding one
   does not let releases point at it. The environment says `target: <name>` and the setup stores the host alias separately.
6. **Detection misses reality.** "No app found" for a stack in `/home/administrator/...` (probe only looks at `/opt`, `/srv`, labels of running compose
   projects in some paths). A builder is fixing this; the UI must still handle "found nothing" gracefully and allow "point me at the folder".
7. **The Deploys page has lost its purpose.** After the wizard moved into project settings, `/deploys` shows Ready to release, Recent deploys, and Gate presets.
   It is org-wide, hidden from Members, and says nothing about what is live.
8. **Run is also a deploy, but looks unrelated.** Run steps (how to start the app) are needed by card test copies and by local environments,
   yet Run settings and Delivery never mention each other.

---

## 1. The model (words a non-coder uses)

One concept per project: **Environments** ("Where your app runs"). Everything below is a plain-language view of existing objects.

| New word | What it is for the user | Underlying objects (unchanged) |
|---|---|---|
| **Your app** | "How to start the app": the shared start steps | project-wide `RunPlan` (run steps) |
| **Place** | Where something runs: **This computer** (a Guildwise computer with Docker) or **A server** (my own VPS) | `workstation` (+ `deploy_targets` row, kind `local_docker` or `remote_ssh`, SSH host/key, reachability) |
| **Test copy** (per card) | Temporary copy of the app for one card, thrown away after (and the "keep a failed copy for N hours" rule) | run environments (card copies, TTL), integration-test settings |
| **Test site** | Always-on copy for people to try; updates by itself after each merge | delivery environment `uat`-like: trigger `after_merge`, `releasedBy: auto` |
| **Live site** | The real thing customers use; goes out only when you release it, after the test site is healthy | delivery environment with `production` target flag, gate, `releasedBy: owner` |
| **Extra site** (advanced) | Any further named copy (demo, staging 2, a customer's own) | additional delivery environment |
| **Release** | One version going to one site | release queue item, deploy run, approved hash |
| **Rules** | Plain list of what must be true before a release | gate (inline or preset) |

Decisions:

- **D1. Environments are a list, not two slots.** An environment has: a **name and label** (free, with the role chosen from `Test copy` / `Live` / `Other`), a **place**, a **version source**
  (the app is started by the run steps, or by an existing stack that was adopted), an **update rule** ("after each merge" / "when I press Release" / "with each phase"), a **rules** summary and a **status**. Role "Test site"
  and "Live site" only drive defaults and badges; the setup schema allows N environments of any role (the `DeliverySetup.environments[]` array already does; the wizard hard-wires `uat`/`production` and must stop).
- **D2. Places are listed once, in a "Places" section.** A server is added once (connect, scan, reachability, keys, prepare) and then *chosen* by any environment. Today's `deploy_targets` row is exactly a Place; we stop
  asking for a target name in the wizard and derive it (`<place>`; an environment on a place gets its own target row only if it needs a different app address; otherwise the environment references the place). This fixes
  "added a server but couldn't point releases at it" and the duplicate target rows.
- **D3. "How to start the app" is a shared, visible dependency.** An environment on **This computer** that is not an adopted stack says "Starts with your start steps" and links to them. An environment on **a server** says "Updates the existing app by [method]". The run steps live at the top of the Environments page (section "Your app"), not in a second settings tab.
- **D4. One home per audience.**
  - **Project > Environments** (new project page, own route, also reachable from Settings): everything about *setting up and seeing* environments for one project. Owner role edits; Members see read-only status.
  - **Deploys (org page) becomes Releases**: what needs a decision or is moving, across projects. No setup there.
- **D5. The wizard is gone as a wizard; it becomes small focused dialogs launched from the page**, always editing real draft state, never creating anything before "Save". Pain items (remove, add another, change server) are one-click actions on the cards.

---

## 2. Information architecture and navigation

```
Sidebar (org)               Project (tabs in the project header)
 Work: Board, Desk, ...      Board | Research | Phases | Environments (NEW) | Settings
 Organization:
   Workstations   -> "Computers" (Places that are computers; links to Environments)
   Releases       -> (was Deploys; Owner/Admin sees actions, Members read-only)
```

- **Project > Environments** route: `/p/:projectKey/environments` (children via query/hash: `#places`, `#start-steps`, `#rules`, `#history`). Project settings no longer has the sections "Phases and deploys" (deploy parts) and "Run and test"; it keeps
  a one-line card "Environments: 1 live, 1 test, 2 places. [Open Environments]" in the section list so old links work (`/projects/:id/settings#run`, `#phases` redirect to the new page with the matching anchor).
- **Phases stay** a project concept (named slices). Their "follow-ups" (deploy per target) change from picking a *target* to picking an *environment* ("When this phase is done: release to **Test site**, then to **Live site** (waits for you)"). "Default follow-ups" moves from Settings into **Environments > Rules**'s "Releases" subsection ("What a new phase does when it is finished").
- **Card page environment panel** (`RunPanel` / `EnvironmentPanel`): stays on the card but is labelled **Test copy** and links "How it starts" to Environments > Your app. Same component data; copy changes only.
- **Workstations page "run environments"**: becomes a per-computer list of **Test copies running here** (card, age, expires, Stop) plus **Environments on this computer** (read-only links). Server-side nothing changes.
- **Releases (org)**, Owner/Admin: three tabs: **Waiting for you** (release queue), **What is live** (matrix project x environment: version, since, health), **History** (recent deploys with audit) and **Rules** (gate presets, the standard rule, freeze). Members: **What is live** and **History** read-only. Entry points: sidebar, desk "Release waiting" item, project Environments cards ("Waiting for you: 1 release. Open").
- **Mobile**: Environments and Releases are single-column, card-based, with sticky bottom actions; dialogs become full-screen sheets (existing `Dialog` pattern). Tables only in History >= md.
- Breadcrumbs: `Projects > P5 > Environments`; `Organization > Releases`.

---

## 3. Project > Environments page (desktop wireframe)

```
P5 Environments                                              [ Scan with DevOps ] [ Add an environment v ]
Where your app runs. Guildwise looks at what is already there and never changes it without asking.

[!] 1 thing needs you:  "DevOps asks: Which port does the website use?"  [ Answer ]        <- needs-answer banner

YOUR APP  — how to start it                                                       ( set up | needs steps )
 Starts in 4 steps on any computer of this project.  Last start: worked 2 h ago.  [ Edit steps ] [ Test start ]
 Used by: Test copies (cards) and environments on this computer that do not already run.      [ technical details v ]

ENVIRONMENTS
 +------------------------------------------------------------------------------------------------+
 | TEST COPIES  (one per card, temporary)                                  [ Healthy ]            |
 | Runs on: This computer  [Office PC v]     Kept for 6 h after a card fails      [ Change ]       |
 | Right now: 2 running (P5-12, P5-15)   [ Show ]                                                  |
 +------------------------------------------------------------------------------------------------+
 | TEST SITE                                                              [ Healthy ]  v0.9.4 (a1b2c3) |
 | Place: Office PC (this computer)  http://localhost:4700            Updates: after each merge       |
 | Last update: 12 min ago, worked                                                                  |
 | [ Update now ] [ Change place ] [ Edit ] [ ... Remove ]                                          |
 +------------------------------------------------------------------------------------------------+
 | LIVE SITE   (production)                              [ Waiting for your approval ]   v0.9.2    |
 | Place: prod-server (server 203.0.113.10)  https://hq.example.com   Updates: when you release   |
 | Rules: test site healthy on the same version for 10 min * you approve every release              |
 | Not approved yet: the setup changed.   [ Try it without changing anything ] [ Approve ]          |
 | [ Release 0.9.4 ] [ Change server ] [ Edit ] [ ... ]                                             |
 +------------------------------------------------------------------------------------------------+
 [ + Add an environment ]

PLACES  — computers and servers this project can use
 Office PC            this computer (online)      Used by: Test copies, Test site                [ Check ] [ ... ]
 prod-server       server  [Can sign in] 4 min ago   Used by: Live site                        [ Check ] [ Reconnect ] [ Move ] [ ... ]
 old-vps (nothing uses it)  [Cannot reach]                                                        [ Remove ]
 [ + Add a computer ] [ + Add a server ]

RULES  — what must be true before a release            [ Edit rules ]
 Live site: the test site is healthy on the same version for 10 minutes. You approve each release.

HISTORY  — last 10 updates (all environments)   [ See all in Releases ]
 
> Show technical details  (setup file, scripts, what was found)    > Old setups and drafts (1)  [ Clean up ]
```

Card status vocabulary (one chip each, with an action in the card): `Healthy`, `Updating` (spinner), `Needs your answer`, `Waiting for your approval`, `Blocked` (with the reason sentence), `Failed` (with step, plain reason and **Fix with DevOps** / **Try again**), `Not set up`, `Cannot reach` (place), `Draft` (not saved).

Page states:
- **Loading**: skeleton of three cards. **Empty**: see Journey A. **Error**: `ErrorBox` with retry; the Places block still renders from cached data.
- **Runner too old / no computer online**: warning banner "Guildwise on Office PC needs an update to set up environments" with the existing capability text; cards still show last known status.
- **Not Owner**: the same page read-only, buttons replaced by the one sentence "Only the project owner changes environments".

Mobile (360 px):

```
P5 Environments            [ + ]
[!] 1 needs you [Answer]
YOUR APP  Ready  [Edit steps]
-------------------------
TEST SITE     Healthy
Office PC - 0.9.4
after each merge
[ Update now ]  [ ... ]
-------------------------
LIVE SITE     Waiting for you
prod-server - 0.9.2
[ Approve ]  [ ... ]
-------------------------
PLACES (2)  >    RULES >    HISTORY >
```
Each of Places/Rules/History is an accordion that opens inline; "..." is a bottom sheet with Edit, Change place, Remove.

---

## 4. Journeys

Each journey is the same dialog set, entered from the cards. Dialogs are named so tests can find them: **Add environment**, **Choose place**, **Add a server**, **Review what we found**, **Try it**, **Approve**.

### A. First time, project with nothing

Empty state (no environments, no run steps):

```
Where does your app run?
Nothing is set up yet. Pick what you want first:

 ( ) I only want card test copies  -> Your app (start steps) first
 ( ) A test site my team can try, then a live site later
 ( ) Not sure: let DevOps look at my project and my computer   [ Scan with DevOps ]   <- primary
 
 You can do all of it step by step, and nothing changes until you confirm.
```
1. **Scan with DevOps** (also available in "Your app" and in Add environment). The scan covers *both* run steps and environments: DevOps reads the repo, probe reads this computer. Progress callout: "DevOps is looking on Office PC. Usually 2 to 5 minutes. You can leave this page."
2. **Review what we found** (one review, two sections): *Start steps* (Found/Guessed/Unknown rows) and *Environments* (cards "Test site on Office PC, updates after merge", "Live site on a server: needs a server"). Questions (section 5) are answered here. Buttons: **Use this** (merges into the draft), **Test it first**, **Dismiss**.
3. If there is nothing to adopt: "No app is running yet. Guildwise will start a new copy from your start steps." The run steps become step one ("Your app").
4. **Add environment** wizard-free dialog (single screen, 3 fields):
   - "What is this for?" `Test site` / `Live site` / `Something else (name it)`.
   - "Where does it run?" Places list with radio + "This computer: Office PC", "prod-server", **+ Add a server**, **+ Add a computer**.
   - "How is it started?" shown only when it applies: `Use the app that is already running here: shop-uat (found)` / `Start a new copy from my start steps` / `Let DevOps decide`.
5. **Review what we found** (existing `FoundChanges`: Found and will be used / Each update will / Will not be touched / Needs your answer), then **Try it without changing anything** (dry run), then **Save**, then **Approve** (Owner). One linear "Finish" strip at the card: `Saved > Tried > Approved`.

### B. Adopt an existing running local stack (including `/home/administrator/...`)

- Choose place **This computer**, "How is it started?" lists stacks the probe found (labels `com.docker.compose.*` first, then compose files in the project folder, home folders of the computer's user, `/opt`, `/srv`). Each: name, parts, address, "started 3 days ago", folder.
- If the list is empty or the right one is missing: **"My app is somewhere else"** opens "Where is it? (folder on Office PC)" with a text field + browse hint ("the folder that holds docker-compose.yml") and **Look there**; the probe takes the folder as a `hint` (needs a runner support, section 9). Copy on a miss: "We looked in the usual places and in the folder you gave and found no running app. Here is what we checked: [list]. You can start a new copy instead, or ask DevOps to look." Never the bare sentence "No app found".
- After choosing: only the app part is updated, never `down`/`rm` (unchanged semantics), shown in **Will not be touched**.

### C. Adopt an existing server stack

Same dialog, place **A server**: **Choose place** lists servers the computer already signs in to (ssh aliases) with the reachability chip; pick one and the probe reads `/opt`, `/srv`, the user's home and any folder the user types ("My app is in a different folder"). The "Live site" role pre-ticks production. Update method (section 7) is a question here.

### D. Add a second environment (or a second server)

- **+ Add an environment** is always visible (page header, below the cards, and in the empty-after-remove state). Roles are not exclusive: a project may have two test sites or two live sites ("EU live", "US live"). Place can be any existing place; **+ Add a server** inside the dialog returns to the dialog with the new server selected.
- An environment on a **second server for the same role**, e.g. Live site on two servers: not a separate concept. The environment card has "Places: prod-server, guildwise-eu" (multi-select; existing multi-target environments release to ticked servers).

### E. Change an environment's server (and move)

- On the card: **Change server**. Two choices:
  1. "Point this environment at another server I already connected" (instant: changes the place; needs re-approval and a dry run because the generated scripts change; copy says so).
  2. "Move the live site to a new server (with its data)": launches the existing Move wizard (`MoveWizard`), unchanged.
- The old place stays in **Places** with "Used by: nothing" until removed.

### F. Remove things (all with a confirm that says what will happen and what will not)

| Remove | Where | Copy on the confirm | Effect |
|---|---|---|---|
| An environment | card `...` > Remove | "Remove Test site? Guildwise stops updating it. The app that is running on Office PC is left exactly as it is." Checkbox "Also delete its saved release history" is not offered. | removes it from `setup.json`, regenerate, needs approval (dry-run exempt when only removing) |
| A place (server/computer) | Places row > Remove (only when nothing uses it; otherwise "Used by Live site: change that first") | "Remove prod-server from this project? Nothing on the server is touched. Guildwise's sign-in key for it can also be removed: [ ] remove the key" | removes deploy target + optional revoke of the Guildwise key |
| An old setup / draft | "Old setups and drafts" | lists: unfinished draft, files in `delivery/` Guildwise does not make (`unmodelled`), old recipe scripts. Each has a checkbox; **Clean up** | removes draft; `removeFiles` as today |
| A duplicate place | Places, with "Looks like a duplicate of Office PC (same address)" | **Merge** (re-point environments, then remove) | needs `merge target` API (section 9) |
| A proposal | review dialog > Dismiss | | `SetupProposalResolved dismissed` |

Everything that changes approved files re-enters the same Save > Try > Approve strip.

### G. DevOps scan with real questions

Questions come from the proposal `questions[]` (`path`, `question`, `options?`, `default?`). They render as **answerable fields** in the review and in the page banner:

```
2 questions before you can use this
 1. Which part is your app?             ( ) app   ( ) worker   ( ) web      <- radios from options[]
 2. Which port does the website use?    [ 3000 ]  (DevOps guessed 3000)       <- typed field with default
 3. Is this server the live site?       ( ) Yes, customers use it  ( ) No, it is a test site
                                         [ Answer later ]            [ Use these answers ]
```
- Free-text questions get a text input; questions with `options` get radios (up to 5) or a select; yes/no is rendered as two radios; a numeric default shows a number input. The control type is inferred from `options`/`default`; the server stores the answer value.
- An answer is merged into the draft at the question's `path` *by the server* (`POST /api/setup-proposals/:id/answers {answers: [{path, value}]}`), the proposal is re-validated, and the rows it affects flip from Unknown to Answered. Questions never need a JSON-pointer editor in the UI.
- Unanswered questions block **Use this** (as today), except those marked optional (`default` present): "We will use 3000 unless you change it."
- Where they show: inside the review, as a **Needs your answer** banner on the page ("DevOps asks 2 questions"), and as a desk item (existing desk notice) that deep-links to the dialog.
- The old **Answer** button that merely marks "checked" is removed. "Looks right" remains for Guessed rows, as a checkbox, not a button.

### H. Dry run and approval

On each environment card after any change: `Saved > Tried (dry run) > Approved` is shown as a three-dot strip with exactly one next action.
- **Try it without changing anything**: result shown inline in plain words ("Would back up the database, build 0.9.4, copy to prod-server, switch only the app, check https://hq... Nothing was changed."). Failure: plain reason + **Fix with DevOps**.
- **Approve** (Owner): the approval card shows the change list *and* "What changed since the last approval" (existing diff), with the hash in technical details. Non-owners see "Waiting for the Owner's approval".
- Approval remains per bundle hash; the page just labels it "Version 3 approved" / "Changed since approval: needs your approval".

### I. Releasing to live

- A release is "ready" when the test site updated and the rules hold. The Live site card shows **Release 0.9.4** (primary) plus "Rules: the test site has been healthy on this version for 10 minutes (7 minutes to go)" in text, not as a lint message.
- Pressing **Release** opens a sheet: commit/version, what changed (list of merged cards), which place(s) (tick if several), "Back up first" shown as a fact, **Release now**. Refused releases show the missing rules by name ("Waiting for: test site healthy for 3 more minutes").
- The same action exists in **Releases > Waiting for you** (org-wide) and on the desk item.

### J. Seeing what is live

- On the environment card: version, since when, health chip, link to the site.
- **Releases > What is live**: one row per project x environment.
```
Project   Environment   Version   Since        Health    Place
P5        Live site     0.9.2     3 days ago   Healthy   prod-server
P5        Test site     0.9.4     12 min ago   Healthy   Office PC     [ 1 release waiting ]
```
This needs a "current version" per environment (section 9).

### K. Rollback

- Live card `...` > **Go back to an earlier version**. Sheet lists the last 5 successful releases (version, date, who released); choose one; the explanation: "This puts the app back to that version. Your data is not rolled back. The backup taken before the newer release is at /opt/app/backups/... (kept)." Needs Owner approval each time (Release-style sheet with the Owner approving). Uses the existing deploy path with a pinned older commit (same approved recipe; the gate is bypassed only by an explicit "rollback" release kind recorded in the audit).
- Automatic rollback (health failed) shows as a history entry "Went back to 0.9.2 by itself (the new version did not answer)".

### L. Card test copies

- Unchanged mechanism. The page shows the **Test copies** card (kept for N hours after a failed card, how many are running, retry count) and the existing integration-test suites move into it as **Tests that run on a test copy** (suites list, "Run a failing suite again").
- "Test copy" requires "Your app" start steps; if not set up the card says "Card tests need your start steps. [ Set them up ]".

---

## 5. Screens and copy (key ones)

### 5.1 Your app (start steps)

Component: `RunStepsCard` + `RunStepsEditor` reused as is; only the frame and copy change.
- Heading "Your app: how to start it". Subtext: "Test copies and environments on this computer use these steps."
- States: Not set up ("Guildwise does not know how to start your app yet. [ Scan with DevOps ] [ Set up myself ]"), Scanning, Proposal waiting, Ready ("Starts in 4 steps. Last start: worked 2 h ago"), Needs attention (plain failure sentence, **Fix with DevOps**).
- `RunSettings` free-text fields (run instructions, build guide, declared services) move to "Show technical details > Notes for DevOps".

### 5.2 Add environment dialog

```
Add an environment
What is it for?       (o) Test site   ( ) Live site   ( ) Something else [ name ]
Where does it run?    (o) Office PC (this computer)   ( ) prod-server (server)   [ + Add a server ] [ + Add a computer ]
How is it started?    (o) The app that is already running here: shop-uat   ( ) Start a new copy   ( ) My app is somewhere else
When should it update? (o) Automatically after each merge   ( ) Only when I press Release
                       (Live site: only "when I press Release" is offered; the rules and your approval are on.)
[ Cancel ]                                                        [ Next: see what we found ]
```
Copy for the live-site explainer: "Live is never used for tests, and every release needs your approval. The test site must be healthy on the same version first." (editable rules in **Rules**).

### 5.3 Add a server

Flow reuses `ConnectServer` (existing sign-in, password once, key file, hosting panel paste, fingerprint confirm) and `PrepareServer`. Differences: it is launched from Places, creates a **Place** only (no environment, no target name field), and ends on a "Looking at the server" probe summary: "Found 1 app in /home/administrator/shop (3 parts, answers at https://...)." or the not-found text of Journey B. Result is stored once and offered in every Choose place list.

### 5.4 Review what we found

`FoundChanges` and `ProposalReview` merged into one **Review** dialog with three tabs on desktop, accordion on mobile: **Found**, **Each update will**, **Will not be touched**, plus the **Needs your answer** area on top (answerable fields). Buttons at the bottom: **Back**, **Try it**, **Save**.

### 5.5 Releases page (org)

```
Releases
[ Waiting for you (2) ] [ What is live ] [ History ] [ Rules ]

WAITING FOR YOU
 P5  Live site   0.9.4 (a1b2c3)   from 3 merged cards   Rules: all met  [ Release ] [ Not now ]
 P7  Live site   1.2.0            Rules: waiting for the test site (4 min)      (button disabled, reason shown)
 
WHAT IS LIVE   (table on md+, cards on mobile)
HISTORY        filter: project, environment, result   > row opens audit (recipe version, rules, who asked, who released, log)
RULES          Standard rule: "test site healthy 30 min, regression passed, weekdays 08-16"  [ Edit ]
               Freeze: [ off ]   -> "Nothing goes live while this is on"
               Rule presets (advanced) ...
```
Empty: "Nothing is waiting. Releases appear here when a version is ready for a live site." States: loading skeleton, error retry, Member read-only.

Gate presets and the freeze become "Rules" in plain words: each gate condition has a sentence (`envHealthy` -> "The test site is healthy on the same version for 10 minutes"; `checksPassed` -> "Regression tests passed"; window -> "Only on weekdays 08:00-16:00"). The raw preset editor sits behind "Advanced".

---

## 6. States table (per environment card)

| State | Chip | Sentence | Primary action |
|---|---|---|---|
| Draft only | Draft | "Not saved. Nothing has changed yet." | Review, Save |
| Saved, not tried | Needs a try | "Try it before the Owner approves." | Try it |
| Tried, not approved | Waiting for approval | "Tried: would work." | Approve (Owner) |
| Approved, idle | Healthy | "Version 0.9.4 is live since ..." | Update now / Release |
| Updating | Updating | step names in words | View log |
| Needs answer | Needs your answer | "DevOps asks 2 questions" | Answer |
| Blocked by rules | Blocked | "Waiting for: test site healthy for 3 more minutes" | (none) |
| Blocked by place | Cannot reach | "Office PC is offline" / "Cannot sign in to prod-server" / "Server identity changed" | Check / Reconnect |
| Failed | Failed | "The update stopped at Check the site: no answer from https://..." plus "Went back to 0.9.2" if it did | Fix with DevOps / Try again |
| Changed outside | Changed | "Someone changed the deploy files. Review and approve, or go back." | Review |
| Hand-edited | Custom | "Edited by hand: shown as a script." | Back to guided |

---

## 7. Update methods (the "How does the app get onto the server" question)

Shown in the Add environment dialog only for a server place, after the probe, as one question "How should new versions get onto the server?":

1. **Download a ready-made app from a registry** (pull): "The server pulls ghcr.io/org/app:<version>. Best when you already publish images." Asks: registry address (prefilled from the compose file), login stored on the server (name only).
2. **Build it on the server**: "The server builds the app from the approved code." Needs the repository on the server and build tools; warning about build time and memory.
3. **Build here and copy it** (today's behaviour): "Guildwise builds on Office PC and sends the app to the server."

Defaults: prefer what the compose file implies (image with a registry host -> pull; `build:` -> build on server; otherwise copy). Each maps to a step kind in the compiler (`registry_pull`, `build_on_server`, `ship_image_ssh`); the choice is stored on the environment (`app.updateMethod`).

---

## 8. What to delete or merge from today's UI

| Today | Fate |
|---|---|
| `pages/ProjectSettings.tsx` sections "Phases and deploys" and "Run and test" | Remove from Settings; add the `Environments` entry card and redirects for `#phases`/`#run`. `PhasesPanel` (the phases list) stays under the Phases tab (move out of Settings too). |
| `DeployTargetsPanel.tsx` (always-open add form, per-target cards) | Replace by **Places** list (`PlacesPanel.tsx`) built on the same hooks (`useRemoveDeployTarget`, reachability chip, reconnect). Its "Add" form and `TargetTesting` expander are deleted (testing flags move into the environment's Edit dialog for the Test copy card; production flag into the environment). |
| `runs/TargetTesting.tsx` | Merge into Edit dialog of Test copies / environment ("Used for card tests", "Tests may change data"). |
| `delivery/setup/DeploySetup.tsx` (Overview/EnvCard/Approval/OldServers/ImprovedSteps) | Becomes `EnvironmentsPage` with `EnvironmentCard`; keep `Approval`, `ImprovedSteps`, scan/proposal callouts, `OldServers` (-> Places). |
| `delivery/setup/DeployWizard.tsx` (1374 lines, uat/production-hardwired, creates targets) | Replace by `AddEnvironmentDialog` + reused `FoundChanges`, `SecretsStep`, `WhenStep` fragments; remove the target creation/patch at end of "Where"; remove `testEnvExists` logic. |
| `delivery/setup/AdvancedSetup.tsx` | Keep as "Show technical details". |
| `delivery/DeliveryPanel.tsx` (mode select, lint, approve, deploy buttons) | Merge: approval and lint into environment cards ("Approve" strip); mode select hidden (always Recipe once guided setup is approved); manual Deploy buttons -> "Update now"/"Release". Delete the standalone panel. |
| `components/PhasesPanel.tsx` `FollowupDefaultsPanel` | Re-key follow-ups from target to environment; move defaults to Environments > Rules. |
| `components/setup/ProposalReview.tsx` "Answer" button | Replace by answerable fields; keep Use/Dismiss. |
| `pages/Deploys.tsx` | Rename `Releases`; tabs: `ReleaseQueue` (Waiting), new `LiveMatrix`, `DeployRuns` (History), `GatesPanel` (Rules). Route `/deploys` redirects to `/releases`. |
| `runs/RunSettings.tsx` | Keep only the technical-details parts (notes, saved plans). `IntegrationTestsSettings.tsx` moves into the Test copies card. |
| `runs/RunPanel.tsx` (card) | Copy change: "Test copy". |
| Nav label "Deploys" | "Releases". Help (`/deploys` entry in `page-help-content.ts`) and USER-GUIDE sections rewritten. |

Old concept -> new concept:

| Old | New |
|---|---|
| Run plan / run steps / Run and test | **Your app: how to start it** |
| Run environment (card copy) | **Test copy** |
| Deploy target (kind `local_docker`/`remote_ssh`) | **Place** (computer or server) |
| Delivery environment `uat` | **Test site** (role) |
| Delivery environment `production` / target `production` flag | **Live site** (role) |
| Delivery recipe + `setup.json` + approved hash | **The setup** (invisible); status chips Saved/Tried/Approved |
| Delivery mode (Instructions/Recipe) | Hidden; Recipe once guided setup exists |
| Gate / gate presets / standard rule / freeze | **Rules** (sentences) |
| Release queue | **Waiting for you** (Releases) |
| Deploy runs | **History** |
| Phase follow-up "deploy to <target>" | "Release to <environment>" |
| DevOps scan proposal (run or deploy) | **Scan with DevOps** + Review |
| Draft (`DeliverySetupDraft`) | "Unfinished changes" |

---

## 9. API and backend gaps the UI needs

Already being fixed by the builder (assumed available): probe finds stacks from container labels and home dirs; update methods registry pull / build on server / copy from computer; server-side merge of proposals; removal APIs; proposal answers storage; target matching by host.

Additional gaps (name, shape, why):

1. **Place as a first-class object / listing**: `GET /api/projects/:id/places` -> `[{id, kind:'computer'|'server', name, workstationId?, host?, reachability, lastProbeAt, usedBy:[envName], duplicateOf?}]`, derived from `deploy_targets` + connection + latest probe. Needed for Choose place, Used by, duplicate hint. No new storage if derived.
2. **Environments not limited to `uat`/`production`**: setup schema/compile already supports a list; server `DeliverySetup` validation and `planChanges`/lint must not assume names; `role: 'test'|'live'|'other'` optional field on `SetupEnv`. Lint rule "production with auto + no gate" keyed on the target's production flag stays.
3. **Environment references a place, not a target name** (or the server derives the target): `SetupEnv.place?: placeId`; compatibility: `target` remains the stored key; the server creates/reuses one target per (place, appUrl) so no UI-created duplicates. Add `POST /api/deploy-targets/merge {fromId, toId}` re-pointing environments and queued releases.
4. **Probe hints**: `deploy.probe` accepts a user-typed folder (any absolute path under the user's home, `/opt`, `/srv`) for local and ssh, bounded; result lists "checked" locations so the UI can say what was looked at; error kind `nothing_found`.
5. **Answerable questions**: proposal answers endpoint `POST /api/setup-proposals/:id/answers` (answers merged at `path`, re-validation, returns new proposal + remaining questions); `SetupProposal.questions[].kind?: 'text'|'choice'|'number'|'yesno'`, `optional?: boolean`; stored answers survive reload.
6. **Current version per environment**: `GET /api/projects/:id/environments/status` -> `[{env, version, commit, since, health, lastRun, waitingRelease?, approvalState, savedState, triedState}]` from deploy runs + health. For Releases > What is live: `GET /api/org/live`.
7. **Rollback release kind**: `POST /api/projects/:id/releases {env, commit, kind:'rollback'}` allowed only to a previously successful commit of that environment, Owner/Admin, audited; gate treats it as `rollback` (no test-site requirement). Also list of last N successful releases.
8. **Removal APIs** (builder has them): environment remove (edit `setup.json` + publish), place remove with optional `revokeKey`, draft discard, `unmodelled` cleanup.
9. **Follow-ups keyed by environment**: `phase_followups` deploy action gains `environment?: string`; old `targetId` stays for Instructions mode.
10. **Rules in sentences**: server returns `GateDto.summary: string[]` (or the web maps from the gate schema in shared; prefer shared function `describeGate(gate)`).
11. **Members read-only**: `GET /api/projects/:id/environments/status` and `/api/org/live` allowed to project members (no actions, no secrets); the Releases page must not be Owner/Admin-only.
12. **Redirects**: `/deploys` -> `/releases`, `/projects/:id/settings#run|#phases` -> `/p/:key/environments#...` (web only).
13. **Desk deep links** for "Release waiting" and "DevOps asks a question" -> the page + dialog param (`?dialog=answer&proposal=<id>`).

---

## 10. Accessibility checklist

- Every card is a `<section aria-labelledby>`; status chips have text, never colour alone; icons `aria-hidden` with adjacent text.
- Dialogs: focus trap, `Esc` closes, return focus to the opener, first field focused; steps announce "Step 2 of 3" in a polite live region.
- Radios in groups with `fieldset/legend` (What is it for? Where does it run?). Answerable questions: `label` tied to control, default stated in text, errors via `aria-describedby`.
- Progress and results (scan, try, update) use `role="status"`/`aria-live="polite"`; failures `role="alert"`.
- All actions >= 44 px touch targets on mobile; `...` menus are real buttons with `aria-haspopup="menu"`; bottom sheets usable by keyboard.
- Destructive confirms name the object and say what is NOT touched; default focus on Cancel.
- Disabled buttons are paired with a visible reason sentence (not only `title`).
- Contrast of chips >= 4.5:1; reachability chips include time ("4 min ago").
- Reduced motion: no spinner-only status; spinner labelled.
- Tab/accordion pattern on mobile Releases follows WAI-ARIA tabs; History table has headers and becomes a list on small screens.
- Plain language: reading level around grade 8; technical terms only in "Show technical details".

---

## 11. Implementation notes for the feature-builder

Pass order matters: build the web with the shared hooks that exist, then the few server gaps.

Reuse as is: `RunStepsCard`, `RunStepsEditor`, `RunTestPanel`, `ProposalReview` frame, `FoundChanges`, `AdvancedSetup`, `ConnectServer`, `PrepareServer`, `MoveWizard`, `ReachabilityChip`, `KeysList`, `ReleaseQueue`, `DeployRuns`, `GatesPanel` (as Rules advanced), queries in `api/queries/{deploy-setup,deploy-move,delivery,run-plan}.ts`, `Dialog`, `Callout`, `Badge`, `Panel`.

New web files:
- `pages/ProjectEnvironments.tsx` (route `/p/:projectKey/environments`, anchors).
- `components/environments/{EnvironmentCard,PlacesPanel,AddEnvironmentDialog,ChoosePlace,AnswerFields,LiveSummary,RulesSummary,ReleaseSheet,RollbackSheet,CleanUpDialog,StatusStrip}.tsx`, `environments/model.ts` (status derivation from `SetupStateDto`, rules sentences via shared `describeGate`).
- `pages/Releases.tsx` (replaces `Deploys.tsx`) + `delivery/LiveMatrix.tsx`.
- Edits: `router.tsx` (new routes, redirects), `nav-config.ts` (label, Members see Releases), project header tabs, `Breadcrumbs.tsx`, `page-help-content.ts`, `PhasesPanel.tsx` follow-ups, `Workstations.tsx` copy, `CardDetail/RunPanel` copy, `ProjectSettings.tsx` (remove two sections, add pointer card).
- Delete after migration: `DeployTargetsPanel.tsx`, `DeployWizard.tsx`, `DeliveryPanel.tsx` (ports kept pieces), `TargetTesting.tsx`; update their tests (`runs-ui.test.tsx`, deploy-setup tests).

Conventions: Tailwind classes and `ui.tsx` primitives as today; `data-testid`s on the page, each card (`env-card-<name>`), places (`place-<name>`), strips (`env-strip-<name>`), answer fields (`answer-<index>`), banner (`needs-answer`), to feed e2e. Feature flag `environments_ui` for one release so old Settings sections can be reverted in a day.

Copy rules: never "target", "recipe", "gate", "hash", "probe", "compose" outside technical details; say "place", "setup", "rules", "version", "looking", "app".

### Build plan (one focused, web-heavy pass; ~8-10 dev-days)

1. (1 d) Routes, nav (Releases), redirects, project Environments shell with cards derived from the existing `useSetupState` + targets; settings pointer card.
2. (1.5 d) `EnvironmentCard` with state machine and Saved/Tried/Approved strip (reuse Approval, dry-run hooks); remove `DeliveryPanel`.
3. (1.5 d) `AddEnvironmentDialog` + `ChoosePlace` + Places list; roles not hard-wired (needs gap 2, 3); drop `DeployWizard` creation of targets.
4. (1 d) Removal flows (environment, place, drafts/old setups), duplicate merge (gap 3, 8).
5. (1 d) Answerable questions (gap 5) in the Review and banner; update `mock-agent` proposals to include choice/number questions.
6. (1 d) Your app + Test copies cards (move IntegrationTests/TargetTesting), copy changes in card page and Workstations.
7. (1.5 d) Releases page: Waiting, What is live (gap 6, 11), History, Rules sentences (gap 10); rollback sheet (gap 7).
8. (0.5 d) Phase follow-ups re-key (gap 9), help text, USER-GUIDE rewrite of Run and test / 4.10 / 4.27.
Server work in parallel by the builder: gaps 1, 2, 3, 4, 5, 6, 7, 9, 11. Web ships behind the flag; MSW handlers extended in `mocks/handlers-deploy-setup.ts` for places, status, answers.

---

## 12. Acceptance tests (Playwright e2e, user journeys)

Use the existing e2e harness (own port/db/folder, throwaway compose stack, mock DevOps). Each test asserts visible text and ids.

1. **First-time empty project.** Open Environments on a project with nothing: the empty state shows three choices; **Scan with DevOps** produces a review with a start-steps section and one environment; unanswered question blocks **Use this**; answering a choice question (radio) and a number question enables it; after Use, the page shows Your app "Ready" and a draft Test site card.
2. **Answer is a real answer.** In the review, the "Which part is your app?" question shows radios `app / worker / web`; choosing `app` and saving, then reloading, still shows it answered and the draft's service is `app` (no "Answer" button exists anywhere).
3. **Adopt a running local stack in a non-standard folder.** With a compose stack running from a folder under the user's home: Add environment > Test site > This computer lists it ("found"); choose it, review shows the other containers under **Will not be touched**; Try it; Save; Approve; container ids of the non-app services unchanged afterwards. Also: when nothing is found, "My app is somewhere else" with the folder finds it, and the miss copy lists where it looked and never says only "No app found".
4. **Add a second environment while one exists.** With a Test site present, **Add an environment** is available, Live site is created on a server; then a third environment ("Demo", role Something else) on the same place works; no duplicate place rows appear (Places lists each once).
5. **Add a server and point a release at it.** From Places **Add a server** (existing sign-in alias), then edit the Live site > Change server to it; card shows the new place, needs re-approval; after Try + Approve the Release sheet lists that server.
6. **Remove.** Remove an environment (confirm names what is not touched; the app keeps running), remove an unused place, clean up a draft and an `unmodelled` file; a place used by an environment cannot be removed and says which environment uses it; duplicate merge re-points the environment.
7. **Dry run and approval.** After a change the strip shows Saved; Approve is disabled until Tried succeeds; Owner approves; a Member sees "Waiting for the Owner's approval".
8. **Release to live.** Merge on test site; Live card shows "Waiting for: test site healthy for N minutes" then **Release** becomes enabled; releasing from Releases > Waiting for you updates "What is live" version and History shows the audit with the rules.
9. **Rollback.** Go back to an earlier version from the Live card: sheet lists previous successes; after confirmation What is live shows the older version and History shows "rollback".
10. **Card test copy.** A card integration test starts a Test copy using Your app steps; the Test copies card shows it running with expiry; Stop removes it; a failed copy is kept for the configured hours.
11. **Members and mobile.** A Member sees What is live and History read-only and no action buttons; at 360 px the Environments page is single-column, the Add environment dialog is a full-screen sheet and every primary action is reachable without horizontal scroll.
12. **Redirects.** `/deploys` lands on `/releases`; `/projects/:id/settings#run` lands on Environments > Your app.
13. **Unreachable place.** Take a server offline: card shows Cannot reach with Reconnect/Check; updates are blocked with the reason sentence; after Reconnect the chip is Can sign in.

---

## 13. API contract (as built)

Written before the implementation so the web can code against it. Schemas live in `packages/shared/src/delivery/environments.ts`
(places, status, live, rollback, removal, answers, merge info), `delivery/gate-text.ts` (`describeGate`), and the extended existing
schemas named below. Errors use the normal `{error:{code,message}}` body; codes are listed per route. Roles: "project owner" =
`projectOwnerOrThrow`; "member" = any active project member (`loadVisibleProject`); "org Owner/Admin" = org role.

### 13.1 New routes

| Route | Who | Request | Response | Notes / error codes |
|---|---|---|---|---|
| `GET /api/projects/:id/places` | member | | `PlacesResponse` | A place is a deploy target. `usedBy` = environments of the SAVED setup, `usedByDraft` = only in the draft. `duplicateOf` is set on the newer of two matching places. |
| `POST /api/projects/:id/places/:placeId/remove` | project owner | `{removeKey?: boolean}` | `RemovePlaceResult` | 409 `place_in_use` (message names the environments, saved or draft, and unfinished follow-ups); 409 `target_in_move`. The place is removed first; with `removeKey` a `deploy.revoke {forget:true}` is sent to the deploying computer when it is the caller's own, online and has `deploy-setup:2` (`keyCleanup.state` says `started`/`skipped` and why). An unreachable server never blocks the removal. |
| `POST /api/projects/:id/places/merge` | project owner | `{fromId,toId}` | `MergePlacesResult` | 422 `not_duplicates` unless the places have the same kind and (same alias on the same computer, or the same computer). Re-points draft environments and unfinished follow-ups; removes `fromId` only if no saved environment uses it. |
| `PUT /api/projects/:id/delivery/setup/environments/:env/place` | project owner | `{placeId}` | `SetupStateDto` | Changes `target` (and `host` for a server) of that environment in the draft (draft = current setup if none yet). 422 `kind_mismatch` if the environment's hosting does not fit the place (a server environment needs a server place). Needs publish + dry run + approval like any change. |
| `POST /api/projects/:id/delivery/setup/remove-environment` | project owner | `{env}` | `SetupStateDto & RemoveEnvironmentResult` | Takes the environment out of the draft; rules in other environments that referred to it are dropped (listed in `impact`). 422 `last_environment` for the last one (use stop-guided). Publishing the draft also deletes `scripts/<env>.sh` (never any other file). Nothing running is touched. |
| `POST /api/projects/:id/delivery/setup/discard-draft` | project owner | `{}` | `SetupStateDto` | `draft` is `null` afterwards. |
| `POST /api/projects/:id/delivery/setup/stop-guided` | project owner | `{confirm:true}` | `SetupStateDto` | Delivery mode becomes `instructions`, the draft is cleared. Targets, keys, the vault files and the approved recipe stay (no further release runs from it). `deliveryMode` in the state tells the page. |
| `GET /api/projects/:id/environments/status` | member | | `EnvironmentsStatusResponse` | Read-only; no secrets, no log text. `state`/`stateText` are final wording for the card chip. |
| `GET /api/projects/:id/environments/:env/releases?limit=5` | org Owner/Admin | | `EarlierReleasesResponse` | Last N successful real releases (rollbacks included), newest first, `current` marks the running one. Members: 403. |
| `POST /api/projects/:id/releases/rollback` | org Owner/Admin | `RollbackRequest` | `DeployResult` | 422 `not_a_previous_release` (run not successful / other env / dry run); 409 `frozen`. Run has `trigger:'rollback'`; evidence line "rollback to <commit> (earlier release <runId>)"; is released at once: the Owner or Admin who asks IS the one who releases (the same rule as the Release button), so the confirm sheet is the approval; the result is the normal `DeployResult` (`queued` or `refused` with the reason). |
| `GET /api/org/live` | any org member | | `OrgLiveResponse` | One row per project x environment of projects the viewer can see. |
| `POST /api/setup-proposals/:id/answers` | project owner | `AnswerProposalRequest` | `ProposalDto` | Stores `answer` on each question (by `path`), applies it to the proposal's draft value at `path` (number if that value is a number, boolean for a boolean, else string), re-validates the proposal. 422 `bad_answer` (not in `options`, empty for a required question, fails the setup schema) names the question. 409 `proposal_resolved`. Unanswered required questions still block `use-proposal` (409 `questions_open`). |

### 13.2 Changed routes

- `POST .../delivery/setup/use-proposal` -> `UseProposalResult` (= `SetupStateDto` + `merge: {added, replaced, notCovered}`). A proposal now MERGES into the draft (draft, else the saved setup) by environment name; existing environments the proposal does not mention are kept untouched and listed in `notCovered`. Questions with an `answer` are applied; required questions without one -> 409 `questions_open`.
- `POST /api/projects/:id/deploy-targets` accepts `reuseExisting: true` -> 200/201 with the matching existing target and `reused: true`.
- `DELETE /api/deploy-targets/:id` -> 409 `place_in_use` (names environments) before the old follow-up check.
- `GET .../delivery/setup` gains `deliveryMode`, `workstations[].canNewMethods`, and `draft` is `null` when there is no draft setup.
- `POST .../delivery/probe`: `hints.dirs` is also the typed folder ("My app is in this folder"). For a server it must be an absolute path under the sign-in user's home, `/opt` or `/srv`; for this computer under the user's home, `/opt`, `/srv`. Result `ProbeReport.checked: string[]` lists the folders and compose files that were looked at (absent from an old runner, which only looks in /opt and /srv for servers). "Nothing found" is an `ok:true` report with no container that has a `project` and no `composeFiles`; there is no `nothing_found` error code.
- Setup schema: `SetupEnv.role?: 'test'|'live'|'other'`; names are free (`[a-z0-9-]`). Nothing on the server assumes `uat`/`production` any more (the gate default for a live site is built from the first `role: 'test'` environment, else none).
- `SetupApp`: `imageVar` optional (absent = the new version is named in `docker-compose.guildwise.yml` next to the compose file), `registry?`, `sourceDir?`. Update method is derived from the steps (`updateMethodOf`: `ship` | `registry` | `build_on_server`); builders: `sshShipEnv({method, registry, registryPush, sourceDir, imageVar?})`. Section 7's `app.updateMethod` field is NOT stored (derived).
- `ProposalQuestion`: `kind?: 'text'|'choice'|'confirm'` (`confirm` answers are `"yes"`/`"no"`), `optional?`, `answer?`.
- Phase follow-up spec `{kind:'deploy'}` takes `environment` (env name) instead of `targetId` (one of the two); the DTO echoes `environment` and the resolved `targetName`. Old `targetId` follow-ups keep working. Resolving an environment uses the SAVED setup; 422 `unknown_environment` otherwise.
- Version skew: any save/publish of a setup that uses the override file or the registry/build-on-server steps needs capability `deploy-setup:2` on the computer that writes the vault (409 `runner_outdated`: "Guildwise on <computer> needs an update for this way of updating"); `workstations[].canNewMethods` tells the page beforehand. `deploy.revoke {forget}` needs `deploy-setup:2` as well.

### 13.3 Status vocabulary (`EnvironmentStatusDto.state`)

`not_set_up`, `draft` (only in the draft), `needs_try` (saved, no successful dry run of this version), `waiting_approval` (tried, not approved), `healthy`, `unhealthy` (last health check failed), `updating` (a run is queued/running), `needs_answer` (open proposal question for it), `blocked` (a release waits for rules; `blockedBy` has the sentences), `cannot_reach` (the place is offline / ssh failed), `failed` (last real run failed or refused; `lastRun.rolledBack` says it went back by itself), `changed` (files changed outside Guildwise since approval), `custom` (hand-edited or custom script). The server picks exactly one by this order: updating, cannot_reach, needs_answer, failed, changed, custom, draft, needs_try, waiting_approval, blocked, unhealthy, healthy, not_set_up.

### 13.4 Apps that run directly on the machine (no Docker)

For an app that runs as a systemd unit, a pm2 process or a command of the person's own, on this computer or on a server over ssh.
Same safety rules as Docker environments: nothing unrelated is stopped, no release folder in use is ever deleted, `sudo` only when the
person confirmed a restart that needs it and passwordless sudo exists, a database backup first when asked (a failed backup stops
everything), health check, automatic rollback.

**Setup shape** (`packages/shared/src/delivery/setup.ts`): `SetupEnv.hosting` still says where (`this_computer` | `ssh`);
`SetupEnv.runtime?: 'docker' | 'direct'` (absent = docker) says what runs; `SetupEnv.direct?: DirectApp` is required when `runtime` is `direct`:

```
DirectApp = {
  appDir: absolute path          // holds releases/<12-char commit> and the symlink current -> releases/<sha>
  keep: 2..30 (default 5)        // release folders kept; the running and the previous are never removed
  build: [{label, argv[]}]       // run in the NEW release folder, in order (from "Your app" start steps where they fit)
  manager: {kind:'systemd', unit, scope:'system'|'user', sudo:boolean}   // scope 'user' = systemctl --user, never sudo
         | {kind:'pm2', name}
         | {kind:'command', restart: argv[], sudo:boolean}
  shared: string[]               // paths in <appDir>/shared linked into every release (.env, uploads)
}
```
For a direct environment `app.composeFile` holds `appDir`, `app.service` the unit/process name and `app.imageName` the app's name (labels only; the builder
`directEnv(...)` in `setup-templates.ts` fills them). `app.appUrl`, `health`, `rollback`, `trigger`, `releasedBy`, `gate` mean the same as for Docker.
Steps (in this order, each once): optional `direct_db_backup {engine:'postgres'|'mysql'|'sqlite', database?, sqliteFile?, dir, keep}`
(uses the signed-in user's own database access: peer auth, `~/.pgpass`, `~/.my.cnf`), then `direct_prepare`, then `direct_switch`. Builder:
`directEnv({name,label,target,host?,appDir,manager,build,shared,keep,database?,healthUrl?,appUrl?,...}, testEnv)` returns the `SetupEnv`
(`hosting` is `ssh` when `host` is given).

**Probe** (`ProbeReport`, scopes `local` and `ssh_target`): `services?: ProbeService[]` and `appDirs?: string[]`.
`ProbeService = {manager:'systemd'|'systemd_user'|'pm2'|'process', name, state, workingDir?, command?, ports[], user?, releaseLayout?}`
(systemd = running units with a `WorkingDirectory` under a home folder, `/opt`, `/srv`, `/var/www`; `systemd_user` = `systemctl --user`; pm2 from
`pm2 jlist`; `process` = listening non-system processes with their cwd; `releaseLayout` when `<dir>/releases` and `<dir>/current` exist).
`appDirs` = folders that look like app folders (`/var/www/*`, `/srv/*`, `/opt/*`, `~/apps/*`, `~/*` with a `package.json`, `requirements.txt`, ...), names only.
No environment values and no file contents are ever reported.

**Capability** `deploy-direct:1` (`DEPLOY_DIRECT_CAPABILITY`): the computer that probes and the one that writes the vault need it.
Server: `SetupStateDto.workstations[].canDirect?: boolean`; saving/publishing a setup with a direct environment on a runner without it gives
409 `runner_outdated` and a lint error `runner_update_needed`. Status (`EnvironmentStatusDto`) gains `runtime: 'docker'|'direct'`.

**What "adopt" means**: the person picks a detected service (manager + name + workingDir + ports); the wizard fills `manager` from it and asks only what
cannot be found: the restart confirmation (and sudo), the build steps, which files stay shared. The service must start from the symlink path
(`direct.currentLink`, default `<appDir>/current`). Three cases, decided by the wizard from `ProbeService.workingDir` / `releaseLayout`:

1. It already runs from a `.../current` link of a releases layout: `appDir` = the parent folder, nothing to convert.
2. It runs from a plain folder `D` (for example `/var/www/shop`): the wizard sets `currentLink = D`, `appDir = <D>-app` (a new sibling folder, editable) and
   `adoptFolder = true` after a plain confirmation: "The first update moves the folder /var/www/shop to /var/www/shop-app/releases/initial and puts a link with the
   same name in its place. Nothing is deleted or copied; the app keeps running from the same files." Without `adoptFolder` the script refuses a plain folder.
3. A command of the person's own (`manager.kind = 'command'`): the same two fields apply; Guildwise never edits a unit file.

`EnvironmentStatusDto.savedState`: `none` = the environment exists only in the unfinished draft (nothing is saved yet), `draft` = saved, and the draft has changes to it that are not saved, `saved` = what is saved is what you see.

**As built (direct environments)**: shared builder `directEnv` and `SetupEnv.runtime/direct` are in `packages/shared`; `SetupStateDto.workstations[].canDirect`
(capability `deploy-direct:1`, `DEPLOY_DIRECT_CAPABILITY`); `EnvironmentStatusDto.runtime`; `ProbeReport.services/appDirs`; lint `runner_update_needed` and
409 `runner_outdated` for a direct environment on a computer without the capability; `planChanges` lists the found service ("The service "shop" is running and
runs from ..."), what stays untouched (other services, pm2 processes, containers), the folder adoption, and the steps in words. The probe of a machine with no
Docker but with apps now answers with a report (`docker.installed:false`) instead of `docker_missing`; with neither it still says `docker_missing`.
