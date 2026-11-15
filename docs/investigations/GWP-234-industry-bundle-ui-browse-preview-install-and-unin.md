# GWP-234 Industry bundle UI: browse, preview, install and uninstall the accounting and law bundles

Design report, revised 2026-11-15 after GWP-233 (server and shared bundle API) and GWP-232 (accounting and law journey templates) landed on the working branch (`462c9f2b`). The first version was written against the GWP-233 spec at `7fcd4320`. Section 8 records which assumptions held and what changed. The placement, the component structure, the result Callout and the test approach are unchanged. The hooks, the preview item model, the result wording, the invalidation list, a new project picker and the E2E journey template check change.

## 1. Question

Org managers need a screen to list the industry bundles, preview one, and install or uninstall it in one action. Members see the list and the preview but no action buttons. Where does the screen go, what does it look like, and which code changes?

## 2. Findings (current code)

| Area | File | What is there |
|---|---|---|
| Bundle API (landed) | `apps/server/src/routes/industry-bundles.ts`, `commands/industry-bundles.ts` | `GET /api/industry-bundles` gives `{ bundles }`, `GET /api/industry-bundles/:bundleId?projectId=` gives the preview, `POST …/:bundleId/install` takes an optional `{ projectId, timezone }` body, and `POST …/:bundleId/remove` uninstalls. The verb is **remove**, not uninstall. List and preview check `assertMember`. Install and remove check `assertManager` and return 403 `forbidden` with "only the organization Owner and Admins can install or remove industry bundles". Removing a bundle that is not installed returns 409 `bundle_not_installed`. Installing an installed bundle returns 200 `status: 'already_installed'`. |
| Bundle types (landed) | `packages/shared/src/api/ledger.ts:238-332`, exported through `@aom/shared` | `IndustryBundleSummarySchema` (id, industry, name, description, version, installed, installedAt, `counts { rules, playbooks, knowledgeTemplates, sampleData, journeyTemplates }`), `IndustryBundleListResponseSchema`, `IndustryBundlePreviewSchema`, `InstallIndustryBundleRequestSchema`, `IndustryBundleInstallResultSchema`, `IndustryBundleRemoveResultSchema`. See section 4.2 for the shapes the UI reads. |
| Bundle definitions | `packages/shared/src/industry/{accounting,law,bundles,common}.ts` | `INDUSTRY_BUNDLES`, `industryBundleById`. Knowledge templates and sample data are **Documents** (kind `template` / `sample`, tags `industry-template` / `sample`). Playbooks are **brief playbooks**, which become schedules, installed **switched off** (`enabled: false`). |
| Where members show | `Documents.tsx` (GWP-233 added the `Template` and `Sample data` kind labels), `api/queries/documents.ts` (`['documents', …]`), `briefPlaybooks.ts` (`['brief-playbooks']`, `['schedules']`), `ledger.ts` (`['ledger']`, `['rule-packs']`) | Rules show in Rules & decisions, playbooks in Schedules, and templates and sample data in Documents. |
| Journey templates | `apps/server/src/routes/journeys.ts:41-44`, `packages/shared/src/journeys/templates.ts:59-60` | `GET /api/journey-templates` returns the static `JOURNEY_TEMPLATES` to every member of every org. `accounting-client-onboarding` and `law-client-matter` are always listed. Bundle install and remove only record the template ids. They do not add or remove anything. |
| Project for playbooks | `commands/brief-playbooks.ts:171-190`, `components/schedules/BriefPlaybookDialog.tsx:46,67,81,184-196` | Install needs a project for the playbook cards. With one active project it is chosen automatically. With more than one, install fails with 400 `project_required` unless `projectId` is given. The bundle preview reports this in `blockers[]` (`project_required` or `no_project`). `BriefPlaybookDialog` already has the picker pattern: `useProjects()` filtered on `status === 'active'`, and a `Select` shown only when there is more than one. |
| Rule pack hooks | `apps/web/src/api/queries/ledger.ts:124-164` | `useRulePacks`, `useRulePackPreview`, `useInstallRulePack` / `useRemoveRulePack` (POST, zod-parsed result, invalidate `['ledger']` and `['rule-packs']`). |
| Rule pack UI | `apps/web/src/components/RulePacksDialog.tsx` | `PackList` (row button with `Installed` badge, `[@media(pointer:coarse)]:min-h-11`), `PackPreview` (back button, `ListSkeleton`, `ErrorBox` with retry, rule list with `statusLine()` per status, `canManage` gate, `ConfirmDialog` for remove, toast), and module-private `plural()` and `statusLine()`. |
| Host page | `apps/web/src/pages/Ledger.tsx:412-450, 546` | PageHeader actions: `Rule packs` (secondary) and `Add entry` (primary). The button shows in both views (GWP-27: views never switch features off; `rule-packs.test.tsx` "software-default org too" pins this). |
| Shared UI | `components/ui.tsx`, `ui/ConfirmDialog.tsx`, `ui/Callout.tsx` | `Dialog` (bottom sheet on small screens, `--kbd-gap` aware), `ConfirmDialog` (Cancel gets initial focus, `children` slot), `Badge`, `ErrorBox` (shows `error.message` through `reword`, `role="alert"`), `Callout`, `ListSkeleton`, `Select`, `useToast`. |
| Role and wording | `lib/orgRole.ts` `useCanManageOrg()`; `lib/terms.ts` `useOrgTerms()` | Owner or admin, the same rule as the server's `assertManager`. `t.StandingOrders` ("Rules" / "Standing orders"), `t.reword(sentence)`. |
| Client | `apps/web/src/api/client.ts:23-66` | `get`, `post`, `qs()` for query strings. A response that does not match its schema only logs a warning (line 54). |
| Tests | `apps/web/src/test/rule-packs.test.tsx` | `vi.stubGlobal('fetch')` with a path switch, a `calls` log, `me()` with `role` and `mode`, and `wrap()` with QueryClient, ToastProvider and MemoryRouter. No MSW handlers are needed. |

