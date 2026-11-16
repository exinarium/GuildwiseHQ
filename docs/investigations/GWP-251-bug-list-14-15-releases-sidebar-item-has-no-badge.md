# GWP-251: Releases sidebar badge and Release prep tab count

## Question

The Releases item in the web sidebar has no count badge. A release waiting for a decision only shows once the
user opens the Releases page. The Release prep tab also has no count of open Ship release items. What should
the badge count, where does the count come from, and how do we keep it in step with the Release queue panel
and the Desk?

## Findings

### What exists today

| Piece | Where | Behaviour |
|---|---|---|
| Desk badge | `apps/web/src/components/shell/Sidebar.tsx` `DeskPill` (line 16), rendered in `Item` only when `entry.id === 'desk'` (line 67) | `counts.open` from `useDesk()`. Accent fill, or `bg-danger-solid` when something is blocking. Uses `absolute -top-1.5 -right-1.5` when collapsed. **No 99+ cap** in the sidebar (the mobile tab bar `Badge` has one). `data-testid="desk-badge"`. |
| Where counts come from | `apps/web/src/components/shell/AppShell.tsx` line 106 `useDesk()`, line 127 `counts`, passed to `SidebarBody` (desktop line 293, phone drawer line 457) and `MobileTabBar` (line 431) | `useDesk()` is called **without a projectId**, so the query key is `['desk','all','open']`. The Desk badge is **organization-wide**: the active organization, across every project the user can see. It does not change when the user switches project. |
| Desk list on the server | `apps/server/src/queries/desk.ts` `listDesk` | Already filtered by `DESK_VISIBLE`: items of projects the user is an active member of, plus org-level items for Owners/Admins. Open list = `status='open' AND routed_to='manager'`, plus resolved CEO decisions not yet reviewed (those have `status <> 'open'`). |
| Ship release item | created in `apps/server/src/release/reconcile.ts` line 117 | `kind: 'approval'`, `subkind: 'ship_release'`, `projectId: repo.project_id` (project-scoped, so every active project member sees it on the Desk). It is shown by `Desk.tsx` line 639 (`item.kind === 'approval' && item.subkind === 'ship_release'`). |
| Release queue | `GET /api/delivery/queue`, `requireOrg(..., { min: 'admin' })`; `apps/server/src/delivery/queries.ts` `releaseQueue(ctx, orgId)` | **Organization-wide** (the active org, every project). Runs with `status='waiting_release'`, grouped by (project, env, commit). Each group is one row in the panel. |
| Release queue in the web app | `apps/web/src/api/queries/delivery.ts` `useReleaseQueue(enabled)` (key `['delivery-queue']`, `refetchInterval: 15_000`) | Used by `Releases.tsx` (`useReleaseQueue(manage)`, where the "Waiting for you" tab badge is `queue.data.length`) and by `ReleaseQueue.tsx` (the panel lists `queue.data`). |
| Invalidation | `useQueueMutation` (release / cancel) invalidates `['delivery-queue']`, runs, `['delivery']` and `['desk']`. `useDeskAction` (resolve / answer / dismiss) invalidates `['desk']`. `ws/invalidate.ts`: every `desk-*` and `releasedocs-*` event invalidates `['desk']`. | Deploy runs have no websocket stream, which is why the queue polls every 15 s. `releases.ts:189` and `environments.ts:290` also invalidate the queue key. |
| Releases page | `apps/web/src/pages/Releases.tsx` | Says "across projects". The tabs use `Badge tone="brand"` through the `badge` prop of `Tabs`. The `prep` tab only exists when `useReleaseDocsPrepOverview()` returns at least one project. |
| Mobile | `MobileTabBar.tsx` | Releases is **not** a tab. The phone's "More" menu is the same `SidebarBody` (AppShell line 457) with the same `counts`, so a Releases pill in `SidebarBody` shows there automatically. The Desk count also shows in that menu through `DeskPill`. |
| Org switch | `useSwitchOrg` in `api/queries/auth.ts` | Runs `qc.clear()`, so both counts refetch for the new organization. |

