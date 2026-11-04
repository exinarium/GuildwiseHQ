# GWP-79: mobile bottom bar scrolls with the content, chat shifts when the keyboard opens

Scope: `apps/web`, phone layout (< 768 px), browser and installed PWA (iOS Safari, Android Chrome). Desktop and
tablet (>= 768 px) must not change.

## 1. Question

Why does the mobile tab bar move with the board content, and why does the whole screen shift in chat when the
keyboard opens? What single viewport approach fixes the shell, the board, the chat page, the chat drawer and the other
conversation views (boardroom, discovery, persona chat, intake)?

## 2. Findings (root cause)

### 2.1 Which element scrolls

On a phone the **document** scrolls. `AppShell.tsx:229` is `min-h-dvh` and `AppShell.tsx:255` is
`flex min-h-dvh flex-col`, `main` (line 338) is an in-flow `flex-1` block, and `html`/`body` (`index.css:162-172`)
have no height or overflow rules. The mobile top bar is `sticky top-0` (line 310) and the tab bar is
`position: fixed; bottom: 0` (`MobileTabBar.tsx:136`). Pages keep clear of the bar with bottom padding
(`pb-[calc(1.25rem+var(--app-bottom-inset))]`, line 340).

### 2.2 No containing-block bug

Checked: the tab bar is rendered at the top level of `Shell` (line 386). Its ancestors are context providers only
(`SetupChecklistProvider`, `TourProvider`, `Tooltip.Provider`, `AskDevOpsProvider`, `ext.AppProviders`). None of them
renders a box with `transform`, `filter`, `backdrop-filter`, `contain` or `will-change`. `MobileBoard.tsx` and
`BoardView.tsx` (mobile branch) contain no such wrapper either: `overflow-hidden` on the accordion sections does not
affect a fixed element outside them. So the bar is not "fixed to the wrong box". The lead from planning is ruled out.

### 2.3 What actually moves the bar: layout viewport and visual viewport drift apart

`position: fixed` positions against the **layout viewport**. What the user sees is the **visual viewport**. While the
document is the scroller, these two separate in three common phone situations:

1. **Keyboard (iOS, and Android Chrome since 108, whose default is `resizes-visual`).** The keyboard only shrinks the
   visual viewport. The layout viewport, `100dvh` and `bottom: 0` keep the full height. To show the focused field the
   browser pans the visual viewport (`visualViewport.offsetTop > 0`) and scrolls the document. Everything anchored to the
   layout viewport, including the sticky header, moves up and out of view. That is the "whole screen shifts" in chat.
2. **After the keyboard closes (iOS, worst in standalone PWAs).** WebKit often leaves the document scrolled past its
   end, or leaves the visual viewport offset, until the next scroll settles. Fixed elements are then drawn at the
   stale layout-viewport position and appear to ride along with the content. The board page has a search field at the
   top (`Board.tsx:332`), so using the board's filter is enough to get into this state. On the board this matches the
   report that the bar "scrolls with the board".
3. **Zoom or sideways overflow.** With a zoom scale above 1 (pinch, or a field below 16 px focused; `index.css:210`
   already prevents the focus zoom), or content wider than the screen, the visual viewport pans inside a larger layout
   viewport, and fixed elements scroll with the page.

All three have the same cause: **the document scrolls, and the fixed chrome is anchored to the layout viewport rather
than the visible one.** I confirmed this from the code (which element scrolls, what every fixed or sticky element is
anchored to, and what the hooks measure). The device-side behaviour is documented WebKit and Chrome behaviour, and
testers must confirm it on real phones (see section 8). Emulation cannot reproduce the keyboard.

### 2.4 Full-height layouts and the keyboard

There is no plain `100vh`/`h-screen` anywhere in `apps/web/src`. The full-height layouts use `dvh`, and `dvh` does
**not** shrink for the keyboard, either on iOS or on Android with `resizes-visual`:

