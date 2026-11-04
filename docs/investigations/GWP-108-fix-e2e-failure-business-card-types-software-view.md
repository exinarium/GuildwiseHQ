# GWP-108: business-card-types "Software view" fails in the full E2E run on release/1.5.0

## 1. The question

`e2e/tests/business-card-types.spec.ts`, test *"the Software view leads with the developer card types and has the
business workflows installed already"* (line 100), fails in the GWP-99 full run on release/1.5.0. What is the root
cause (product regression, test isolation or stale expectation), and where does the fix go?

Base examined: `release/1.5.0` at `d81aa42f` (this card branch has the same commit).

## 2. The run log

From `/home/exinarium/devbox-cache/gwp99-run/run.log` (GWP-99 full run, checkout gwp-core-caa6a44, 379 tests,
1 worker, 12.6 min), failure 4 of 6:

```
✓ 45 [business-card-types] › tests/business-card-types.spec.ts:89:1 › setup: a developer organization with project BIZC (no repository) and a paired mock runner (461ms)
✘ 46 [business-card-types] › tests/business-card-types.spec.ts:100:1 › the Software view leads with the developer card types and has the business workflows installed already (585ms)
-  47..49 (Business view, enquiry, quote): not run (serial describe)

Error: expect(received).toBeGreaterThan(expected)
Expected: > 0
Received:   0

  107 |     [projectId],
  108 |   );
> 109 |   expect(installed.length).toBeGreaterThan(0);
  110 | });
  at e2e/tests/business-card-types.spec.ts:109:28
```

The failure is at line 109, the "installed" query, which matches the stale expectation in 3.2. Lines 102 and 103
passed in that run, so the race in 3.3 did not trigger there. It is still a latent fault. The three tests after it
did not run because the describe is serial, so the fix must also let them run.

## 3. Findings

### 3.1 The planning hypothesis (shared org mode) does not hold

- `inviteAndAccept` (`e2e/support/api.ts:20`) does not invite anyone into the admin's organization. It ignores
  `_admin` and runs `admin:create --org "<name>'s organization"`, so **BIZCARDS owns its own new organization**.
- `BIZCARDS` (`e2e/support/env.ts:41`) is used only by this spec. `business-mode.spec.ts` (MODESW) and
  `business-terms.spec.ts` each use their own user and organization.
- `playwright.config.ts` runs with `workers: 1` and `fullyParallel: false`, and `business-card-types` depends only on
  `auth`. Nothing runs at the same time, and no other spec can change this organization's mode.
- A view is per organization or per member (`effectiveView` in `packages/shared/src/orgs/mode.ts`), so no other
  organization's mode can leak in.

Test isolation (b) is ruled out for the mode. The planning note's idea that options[0] is not 'feature' because of a
leaked 'business' mode cannot happen.

### 3.2 Root cause: stale expectation (c). The "installed" query looks for organization-owned rows that no longer exist

Lines 105-109 of the spec:

```ts
const installed = await q(
  `SELECT key FROM workflow_versions WHERE key LIKE 'business-%' AND org_id = (SELECT org_id FROM projects WHERE id=$1)`,
  [projectId],
);
expect(installed.length).toBeGreaterThan(0);
```

This was written on 2026-10-31/11-01 (`6b6105ab`, `907c227a`, `e0e5c4f2`), when every organization got its own copy
of the six business workflows (`businessWorkflowEvents` in `admin:create` and in invitation accept).

