# GWP-205: Per-project review settings (size budget, size unit, path-to-risk map), no defaults

## Question

The owner must be able to set, per project, a **size budget**, the **unit** it is measured in and a **path-to-risk
map**, with no defaults anywhere. Features that need these settings (size verdict, needs-split, hard size check, risk
from paths) must stay inactive and say what is missing until they are set. A shared helper derives the risk class of a
diff from the map, and a declared risk may raise it but never lower it. Open points from planning: which size units to
offer, where the risk class enum lives, and whether the map uses glob syntax.

## Findings

### What the PRD says (v22, doc 61871304)

The approved v22 PRD in the project vault has no F3 table. It is the summary, the users, the decision log and a list
of edits. The parts that apply to this card:

- Non-goal: "No default budgets or risk maps."
- Owner scenario: "sets the size budget, its unit and the path-to-risk map".
- Decision log: "Budget and risk map set per project, no defaults" (Owner) and "Size unit chosen per project" (Johnny,
  confirmed).
- Boardroom open question (v2 seed): "Owner to set a per-project size budget (**max files, max lines**) and a
  path-to-risk map".
- F2 and F6 edits measure size in **changed lines** ("1 finding per 100 changed lines"; stacked PRs "their changed
  lines are added up before comparing against the size budget").
- Risks: "derive risk from a per-project path-to-risk map applied to the actual diff", "the declaration only able to
  raise it", and scope at "directory-level ... never exact paths".

**Units:** the PRD names exactly two measures, lines and files. The design offers `changed_lines` and `changed_files`
and nothing else. The enum leaves room for more later, but adding a unit is out of scope.

### What the code has today

- **Project settings are not in `ProjectChangesSchema`.** The brief and planning note say `stopLoss` lives in
  `ProjectChangesSchema`. It does not. `ProjectChangesSchema` (`packages/shared/src/events/project.ts:29`) holds the
  General form fields. Stop-loss has its own event `ProjectStopLossSet`, its own route `PUT /api/projects/:id/stop-loss`
  (`apps/server/src/routes/projects.ts:424`) and its own command `setStopLoss` (`apps/server/src/commands/projects.ts:548`).
  The other policy settings use the same pattern: merge policy, owner approval, E2E areas, architect settings, test
  services and concurrency cap.
- **Owner-only check:** `ownedProject()` (`apps/server/src/commands/projects.ts:153`) refuses anyone whose
  `project_members.role` is not `owner`, with 403 "only the project owner can do this". `setMergePolicy` uses it.
  `loadManaged()` in `lean-project.ts` also lets org Owners and Admins through, so it is **not** owner-only.
- **Glob matching already exists:** `globToRegExp` in `packages/shared/src/workflows/high-risk.ts:124` handles `**`,
  `*` and `?`, is case-insensitive and is used by E2E areas, component rules and docs-prep.
- **A risk class enum already exists:** `ReviewRisk = z.enum(['low','medium','high'])` in
  `packages/shared/src/cards/types.ts:193`, exported from `@aom/shared`. The reviewer already rates risk with these
  three values, so the map should use the same enum. GWP-207 can then compare the two directly.
- **Built-in high-risk list:** `HIGH_RISK_RULES` in `workflows/high-risk.ts` is a fixed list (auth, data, tenancy)
  that drives the lean flow's owner approval and second Opus review. It is not a per-project map and it is not a
  "default" of the new setting. This card leaves it alone (see Risks).
- **Persistence pattern:** each setting gets nullable columns on `projects`, a projector that writes them
  (`apps/server/src/projections/projects.ts`, `code-v6.ts`, `question-flow.ts`), a migration under
  `apps/server/migrations/NNNN_*.sql` (applied in filename order; the latest is `2891_regression_loop.sql`), and a
  mapping in `toProjectDto` (`apps/server/src/queries/misc.ts:80`).
- **Web pattern:** one panel component per setting in `apps/web/src/components/*Panel.tsx`, placed in
  `apps/web/src/pages/ProjectSettings.tsx` inside `<div id="..." className="scroll-mt-20">`, with a mutation hook in
  `apps/web/src/api/queries/projects.ts` (`useSetMergePolicy` is the template) and a test in
  `apps/web/src/test/*.test.tsx` that mocks `fetch` (`owner-approval-panel.test.tsx` is the template).
- **No size-dependent code exists yet.** GWP-207, GWP-209 and GWP-211 will read these settings. This card provides the
  gate they must call.

## Options compared

### A. Where the settings are stored and changed

| Option | For | Against |
| --- | --- | --- |
| A1: add the fields to `ProjectChangesSchema` and send them through `PATCH /api/projects/:id` (as the brief suggests) | No new route. `updateProject` is already owner-only. | The audit event is a generic `ProjectUpdated`. The General form's partial PATCH and this form would share one body. Validation of the map (refinements) would sit in the event's changes schema, which old events must still parse. It does not match how every other policy setting is stored. |
| **A2: dedicated event `ProjectReviewSettingsSet` + `PUT /api/projects/:id/review-settings`** | Same pattern as stop-loss and merge policy. Explicit audit (who, what). Strict request validation stays in the API schema. Whole-value replace, so there is no partial-merge ambiguity. | One more event, route and projector. |

**Choice: A2.** It is how the codebase stores every other project policy. The builder should not touch
`ProjectChangesSchema`.

### B. Path pattern syntax

| Option | For | Against |
| --- | --- | --- |
| B1: exact paths only | Simple | Rejected by the boardroom risk: fires on incidental edits |
| B2: regular expressions | Powerful | Hard to type on a phone and easy to get wrong |
| **B3: globs (`**`, `*`, `?`) through `globToRegExp`, and a bare path means that path and everything under it** | Matches E2E areas and the high-risk list. Folder-level by default. | A bare file name such as `package.json` also matches itself, which is fine. |

**Choice: B3.** Normalisation: trim, `\` becomes `/`, a leading `./` is dropped, and a trailing `/` is dropped. A pattern
with no `*` or `?` matches the path itself **or** any path under it (`p` or `p/**`). Refused: an empty pattern, a
leading `/`, any `..` segment, more than 300 characters, duplicates after normalisation, and more than 200 entries.

### C. What "unset" means

There are no defaults, so `null` is the only unset value. An empty map (`[]`) saved from the UI is stored as `null`.
Budget `0` is refused (minimum 1). The unit has no preselected option in the UI: the select starts at
"Not set".

### D. A diff that touches no mapped path

| Option | For | Against |
| --- | --- | --- |
| Treat it as `low` | Always yields a class | That is a default, which the PRD forbids |
| **Derived class is `null` ("no touched path is in the map"); the final class is the declared one if given, else `null`** | No hidden default; the caller (GWP-207/211) decides what null means for it | Callers must handle null |

**Choice: null.**

## Recommendation and design

### 1. Shared: `packages/shared/src/projects/review-settings.ts` (new), exported from `projects/index.ts`

```ts
import { z } from 'zod';
import { ReviewRisk } from '../cards/types.ts';
import { globToRegExp } from '../workflows/high-risk.ts';

/** How a project's size budget is measured (PRD v22: lines and files; chosen per project, no default). */
export const SizeUnitSchema = z.enum(['changed_lines', 'changed_files']);
export type SizeUnit = z.infer<typeof SizeUnitSchema>;
export const SIZE_UNIT_LABELS: Record<SizeUnit, string> = {
  changed_lines: 'Changed lines (added + removed)',
  changed_files: 'Changed files',
};

/** The risk class a path maps to: the same scale the reviewer rates with. */
export const RiskClassSchema = ReviewRisk;            // 'low' | 'medium' | 'high'
export type RiskClass = z.infer<typeof RiskClassSchema>;
export const RISK_ORDER: Record<RiskClass, number> = { low: 0, medium: 1, high: 2 };

export const RiskPatternSchema = z.string().transform(normalisePattern).pipe(
  z.string().min(1).max(300)
    .refine((p) => !p.startsWith('/'), 'a path inside the repository, not starting with /')
    .refine((p) => !p.split('/').includes('..'), 'no .. in a path'),
);
export const RiskMapEntrySchema = z.object({ pattern: RiskPatternSchema, risk: RiskClassSchema });
export const RiskMapSchema = z.array(RiskMapEntrySchema).max(200)
  .refine(noDuplicatePatterns, 'each path appears once');
export type RiskMapEntry = z.infer<typeof RiskMapEntrySchema>;

/** The stored settings; every field null until the owner sets it. */
export const ReviewSettingsSchema = z.object({
  sizeBudget: z.number().int().min(1).max(1_000_000).nullable(),
  sizeUnit: SizeUnitSchema.nullable(),
  riskMap: RiskMapSchema.nullable(),   // [] normalised to null by the command
});
export type ReviewSettings = z.infer<typeof ReviewSettingsSchema>;

export const REVIEW_SETTING_MISSING = {
  sizeBudget: 'inactive: no size budget set',
  sizeUnit: 'inactive: no size unit set',
  riskMap: 'inactive: no path-to-risk map set',
} as const;
export type ReviewSettingKey = keyof typeof REVIEW_SETTING_MISSING;

export type FeatureStatus =
  | { active: true }
  | { active: false; missing: ReviewSettingKey[]; reason: string /* first message */; reasons: string[] };

/** Size verdict, needs-split and the hard size check need a budget AND a unit. */
export function sizeChecksStatus(s: Partial<ReviewSettings> | null | undefined): FeatureStatus;
/** Risk from paths needs the map. */
export function riskFromPathsStatus(s: Partial<ReviewSettings> | null | undefined): FeatureStatus;
export function reviewSettingsStatus(s): { size: FeatureStatus; risk: FeatureStatus };

/** What a diff measures in the unit (numstat: binary files count 0 lines, 1 file). */
export function diffSize(files: ReadonlyArray<{ added: number; deleted: number }>, unit: SizeUnit): number;

export type DerivedRisk =
  | { state: 'inactive'; reason: string }                          // no map: never a fallback value
  | { state: 'active';
      derived: RiskClass | null;      // highest class among touched paths; null: no touched path is mapped
      declared: RiskClass | null;
      final: RiskClass | null;        // max(derived, declared); a lower declaration is ignored
      raisedByDeclaration: boolean;
      matches: Array<{ path: string; pattern: string; risk: RiskClass }> };  // for the "why" text

export function riskFromPaths(i: {
  paths: readonly string[];
  riskMap: readonly RiskMapEntry[] | null | undefined;
  declared?: RiskClass | null;
}): DerivedRisk;
```

Rules:
- `normalisePattern`: trim, `\` to `/`, drop leading `./`, drop trailing `/`.
- `compile(pattern)`: if it contains `*` or `?`, use `globToRegExp(pattern)`. Otherwise use two regexps,
  `globToRegExp(pattern)` and `globToRegExp(pattern + '/**')`.
- Normalise the paths the same way as `high-risk.ts` (`\` to `/`, strip a leading `./`).
- `riskFromPaths`: if the map is null or empty, return `inactive` with `REVIEW_SETTING_MISSING.riskMap`. Otherwise, for
  each path, take the highest class of every matching entry (entries can overlap; the highest wins, the order does not
  matter). `derived` is the highest class across all paths. `final = max(derived, declared)`, where null counts as
  below `low`. `raisedByDeclaration = declared != null && (derived == null || RISK_ORDER[declared] > RISK_ORDER[derived])`.
- The declaration only matters when the map is set. With no map the result is `inactive`, so the declaration does
  not stand in for a missing map.

### 2. Shared: event and API

- `packages/shared/src/events/project.ts`: new event
  ```ts
  defineEvent('ProjectReviewSettingsSet', z.object({
    projectId: Id,
    sizeBudget: z.number().int().min(1).nullable(),
    sizeUnit: SizeUnitSchema.nullable(),
    riskMap: z.array(z.object({ pattern: z.string().min(1).max(300), risk: RiskClassSchema })).nullable(),
    by: Id,
  })),
  ```
  Keep the event schema lenient (no refinements) so later rule changes never make old events fail to parse. The strict
  checks live in the request schema.
- `packages/shared/src/api/projects.ts`:
  - `SetReviewSettingsRequestSchema = ReviewSettingsSchema` (all three fields required, each nullable; whole-value
    replace).
  - `ProjectDtoSchema` gets
    `reviewSettings: z.object({ sizeBudget, sizeUnit, riskMap, status: z.object({ size: FeatureStatusSchema, risk: FeatureStatusSchema }) }).optional()`.
    Define `FeatureStatusSchema` in review-settings.ts next to the type. In the DTO, use a plain entry schema
    (`{ pattern: z.string(), risk: RiskClassSchema }`) with no `transform` or `refine`, so serializing a response
    never runs input normalisation. Keep a single `StoredRiskMapEntrySchema` for both the event and the DTO.

### 3. Server

- **Migration** `apps/server/migrations/2900_project_review_settings.sql` (take the next free number above the
  highest on main when you build):
  ```sql
  -- Per-project review settings (no defaults): size budget, its unit and the path-to-risk map. Projection of
  -- ProjectReviewSettingsSet. All nullable, no DEFAULT: unset stays unset.
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS size_budget integer;
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS size_unit text;
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS risk_map jsonb;
  ```
  No `DEFAULT` and no backfill (AC2).
- **Command** `setReviewSettings(ctx, user, projectId, settings)` in `apps/server/src/commands/projects.ts`, next to
  `setMergePolicy`:
  - `const p = await ownedProject(tx, user.id, projectId)`. This is the owner-only check (AC5): a manager gets 403, a
    non-member gets 404. Do **not** use `loadManaged` (it lets org Admins in).
  - Normalise `riskMap: []` to `null`.
  - Skip the append when nothing changed. Compare against `p.size_budget`, `p.size_unit` and `p.risk_map`, using JSON
    equality for the map.
  - Append `ProjectReviewSettingsSet` with `by: user.id` on `streamId.project(projectId)`, with
    `projectScope(p.org_id, projectId)` and `userActor(user.id)`.
- **Route** in `apps/server/src/routes/projects.ts`, next to stop-loss:
  ```ts
  app.put('/api/projects/:id/review-settings',
    { schema: { params: IdParamsSchema, body: SetReviewSettingsRequestSchema } },
    async (req) => {
      const s = await requireUser(ctx, req);
      await setReviewSettings(ctx, s.user, req.params.id, req.body);
      return getProjectDetail(ctx, s.user.id, req.params.id);
    });
  ```
  A bad body gets a 400 from the schema (fastify zod provider), as the other routes do.
- **Projector** in `apps/server/src/projections/projects.ts`:
  `UPDATE projects SET size_budget=$2, size_unit=$3, risk_map=$4::jsonb WHERE id=$1` (map: `JSON.stringify` or null).
  The `projects` table is already in the rebuild list, so nothing to add there.
- **Read back** in `toProjectDto` (`apps/server/src/queries/misc.ts`):
  ```ts
  const review = {
    sizeBudget: p.size_budget ?? null,
    sizeUnit: SizeUnitSchema.safeParse(p.size_unit).data ?? null,
    riskMap: RiskMapSchema.safeParse(p.risk_map).data ?? null,
  };
  reviewSettings: { ...review, status: reviewSettingsStatus(review) },
  ```
  Never use a fallback value here: the `?? null` keeps unset as unset.
- Optional helper `loadReviewSettings(db, projectId): Promise<ReviewSettings>` in a new
  `apps/server/src/queries/review-settings.ts`, for GWP-207, GWP-209 and GWP-211 to call later. Nice to have, not
  required by an AC.

### 4. Web

- **Hook** `useSetReviewSettings(id)` in `apps/web/src/api/queries/projects.ts`: `put('/projects/${id}/review-settings', body)`,
  then invalidate `['project', id]` and `['projects']`.
- **Panel** `apps/web/src/components/ReviewSettingsPanel.tsx` (new), added in `ProjectSettings.tsx` under
  `{project && traits.usesRepos && <div id="review-settings" className="scroll-mt-20">...}`, placed after
  `owner-approval`. Add the jump chip "Review settings" to `sections`.
  - Title "Review settings". Under it, a status callout built from `project.reviewSettings.status`: either "Size
    checks are active" / "Risk from paths is active", or each missing reason, for example
    "Size checks: inactive: no size budget set" and "Risk from paths: inactive: no path-to-risk map set". This is how
    the UI says what is missing (Requirement 3).
  - **Size budget:** `TextInput` with `inputMode="numeric"`, `pattern="[0-9]*"` and `enterKeyHint="next"` (a numeric
    soft keyboard on phones; avoid `type=number` scroll and spinner problems). An empty value means not set. The error
    "A whole number of 1 or more" is shown inline under the field, not as a toast.
  - **Size unit:** `Select` whose first option is "Not set" (value `''`), then the two `SIZE_UNIT_LABELS`. Nothing is
    preselected.
  - **Path-to-risk map:** a list of rows, each with a pattern `TextInput` (placeholder `apps/server/src/auth/**`,
    `autoCapitalize="off"`, `autoCorrect="off"`, `spellCheck={false}`), a risk `Select` (low, medium, high; a new row
    starts at an empty "Choose" option, so there is no default class and the row is invalid until a class is chosen)
    and a **Remove** button. **Add path** appends a row and focuses its pattern input. The user has to type there
    anyway, so the soft keyboard opening is expected, and `scrollIntoView({ block: 'center' })` keeps the input
    visible above the keyboard. A hint explains: "A folder such as `apps/server/src/auth` covers everything under it;
    `*` and `**` work as in .gitignore. The highest class of any touched path wins." Errors such as a duplicate,
    `..` or a leading `/` are shown inline per row, and the server's 400 message is shown in the panel's `ErrorBox`.
  - **Touch:** controls and buttons at least 44 px high (use the existing `Button` and `TextInput` sizes). Rows stack
    vertically below `sm` and sit inline on larger screens. No hover-only affordances.
  - **Save** sends all three values. Empty fields send `null`. A non-owner sees the values and the status read-only
    (no inputs, no Save) with the note "Only the project owner can change these settings."
- `project.myRole === 'owner'` decides whether the form can be edited. Do **not** add `|| canConvert` (other panels do,
  but this setting is owner-only and the server refuses everyone else).

### 5. Docs

`docs/USER-GUIDE.md` section 4.3, in the "What you will find there" list: add a **Review settings** bullet (owner only;
size budget, unit lines or files, path-to-risk map with glob and folder rules; nothing is set by default; until a value
is set, the checks that need it show "inactive: no size budget set" and the like; the highest class of any touched path
wins, and a declared class can raise it but never lower it). Add "Review settings" to the jump-chip list at the end of
that bullet list.

### Tests (new files only)

| File | Covers |
| --- | --- |
| `packages/shared/test/review-settings.test.ts` | AC4: high + low paths give `high`; declared `low` gives `high` (not lowered, `raisedByDeclaration=false`); a map of only low/medium paths with declared `high` gives `high` (`raisedByDeclaration=true`); unmatched paths give derived `null`, final = declared; a bare folder pattern matches nested files; a glob `**/migrations/**` matches; no map gives `inactive` + reason. AC3 (unit level): `sizeChecksStatus` with budget null gives `{active:false, reason:'inactive: no size budget set'}`, with a unit missing gives the unit reason, with both set gives active. Schema: `0`, `..`, a leading `/` and duplicates are refused; a trailing `/` is normalised. `diffSize` for both units. |
| `apps/server/test/review-settings.test.ts` (needs the test DB: testers run it) | AC1: the owner PUTs budget, unit and map, a fresh GET returns them. AC2: a new project (or the world's project before any PUT) has `sizeBudget/sizeUnit/riskMap` null and both statuses inactive. AC3: a project with no budget reports `status.size.reason === 'inactive: no size budget set'`. AC5: a manager (`addMember` helper, as in `merge-policy.test.ts`) gets 403 and the values are unchanged; a bad body (budget 0, a pattern with `..`) gets 400. One `ProjectReviewSettingsSet` event per change, none for an identical PUT. |
| `apps/web/src/test/review-settings-panel.test.tsx` | Renders "Not set" and the missing reasons for an empty project. The owner fills budget, unit and two rows, then Save sends `PUT /api/projects/:id/review-settings` with the exact body; clearing the budget sends `null`. A manager sees read-only values and no Save. Inline errors appear for budget `0` and for a row without a class. |

Run `pnpm --filter @aom/shared test` and the web test file. The server file needs Postgres 5433, so list it in the
handoff for the testers.

## Acceptance criteria mapping

| AC | Design element |
| --- | --- |
| AC1 saved and shown after reload | `PUT /review-settings` gives event, projector, columns, `toProjectDto.reviewSettings`; the panel reads `project.reviewSettings` |
| AC2 empty on a new project | nullable columns with no DEFAULT and no backfill; `ProjectCreated` does not touch them; the DTO maps unset to `null`; the unit select has no preselected option |
| AC3 "inactive: no size budget set" | `sizeChecksStatus` / `REVIEW_SETTING_MISSING`, exposed as `reviewSettings.status` on the DTO and shown in the panel; GWP-207, GWP-209 and GWP-211 must call `sizeChecksStatus` and `riskFromPaths` and never use a fallback |
| AC4 high beats low, raise-only declaration | `riskFromPaths` (max over matches, `final = max(derived, declared)`) |
| AC5 owner only | `ownedProject()` in `setReviewSettings` (403 for managers); the UI form can be edited only when `myRole === 'owner'` |

## Risks and notes

- **Built-in high-risk list versus the new map.** `HIGH_RISK_RULES` still drives the lean flow's owner approval and
  second review, whatever the project map says. This card does not connect the two, because that belongs to the
  consumers (GWP-207 and later). If the owner later wants the project map to replace the built-in list, that is a new
  decision and needs its own card.
- **Card brief inaccuracy:** settings do not live in `ProjectChangesSchema` (see Findings). Do not add the fields there.
- **Migration number:** other cards may add migrations at the same time. Take the next free number on main when you
  build, and re-check after a merge of main.
- **Event schema leniency:** keep the event payload free of refinements, so a future tightening of the pattern rules
  never makes a projection rebuild fail on old events.
- **Out of scope:** the size verdict, needs-split, the CI size check and exceptions (GWP-207, GWP-208, GWP-210,
  GWP-211), GWP-209, and any change to `HIGH_RISK_RULES`. What counts as a changed line, for example whether lockfiles
  are excluded, is pinned only as far as `diffSize` (numstat added + deleted). Any exclusion list belongs to GWP-211.