| Place | Mobile height today | Problem with the keyboard |
| --- | --- | --- |
| `PinnedScreen.tsx:34` (Chat, CeoChat) | `fixed`, `top: 3.5rem+safe-top`, `bottom: useViewportBottomGap()` | bottom follows the keyboard, **top does not follow `offsetTop`**, so header and top rows are pushed off-screen when iOS pans |
| `ChatDrawer.tsx:98` | `fixed inset-y-0`, `bottom: gap` | same: top stays at the layout top |
| `BoardroomSession.tsx:324` | in flow, `h-[calc(100dvh-30rem)] min-h-[20rem]` | the document scrolls to the composer, the page and header move |
| `DiscoverySession.tsx:314` | in flow, `h-[calc(100dvh-27rem)] min-h-[20rem]` | same |
| `PersonaChat.tsx:112` | in flow, `h-[calc(100dvh-16rem)] min-h-[20rem]` (no mobile branch) | same |
| `Intake.tsx:164` | `max-md:h-[calc(100dvh-5.5rem-var(--app-bottom-inset))]` | same |
| `BottomSheet.tsx:65-66`, `ui.tsx:477-478` (sheets) | `bottom-0`, `max-h-[90dvh]`/`92dvh` | a field in a sheet ends up under the keyboard |

### 2.5 The keyboard helpers disagree

| Helper | Signal | Threshold | Used by |
| --- | --- | --- | --- |
| `useKeyboardOpen` (`MobileTabBar.tsx:13`) | text field focused **and** `innerHeight - vv.height > 150`; vv `resize` + `focusout` | 150 px | tab bar (returns `null`, sets `html[data-kbd]`) |
| `useViewportBottomGap` | `innerHeight - vv.height - vv.offsetTop > 120`; vv `resize` + `scroll` | 120 px | `PinnedScreen`, `ChatDrawer` |
| `useVisualViewportHeight` | `vv.height` | none | **no consumer** (verified by grep; the last user was removed in 672e6c77) |

The two thresholds and triggers differ. Between 120 and 150 px, or when focus is not on an input, the pinned chat
already sits on the "keyboard" while `--app-bottom-inset` still reserves the tab bar. Neither helper checks
`visualViewport.scale`, so a pinch-zoom reads as a keyboard. `useKeyboardOpen` compares with `window.innerHeight`. That
breaks if the viewport is ever switched to `interactive-widget=resizes-content`, because `innerHeight` then shrinks too.

### 2.6 Other findings

- `index.html:6` has `viewport-fit=cover` and no `interactive-widget`. The manifest is `display: standalone` with
  `black-translucent` status bar, so `env(safe-area-inset-top)` matters in the PWA.
- `Desk.tsx:228` sticky toolbar uses `top-14`. In the PWA the header is `3.5rem + safe-area-inset-top`, so it already
  slides under the header by the notch height.
- Sticky bottom bars inside pages float above the fixed bar with `bottom: var(--app-bottom-inset)`: `.sticky-actions-page`
  (`index.css:278`), `CardNew.tsx:370`, `MoveWizard.tsx:279`, `ConnectServer.tsx:364,592`.
- Fixed floating elements clear the bar with `--app-bottom-inset`: Board FAB (`Board.tsx:452`), `UpdateToast.tsx:12`,
  `PushPrompt.tsx:80`. `Backlog.tsx:462` is a fixed bulk bar at `bottom-0 z-40` over the tab bar (intended, leave it).
- Window-scroll dependants: only `AppShell.tsx:163` (`window.scrollTo(0,0)` on route change) and `lib/screenshot.ts`
  (`window.scrollX/Y`, harmless). All other code uses `scrollIntoView`, which works in any scroll container.
- `useStickToBottom` already re-pins on `ResizeObserver`, so a list that shrinks for the keyboard stays at the bottom.
- `docs/design/ui/layout-and-navigation.md` section 3.3 is out of date. It still says "No bottom tab bar".

## 3. Options

**A. Keep the document scroller; patch each symptom.** Add `vv.offsetTop` to `PinnedScreen`/`ChatDrawer` tops, give
the conversation pages a visual-viewport height, and scroll the window back to 0 after the keyboard closes. This
doesn't address the drift in 2.3 (items 2 and 3): the bar stays anchored to the layout viewport while the document
scrolls, so the iOS after-keyboard and zoom cases remain. It also relies on `window.scrollTo` hacks, which the card
rules out as the primary fix. Rejected.

**B. `interactive-widget=resizes-content` plus `dvh`.** Chrome and Firefox would resize the layout viewport for the
keyboard, so `dvh` and fixed elements follow it. **Safari ignores it**, so iOS (browser and PWA) keeps every problem.
It also breaks `innerHeight`-based keyboard detection. It is not enough on its own. Rejected as the approach (the
design below works with either setting).

**C. App frame: a fixed shell sized to the visual viewport, with one inner scroller (recommended).** On a phone the
signed-in shell becomes a `position: fixed` flex column whose `top`/`height` follow the visual viewport (CSS
variables written by one viewport store). The header, one scrolling content area and the tab bar are its children. The
document itself never scrolls (`html`/`body` locked while the frame is mounted).

