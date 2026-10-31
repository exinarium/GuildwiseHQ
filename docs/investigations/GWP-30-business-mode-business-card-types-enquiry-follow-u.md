# GWP-30 Business mode: business card types (enquiry, follow-up, document request, reminder, report, quote)

Design report. First written against `main` before GWP-27 (org mode flag) and GWP-33 (business roles) landed; revised
on 31 Oct 2026 after both landed (see section 9, assumption review).

## 1. Question

How do we add six non-technical card types, each with its own fields and a default workflow that never touches a
repository, branch, build, review or merge, so that:

- a business org offers only these types in the new-card picker and can run each card from created to done with no repository;
- a dev org (every org today) sees no change at all;
- the shared types stay additive so Guildwise Cloud still compiles?

## 2. Findings (what the engine already gives us)

| Area | File | Finding |
| --- | --- | --- |
| Card types | `packages/shared/src/cards/types.ts` | `CardType` is a `z.enum` of 8 values. The only exhaustive `Record<CardType, …>` is `DEFAULT_HOURS_PER_CARD` (`packages/shared/src/api/value.ts`). Guildwise Cloud (`core` submodule) has no `Record<CardType>` or switch on card types (grep: only `fold-code-v6.ts` passes `defaultCardTypes` through). |
| Custom workflows | `packages/shared/src/workflows/custom.ts` | `validateCustomWorkflow` requires `builtIn: false`, `fieldSet: 'custom'`, events `StageCompleted`/`CardSpecified` only, `data: 'none'`, `effect: 'none'`, a manual stage only as the first stage, and card types from `CardType` minus research/feed/regression. New enum values pass automatically. |
| Approval step | `validate.ts` rule 11/12, `commands/approval.ts`, `variant.ts:166` | A `human` stage with `purpose: 'approval'` uses `StageCompleted` outcomes `approve`/`send_back`, so it is allowed in custom workflows. `apps/server/test/approval-step.test.ts` already runs a custom workflow with an approval step end to end. |
| Done without merge | `projections/cards.ts:739` (`StageCompleted`) | A `StageCompleted` into a `terminal` stage sets `status='done'`, `finalized_at`. No finalize stage, no `CardFinalized`, no completion action is involved. |
| No repository | `schema.ts` `workflowUsesRepos`, `commands/cards.ts:284`, `card-repo.ts` | A workflow whose stages all have `worktree: 'none'` never takes a repo: `createCard` drops `repoId`, `needsRepoScoping` is false, BA repo scoping is skipped, the dispatcher's repo/env filters pass for `repo_id IS NULL`. Research cards run this way today. |
| Claiming | `validate.ts` rule 3 and `business_role_worktree`, `roles/schema.ts` `roleClaimsStage`, `roles/business.ts` | Every agent stage needs a `claimRole` that exists and claims `(workflowKey, stageId)`. GWP-33's seven business roles (`front_desk`, `follow_up_assistant`, `billing_clerk`, `compliance_officer`, `marketing_reputation`, `operations_analyst`, `personal_assistant`) already claim `{ workflowKey: '*', stageId: '*' }`; validation refuses them on any stage with `worktree ≠ 'none'`. Dispatch goes by the stage's `claimRole`. |
| Org mode (GWP-27) | `packages/shared/src/orgs/mode.ts`, `apps/server/src/orgs/mode.ts`, `apps/web/src/lib/orgMode.ts` | `isBusinessOrg(org)` is the single gate; `organizations.mode` is `'dev' | 'business'`; server `orgModeOf(db, orgId)`; web `useBusinessMode()`. `setOrgMode` (`commands/orgs.ts:138`) appends `OrgModeSet`; `OrganizationCreated` carries an optional `mode` (written by `acceptEvents` in `commands/invitations.ts`). GWP-27 guards repository, hire and pack-URL paths only; card creation and project workflows are untouched. |
| Workflows per project | `catalogue/project-workflows.ts`, `commands/project-workflows.ts` (`ProjectWorkflowsSet`) | A project enables extra workflows with `defaultCardTypes`; `resolveProjectCardWorkflow` picks the workflow for a type. The web picker (`CardNew.tsx:172`) is the union of the primary's and the enabled workflows' card types. |
| Org-scoped versions | `catalogue/boot.ts`, `projections/catalogue.ts` | `WorkflowVersionRegistered` with an `orgId` and `status: 'active'` inserts an org workflow directly (boot does the same with `orgId: null` for built-ins). |
| Card form | `CardFormFields.tsx:51` | `codeCard` is true for every field set except research/feed, so a custom-workflow card shows **Repository**, **Completion action** and **Docs needed**. GWP-27 added no business gate here. Custom fields render by kind (text, number, list, markdown). |
| Card detail | `CardDetail.tsx:222, 660-675` | GWP-27 hides DevOps/branch surfaces with `business = isBusinessOrg(...)`. Custom fields render from `fieldCatalogue(fieldSet, customFields)`. The completion row always shows `effectiveCompletionAction`, which falls back to the project default `merge`. |
| Brief / prompt | `runner-gateway/brief.ts:280, 312`; `prompt/instructions.ts:47, 66-74`; `prompt/shift-prompt.ts:246-307` | The brief always carries `completionAction` (project default `merge`) and `workingBranch`; the prompt always prints "Working branch", the worktree/push boundaries and the .NET/test rules. **Custom fields are not rendered in the shift prompt at all** (only `context`, `requirements`, … and mail-untrusted fields), so an agent would not see "Who asked" or "Question". The prompt is rendered by the runner from the shared package. |
| Type labels | `CardNew.tsx:264` | The type select prints the raw enum value. Workflow builder/editor and CEO actions use hard-coded dev lists (`['feature','bug','support','refactor','docs']`), so they do not change when the enum grows. |
| Field kinds | `CustomFieldSchema.type` | `text, markdown, list, number, boolean, url-list`. No date and no enum. |
| Research file | GWP vault `projects/gwp/docs/business-mode/2026-10-27-business-mode-game-plan.md` | Now readable. It names the six types (Engine needs 2, Phase 1 item 2) but has **no field table** for them; its role table and pattern table decide the role per type (4.2). |

