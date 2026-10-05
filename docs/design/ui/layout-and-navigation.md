# App shell and navigation

Replaces `components/Layout.tsx` (`RequireAuth` + `Shell`). Routes and URLs do **not** change (`router.tsx` stays as is, plus new routes later for Phases).

## 1. What is wrong today

(from `Layout.tsx` and the screenshots in `current/`)

- 13 flat items in one horizontally scrolling top bar (Board, Desk, Ledger, New card, HR, Organization, Metrics, Workstations, Projects, Schedules, Vaults, Admin). At 1440 px they just fit; at 390 px the user sees about four of them, the avatar and "Sign out" overlap the strip, and there is no hint that the strip scrolls (`current/hr-m.png`, `desk-m.png`).
- "New card" is an action disguised as a destination; "HR" opens a page titled "HR board" at `/agents`; "Organization" is really Roles and workflows; "Vaults" lives at `/settings/vaults` but there is no Settings group.
- No notion of "current project": the Board page has its own tiny `<select>` showing only the key, `lastProject` is invisible state that silently decides where "Board" and "New card" go.
- The desk count is a red pill inside a nav tab; on mobile it is off screen unless scrolled to. The Live/Offline indicator is hidden below `sm`.
- No landmark structure beyond `nav aria-label="Main"`; no skip link; no per-page `<title>`; "Sign out" is a plain text button next to the avatar with no account info.

## 2. Information architecture

```
[logo]  Guildwise                                  [collapse]
[ project switcher:  WEB  Web shop         v ]
[ + New card ]

WORK
  Board                      /p/:key/board     (current project)
  Desk                  (3)  /desk             badge: open count; red if any blocking
  Feed                       /p/:key/feed      only when current project's workflow is feed
  Intake                     /intake
  Schedules                  /schedules
  Phases   (soon)            hidden until the feature ships; then /p/:key/phases
  Projects                   /projects

ORGANIZATION
  Agents                     /agents           (also /hr; page title "Agents")
  Roles & workflows          /org
  Workstations               /workstations
  Metrics                    /metrics

KNOWLEDGE
  Ledger                     /ledger
  Vaults                     /settings/vaults

(bottom, pinned)
  Admin                      /admin            admin only; "Settings" group label
  [avatar] Pieter Jordaan  [Sign out]  [theme / more v]
  Live  (dot)
```

Decisions:

1. **Group labels** (Work, Organization, Knowledge) are real headings (`<h2 class="sr-only">` plus visible text) inside one `<nav aria-label="Main">`. The `aria-label="Main"` and the `link` accessible names (Board, Desk, Ledger, Agents, Workstations, Projects, Schedules, Vaults, Admin) are what e2e tests use; keep them.
2. **"HR" becomes "Agents"**, because the page is the roster (hire/fire/model/role + stats). The subtitle keeps "HR board" language ("Performance over the last 30 days"). `/hr` stays as an alias route. Test strings: `unit` tests render `Agents` directly, so only e2e clicks on the nav label matter (none found for "HR"; verify with `grep "name: 'HR'"` before changing).
3. **"Organization" becomes "Roles & workflows"** in the nav; the page title is "Organization" (it designs the org: roles, workflows, departments, BA design chat), tabs unchanged. The route stays `/org`.
4. **New card** is a primary button at the top of the sidebar (and a "+" icon button in the mobile top bar), not a nav item. It links to `/cards/new?project=<current key>` and keeps the accessible name "New card".
5. **Intake** is promoted from a hidden button on the Desk header to a Work item: it is a primary way to create work from Jira/GitHub. The Desk header keeps a secondary "Intake" button (test id `intake-button` stays).
6. **Chat** (agent conversations) is not a page; it is the `ChatDrawer`. Lift the drawer state to the shell so it opens from anywhere: a chat icon button in the top bar (desktop right side, label "Chat") opens it. The Desk header "Chat" button remains (tests click it).
7. **Metrics** moves under Organization (it measures the team) and is cross-linked from the Agents page header as today.
8. **Phases** (coming): reserve the slot under Work; hidden behind a feature flag from `/api/auth/me` `features` (the same place `mockUi` comes from). Do not render a disabled "coming soon" link.
9. **Sub-navigation stays in pages**, not the sidebar: Organization tabs, Project settings sections, Admin sections. The sidebar is one level deep.
10. Active item: `aria-current="page"`, `bg-side-active text-side-strong` and a 3 px lime bar at the left edge. For "Board" the active test is `pathname.startsWith('/p/')` (board and feed), and for card pages (`/cards/*`) the **Board** item stays highlighted (cards belong to a project board) unless the card was reached from the desk (`state.from`), which is a P3 nicety.