## 3. Options

### 3.1 Placement (requirement 5), unchanged

| Option | For | Against |
|---|---|---|
| A. Tabs inside `RulePacksDialog` | One place | The dialog talks about rules only, and a bundle is more. It changes the GWP-31 test flow. |
| B. A bundles section in `PackList` | No new control | Bundle queries fire in the rule pack tests. It mixes two kinds of install, with the Industry rule packs next to the bundles that contain them. |
| **C. Sibling button "Industry bundles" on the Rules & decisions header, opening `IndustryBundlesDialog`** | Same screen as rule packs today. `RulePacksDialog` behaviour stays unchanged. The header actions already wrap on narrow screens. | One more header button |
| D. A new page or route | Room to grow | Router and nav work this card does not need. |

**Decision: C.** An "Industry bundles" button on the Rules & decisions (Ledger) page header, between "Rule packs" and "Add entry", opens `IndustryBundlesDialog`. It shows in both views. This is recorded on the card.

### 3.2 Contents

The list builds its contents line from `summary.counts`. The preview shows the full member list from the preview endpoint. The list never calls the preview per bundle.

### 3.3 Result

After install or uninstall, show an inline `Callout` (`role="status"`, `data-testid="bundle-result"`) at the top of the preview, plus a short toast. A toast cannot hold the kept list.

## 4. Design

### 4.1 Files

| File | Change |
|---|---|
| `apps/web/src/api/queries/industryBundles.ts` (new) | Query and mutation hooks (4.2). |
| `apps/web/src/components/IndustryBundlesDialog.tsx` (new) | `IndustryBundlesDialog`, `BundleList`, `BundlePreview`, `BundleResult`. |
| `apps/web/src/lib/rulePackStatus.ts` (new, small) | Move `plural()` and `statusLine()` out of `RulePacksDialog.tsx` so both dialogs share them. `RulePacksDialog.tsx` imports them, with no behaviour change. |
| `apps/web/src/pages/Ledger.tsx` | `const [bundles, setBundles] = useState(false)`, the header button, and `<IndustryBundlesDialog open={bundles} onOpenChange={setBundles} />`. |
| `apps/web/src/test/industry-bundles.test.tsx` (new) | Component tests (6.1). |
| `apps/web/src/test/rule-packs.test.tsx` | One added assertion: the Ledger header also has "Industry bundles" in both views. All existing cases stay green. |
| `docs/USER-GUIDE.md` section 4.5 | One paragraph: Industry bundles on Rules & decisions, what a bundle holds (rules, playbooks added switched off, knowledge templates and sample data in Documents, journey templates that are always in the Journeys gallery), who may install, the project choice, and that uninstall keeps edited items. |
| `e2e/tests/industry-bundles.spec.ts` (new) | **Tester-owned** (6.2). |