### The scope question raised in planning

The planning note worried that the queue is org-scoped while the Desk takes a projectId. In the shell, though,
**the Desk badge does not pass a projectId**: it is org-wide too. The Releases page is also explicitly
"across projects", and its queue panel is org-wide. Requirement 2 says to follow the Desk badge's scope. So
there is no mismatch: **the Releases badge is org-wide (the active organization)**, the same as the Desk badge,
the Release queue panel and the Desk page's list.

How this fits AC 6 ("Switching project updates both to that project's numbers"): no count in the shell or on the
Releases page is project-scoped today. Switching project leaves the Desk badge, the Release queue panel and the
Desk list as they are, so the Releases badge and the prep tab count stay as they are as well. That is how they
"match the Release queue panel and the Desk for the same scope". Switching **organization** clears the cache and
updates every count to that organization's numbers. If the badge were project-scoped, it would disagree with the
Releases page it links to, which would break the first half of AC 6. Testers should check AC 6 with an
organization switch, and check that a project switch leaves the badge and the Desk badge unchanged together.

## Options

### Source of the count

| Option | For | Against |
|---|---|---|
| **A. Reuse the cached queries** (`useReleaseQueue` + `useDesk`) in the shell, with one shared counting helper | One source of truth by construction: the badge reads the **same cache entries** (`['delivery-queue']`, `['desk','all','open']`) that the queue panel, the Releases tab badge and the Desk read. Every existing invalidation (release, cancel, resolve, websocket desk events, org switch) already reaches it, with no new code. No server change, no overlap with GWP-257's `apps/server/src/delivery/*`. `useDesk()` is already mounted in the shell, so the Ship release half costs nothing extra. | The shell now mounts `useReleaseQueue` for Owners/Admins, so its existing 15 s poll runs on every page, not only on Releases. That is acceptable: when nothing is waiting the endpoint is a single indexed SELECT, TanStack does not poll in a background tab (`refetchIntervalInBackground` defaults to false), and it is the existing loop, not a new one. |
| B. New `GET /api/delivery/queue/count` or a `counts.releases` field on the desk response | Light payload. | Adds a second definition of "waiting" on the server (a COUNT next to the grouping in `releaseQueue`), and it can drift from the panel's grouped rows. It would need its own polling (deploy runs have no websocket events) or would have to ride on the desk poll, and that would miss queue changes. It touches `apps/server/src/delivery` while GWP-257 is open there. |

**Choice: A.** The constraint "do not fetch the full release queue on every page if that is heavy" does not
apply: the queue holds only the rows waiting right now (usually 0 to a few), and the cost scales with that.

### How the sidebar carries the count

| Option | For | Against |
|---|---|---|
| **A. Widen the shell's `counts` prop** with an optional `releases` number and render a Releases pill in `Item` for `entry.id === 'releases'`, next to the existing Desk special case | `nav-config.ts` does not change at all (CommandPalette, videos and the business-mode/term tests depend on it). Same pattern as the Desk. The phone menu gets it for free. | A second id special case in `Item`. |
| B. Add `count` to `NavEntry` and have `buildNav` take counts | More generic. | Changes `buildNav`'s inputs and the shape that CommandPalette and the tests consume. More change than this card needs. |

**Choice: A**, with the pill markup pulled out into one `CountPill` so the Desk and Releases pills cannot
drift apart in style.

## Recommendation and design

### 1. One definition: `apps/web/src/lib/releaseCounts.ts` (new)

```ts
import type { DeskItemDto, ReleaseQueueItem } from '@aom/shared';

/** A Ship release desk item (the release proposal the Owner approves). */
export const isShipReleaseItem = (i: Pick<DeskItemDto, 'kind' | 'subkind'>): boolean =>
  i.kind === 'approval' && i.subkind === 'ship_release';

/** ...that is still open. The open desk list also carries resolved CEO decisions; they do not count. */
export const isOpenShipRelease = (i: Pick<DeskItemDto, 'kind' | 'subkind' | 'status'>): boolean =>
  isShipReleaseItem(i) && i.status === 'open';

export const countOpenShipReleases = (items: readonly DeskItemDto[] | undefined): number =>
  (items ?? []).filter(isOpenShipRelease).length;

/** One per row of the Release queue panel (a project, environment and commit), the same as its "Waiting for you" tab badge. */
export const countWaitingReleases = (queue: readonly ReleaseQueueItem[] | undefined): number =>
  queue?.length ?? 0;
```

