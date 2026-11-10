# GWP-159: the installed app does not respect device safe areas

Target branch: `release/1.6.0`. Scope: `apps/web` only. `guildwise-cloud` holds only the marketing site and has no PWA
shell, manifest or standalone code, so it is not touched.

## 1. Question

Why does the installed web app run under the status bar, notch and home indicator? What has to change so that the
header, tab bar, sheets, dialogs, drawers, toasts, the push prompt and the chat composer stay inside the safe area in
portrait and landscape, without changing desktop or a normal browser tab and without breaking the GWP-79 keyboard
behaviour?

## 2. What release/1.6.0 already has (requirement 0)

I checked `origin/release/1.6.0`. It is the same commit as the card branch base (`b648d067`, no commits between them).

| Item | State before the change | Where |
| --- | --- | --- |
| Viewport meta | `width=device-width, initial-scale=1.0, viewport-fit=cover` (already set) | `apps/web/index.html:6` |
| `apple-mobile-web-app-capable` | `yes` (also `mobile-web-app-capable` `yes`) | `index.html:11-12` |
| `apple-mobile-web-app-status-bar-style` | `black-translucent` | `index.html:13` |
| `apple-mobile-web-app-title` | `Guildwise` | `index.html:14` |
| `theme-color` meta | `#f5f6f8` for `prefers-color-scheme: light`, `#0b0e14` for dark. These are the `--canvas` tokens in `tokens.css:4` and `:67` | `index.html:8-9` |
| Manifest file | `apps/web/public/manifest.webmanifest`, linked from `index.html:10` | |
| Manifest `display` | `standalone` | |
| Manifest `orientation` | `portrait-primary` | |
| Manifest `theme_color` | `#0D1220`, the light `--side-bg` navy. It matches neither canvas colour | |
| Manifest `background_color` | `#0b0e14`, the dark canvas | |
| `env(safe-area-inset-*)` | Written inline 28 times across 14 files, not from a shared definition (list below) | |
| GWP-79 viewport store | `lib/viewport.ts` writes `--vvh`, `--vv-top`, `--kbd-gap` and `html[data-kbd]`. It runs on phones only (`useViewportSync(!isTabletUp)`) | `lib/viewport.ts`, `AppShell.tsx:125` |
| GWP-79 CSS | `--app-tabbar-h: calc(3.5rem + env(safe-area-inset-bottom, 0px))` and `--app-bottom-inset` (tab bar or keyboard) below 768px, `0px` from 768px up. The tab bar is hidden while the keyboard is open | `index.css:291-317` |

These are the inline `env()` uses before the change:

- `index.css:271` `.sticky-actions` bottom padding `max(0.75rem, env(bottom))`, and `index.css:300` `--app-tabbar-h`.
- `AppShell.tsx:359` mobile top bar: `pl-[max(0.5rem,env(left))] pt-[env(top)]`. It has `pr-2` and no right inset.
- `AppShell.tsx:442` mobile "More" menu: top, right and left insets.
- `MobileTabBar.tsx:107`: bottom, left and right insets.
- `Sidebar.tsx:183` footer: bottom inset.
- `ui.tsx:434` Dialog sheet variant: `max-sm:pb-[env(bottom)]`.
- `ui/BottomSheet.tsx:67,104,108`: full-size top, footer bottom, and a bottom spacer.
- `ChatDrawer.tsx:94`: all four insets.
- `ui/Toast.tsx:66`: phone top is `calc(env(top)+4rem)`.
- `PinnedScreen.tsx:32`: left and right insets.
- `CardNew.tsx:370`: sticky bar bottom inset.
- `palette/CommandPalette.tsx:354`: phone top inset.
- `help/PageHelpPanel.tsx:32`: phone sheet bottom inset.
- `auth/AuthFrame.tsx:17,39`: top and bottom insets.

`PushPrompt.tsx:80` and `UpdateToast.tsx:12` use `--app-bottom-inset`, so they clear the tab bar on a phone. From 768px
up they use `bottom-4` or `0.75rem` with no inset.

