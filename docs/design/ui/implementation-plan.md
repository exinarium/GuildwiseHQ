# Implementation plan (for feature-builder)

Read first: `design-system.md` (tokens and components), `layout-and-navigation.md` (shell), `login.md`, `pages.md`. Assets already written: `logo.svg`, `logo-light.svg`, `logo-dark.svg`, `logo-mark.svg`, `favicon.svg`, `login-art.svg` in `docs/design/ui/`.

Scope rules that apply to every step:

- Only `apps/web` changes (plus `e2e` test updates called out below). No API, schema or route changes; no changes to `@aom/*` package names, `aom` CLI, `aom-runner`.
- **Keep stable**: every `data-testid`, every accessible name listed in section 6, every route path. If a name must change, update the tests in the same commit.
- Work in small commits, one step each. After each step: `pnpm --filter @aom/web typecheck`, `pnpm --filter @aom/web test`, `pnpm lint` (Biome), and the screenshot run (section 5) must pass/look right before moving on.
- Do not run `pnpm add` concurrently with other agents (lockfile). Dependencies in step 0 only.
- Node: `nvm use` (Node 22.23). The dev web server proxies `/api` to `127.0.0.1:4600`; for UI-only work use the MSW mode `VITE_MSW=1 pnpm --filter @aom/web dev` (sign in with `admin@example.com` / `password123456`).

## Step 0 , Decisions, dependencies, branch

1. Confirm with the owner (see "Decisions needed" at the end): name Guildwise, palette, Geist font, lucide icons, no bottom tab bar.
2. Add dependencies to `apps/web`: `@fontsource-variable/geist`, `@fontsource-variable/geist-mono`, `lucide-react`, `@radix-ui/react-popover`, `@radix-ui/react-tooltip`, `@radix-ui/react-toast` (or skip toast and write the 60-line custom provider). Dev: `@axe-core/playwright` in `e2e` (for step 7).
3. Verify: `pnpm install` clean; `pnpm --filter @aom/web build` passes.

## Step 1 , Tokens, fonts, theme, brand assets

Files: `apps/web/src/index.css`, `apps/web/index.html`, `apps/web/public/theme-init.js`, `apps/web/public/favicon.svg`, `apps/web/public/apple-touch-icon.png`, `apps/web/src/main.tsx`.

Do:
1. Replace `index.css` with the block from `design-system.md` section 1.8 (tokens for light and `[data-theme=dark]`, `@theme inline`, `@custom-variant dark`, focus ring, reduced motion). Fill in the "repeat for warning, danger, info" lines.
2. `public/theme-init.js`: ~12 lines. Read `localStorage.getItem('guildwise-theme')` (try/catch), `'light'|'dark'` wins, else `matchMedia('(prefers-color-scheme: dark)')`; set `document.documentElement.dataset.theme`. Also listen for system changes when the stored value is absent. **External file, not inline** (server CSP `script-src 'self'`).
3. `index.html`: `<title>Guildwise</title>`, `<script src="/theme-init.js"></script>` first in `<head>`, `<link rel="icon" href="/favicon.svg" type="image/svg+xml">`, `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`, `<meta name="theme-color" content="#0D1220">`, keep `color-scheme` meta, add `viewport-fit=cover` to the viewport meta.
4. Copy `favicon.svg`. Render `logo-mark.svg` to a 180 px PNG for the touch icon (Playwright screenshot of the SVG is enough).
5. `main.tsx`: `import '@fontsource-variable/geist/wght.css'; import '@fontsource-variable/geist-mono/wght.css';` before `./index.css`.
6. Create `src/lib/useTheme.ts` (`'system'|'light'|'dark'`, persists to `guildwise-theme`, updates `dataset.theme`).

Because the `dark:` variant now keys off `[data-theme=dark]`, all existing `dark:` classes keep working during migration.

Verify: app renders with Geist; toggling `document.documentElement.dataset.theme='dark'` in devtools flips body colour; no CSP console errors when served by the real server (`pnpm --filter @aom/web build` then run the server which serves `dist`; check the Network tab shows fonts from `/assets/...`).