### Avoid accessible-name collisions

Playwright's `getByRole('link', { name: 'Projects' })` is a case-insensitive substring match and is **strict**: two matching links in the DOM fail the test. The existing e2e specs click links named `Workstations`, `Projects`, `Admin`, `Settings for TOY`, `Pick the project`. Therefore:

- The project switcher footer link must not contain these words: use "See all" (route `/projects`), not "All projects".
- Breadcrumb parents that duplicate a nav label (for example "Projects" on project settings) are allowed only if the test never clicks that label while on such a page; the builder must run the e2e suite and, where a clash appears, scope the locator to `getByRole('navigation', { name: 'Main' })` (a test-only change).
- The Desk count badge keeps `data-testid="desk-badge"` and exists **once** in the DOM at any time (see responsive rule below). Likewise `live-indicator`.

## 3. Shell anatomy

```
<div class="app-shell">
  <a href="#main" class="skip-link">Skip to content</a>
  <aside class="sidebar"> ... <nav aria-label="Main"> ... </aside>      // landmark: complementary + nav
  <div class="content-col">
    <header class="topbar"> ... </header>                                // landmark: banner
    <main id="main" tabindex="-1" class="page"> <Outlet/> </main>        // focus moved here on route change
  </div>
</div>
```

- Layout: CSS grid `grid-template-columns: var(--sidebar-w) 1fr` on >= 768; `--sidebar-w` is 256 px expanded, 64 px collapsed, 0 on mobile. Sidebar is `position: sticky; top: 0; height: 100dvh; overflow-y: auto`. Transition `grid-template-columns 200ms var(--ease-out)`.
- The content column is `min-h-dvh flex flex-col`; `main` is `flex-1 min-w-0` so pages can opt into full-height layouts (`Chat`, `Intake` view) with `flex flex-col min-h-0` children instead of the current `h-[calc(100dvh-6rem)]` which is tied to the old 3 rem top bar.
- Page container classes: `mx-auto w-full px-4 sm:px-6 lg:px-8 py-6` and a width token from design-system section 3 (`narrow` 640, `default` 960, `wide` 1200, `full`).
- On route change: move focus to `main` (or its `h1`), set `document.title = "<Page> · <Project> · Guildwise"`, announce via a polite live region. Scroll to top unless there is a hash (the desk uses `#desk-item-<id>`).

### 3.1 Sidebar, expanded (>= 1024 by default)

```
+--------------------------------+   256 px, bg-side (#0D1220), text-side-fg
|  [G] guildwise                 [<]|   56 px header: logo-dark.svg, collapse button (aria-label "Collapse menu")
|--------------------------------|
| [WEB] Web shop             [v] |   project switcher: key chip (mono) + name + chevron   (button, aria-haspopup=listbox)
| [ + New card               ]   |   lime button (bg-accent text-accent-fg), 40 px
|                                |
| WORK                           |   11->12 px label, text-side-label, 6.5:1
|  | Board                       |   active: bg-side-active, white text, 3 px lime bar at left
|    Desk                    (3) |   count pill: red (#E5484D, white text) if blocking, lime if open only
|    Intake                      |
|    Schedules                   |
|    Projects                    |
|                                |
| ORGANIZATION                   |
|    Agents                      |
|    Roles & workflows           |
|    Workstations                |
|    Metrics                     |
|                                |
| KNOWLEDGE                      |
|    Ledger                      |
|    Vaults                      |
|                                |
|  (flex spacer)                 |
|--------------------------------|
|    Admin                       |   only for admins
|  (PJ) Pieter Jordaan       [v] |   avatar + name + role; [v] opens user menu
|  [ Sign out ]        o Live    |   secondary button (text visible), live dot + text
+--------------------------------+
```