## 3. Findings: why it still goes wrong

### 3.1 Top (iPhone portrait): the WebKit top-inset regression combined with `black-translucent`

With `black-translucent`, the page draws under the status bar and has to pad itself by `env(safe-area-inset-top)`. The
mobile top bar already does that. On iOS 26.1 and later, however, home-screen web apps report
`env(safe-area-inset-top)` as `0`. This is WebKit bug 301994, "REGRESSION (iOS 26.1): Status bar remains visible in
fullscreen mode in Home Screen Web apps". It was fixed in 26.2, seen again on 26.5.2 and on the iOS 27 beta, and is
currently REOPENED. So the header pads by 0 and its title and buttons sit under the status bar and Dynamic Island. That
matches the report on the card.

`black-translucent` also always draws white status-bar text. On the light theme the header behind it is `#f5f6f8`, so
the text is unreadable.

**Owner decision (2026-11-08):** use `apple-mobile-web-app-status-bar-style` `default`. iOS then draws an opaque
system bar, light or dark following the iOS appearance, and lays the page out below it. The text is always readable,
and the top inset is no longer needed in portrait, so the WebKit bug cannot hurt us. The trade-off is accepted: nothing
is drawn under the status bar, and if the user picks an in-app theme against the iOS setting, the bar colour will not
match the header.

### 3.2 Landscape uses the tablet layout, which has no inset handling at all

The shell switches at 768px (`useIsTabletUp`). Every notched iPhone in landscape is 812px wide or more, and so is a
typical Android phone in landscape. So landscape shows the **sidebar layout**, not the tab bar:

- The left sidebar (`AppShell.tsx:283`, a `4rem` rail below 1024px) sits under the notch or rounded corner on the left.
- The tablet header (`AppShell.tsx:306`, `h-14 px-6`) and the main content (`AppShell.tsx:410`) run under the right
  inset.
- At the end of a scroll, the last content line sits under the home indicator. `--app-bottom-inset` is `0px` from
  768px up.
- Toasts (`sm:bottom-4 sm:right-4`), the push prompt (`md:bottom-4 md:right-4`) and the update toast (`px-4`) sit under
  the home indicator or the right inset.
- The page-help panel (`sm:inset-y-0 sm:right-0`) has no right or bottom inset.
- `xl` dialogs (`min(92vw,56rem)`, about 776px on an 844px wide screen) reach under the notch. `sm:max-h-[90dvh]` lets a
  tall dialog reach under the home indicator.

The owner kept the portrait lock, so landscape only applies to iOS, which ignores the manifest `orientation`. On
Android, landscape is checked in an emulated browser only.

### 3.3 Extra inset gaps above the keyboard and above the tab bar

- **Above the keyboard.** The chat drawer (`pb-[env(bottom)]`), the Dialog sheet (`pb-[env(bottom)]`) and the
  BottomSheet footer and spacer keep the home-indicator inset while the keyboard is open. iOS keeps reporting 34px with
  the keyboard up. Their bottom edge already follows the keyboard (`bottom-[var(--kbd-gap)]`), so the composer in the
  chat drawer floats 34px above the keyboard. AC6 and the GWP-79 constraint forbid that gap.
- **Above the tab bar.** `.sticky-actions` (`index.css:271`) and the `CardNew` sticky bar sit inside the phone's
  scrolling area, which already ends above the tab bar, and the tab bar already pads the home indicator. Their own
  `max(0.75rem, env(bottom))` adds a second 34px gap. Inside a BottomSheet with no footer, the sheet's spacer also pads
  it, so the gap is doubled there too.

### 3.4 Chat composers on pages need no inset of their own

On a phone, the CEO chat, persona chat, discovery and boardroom composers sit in the scrolling area, directly above the
tab bar, and the tab bar fills the home-indicator area. While the keyboard is open, the tab bar is gone and the app
frame ends at the keyboard (GWP-79). Padding these composers by the bottom inset would create exactly the extra gap the
card forbids.