## Step 2 , Token swap in `components/ui.tsx` (no API change)

Files: `components/ui.tsx` (optionally split into `components/ui/*` re-exported from `ui.tsx`), `lib/avatar.ts`.

Do:
1. Re-map classes per `design-system.md` section 6: `Button` (variants incl. new `danger-ghost`, `link`; sizes `sm|md|lg`; `loading` prop; `min-h` 40 and 44 on coarse pointer), inputs (`h-10`, `border-control`, `rounded-control`, ring), `Select` chevron skin, `Badge` (tone aliases kept: `neutral|red|amber|green|blue|violet`; new `brand|success|warning|danger|info`), `Panel` (optional `title`, `actions`, `padding`), `ErrorBox` (icon, optional `onRetry`), `Avatar` (`hsl(h 50% 30%)`).
2. Add `Dialog` close button and mobile sheet styling; add `footer`/`size` props (optional, defaults unchanged).
3. `PageHeader`: wrap instead of `truncate`; add optional `breadcrumb`, `back`, and `actions` overflow (> 3 -> menu is a later step; for now only wrapping).
4. Do **not** rename exports or props. Do not move test ids.

Verify: unit tests; update `workability.test.tsx` class assertions (`text-red` -> check `data-level` attribute and `text-danger`, `text-amber` -> `text-warning`; also change `WorkabilityWarning.tsx` accordingly). Screenshot run: all pages still render in both themes (old zinc pages remain unchanged until their step).

## Step 3 , App shell

Files (new): `components/shell/{AppShell,Sidebar,NavItem,ProjectSwitcher,UserMenu,TopBar,Breadcrumbs,MobileDrawer,nav-config}.tsx|ts`, `components/Logo.tsx`, `lib/{useMediaQuery,usePageTitle}.ts`. Modify: `components/Layout.tsx` (keep `RequireAuth` export; `Shell` becomes `AppShell`), `src/test/setup.ts`.

Do (details in `layout-and-navigation.md`):
1. `Logo.tsx`: inline SVG of the mark and wordmark (paths from `logo-dark.svg`); props `variant`, `size`, `collapsed`.
2. `nav-config.ts`: groups and items (label, to, icon, match, badge, adminOnly, flag).
3. `Sidebar` (expanded/collapsed) and `MobileDrawer` (Radix Dialog), `ProjectSwitcher` (Popover + filter + department grouping using `departmentsOf/inDepartment`), `UserMenu` (DropdownMenu with theme radio), visible **Sign out** button (name unchanged), live indicator (`data-testid="live-indicator" data-state`), desk badge (`data-testid="desk-badge"`, `title` text unchanged), New card link.
4. `TopBar` (mobile: hamburger, title/project, New card icon, Desk button with count; desktop: breadcrumbs, live, Chat button). Lift `ChatDrawer` open state into the shell (Desk page keeps its own "Chat" button which can call a shared store/context).
5. Render exactly one of {sidebar nav, drawer nav} and one desk badge / live indicator via `useMediaQuery` (breakpoints 768 and 1024). In `src/test/setup.ts` add a `matchMedia` polyfill (jsdom has none) defaulting to desktop, plus the Radix-in-jsdom shims (`ResizeObserver`, `Element.prototype.hasPointerCapture`, `scrollIntoView`, `PointerEvent`).
6. Skip link, `<main id="main" tabIndex={-1}>`, focus `main` on route change, `usePageTitle`.
7. Remove the project/department `<select>`s from `Board.tsx` later in step 6 (they keep working until then).

Verify: Playwright screenshots at 390 / 768 / 1440 for light and dark; keyboard: Tab order (skip link, logo, switcher, New card, nav items, user area), drawer focus trap and Esc; run `e2e/tests/auth.spec.ts` against a real stack (see "E2E" below) and `desk.spec.ts` (badge). Update e2e only if a collision with duplicate link names appears (see layout doc).

## Step 4 , Login and Accept invitation