No router change and no shared type change. Every type comes from `@aom/shared`.

### 4.2 Hooks (`industryBundles.ts`)

Real paths and schemas from GWP-233:

```ts
import {
  type IndustryBundleInstallResult, IndustryBundleInstallResultSchema,
  IndustryBundleListResponseSchema,
  type IndustryBundlePreview, IndustryBundlePreviewSchema,
  type IndustryBundleRemoveResult, IndustryBundleRemoveResultSchema,
} from '@aom/shared';
import { get, post, qs } from '../client.ts';

const BASE = '/industry-bundles';
export const industryBundlesKey = ['industry-bundles'] as const;

export function useIndustryBundles() {
  return useQuery({ queryKey: industryBundlesKey,
    queryFn: async () => (await get(BASE, IndustryBundleListResponseSchema)).bundles ?? [] });
}
/** projectId: the project chosen for the playbook cards; the preview's blockers depend on it. */
export function useIndustryBundlePreview(id: string | null, projectId?: string) {
  return useQuery({ queryKey: [...industryBundlesKey, id, projectId ?? null], enabled: !!id,
    queryFn: () => get<IndustryBundlePreview>(`${BASE}/${id}${qs({ projectId })}`, IndustryBundlePreviewSchema) });
}
// Where bundle members show: rules (ledger, rule packs), playbooks (brief playbooks, schedules),
// knowledge templates and sample data (documents). Journey templates are static: no key.
const AFFECTED = [industryBundlesKey, ['rule-packs'], ['ledger'], ['brief-playbooks'], ['schedules'], ['documents']] as const;
function useAfterBundleChange() {
  const qc = useQueryClient();
  return () => { for (const k of AFFECTED) void qc.invalidateQueries({ queryKey: k }); };
}
export function useInstallIndustryBundle() {
  const after = useAfterBundleChange();
  return useMutation({
    mutationFn: ({ id, projectId }: { id: string; projectId?: string }) =>
      post<IndustryBundleInstallResult>(`${BASE}/${id}/install`, projectId ? { projectId } : {}, IndustryBundleInstallResultSchema),
    onSuccess: after });
}
export function useRemoveIndustryBundle() {
  const after = useAfterBundleChange();
  return useMutation({
    mutationFn: (id: string) => post<IndustryBundleRemoveResult>(`${BASE}/${id}/remove`, {}, IndustryBundleRemoveResultSchema),
    onSuccess: after });
}
```

Check that `qs({ projectId: undefined })` gives `''` (read `client.ts:68`). Do not use a bare `invalidateQueries()`. The timezone is left to the server default (the org time zone).

Shapes the UI reads (from `packages/shared/src/api/ledger.ts`):

- **Preview** = summary + `rulePack: RulePackPreview` (rules with `status: new | installed | edited | covered | may_conflict`, `existing[]`, `enforcedBy`), `playbooks[] { key, name, description, status: new | present }`, `knowledgeTemplates[]` and `sampleData[] { id, title, status: new | present, existingId }`, `journeyTemplates[] { id, name }` (no status), `blockers[] { code: project_required | no_project, message }`.
- **Install result** = `status: installed | already_installed`, `rulePack: RulePackInstallResult | null` (null: the pack was installed before the bundle, or a no-op), `playbooks { added[], present[] }` (keys and schedule ids), `documents { added[] { memberId, docId, kind }, present[] }`, `journeyTemplates: string[]` (ids). There are ids only, no titles.
- **Remove result** = `removed { ruleEntries[], schedules[], documents[] }` (ids), `kept[] { kind: rule | playbook | document, id, title, reason: edited | present_before_install }`, `gone[] { kind, id }` (already removed by the org before the uninstall).

Guard every array with `?? []` (a schema mismatch is only a warning, see section 5).

### 4.3 Component structure (`IndustryBundlesDialog.tsx`)

