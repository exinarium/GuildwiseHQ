# Business mode: the organization mode flag and hiding developer surfaces

Design for the first Business mode change of release 1.4.0: an organization-level mode, `dev` (the default) or
`business`, with the developer surfaces hidden in the web app and refused by the server in a business organization.
Every later Business mode change (optional repository step, Knowledge/Rules renames, business card types, rule packs,
business roles) gates on the helper defined here.

## The question

1. Where does the mode live, and how does it reach the server, the `me`/org DTO and the web app without changing
   anything for the organizations that exist today?
2. Where can one guard per action refuse a repository, a builder/reviewer/tester/DevOps hire and a pack added by git
   URL, so that no path around it is left?
3. Which web surfaces belong to "repositories, worktrees, branches, working-branch settings, dev hires, DevOps and
   packs by git URL", and how are they removed (not just disabled), including by direct URL?
4. What blocks a switch to business, and how is the switch recorded?

## Findings

### Organizations today

- Table `organizations` (migration `1310_organizations.sql`, later columns added by `ALTER TABLE ... ADD COLUMN IF NOT
  EXISTS`, for example `2240_blog_topics.sql`). Server row type `OrgRow` in `apps/server/src/auth/org-context.ts`
  (`loadOrg` does `SELECT *`, so a new column shows up in `a.org` everywhere without more queries).
- Event-sourced: `OrganizationCreated` (payload in `packages/shared/src/events/org.ts`) is projected in
  `apps/server/src/projections/orgs.ts`. Org-level settings each have their own event and projector:
  `OrgTwoFactorPolicySet`, `OrgDiagnosticsSharingSet`, `OrgSimulationSet`. Naming pattern: `Org<Thing>Set`.
- `PATCH /api/org` (`apps/server/src/routes/orgs.ts:87`) requires `min: 'admin'` and dispatches per field to
  `renameOrg`, `setRequireTwoFactor` and `setDiagnosticsSharing` in `apps/server/src/commands/orgs.ts`. It answers with
  a fresh `OrgDetailResponse`.
- The `activeOrg` block of `me` and `GET /api/org` comes from `activeOrgDto` in `apps/server/src/orgs/summary.ts`
  (shape `ActiveOrgSchema` in `packages/shared/src/api/orgs.ts`). The web reads it as `useMe().data.activeOrg`
  (`AppShell.tsx:122`).
- Organizations are created in three places in this repository: accepting a `new_org` or `legacy` invitation
  (`commands/invitations.ts:393-424`, where the invitee becomes the Owner and may rename the org on
  `pages/AcceptInvite.tsx`), the CLI `apps/server/scripts/admin-create.ts` (`createdVia: 'cli'`) and the legacy data
  migration. Guildwise Cloud's self-service sign-up (`guildwise-cloud/server/src/billing/signup.ts`) appends its own
  `OrganizationCreated` without a mode. With an optional payload field it keeps building and its orgs are `dev`.
- Every user-acted event of an organization appears in the org's audit export (`governance/audit-export.ts:88-96`:
  `actor_kind = 'user'`, no type allow-list). A new user-acted `OrgModeSet` event therefore shows up in the org's
  event history (Organization settings > Audit) without extra work. Super admins see org settings changes in
  `projections/platform-audit.ts` (see `OrgDiagnosticsSharingSet` at line 443). Add `OrgModeSet` there too.

### Where the guarded actions converge (server)

- **Adding a repository.** Every path builds its event in `repoAddedEvent` (`apps/server/src/commands/projects.ts:602`):
  settings add (`addRepo` → `addRepoIn`), the approved `aom repo create` request (`repo-create.ts:496` → `addRepoIn`)
  and project conversion (`convert.ts:180`). One guard there covers all three. Two related entry points should
  refuse early with the same message: `repoCreateRequestEvents` (`repo-create.ts:287`, so an agent's `aom repo create`
  gets a plain refusal instead of a desk item that fails on approval) and `setReferenceRepos` (`projects.ts:495`,
  when the new list is not empty).