Commit `594d2b33` (2026-11-01 21:30, *"register the business workflows as built-ins, migrate the 1.4.0 organization
copies"*) changed this on purpose:

- `apps/server/scripts/admin-create.ts` and `apps/server/src/commands/invitations.ts` no longer append
  `businessWorkflowEvents`. A new organization gets **no** `business-*` rows of its own.
- The six workflows are true built-ins (`org_id IS NULL`) registered at boot by `registerBuiltins`
  (`apps/server/src/catalogue/boot.ts`). `ensureBusinessWorkflows` (`apps/server/src/catalogue/business-workflows.ts`)
  only **enables** them on each project (`ProjectWorkflowsSet`, which `createProject` calls,
  `apps/server/src/commands/projects.ts:95`).
- The same commit updated the server tests to match. `apps/server/test/business-card-types.test.ts:26` now reads
  `(org_id IS NULL OR org_id=$1)`, and line 52 asserts that the organization owns **none**:
  `SELECT 1 FROM workflow_versions WHERE org_id=$1 AND key = ANY(...)` must equal `[]`. `org-mode.test.ts` was
  changed the same way.
- The E2E spec was not updated. `git log` shows its last change was `5f8fd508` (2026-11-01 07:01), before `594d2b33`.

So on release/1.5.0 the spec's query returns **0 rows every time**, and `expect(installed.length).toBeGreaterThan(0)`
fails (received 0). This does not depend on the order: it fails the same way alone and in the full run. It looked
like a full-run-only failure because GWP-99 was the first full run after `594d2b33`. The intended behaviour (user
guide, "Software view and Business view": every organization has every card type, and a view switches nothing on or
off) still holds in the product. Only the way the spec checks it is out of date.

No product regression (a): the product does what the views change and `594d2b33` intend, and the server tests cover it.

### 3.3 A second, latent fault in the same test: the picker is read before the business types arrive

`pickerOptions()` waits only for the **first** `<option>` to be attached, then takes a one-off `allInnerTexts()`
snapshot. `expect(options).toContain(label)` on that snapshot does not retry.

In `apps/web/src/pages/CardNew.tsx`:

- The form renders once `projects` and `workflows` have loaded. It waits for `enabledWorkflows` (the project's
  enabled set, where the six business types come from) **only in the Business view** (line 57: `business &&
  enabledWorkflows.isPending`).
- In the Software view the first render offers only the project workflow's types (`feature`, `bug`, ...) plus
  `research`. The six business types are added under "More types" when `GET /api/projects/:id/workflows` resolves.

`/workflows?projectId=` and `/projects/:id/workflows` start together, after `/projects`. If the second one returns
later (likely on a loaded full-run server), the snapshot has no "Enquiry" and line 103 fails before the SQL check.
This is a test race, not a product defect: the form is meant to fill in late-loading workflows (`2910e2e4`, "new card
form follows late-loading workflows"), and the user sees the types appear a moment later. The Business-view test is
not affected, because that view waits for the enabled set before rendering.

The log will show which of the two lines failed in GWP-99. Line 109 fails every time, and line 103 fails only when
the race goes the wrong way. Both are fixed below, so the test is reliable.

## 4. Options

| Option | What | Verdict |
| --- | --- | --- |
| A. Fix the spec's expectations to the built-in model, and wait for the full option list | Spec only | **Recommended.** The cause is in the spec, and the new check is stricter than the old one. |
| B. Put back per-organization copies on organization creation | Product | Rejected. It reverses `594d2b33` and its data migration, and breaks `business-card-types.test.ts:50` ("none owned by the organization"). |
| C. Make the Software view also wait for `enabledWorkflows` before rendering | Product (`CardNew.tsx:57`) | Not needed for this card. The card says to keep the change small and not to refactor the views. It would also make the Software form slower to show. You could raise it as a backlog item. |
| D. Change only the SQL | Spec | Not enough: it leaves the race in 3.3, so "passes reliably" is not met. |

## 5. Design (option A)

**One file changes: `e2e/tests/business-card-types.spec.ts`.** No change to `e2e/support/**`, the product or other
specs.

### 5.1 Wait for the whole option list before the snapshot

The business types arrive with the project's enabled workflows, which the Software view does not wait for. Wait for
each business label to be attached (exact match), then take the snapshot. `pickerOptions` is also used by the
Business-view test, where the wait passes at once.

```ts
async function pickerOptions(): Promise<string[]> {
  await page.goto('/cards/new');
  const type = page.getByRole('form', { name: 'New card' }).getByLabel('Card type');
  // the business types come with the project's enabled workflows, which the Software view does not wait for
  for (const label of BUSINESS_LABELS)
    await expect(type.locator('option').filter({ hasText: new RegExp(`^${label}$`) })).toHaveCount(1);
  return type.locator('option').allInnerTexts();
}
```

(`toHaveCount(1)` retries until the option is there, using the 30 s expect timeout. It also checks that no label
appears twice.) The assertions that follow stay exactly as they are: `options[0] === 'feature'`, and every business
label is offered.

### 5.2 Replace the "installed" query with the built-in model, and make it stricter

The comment *"every organization has the business workflows, installed at creation"* becomes *"the six business
workflows are built-ins, and every project has them enabled from the start"*. Put the six keys in the spec as a
constant (E2E specs do not import `@aom/shared`). They are the values of `BUSINESS_WORKFLOW_KEY` in
`packages/shared/src/workflows/business.ts`.

```ts
const BUSINESS_KEYS = [
  'business-enquiry', 'business-follow-up', 'business-document-request',
  'business-reminder', 'business-report', 'business-quote',
];

// the six business workflows are built-ins, and every project has them enabled from the start
const builtIn = await q<{ key: string }>(
  `SELECT DISTINCT key FROM workflow_versions
    WHERE key = ANY($1::text[]) AND org_id IS NULL AND project_id IS NULL AND status='active'`,
  [BUSINESS_KEYS],
);
expect(builtIn.map((r) => r.key).sort()).toEqual([...BUSINESS_KEYS].sort());
const enabled = await q<{ workflow_key: string }>(
  `SELECT workflow_key FROM project_workflows WHERE project_id=$1 AND workflow_key = ANY($2::text[])`,
  [projectId, BUSINESS_KEYS],
);
expect(enabled.map((r) => r.workflow_key).sort()).toEqual([...BUSINESS_KEYS].sort());
// none is an organization copy (they were until release 1.4.0)
expect(
  await q(
    `SELECT 1 FROM workflow_versions WHERE key = ANY($1::text[]) AND org_id = (SELECT org_id FROM projects WHERE id=$2)`,
    [BUSINESS_KEYS, projectId],
  ),
).toEqual([]);
```

This is stricter than the old `length > 0`. It requires all six as built-ins, all six enabled on the project, and no
organization copy, which matches `apps/server/test/business-card-types.test.ts:47-58`.

### 5.3 What stays the same

The test title, the `options[0]` and `toContain` assertions, the other four tests, `test.describe.configure({ mode:
'serial' })`, the config (no retries), and every helper. Nothing is skipped, retried or loosened.

## 6. Who does the work, and the runs

- **The edit is under `e2e/**`.** The CEO has ruled several times that builders get no exception to the e2e guard
  and that testers own E2E files (ledger aadf93f9, 69b39b28, f87e3c86; GWP-106 answer 4e156197). Following the
  GWP-106 route: the builder hands off with this report as the only diff, names section 5 as the exact spec change,
  and asks for the card to go to a tester-role shift. The tester applies section 5 to the spec.
- **Runs (DevOps, per the GWP-99 standing order; the tester records the results):**
  1. Reproduce on the base commit: `pnpm -C e2e exec playwright test --project=business-card-types`. Expected
     result: it fails alone too, at line 109 (`expect(received).toBeGreaterThan(expected)`, expected 0, received 0)
     or at line 103 (`toContain "Enquiry"`). Either one confirms 3.2/3.3. Note which line the GWP-99 log names.
  2. After the change: `--project=business-card-types` three times, all green.
  3. `--project=business-mode --project=business-terms --project=business-card-types` in one run, green (test plan
     step 5; it shows the result does not depend on the order).
  4. The full suite on the fixed release/1.5.0: "Software view" green, and no failure that is not already in the
     GWP-99 log.
- No unit or server test changes. The product is unchanged, and `apps/server/test/business-card-types.test.ts`
  already covers the built-in model.

## 7. Acceptance criteria

| AC | How it is met |
| --- | --- |
| Root cause named with evidence | **Stale expectation (c)**, with a latent test race. Evidence: `594d2b33` removed per-org copies and changed the server tests to `org_id IS NULL` and "none owned by the organization", while the spec still queries `org_id = <org>` (section 3.2). The run 1 reproduction and the GWP-99 log line confirm it. Isolation ruled out (section 3.1). |
| Spec passes alone | Sections 5.1 and 5.2. Run 2. |
| Full suite passes "Software view", no new failures | Spec-only change, own user and organization, no shared state touched. Run 4. |
| If isolation: set up and restore mode | Not the cause (3.1). The spec already asserts `mode === 'dev'` in setup, and its organization is its own. |
| If product regression: covered by a unit/server test | Not the cause. The product matches the intended behaviour, and `business-card-types.test.ts:47-58` covers it. |
| Nothing skipped, retried or loosened | Same assertions. The SQL check is stricter (all six, enabled, no org copy). The wait is a web-first assertion, not a retry or a longer timeout (5.3). |

## 8. Risks

- Column names in 5.2 checked: `project_workflows(project_id, workflow_key, ...)` in
  `apps/server/migrations/1660_project_workflows.sql`, and `workflow_versions.org_id/project_id/status` as
  `ensureBusinessWorkflows` reads them.
- If a future release adds a seventh business type, `BUSINESS_KEYS` and `BUSINESS_LABELS` must both change. They
  already sit next to each other at the top of the spec.
- Follow-up outside this card (optional backlog item): the Software-view New card form renders before the project's
  enabled workflows load (option C). It is harmless for users, but every E2E check on that picker has to wait for it.