Files: `pages/Login.tsx`, `pages/AcceptInvite.tsx`, new `components/auth/{AuthFrame,LoginArt,PasswordInput}.tsx`, `src/assets/login-art.svg` (copy of `docs/design/ui/login-art.svg`).

Do: per `login.md`. `PasswordInput` toggle name must not contain "password" (`Show characters`). Keep `safeNext`, schemas, `aria-label`s, labels `Email`, `Password`, `Display name`, `Confirm password`, button names `Sign in`, `Create account`; keep a `role="alert"` on failure.

Verify: unit (no existing login unit test; add `test/login.test.tsx`: renders, shows client errors, shows alert on 401 via msw, reveal toggle toggles `type`, caps lock hint); e2e `auth.spec.ts`; screenshots of `/login` and `/invite/<token>` (valid with MSW, invalid) in all four combinations (desktop/mobile x light/dark); contrast spot check with axe.

## Step 5 , Shared components (new)

Files (new, under `components/ui/`): `Tabs.tsx`, `EmptyState.tsx`, `Skeleton.tsx` (+ `PageSkeleton`, `BoardSkeleton`, `ListSkeleton`), `Toast.tsx` (+ provider mounted in `main.tsx`), `ConfirmDialog.tsx`, `Callout.tsx`, `Menu.tsx` (thin wrapper over Radix DropdownMenu), `StatusDot.tsx`, `StageChip.tsx` + `lib/stages.ts` (stage name -> token/glyph/fallback hue), `Stepper.tsx` (for card pages), `Disclosure.tsx` (accessible `details` styling), `Segmented.tsx`, `lib/useDelayedFlag.ts`.

Do: implement per `design-system.md` section 4. `EmptyState` accepts `data-testid`. `Spinner` keeps its signature (`label`) but renders a skeleton-compatible `role="status"` with `sr-only` text `"{label}..."`. `ConfirmDialog` props: `open, onOpenChange, title, description, confirmLabel, tone, onConfirm, pending`.

Verify: add a Storybook-free demo route only in dev (`/__ui` guarded by `import.meta.env.DEV`) rendering every component in both themes for screenshots; unit tests for `Tabs` keyboard behaviour, `ConfirmDialog` focus, `Toast` roles. Remove or keep the dev route out of the production bundle (dynamic import under the DEV check).

## Step 6 , Pages (in this order; one commit per page group)

Use `pages.md` for the exact redesign and problems per page. For every page: skeleton, EmptyState, error with retry, toast on success, `usePageTitle`, widths from tokens, tokens instead of zinc classes.