- The tab bar becomes a flex child under the scroller. It **cannot** scroll with content, and content cannot hide
  behind it (AC1-3 by construction, no padding arithmetic).
- When the keyboard opens, the frame shrinks to the visible area and moves with `offsetTop`. The header stays on top,
  the composer ends on the keyboard and the list keeps scrolling (AC4-6), with no scroll-position writes.
- Address bar, rotation and keyboard close are just visual-viewport resizes. The frame follows them, with a `100dvh`
  fallback before JavaScript runs or without `visualViewport` (AC7-8).
- Desktop and tablet keep the document scroller, untouched (AC9).

Cost: one structural change in `AppShell` and a handful of class changes in consumers. No new dependency. This is the
pattern used by app-like PWAs (a fixed frame plus an inner scroller, sized from `visualViewport`).

## 4. Recommendation

Build option C, with one viewport store replacing the three hooks.

## 5. Design

### 5.1 Viewport store: `apps/web/src/lib/viewport.ts` (new; replaces the three hooks)

A module-level store, started lazily on the first subscriber and stopped on the last. It listens to
`visualViewport` `resize` and `scroll`, `window` `resize`/`orientationchange`, and `document` `focusin`/`focusout`, and
coalesces them with `requestAnimationFrame`. On each update it writes **CSS custom properties on
`document.documentElement.style`** (no React re-render per event) and keeps one boolean `keyboardOpen` for React.

```ts
const KEYBOARD_MIN_PX = 150;               // one threshold for everyone (was 120 and 150)
let baseH = 0, baseW = 0;                  // full height for the current width (rotation resets it)

function measure() {
  const vv = window.visualViewport;
  if (!vv) return clear();                 // no API: CSS falls back to 100dvh / 0px
  if (window.innerWidth !== baseW) { baseW = window.innerWidth; baseH = 0; }
  baseH = Math.max(baseH, window.innerHeight, Math.round(vv.height));
  const zoomed = Math.abs(vv.scale - 1) > 0.01;          // pinch-zoom is not a keyboard
  const h = zoomed ? window.innerHeight : Math.round(vv.height);
  const top = zoomed ? 0 : Math.max(0, Math.round(vv.offsetTop));
  const typing = isTextField(document.activeElement);    // INPUT (text-like types), TEXTAREA, contenteditable
  const kbd = !zoomed && typing && baseH - h > KEYBOARD_MIN_PX;
  const gap = kbd ? Math.max(0, Math.round(window.innerHeight - h - top)) : 0;
  const s = document.documentElement.style;
  s.setProperty('--vvh', `${h}px`);
  s.setProperty('--vv-top', `${top}px`);
  s.setProperty('--kbd-gap', `${gap}px`);
  if (kbd) document.documentElement.dataset.kbd = '1'; else delete document.documentElement.dataset.kbd;
  setKeyboard(kbd);                         // notifies useSyncExternalStore subscribers only on change
}
```

Exports:
- `useViewportSync(enabled: boolean)`: subscribes while enabled. `Shell` calls it with `!isTabletUp`.
- `useKeyboardOpen(): boolean` (`useSyncExternalStore`). Move it here from `MobileTabBar.tsx`. Because
  `MobileTabBar` and tests import it, keep a re-export or update the imports.
- Test helpers are not needed: tests drive a fake `window.visualViewport` (an `EventTarget` with `height`, `offsetTop`,
  `scale`) and `window.innerHeight`.

`baseH` uses the largest height seen, not `innerHeight` alone, so detection still works if the viewport ever resizes
the layout viewport for the keyboard (Android `resizes-content`, Firefox). Do **not** add `interactive-widget` to
`index.html`: Chrome's default (`resizes-visual`) behaves like iOS, so both platforms take the same code path.

Delete `hooks/useViewportBottomGap.ts` and `hooks/useVisualViewportHeight.ts`. Their only users are `PinnedScreen`
and `ChatDrawer`, which change below. Remove the `data-kbd` effect from `MobileTabBar` (the store owns it).

### 5.2 CSS variables: `apps/web/src/index.css` (replace the block at 291-304)