- Change `Desk.tsx` line 639 to use `isShipReleaseItem(item)`, so the Desk, the badge and the tab count share
  one predicate. This changes no behaviour.
- Change `Releases.tsx` `waiting` to `countWaitingReleases(queue.data)`. This changes no behaviour.

### 2. The hook: `useReleaseBadgeCounts` (in `apps/web/src/api/queries/delivery.ts`, or next to the helper)

```ts
export function useReleaseBadgeCounts(enabled = true) {
  const manage = useCanManageOrg();
  const queue = useReleaseQueue(enabled && manage);   // members: no request at all (the endpoint is admin-only)
  const desk = useDesk();                              // same cache entry the shell and the Desk already use
  const waiting = enabled && manage ? countWaitingReleases(queue.data) : 0;
  const ship = enabled ? countOpenShipReleases(desk.data?.items) : 0;
  return { waiting, ship, total: waiting + ship };
}
```

- Permissions (AC 7, requirement 4):
  - **Owner/Admin**: waiting deploys plus Ship release items.
  - **Member**: the queue query is disabled, so no `/api/delivery/queue` request is made (the server would
    return 403). Members only count the Ship release items that the server already returns to them on the
    Desk (`DESK_VISIBLE`, the projects they belong to). That is exactly what they can see on the Desk and on
    the prep tab, which is shown to every role. Nothing leaks.
  - **Business view**: there is no Releases nav entry. Pass `enabled = !isBusinessView(org)`, so no queue
    request is made and the count is 0.
- Hardening: in `useReleaseQueue`'s `queryFn`, use `((await get(...)).items ?? [])`. Existing shell tests answer
  unknown URLs with `{}`, and this keeps the data an array.

### 3. Sidebar: `apps/web/src/components/shell/Sidebar.tsx`

```ts
export interface DeskCounts { open: number; blocking: number }        // unchanged (MobileTabBar uses it)
export interface NavCounts extends DeskCounts { releases?: number }   // SidebarBody / Item take NavCounts

function CountPill({ count, tone, collapsed, testId, title, srSuffix }: {...}) {
  if (count <= 0) return null;                                         // no "0"
  return (
    <span data-testid={testId} title={title} className={cx(
      'tnum inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-semibold',
      tone === 'danger' ? 'bg-danger-solid text-white' : 'bg-accent text-accent-fg',
      collapsed && 'absolute -top-1.5 -right-1.5 h-[18px] min-w-[18px] px-1 text-xs',
    )}>
      {count}{srSuffix && <span className="sr-only">{srSuffix}</span>}
    </span>
  );
}
```

- `DeskPill` becomes a thin wrapper over `CountPill`. Keep its exact output: `data-testid="desk-badge"`, the
  same title, the danger tone when blocking, **no `srSuffix`**, and the number without a cap. The Desk badge must
  not change (AC 9).
- `ReleasesPill`: `CountPill` with `testId="releases-badge"`, tone `accent` (a waiting release is not "blocking";
  if the owner wants red later, it is one prop), `title={`${waiting} waiting to release, ${ship} Ship release`}`,
  and `srSuffix=" waiting"`. The link's accessible name becomes "Releases 3 waiting" in both the expanded and the
  collapsed sidebar (when collapsed, the label is `sr-only` and the pill is absolute, the same as the Desk).
  `SidebarBody` therefore needs the split as well as the total: pass `counts.releases` as `{ waiting, ship }` or
  as two numbers. Keep it optional, so callers that do not pass it render nothing.