Item spec: 40 px tall (44 on touch), `px-3`, icon 20 px + label 14/500, `rounded-control`, gap 12. Hover `bg-side-hover`. Count pill right aligned. Group label `px-3 pt-4 pb-1 text-xs font-medium tracking-wide` (uppercase only here, small caps style is acceptable for labels).

Project switcher popover (Radix Popover or DropdownMenu, `w-72`): search field (if > 6 projects), list of projects grouped by department when departments exist (the existing `departmentsOf/inDepartment` helpers move here, replacing the department select on Board and Projects), each row: key chip, name, type badge (Code, Research, Feed), check on current; separator; "See all" and "New project". Shared projects show a small "shared" badge. Switching: if on `/p/<old>/board|feed` go to the same page for `<new>`, otherwise only update `lastProject` and show a toast "Now working in WEB". Keyboard: type to filter, arrows, Enter.

User menu (Radix DropdownMenu): name + email header, Theme (System / Light / Dark radio group), "User guide" (opens `/guide` if served, else docs link; owner decision), "Keyboard shortcuts" (P3), separator, "Sign out" (also exposed as the visible button, so tests find a button named "Sign out" without opening the menu).

### 3.2 Sidebar, collapsed rail (768 to 1023 by default, or user-toggled on desktop)

```
+------+
| [M]  |   64 px
| [>]  |   expand
|------|
| [WEB]|   key chip only, opens switcher
| [ + ]|   lime square button, aria-label "New card"
|      |
|  |▮| |   icon only, tooltip on hover/focus (label also sr-only so the accessible name is intact)
|  (3) |   Desk icon with a count dot at the corner
|  ...  |   groups separated by a 1 px line instead of labels
|      |
| (PJ) |   avatar opens user menu
| [->] |   sign out icon button, aria-label "Sign out"
+------+
```

Collapsed items keep `<span class="sr-only">Board</span>` so `getByRole('link', {name:'Board'})` still resolves. Tooltips appear after 300 ms on hover and immediately on keyboard focus. The preference (`guildwise-sidebar` = `expanded|collapsed`) is stored in `localStorage` (try/catch); first-visit default is by breakpoint.

### 3.3 Mobile (< 768): top bar plus off-canvas drawer

No bottom tab bar: the desk badge and New card live in the top bar so there is one navigation model, and the board needs the vertical space.

```
Top bar (56 px + safe-area-inset-top), sticky
+--------------------------------------------+
| [=]  Board              [+]  [Desk (3)] [o]|
|      WEB                                   |
+--------------------------------------------+
  [=]  hamburger, 44x44, aria-label "Open menu", aria-expanded, red dot when desk has blocking items
  title: page title (truncate) and project key on a second line (12 px, subtle)
  [+]  New card (icon button, aria-label "New card"), only on Board/Desk/Cards routes
  [Desk (3)] inbox icon button with count; aria-label "Desk, 3 open" ... see collision note: render its link name as "Desk" + visually the count
  [o]  Live dot (8 px) with aria-label "Live updates: live"/"offline"
```

Drawer (Radix Dialog configured as a side sheet; mounted only when open):

```
+---------------------------------+----------+
| [G] guildwise                  [x] |          |  width min(86vw, 320px), full height 100dvh
| [WEB] Web shop             [v]  |  scrim   |  scrim = --overlay, tap to close
| [ + New card ]                  |          |
| WORK                            |          |
|   Board                         |          |
|   Desk                      (3) |          |
|   ...                           |          |
|---------------------------------|          |
|   Admin                         |          |
|  (PJ) Pieter Jordaan            |          |
|  [ Sign out ]        o Live     |          |
|  pb: env(safe-area-inset-bottom)|          |
+---------------------------------+----------+
```