The one composer that touches the home indicator is the one inside the full-screen chat drawer. The drawer pads it
(see 3.3). In landscape (tablet layout), the page composers end about 3.5rem above the bottom (`h-[calc(100dvh-8.5rem)]`
and similar), which is well clear of the 21px landscape home indicator.

### 3.5 Things on the card that are not what the card says

- **There is no `InterestDrawer`.** Interest editing (`pages/InterestDetail.tsx:220`) uses the shared `Dialog` with a
  `footer`, so fixing the Dialog covers it. `MoveToSheet` uses `BottomSheet` with a `footer`, so fixing BottomSheet
  covers it. Neither file needs its own change.
- **`components/Layout.tsx` holds only `RequireAuth`** (its loading and error states). It has no header and needs no
  change.
- **Manifest `theme_color`.** On Android, Chrome uses the page's `theme-color` meta (which has light and dark variants)
  once the page has loaded. The manifest value only shows on the splash screen and before the first paint, so the navy
  `#0D1220` gives a wrong-coloured band at launch.
- **The `theme-color` meta follows the OS colour scheme, not the in-app theme toggle.** This is out of scope (it would
  need script changes), so I filed it as a backlog suggestion.

## 4. Options

| | Option | For | Against |
| --- | --- | --- | --- |
| A | Patch the missing places one by one with more inline `env()` | Smallest diff | Violates AC10 (one definition), and the keyboard gap stays |
| **B** | **One set of `--safe-*` custom properties in `index.css`, including a keyboard-aware bottom value. Replace every inline `env()` with them and add the missing landscape and overlay insets** | Meets AC10. Each new rule is one class. Tests can scan for stray `env()`. Playwright can emulate insets by overriding four variables | Touches about 15 files (all class strings) |
| C | Tailwind `@utility` plugins (`pt-safe`, `pr-safe-6`, ...) | Shorter class names | Functional `@utility` with `--value()` and `--spacing()` is new in v4 and less readable for this team. B already meets the AC |

**Recommendation: B.** Use plain custom properties and Tailwind v4 arbitrary values (`pt-(--safe-top)`,
`pb-[max(0.75rem,var(--safe-bottom))]`). This follows the codebase's existing `var(--kbd-gap,0px)` style.

## 5. Design

### 5.1 `apps/web/index.html`

Change one line. Keep everything else, including `viewport-fit=cover`, which the landscape side insets and the
home-indicator inset still need.

```html
<meta name="apple-mobile-web-app-status-bar-style" content="default" />
```

### 5.2 `apps/web/public/manifest.webmanifest`

```json
"display": "standalone",
"orientation": "portrait-primary",
"theme_color": "#f5f6f8",
"background_color": "#f5f6f8",
```

Both colours become the light canvas (`--canvas`, and the light `theme-color` meta), so the splash screen, the status
bar before first paint and the shell match. After the first paint, Android re-tints from the `theme-color` meta for each
colour scheme. Keep `display` and the portrait lock (owner decision). Trade-off: a user with a dark OS sees a light
splash for a moment. A single manifest colour cannot follow the colour scheme.

### 5.3 `apps/web/src/index.css`: the one shared definition

Put this near the existing `--app-bottom-inset` block, and replace that block's own `:root` and `--app-tabbar-h`
lines:

```css
/* Device safe areas (notch, status bar, rounded corners, home indicator / gesture bar). The only place env() is read:
   components use these variables, never env() directly. 0px wherever the browser reports no inset (desktop, a normal
   browser tab), so nothing moves there. --safe-bottom-kbd is the bottom inset for surfaces whose bottom follows the
   on-screen keyboard: it drops to 0 while the keyboard is open (html[data-kbd], lib/viewport.ts), so they sit directly
   on the keyboard. */
:root {
  --safe-top: env(safe-area-inset-top, 0px);
  --safe-right: env(safe-area-inset-right, 0px);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
  --safe-left: env(safe-area-inset-left, 0px);
  --safe-x: max(var(--safe-left), var(--safe-right));
  --safe-y: max(var(--safe-top), var(--safe-bottom));
  --safe-bottom-kbd: var(--safe-bottom);
  /* From md up (sidebar layout, phones in landscape) fixed things only need to clear the home indicator. */
  --app-bottom-inset: var(--safe-bottom);
}
:root[data-kbd] {
  --safe-bottom-kbd: 0px;
}
@media (max-width: 767.98px) {
  :root {
    --app-tabbar-h: calc(3.5rem + var(--safe-bottom));
    --app-bottom-inset: calc(var(--kbd-gap, 0px) + var(--app-tabbar-h));
  }
  /* keep :root[data-kbd] { --app-tabbar-h: 0px }, data-app-frame and .kbd-hide exactly as they are */
}
```

`.sticky-actions` (index.css:266-274): change the padding to `0.75rem 1rem`. This bar only exists below 768px and always
sits inside the phone's scrolling area or a sheet body. Both already end above the tab bar, the sheet spacer or the
keyboard, so it must not add the inset again (3.3).

At desktop width `--app-bottom-inset` stays `0px` (the inset is 0 there), so the tablet content padding and
`UpdateToast` do not move.

### 5.4 Replace every inline `env(safe-area-inset-*)`

Rule: `env(safe-area-inset-X)` becomes `var(--safe-X)`. Where the surface's bottom follows the keyboard, use
`var(--safe-bottom-kbd)`. After this change, `grep -rn "env(safe-area-inset" apps/web/src` must only match the four
definition lines in `index.css`.