## 3. Options

### Where the six default workflows live

| Option | How | Verdict |
| --- | --- | --- |
| A. Built-in workflows (`BUILTIN_WORKFLOWS`, `org_id NULL`, `builtIn: true`) | Registered at boot for everyone | Fails AC2 by construction (`not_custom`, `builtin_key`, and `fieldSet` must be `custom`). They would also appear in every dev org's workflow catalogue (AC4). **Rejected.** |
| B. Global rows with `builtIn: false` | Registered at boot with `org_id NULL` | Passes the validator but is a new half-built-in category; visible to dev orgs in workflow lists and project "enable workflow" lists (AC4). **Rejected.** |
| C. **Shipped definitions in shared, installed per business org** | Static `WorkflowDefinitionInput`s in `packages/shared/src/workflows/business.ts`; the server registers them as org-scoped active workflows and enables them on the org's projects when the org is business | Passes `validateCustomWorkflow` (they are ordinary custom workflows). Dev orgs never get a row. The owner can edit them in the workflow builder like any custom workflow. Uses only existing events. **Recommended.** |
| D. Templates only (`WORKFLOW_TEMPLATES`) | The owner instantiates each from the gallery | Not a "default workflow": a pilot would have to build six workflows before the first card. **Rejected** (the templates can still list them later). |

### Fields per type

| Option | Verdict |
| --- | --- |
| New built-in field sets (`FIELD_SETS.enquiry`, …) | Built-in field sets fail `validateCustomWorkflow` (`invalid_field_set`) and widen `BuiltinFieldSet`. **Rejected.** |
| **`customFields` on each default workflow** | This is the mechanism custom workflows already use; card detail and the form render them; required fields go on the agent stage's `requiredFields`. **Recommended.** |

Dates: add an **optional** `format: 'date'` to `CustomFieldSchema` (additive; absent = today). The form renders such a
text field as `<input type="date">` (native picker on phones and tablets, no typing on a soft keyboard) and stores
`YYYY-MM-DD`. Number fields (amount) use `inputMode="decimal"`. The workflow builder ignores `format` (if an owner
re-saves the workflow in the builder the field becomes a plain text field, which still works). No new `FieldKind`, so
`FIELD_TYPE_LABEL`, the builder and the editor stay unchanged.