```
IndustryBundlesDialog({ open, onOpenChange })
  Dialog size="lg" title="Industry bundles"
    description={t.reword(`Everything one industry needs in one install: ${t.standingOrders}, playbooks, knowledge templates, sample data and journey templates.`)}
  bundleId ? <BundlePreview bundleId onBack/> : <BundleList onOpen/>
  on close: reset bundleId, the chosen project and the result (same as RulePacksDialog)
```

**BundleList**: `useIndustryBundles()`, `ListSkeleton label="Loading the bundles"`, `ErrorBox` with retry, and `EmptyState` "No industry bundles yet" when the list is empty. Each row is `<li data-testid="industry-bundle">` with a full-width `<button>` using the `PackList` classes, including `[@media(pointer:coarse)]:min-h-11`. A row shows:
- the name, `<Badge tone="green">Installed</Badge>` when `installed`, and the description;
- a contents line `data-testid="bundle-contents"` built from `counts` with `plural()`, leaving out zero counts: for example "12 rules · 2 playbooks · 3 knowledge templates · 2 sample documents · 1 journey template". Use `t.standingOrders` for "rules".

**BundlePreview**: `useIndustryBundlePreview(id, projectId)`, the install and remove mutations, `useCanManageOrg()`, `useOrgTerms()`, `useProjects()`, `useToast()`.
- The "All bundles" ghost button goes back.
- Show the name, the description and a `Badge` "Installed" when installed.
- Show the `BundleResult` Callout if a result is set.
- **Groups** come from a small adapter, `groupsOf(preview)`, that turns the preview into a list of `{ kind, label, items: { key, title, status, line, existing?, enforcedBy? }[] }`. Each group is a `<section aria-label={label}>` with an `h4`, and empty groups are left out. In order:
  - `rule`, label `t.StandingOrders`, items from `preview.rulePack.rules`. The line comes from the shared `statusLine(rule)`, and the `EnforcedByBadge` shows when `enforcedBy` is set.
  - `playbook`, label "Playbooks", items from `preview.playbooks` (title = `name`). `new` gives "Will be added, switched off", and `present` gives "Already set up, left as it is".
  - `knowledge_template`, label "Knowledge templates", and `sample_data`, label "Sample data". `new` gives "Will be added to Documents", and `present` gives "A document with this title already exists, left as it is".
  - `journey_template`, label "Journey templates", items from `preview.journeyTemplates` (title = `name`), status `available`, line "Always available in the Journeys gallery". This is true to the server: journey templates are static and not installed per org (section 8, A7).
- Each item is `<li data-testid="bundle-item" data-kind=…>` with the title and a status line `data-testid="bundle-item-status" data-status=…`.
- **Flags (AC 2)**: when any rule is `may_conflict` or `covered`, show a `Callout tone="warning"` above the groups: "2 rules may contradict or repeat your own rules. They are marked below." Use `t.reword` and the right plural. Only rules carry contradictions. `present` documents and playbooks are near-duplicates by title or key and are already marked on their rows.
- Show the enforced-by legend (copy it from `PackPreview`) only when there are rules.
- **Blockers (new)**, managers only, and only when not installed:
  - `project_required`: show a `Select label="Project"` with the active projects from `useProjects()` (the `BriefPlaybookDialog` pattern) and the hint "Playbook cards are made in this project". Choosing a project sets `projectId`. The preview refetches with `?projectId=` and the blocker clears. Install stays disabled while a blocker remains.
  - `no_project`: show a `Callout tone="warning"` with the server's message ("the organization has no project to make the cards in"). Install stays disabled.
  - A native `select` opens the system picker, not the soft keyboard. It keeps the 44 px coarse-pointer height.
- `ErrorBox error={install.error ?? remove.error}`. A 403, 409 or 400 from the server is shown here as text, not a crash (AC 5).
- `canManage &&` buttons in `flex flex-wrap gap-2`:
  - when not installed: `<Button variant="primary" loading={install.isPending} disabled={blockers.length > 0}>Install bundle</Button>`. On click, call `install.mutate({ id, projectId }, { onSuccess: r => { setResult({ kind: 'install', r, preview: snapshot }); toast.success(...) } })`. Snapshot the current preview before the call, because the refetch flips every status and the result needs titles and counts from it. Button `loading` blocks double clicks, so the endpoint is called once.
  - when installed: `<Button variant="danger-ghost">Uninstall bundle</Button>`, which opens the `ConfirmDialog`.