Behaviour: opens with 200 ms slide; focus moves to the first item and is trapped; Esc, scrim tap, route change and swipe-left close it and return focus to the hamburger; background gets `inert`. Items are 48 px tall. Respect `env(safe-area-inset-*)` on the drawer's left, bottom and the top bar's top (`viewport-fit=cover` in the viewport meta). Body scroll is locked while open (Radix does this).

**Single-instance rule**: the sidebar `<nav aria-label="Main">`, desk badge and live indicator are rendered conditionally with a `useMediaQuery` hook (not hidden with CSS), so a test that counts them sees exactly one. On mobile the persistent sidebar is not in the DOM and the drawer only when open; thus on mobile `getByRole('navigation', {name:'Main'})` is **not visible until the menu is opened**. The e2e checks `expect(mp.getByRole('navigation', { name: 'Main' })).toBeVisible()` use a default 1280 px context, so they are unaffected; the only 390 px test (`chat.spec.ts` AC3) opens `/chat/:id` directly and does not use the nav.

## 4. Top bar (>= 768)

```
+--------------------------------------------------------------------------------+
| Web shop / Board              [ Search or jump to...  Ctrl K ]   o Live  [Chat] |
+--------------------------------------------------------------------------------+
```

- Left: breadcrumbs (below). On pages with a single level it shows just the section name.
- Centre/right: command palette trigger (P3; hide until built), live indicator (dot + "Live" / "Reconnecting"), "Chat" button (opens the drawer), nothing else. Page-specific actions live in the page header, not the top bar, so the top bar stays calm and identical everywhere.
- Height 56 px, `bg-canvas/85 backdrop-blur border-b border-line`, sticky. Contains no h1; the page has its own.

### Breadcrumbs

`<nav aria-label="Breadcrumb"><ol>`, separators are CSS (not text), last item `aria-current="page"` and not a link, parents truncate with `max-w-[12rem]`. Desktop only; mobile shows the title/project pair in the top bar and a "Back" icon link (`aria-label="Back to board"`) in the page header where there is a parent.

| Route | Crumbs |
| --- | --- |
| `/p/:key/board` | Web shop > Board |
| `/p/:key/feed` | Web shop > Feed |
| `/cards/:ref` | Web shop > Board > WEB-42 |
| `/cards/new` | Web shop > Board > New card |
| `/projects` | Projects |
| `/projects/:id/settings` | Projects > WEB > Settings |
| `/agents` | Organization > Agents |
| `/org` | Organization > Roles & workflows |
| `/workstations`, `/metrics` | Organization > Workstations / Metrics |
| `/ledger`, `/settings/vaults` | Knowledge > Ledger / Vaults |
| `/intake`, `/intake/:id` | Work > Intake > ABC-123 |
| `/chat/:threadId` | Desk > Chat with Linus |
| `/admin` | Admin |

Group names are plain text (not links).

## 5. Responsive breakpoints

| Name | Width | Sidebar | Top bar | Page padding | Board | Dialogs |
| --- | --- | --- | --- | --- | --- | --- |
| `xs` mobile | < 640 | drawer | hamburger + title + actions | 16 | one column at a time (see pages.md) | bottom sheet |
| `sm` large phone / small tablet | 640 to 767 | drawer | same | 24 | 2 columns visible, snap scroll | centred dialog |
| `md` tablet | 768 to 1023 | collapsed rail (user can expand, overlays content) | breadcrumbs | 24 | columns 256 px, snap scroll | centred |
| `lg` desktop | 1024 to 1439 | expanded 256 | breadcrumbs + live + chat | 32 | columns 272 px | centred |
| `xl` wide | >= 1440 | expanded | same | 32, content `wide` max 1200 | columns flex to fill, min 272 | centred |

