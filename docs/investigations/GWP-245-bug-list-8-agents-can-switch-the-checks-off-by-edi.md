# GWP-245: check configuration as a built-in high-risk category

## Question

Agents can weaken or switch off the project's checks by editing the files that define them (package.json scripts, lint,
typecheck, test-runner and format configuration, git hooks). Those paths are not high risk today, so such a change goes
through the normal flow. How do we add a built-in high-risk category for them so every existing consumer (merge gate and
owner approval, second review, shift brief and handoff, design gate, deploy risk) treats them like the existing
categories, without changing any of that logic?

## Findings

### The shared module

`packages/shared/src/workflows/high-risk.ts` holds the single definition:

- `HighRiskCategory = 'auth' | 'data' | 'tenancy'` and `HIGH_RISK_RULES` (id, label, globs).
- `HIGH_RISK_EXEMPT_GLOBS` (`docs/**`, `**/*.md`, `e2e/**`, `**/test/**`, `**/tests/**`, `**/__tests__/**`,
  `**/*.test.*`, `**/*.spec.*`, `deploy/**`, runner sandbox, devops and policy files). `highRiskCategoriesOf` returns `[]`
  for an exempt path **before** any rule is tried.
- `globToRegExp` (case-insensitive, `**/` = zero or more directories, `.` is escaped) and `normalise` (backslashes, a
  leading `./` or `/`).
- `isHighRiskPath`, `isHighRiskPaths`, `highRiskPaths`, `highRiskSummary` (categories plus labels, in rule order).

### Consumers (all go through `highRiskCategoriesOf` / `isHighRiskPath`)

| Consumer | Where | What it does with the rules | Change needed |
| --- | --- | --- | --- |
| Build handoff flag | `apps/server/src/commands/shifts.ts` `leanHandoff` (~l.1035) | `highRiskPaths(msg.changedPaths)` sets `high_risk` / `high_risk_paths` on the card | none |
| Second review | `shifts.ts` `ReviewApproved` (~l.432) | `card.high_risk === true` needs 2 approvals | none |
| Owner approval | `packages/shared/src/cards/lean-v6.ts` `ownerApprovalDecision` | `highRisk` gives `required: true, reason: 'high_risk'` | reason text only |
| Handoff thread note | `shifts.ts` ~l.405 | `highRiskSummary(paths).labels` | improve to list files (R5) |
| Shift brief | `apps/server/src/runner-gateway/brief.ts` ~l.595, `packages/shared/src/prompt/shift-prompt.ts` ~l.491 | `{ paths, labels }`; the prompt prints the labels and every path | none |
| Design gate | `packages/shared/src/workflows/design-gate.ts` | `isHighRiskPath` on path tokens of the card text (no project risk map) | reason text only |
| Deploy risk | `packages/shared/src/platform/index.ts` `classifyDeployRisk` | maps each category through `CATEGORY: Record<HighRiskCategory, RiskCategory>` | **one map entry (typecheck)** |
| Approval desk / web | `ApprovalReview.tsx`, `DesignGatePanel.tsx` | render `highRiskPaths` only, no category label map | none |
| Web copy | `apps/web/src/components/OwnerApprovalPanel.tsx` l.33-35 | hard-coded list of categories in the explanation | copy only |

`review-risk.ts` (`riskOf`, `isHighRisk`, `mergeRisk`) works on the reviewer's own risk call, not on paths, and is not
affected. `review-settings.ts` reuses `globToRegExp` only; the project path-to-risk map keeps exactly its current power
(it replaces the built-in rules for the design gate when set, nothing else). `component-rules.ts` does not use the rules.

### Persistence

The category is **not** persisted as a closed enum anywhere:

- Card events store `highRisk: boolean` and `highRiskPaths: string[]` (`events/card.ts` l.206), the design gate stores
  paths (`events/design-gate.ts`).
- The deploy `RiskCategory` is a plain TypeScript union; the DTOs use `z.array(z.string())`; the column
  `platform_deploy_audit.risk_categories` is `text[]` (`migrations/2160_platform_team.sql` l.72).
- The runner protocol brief carries `{ paths: string[], labels: string[] }` (`protocol/runner.ts` l.639).