- No overflow cap: the sidebar Desk pill has none (AC 4: "same overflow cap if the Desk has one").
- `Item`: `{entry.id === 'releases' && <ReleasesPill ... collapsed={collapsed} />}` next to the Desk line.
- Collapsed tooltip: optionally append the count (`Releases (3 waiting)`). This is nice to have, not required.

### 4. Shell: `apps/web/src/components/shell/AppShell.tsx`

- `const releases = useReleaseBadgeCounts(!isBusinessView(org));`
- `const counts = { open, blocking, releases: { waiting: releases.waiting, ship: releases.ship } }`. This is passed
  as it is today to both `SidebarBody` calls. `MobileTabBar` keeps receiving it; its type is `DeskCounts` and the
  extra field is harmless.
- `setAppBadge(deskOpen)` stays as it is (the PWA app badge and push counts are out of scope).

### 5. Mobile (AC 8)

Releases is not in the tab bar, so the tab bar does not change. The Desk count shows in the phone's "More" menu
through `SidebarBody`, and the Releases pill shows there too with the same count, because it is the same
component and the same `counts`. The drawer's links already have the touch-height classes. Nothing more is
needed.

### 6. Releases page: `apps/web/src/pages/Releases.tsx` (AC 5)

```ts
const desk = useDesk();                                   // cached: the shell already holds ['desk','all','open']
const ship = countOpenShipReleases(desk.data?.items);
const prepEntry = { id: 'prep' as TabKey, label: 'Release prep',
  ...(ship > 0 ? { badge: <Badge tone="brand">{ship}</Badge> } : {}) };
const tabs = prepTab ? [...base, prepEntry] : base;
```

The prep tab still appears only when a project uses release prep. That rule is unchanged, so on a page without
the tab there is no tab count. The sidebar still counts those Ship release items, and they are on the Desk.

### Freshness (AC 3, requirement 2)

| Event | Path that lowers the badge without a reload |
|---|---|
| Release / cancel from the queue | `useQueueMutation.onSuccess` invalidates `['delivery-queue']` and `['desk']`. The shell's observer refetches, so the badge drops at the same moment as the panel row. |
| Ship release resolved on the Desk | `useDeskAction.onSuccess` invalidates `['desk']`, plus the `desk-*` websocket event for other tabs. This is the same path as the Desk badge, so it is equally fast. |
| New waiting deploy / new Ship release | The queue's existing 15 s poll / the `desk-*` websocket event. |
| Org switch | `qc.clear()` |

A group with several servers is one row. Releasing all the chosen servers removes the row (−1). Releasing only
some of them leaves the row in place. The page's own "Waiting for you" badge behaves the same way.

## Acceptance criteria mapping

| AC | Design |
|---|---|
| 2 waiting + 1 Ship release → 3 | `useReleaseBadgeCounts`: `waiting` (queue rows) + `ship` (open `ship_release` desk items) → `ReleasesPill` |
| None → no badge | `CountPill` returns null when `count <= 0` |
| Release/cancel/resolve lowers by 1, no reload | Shared cache keys and existing invalidation (table above) |
| Looks like the Desk badge, expanded and collapsed | Same `CountPill` markup and classes, same placement in `Item`, no cap (the Desk has none) |
| Prep tab count | `Releases.tsx` prep tab `badge` from `countOpenShipReleases` |
| Matches the panel and the Desk; scope switch | Same cache entries and the same helpers. Org-wide like the Desk badge; org switch clears the cache (see "The scope question") |
| No permission → no badge, no failing request | Queue query disabled for non-admins and in business view; Ship release items come only from the server-filtered desk list |
| Mobile | Phone "More" menu = `SidebarBody` with the same counts; Releases is not a tab bar entry |
| Desk badge unchanged | `DeskPill` output identical (testid, title, tone, number); `setAppBadge` untouched |
| vitest, typecheck, lint pass; new tests | See the test plan |

## Test plan for the builder (vitest, apps/web)