Tailwind v4 default breakpoints (`sm` 40rem, `md` 48rem, `lg` 64rem, `xl` 80rem) already match; no config needed. Touch behaviour is keyed off `@media (pointer: coarse)`, not width, so a 1366 px touch laptop still gets 44 px targets.

Landscape phones (height < 500): the drawer scrolls, the top bar is 48 px.

## 6. Wireframes

### 6.1 Desktop, Board (1440 x 900)

```
+------------------+---------------------------------------------------------------------------------------+
| [G] guildwise    [<]| Web shop > Board                                  [Ctrl K]            o Live   [Chat]  |
| [WEB] Web shop [v]+---------------------------------------------------------------------------------------+
| [ + New card    ]| Web shop                                                                               |
|                  | WEB · Code · 11 open · 2 blocked                [Search cards] [Assignee v] [Run regression] |
| WORK             |                                                                                       |
| | Board          |  SPEC  2        TO DO  2       REWORK 2      IN PROGRESS 2    BLOCKED 2     REVIEW 1 ... |
|   Desk       (3) |  ------------   ------------   ------------   ------------    ------------  ----------- |
|   Intake         |  [WEB-42  now ] [WEB-40  now ] [WEB-38  now ] [WEB-10  7m  ] [WEB-21  6m ] [WEB-36 2m ]  |
|   Schedules      |  [Redesign the] [Upgrade the ] [Bug: the del.] [Add rate lim.] [Let guests..] [Add keyb..]  |
|   Projects       |  [order conf.. ] [date picker ] [estimate says] [to the pub..] [  BLOCKED  ] [(Li) Linus]  |
|                  |  [WEB-43  now ] [WEB-41  now ] [WEB-32  now ] [WEB-39  7m  ] [WEB-30  3m ]              |
| ORGANIZATION     |  [Support gift] [Add Swedish ] [Update footer] [Add pagina..] [  BLOCKED  ]              |
|   Agents         |                                 [Rework 1    ] [(Gr) Grace  ]                           |
|   Roles & flows  |                                                                                       |
|   Workstations   |  (columns scroll horizontally if they do not fit; fade mask at the right edge;        |
|   Metrics        |   column header sticky; empty columns collapse to a 48 px strip with the count)        |
| KNOWLEDGE        |                                                                                       |
|   Ledger         |                                                                                       |
|   Vaults         |                                                                                       |
|------------------|                                                                                       |
|   Admin          |                                                                                       |
| (PJ) Pieter   [v]|                                                                                       |
| [Sign out]  o Live|                                                                                      |
+------------------+---------------------------------------------------------------------------------------+
```

### 6.2 Desktop, collapsed rail (Desk page)

```
+----+-------------------------------------------------------------------------------+
|[M] | Desk                                                              o Live [Chat] |
|[>] +-------------------------------------------------------------------------------+
|WEB | Decision desk                                         [Add to ledger][Intake][Chat]|
|[+] | 3 open · 1 blocking                                                            |
|    | (All 3) (Blocking 1) (Questions 1) (Approvals 1) (Notices 0)   [Sort: Priority v]|
|[]  | |#| URGENT  BLOCKING  Question   asked 7m ago                                    |
|[3] | |#| (GR) Grace (builder)  WEB-21 Let guests check out ...                         |
|[]  | |#| How long may we keep the personal data of a guest ...?                        |
| .. | ...                                                                              |
+----+-------------------------------------------------------------------------------+
```

### 6.3 Mobile (390 x 844), closed and open drawer