| File | Change |
| --- | --- |
| `components/shell/AppShell.tsx:283` aside (tablet) | add `pt-(--safe-top) pl-(--safe-left)` |
| `AppShell.tsx:280` `--sidebar-w` | `collapsed ? 'calc(4rem + var(--safe-left))' : 'calc(16rem + var(--safe-left))'`, so the rail keeps its 4rem of content next to the notch |
| `AppShell.tsx:306` tablet header | `h-14` becomes `min-h-14 pt-(--safe-top)`. Add `pr-[calc(1.5rem+var(--safe-right))] lg:pr-[calc(2rem+var(--safe-right))]` (keep `px-6 lg:px-8` before them, so `pr` wins) |
| `AppShell.tsx:359` mobile top bar | `pr-2` becomes `pr-[max(0.5rem,var(--safe-right))]`, `pl-[max(0.5rem,var(--safe-left))]`, `pt-(--safe-top)`. Keep `data-testid="mobile-topbar"` |
| `AppShell.tsx:410` tablet content | after `sm:px-6`, add `sm:pr-[calc(1.5rem+var(--safe-right))]`. After `lg:px-8`, add `lg:pr-[calc(2rem+var(--safe-right))]`. The bottom padding already uses `--app-bottom-inset`, which now clears the home indicator in landscape |
| `AppShell.tsx:442` More menu | `pt-(--safe-top) pr-(--safe-right) pl-(--safe-left)` |
| `components/shell/MobileTabBar.tsx:107` | `pb-(--safe-bottom) pl-(--safe-left) pr-(--safe-right)`. Its `bg-surface/95` already fills the home-indicator area. It still returns `null` while the keyboard is open |
| `components/shell/Sidebar.tsx:183` | `pb-[max(0.75rem,var(--safe-bottom))]` |
| `components/ui.tsx:434` Dialog | phone: `max-sm:pb-(--safe-bottom-kbd) max-sm:pl-(--safe-left) max-sm:pr-(--safe-right)`. Height: `max-h-[calc((var(--vvh,100dvh)-var(--safe-top))*0.92)]`. Centred (`sm:`): `sm:max-h-[calc(90dvh-2*var(--safe-y))]` and `sm:max-w-[calc(100vw-2*var(--safe-x)-1rem)]`, so an `xl` dialog keeps clear of a landscape notch |
| `components/ui/BottomSheet.tsx:65-70` | `size="full"` top: `top-[calc(var(--vv-top,0px)+var(--safe-top))]`. Phone sides: `max-md:pl-(--safe-left) max-md:pr-(--safe-right)`. Centred (`md:`): `md:max-h-[calc(90dvh-2*var(--safe-y))] md:max-w-[calc(100vw-2*var(--safe-x)-1rem)]` |
| `BottomSheet.tsx:104` footer | `pb-[max(0.75rem,var(--safe-bottom-kbd))]` |
| `BottomSheet.tsx:108` spacer | `h-(--safe-bottom-kbd)` |
| `components/ChatDrawer.tsx:94` | `pt-(--safe-top) pr-(--safe-right) pb-(--safe-bottom-kbd) pl-(--safe-left)`. Keep `max-md:top-[var(--vv-top,0px)]`, `max-md:bottom-[var(--kbd-gap,0px)]` and `md:inset-y-0`, which `chat-drawer.test.tsx:182-184` asserts. The composer inside now sits directly on the keyboard |
| `components/ui/Toast.tsx:66` | phone `top-[calc(var(--safe-top)+4rem)]`. From `sm`: `sm:right-[calc(1rem+var(--safe-right))] sm:bottom-[calc(var(--app-bottom-inset,0px)+1rem)]`, replacing `sm:right-4 sm:bottom-4` |
| `components/pwa/UpdateToast.tsx:12` | `px-4` becomes `pl-[calc(1rem+var(--safe-left))] pr-[calc(1rem+var(--safe-right))]`. The bottom is unchanged (it uses `--app-bottom-inset`) |
| `components/push/PushPrompt.tsx:80` | `inset-x-3` becomes `left-[calc(0.75rem+var(--safe-left))] right-[calc(0.75rem+var(--safe-right))]`. `md:right-4 md:bottom-4` becomes `md:right-[calc(1rem+var(--safe-right))] md:bottom-[calc(var(--app-bottom-inset,0px)+1rem)]`. Keep `md:inset-x-auto`, or use `md:left-auto` |
| `components/help/PageHelpPanel.tsx:32` | phone `max-sm:pb-(--safe-bottom)`. Side drawer: `sm:pt-(--safe-top) sm:pr-(--safe-right) sm:pb-(--safe-bottom)` |
| `components/palette/CommandPalette.tsx:354` | `max-sm:pt-(--safe-top)` |
| `components/PinnedScreen.tsx:32` | `pr-[max(1rem,var(--safe-right))] pl-[max(1rem,var(--safe-left))]` |
| `pages/CardNew.tsx:370` | `pb-[max(0.75rem,env(...))]` becomes `pb-3 md:pb-[max(0.75rem,var(--safe-bottom))]`. On a phone the bar is in the scrolling area above the tab bar. From md up it sticks to the window's bottom edge |
| `pages/Desk.tsx:230` sticky toolbar | `top-14` becomes `top-[calc(3.5rem+var(--safe-top))]` (keep `max-md:top-0`), so it stays under the taller tablet header |
| `components/auth/AuthFrame.tsx:17,39` | `pt-[max(1.5rem,var(--safe-top))]` and `pb-[max(2rem,var(--safe-bottom))]` |

**Unchanged on purpose:** `chat/Composer.tsx` and its hosts (`ChatPanel.tsx`, `PersonaChat.tsx`, `DiscoverySession.tsx`,
`BoardComposer.tsx`, `BoardroomSession.tsx`), see 3.4. Also unchanged: `lib/viewport.ts` (it already sets
`data-kbd`), `InterestDetail.tsx`, `MoveToSheet.tsx`, `components/Layout.tsx`, the service worker, push logic and
update-toast behaviour.

Tailwind note: `pt-(--safe-top)` is the v4 shorthand for `pt-[var(--safe-top)]`. Inside arbitrary values, write
`calc()`/`max()` with no spaces, as the codebase already does.

