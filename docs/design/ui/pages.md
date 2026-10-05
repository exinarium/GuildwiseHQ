# Page-by-page audit and redesign

Scope: every route in `apps/web/src/router.tsx` and the components they render. Screenshots of the current state (empty mock data; the board and card pages are described from `docs/guide/raw/*.png`, which are real captures of a populated instance) are in `docs/design/ui/current/` as `<page>-d.png` (1440 x 900) and `<page>-m.png` (390 x 844).

Priorities: **P1** = first impression and daily use (shell, sign-in, Board, Desk, Card). **P2** = weekly use. **P3** = occasional / admin.

Common conventions used below (defined in `design-system.md` and `layout-and-navigation.md`): `PageHeader` with breadcrumb and wrapping title, `Panel`, `EmptyState`, `Skeleton*`, `ConfirmDialog`, `Toast`, `Tabs`, widths `narrow|default|wide|full`.

## 0. Route inventory

| # | Route | Component | Priority |
| --- | --- | --- | --- |
| 1 | `/login` | `pages/Login.tsx` | P1 |
| 2 | `/invite/:token` | `pages/AcceptInvite.tsx` | P1 |
| 3 | `/` | `Home` in `router.tsx` (redirect to last project's board or `/projects`) | P1 |
| 4 | `/p/:projectKey/board` | `pages/Board.tsx`, `components/BoardView.tsx` (+ `RegressionDialog`, `WorkabilityWarning`) | P1 |
| 5 | `/desk` | `pages/Desk.tsx` (+ `ChatDrawer`, `LedgerForm`, `MappingForm`, `OutboundApproval`, `DigestRating`, `EscalationTrail`) | P1 |
| 6 | `/cards/:ref` | `pages/CardDetail.tsx` (+ `CardEdit`, `EvidencePanel`, `FinalizePanel`, `OutboundHistory`, `PublicationPanel`, `ShiftLog`, `ThreadPanel`) | P1 |
| 7 | `/cards/new` | `pages/CardNew.tsx` (+ `CardFormFields`) | P1 |
| 8 | `/agents` and `/hr` (same component) | `pages/Agents.tsx` (+ `components/hr/*`) | P2 |
| 9 | `/projects` | `pages/Projects.tsx` (+ `ProjectInvitations`) | P2 |
| 10 | `/projects/:id/settings` | `pages/ProjectSettings.tsx` (+ `MergePolicyPanel`, `MembersPanel`) | P2 |
| 11 | `/workstations` | `pages/Workstations.tsx` (+ `DevOpsPanel`, `SandboxWarning`) | P2 |
| 12 | `/ledger` | `pages/Ledger.tsx` (+ `LedgerForm`) | P2 |
| 13 | `/intake` and `/intake/:id` | `pages/Intake.tsx` (`IntakeNew`, `IntakeView`) | P2 |
| 14 | `/chat/:threadId` | `pages/Chat.tsx` (+ `ChatPanel`) | P2 |
| 15 | `/settings/vaults` | `pages/Vaults.tsx` | P2 |
| 16 | `/org` | `pages/OrgDesigner.tsx` (+ `components/org/*`) | P2 |
| 17 | `/schedules` | `pages/Schedules.tsx` | P3 |
| 18 | `/p/:projectKey/feed` | `pages/FeedProject.tsx` (+ `DigestRating`, `Transcript`) | P3 |
| 19 | `/metrics` | `pages/Metrics.tsx` (+ `components/hr/Charts.tsx`) | P3 |
| 20 | `/admin` | `pages/Admin.tsx` (+ `WorkstationCard`) | P3 |
| 21 | `*` | redirect to `/` | n/a |
| (soon) | Phases | not built; see section 22 | P2 once shipped |

## 1. Cross-cutting problems (affect every page)

| Problem | Where | Fix |
| --- | --- | --- |
| Top-tab navigation with 13 items; unusable on mobile | `components/Layout.tsx` | New shell (see layout doc) |
| Loading is the text "Loading..." in a grey paragraph | `ui.tsx` `Spinner`, used ~25 places | Layout-shaped skeletons, delayed 150 ms |
| Empty states are one grey sentence in a bordered box, no action | `Ledger`, `Projects`, `Workstations`, `Agents`, `Desk`, `Schedules`, `Vaults`, `Feed` | `EmptyState` with icon, explanation, primary action |
| Mutations give no feedback (or ad hoc `<p role="status">Saved.</p>` in `ProjectSettings.tsx`, emerald-600 on white = 3.8:1, fails AA) | all forms | `useToast()`; keep inline errors |
| Destructive actions without confirmation: Dismiss (Desk), Revoke/Deactivate (Admin), Remove repo, Release (card), Re-home; `window.confirm` for schedule delete | `Desk.tsx`, `Admin.tsx`, `CardDetail.tsx`, `Schedules.tsx:144` | `ConfirmDialog` or undo toast |
| `PageHeader` truncates the `h1` (`truncate`) so long card titles are cut off with no way to read them | `ui.tsx` | Wrap, balance |
| Page widths are ad hoc (`max-w-3xl/4xl/5xl/6xl`) so the content edge jumps between pages | every page | 4 width tokens |
| Fixed-height hacks `h-[calc(100dvh-6rem)]` tied to the old top bar | `Chat.tsx:13`, `Intake.tsx:98` | Flex fill in `main` |
| Controls are 32 px high (`min-h-8`, `py-1.5` inputs); below the 44 px touch guideline | `Button`, `inputCls` | 40 px default, 44 on coarse pointers |
| Tiny text: badges 11 px, captions `text-xs text-zinc-500` ~170 times, 4.3:1 on `zinc-100` | everywhere | 12 px minimum, `text-subtle` token |
| Hand-rolled controls: native selects used as project switcher and department filter; custom tabs without keyboard support (`OrgDesigner.tsx:125`) | several | `Tabs`, `Select` skin, project switcher in the shell |
| No per-page document title; `index.html` says "Agent Org Manager" | all | `usePageTitle` |
| Avatar white-on-hsl(…55% 38%) can fall to 3.1:1 | `Avatar` | `hsl(h 50% 30%)` |
| Jargon in user-facing text: "Specify", "Re-home", "Workability", "ReviewRequested" style event names in timeline, `waitingFor` codes | Card, HR | Plain-language labels (below) |
| No visible focus-order / skip link; no live region for async results | shell | see layout doc |

---

## 2. Login (`/login`) , P1

Current: bare form, no brand (`current/login-d.png`). Redesign: split brand panel + form, reveal toggle, caps lock hint, better error placement and copy, rate-limit and network states. Full spec in `login.md`.

## 3. Accept invitation (`/invite/:token`) , P1

Current: same bare layout; invalid link is an unstyled paragraph; no password strength; "Create account" fine. Redesign: shared `AuthFrame`, strength meter, read-only email field for password managers, proper invalid-link card, skeleton while checking. See `login.md` section 6.

## 4. Home redirect (`/`) , P1

Problem: `Home` shows the "Loading..." text and, when the user has no projects, silently drops them on `/projects`. Redesign: show the shell skeleton while loading; with zero projects go to a first-run state on `/projects` ("Create your first project" EmptyState with a 3-step checklist: Pair a workstation, Create a project, Hire an agent; each step links to its page and ticks when done using `useWorkstations`, `useProjects`, `useAgents`).

## 5. Board (`/p/:projectKey/board`) , P1

Files: `pages/Board.tsx`, `components/BoardView.tsx`.

Problems:
1. Header crams up to six controls into one row: department select, project select (showing only the key, with an `sr-only` label), "Run regression", "Feed", "Run now", "New card". On mobile they wrap into three rows above the board (see wrapping behaviour in `current/` mobile shots).
2. Project switching is a bare `<select>` of keys ("WEB"); the human name appears only in the title.
3. 10 to 11 fixed 256 px columns scroll horizontally on every device; on a phone the user sees one column edge and has no idea what is off screen. Columns have no colour, no icons, no collapse; empty columns take full width and 100 % height as blank grey slabs (`board-hero.png`).
4. Tiles: "Unassigned" is printed on every unassigned tile (noise); risk shown as raw word "small"; no priority; badges at 11 px; age is a bare "now/7m"; hover is only a border colour; no density control.
5. No search or filter on the board (assignee, blocked only, my cards, type, text).
6. Not-found project state is a single paragraph.
7. Live updates have no cue: cards jump columns without animation.
8. Loading is "Loading board..." text; errors are a red box with no retry.
9. The scroll container is focusable (good) but has no visible indication or keyboard instructions.

Redesign:
- **Header**: `h1` project name, subtitle `WEB · Code · 11 open · 2 blocked` (counts from the board data), actions: search field (client-side filter on ref/title/assignee), "Filter" chip row (`Mine`, `Blocked`, `Rework`, `Unassigned`; `aria-pressed`), primary "New card" link (keeps name), secondary overflow menu ("Run regression" opens the existing `RegressionDialog`, "Open feed", "Run now" for feed projects, "Project settings"). Project and department switching move to the sidebar switcher (department grouping in the popover). Keep the `RegressionDialog` trigger accessible name.
- **Columns**: header = stage dot (stage colour) + glyph + name + count pill; 3 px top rail in stage colour; column body `bg-sunken` radius 12; width 272 px (flex-grow to fill on >= 1440 px, min 272). Empty columns show a quiet "No cards" caption with a dashed outline, and columns with 0 cards that are not the first or last collapse to a 56 px vertical strip (rotated label + count) via a "Hide empty columns" toggle (default on, remembered in localStorage). Done column shows only the last 10 with "Show all" link (check API first; if the API returns all, clamp in the UI).
- **Tiles**: as in `design-system.md` 4.4: ref + age, 2-line title, assignee avatar + first name, exceptional badges only. Left rail colours for blocked/waiting; stale indicator (age text turns `warning` after 3 days in a stage; threshold constant, P3). Whole tile is the link; `aria-label` stays `"{ref} {title}"`, `data-testid="card-tile-{ref}"` stays.
- **Mobile (< 768)**: replace the sideways scroll with a **column tab strip** on top (scrollable chips: `Spec 2`, `To do 2`, `In progress 2` ... with stage dots, sticky under the top bar) and show the selected column's tiles full width; swipe left/right changes column (optional, P3). Default selected = the first non-empty column among "Blocked, Review" else "In progress". Each tile is a 72 px tall row. Keep `data-testid="board"` on the container and `column-{name}` on every column (render all columns in the DOM but hide non-selected ones with `hidden`/`inert`? Prefer: render all, mark non-selected `hidden` only below `md` so desktop tests are unaffected; unit tests render at jsdom width where `md:` styles do not apply, so all columns remain present).
- **Desktop**: horizontal scroll with fade masks and `scroll-snap-type: x proximity`; shift+wheel works; keyboard: the board container keeps `tabIndex=0`; add `aria-describedby` hint "Scroll sideways to see more columns".
- **Live updates**: a card that changes column gets a 1.2 s `bg-brand-soft` flash and an `aria-live="polite"` summary ("WEB-12 moved to Review") in a visually hidden region.
- **States**: skeleton = 5 columns x 3 tiles. Error = EmptyState (error tone) with "Try again". Project not found = EmptyState "That project does not exist or you do not have access" + "Browse projects". Board with zero cards in a new project = center EmptyState "No cards yet. Create the first one" (primary New card) and an inline link to Intake.
- Waiting-on link below a tile ("waiting on WEB-12") stays but is contained inside the tile's footer, not floating outside it (it currently sits below the card in the `li`).

## 6. Desk (`/desk`) , P1

Files: `pages/Desk.tsx`, `DeskItem` (exported, used by tests), `AnswerForm`, `ResolveButtons`.

Problems:
1. Header buttons "Add to ledger", "Intake", "Chat" are three unrelated utilities of equal weight; "Chat" is primary-coloured while the page's job is answering items.
2. All items are the same white card regardless of urgency; urgency is only a small red badge and a pink ring. Blocking, question, approval and notices interleave with no grouping or filtering. With 12+ items (`desk.png`) the page is a long scroll with no way to jump.
3. Every item prints 5 badges/meta fragments in a row (Urgent, kind, Blocking/Non-blocking, "Affects N cards", "asked 7m ago") at 12 px grey; the question (the thing to read first) comes after avatar, ref link, "Was doing" line.
4. The answer area: options as bordered radios (good), then a "Note" textarea whose label is a sentence in parentheses, then an "Add to ledger as" select that is always visible and makes every answer a three-part form, then "Answer" and "Dismiss" side by side with equal weight; "Dismiss" acts immediately with no confirmation.
5. "Escalation trail" is a long grey sentence with arrows; "The ledger already has similar entries" hint is dense amber text.
6. Closed items hidden in a `<details>`; no time filter.
7. Empty state "Nothing is waiting on you." in a box; no positive feedback or next step.
8. On mobile there is no way to reach the answer button without scrolling past options; no sticky action.

Redesign:
- **Header**: title "Decision desk", subtitle `3 open · 1 blocking`; actions: primary none; secondary "Add to ledger" (opens a dialog instead of the inline panel on mobile), "Intake" (`data-testid="intake-button"` stays), "Chat" (opens drawer; keep the name "Chat"). Equal weight, `secondary` variant.
- **Filter bar** (sticky below the top bar): filter chips `All 12 · Blocking 4 · Questions 5 · Approvals 2 · Notices 1` (with counts, `aria-pressed`), sort select "Priority (default) / Oldest / Newest". Persist in the URL (`?filter=`).
- **Grouping**: sections "Needs you first" (urgent/pinned), "Blocking work" (blocking), "Decisions" (rest), "Heads-up" (notices), each an `h2` with count; all inside the same `ol[data-testid="desk-list"]`-equivalent so tests that count items still find them (keep one `ol` per section only if tests allow; `desk.test.tsx` queries `desk-item-{id}` by id, safe).
- **Item card**: 3 px left rail (danger = urgent, warning = blocking, line = other), header row with kind icon + kind label (Question / Approval / Escalation / Notice), blocking badge only if blocking (drop "Non-blocking"), "Affects N cards" as a link-like chip, age on the right (`title` keeps the full timestamp). Next row: asker (avatar + name + role) and card chip (`WEB-21 Let guests check out`). Then the **question as `h2` text-lg**, body, "Was doing" as a collapsible "Context" disclosure (default open on first item only). Dedup hint becomes a collapsed "Similar ledger entries (2)" disclosure. Escalation trail becomes a vertical mini-timeline in a disclosure "How this got here (3 steps)".
- **Answer area**: choice cards for options; the free-text answer is a textarea labelled "Your answer" (when there are options: "Add a note (optional)"); "Add to ledger as" moves into a compact row "Record as: Decision v" (a `Select` styled as an inline control, default Decision) so the main form is options + note + Answer. Buttons: primary "Answer" (full width on mobile, sticky at the bottom of the card on mobile via `sticky bottom-3`), `ghost` "Dismiss" which opens an inline confirm popover ("Dismiss without answering? The asker will be told you declined.") with "Dismiss" and "Keep". Button names `Answer`, `Dismiss`, `Approve`, `Reject`, `Approve merge`, `Retry`, `Acknowledge` stay as-is.
- **Approvals and acknowledgements** (`ResolveButtons`): primary approve, secondary reject, with a one-line consequence under the buttons for the dangerous ones ("Merges into main. Cannot be undone from here.").
- **Closed items**: a "Closed (7)" tab/chips toggle instead of `<details>`; row layout `title · status · by whom · when`.
- **Empty**: EmptyState (success tone, check icon) "All clear. Nothing is waiting on you." Description: "Questions, approvals and heads-ups from your agents show up here." Secondary action "Go to the board". Keep `data-testid="desk-empty"`.
- **Deep links** `#desk-item-<id>`: scroll into view and flash a 2 s ring on the item (not only scroll).
- **Mobile**: filter chips scroll horizontally; item cards full bleed with 12 px padding; the Answer button sticky; tap targets 44 px.

## 7. Card detail (`/cards/:ref`) , P1

Files: `pages/CardDetail.tsx` (594 lines), `ThreadPanel`, `CardEdit`, `MoveDialog`, `CancelDialog`, `RiskTierDialog`, `TestingLinks`, panels.

Problems:
1. Title area: `PageHeader title={`${card.ref} ${card.title}`}` is truncated; the sub row mixes status badge, column text, type, rework badge, workability, assignee in one line of 12 px fragments.
2. Up to seven buttons in the header row: Specify, Edit, Move, Release, Re-home, Cancel card (danger) — all equal-size, the destructive one sits beside the primary. "Re-home" and "Release" are unexplained jargon (`title` tooltip only).
3. "Details" panel mixes system metadata (stage, risk tier, completion action, docs needed, branch, priority, decision policy select) with the card's actual spec fields (Context, Requirements, Acceptance criteria…) in one list; the most important content (what to build) is below six meta rows.
4. Timeline lists raw event names and `from → to (status)` pairs, e.g. `spec → build (queued) / CardSpecified`, 16 entries for one card (`card-detail.png`); the useful summary (where is it now, what is next, who has it) is missing.
5. Handoffs, Evidence, Finalize, Outbound history, Publication, Thread: up to eight stacked panels in a 2/3 column; the thread (conversation) is at the bottom of the right column, below the timeline.
6. The decision-policy `<select>` is inline in the details with no label beyond a tiny `dt` and acts on change immediately without feedback.
7. Blocker banner is good content but is a dense red paragraph.
8. On mobile everything is one long scroll with no anchors.

Redesign:
- **Header**: breadcrumb (Project > Board > ref). Row 1: mono ref chip + status pill (plain words: Draft, Queued, In progress, Blocked, Waiting, Done, Cancelled) + type badge. Row 2: full title as `h1` (wraps). Row 3: **stage stepper** built from the workflow stages (`workflow.stages`): dots joined by a line, completed filled with the stage colour, current ringed + label, upcoming outline; scrolls horizontally on mobile; shows rework loops as a small return arrow with "Rework 1" badge. Row 4: assignee (avatar + name, or "Not claimed yet"), risk badge (only if not small), workability warning, priority chip (only if not default), age ("in Review for 2 h").
- **Actions**: one primary contextual button (Specify for drafts, otherwise none), `Edit` secondary, and a "More" menu (Radix DropdownMenu) holding Move, Release, Re-home, Change risk tier, Cancel card (red, separated). Button names remain findable: menu items are `menuitem`s, so tests that click `Move`/`Release`/`Cancel card` buttons must either open the menu first (update those tests) or keep `Move` and `Edit` as visible buttons. Recommendation: keep `Specify`, `Edit`, `Move` visible on desktop (as buttons) and put `Release`, `Re-home`, `Cancel card` in "More"; on mobile all but the primary go in "More". Add visible explanations in the menu ("Release: let another agent claim it").
- **Layout (>= 1024)**: main column (2/3): "What to build" panel (the spec fields from `keys`, rendered as readable sections with headings; acceptance criteria as a checklist-style list), then tabs: **Activity** (thread + timeline merged chronologically, filterable: All / Conversation / History), **Handoffs**, **Evidence** (test evidence + finalize + publication + outbound as sections). Side rail (1/3, sticky): "Details" key-value (stage, branch with copy button, completion action, docs needed, priority, risk tier with Change link, decision policy), "Live shift" panel on top when a shift is running (pulsing lime dot).
- **Layout (< 1024)**: header, then tabs (`Overview | Activity | Handoffs | Evidence`) with sticky tab bar; details collapsed in a disclosure under Overview.
- **Timeline copy**: map event reasons to sentences: "Specified", "Claimed by Grace", "Sent to Review", "Changes requested by Linus", "Approved", "Tests passed", "Merged". Keep raw `reason` in a `title`. `data-testid` for `timeline`, `timeline-activity` stay.
- **Decision policy**: becomes a labelled `Select` ("Who answers this card's questions") in the side rail with a toast on change.
- **Blockers**: banner with icon, "Waiting for your answer", each blocker as a button-like link to the desk item; tone `warning` for waiting-on-you, `danger` only for failures.
- **States**: skeleton (header + two panels); ambiguous-ref error keeps the candidates list as a proper list of cards; 404 = EmptyState "Card not found".
- Confirm dialogs: Cancel card stays a dialog (add consequence text and "Keep card" cancel); Release and Re-home get a `ConfirmDialog` (they discard work); Move keeps its dialog.

## 8. New card (`/cards/new`) , P1

Files: `pages/CardNew.tsx`, `CardFormFields.tsx`, `lib/cardForm.ts`.

Problems:
1. Primary button "Specify" is jargon; the secondary "Save draft" is clearer than the primary. A first-time user cannot tell what Specify does (moves the card into the pipeline once required fields are present).
2. All fields in one long form with no grouping; "Priority (1-9)" has no explanation of which end is urgent; "Completion action" and "Docs needed" are technical and appear before the description for code cards.
3. Project and card type selects share a row at the top but changing Project remounts the form (`key={project.id}`) and drops what was typed.
4. Validation summary "Fix the highlighted fields." appears at the bottom only; the form focuses the first invalid field (good) but on mobile the error line may be off screen.
5. Action buttons are at the end of a long form; no sticky bar; no unsaved-changes guard; "Cancel" is a text link.
6. The page has no guidance about what makes a good spec (acceptance criteria, test plan).

Redesign:
- Narrow width, grouped sections with headings: **Basics** (Project, Card type, Title), **What to build** (Context/Requirements/Constraints textareas with hints and an example placeholder), **How we know it is done** (Acceptance criteria list input, Test plan), **Delivery** (Repository, Completion action with plain explanations beneath each option, Docs needed switch), **Planning** (Priority as a segmented control Low / Normal / High / Urgent mapped to the numeric scale once the direction is confirmed with the owner; Risk shown read-only "set automatically").
- Primary button text: **"Create and specify"** hmm: the tests click `Specify` and `Save draft` by exact name. Keep accessible names `Specify` and `Save draft`; add a one-line description under the buttons (`aria-describedby`): "Specify sends the card to the Spec stage and checks every required field. Save draft keeps it private until you are ready." Visually label primary as "Specify" with a help popover; do not rename.
- Sticky action bar at the bottom (mobile and desktop), with "Cancel" as `ghost` button-link.
- Preserve typed values when switching project/type (lift state above the `key`).
- Required-field progress: a small "3 of 5 required fields filled" meter in the sticky bar.
- Unsaved-changes prompt on navigation (`useBlocker`).
- Success: navigate to the card and toast "Saved as draft WEB-45" / "WEB-45 specified".

## 9. Agents / HR board (`/agents`, `/hr`) , P2

Files: `pages/Agents.tsx` (683 lines), `components/hr/*`, `HireDialog`, `FireDialog`, `RehomeDialog`, `ChangeModelDialog`, `ChangeRoleDialog`.

Problems:
1. Nav says "HR", page title says "HR board", route is `/agents`: three names for one page.
2. Each agent card (`hr-m.png`) shows 6 stats with team comparison bars, a work-quality block of 6 more numbers for builders, model line, "Hired by", current card, and three equal ghost buttons (Change model, Change role, Fire). On mobile one agent fills more than a screen.
3. "Fire" is a plain ghost button identical to its neighbours; it does open a dialog (good) but nothing signals danger.
4. Stats show "-" for no data without explanation; `team -` text repeated.
5. Filters (project, department) are full-width selects stacked on mobile; "Metrics" link is an underlined word beside the primary "Hire agent".
6. `RoleUpdates` and `RecommendationList` appear above the roster as full panels; with several recommendations they push the agents off screen.
7. Retired agents hide in a `<details>` as plain text.
8. Status "on shift / idle / blocked / needs rehome" is a tiny badge; no at-a-glance roster view.

Redesign:
- Title "Agents", subtitle "Performance over the last 30 days, each against the role average." Actions: primary "Hire agent", secondary "Metrics" (button-link). Filters as compact selects in a toolbar row (collapse into a "Filters" popover on mobile).
- **Recommendations** become a collapsible banner "3 suggestions" (badge + chevron) above the roster, expanded on first visit; each recommendation a row with evidence and one-click Apply (existing component, restyled).
- **Roster**: grid of compact cards (avatar with status ring, name, role · seniority, status badge, current card link, model line in mono), 3 columns >= 1280, 2 >= 768, 1 on mobile. Stats are behind a "Stats" disclosure inside the card or a right-hand drawer ("Open details") so the grid scans quickly; default view shows 3 headline numbers (Cards done, Rework rate, Utilisation) as mini bars.
- **Actions**: kebab menu on each card (Change model, Change role, Re-home when needed, Reset for DevOps, Fire in red at the bottom). Keep the accessible names `Change model of {name}`, `Change role of {name}`, `Fire {name}`, `Re-home {name}` on the menu items; unit tests (`hr.test.tsx`) click them as buttons today, so either keep them as visible ghost buttons in a "Manage" row revealed by the disclosure, or update the tests (preferred: update to `menuitem`).
- **Fire dialog** becomes `ConfirmDialog` with consequences listed (sandbox reset, claimed cards released, record kept) and a danger button "Fire {name}".
- **Empty**: "No agents yet. Hire a builder and a reviewer to start moving cards." + primary "Hire agent". If no workstation: first show "Pair a workstation first" with link.
- **Retired**: "Retired (2)" collapsible list with role and date, muted.
- Sandbox warnings keep their persistent amber banner style (cannot be dismissed per spec) but at the top of the card, not mid-card.

## 10. Projects (`/projects`) , P2

Problems:
1. Each project is a wide bordered row with name and four same-looking grey badges (`code`, `work`, `owner`, department) and underlined "Board"/"Settings" links; no signals of activity.
2. "Workflow" select in the New project dialog lists raw keys (`code`, `research`, `feed`) without describing them.
3. Department select shown only when departments exist, in the middle of the page.
4. Invitations (`ProjectInvitations`) appear above the list without emphasis.
5. No empty-state action other than the header button.

Redesign:
- Card grid (1/2/3 columns): key chip (mono, tinted), name, type with icon (Code, Research, Feed), domain badge, role badge ("Shared with you" for non-owner), 3 numbers (open cards, blocked, desk items) if available from existing queries (`useBoard` per project is too heavy; add to P3 an API field; for now show only type/domain/role), primary click opens the board; "Settings" as an icon button with `aria-label="Settings for {key}"` (kept; e2e depends on it) .
- Pending invitations as a top banner card with Accept / Decline.
- New project dialog: workflow picker as three **choice cards** (Code: "Build features with agents. Spec to Finalize, uses repositories", Research: "Answer questions with cited sources", Feed: "Scheduled scans and digests"), keys derived from `workflows.data`; key field auto-suggests from the name (user can edit).
- Empty: "No projects yet" + "Create your first project" and the 3-step checklist.

## 11. Project settings (`/projects/:id/settings`) , P2

Problems: one long column of unrelated panels (General, Repositories, Merge policy, Members); success feedback is an emerald paragraph (fails contrast); repository removal and member removal are immediate buttons; no way to jump; the "Back to board" link is an underlined text.

Redesign: breadcrumb back, `Tabs` (General, Repositories, Merge policy, Members, Vaults link) synced to `?tab=`; save bar sticky within the panel ("Save settings" appears enabled only when dirty, plus "Discard"); toast on save; `ConfirmDialog` for remove repository/member with consequences ("Their agents are re-homed to you"); show owner-only restrictions via a `Read only` banner instead of silently missing controls. Dangerous section "Danger zone" for archive/delete if those exist (they do not today; none added).

## 12. Workstations (`/workstations`) , P2

Problems: each workstation is a big panel; warnings stack as multiple amber blocks (sandbox warnings per runtime); the connection status is a dot + word at the top right with an adjacent "Unlink" button; runtimes shown as green badges; repos listed as raw paths; "Shifts running" as a label/value in a 2-column grid; DevOps engineer panel nested inside. "Pair workstation" dialog is good but the pair command is unstyled text.

Redesign: list rows (table on desktop) with status dot ("Online"/"Offline since 3 h ago"), name, platform chip, runner version, shifts `2 of 4` meter, sandbox state as a single badge ("Sandboxed" success / "No sandbox" warning), kebab (Unlink in red). Expand row (disclosure) for runtimes, repos, DevOps panel. The sandbox explanation keeps its full text but appears once in the expanded area, and the warning badge in the row cannot be dismissed. Pair dialog: step list (1 Generate code, 2 Run the command, 3 Wait for connection with live "Waiting for the runner..." status), the code in a large mono box with "Copy command" button that confirms with a toast, expiry countdown. Unlink uses `ConfirmDialog` (already dialog; restyle). Empty: "No workstations paired" with the 3-line install summary and a primary "Pair workstation".

## 13. Ledger (`/ledger`) , P2

Problems: three labelled filter fields in a row (Search, Scope, Project) take much space; the scope is a select though there are only four values; entries are full-text panels with no clamp (long standing orders push the page); the "Add to the ledger" form is in a side column that on mobile appears **after** the entire list; empty text differs by case but without action.

Redesign: toolbar with search field + scope **chips** (All, Standing orders, Decisions, Requirements) + project select; entry rows: scope badge, title, 3-line clamped body with "Show more", metadata footer (project, card link, who, when). "Add entry" is a primary button opening a dialog (the form is reused) on all sizes; desktop keeps no side column. Empty (first use): "The ledger is empty. Answers you give on the desk are recorded here so agents do not ask twice." with a button "Add an entry". Filtered empty: "No entries match "{q}"" with "Clear filters". Keep `data-testid` `ledger-list`, `ledger-entry`, `ledger-empty`.

## 14. Intake (`/intake`, `/intake/:id`) , P2

Problems: `IntakeNew` is a single textarea inside a panel with a back link to the desk; earlier intakes list is a plain list; `IntakeView` uses a hard-coded `h-[calc(100dvh-6rem)]`, the sub row packs connection dot, BA name, status badge and two links in one line; the "cards created" aside is 16 rem fixed and stacks below the chat on mobile; status note is amber text.

Redesign: `IntakeNew` = narrow centred form with a clear heading "Bring work in from Jira or GitHub", helper text with examples (the `placeholder`), detected-source chip (existing `source.label`), recent intakes as a list with status badges and relative times. `IntakeView` = chat full height (flex), header with BA identity (avatar, "Business analyst Olga", online dot), status badge, two ghost links ("All intakes", "Back to the desk"); cards-created panel as a right rail on >= 1024 and as a collapsible "Cards created (2)" bar above the composer on mobile. Mapping-needed banner becomes a `warning` banner with a button "Pick the project" (keep the link name `Pick the project`).

## 15. Chat page (`/chat/:threadId`) and ChatDrawer / ChatPanel , P2

Problems: `Chat.tsx` uses `h-[calc(100dvh-6rem)]`; bubbles: user = indigo-600 (white on indigo 6.3, fine), agent = zinc-100; no avatars on agent bubbles in the page (only a name line); streaming "…" has no typing indicator; composer is a textarea + Send with no Enter-to-send hint; the offline notice is an amber paragraph; the drawer is a right panel `sm:w-[28rem]` with a close button but no title context while in a thread.

Redesign: header with avatar, agent name, role, online/offline `StatusDot`, "Back to the desk"; messages with grouped bubbles (agent left on `sunken`, you right on `brand` with `brand-fg`), timestamps on hover/focus, typing indicator (3 dots, reduced-motion safe); composer sticky at the bottom with safe-area padding, Enter sends, Shift+Enter newline, hint text, Send button (name `Send`, label `Message` stays). Offline banner "Linus's workstation is offline; messages are sent when it reconnects" (use the real behaviour per `ChatPanel`). Drawer: same panel, header shows the agent; list view of conversations with avatars and last message preview.

## 16. Vaults (`/settings/vaults`) , P2

Problems: the page is under "Settings" in the URL but the nav has no Settings group; each vault card shows an always-editable form (Git URL, interval, Save) followed by a list of workstation sync lines with inline badges and long conflict text; "Register a vault" form sits at the bottom, always expanded; terms "Sync paused: conflict" with a button "I resolved it, resume" are good but visually weak.

Redesign: vault cards read-only first: name, kind badge, truncated URL (mono, copy), sync summary "Synced on 2 of 2 workstations", "Edit" ghost button opening the form in a dialog; per-workstation rows as a table with `StatusDot` (Synced / Waiting / Error / Paused) and relative times; conflict state is a `danger-soft` banner in the card with the conflicting files as a code list and the resume button (name kept: `Resume sync on {ws}`). "Register vault" is a primary button in the header opening a dialog. Empty: "No vault yet. A vault is a git repository of markdown notes your agents read. Decisions and standing orders are written to it." + "Register a vault".

## 17. Organization designer (`/org`) , P2

Files: `OrgDesigner.tsx` (781), `components/org/*` (WorkflowEditor 520 lines, RoleEditor, WorkflowGraph, ListInput).

Problems:
1. Hand-rolled tabs (Roles, Workflows, Departments, Design) with `role="tab"` but no arrow-key support or `aria-controls`; on mobile the tab row wraps.
2. Roles tab lists custom roles then built-in roles as bordered cards with several buttons each (`Extend`, `New version`, `Discard`, `Submit` …) and status badges.
3. Version/status vocabulary (active, pending_approval, superseded) is shown in several places; the "waiting for your approval" state links to the desk only in prose.
4. The editors are inline panels replacing the list (no breadcrumbs back); the workflow editor is a very dense form (stages table, outcomes, graph).
5. The shared-org selector sits above the tabs as a full-width select; the read-only note is a blue box.

Redesign: `Tabs` component; roles/workflows rendered as a table-card list with columns Name, Version, Status (badge), Used by, Actions (kebab); editors open full-width with a sticky header ("Editing: Support v2 [Save draft] [Submit for approval]") and a clear back link; workflow editor split: left stage list (drag handles optional, P3), right stage detail form, bottom/side live graph preview; validation errors summarised in a panel with jump links. Status badge colours: Active (success), Waiting for your approval (warning, with "Review on the desk" button), Draft (info), Replaced (neutral). Keep all button names tested in `org-designer.test.tsx` (`New custom role`, `Extend builder`, `Save extensions`, `Create department`, `Add stage`, `Add outcome to work`, `View support v1`, `New version of support v2`).

## 18. Schedules (`/schedules`) , P3

Problems: schedule panels show a 2-column `dl` of When/Next run/Topic/Max items/Description plus three buttons side by side (Run now primary, Pause/Resume, Delete in solid red) — `window.confirm` for delete; "New feed schedule" form (project, name, preset, cron, timezone, topic, sites, description, max items) is always expanded below the list; custom cron entry is raw.

Redesign: list of schedule cards (name, project key, human cadence "Every weekday at 07:00 (Europe/Stockholm)", next run relative "in 3 h", last result badge, Active/Paused switch), actions: primary-ghost "Run now", kebab (Pause, Edit, Delete). Delete uses `ConfirmDialog`. "New schedule" is a primary header button opening a two-step dialog (What to scan: project, name, topic, sites, description, max items; When: preset chips + custom cron with live preview "Next 3 runs: ..."). Empty state keeps the message and adds "Create a feed project" button when none exists. Keep `data-testid` values (`schedules`, `schedules-empty`, `schedule-when`, `schedule-next`, ...).

## 19. Feed project (`/p/:projectKey/feed`) , P3

Problems: four stacked panels (Schedules, Running list, taste.md) with the header buttons "Board"/"Run now"; the running list shows digests oldest first (spec) but long; `taste.md` shown as a raw `<pre>`; run result is a loose paragraph.

Redesign: `Tabs` Digests / Schedules / Taste; digest items as rows with rating buttons (existing `DigestRating`, keep names `Useful`, etc.), source link, date; taste rules as a list with "From N ratings"; "Run now" primary; toast "Emitted WEB-45" with a "View card" action instead of a paragraph (keep `data-testid="run-result"` text for tests: render it in the page as well as the toast).

## 20. Metrics (`/metrics`) , P3

Problems: six panels, one table (bounce rate); stat blocks are plain label/value; charts (`components/hr/Charts.tsx`) are hand-made `BarChart`/`HBars` with fixed colours; filters are two selects (Project, Range) with fixed widths `w-56` / `w-40`; no comparison to previous period; no skeleton.

Redesign: top row of 4 `Stat` tiles (Cards finalized, Time blocked on you, Avg per card, Bugs escaped) with delta vs previous period when the API provides it (otherwise omit; do not fake). Range as chips (7 / 14 / 30 / 90 days). Charts use the stage/semantic palette tokens, axis text `text-subtle` 12 px, each with a text summary and a "View as table" toggle for accessibility. Tables become responsive lists on mobile. Keep `data-testid`s (`metrics`, `metric-throughput-total`, `metric-blocked`, `metric-bounce`, `bounce-{name}`, `metric-bugs-total`, `metric-duration`, `metric-queue`).

## 21. Admin (`/admin`) , P3

Problems: four panels stacked: Invite user form, Invitations list, Users list, All workstations (reusing `WorkstationCard`). Users: each row has a role `<select>` and a Deactivate button with `aria-label`; no confirmation on Deactivate (which disconnects runners and parks agents!) or Revoke; "Resend" and "Revoke" are ghost buttons; status badges inline.

Redesign: `Tabs` Users / Invitations / Workstations; "Invite user" as a primary button opening a dialog; Users as a table (Name + email, Role select, Status, Last login, kebab: Deactivate / Reactivate); Deactivate and Revoke via `ConfirmDialog` with consequences from the user guide ("Unlinks all of their workstations... parks their agents"). Invitations table with status badge and expiry relative time. Keep names `Send invitation`, `Resend invitation to {email}`, `Revoke invitation to {email}`, `Deactivate {email}`, `Role for {email}`.

## 22. Phases (not built yet; design reference `docs/design/phases.md`) , P2 when shipped

Placement: sidebar Work group "Phases" (`/p/:key/phases`), and on the Board header a "Phase" filter chip. Page: list of phases as cards with a progress bar (cards done / total), status (Proposed, Open, Done), member cards chips; the BA's `phase_proposal` arrives as a desk approval (existing desk item pattern, kind `approval`): render with a summary table of the proposed assignments and the standard Approve / Reject. Follow-ups list as a vertical stepper (ordered, status per follow-up). Reuse `StageStepper`, `Badge`, `Panel`, `EmptyState` ("No phases yet. Ask the BA to propose phases in an intake chat."). No design beyond reuse is required before the feature exists.

## 23. Shared components worth restyling once

| Component | Problem | Change |
| --- | --- | --- |
| `Badge` | 11 px, six tones using raw Tailwind colours | Token tones, 12 px |
| `Dialog` | No close button, no footer slot, centred on mobile | Header with close, sheet on mobile |
| `SandboxWarning`, `WorkabilityWarning` | Amber boxes duplicated per agent/workstation | One `Callout` component (`info|warning|danger|success`) with icon |
| `Transcript` | `max-h-96` pre, no copy/search | Mono block with copy button, line wrap toggle |
| `DigestRating` | Not reviewed in detail; ensure 44 px targets and `aria-pressed` | Restyle |
| `ConnectionDot` | Text 12 px | `StatusDot` |
| `Avatar` | contrast, no status ring | see design system |
| `Spinner` | Plain text | Skeletons + inline spinner |