| Order | Page(s) | Priority | Key files | Watch out for |
| --- | --- | --- | --- | --- |
| 6.1 | Board | P1 | `Board.tsx`, `BoardView.tsx`, `WorkabilityWarning.tsx`, `RegressionDialog.tsx` | keep `data-testid` `board`, `column-*`, `card-tile-*`, `waiting-badge`, `suite-badge`, `tile-assignee`, `waiting-on-link-*`; mobile column tabs must not remove columns from the DOM at jsdom width; `BoardView.test.tsx` |
| 6.2 | Desk | P1 | `Desk.tsx` (+ `DigestRating`, `EscalationTrail`, `MappingForm`, `OutboundApproval`, `LedgerForm`, `ChatDrawer`) | `desk.test.tsx` (278 lines), `feeds.test.tsx`, `outbound.test.tsx`, `intake.test.tsx`; keep `DeskItem` export and signature; Dismiss confirm flow needs test updates |
| 6.3 | Card detail | P1 | `CardDetail.tsx` (+ `CardEdit`, `EvidencePanel`, `FinalizePanel`, `OutboundHistory`, `PublicationPanel`, `ShiftLog`) | `card-edit.test.tsx`, `merge-policy.test.tsx`, `testing.test.tsx`, `research.test.tsx`, `sandbox.test.tsx`; menu items vs buttons (see `pages.md` 7) |
| 6.4 | Card new | P1 | `CardNew.tsx`, `CardFormFields.tsx` | `CardNew.test.tsx`, `repo-less.test.tsx`; keep `Specify`, `Save draft`, form `aria-label="New card"`, field labels |
| 6.5 | Projects, Project settings | P2 | `Projects.tsx`, `ProjectSettings.tsx`, `MembersPanel`, `MergePolicyPanel`, `ProjectInvitations` | `sharing.test.tsx` (`Accept invitation to TOY`), e2e `Settings for TOY` |
| 6.6 | Agents (HR) | P2 | `Agents.tsx`, `components/hr/*` | `hr.test.tsx` button names; `?hire=` prefill query |
| 6.7 | Workstations, Admin | P2/P3 | `Workstations.tsx`, `Admin.tsx`, `DevOpsPanel.tsx`, `SandboxWarning.tsx` | `sandbox.test.tsx`; `pairCommand` export used by tests |
| 6.8 | Ledger, Vaults | P2 | `Ledger.tsx`, `LedgerForm.tsx`, `Vaults.tsx` | keep `ledger-*` test ids |
| 6.9 | Intake, Chat | P2 | `Intake.tsx`, `Chat.tsx`, `ChatPanel.tsx`, `ChatDrawer.tsx` | `intake.test.tsx`, `chat.test.tsx`, e2e `chat.spec.ts` 390 px (`heading "Chat with Linus"`, `chat-message`, label `Message`) |
| 6.10 | Organization designer | P2 | `OrgDesigner.tsx`, `components/org/*` | `org-designer.test.tsx` (tab roles and names) |
| 6.11 | Schedules, Feed, Metrics | P3 | `Schedules.tsx`, `FeedProject.tsx`, `Metrics.tsx`, `components/hr/Charts.tsx` | `feeds.test.tsx`; `window.confirm` replacement needs the test to click the confirm button |

Parallelisation: after step 5, 6.1 to 6.4 should be done in order by one builder (they define the visual language in practice); 6.5 to 6.11 can be split across builders by file ownership.

## Step 7 , Polish and verification

1. `ErrorBoundary` at router level; 404 handling unchanged.
2. Keyboard shortcuts (P3): `g b` board, `g d` desk, `n` new card, `/` focus search, `?` help dialog. Command palette (`Ctrl/Cmd+K`, P3).
3. Document titles for all routes.
4. Axe pass on every route (section 5); fix serious/critical violations.
5. Remove leftover `zinc-`/`indigo-`/`emerald-`/`amber-`/`sky-`/`violet-`/`red-` classes: `grep -rnE "(zinc|indigo|emerald|amber|sky|violet|red|blue)-[0-9]" apps/web/src --include=*.tsx` must return only intentional hits.
6. Update `docs/guide` screenshots later (separate task; `guide-screenshots.spec.ts` regenerates them). USER-GUIDE text mentions "top tabs"? (it says "in the sidebar" already).
7. Update README/USER-GUIDE product name only if the owner decides to.

---

## 5. Screenshot-based verification

Add `apps/web/scripts/ui-shots.mjs` (or `e2e/support/ui-shots.ts`) using the repo's Playwright and `/usr/bin/chromium`:

```js
// usage: node apps/web/scripts/ui-shots.mjs [outDir]   (expects http://127.0.0.1:5199 running with VITE_MSW=1)
import { chromium } from '/path/to/guildwise/e2e/node_modules/@playwright/test/index.mjs';
const base = process.env.BASE ?? 'http://127.0.0.1:5199';
const out = process.argv[2] ?? 'docs/design/ui/after';
const routes = {
  login: '/login', projects: '/projects', board: '/p/WEB/board', desk: '/desk', 'card-new': '/cards/new',
  'card-detail': '/cards/WEB-10', agents: '/agents', workstations: '/workstations', ledger: '/ledger',
  vaults: '/settings/vaults', org: '/org', 'org-workflows': '/org?tab=workflows', schedules: '/schedules',
  feed: '/p/NEWS/feed', metrics: '/metrics', admin: '/admin', intake: '/intake', 'project-settings': '/projects/<id>/settings',
};
const sizes = { d: { width: 1440, height: 900 }, m: { width: 390, height: 844, isMobile: true, hasTouch: true } };
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
for (const [sk, vp] of Object.entries(sizes)) for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme, reducedMotion: 'reduce', ...(vp.isMobile ? { isMobile: true, hasTouch: true } : {}) });
  await ctx.addInitScript((s) => localStorage.setItem('guildwise-theme', s), scheme);
  const p = await ctx.newPage();
  await p.goto(base + '/login'); await p.screenshot({ path: `${out}/login-${sk}-${scheme}.png` });
  await p.getByLabel('Email').fill('admin@example.com'); await p.getByLabel('Password').fill('password123456');
  await p.getByRole('button', { name: 'Sign in' }).click(); await p.waitForURL((u) => !u.pathname.startsWith('/login'));
  for (const [name, path] of Object.entries(routes)) {
    if (name === 'login') continue;
    await p.goto(base + path); await p.waitForLoadState('networkidle');
    await p.screenshot({ path: `${out}/${name}-${sk}-${scheme}.png`, fullPage: name !== 'board' });
  }
  if (sk === 'm') { /* also capture the open drawer */
    await p.goto(base + '/p/WEB/board'); await p.getByRole('button', { name: 'Open menu' }).click();
    await p.screenshot({ path: `${out}/drawer-m-${scheme}.png` });
  }
  await ctx.close();
}
await browser.close();
```

Prerequisites and details:

- **Seed data.** The MSW mock DB (`src/mocks/db.ts`) starts with no projects, so screenshots would show only empty states. Extend the seed behind `VITE_MSW` (not shipped in prod) with: projects `WEB` (code), `NEWS` (feed), `RES` (research); ~14 cards spread across all code columns incl. blocked, rework 1, waiting, large risk and a done card; 5 agents (builder, reviewer, tester, BA, DevOps) with stats; 6 desk items (urgent question, blocking approval, notice, digest rating, outbound approval, unmapped ticket); ledger entries of the three scopes; two workstations (one with the unsandboxed warning, one offline); one vault with a conflict; two schedules; one intake thread. The existing real-data captures in `docs/guide/raw/*.png` are a good visual reference for the mix.
- Capture empty-state variants too: a second run with `?seed=empty` (or the current empty DB) for `board`, `desk`, `ledger`, `agents`, `projects`, `workstations`, `vaults`, `schedules`.
- Output folder `docs/design/ui/after/` (PNG, keep each under about 150 KB; use `jpeg` quality 80 if the count gets large). Compare side by side with `docs/design/ui/current/`.
- Reviewer checklist per screenshot: no horizontal page scroll at 390 px; text not clipped; hit targets visually >= 44 px on mobile; contrast of captions in dark mode; active nav item visible; focus ring visible (take one extra shot with `p.keyboard.press('Tab')` x3 on login and board); no layout shift between skeleton and content.
- **Automated a11y**: in the same script (or `e2e/tests/a11y.spec.ts`, not part of the default run) use `@axe-core/playwright`: `new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag22aa']).analyze()` per route/theme; fail on `serious`/`critical`. Run once per theme because contrast violations differ.
- Responsive sweep: also capture the Board and Desk at 768 x 1024 and 1024 x 768 to check the rail/expanded transitions, and at 320 x 640 for overflow.
- Reduced motion run: `reducedMotion: 'reduce'` is already set above; verify the login art is static and the drawer appears without sliding.

## 6. Tests likely affected

### Names and ids that must stay (grep-derived from `src/test/*` and `e2e/tests/*`)