```css
:root { --app-bottom-inset: 0px; }
@media (max-width: 767.98px) {
  :root {
    --app-tabbar-h: calc(3.5rem + env(safe-area-inset-bottom, 0px));
    /* For position:fixed things (FAB, toasts, prompts): clear the tab bar, or the keyboard while it is open. */
    --app-bottom-inset: calc(var(--kbd-gap, 0px) + var(--app-tabbar-h));
  }
  :root[data-kbd] { --app-tabbar-h: 0px; }

  /* The signed-in shell owns scrolling on a phone: the page itself never scrolls or rubber-bands. */
  :root[data-app-frame], :root[data-app-frame] body {
    height: 100%;
    overflow: hidden;
    overscroll-behavior: none;
  }
  /* While typing, page chrome above a conversation steps aside (never the block that holds the focus). */
  :root[data-kbd] .kbd-hide:not(:focus-within) { display: none; }
}
```

The lock is scoped to `html[data-app-frame]`, which `Shell` sets while the mobile frame is mounted. The public site,
blog, sign-in screens, public forms (GWP-65/67/68 area) and the platform shell keep normal document scrolling.

Sticky bars **inside** the scroller no longer need to clear the tab bar, because the scroller ends above it. Change
them to `bottom: 0` on mobile: `.sticky-actions-page` (drop the rule or set `bottom: 0`), `CardNew.tsx:370`
(`max-md:bottom-0`), `MoveWizard.tsx:279`, `ConnectServer.tsx:364,592` (`bottom-0`). The fixed users (`Board.tsx:452`
FAB, `UpdateToast`, `PushPrompt`) keep `var(--app-bottom-inset)`. They now also clear the keyboard for free.
`Desk.tsx:228`: `top-14` becomes `max-md:top-0 md:top-14` (sticky inside the scroller, under nothing).

### 5.3 Shell: `apps/web/src/components/shell/AppShell.tsx`

Only when `!isTabletUp`. Build the class strings in JavaScript with `cx(...)` so the desktop DOM stays exactly as it
is today and tests can assert both cases.

```
<div data-testid="app-frame"   root (line 229), mobile:
     className="fixed inset-x-0 top-[var(--vv-top,0px)] h-[var(--vvh,100dvh)] flex flex-col overflow-hidden">
  <div content column (line 255), mobile: "flex min-h-0 min-w-0 flex-1 flex-col">
    <header mobile-topbar>          drop `sticky top-0`, add `shrink-0` (stays at the top of the frame)
    <main id="main" ...>            mobile: "relative flex min-h-0 flex-1 flex-col"  (positioned, NOT the scroller)
      <div data-testid="app-scroll" ref={scroller}
           className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain">   (static position)
        OrgBanner
        <div className="px-4 py-5 sm:px-6 ...">   mobile padding: plain pb-5, no --app-bottom-inset
          <Outlet/>
    <MobileTabBar .../>             moved here: last flex child of the column, shrink-0
```

- `MobileTabBar` `nav`: replace `fixed inset-x-0 bottom-0` with `relative shrink-0` (keep `z-40`, borders,
  safe-area paddings and `md:hidden`). Keep the "returns null while `useKeyboardOpen()`" behaviour. The centre
  button's `-top-4` circle overlaps the scroller's last pixels, which is fine because the content has `pb-5`.
- `useEffect`: while mobile, set `document.documentElement.dataset.appFrame = ''` and remove it on unmount or when
  switching to tablet. Call `useViewportSync(!isTabletUp)`.
- Route change (line 156): also reset `scroller.current.scrollTop = 0` (keep `window.scrollTo` for desktop).
- `main` keeps `id`, `ref` and `tabIndex={-1}`. "Skip to content" still works.
- Publish the content height for conversation pages. A `ResizeObserver` on `app-scroll` writes
  `--app-content-h: <clientHeight>px` on that element's style (the CSS var is inherited by its descendants). This
  avoids hard-coding header heights, banners or safe areas.

Overflow: `overflow-x-hidden` on the scroller stops sideways panning. The e2e helpers in `e2e/tests/mobile.spec.ts:74,264`
and `mobile-board.spec.ts:19` measure `document.documentElement.scrollWidth`, which then always passes. The testers
must update them to also check `[data-testid="app-scroll"]` `scrollWidth <= clientWidth` (testers own e2e: ledger
87780c46).

### 5.4 Pinned chat screens: `apps/web/src/components/PinnedScreen.tsx`

The mobile branch becomes `absolute inset-0 flex flex-col overflow-hidden bg-canvas pt-3 px-[max(1rem,env(...))]`,
with no inline `bottom` and no hook. Its containing block is `main` (positioned), which lies outside the static
scroller. So it fills exactly the area between the header and the tab bar (or the keyboard) and never scrolls. The
desktop branch is unchanged. `Chat.tsx` and `CeoChat.tsx` need no change.