### Roles for the agent step

| Option | Verdict |
| --- | --- |
| Reuse an existing dev role (`ba`, `writer`) | Wrong fit; the research file's role table decides. **Rejected.** |
| **One GWP-33 business role per type as the `prepare` step's `claimRole`** | GWP-33's roles already claim every stage (`*`), so no role change is needed; the mapping in 4.2 comes from the research file's role and pattern tables (owner confirmed the two inferred rows on 31 Oct 2026). **Recommended.** |

## 4. Recommendation and design

### 4.1 Shared: card types, labels, fields, workflows

**`packages/shared/src/cards/types.ts`** (additive):

```ts
export const CardType = z.enum([
  'feature', 'bug', 'support', 'refactor', 'docs', 'research', 'feed', 'regression',
  // Business mode (no repository): the default workflows are in workflows/business.ts.
  'enquiry', 'follow_up', 'document_request', 'reminder', 'report', 'quote',
]);

export const BUSINESS_CARD_TYPES = ['enquiry', 'follow_up', 'document_request', 'reminder', 'report', 'quote'] as const;
export type BusinessCardType = (typeof BUSINESS_CARD_TYPES)[number];
export const isBusinessCardType = (t: string | null | undefined): t is BusinessCardType =>
  (BUSINESS_CARD_TYPES as readonly string[]).includes(t ?? '');
/** UI labels of the business types (dev types keep showing their raw value, as today). */
export const BUSINESS_CARD_TYPE_LABELS: Record<BusinessCardType, string> = {
  enquiry: 'Enquiry', follow_up: 'Follow-up', document_request: 'Document request',
  reminder: 'Reminder', report: 'Report', quote: 'Quote',
};
```

Snake case keeps the values URL- and `?type=`-safe and matches the single-token style of the existing values.

**`packages/shared/src/api/value.ts`**: add the six keys to `DEFAULT_HOURS_PER_CARD` (it is `Record<CardType, number>`,
so shared does not compile otherwise). Suggested defaults: enquiry 0.5, follow_up 0.25, document_request 0.25,
reminder 0.1, report 2, quote 1. Do **not** add them to `VALUE_CARD_TYPES` (the dev Costs page stays as it is).

**`packages/shared/src/workflows/schema.ts`**: `CustomFieldSchema` gains `format: z.enum(['date']).optional()`.

**New `packages/shared/src/workflows/business.ts`** (export from `workflows/index.ts`):

```ts
export const BUSINESS_WORKFLOW_KEY: Record<BusinessCardType, string> = {
  enquiry: 'business-enquiry', follow_up: 'business-follow-up', document_request: 'business-document-request',
  reminder: 'business-reminder', report: 'business-report', quote: 'business-quote',
};
/** The GWP-33 business role that prepares the output of each type (research file role/pattern tables, see 4.2). */
export const BUSINESS_PREPARE_ROLE: Record<BusinessCardType, string> = {
  enquiry: 'front_desk',
  follow_up: 'follow_up_assistant',
  document_request: 'compliance_officer',
  report: 'operations_analyst',
  reminder: 'compliance_officer',
  quote: 'front_desk',
};
export const BUSINESS_WORKFLOWS: readonly WorkflowDefinitionInput[] = BUSINESS_CARD_TYPES.map(businessWorkflow);
export const isBusinessWorkflowKey = (k: string) => Object.values(BUSINESS_WORKFLOW_KEY).includes(k);
```

Use the role keys from `BUSINESS_ROLES` in `packages/shared/src/roles/business.ts` (import the keys or check them in a
test against `BUSINESS_ROLE_KEYS`; do not retype names).

Every workflow has the same four steps (no `worktree`, no `environment`, no build evidence, no finalize):