- Landmarks/links: `navigation "Main"`; links `Board`, `Desk`, `Workstations`, `Projects`, `Admin`, `Settings for {KEY}`, `Pick the project`; `Back to the desk`, `All intakes` (check the intake tests).
- Buttons: `Sign in`, `Sign out`, `Create account`, `Send invitation`, `Resend invitation to {email}`, `Revoke invitation to {email}`, `Cancel invitation for {name}`, `Accept invitation to {KEY}`, `Specify`, `Save draft`, `Edit`, `Move`, `Release`, `Re-home`, `Cancel card`, `Set risk tier`, `Save changes`, `Answer`, `Dismiss`, `Approve`, `Reject`, `Approve merge`, `Approve and post`, `Approve and post my edit`, `Retry`, `Acknowledge`, `Hire`, `Hire agent`, `Change model of {name}`, `Change role of {name}`, `Fire {name}`, `Unlink {name}`, `Confirm unlink`, `Confirm removal`, `Run now`, `Create schedule`, `Create department`, `New custom role`, `Extend {role}`, `Save extensions`, `Add stage`, `Add outcome to work`, `View {workflow} v1`, `New version of {workflow} v2`, `Start intake`, `Map to project`, `Send`, `Transcript`, `Useful`, `Merge large changes without my approval`, `Yes, merge without my approval`, `Pair workstation`, `Generate pairing code`, `Copy command`, `Resume sync on {ws}`.
- Labels: `Email`, `Password` (substring match: nothing else may carry "password" in its label), `Confirm password`, `Display name`, `Message`, `Project` (inside forms), `Role for {email}`, `Decision policy`.
- Roles/names: `form "New card"`, `form "Invite user"`, `heading "Chat with Linus"`, tabs in the Organization page (`role=tab` with names from `TABS`).
- Test ids: all 191 existing `data-testid`s (list with `grep -rhoE 'data-testid="[^"]+"' apps/web/src --include=*.tsx | sort -u`), notably `desk-badge`, `live-indicator`, `board`, `column-*`, `card-tile-*`, `desk-list`, `desk-item-*`, `desk-empty`, `desk-counts`, `ledger-*`, `agent-*`, `workstation-*`, `vault-*`, `intake-*`, `schedule-*`, `metric-*`, `timeline`, `handoffs`, `workability-warning`.

### Tests that will need edits

| Test | Why | Edit |
| --- | --- | --- |
| `src/test/workability.test.tsx` (lines 57, 69) | asserts class names `text-red`, `text-amber` | assert on `data-level` + new token classes `text-danger` / `text-warning` |
| `src/test/desk.test.tsx` | Dismiss gets a confirm; filter chips and grouping change the DOM; empty state markup | click the confirm button; keep `desk-item-*` assertions; adapt empty text if copy changes |
| `src/test/hr.test.tsx` | actions may move into a menu (`menuitem`) | use `getByRole('menuitem')` after opening the menu, or keep visible buttons |
| `src/test/card-edit.test.tsx` | overflow menu on the card page | open "More" first for Release/Re-home/Cancel; `Move` and `Edit` stay visible |
| `src/test/org-designer.test.tsx` | new `Tabs` component | tab names unchanged; verify arrow-key test if added |
| `src/test/feeds.test.tsx`, `intake.test.tsx`, `chat.test.tsx`, `outbound.test.tsx`, `research.test.tsx`, `testing.test.tsx`, `sandbox.test.tsx`, `repo-less.test.tsx`, `sharing.test.tsx`, `merge-policy.test.tsx`, `BoardView.test.tsx`, `CardNew.test.tsx` | restyle only; text of empty/loading copy and headings may shift | fix any `getByText` that matches changed copy; keep labels |
| `src/test/setup.ts` | `matchMedia`, Radix shims | add polyfills (step 3) |
| New tests | login, shell nav (single instance, collapsed names), Tabs, ConfirmDialog, Toast | add |
| `e2e/tests/auth.spec.ts` | `Sign in` alert, Main nav visible, `Sign out` button, no Admin link for member | should pass unchanged because Sign out stays visible and the 1280 px context shows the sidebar |
| `e2e/tests/pairing.spec.ts`, `core-loop.spec.ts`, `desk.spec.ts` | link/ids as above | pass unchanged if the collision rule in the layout doc is respected; scope locators to `navigation "Main"` where a breadcrumb duplicates a label |
| `e2e/tests/chat.spec.ts` (390 px) | `/chat/:id` page | heading `Chat with Linus` must remain an `h1` or heading role |
| `e2e/tests/guide-screenshots.spec.ts` and `guide-capture` | visuals change, selectors rely on labels | run once after step 6 to see whether any capture fails; regenerate guide assets as a separate task |