### 5.5 Chat drawer: `apps/web/src/components/ChatDrawer.tsx`

Remove `useViewportBottomGap` and the inline style. On mobile only (`max-md:`), use
`max-md:top-[var(--vv-top,0px)] max-md:bottom-[var(--kbd-gap,0px)]` instead of `inset-y-0`. The drawer then spans
exactly the visible viewport. Its header stays visible and the composer sits on the keyboard. `sm:` and `md:` widths
stay as they are.

### 5.6 Other conversation views (boardroom, discovery, persona chat, intake)

These keep their page layout (no redesign). On mobile:
- The conversation box height becomes `max-md:h-[calc(var(--app-content-h,100dvh)-2.5rem)]` (content area minus
  `py-5`) with `max-md:min-h-0`:
  - `BoardroomSession.tsx:324`: replaces `h-[calc(100dvh-30rem)] min-h-[20rem]`.
  - `DiscoverySession.tsx:314`: replaces `h-[calc(100dvh-27rem)] min-h-[20rem]`.
  - `PersonaChat.tsx:112`: `max-md:` override, desktop class stays.
  - `Intake.tsx:164`: replaces the `max-md:h-[...]`.
- Everything above the conversation gets `kbd-hide`: the `PageHeader`, the meters/cast block (`BoardroomSession.tsx:283`,
  `DiscoverySession.tsx:283`), the `Tabs`, PersonaChat's callouts and `LimitsForm`, Intake's callout and the
  "Cards from this intake" aside. While the keyboard is open, the conversation is the only content and is exactly the
  content height. The scroller has nothing to scroll, so the shell header stays, the composer sits on the keyboard and
  the list scrolls (`useStickToBottom` re-pins via its `ResizeObserver`). Because of `:not(:focus-within)`, a field
  inside a hidden block (PersonaChat limits) stays visible while it is being typed into.
- When the keyboard closes, the blocks come back. Restore the scroller's `scrollTop` from before the keyboard opened
  (saved on `focusin` of a text field in `app-scroll`, restored when `keyboardOpen` goes false), so the page doesn't
  jump to the top. This is a small helper in `AppShell` beside the scroller. It is not the fix itself, and it is the
  only scroll write.

Desktop branches of all four pages are unchanged (`kbd-hide` only acts under `max-width: 767.98px` with `data-kbd`).

### 5.7 Sheets: `components/ui/BottomSheet.tsx`, `components/ui.tsx:477` (sheet variant of the dialog)

On the phone only, replace `bottom-0` with `bottom-[var(--kbd-gap,0px)]`. Replace `max-h-[90dvh]`/`92dvh` with
`max-h-[calc(var(--vvh,100dvh)*0.9)]` (and `0.92`). For `size="full"`, use `top-[calc(var(--vv-top,0px)+env(safe-area-inset-top))]`.
The `md:`/`sm:` dialog positioning stays as it is (`md:bottom-auto` already overrides). Fields in Move-to, filters and
other sheets then stay above the keyboard.

### 5.8 Docs

Update `docs/design/ui/layout-and-navigation.md` section 3.3: the bottom tab bar exists, describe the mobile app frame
(fixed to the visual viewport, inner scroller, tab bar as a flex child, `data-kbd`, the CSS variables and when to use
`--app-bottom-inset` (fixed elements) or `bottom: 0` (sticky inside the scroller)). Also fix the note at line 82.