1. `src/test/release-counts.test.ts` (new): `isOpenShipRelease` / `countOpenShipReleases`. Counts open
   `approval`/`ship_release` items. Ignores closed ones, a resolved CEO decision with `subkind 'ship_release'`
   and `status 'answered'`, other approval subkinds and other kinds. `countWaitingReleases(undefined) === 0`.
2. `src/test/releases-badge-shell.test.tsx` (new, modelled on `mobile-shell.test.tsx` / `card-back-shell.test.tsx`,
   with a desktop viewport, mounting `AppShell` with a stub page):
   - Owner, queue → 2 rows, desk → 1 open ship_release + 1 other open item (`counts.open: 2`):
     `within(getByTestId('nav-releases')).getByTestId('releases-badge')` reads `3`; `desk-badge` reads `2`;
     the link's accessible name contains "3 waiting".
   - Both empty: no `releases-badge`; the Desk badge behaves as before.
   - Collapsed sidebar (localStorage `-sidebar` = `collapsed`): the badge is present inside the collapsed link.
   - Member with 1 ship_release on the desk: badge `1`; `fetch` was **never** called with `/api/delivery/queue`.
     Member with none: no badge.
   - Business view: no `nav-releases` and no queue request.
   - Invalidation without a remount: render a stub route element with buttons that call
     `useCancelRelease().mutate(runId)` and `useResolveDeskItem().mutate({...})`. Switch the fetch mock to the
     smaller lists, click, and `await` the badge dropping to 2, then to 1. Assert that the shell node is the same
     element (no remount).
3. `src/test/releases.test.tsx` (extend): with a non-empty prep overview and 2 open ship_release items, the tab
   `releases-tab-prep` shows `2`. With 0 there is no badge in the tab. The "Waiting for you" badge is unchanged.
4. `src/test/mobile-shell.test.tsx` (extend): open More. The menu's `nav-releases` shows `releases-badge` with
   the count. `tab-desk-badge` is unchanged and there is no new tab.
5. Re-run unchanged: `delivery.test.tsx`, `desk-ship-release.test.tsx`, `releases-panel.test.tsx`,
   `release-docs-prep.test.tsx`, `card-back-shell.test.tsx`, `business-mode*.test.tsx`,
   `business-terms-walk.test.tsx`. Then `pnpm --filter web typecheck` / lint (biome).

E2E/manual (for testers, on a running instance): put a release in the queue and keep a Ship release item open.
Check the sidebar sum without opening Releases, and the prep tab count. Release and resolve, and check that both
counts drop without a reload. Repeat on a phone (More menu) and as a Member (Ship release count only, no 403
in the network tab).

## Risks

- **15 s queue poll on every page for Owners/Admins.** This is the existing loop, and it pauses in background tabs.
  If it ever proves heavy, the next step is a deploy-run websocket event that invalidates `['delivery-queue']`,
  not a count endpoint.
- **Prep tab hidden when no project uses prep.** The tab count then has nowhere to show. That is intended (no
  change to when the tab exists), but a reviewer may ask about it.
- **Overlap with the Desk badge.** An open Ship release item counts in both the Desk badge and the Releases badge.
  The spec asks for this.
- **Existing tests with a catch-all `{}` response.** The `?? []` in `useReleaseQueue` keeps them green; without it
  the data would be `undefined`, which the helper handles anyway.
- No server change, so no conflict with GWP-257 (`apps/server/src/delivery/*`).

## Files to change

- `apps/web/src/lib/releaseCounts.ts` (new): the predicates and counters
- `apps/web/src/api/queries/delivery.ts`: `useReleaseBadgeCounts`, `items ?? []`
- `apps/web/src/components/shell/Sidebar.tsx`: `NavCounts`, `CountPill`, `ReleasesPill`, the `Item` branch
- `apps/web/src/components/shell/AppShell.tsx`: gather the release counts into `counts`
- `apps/web/src/pages/Releases.tsx`: prep tab badge, `countWaitingReleases`
- `apps/web/src/pages/Desk.tsx`: use `isShipReleaseItem` (no behaviour change)
- Tests as listed above. `nav-config.ts` and `MobileTabBar.tsx`: **no change**.