### E2E run

Per README: `docker compose -f docker-compose.dev.yml up -d`, then `pnpm e2e` (the Playwright project spins up server + runner). Run at least `auth`, `desk`, `core-loop`, `pairing`, `chat`, `sharing`, `org-designer` specs after steps 3, 4, 6.2 and 6.3.

## 7. Risks and gotchas

- **CSP** (`apps/server/src/app.ts`): no inline scripts, `font-src 'self'`, `img-src 'self' data:`. No Google Fonts, no remote images, no inline `<script>`; inline SVG and `style` attributes are fine.
- **Strict-mode locators** with duplicate link names (see layout doc).
- **jsdom**: no `matchMedia`, Radix needs pointer-event shims; the hidden-on-mobile board columns must not rely on CSS in unit tests (`css: false` in `vite.config.ts`).
- **Priority semantics are not documented in the UI** ("Priority (1-9)"). Confirm with the server dispatcher which direction is urgent before mapping to Low/Normal/High/Urgent labels; until confirmed, keep the numeric input and add the explanation.
- **Risk tier values** are free strings in the UI; map known ones, fall back to a neutral badge.
- **Board column names come from workflow definitions**: custom workflows add unknown names; stage colours need the fallback hue (design system 1.5).
- **Performance**: Geist variable fonts add about 70 KB woff2; use `font-display: swap`; keep the login art as a single SVG (13 KB).
- **Do not** introduce a CSS-in-JS or component library; Tailwind v4 + Radix stay.

## Brand constants (do this first, so a future rename is one edit)

- Create `apps/web/src/brand.ts` as the single source of truth and import it everywhere. No component, page title, `aria-label`, toast or test may hard-code the strings.

  ```ts
  export const BRAND = {
    name: 'Guildwise',
    descriptor: 'Guildwise: your guild of AI agents',
    slogan: 'Many hands. One master.',
    domain: 'guildwisehq.com',
    storagePrefix: 'guildwise', // keys: guildwise-theme, guildwise-sidebar
  } as const;
  export const pageTitle = (...parts: string[]) => [...parts, BRAND.name].join(' · ');
  ```
- Copy the logo files from `docs/design/ui/` into `apps/web/public/brand/`: `logo.svg`, `logo-light.svg`, `logo-dark.svg`, `logo-mark.svg`, `logo-hq.svg`, and `favicon.svg` (also served at `/favicon.svg`). `components/Logo.tsx` loads them from `/brand/` (or inlines them) and takes `aria-label` and `alt` from `BRAND.name`.
- `index.html` `<title>` cannot import TS: have Vite replace a `%BRAND_NAME%` placeholder from `brand.ts` (small `transformIndexHtml` plugin), so it is still one edit.
- `theme-init.js` is an external static file and cannot import `brand.ts`; keep its storage key in a `// keep in sync with brand.ts` comment, or generate it in the same Vite plugin.
- A rename then means: edit `brand.ts`, replace the files in `public/brand/`, regenerate `apple-touch-icon.png`.
- Tests assert against `BRAND.name`, not string literals.

## Decisions needed from the owner

1. Name **Guildwise HQ** (chosen by the owner; see `name.md`): README, USER-GUIDE and server emails are renamed; no "formerly" wording anywhere.
2. Always-dark sidebar with lime accent (recommended) versus a sidebar that follows the theme.
3. Self-hosted Geist fonts and `lucide-react` (two new dependency families), or system font + hand-made icons.
4. Mobile navigation: drawer only (recommended) versus adding a bottom tab bar (Board, Desk, New, Menu).
5. Priority scale direction and wording (Low/Normal/High/Urgent) for the card form.
6. Desk redesign depth: grouped list with filters (recommended, low risk) versus a two-pane inbox (list left, detail right) on desktop.
7. Nav label changes: "HR" -> "Agents", "Organization" -> "Roles & workflows".