| Step id | Kind | Column | What happens | Outcomes |
| --- | --- | --- | --- | --- |
| `request` | manual (initial) | Request | The person fills the fields and starts the card | `specified` → `prepare` (`CardSpecified`) |
| `prepare` | agent, `claimRole: BUSINESS_PREPARE_ROLE[type]`, `worktree: 'none'`, `requiredFields` = the type's required fields, `maxShiftMinutes: 30` | Preparing | The agent writes the output (reply, follow-up message, request, reminder text, report, quote) and puts the full text in its handoff note | `done` → `approve` (`StageCompleted`) |
| `approve` | human, `{ purpose: 'approval', approver: { kind: 'starter' } }` | Approval | The person who started the card (project owner as fallback, Owner/Admins may act) approves the output or sends it back with a comment | `approve` → `done`; `send_back` → `prepare` (failure, `rework: true`) |
| `done` | terminal | Done | `status='done'` via `StageCompleted` | – |

`fieldSet: 'custom'`, `builtIn: false`, `version: 1`, `cardTypes: [type]`, `name` = the label ("Enquiry"). Done
criteria are plain sentences ("A reply to the question is written, complete and ready to send; the full text is in
the handoff note."); they are not playbook text. GWP-32 later adds a "send" step between `approve` and `done`;
GWP-34 adds its own workflows next to these. "Completion is an approved or sent output": in Phase 1 the approved output
is the completion.

**Fields** (`customFields`). The research file defines no field tables for these types, so the card's minimal lists
are final:

| Type | Key | Label | Type | Required on `prepare` |
| --- | --- | --- | --- | --- |
| enquiry | `whoAsked` | Who asked | text | yes |
| | `channel` | Channel | text (hint: e-mail, phone, WhatsApp, in person) | no |
| | `question` | Question | markdown | yes |
| | `dueBy` | Due by | text, `format: 'date'` | no |
| follow_up | `person` | Who | text | yes |
| | `about` | About what | markdown | yes |
| | `dueDate` | Due date | text, `format: 'date'` | no |
| | `linkedCard` | Linked card | text (hint: a card reference such as ABC-12) | no |
| document_request | `document` | Document | text | yes |
| | `fromWhom` | From whom | text | yes |
| | `deadline` | Deadline | text, `format: 'date'` | no |
| reminder | `what` | What | markdown | yes |
| | `remindOn` | When | text, `format: 'date'` | yes |
| | `forWhom` | For whom | text | yes |
| report | `subject` | Subject | text | yes |
| | `period` | Period | text | no |
| | `audience` | Audience | text | no |
| quote | `customer` | Customer | text | yes |
| | `scope` | Items / scope | markdown | yes |
| | `amount` | Amount | number | no |
| | `validUntil` | Valid until | text, `format: 'date'` | no |

The field `when` from the card is stored as `remindOn` and `who` as `person`, so the keys never read like the stage
`when` guard or a pronoun in code; the labels are the card's words.

### 4.2 Roles (GWP-33, landed)

No role change. The seven business roles already claim `{ workflowKey: '*', stageId: '*' }` and validation allows
them only on `worktree: 'none'` stages, which every `prepare` step is. Do **not** bump any role version or add
`claimableStages` entries.

The role per type (the `prepare` step's `claimRole`):

| Type | Role key | Source |
| --- | --- | --- |
| enquiry | `front_desk` | Role table: Front Desk works Respond |
| follow_up | `follow_up_assistant` | Role table: Follow-up Assistant works Chase (leads) |
| document_request | `compliance_officer` | Role table: Compliance Officer works Chase (documents) |
| report | `operations_analyst` | Role table: Operations Analyst works Draft (reports) |
| reminder | `compliance_officer` | **Inferred, owner confirmed 31 Oct 2026.** Remind is "dated register → reminders ahead of each date"; the deadline register is Compliance Officer's tool, and the 1.4.0 verticals (real estate, accounting, law) remind on deadlines. Front Desk's Remind is appointments only. |
| quote | `front_desk` | **Inferred, owner confirmed 31 Oct 2026.** No row names quotes; Respond ("Desk for priced") is the closest pattern, and Front Desk's "never price statements without approval" is met by the Approve step. Not Billing Clerk (payments and cash; never changes prices). |

The owner can change the role per workflow in the workflow builder. The handoff must say that reminder and quote were
inferred from the file and are not named in it.

A card only runs once the org has an agent in that role. Hiring is GWP-33's surface; this card adds nothing there.

### 4.3 Server

1. **Install for business orgs**: new `apps/server/src/catalogue/business-workflows.ts`

   ```ts
   /** Registers the shipped business workflows an org does not have yet and enables them on its projects. Idempotent. */
   export async function ensureBusinessWorkflows(tx: Tx, ctx: Ctx, orgId: string, projectIds?: string[]): Promise<AppendInput[]>
   ```

   - For each `BUSINESS_WORKFLOWS` def: if the org has **no** version of that key, validate it with
     `validateCustomWorkflow(def, orgRoleCatalogue, { builtinWorkflowKeys, departments })`; on errors log and skip
     (never register an invalid workflow); otherwise append `WorkflowVersionRegistered { orgId, key, version: 1,
     definition, status: 'active', draftedBy: { kind: 'system' } }`. An existing key (the owner edited it, or an
     org-made workflow already uses the key) is left alone.
   - For each project of the org (or `projectIds`): one `ProjectWorkflowsSet` keeping every enabled entry and adding
     the missing business keys with `defaultCardTypes: [type]` (the primary stays the primary).
   - Call sites (GWP-27 landed): `setOrgMode` in `commands/orgs.ts` when `mode === 'business'` (same transaction,
     after the `OrgModeSet` append); org creation in `acceptEvents` (`commands/invitations.ts`) when `mode` is
     `business`; `createProject` (`commands/projects.ts`) when `orgModeOf(tx, orgId) === 'business'`; and once at
     boot after `registerBuiltins` for every org with `mode='business'` (catches orgs switched before this landed).
     Switching back to dev changes nothing (no data lost; the dev picker hides the types, see 4.4).

2. **Card creation guard** (`commands/cards.ts` `createCard`, the place that resolves `def`): in a business org
   (`orgModeOf`) a card whose workflow uses repositories is refused: `409 business_mode_code_workflow`, "This
   organization works without code projects. Pick one of: Enquiry, Follow-up, Document request, Reminder, Report,
   Quote." This covers the API, chat and intake paths in one place. Dev orgs: no check. (GWP-27 added no card guard,
   so this is not a duplicate.)

3. **Completion**: `runner-gateway/brief.ts:280` and `queries/cards.ts:132/170`: for `isBusinessCardType(card.card_type)`
   send `completionAction: null` (and `completionActionSource` unchanged type-wise). The shift prompt's
   `section('Completion action', '')` then prints nothing. Nothing reaches `finalize.ts` / `ba-finalize.ts` for these
   cards (no finalize stage), so they need no change; add a test that proves it.

4. **Brief without a repo** (`brief.ts`, protocol `ShiftBrief` in `packages/shared/src/protocol/runner.ts`), additive optional fields:
   - `project.repoless?: true` when `isBusinessCardType(card.card_type)`;
   - `card.fieldLabels?: Record<string, string>` from the workflow's `customFields`, set only for business types.

5. **Prompt** (`packages/shared/src/prompt/instructions.ts`, `shift-prompt.ts`), only when the flags are present:
   - `repoless`: no "Working branch", architectural or E2E lines; the boundaries become "Work only inside your current
     working directory." plus the ledger line; drop the worktree/push, toolchain, .NET and test lines.
   - `fieldLabels`: a `## Details` section after the title, one `- <label>: <value>` per filled field, in
     `customFields` order; a field that came from mail/webhook (`outside`) keeps going through `renderUntrusted`.
   An older runner ignores both fields (zod strips unknown keys) and renders today's research-style prompt: no error.

### 4.4 Web

All gated on GWP-27's `useBusinessMode()` (or `isBusinessOrg(me.activeOrg)`) and on `isBusinessCardType`; dev rendering is untouched.

- **`pages/CardNew.tsx`**: `cardTypes` = business org ? `cardTypes.filter(isBusinessCardType)` : `cardTypes.filter((t) => !isBusinessCardType(t))`
  (a dev org, including one switched back from business, sees today's list). The initial type is the first of the
  filtered list, so `projectWorkflow.cardTypes[0]` (`feature`) is never preselected in a business org. Option text:
  `BUSINESS_CARD_TYPE_LABELS[t] ?? t`. In a business org the header `sub` shows the card's workflow name only (not
  "Code workflow"). No "generic task" type exists today, so none is added.
- **`components/CardFormFields.tsx`**: `codeCard` also false when `isBusinessCardType(v.cardType)` (no Repository,
  Completion action, Docs needed or Investigate & design). Custom text fields with `format: 'date'` render as
  `TextInput type="date"`; number fields keep `inputMode` but use `"decimal"` for business types (amount).
  `lib/cardForm.ts` already stores text as entered; `YYYY-MM-DD` round-trips through `fieldToText`.
- **`pages/CardDetail.tsx`**: hide the completion row when `effectiveCompletionAction` is null; show the type label;
  fields already render from `fieldCatalogue(…customFields)`; a date shows as a locale date.
- Board/list chips that print `cardType`: use the label helper where the type is a business type.

### 4.5 Research file

Now readable in the GWP vault (`projects/gwp/docs/business-mode/2026-10-27-business-mode-game-plan.md`). It names the
six types but defines no fields for them, so the card's minimal fields in 4.1 are final. Its role and pattern tables
give the roles in 4.2. Nothing else in this card depends on it.

## 5. Data model and API summary

- No migration, no new event type, no new table, no API path change. New rows only through existing
  `WorkflowVersionRegistered` (org-scoped) and `ProjectWorkflowsSet`.
- Additive shared changes: 6 enum values, `BUSINESS_CARD_TYPES`/`isBusinessCardType`/labels, `CustomField.format?`,
  `ShiftBrief.project.repoless?`, `ShiftBrief.card.fieldLabels?`, `DEFAULT_HOURS_PER_CARD` keys, `workflows/business.ts`.
- New error code `business_mode_code_workflow` (409).

## 6. Acceptance criteria → design → tests

| AC | Design | Test (builder unless noted) |
| --- | --- | --- |
| 1. Create each of the six types in a business org, fill fields, see them on the card | 4.1 fields, 4.3.1 install, 4.4 picker/form/detail | Server: `business-card-types.test.ts` creates one card of each type in a business org with each field filled and reads them back from the card DTO. Web: `card-new-business.test.tsx` (picker lists the six labels; each type shows its fields; date field is `type="date"`); card detail renders the labels/values. |
| 2. Each default workflow passes `validateCustomWorkflow`, no repo/branch/build/review/merge stage | 4.1 four steps, 4.2 roles | Shared: `business-workflows.test.ts`: for each def `validateCustomWorkflow(def, builtinRolesIncludingBusinessRoles, ctx)` has no errors; each `prepare` `claimRole` is in `BUSINESS_ROLE_KEYS` and equals the 4.2 table; `workflowUsesRepos` false; no stage with `worktree≠none`, `environment≠none`, `requireBuildEvidence`, `rebaseBefore`/`syncMainBefore`, kind `server`, claim role builder/reviewer/pre_reviewer/tester/devops, or an outcome event other than `StageCompleted`/`CardSpecified`. Also `CardType` contains the six; `isBusinessCardType`. |
| 3. Created → done in an org with no repository, no error or repo prompt | 4.3.1–4.3.5 | Server (pattern of `approval-step.test.ts`): business org with no repo, hire the business role of each type, for each type: create + specify → `prepare` claimed by that role, brief has `repoless`, `fieldLabels`, `completionAction: null`, no `projectPath` → report `done` → approval desk item for the starter → approve → `status='done'`, no `FinalizeRequested`/`CardFinalized`, `repo_id` null. Plus a send-back round trip once. Shared: prompt snapshot for a business brief (no working branch, Details section). E2E (tester, `e2e/**`): create and complete an enquiry and a quote in a business org with no repository. |
| 4. Dev org picker and workflows unchanged | No install in dev orgs; dev picker filter; all UI/prompt changes gated on business type/mode | Server: a dev org gets no `business-*` workflow rows and its project's enabled workflows are unchanged after boot; `createCard` in a dev org unchanged. Web: dev picker list equals today's list (existing `card-new` tests unchanged and passing). Shared: existing prompt snapshots unchanged (new **test files** only; do not edit existing snapshot files). |
| 5. Guildwise Cloud compiles | All shared changes additive; Cloud has no `Record<CardType>` | Run `pnpm -r typecheck` in GuildwiseHQ; in Guildwise Cloud run its typecheck with the `core` submodule at the card branch if the workstation allows it, else say in the handoff that Cloud has no exhaustive use of `CardType`/`CustomField` (grep result) and leave the Cloud build to the tester/DevOps. |

## 7. Risks and traps

- **Roles**: the `prepare` steps rely on GWP-33's wildcard claim. If a later change narrows that claim, the defs fail
  `role_cannot_claim_stage` and `ensureBusinessWorkflows` skips them; the shared test in AC2 catches it.
- **Existing test files**: the runner flags modified existing test files not named in Affected areas
  (ledger 901a6d34, bd3b1486). Put new tests in new files. If an existing snapshot must change, stop: the gating above
  is meant to avoid that.
- **E2E belongs to the tester** (ledger aadf93f9, 3c469f98): builders do not touch `e2e/**`.
- **Key collision**: an org-made workflow already called `business-quote` is left alone; the type then has no default
  workflow in that org. Log it; do not overwrite.
- **Install-once**: a later version of a shipped business workflow is not pushed onto orgs that have the key; that
  upgrade path is a follow-up.
- **Mail/webhook intake into a business org** picks no business type yet; out of scope (follow-up).
- **Research cards** in a business org: the picker hides them (card says "the six"); confirm with the owner later if
  research should stay offered.
- **Approval view**: `commands/approval.ts` shows a diff only for lean-team cards with a sha; check the desk item
  renders for a card with no repo and no sha (it does in `approval-step.test.ts`, which has no repo).

## 8. Assumptions about dependencies (now landed)

| Assumption | Dependency | Result |
| --- | --- | --- |
| 1. `packages/shared/src/orgs/mode.ts` exports `isBusinessOrg(org)` and the org row has `mode` `'dev'|'business'`; web has `useBusinessMode()` | GWP-27 | Holds. Server also has `orgModeOf(db, orgId)`. |
| 2. GWP-27 has a server `setOrgMode` (event `OrgModeSet`) and org creation accepts `mode` | GWP-27 | Holds: `commands/orgs.ts:138`; `OrganizationCreated.mode` set in `acceptEvents` (`commands/invitations.ts`). |
| 3. GWP-27 does not change a project's primary workflow or block card creation in business orgs | GWP-27 | Holds: guards only on repositories, hires and pack URLs. The 409 in 4.3.2 stays. |
| 4. GWP-27 hides repository/branch surfaces at page level but not inside the card form | GWP-27 | Holds: `CardFormFields.tsx` has no business gate; `CardDetail.tsx` gates DevOps/branch only. |
| 5. GWP-33 ships built-in roles named by the research file that can be given `claimableStages` for `business-*.prepare` | GWP-33 | **Revised.** The roles already claim `*`/`*`, so 4.2's role version bump is dropped. Role per type now fixed from the research tables (two rows inferred, owner confirmed). |

## 9. Assumption review (31 Oct 2026)

Checked against the working branch after GWP-27 and GWP-33 landed: `packages/shared/src/orgs/mode.ts`,
`apps/server/src/orgs/mode.ts`, `apps/web/src/lib/orgMode.ts`, `commands/orgs.ts` (`setOrgMode`),
`commands/invitations.ts` (`OrganizationCreated` with `mode`), every `assertDevMode` call site (none in card creation
or project workflows), `CardFormFields.tsx` and `CardDetail.tsx` gates, `packages/shared/src/roles/business.ts` and
`roles/schema.ts` (`roleClaimsStage` wildcard), `workflows/validate.ts` (`business_role_worktree`). Changes in this
revision: 4.2 (no role bump; role table), `BUSINESS_PREPARE_ROLE` in 4.1, 4.5 (file read; no field tables), concrete
call sites in 4.3.1, AC2/AC3 test rows, risk 1, section 8.