- `ConfirmDialog`: title `Uninstall ${name}?`. Description: `t.reword('This removes the ${t.standingOrders}, playbooks, knowledge templates and sample data this bundle added. Anything your organization created or edited is kept. Journey templates stay in the Journeys gallery.')`. `confirmLabel="Uninstall bundle"`, `pending={remove.isPending}`. On success: close the dialog, `setResult({ kind: 'uninstall', r })`, and toast. On error: close the dialog. The ErrorBox shows the message (for example 409 "the Accounting firms bundle is not installed").
- Hold the result in `IndustryBundlesDialog`, keyed by bundle id, so it survives the refetch and is cleared on back or close.

**BundleResult** (`Callout tone="success" role="status" data-testid="bundle-result"`):
- **install, `status: 'installed'`**: title "Bundle installed". Body, from counts: "Added 12 rules, 2 playbooks (switched off: turn them on in Schedules), 3 knowledge templates and 2 sample documents." Use `rulePack?.added.length ?? 0`, `playbooks.added.length`, and `documents.added` split by `kind`. Then:
  - when `rulePack === null`: "The rules were already installed, so they were left as they are."
  - when `rulePack.skipped` is not empty: "N rules were skipped because your own rules cover them", followed by the `existingTitle`s (in a `Disclosure` when there are more than 3);
  - when `playbooks.present` or `documents.present` is not empty: "N items were already there and were left as they are". Titles come from the preview snapshot by key or member id. Fall back to the count when a title is missing.
  - journey templates: "Journey templates in the Journeys gallery: <names from the snapshot>".
- **install, `status: 'already_installed'`**: title "Already installed", body "Nothing changed." (this happens when another manager installed it first).
- **uninstall**: title "Bundle uninstalled". Body "Removed N items" (the sum of the three `removed` arrays). Kept items go in `<ul data-testid="bundle-kept">`, each `<li>` with the title, the kind label (`t.StandingOrders` singular wording "rule", "playbook", "document") and the reason: `edited` gives "you edited it", and `present_before_install` gives "it was there before the bundle". When `kept` is empty: "Nothing was kept." When `gone` is not empty: "N were already removed."

**Accessibility and touch.** Every control is a real `<button>` or a labelled `Select`. Dialogs use Radix (focus trap, Escape), and ConfirmDialog gives Cancel the initial focus. There is no text input, so the soft keyboard never opens. On small screens the Dialog is a bottom sheet. Rows meet the 44 px coarse-pointer target. Status is text, not colour only.

### 4.4 Ledger header (unchanged)

```tsx
<Button variant="secondary" onClick={() => setPacks(true)}>Rule packs</Button>
<Button variant="secondary" onClick={() => setBundles(true)}>Industry bundles</Button>
<Button variant="primary" onClick={() => setAdding(true)}>Add entry</Button>
…
<IndustryBundlesDialog open={bundles} onOpenChange={setBundles} />
```

Members see the button too (requirement 4).

## 5. Risks

- **Journey templates are global.** They are always in the gallery for every org, installed or not. The AC "become visible in their usual screens" holds, but they never disappear on uninstall. The UI says so honestly (preview line, confirmation text, user guide). It must not filter in the client (card constraint). Per-org availability is a server follow-up, suggested on the backlog.
- **Project choice.** An org with several active projects must pick one before install. `useProjects()` lists the projects the user is a member of. The server lists all active projects of kind `project` in the org. If a manager picks a project the server rejects, the 400 `project_not_found` shows in the ErrorBox.
- **The result has ids only.** Titles come from the preview snapshot taken before install. If the snapshot is missing (should not happen), fall back to counts.
- **A schema mismatch is not an error.** `client.ts:54` only warns. Guard arrays with `?? []`.
- **The `statusLine` move** touches `RulePacksDialog`. Run `rule-packs.test.tsx`.
- **Partial install.** A rule pack installed before the bundle gives `rulePack: null` on install and is left alone on uninstall. The result wording covers it.

## 6. Tests

### 6.1 Component tests: `apps/web/src/test/industry-bundles.test.tsx` (builder)