```
 closed                                   drawer open
+--------------------------------+       +--------------------------+---+
| [=]  Board         [+] [Desk3] |       | [G] guildwise           [x] |///|
|      WEB                  o    |       | [WEB] Web shop       [v] |///|
+--------------------------------+       | [ + New card          ]  |///|
| ( Spec 2 )( To do 2 )( Rework 2)>      | WORK                     |///|
| -------------------------------|       |  | Board                 |///|
| SPEC                        2  |       |    Desk              (3) |///|
| [WEB-42                   now ]|       |    Intake                |///|
| [Redesign the order           ]|       |    Schedules             |///|
| [confirmation page            ]|       |    Projects              |///|
| [WEB-43                   now ]|       | ORGANIZATION             |///|
| [Support gift wrapping        ]|       |    Agents ...            |///|
|                                |       |--------------------------|///|
|                                |       | (PJ) Pieter Jordaan      |///|
|                                |       | [Sign out]      o Live   |///|
+--------------------------------+       +--------------------------+---+
 safe area padding at the bottom         /// = scrim, tap closes
```

## 7. Accessibility checklist (shell)

- [ ] Skip link ("Skip to content") is the first focusable element, visible on focus, targets `#main`.
- [ ] Landmarks: one `banner` (top bar), one `nav aria-label="Main"`, one `main`, `nav aria-label="Breadcrumb"`. Sidebar `aside` has an accessible name only if it holds more than the nav; otherwise nav alone.
- [ ] Nav links use real `<a>` (React Router `NavLink`), `aria-current="page"` on the active one; group headings are `h2`.
- [ ] Collapsed rail: every item has a visible tooltip on focus and an `sr-only` label; the collapse button has `aria-expanded` and an `aria-label` that flips ("Collapse menu" / "Expand menu").
- [ ] Hamburger: 44 x 44, `aria-controls` the drawer, `aria-expanded`. Drawer is a modal dialog (`role="dialog"` with `aria-label="Main menu"`), traps focus, Esc closes, focus returns to the trigger, background `inert`.
- [ ] Desk badge has a text alternative: the link's accessible name stays "Desk" and the pill carries `title`/`aria-label` "3 open, 1 blocking" (as today). Count changes are announced via one polite live region ("Desk: 4 open"), debounced, not on every poll.
- [ ] Live indicator is text ("Live"/"Reconnecting") not just a dot; offline uses `warning`, not red only.
- [ ] Project switcher is a labelled button (`aria-label="Project: WEB Web shop"`) opening a listbox with `aria-selected`; typing filters.
- [ ] Focus visible everywhere; lime focus outline on the dark sidebar (14.8:1).
- [ ] Route change moves focus to `main`/`h1` and updates `document.title`.
- [ ] Targets >= 44 px on coarse pointers; nothing relies on hover.
- [ ] Theme toggle respects system; `color-scheme` meta updated; no flash of the wrong theme (external `theme-init.js`, CSP-safe).
- [ ] `prefers-reduced-motion` removes the drawer slide and width transition.
- [ ] Zoom 200 % / 320 px width: no horizontal scroll in the shell; page content may scroll horizontally only inside the board region.

## 8. Implementation notes for the builder

- New files: `components/shell/AppShell.tsx`, `Sidebar.tsx`, `NavItem.tsx`, `ProjectSwitcher.tsx`, `UserMenu.tsx`, `TopBar.tsx`, `Breadcrumbs.tsx`, `MobileDrawer.tsx`, `nav-config.ts` (the table in section 2 as data with `adminOnly`, `flag`, `match` predicate), `lib/useMediaQuery.ts`, `lib/useTheme.ts`, `lib/usePageTitle.ts`. `Layout.tsx` keeps exporting `RequireAuth` (router imports it) and renders `<AppShell>`.
- Keep `useDesk()` for counts: `counts.open`, `counts.blocking`. `title={`${blocking} blocking, ${open} open`}` stays on the pill.
- Keep `getSocket()?.start()/stop()` effect and `useSocketState()` in `RequireAuth`.
- Keep `getLastProjectKey()` semantics; the switcher calls `setLastProjectKey`.
- Admin item visibility: `me.data.isAdmin`.
- Drawer and popovers use the Radix packages already in `package.json` (`react-dialog`, `react-dropdown-menu`); add `@radix-ui/react-popover` and `@radix-ui/react-tooltip` (or implement the tooltip with `title` + CSS for the rail).