### 5.5 Docs: `docs/design/ui/design-system.md` section 4.7

Replace `pb-[env(safe-area-inset-bottom)]` in the Dialog bullet with `pb-(--safe-bottom-kbd)`, and add one bullet:

> **Safe areas.** Insets come only from `--safe-top/right/bottom/left` (plus `--safe-x`, `--safe-y`,
> `--safe-bottom-kbd`) in `index.css`; never write `env(safe-area-inset-*)` in a component. Fixed or full-height
> surfaces pad the edges they touch. A surface whose bottom follows the keyboard uses `--safe-bottom-kbd` (0 while the
> keyboard is open). Anything inside the phone's scrolling area or a sheet body adds no bottom inset: the tab bar, the
> sheet or the keyboard below it already handles it.

### 5.6 Tests (Vitest, unit only)

New file `apps/web/src/test/safe-area.test.tsx` (new files avoid the out-of-scope test flag):

1. **index.html.** Read it with `readFileSync`, as `service-worker.test.ts` does, and parse it with `DOMParser`. Check:
   - the viewport `content` contains `viewport-fit=cover`;
   - `apple-mobile-web-app-capable` is `yes`;
   - `apple-mobile-web-app-status-bar-style` is `default`;
   - `theme-color` has `#f5f6f8` for `(prefers-color-scheme: light)` and `#0b0e14` for dark.
2. **Manifest.** `display: 'standalone'`, `orientation: 'portrait-primary'`, `theme_color: '#f5f6f8'`,
   `background_color: '#f5f6f8'`. The light value equals the light `theme-color` meta.
3. **One definition.** `index.css` defines `--safe-top/right/bottom/left` with `env(safe-area-inset-*, 0px)`, defines
   `:root[data-kbd]` resetting `--safe-bottom-kbd: 0px`, and contains exactly 4 `env(safe-area-inset` occurrences. A
   scan of every `.ts`, `.tsx` and `.css` file under `apps/web/src` (use `fs.readdirSync` recursively, skip `test/`)
   finds no other `env(safe-area-inset`.
4. **Classes on mounted components.** Mount them the way `mobile-shell.test.tsx` does, with `matchMedia` stubbed to
   phone or tablet width:
   - mobile top bar: `pt-(--safe-top)` and `pr-[max(0.5rem,var(--safe-right))]`;
   - tablet header: `pt-(--safe-top)` and `pr-[calc(1.5rem+var(--safe-right))]`;
   - tab bar: `pb-(--safe-bottom)`;
   - BottomSheet with a footer: footer `pb-[max(0.75rem,var(--safe-bottom-kbd))]`;
   - Dialog: `max-sm:pb-(--safe-bottom-kbd)`;
   - ChatDrawer content: `pb-(--safe-bottom-kbd)`;
   - toast container: `top-[calc(var(--safe-top)+4rem)]`;
   - push prompt: `md:bottom-[calc(var(--app-bottom-inset,0px)+1rem)]`;
   - update toast: `pr-[calc(1rem+var(--safe-right))]`.
5. **Composer has no own inset (guards the keyboard gap).** In the chat drawer the composer is inside the element that
   carries `pb-(--safe-bottom-kbd)`. On a page (`PinnedScreen`) no ancestor of the composer up to `app-scroll` has a
   `--safe-bottom` class.

Existing test to update: `apps/web/src/test/mobile-shell.test.tsx:275` should expect `pb-(--safe-bottom)` instead of
`pb-[env(safe-area-inset-bottom)]`. This path is listed in the card's affected areas. Do not change any other existing
test file. If one has to change, name its full path in the handoff so the affected areas can be updated before review.
I checked the other class assertions (`chat-drawer.test.tsx:182-184`, `mobile-board.test.tsx:227`,
`mobile-shell.test.tsx:246`, `pinned-screen.test.tsx:31`): they keep passing with this design.

Run the whole `apps/web` suite: `pnpm --filter ./apps/web test`, or `vitest run` in `apps/web`, under a `timeout`.