So no migration and no event change. Old events parse as before.

### Exemptions hide check configuration today

Running the real matcher (read-only, against this worktree) on the proposed globs: every R2 example matches, no look-alike
matches, and none of the R2 examples already falls in another category. But these real files are **exempt** before any
rule is tried, so a check-config rule behind the exemption would miss them:

- `e2e/playwright.config.ts`, `e2e/package.json`, `e2e/tsconfig.json` (this repository, `e2e/**`)
- any `test/tsconfig.json`, `tests/vitest.config.ts` (`**/test/**`, `**/tests/**`)
- `deploy/package.json`, `docs/package.json` of a docs site (`deploy/**`, `docs/**`)

`e2e/playwright.config.ts` is exactly the kind of file the card is about (it decides which specs run, retries, timeouts).
The exemptions exist so that test, docs and deploy *content* is not high risk by itself; check configuration inside those
folders is not content. So the new rule must be evaluated **regardless of the exemption list**. The existing categories keep
the exemption exactly as today (R6).

Accepted side effect: a committed test fixture named like a check file (`test/fixtures/app/package.json`) becomes high
risk. This repository has none (`git ls-files` lists 20 check-config files, all real configuration).

### Case sensitivity

R2 says "case-sensitively as on disk". The existing `globToRegExp` is case-insensitive and the constraint says to reuse it
rather than add a second matcher. Case-insensitive is a strict superset (`Directory.Build.props` and
`directory.build.props` both match, which is also what MSBuild on Windows does). None of the look-alikes becomes a match.
Recommendation: reuse `globToRegExp` as it is; do not add a case-sensitive variant.

### How often owner approval will fire

Since 2026-09-01, 125 of 2,069 non-merge commits (about 6 %) touched one of this repository's check-config files: most are
dependency bumps and E2E setup. Card-level the share is higher than commit-level but still a minority, so owner approval
will not fire on most cards. The card accepts dependency-only `package.json` edits as high risk, so no question is raised.
Deploys of the platform team whose fix diff includes a version bump in `package.json` will also need the platform
organisation's high-risk approval (R4 asks for deploy risk to count; noted for the release notes).

## Options

1. **New rule in `HIGH_RISK_RULES`, behind the exemption list** (the simplest change). Misses `e2e/playwright.config.ts`
   and other configuration in test, docs and deploy folders. Rejected: the main gap the card names would stay open in this
   very repository.
2. **New rule that is evaluated regardless of the exemption list** (a per-rule flag). Small, deterministic, no change to
   the existing categories. **Recommended.**
3. **A separate list and function outside `HIGH_RISK_RULES`.** Every consumer would need a second call, which breaks R4
   ("no per-consumer changes"). Rejected.
4. **Content-aware detection** (only `scripts` changes in package.json). Out of scope by the card.

## Recommendation and design

### 1. `packages/shared/src/workflows/high-risk.ts` (primary change)

```ts
export type HighRiskCategory = 'auth' | 'data' | 'tenancy' | 'check-config';

export interface HighRiskRule {
  id: HighRiskCategory;
  label: string;
  globs: readonly string[];
  /** Why the category is high risk, for the handoff note (optional). */
  why?: string;
  /** Matched even inside the exempt folders (tests, docs, deploy): configuration there still decides what the checks do. */
  ignoresExemptions?: boolean;
}
```

Append (keep it last so existing summaries keep their order):