- **Hiring.** Every hire runs `hireAgentIn` (`apps/server/src/commands/agents.ts:305`): the Hire dialog
  (`routes/agents.ts:56`), hire-from-pack (`pack-hire.ts:505`), pack team seats (`pack-team.ts:424`), describe-an-agent
  (`agent-draft.ts:225`) and the CEO's staffing action (`ceo/actions2.ts:528`). The role is known after `loadRole` at
  line 361, and the target organization after line 332 (a guest hires into the project's org). Put the guard right
  after the existing `DEVOPS_ROLE_KEY` / `ceo` checks (line 366-372).
  `canHireAgentInOrg` (`packages/shared/src/authz/index.ts:88`) is the permission check and stays as it is. The mode
  guard is a separate check.
- **The DevOps engineer is not hired by people.** `hireAgentIn` already refuses role `devops` in every organization
  ("DevOps engineers are hired automatically per workstation"). The engineer is created by the system,
  one per organization and workstation (`devopsHireEvent`, `commands/devops.ts:89`, on pairing and on joining an
  org). It cannot be fired (`fireAgent`, `agents.ts:697`), and the server relies on it: it is the commit identity of
  vault sync (`vaults.ts:332`), the target of `devops_request` automations (`schedules.ts:472`), and it resolves
  conflicts and runs environments. See "The built-in DevOps engineer" below.
- **Adding a pack by git URL.** `POST /api/packs` → `addPack` (`apps/server/src/commands/packs.ts:384`) is the only way
  in for a git pack. The other pack sources use other routes and stay: authored packs (`POST /api/my-capabilities`), the
  starter gallery (drafts and playbooks), and update checks of packs that already exist.

### Web surfaces

- The sidebar is data: `buildNav` in `apps/web/src/components/shell/nav-config.ts`, called from `AppShell.tsx:124` and
  `lib/videos.ts:219`. It already drops entries for switched-off org features (`features`), which is the pattern to
  follow. The command palette and the mobile tab bar take their entries from the same sections.
- Routes are a flat list in `apps/web/src/router.tsx`. Nothing guards a route by org property today.
- Project settings (`pages/ProjectSettings.tsx`) already hide most repository panels behind
  `traits.usesRepos` (research-style projects). That flag also hides non-repository panels (Claude account, provider
  accounts, owner approval, manual QA, policy), so business mode needs its own flag, not a change to `usesRepos`.
- DevOps on the Workstations page: `DevOpsPanel` (DevOps access, worktree sweep) and `GitConnectionsPanel`
  (`pages/Workstations.tsx:387-389`). "Ask DevOps": `AskDevOpsProvider` in the shell, the palette action
  (`CommandPalette.tsx:167`), `components/devops/FixWithDevOps.tsx`, Desk and CardDetail.
- Deploy setup: the project Environments page (`/p/:key/environments`, nav entry `environments`), the settings
  sections `environment`/`environments`, and Releases (`/releases`, `/deploys`: the release queue, what is live, deploy
  history, rules). All of these are DevOps deploy surfaces.
- The hire role lists: `HireDialog.tsx:88` (already filters `devops` and `ceo`), and the pack seat pickers
  (`HirePackAgentForm.tsx`, `capabilities/HirePackDialog.tsx`, `HirePackTeamDialog.tsx`), which offer
  `PACK_SEAT_KEYS` (`packages/shared/src/capabilities/pack-team.ts:18`: includes `builder`, `pre_reviewer`,
  `reviewer`, `tester`).
- Packs add-by-URL form: `capabilities/PacksTab.tsx` (`useAddPack`, the URL field at line 234). The rest of the tab
  (existing packs, trust, updates) stays.
- Help: bundled markdown articles in `apps/web/src/help/articles/*.md`, addressed by slug. Dev-only articles:
  `devops-and-hygiene`, `testing-and-finalization`, `project-conversion` (conversion adds repositories).
  `page-help-content.ts` links to slugs.

### The owner's research file

`/home/pieter/guildwise-research/2026-10-27-business-mode-game-plan.md` is not readable from here. **This card does
not need it**: it adds no role names, rule text or playbook text. The only new UI words are the two mode names and
plain refusal messages, given below. The builder should not stop this card for the file. GWP-33 (the business
roles, next in the same group) does need it.

## Options compared

### A. Where the mode lives

| Option | For | Against |
| --- | --- | --- |
| **A1. New column `organizations.mode` + event `OrgModeSet` (chosen)** | Same pattern as two-factor and diagnostics. Replay-safe. Event history for free. The org manager sets it. | One migration, one event. |
| A2. An entry in `features` (`OrgFeaturesSet`) | Nav already hides switched-off features. | `features` are plan/licensing flags a super admin sets (`meta` for the platform audit), merged with plan defaults by `effectiveFeatures`. Mixing in a manager setting confuses both. |
| A3. Derive from the projects' workflows | No new state. | Not an org choice; nothing to switch; cannot be set at creation. |

### B. How the web hides surfaces

| Option | For | Against |
| --- | --- | --- |
| **B1. One hook `useBusinessMode()` + `buildNav({ business })` + a `DevOnly` route wrapper + per-page flags (chosen)** | Surfaces are gone, not disabled; direct URLs land on a clear page; one source (`isBusinessOrg`). | Touches many files (small edits each). |
| B2. Only hide the nav entries | Small. | Fails AC2 (direct URLs, page sections, dialogs). |

### C. The built-in DevOps engineer (asked of the owner, non-blocking)

| Option | For | Against |
| --- | --- | --- |
| **C1. Keep it as hidden plumbing (recommended, designed below)** | Nothing in the engine changes (vault sync, automations, conflicts keep their actor); dev orgs are untouched; the switch stays possible for orgs with a paired workstation. | A business org still has an agent row with `is_devops`. Every view of it is hidden. |
| C2. No engineer in business orgs: skip the auto-hire, retire the engineers on switch, re-hire on switch back | Literal "no DevOps". | Changes the engine for business orgs (vault sync identity, `devops_request` automations); retiring and re-hiring on every switch is new behaviour with replay risk. |
| C3. Literal: the engineer blocks the switch | Literal reading of requirement 5. | Since it cannot be fired, no org with a paired workstation could ever switch. A new business org would also get one on its first pairing. |

The question went to the owner with C1 recommended. If the answer is C2 or C3, only `modeSwitchBlockers` and
`devopsHireEvent` change. The rest of this design stays.

## Recommendation and design

### 1. Shared (`packages/shared`): additive only

New file `packages/shared/src/orgs/mode.ts`, re-exported from `packages/shared/src/orgs/index.ts` (and so from
`@aom/shared`):

```ts
import { z } from 'zod';

/** How an organization works: `dev` (software delivery, the default) or `business` (no repositories or code roles). */
export const ORG_MODES = ['dev', 'business'] as const;
export const OrgModeSchema = z.enum(ORG_MODES);
export type OrgMode = z.infer<typeof OrgModeSchema>;
export const ORG_MODE_LABEL: Record<OrgMode, string> = { dev: 'Developer', business: 'Business' };

/** THE gate for every Business mode difference, web and server. Absent or unknown: dev. Keep this name stable. */
export const isBusinessOrg = (org: { mode?: string | null } | null | undefined): boolean =>
  org?.mode === 'business';

/** Built-in roles that only exist for software delivery: not hired in a business organization. */
export const DEV_ONLY_ROLE_KEYS = ['builder', 'reviewer', 'pre_reviewer', 'tester', 'devops'] as const;
export const isDevOnlyRoleKey = (key: string): boolean => (DEV_ONLY_ROLE_KEYS as readonly string[]).includes(key);
```

- `ActiveOrgSchema` (`api/orgs.ts`): add `mode: OrgModeSchema.default('dev')`, the same pattern as
  `requireTwoFactor`. `OrgDetailResponseSchema` extends it, so the detail gets it too.
- `PatchOrgRequestSchema`: add `mode: OrgModeSchema` inside `.partial()`, and add `v.mode !== undefined` to the
  `refine`, with the message 'name, requireTwoFactor, diagnosticsSharing or mode is required'.
- `AcceptInvitationRequestSchema` and `AcceptExistingInvitationRequestSchema` (`api/invitations.ts`): add
  `mode: OrgModeSchema.optional()` (used only when the invitation starts an organization).
- `events/org.ts`: `OrganizationCreated` payload gets `mode: OrgModeSchema.optional()` (absent = dev). New event
  `defineEvent('OrgModeSet', z.object({ orgId: Id, mode: OrgModeSchema, previous: OrgModeSchema, by: Id }))`, placed
  beside `OrgDiagnosticsSharingSet`. Check how the events registry and the audience map pick it up (follow
  `OrgTwoFactorPolicySet`).
- `authz/index.ts`: `export const canSetOrgMode = isOrgManager;` beside `canRenameOrg`.
- Do not change `CardType`, `ScheduleKind`, delivery or role types. Guildwise Cloud imports `@aom/shared`: every
  change above is a new optional or defaulted field, a new event or a new export.

### 2. Server (`apps/server`)

**Migration** `apps/server/migrations/2750_org_mode.sql` (take the next free number above the newest file when you
build; other 1.4.0 cards add migrations too):

```sql
-- Business mode (release 1.4.0): how an organization works. Every existing organization is 'dev'. Safe to run again.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'dev';
DO $$ BEGIN
  ALTER TABLE organizations ADD CONSTRAINT organizations_mode_check CHECK (mode IN ('dev','business'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
```

No data migration is needed: the default is the migration of the existing orgs.

**Projection** (`projections/orgs.ts`): `OrganizationCreated` inserts `mode` = `p.mode ?? 'dev'` (add the column to the
INSERT list). New projector `OrgModeSet: UPDATE organizations SET mode=$2 WHERE id=$1`. Replay gives the same state.

**Row and DTO**: `OrgRow` gets `mode?: OrgMode` (optional, so Guildwise Cloud's use of `OrgRow` still compiles).
`activeOrgDto` sets `mode: org.mode === 'business' ? 'business' : 'dev'`.

**Creation**: in `acceptInvitation*` (`commands/invitations.ts:393-424`), when the invitation starts an org, put
`...(a.mode === 'business' ? { mode: 'business' } : {})` in the `OrganizationCreated` payload. The invitee becomes
its Owner, so the org manager is the one choosing. The route passes `req.body.mode` through. In
`scripts/admin-create.ts`, add an optional `--mode business` flag. Cloud sign-up is unchanged (dev).

**Guard helper**: new file `apps/server/src/orgs/mode.ts`:

```ts
/** 409 `business_mode` when the organization is in Business mode. `FOR SHARE` serialises with a concurrent switch. */
export async function assertDevMode(db: Queryable, orgId: string, message: string): Promise<void> {
  const o = await one<{ mode: string }>(db, 'SELECT mode FROM organizations WHERE id=$1 FOR SHARE', [orgId]);
  if (isBusinessOrg(o)) throw conflict('business_mode', message);
}
export const BUSINESS_MODE_MSG = {
  repo: 'This organization works in Business mode, which does not use code repositories. An Owner or Admin can switch it to Developer mode in Organization settings.',
  hire: (role: string) => `This organization works in Business mode: ${role} agents are for software delivery and cannot be hired here.`,
  packUrl: 'This organization works in Business mode: packs cannot be added from a git URL. Write your own capability or use the starter gallery instead.',
};
```

Use 409 (a valid request refused because of the org's state, like `project_archived`). The web shows the message as
it is.

**Guards** (each throws before any event is appended):

| Action | Where | Check |
| --- | --- | --- |
| Add a repository (settings, approved `aom repo create`, conversion) | `repoAddedEvent`, top (`projects.ts:602`), using `project.org_id` | `assertDevMode(tx, project.org_id, MSG.repo)` |
| Ask for a new repository (`aom repo create`) | `repoCreateRequestEvents` (`repo-create.ts:287`) | same, so the agent gets the refusal at once |
| Reference repositories | `setReferenceRepos` (`projects.ts:495`) when `repoIds` or `workstationRepos` is non-empty | same (clearing the list stays allowed) |
| Hire builder / reviewer / pre-reviewer / tester / DevOps | `hireAgentIn` after the `ceo` check (`agents.ts:372`), with the resolved `orgId` | `if (isDevOnlyRoleKey(roleDef.definition.key)) await assertDevMode(tx, orgId, MSG.hire(roleDef.definition.name))` |
| Add a pack by git URL | `addPack`, after `requireManager` (`packs.ts:385`) | `assertDevMode(ctx.pool, who.orgId, MSG.packUrl)` |

Pack team seats, hire-from-pack, describe-an-agent and the CEO staffing action are covered by the `hireAgentIn`
guard. In dev orgs every check reads one row and passes, so behaviour is unchanged.

**Switching** `setOrgMode(ctx, a, mode)` in `commands/orgs.ts`, called from the `PATCH /api/org` route when
`req.body.mode !== undefined` (after the existing fields):

```ts
export async function setOrgMode(ctx: Ctx, a: OrgAccess, mode: OrgMode): Promise<void> {
  if (!canSetOrgMode({ orgRole: a.role })) throw forbidden('only the Owner and Admins can change how the organization works');
  await withAppendTx(ctx.pool, async (tx) => {
    const cur = await one<{ mode: OrgMode }>(tx, 'SELECT mode FROM organizations WHERE id=$1 FOR UPDATE', [a.orgId]);
    const previous = cur?.mode ?? 'dev';
    if (previous === mode) return;
    if (mode === 'business') {
      const b = await modeSwitchBlockers(tx, a.orgId);
      if (b.repositories.length || b.agents.length) throw conflict('business_mode_blocked', blockersMessage(b), b);
    }
    await ctx.store.append([{ streamId: streamId.org(a.orgId),
      event: { type: 'OrgModeSet', payload: { orgId: a.orgId, mode, previous, by: a.session.user.id } },
      actor: userActor(a.session.user.id), scope: orgScope(a.orgId) }], { tx });
  });
}
```

`modeSwitchBlockers(tx, orgId)`:

- repositories: `SELECT p.key, r.name FROM project_repos r JOIN projects p ON p.id = r.project_id WHERE p.org_id=$1
  AND r.removed_at IS NULL` (archived projects included: their repositories can still be removed). Check how
  `deleteProject` leaves `project_repos` rows and skip the rows of deleted projects.
- agents: `SELECT name, role_key FROM agents WHERE org_id=$1 AND status <> 'retired' AND NOT is_devops AND role_key =
  ANY($2)` with `DEV_ONLY_ROLE_KEYS` (option C1: the built-in DevOps engineer does not block).
- Message, listing everything, for example: "Business mode needs an organization without code work. Remove these
  first: repository web (project APP), repository api (project APP); let go of Ken (Builder), Linus (Reviewer)."
  `details` carries the two lists so the web can render them as a list.

Switching back to dev has no checks and deletes nothing. The web shows every surface again because all hiding reads
`mode`. Agents and repositories were never removed by the mode itself, so no data is lost.

Platform audit: add `OrgModeSet` to `projections/platform-audit.ts` (summary "Organization mode set to Business for
Acme", `targetUserId: p.by`), following `OrgDiagnosticsSharingSet`.

### 3. Web (`apps/web`)

- `apps/web/src/lib/orgMode.ts`: `export function useBusinessMode(): boolean { return isBusinessOrg(useMe().data?.activeOrg); }`.
  Every gate below uses this hook (or `isBusinessOrg` where `me` is already at hand).
- **Not-available page and route guard**: `components/DevOnly.tsx` with `<DevOnly>{children}</DevOnly>`. In a business
  org it renders an `EmptyState` ("Not available in Business mode. This page is for software delivery. An Owner or
  Admin can switch the organization to Developer mode in Organization settings.", with a link to the board and, for
  managers, to `/settings/org`). Otherwise it renders the children. Wrap these routes in `router.tsx`:
  `/p/:projectKey/environments`, `/releases` (and `/deploys` by its redirect). Wait for `me` (skeleton) before
  deciding, so a dev org never flashes the page.
- **Nav** (`nav-config.ts`): new option `business?: boolean`. When true, leave out `environments` and `releases`.
  Pass `business` from `AppShell.tsx` and `lib/videos.ts`. The palette and mobile bar follow the sections. Remove the
  palette's "Ask DevOps..." action and the shell's Ask DevOps entry points (`AskDevOpsProvider` stays mounted;
  only the triggers go) in a business org.
- **Project settings** (`ProjectSettings.tsx`): `const business = useBusinessMode(); const repoUi = traits.usesRepos &&
  !business;`. Use `repoUi` instead of `traits.usesRepos` for: the section links `repos`, `phase-list`,
  `environments`, `reference-repos`, `merge`; the General fields working branch (the `expert` field too), "How finished
  work lands", PR branch prefix, "Remove finished card branches", architectural globs, E2E globs; the panels Repositories
  (whole section, even with `activeRepos.length > 0`), `commit-as`, `environment`, `environments` pointer,
  `reference-repos`, `merge`, `architect` report location (if it offers "repo"), `code-map` (GraphStatusPanel),
  `full-suite`. Leave `claude-account`, `provider-accounts`, `owner-approval`, `manual-qa`, `policy`, MCP, budget, team
  and archive on `traits.usesRepos` as they are. Replace the "Convert it to a delivery project to add repositories"
  callout with neutral text in a business org, and have `ConvertPanel` offer only targets whose workflow uses no
  repositories (`workflowUsesRepos(def) === false`).
- **Workstations** (`Workstations.tsx:387-389`): hide `GitConnectionsPanel` and `DevOpsPanel` in a business org.
  Pairing, sign-ins, runtimes and toolchains stay (the runner is still needed).
- **Agents and org chart**: hide agents with `isDevops` from the Agents list and the org chart in a business org
  (C1: the engineer is plumbing there). Check `pages/Agents.tsx` and `components/orgchart` for where DevOps engineers
  are listed.
- **Hire dialogs**: `HireDialog.tsx:88`: also filter `isDevOnlyRoleKey(r.definition.key)` when business. Pack seat
  pickers (`HirePackAgentForm.tsx`, `HirePackDialog.tsx`, `HirePackTeamDialog.tsx`): drop `builder`, `pre_reviewer`,
  `reviewer`, `tester` from the seat options when business, and do not pre-select a suggested seat that was dropped
  (fall back to `own`).
- **Capabilities > Packs** (`PacksTab.tsx`): do not render the add-by-URL form (URL, credential, ref, workstations) in
  a business org. The pack list, trust and updates stay.
- **Card detail** (`CardDetail.tsx:696`): hide the Branch line in a business org. In the reset dialog description,
  drop "and worktree" in a business org (UI text only).
- **Help**: `DEV_ONLY_HELP_SLUGS = ['devops-and-hygiene', 'testing-and-finalization', 'project-conversion']` in
  `help/articles.ts`. In a business org, leave them out of the help index and search, render the not-available text
  for their URL (`/help/:slug`), and drop page-help links (`page-help-content.ts`) that point at them.
- **Org settings > General** (`orgsettings/GeneralTab.tsx`): a "How this organization works" panel. Two large radio
  cards (Developer / Business, a one-line description each, full-width and touch-sized on phones) for Owners and
  Admins; read-only text for members ("Only the Owner and Admins change this."). Saving calls
  `usePatchOrg().mutate({ mode })`. On `business_mode_blocked`, show the server message with the `details` lists as a
  bulleted list in a Callout. Switching to business asks for confirmation ("Repository, branch, DevOps and code-role
  screens will be hidden. Nothing is deleted; switching back shows them again."). `usePatchOrg` already refreshes
  `me`.
- **Accept invitation** (`pages/AcceptInvite.tsx`): when `startsOrg`, the same two radio cards under the org name
  field, default Developer, sent as `mode` in both the new-account and the signed-in accept calls. Keep it one tap on
  touch, and keep it out of the way of the password field on small screens: it goes below the name, above the
  password.
- `mocks/handlers.ts`: give the mock `activeOrg` `mode: 'dev'` and let `PATCH /org` echo `mode`.

### 4. Docs

`docs/USER-GUIDE.md` (a short "Developer and Business mode" section under organizations), `docs/ARCHITECTURE.md`
(org mode: column, event, `isBusinessOrg` as the one gate, the guard points), `docs/SPEC.md` if it lists org
settings. Rename UI text only; routes, API paths, event names and columns keep their names.

## Risks

- **Missing a surface.** Requirement 3 is broad. The list above comes from the code. The tester's e2e walk (business
  org: no repo/branch/DevOps/dev-hire/pack-URL entry anywhere, direct URLs show not-available) is the safety net. Any
  surface found later is a one-line `useBusinessMode()` gate.
- **Dev mode regressions.** Every web gate is `business && ...`, and every server guard passes in dev after one row
  read. Existing tests must pass unchanged (AC6). Fixtures that build `ActiveOrg` literals may need `mode: 'dev'` for
  the typecheck. Do not change assertions.
- **Guildwise Cloud build.** Only optional fields, defaulted fields and new exports. `OrgRow.mode` is optional. Cloud's
  `decorateActiveOrg` receives a dto that already has `mode`. Run `pnpm -r typecheck` here. Cloud is read-only for
  this card, and nothing in it constructs `ActiveOrg` in `src`.
- **Race between a switch and an add or hire.** `FOR UPDATE` on the org row in `setOrgMode` and `FOR SHARE` in
  `assertDevMode` serialise them inside the append transactions.
- **Custom roles that copy the builder.** The guard is by built-in role key. An org-made role with its own key that
  claims code build stages is not caught. Business projects have no code workflow stages, so it would never get
  work. This is a known limit for Phase 1.
- **The DevOps decision (C1)** is pending with the owner (non-blocking question). Only `modeSwitchBlockers` and the
  DevOps auto-hire would change if the answer differs.
- **Migration number collision** with other 1.4.0 cards: pick the next free number when building.

## Acceptance criteria → design

| AC | Covered by |
| --- | --- |
| New org can be created in business mode; existing orgs are dev after migration and look unchanged | `OrganizationCreated.mode` (optional) + accept-invitation `mode` + `--mode` CLI; migration `DEFAULT 'dev'`; all gates are business-only |
| In a business org no nav item, page, dialog or button for repos, worktrees, branches, dev hires, DevOps or pack-by-URL is reachable, also by direct URL | `buildNav({ business })`, `DevOnly` route wrapper, `repoUi` in project settings, Workstations panels, hire/seat filters, PacksTab form, card Branch line, help slugs, Ask DevOps triggers |
| Server rejects repo add, dev hire, pack-by-URL with 4xx and a readable message | `assertDevMode` (409 `business_mode`) in `repoAddedEvent`, `repoCreateRequestEvents`, `setReferenceRepos`, `hireAgentIn`, `addPack` |
| Switch to business refused with a listed reason while repos or dev agents exist; back to dev restores every surface | `setOrgMode` + `modeSwitchBlockers` (409 `business_mode_blocked`, message + details); dev switch unconditional; hiding is computed from `mode`, nothing deleted |
| Only an org manager changes the mode; change shows in the org's event history | `canSetOrgMode = isOrgManager` + route `min: 'admin'`; user-acted `OrgModeSet` on the org stream → audit export; platform audit entry |
| Dev-mode web and server suites pass unchanged | additive schema; guards no-op in dev; run existing suites |

## Tests (builder: unit and component; tester: e2e)

- `packages/shared/test/org-mode.test.ts`: `isBusinessOrg` (business, dev, missing, null, unknown string),
  `isDevOnlyRoleKey`, `ActiveOrgSchema.parse` without `mode` gives `'dev'`, `PatchOrgRequestSchema` accepts
  `{ mode }` alone.
- `apps/server/test/org-mode.test.ts` (template: `org-diagnostics-sharing.test.ts`): an org created without mode is
  `dev` in the row and in `GET /api/org` (the migration default); an invitation accepted with `mode: 'business'`
  gives a business org; an Admin can switch, a Member gets 403; an `OrgModeSet` event is appended with `previous` and
  `by`; the switch is refused with 409 listing a repository and a builder; the built-in DevOps engineer does not block;
  switching back to dev always works; in business mode: add repo, approved repo create, convert with a repo,
  reference repos, hire builder/reviewer/pre_reviewer/tester (also as a pack seat) and `POST /api/packs` all give 409
  `business_mode`, and the same calls succeed in dev; hiring an architect or BA in a business org works.
- Web (`apps/web/src/test/business-mode.test.tsx`): `buildNav` without `environments`/`releases` when business,
  unchanged when not; HireDialog role list omits dev-only roles in business and keeps them in dev; `DevOnly` shows the
  not-available page for `/releases` in business; PacksTab has no URL field in business; GeneralTab mode panel is
  read-only for members and shows the blocker list on 409.
- E2E (`@aom/e2e`, the tester): create a business org through an invitation, check the dev surfaces are absent and
  the direct URLs blocked; switch a clean dev org to business and back.