**For testers (e2e, not the builder):** because every component reads the variables, a Playwright check can emulate a
device with
`page.addStyleTag({ content: ':root{--safe-top:47px;--safe-bottom:34px;--safe-left:0px;--safe-right:0px}' })` (in
landscape, `0 / 21px / 47px / 47px`) and compare against insets `0`.

## 6. Risks

- **iOS status bar colour versus the in-app theme.** With `default`, the bar follows the iOS appearance. A user who
  forces the dark in-app theme on a light iPhone gets a light bar above a dark header. The text is still readable
  (owner-accepted). The follow-up is in the backlog.
- **The WebKit top-inset bug may still matter on iPad** if a future change goes back to `black-translucent`. The design
  doc rule and `--safe-top` keep a single place to add a fallback floor.
- **Sidebar width change.** `--sidebar-w` grows by the left inset only when there is one (0 on desktop). Check the
  collapse animation and the guided tour highlight on an emulated landscape iPhone.
- **Tailwind ordering.** `pr-[...]` must come after `px-*` within the same variant (`sm:`, `lg:`), or `px` wins. The
  class assertions in the tests will catch a missing class but not ordering, so check it once in the emulated
  landscape view.
- **Removing the double gap on `.sticky-actions` and `CardNew`** makes those bars 34px shorter on notched phones. That
  is intended (they sit above the tab bar), but it is a visible change in the PWA.

## 7. Acceptance criteria to design

| AC | Covered by |
| --- | --- |
| 1. Note of what release/1.6.0 had; PR only adds or fixes what is missing | Section 2. Section 5 changes only status-bar style, manifest colours, missing insets and the duplicated or keyboard gaps |
| 2. iOS portrait: header below status bar, text readable in both themes | 5.1 `default` status bar (the page starts below an opaque system bar, so the WebKit 0-inset bug does not apply). `pt-(--safe-top)` remains for any device that reports a real top inset |
| 3. Tab bar above the home indicator, area filled with bar background | `MobileTabBar` `pb-(--safe-bottom)` on `bg-surface/95`, unchanged behaviour |
| 4. Landscape: header, tab bar, content, sheets and dialogs clear of the notch on both sides | 3.2 and 5.4: sidebar `pl` plus width, tablet header and content `pr`, dialog and sheet `max-w` from `--safe-x`, ChatDrawer, PageHelpPanel. Android landscape is emulated only (portrait lock kept by the owner) |
| 5. Bottom sheet, sheet Dialog, drawer with sticky footer, chat drawer: footer above the home indicator, close button below the status bar | BottomSheet footer and spacer, Dialog `pb`, the interest edit Dialog (there is no InterestDrawer), ChatDrawer `pt`/`pb`. Tops come from the opaque status bar, `--safe-top` and the `--safe-top`-aware max height |
| 6. Composer above the home indicator with the keyboard closed, on the keyboard with it open, GWP-79 unchanged | 3.4: on pages the tab bar sits under the composer. In the chat drawer `pb-(--safe-bottom-kbd)` is 0 while `data-kbd` is set. `lib/viewport.ts` is untouched |
| 7. Toasts, update toast and push prompt inside the safe area | Toast top and bottom-right, UpdateToast sides, PushPrompt sides and `md:` bottom, `--app-bottom-inset` = `--safe-bottom` from md up |
| 8. Android installed PWA (punch hole, gesture nav) | Same variables. Chrome reports the gesture-bar inset with `viewport-fit=cover`. The status bar is not overlaid in standalone, so the top inset is 0 |
| 9. No change on desktop or in a normal tab | Every variable falls back to `0px`, and `--app-bottom-inset` is `0px` on desktop. Every `max(Xrem, 0px)` and `calc(Xrem + 0px)` equals the old value |
| 10. One shared definition | 5.3, plus test 3 (no `env()` outside `index.css`) |
| 11. Existing tests pass, new tests cover meta, manifest and classes | 5.6 |