```ts
{
  id: 'check-config',
  label: 'check configuration (lint, typecheck, test, format and git-hook settings)',
  why: 'a change here can switch off or weaken the lint, typecheck, test or format checks, so their results need a human look',
  ignoresExemptions: true,
  globs: [
    // Node scripts and task runners
    '**/package.json', '**/turbo.json', '**/nx.json',
    // ESLint
    '**/eslint.config.*', '**/.eslintrc', '**/.eslintrc.*', '**/.eslintignore',
    // Biome
    '**/biome.json', '**/biome.jsonc',
    // Prettier
    '**/.prettierrc', '**/.prettierrc.*', '**/prettier.config.*', '**/.prettierignore',
    // TypeScript
    '**/tsconfig.json', '**/tsconfig.*.json', '**/jsconfig.json',
    // Test runners
    '**/vitest.config.*', '**/vitest.workspace.*', '**/jest.config.*', '**/playwright.config.*',
    // Git hooks and staged checks
    '**/.husky/**', '**/.lintstagedrc', '**/.lintstagedrc.*', '**/lint-staged.config.*', '**/lefthook.yml', '**/lefthook.yaml',
    // .NET analyzers and build
    '**/Directory.Build.props', '**/Directory.Build.targets', '**/.editorconfig', '**/.globalconfig', '**/*.ruleset',
    // Python
    '**/pyproject.toml', '**/setup.cfg', '**/ruff.toml', '**/.ruff.toml', '**/mypy.ini', '**/.flake8',
  ],
},
```

Every glob starts with `**/` and ends in a full file name (or `name.*`), so matching is anchored to the last segment at any
depth (`**/.husky/**` to the folder segment). `globToRegExp` escapes the dots, so `package-lock.json`,
`src/package-json-utils.ts`, `docs/tsconfig-guide.md`, `src/eslint-rules.md` and `pnpm-lock.yaml` do not match (verified).

`HIGH_RISK_GLOBS` (flatMap of all rules) picks the new globs up automatically.

Compile the flag and change `highRiskCategoriesOf`:

```ts
const COMPILED = HIGH_RISK_RULES.map((r) => ({ id: r.id, ignoresExemptions: r.ignoresExemptions === true, res: r.globs.map(globToRegExp) }));

export function highRiskCategoriesOf(path: string): HighRiskCategory[] {
  const p = normalise(path);
  const exempt = EXEMPT.some((re) => re.test(p));
  return COMPILED.filter((c) => (!exempt || c.ignoresExemptions) && c.res.some((re) => re.test(p))).map((c) => c.id);
}
```

Behaviour of the three existing rules is identical (an exempt path still returns nothing for them).

Add one pure helper for R5 and export it from `workflows/index.ts`:

```ts
/** The categories with their matched paths, in rule order (for the handoff note and the review text). */
export function highRiskByCategory(paths: readonly string[]): Array<{ category: HighRiskCategory; label: string; why?: string; paths: string[] }>;

/** One line for the card thread: "check configuration (...): package.json, apps/web/tsconfig.json; data and migrations: x.sql". */
export function highRiskNotice(paths: readonly string[], maxPerCategory = 10): string; // "and N more" past the cap
```

`highRiskSummary` keeps its signature and output (existing tests and the protocol depend on it). Update the module header
comment (and the `isHighRiskPath` doc comment) to name the new category and why it ignores the exemption list.

### 2. `packages/shared/src/platform/index.ts` (needed for typecheck)

```ts
export type RiskCategory = 'auth_permissions_secrets' | 'data_migrations' | 'tenancy_billing' | 'check_configuration';
const CATEGORY: Record<HighRiskCategory, RiskCategory> = { ...existing, 'check-config': 'check_configuration' };
```

Safe: `RiskCategory` is not validated by a zod enum, DTOs take strings, the column is `text[]`. The deploy desk text
(`deploy.ts` l.283 `replaceAll('_', ' ')`) reads "check configuration". `classifyDeployRisk` strips only a leading `./` and
`/`, then calls `highRiskCategoriesOf`, which normalises again; no change.

### 3. Handoff thread note (`apps/server/src/commands/shifts.ts` ~l.405), R5

Replace the labels-only text with the per-category list:

```ts
`${card.ref} touches high-risk paths (${highRiskNotice(built.highRiskPaths)}): it needs a second Opus review and the owner's approval.`
```

No logic change; the brief (`brief.ts`) keeps `{ paths, labels }` and the shift prompt already prints the labels and every
path, so the runner protocol does not change.

### 4. Reason texts and copy (text only)

- `packages/shared/src/cards/lean-v6.ts` `OWNER_APPROVAL_REASON_TEXT.high_risk` and
  `packages/shared/src/workflows/design-gate.ts` `DESIGN_GATE_REASON_TEXT.high_risk`: append the new category, e.g.
  `'the change touches high-risk paths (authentication, permissions or secrets, data and migrations, tenancy or billing, or the configuration of the checks: lint, typecheck, test, format or git hooks)'`.
  No test asserts these literals (checked).
- `apps/web/src/components/OwnerApprovalPanel.tsx` l.33-35: add "or the configuration of the checks (package.json
  scripts, lint, typecheck, test and format settings, git hooks)". No web test asserts this sentence.
- `packages/shared/src/events/card.ts` l.205 comment.
- `docs/USER-GUIDE.md` l.1431 (High risk) and l.1437 (Design gate): name the new category. `docs/guide/guide.html` is
  generated from the guide at release; do not edit it by hand.
- Leave `packages/shared/src/roles/builtin.ts` (reviewer prompt l.82) alone: changing a built-in role prompt needs a role
  version bump and touches the role tests; the reviewer gets the flag and labels from the brief anyway.

### What must not change

- `ownerApprovalDecision`, `designGateDecision`, `designHighRiskPredicate`, the second-review count, `checkDeploy`,
  `review-risk.ts`, the review-settings map. No opt-out: there is no per-card or per-agent switch, and the flag stays
  computed by the server from `changedPaths`.
- `highRiskSummary` output for paths of the existing categories; `HIGH_RISK_EXEMPT_GLOBS` content.

## Acceptance criteria mapping

| AC | Design | Test |
| --- | --- | --- |
| 1. `package.json`, `apps/web/package.json`, `packages/shared/package.json` are high risk with check-config | `**/package.json` glob | shared table test |
| 2. one root and one nested example per R2 family | the glob list above | shared table test, one row per family at root and nested, including `e2e/playwright.config.ts` and `apps/server/test/tsconfig.json` (exemption bypass) |
| 3. look-alikes not matched | anchored globs, escaped dots | shared negative table: `src/package-json-utils.ts`, `docs/tsconfig-guide.md`, `src/eslint-rules.md`, `package-lock.json`, `pnpm-lock.yaml`, plus `apps/web/src/App.tsx` |
| 4. same handling as an existing category at merge gate / review risk | unchanged consumers read the new category | server test modelled on `apps/server/test/code-v6.test.ts` "high risk" (l.303): changed paths `['apps/web/tsconfig.json']` give `high_risk: true`, two approvals, `owner_approval_required: true, reason 'high_risk'`; `['apps/web/src/App.tsx']` does not. Plus a DB-free shared test: `ownerApprovalDecision({ highRisk: isHighRiskPaths(['apps/web/tsconfig.json']), ... })` is `{ required: true, reason: 'high_risk' }` |
| 5. brief and handoff summary list the category with the files | `highRiskNotice`, brief `{paths, labels}` | shared test for `highRiskNotice(['package.json','apps/server/migrations/1.sql'])`; server test asserts the brief `highRisk.labels` contains the check-config label and `paths` contains `package.json`, and the thread note names the label and the file |
| 6. existing matches and suites unchanged | flag only on the new rule | `lean-v6.test.ts`, `design-gate.test.ts`, `review-settings.test.ts`, size-verdict and component-rules suites pass unchanged; add a multi-category test (`x/auth/login.ts` + `tsconfig.json` gives both, in rule order) |
| 7. lint and typecheck pass | `CATEGORY` entry added | `pnpm lint`, `pnpm typecheck` |

## Risks

- **Server tests need Postgres** (`apps/server/vitest.config.ts` uses `aom_test` on port 5433). If the sandbox has no
  database, run the shared and web suites, and ask DevOps to run the server suites (`code-v6.test.ts`,
  `design-gate*.test.ts`, `platform-team*.test.ts`) and record the result in the handoff.
- **E2E specs** that drive a card through build with real diffs could now hit owner approval if the diff includes
  `package.json`; none was found in the server tests, the E2E suite is left to the testers.
- **Platform deploys**: a fix diff with a `package.json` version bump now needs the platform high-risk approval.
- **Test fixtures** named like check files become high risk (none in this repository).
- **Design gate**: card text that names `apps/web/package.json` (a token with a `/`) now stops at the gate when the project
  has no risk map. A bare root `package.json` has no `/`, so it is not a path token there (same as today's rules).