Copy `me()`, `json()`, `wrap()` and the fetch stub with its `calls` log from `rule-packs.test.tsx`. Stub the real paths with bodies that parse with the real schemas: `GET /api/industry-bundles` (accounting installed=false, law installed=true, both with `counts`), `GET /api/industry-bundles/:id[?projectId=]`, `POST /api/industry-bundles/:id/install`, `POST /api/industry-bundles/:id/remove`, and `GET /api/projects` for case 9.

1. **The list shows contents and installed state** (AC 1): open via the Ledger "Industry bundles" button. Expect 2 `industry-bundle` rows. The accounting `bundle-contents` names its counts ("12 rules", "2 playbooks", …). The law row has "Installed" and the accounting row does not.
2. **The preview shows additions and flags** (AC 2): open accounting. The groups are regions "Rules", "Playbooks", "Knowledge templates", "Sample data", "Journey templates" (business mode). A `may_conflict` rule shows `May contradict "…"`, a `covered` rule shows `Covered by your rule "…"`, a `present` document shows "already exists", and the warning Callout counts the 2 flagged rules.
3. **Install calls the endpoint once and the bundle then shows as installed** (AC 3): click "Install bundle". Expect exactly one `POST /api/industry-bundles/accounting/install` in `calls`. After the stub flips accounting to installed, `bundle-result` shows "Bundle installed" and the added counts, "Install bundle" is gone, "Uninstall bundle" is present, and back in the list the accounting row has "Installed".
4. **Uninstall asks first and shows kept items** (AC 4): open law and click "Uninstall bundle". The confirmation says "created or edited is kept", and no POST has been made yet. Confirm, then expect one `POST /api/industry-bundles/law/remove`. `bundle-kept` lists the kept item with "you edited it", and the list row no longer has "Installed".
5. **Members get no controls** (AC 5): with `role = 'member'`, the list and preview render, and there is no "Install bundle", "Uninstall bundle" or "Project" picker.
6. **A 403 is shown as an error** (AC 5): role owner, the install stub returns `json({ error: { code: 'forbidden', message: 'only the organization Owner and Admins can install or remove industry bundles' } }, 403)`. Install shows a `role="alert"` with the message, and the preview is still rendered.
7. **Loading and error states** (AC 6): the list stub returns 500. The ErrorBox shows with "Try again", and clicking it refetches (a second GET in `calls`).
8. **Business wording** (AC 6): with `mode = 'business'`, the description and group label say "rules". With `mode = 'dev'` they say "standing orders".
9. **Project blocker** (new): the preview stub returns `blockers: [{ code: 'project_required', … }]` without `projectId` and `[]` with it. Install is disabled. Choose a project in "Project", and the preview is fetched with `?projectId=`. Install is enabled, and the POST body has that `projectId`.

In `rule-packs.test.tsx`, extend the "software-default org too" case with `getByRole('button', { name: 'Industry bundles' })`.

Run: `cd apps/web && npx vitest run src/test/industry-bundles.test.tsx src/test/rule-packs.test.tsx`, then the full web suite, `pnpm -r typecheck` and `npx biome check --write` on the touched files.

### 6.2 E2E: `e2e/tests/industry-bundles.spec.ts` (tester, local stack)

In a business-mode org with an owner and one active project:
1. Rules & decisions → "Industry bundles" → open "Accounting" → "Install bundle". Expect "Bundle installed".
2. Close the dialog. The ledger list shows the accounting rules (the pack label from the accounting rule pack).
3. Documents: the accounting knowledge templates (kind "Template") and sample data (kind "Sample data") are listed.
4. Journeys → "New journey": the accounting template is listed (GWP-232 listitem filter pattern). Templates are static, so this is only a visibility check.
5. Back to Industry bundles → Accounting → "Uninstall bundle" → confirm. Expect "Bundle uninstalled". The rules and documents are gone from their screens. **Do not assert that the journey template is gone**: it stays by design today (section 5).
6. Repeat for Law.
7. Member login: the dialog opens and shows no Install or Uninstall buttons.

## 7. Acceptance criteria → design