## 6. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Code that assumes the window scrolls on mobile | Only `AppShell` route reset (handled) and `screenshot.ts` (reads 0, fine). `scrollIntoView` works in the inner scroller. The Tour uses viewport rectangles, which is fine. |
| Sticky bars that cleared the tab bar now sit one bar too high | Switched to `bottom: 0` (5.2). The list there is complete (grep of `app-bottom-inset`). |
| Body lock breaks public or other pages | Lock is scoped to `html[data-app-frame]`, set only by the mobile `Shell`. |
| Pinch-zoom shrinks the frame | `scale !== 1` ignores the visual viewport (5.1). |
| iOS still pans on focus for one frame | The frame follows `offsetTop` on the next `scroll`/`resize` frame. There is a brief settle, then the correct state. The final state is what the ACs check. Manual device check required. |
| Address bar no longer auto-collapses in mobile browsers (the document doesn't scroll) | Accepted, as in other app-like PWAs. The installed PWA has no address bar. |
| Android pull-to-refresh disabled by `overscroll-behavior: none` | Accepted. The app is live (websocket) and the PWA has no pull-to-refresh anyway. |
| Overlap with open cards | GWP-65/67/68 touch public pages (outside the shell, not locked). GWP-70/77 touch `e2e/` (folder overlap only). No code dependency, no block needed. |

## 7. Acceptance criteria and design mapping

| AC | Covered by | Test |
| --- | --- | --- |
| Board: tab bar fixed while scrolling | Tab bar is a flex child of the fixed frame; only `app-scroll` scrolls (5.3) | mobile-shell: tab bar is inside `app-frame` after `app-scroll`, not `fixed`; scroller has `overflow-y-auto`; `html[data-app-frame]` set |
| Same on every routed view | The structure is in the shell, so every route inherits it | mobile-shell: render 3+ routes (desk, chats page, card detail) and assert the same structure |
| Last item visible above bar and safe area | Scroller ends above the bar; bar carries the safe-area padding; content `pb-5` | mobile-shell: mobile content wrapper has no `--app-bottom-inset` padding; nav has `pb-[env(safe-area-inset-bottom)]` |
| Chat: focus opens keyboard, no shift, header visible, composer on keyboard | Frame `top/height` follow vv (5.1, 5.3); `PinnedScreen` `absolute inset-0` (5.4) | viewport store tests (vars and `data-kbd`), chat/mobile tests: `chat-screen` has `absolute inset-0` and no inline bottom |
| Tab bar not floating; returns with no gap | Bar hidden under `useKeyboardOpen`; `--app-tabbar-h` 0 under `data-kbd`; resets on close | mobile-shell: fake vv shrink with focused textarea hides `mobile-tabbar`; restore brings it back and clears `data-kbd`/`--kbd-gap` |
| Drawer, boardroom, discovery, persona chat | 5.5, 5.6 | chat-drawer: mobile classes use `--vv-top`/`--kbd-gap`, no inline style; boardroom/discovery/persona: conversation box uses `--app-content-h`, header blocks carry `kbd-hide` |
| Rotation / address bar | Every vv/window resize re-measures; width change resets `baseH` | viewport store: width change resets the baseline, no false keyboard after rotation |
| No plain 100vh; one approach | `--vvh` / `--app-content-h` everywhere on mobile; two hooks deleted | grep in review; store tests |
| Desktop/tablet unchanged | All changes gated on `!isTabletUp` or `max-md:`; desktop branches untouched | mobile-shell at desktop width: no `app-frame` test id, no `data-app-frame`, root classes as before |
| Existing tests pass, new tests cover fixed bar and keyboard | Section 8 | `mobile-shell`, `mobile-board` (FAB class at line 227 unchanged), `mobile`, `chat`, `chat-drawer`, `chat-unread`, `card-back-shell`, `ceo-chat-page` |

## 8. Test plan for the build

Unit/component (vitest, `apps/web`):
- New `src/test/viewport.test.ts`: no `visualViewport` (no vars, no keyboard); focused textarea and `vv.height`
  shrinking by 300 (`--vvh`, `--kbd-gap`, `data-kbd`, `useKeyboardOpen` true); shrink without focus (no keyboard);
  `scale = 2` (ignored); `offsetTop` (`--vv-top`); restore (all cleared); width change resets the baseline; one
  threshold (149 px no, 151 px yes).
- Extend `mobile-shell.test.tsx`, `chat-drawer.test.tsx`, `mobile.test.tsx`/`chat.test.tsx` and the boardroom and
  discovery page tests as in section 7. Run `chat-unread`, `card-back-shell`, `ceo-chat-page`, `mobile-board` for
  regressions.

E2E (testers; builders do not edit `e2e/`): Playwright iPhone 14 and Pixel 7. Check that the tab bar bounding box is
unchanged after scrolling `app-scroll` to the bottom on board, desk, chat and card detail. Check that the last card's
box ends above the tab bar's top. Focus the composer on the chat page and in the drawer, and check
`window.scrollY === 0` and that the header is in view. Update the sideways-scroll helpers to measure `app-scroll`.
Run a desktop smoke check.

Manual (testers, real devices, required): iPhone Safari and home-screen PWA, Android Chrome and installed PWA. Scroll
the board and use its search field, then scroll again (the iOS after-keyboard case). Open chat, the drawer, a boardroom
and a discovery session. Open and close the keyboard several times. Rotate the device and toggle the address bar.