| AC | Design |
|---|---|
| A manager sees the accounting and law bundles with their contents and installed state | `BundleList`: name, description, `bundle-contents` from `counts`, `Installed` badge. Test 1 |
| Preview shows the items install would add and flags contradictions/near-duplicates | `groupsOf()` groups, status line per item, rule flags in a warning Callout, `present` items marked. Test 2 |
| Install calls the endpoint once; the bundle then shows as installed; items show in their usual screens | One `useInstallIndustryBundle` call, button `loading`, project picker for blockers, invalidation of `AFFECTED`. Tests 3 and 9, E2E steps 1-4. Journey templates are always visible (section 5) |
| Uninstall asks for confirmation, calls the endpoint, shows kept items, then shows not installed | `ConfirmDialog`, `POST …/remove`, `BundleResult` with `bundle-kept`, invalidation. Test 4, E2E step 5 |
| A non-manager has no controls; a server 403 shows as an error | `canManage &&` gate, `ErrorBox`. Tests 5 and 6 |
| Loading and error states use ErrorBox/Badge/Dialog; business labels | `ListSkeleton`, `ErrorBox` with retry, `Badge`, `Dialog`/`ConfirmDialog`/`Callout`/`Select`, `useOrgTerms`. Tests 7 and 8 |
| Requirement 5: record the placement | Section 3.1, option C |

## 8. Assumption review against the landed GWP-233

| # | Assumption | Result | What changed |
|---|---|---|---|
| A1 | List returns id, industry, name, description, installed and per-kind counts, readable by any member | **Holds.** `GET /api/industry-bundles` gives `{ bundles }` with `counts { rules, playbooks, knowledgeTemplates, sampleData, journeyTemplates }`, behind `assertMember` | `BASE = '/industry-bundles'` |
| A2 | Preview gives a flat item list per kind with rule pack statuses and `existing[]` | **Did not hold.** Rules are a nested `rulePack: RulePackPreview`. Playbooks and documents have their own `new` / `present` status. Journey templates have no status. There is a new `blockers[]` and a `?projectId=` query | `groupsOf()` adapter, per-kind status lines, flags from rules only, and a new project picker for `project_required` / `no_project` (test 9) |
| A3 | Install returns added and skipped items with titles, or a clear no-op | **Partly.** The no-op is clear (`status: 'already_installed'`), but the result has ids and keys only, with `rulePack: null` when the pack was there before | Counts in the result. Titles come from a preview snapshot taken before install. Extra wording for `rulePack: null` |
| A4 | `POST …/uninstall` returns removed and kept items with reason (edited or org-created); not-installed gives a 4xx | **Partly.** The verb is `/remove`. Kept reasons are `edited` / `present_before_install`. There is an extra `gone[]`. Not-installed gives 409 `bundle_not_installed` (holds) | Hook `useRemoveIndustryBundle` calls `/remove`. Reason wording mapped. "N were already removed" line |
| A5 | Manager-only actions return 403 with the standard body | **Holds** (`forbidden(MANAGER_ONLY)`) | Test 6 uses the real message |
| A6 | Zod schemas and types exported from `@aom/shared` | **Holds** (`packages/shared/src/api/ledger.ts`) | None |
| A7 | Bundle journey templates appear in `GET /api/journey-templates` after install and disappear after uninstall | **Did not hold.** The endpoint returns the static list to every org. Install and remove only record the ids | Preview line "Always available in the Journeys gallery". The confirmation says templates stay. E2E only checks visibility, not removal. No client filtering. Per-org availability is suggested as a backlog follow-up |
| A8 | Members show under ledger, rule-packs, journey-templates, brief-playbooks, schedules, playbooks, capabilities, vaults | **Did not hold.** Knowledge templates and sample data are Documents (`['documents']`). Playbooks are brief playbooks and schedules. Nothing lands in playbooks, capabilities, vaults or journey templates | `AFFECTED` = industry-bundles, rule-packs, ledger, brief-playbooks, schedules, documents. E2E checks Documents for templates and sample data |

## 9. Out of scope and follow-ups

- Per-org journey template availability (install adds the bundle's templates to the gallery, uninstall hides them). This is a server change, suggested on the backlog.
- An industry filter in the Journeys gallery.
- A link from the rule pack "Industry" section to the matching bundle.
- A time zone choice for the bundle's playbooks (the server default, the org time zone, is used).
