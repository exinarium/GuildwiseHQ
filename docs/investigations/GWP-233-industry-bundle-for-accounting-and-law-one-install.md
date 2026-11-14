# GWP-233: Industry bundle for accounting and law (server and shared)

Design report. Checked against the working branch at `7fcd4320` and the GWP-232 design (branch
`aom/gwp-232-journey-templates-for-accounting-and-law`, commit `754d8f85`).

## 1. The question

The card asks for one "industry bundle" per industry (accounting, law). An org manager installs or uninstalls the
whole bundle in one action. A bundle covers the rule pack, playbooks, knowledge templates, sample data and journey
templates. The design has to settle:

1. Which existing mechanism each member maps to, and the smallest addition where none exists.
2. How install runs in **one** transaction while reusing the existing installers.
3. How uninstall removes exactly what the bundle created and keeps what the org created or edited.
4. The API and type names, fixed early because GWP-234 (UI) builds on them.

## 2. Findings

### F1. Rule packs: the mechanism exists, but its installers open their own transaction

`packages/shared/src/ledger/rule-packs.ts` already has `accounting` and `law` industry packs (`RULE_PACKS`,
`rulePackById`). `apps/server/src/commands/rule-packs.ts` has `installRulePack`, `removeRulePack` and
`previewRulePack`, plus the private helpers `linkedRows` and `installedPackIds`. Each public command opens its own
`withAppendTx` / `withTx` and runs `assertManager` / `assertMember` inside it.

`withAppendTx` (`apps/server/src/db/tx.ts`) takes a pooled client and runs `BEGIN`. It cannot be nested. A bundle that
called `installRulePack` would run in a second transaction, and a later failure could not roll that back.
**Each installer therefore needs a `…Tx(ctx, tx, …)` body that the public function and the bundle both call.** The
codebase already uses this pattern (`addLedgerEntryTx`, `createScheduleIn`).

The rule pack state lives in `org_rule_packs`, projected from `RulePackInstalled` / `RulePackRemoved`. Edited means
`version > 1` (`linkedRows`). The near-duplicate and contradiction checks are `findNearDuplicate` and
`findContradictions` (`ledger-checks.ts`).

### F2. Playbooks = Brief playbooks. No industry playbooks exist, and install requires destinations

`packages/shared/src/schedules/brief-playbooks.ts` has `BRIEF_PLAYBOOKS` with only two keys: `morning_plan` and
`weekly_owner_brief`. Both are general. `installBriefPlaybook` (`apps/server/src/commands/brief-playbooks.ts`):

- registers the Brief workflow of the owner role and enables it on the project (`ensureBriefWorkflow`);
- creates a `create_card` cron schedule through `createScheduleIn(ctx, tx, …)`, with `action.playbook = { key, version }`;
- refuses a second install of the same key (`playbook_installed`, found by `action->'playbook'->>'key'`);
- needs a project. With more than one active project and no `projectId` it fails with `project_required`;
- requires `destinations` (min 1) **in the request schema only**. The schedule action schema has
  `deliverOutput` as optional (`packages/shared/src/events/schedule.ts:195`).

A playbook is removed with `DELETE /api/schedules/:id` (`deleteSchedule`). The Automations page lists the tiles from
`listBriefPlaybooks` (all keys). It edits an installed playbook through `patchBriefPlaybook` and
`BriefPlaybookDialog`, which refuses to save without a destination.

The other "playbooks" in the code (`packages/shared/src/playbooks`, the `/` commands of capabilities, and the
discovery steps) are agent capabilities. They are not org content an owner installs, so they are **not** the
mechanism. **Decision: playbooks = Brief playbooks, with one new industry playbook per bundle.**

### F3. Knowledge templates: no mechanism. Documents is the closest fit

The business-mode **Knowledge** nav section holds Rules & decisions (`/ledger`), **Documents** (`/documents`),
Interests and Vaults (`apps/web/src/components/shell/nav-config.ts`). Documents
(`packages/shared/src/documents`, `apps/server/src/commands/documents.ts`) are:

- held on the server **as drafts** and copied to the org vault (`org/docs/<slug>.md`) only once the owner approves them;
- event sourced (`DocumentCreated`, `DocumentVersionSaved`, `DocumentStatusChanged`), org- or project-scoped, tagged
  (`normalizeDocumentTags`) and versioned (`current_version`);
- able to move from `draft` to `archived`. There is no hard delete.

That fits a "template" exactly. It arrives as a draft, the owner fills it in and approves it, and only then does it
reach the vault on the owner's workstation. That is consistent with the standing order that no vault content is
hosted on the server. Every write is in the DB, so it can join the bundle transaction. Edits are detectable:
`current_version > 1`, a status other than draft, or changed tags.

The alternative, writing templates straight into the vault with `vault.write` (the GWP-154 design), is asynchronous
through a runner. It cannot take part in one transaction or roll back. Removing the notes needs a `vault.delete`,
which does not exist (GWP-154 prerequisite P4). It also cannot tell an edited note from an untouched one. **Rejected.**

`documents.kind` has a CHECK constraint (`2750_document_tags_files.sql`) over
`brief, prd, minutes, session_log, file`. The web page labels kinds through `Record<DocumentKind, string>`
(`apps/web/src/pages/Documents.tsx:45`), which shows `file` as "Uploaded file", a wrong label for a template.

**Smallest addition:** two new document kinds, `template` and `sample`. That means a migration that widens the
CHECK, two enum values, and two web labels. No new table or content store.

### F4. Sample data: no mechanism. Use the same Documents path with a `sample` kind and tag

There is no product sample-data mechanism. Only a dev seed in guildwise-cloud exists, which is out of scope. Sample
journeys, cards or schedules would start real agent work and cost money, or could send messages, so they are not
safe sample data. **Smallest addition:** sample data = org Documents of kind `sample`, tagged `sample` and the
industry. Each title starts with `Sample:` and each body opens with a `SAMPLE DATA: fictional, safe to remove`
banner. Anyone can find them with the Documents kind filter or `?tags=sample`, and uninstall removes them.

### F5. Journey templates: a global catalogue, with no per-org availability

`packages/shared/src/journeys/templates.ts` (`JOURNEY_TEMPLATES`, `getJourneyTemplate`) is served to **every** org
by `GET /api/journey-templates`. `createJourney` copies a template's definition and does not store the template id.
GWP-232 adds `accounting-client-onboarding` and `law-client-matter` with `industry: 'accounting' | 'law'`, and its
acceptance criteria require them to show in the gallery for everyone.

Gating them per org would contradict GWP-232, and would need a check in `createJourney` plus a filtered route.
**Decision:** the bundle *references* its journey templates. Install verifies they resolve and reports them as
available. "Availability" is derived from the bundle's installed state, so GWP-234 can show them as "From your
installed bundles" or filter the gallery by the industries of installed bundles. Uninstall removes that
recommendation automatically, and no journey template row is written or deleted. Journeys the org created from a
template are the org's own. They are never touched.

### F6. Events and projections

Projections run inline in the append transaction. `createDocument` reads the projected row right after `append`, so
anything the bundle reads back inside its transaction is current. A new projected table must be listed in the
rebuild list in `apps/server/src/projections/index.ts`. `org_rule_packs` is at line 255. The suite
`rule-packs.test.ts › replays to the same state` shows the replay check to copy.

## 3. Options compared

| Topic | Option | Verdict |
| --- | --- | --- |
| One transaction | (a) `…Tx` bodies extracted from each installer, public wrappers unchanged | **chosen**: reuses the logic, keeps the existing behaviour byte for byte |
| | (b) call the public installers one after another, with compensation on failure | rejected: not atomic, and the AC fails |
| | (c) copy the rule pack and playbook logic into the bundle | rejected: the card forbids duplication |
| Knowledge templates | (a) Documents of kind `template`, draft | **chosen**: transactional, edit-detectable, under Knowledge, vault only on approval |
| | (b) `vault.write` notes | rejected: async, no delete, no rollback (F3) |
| | (c) new `knowledge_templates` table | rejected: a second content store next to Documents |
| Sample data | (a) Documents of kind `sample`, tag `sample` | **chosen**: same path, findable, removable |
| | (b) sample journeys or cards | rejected: they start agent work and cost money |
| Playbook schedule on install | (a) installed **disabled**, without destinations | **chosen**: no surprise runs or cost. The owner switches it on in Automations (adds a destination) |
| | (b) enabled, with destinations in the bundle request | rejected: the install form would need delivery settings, and every install starts paid runs |
| Bundle state | (a) `org_industry_bundles` row with an `items` jsonb of what the bundle created, projected from the bundle events | **chosen**: event sourced, replayable, no provenance columns on four tables |
| | (b) a `bundle_id` column on ledger_entries, schedules and documents | rejected: wider migration, touches hot tables |
| Edit detection | ledger `version > 1`. Documents: `current_version > 1`, status other than draft, or changed tags. Schedules: sha-256 fingerprint of `name, enabled, trigger, action` (secrets stripped) stored at install | **chosen** |
| Journey availability | (a) derived from the bundle's installed state, no gating | **chosen** (F5) |
| | (b) per-org gating of templates | rejected: breaks GWP-232 AC 3 |

## 4. Design

### 4.1 Shared: catalogue (`packages/shared/src/industry/`)

New folder, exported from `packages/shared/src/index.ts`:

- `bundles.ts`: the types, `INDUSTRY_BUNDLES`, `industryBundleById` and the tag helpers.
- `accounting.ts` and `law.ts`: the content (template strings, no runtime file reads, as for the rule packs).

```ts
import type { RulePack } from '../ledger/rule-packs.ts';
import type { BriefPlaybookKey } from '../schedules/brief-playbooks.ts';

export type IndustryKey = NonNullable<RulePack['industry']>;   // 'real_estate' | 'accounting' | 'law'

/** A Documents draft the bundle creates in the organization (kind `template` or `sample`). */
export interface IndustryDocument {
  /** Stable within the bundle (kebab-case); never reused for different content. */
  id: string;
  title: string;          // samples start with 'Sample: '
  content: string;        // markdown
}

export interface IndustryBundle {
  id: string;             // 'accounting' | 'law'
  version: number;
  industry: IndustryKey;
  name: string;
  description: string;
  rulePackId: string;                     // rulePackById
  playbookKeys: BriefPlaybookKey[];       // BRIEF_PLAYBOOKS
  knowledgeTemplates: IndustryDocument[]; // Documents kind 'template'
  sampleData: IndustryDocument[];         // Documents kind 'sample'
  journeyTemplateIds: string[];           // getJourneyTemplate (GWP-232)
}

export const INDUSTRY_BUNDLES: readonly IndustryBundle[] = [ACCOUNTING_BUNDLE, LAW_BUNDLE];
export const industryBundleById = (id: string) => INDUSTRY_BUNDLES.find((b) => b.id === id);

/** Tags a bundle document carries (normalized form). */
export const industryDocumentTags = (b: IndustryBundle, kind: 'template' | 'sample'): string[] =>
  kind === 'sample' ? ['sample', 'industry-sample', b.industry] : ['industry-template', b.industry];
export const SAMPLE_BANNER = '> SAMPLE DATA: fictional, safe to remove.';
export const GUIDANCE_NOTE = '> Process guidance only. This is not legal, tax or accounting advice.';
```

Bundle ids are `accounting` and `law`, the same as their rule pack ids. Do **not** add a real-estate bundle in this
card, because no real-estate playbooks or templates are asked for. Leave `rentals` untagged, as GWP-232 does.

### 4.2 Shared: Brief playbooks (`packages/shared/src/schedules/brief-playbooks.ts`)

- Extend `BriefPlaybookKey` with `accounting_deadline_brief` and `law_matter_dates_brief`.
- Add an optional `industry?: IndustryKey` to `BriefPlaybook` and set it on the two new entries. Leave the existing
  two entries unchanged.
- `BriefPlaybookDtoSchema`: add `industry: z.enum([...]).nullable().default(null)` (additive).

Content (process guidance, read-only digest, same shape as the existing two):

| key | name | cadence | default | role | maxWords | periodDays | headings |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `accounting_deadline_brief` | Accounting deadlines brief | weekly | Mon 07:00 | `operations_analyst` | 250 | 7 | Deadlines in the next 14 days · Client documents still outstanding · Work waiting for review or sign-off · What needs a partner |
| `law_matter_dates_brief` | Matter dates brief | weekly | Mon 07:00 | `operations_analyst` | 250 | 7 | Dates in the next 14 days (each to be verified by the fee-earner) · Matters waiting on the client · Work waiting for partner review · What needs a partner |

Each `requirements` text starts like the existing ones ("Write … in plain language, as a short read-only digest. Use
only what the Context holds. Use these headings:"). It ends with "List dates as found; do not calculate or confirm
deadlines. Process guidance, not legal/tax advice." This matches the law rule `fee-earner-verifies-every-date` and the
core rule `no-professional-advice`.

### 4.3 Shared: knowledge templates and sample data (content)

Every template body starts with `GUIDANCE_NOTE` and has fill-in headings with `_(fill in)_` placeholders. Every sample
starts with `SAMPLE_BANNER` and uses an obviously fictional entity, with no real people, ID numbers or bank details.

Accounting (`accounting.ts`):

- Templates:
  - `engagement-letter-checklist`: Engagement letter checklist (scope, fees, responsibilities, timelines, sign-off).
  - `client-document-request-list`: Client document request list (per service: annual financials, tax return,
    payroll).
  - `month-end-close-checklist`: Month-end close checklist.
  - `fica-onboarding-checklist`: FICA client onboarding checklist. It states that a person signs off, per the rule
    `fica-human-sign-off`.
- Samples:
  - `sample-client-profile`: "Sample: Client profile, Fictional Trading (Pty) Ltd".
  - `sample-document-request`: "Sample: Document request for the 2026 annual financials".

Law (`law.ts`):

- Templates:
  - `matter-intake-form`: Matter intake form.
  - `conflict-check-record`: Conflict check record. A person decides, per `partner-decides`.
  - `engagement-letter-checklist`: Engagement letter checklist (law).
  - `matter-close-out-checklist`: Matter close-out checklist (trust balance confirmed by a person, per
    `ai-never-moves-trust-money` and `lpa-trust`).
- Samples:
  - `sample-matter-summary`: "Sample: Matter summary, Fictional Holdings v Example Supplies".
  - `sample-key-dates`: "Sample: Key dates list". Every date is marked "to be verified by the fee-earner".

The builder writes the bodies from these outlines. Keep each one short (roughly 20 to 60 lines), with no statute
interpretation and no advice. Both bundles have an `engagement-letter-checklist` member id, which is fine because ids
are unique per bundle. The **titles** must differ (for example "Engagement letter checklist (law)"), because
documents get their slug from the title and the org shares one slug space.

### 4.4 Shared: API types (`packages/shared/src/api/ledger.ts`, after the rule pack schemas)

The names are fixed here for GWP-234:

```ts
export const IndustryBundleSummarySchema = z.object({
  id: z.string(), industry: z.enum(['real_estate', 'accounting', 'law']),
  name: z.string(), description: z.string(), version: z.number().int(),
  installed: z.boolean(), installedAt: IsoTime.nullable(),
  counts: z.object({ rules: z.number().int(), playbooks: z.number().int(), knowledgeTemplates: z.number().int(),
                     sampleData: z.number().int(), journeyTemplates: z.number().int() }),
});
export const IndustryBundleListResponseSchema = z.object({ bundles: z.array(IndustryBundleSummarySchema) });

const MemberDoc = z.object({ id: z.string(), title: z.string(), status: z.enum(['new', 'present']),
                             existingId: z.string().nullable() });
export const IndustryBundlePreviewSchema = IndustryBundleSummarySchema.extend({
  rulePack: RulePackPreviewSchema,                         // previewRulePack's per-rule statuses, unchanged
  playbooks: z.array(z.object({ key: z.string(), name: z.string(), description: z.string(),
                                status: z.enum(['new', 'present']), scheduleId: z.string().nullable() })),
  knowledgeTemplates: z.array(MemberDoc),
  sampleData: z.array(MemberDoc),
  journeyTemplates: z.array(z.object({ id: z.string(), name: z.string() })),
  /** Install would fail: fix these first. */
  blockers: z.array(z.object({ code: z.enum(['project_required', 'no_project']), message: z.string() })),
});
export const InstallIndustryBundleRequestSchema = z.object({
  /** Project the playbook cards are made in; only needed with more than one active project. */
  projectId: z.uuid().optional(),
  /** Default: the organization's time zone. */
  timezone: z.string().min(1).max(60).optional(),
}).default({});
export const IndustryBundleInstallResultSchema = z.object({
  status: z.enum(['installed', 'already_installed']),
  /** null: the rule pack was already installed before the bundle (left as it is). */
  rulePack: RulePackInstallResultSchema.nullable(),
  playbooks: z.object({ added: z.array(z.object({ key: z.string(), scheduleId: z.string() })),
                        present: z.array(z.object({ key: z.string(), scheduleId: z.string() })) }),
  documents: z.object({ added: z.array(z.object({ memberId: z.string(), docId: z.string(), kind: z.enum(['template', 'sample']) })),
                        present: z.array(z.object({ memberId: z.string(), existingId: z.string() })) }),
  journeyTemplates: z.array(z.string()),
});
export const IndustryBundleRemoveResultSchema = z.object({
  removed: z.object({ ruleEntries: z.array(z.string()), schedules: z.array(z.string()), documents: z.array(z.string()) }),
  /** Created by the bundle but changed by the organization since, or the org's own: never removed. */
  kept: z.array(z.object({ kind: z.enum(['rule', 'playbook', 'document']), id: z.string(), title: z.string(),
                           reason: z.enum(['edited', 'present_before_install']) })),
  /** Already removed by the organization before the uninstall. */
  gone: z.array(z.object({ kind: z.enum(['rule', 'playbook', 'document']), id: z.string() })),
});
```

Export the matching `type X = z.infer<…>` for each schema.

### 4.5 Shared: documents and events

- `packages/shared/src/documents/index.ts`: `DOCUMENT_KINDS = [..., 'file', 'template', 'sample']`.
- New `packages/shared/src/events/industry-bundles.ts`, spread into the event list in `events/index.ts` (next to
  `ledgerEvents`):

```ts
const Items = z.object({
  rulePack: z.object({ packId: z.string().max(80), installedByBundle: z.boolean() }),
  playbooks: z.array(z.object({ key: z.string().max(60), scheduleId: Id, fingerprint: z.string().length(64) })).max(20),
  documents: z.array(z.object({ memberId: z.string().max(80), docId: Id, kind: z.enum(['template', 'sample']),
                                tags: z.array(z.string()).max(20) })).max(100),
  journeyTemplates: z.array(z.string().max(80)).max(20),
});
defineEvent('IndustryBundleInstalled', z.object({ bundleId: z.string().max(80), bundleVersion: z.number().int().positive(), items: Items }));
defineEvent('IndustryBundleRemoved', z.object({ bundleId: z.string().max(80),
  removed: z.object({ ruleEntries: z.array(Id).max(200), schedules: z.array(Id).max(20), documents: z.array(Id).max(100) }),
  kept: z.array(z.object({ kind: z.string(), id: Id })).max(300).default([]) }));
```

- `packages/shared/src/ids.ts`: `industryBundle: (orgId, bundleId) => \`industry-bundle-${orgId}-${bundleId}\``.

`items` records **only what the bundle created**. Members that were already present are reported in the command
result but not stored, so uninstall never touches them.

### 4.6 Server: migration (`apps/server/migrations/<next>_industry_bundles.sql`)

Take the next free number at build time. The highest today is `2960_*`.

```sql
-- Industry bundles (business mode): which bundles an organization installed and what each created.
CREATE TABLE IF NOT EXISTS org_industry_bundles (
  org_id          uuid NOT NULL,
  bundle_id       text NOT NULL,
  bundle_version  integer NOT NULL,
  items           jsonb NOT NULL,
  installed_at    timestamptz NOT NULL,
  installed_by    uuid,
  removed_at      timestamptz,
  removed_by      uuid,
  PRIMARY KEY (org_id, bundle_id)
);
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_kind_check;
ALTER TABLE documents ADD CONSTRAINT documents_kind_check
  CHECK (kind IN ('brief','prd','minutes','session_log','file','template','sample'));
```

Projection (`apps/server/src/projections/industry-bundles.ts`, registered with the others in
`projections/index.ts`; add `'org_industry_bundles'` to the rebuild list next to `'org_rule_packs'`):

- `IndustryBundleInstalled`: `INSERT … ON CONFLICT (org_id, bundle_id) DO UPDATE SET bundle_version, items,
  installed_at, installed_by, removed_at = NULL, removed_by = NULL`.
- `IndustryBundleRemoved`: `UPDATE … SET removed_at, removed_by`. Keep `items` for history.

### 4.7 Server: refactors in the existing installers (behaviour unchanged)

Each public function keeps its signature, its authorization message and its transaction. Only the body moves into an
exported `…Tx` / `…In` function.

| File | New export | Public wrapper |
| --- | --- | --- |
| `commands/rule-packs.ts` | `installRulePackTx(ctx, tx, user, orgId, pack): Promise<RulePackInstallResult>` (loop and `RulePackInstalled` append, without `assertManager`) | `installRulePack` = `withAppendTx` → `assertManager` → `installRulePackTx` |
| | `removeRulePackTx(ctx, tx, user, orgId, pack): Promise<RulePackRemoveResult>` | `removeRulePack` likewise |
| | `previewRulePackTx(tx, orgId, pack): Promise<RulePackPreview>` | `previewRulePack` = `withTx` → `assertMember` → `previewRulePackTx` |
| | export `installedPackIds` and the two asserts (or move the asserts to a tiny `commands/org-guards.ts`) | |
| `commands/brief-playbooks.ts` | `installBriefPlaybookIn(ctx, tx, user, org, key, opts: { projectId?, timezone?, time?, weekday?, ownerRole?, maxWords?, destinations?: OutputDestination[], enabled: boolean })`. It omits `deliverOutput` when `destinations` is empty, passes `enabled` through, and keeps the `playbook_installed` conflict. Also export `installedMap` and a `resolvePlaybookProject(tx, orgId, projectId?)` helper with the current project rules and error codes | `installBriefPlaybook` = `managerOrg` → `withAppendTx` → `installBriefPlaybookIn(…, { ...req, enabled: true })` |
| | `listBriefPlaybooks`: list general playbooks (no `industry`) **plus** industry playbooks that have an installed schedule. The output is identical for an org with no bundle, and the bundle's disabled schedule gets an Edit tile in Automations | |
| `commands/schedules.ts` | `deleteScheduleIn(ctx, tx, user, org, id)` (the body of `deleteSchedule`) | `deleteSchedule` = `withAppendTx` → `deleteScheduleIn` |
| `commands/documents.ts` | `createDocumentIn(ctx, tx, who, req)` (body of `createDocument` without `assertManager`; `kind` can now be `template`/`sample`) and `archiveDocumentIn(ctx, tx, who, docId, note)` (appends `DocumentStatusChanged` from draft to archived; refuses any other status) | `createDocument` and `changeDocumentStatus` unchanged on the outside |

Do not reverse `ensureBriefWorkflow` on uninstall. The single-playbook remove does not reverse it either, and the
Brief workflow is shared with the general playbooks.

### 4.8 Server: bundle commands (`apps/server/src/commands/industry-bundles.ts`)

```ts
listIndustryBundles(ctx, user, orgId): Promise<IndustryBundleSummary[]>        // withTx, assertMember
previewIndustryBundle(ctx, user, orgId, bundleId, projectId?)                    // withTx, assertMember, writes nothing
installIndustryBundle(ctx, user, orgId, bundleId, req): Promise<IndustryBundleInstallResult>  // withAppendTx, assertManager
removeIndustryBundle(ctx, user, orgId, bundleId): Promise<IndustryBundleRemoveResult>          // withAppendTx, assertManager
```

Unknown bundle id: `notFound('industry bundle not found')`.

**Preview** (read-only `withTx`):

1. `previewRulePackTx` for the pack.
2. Each playbook: `present` when `installedMap` has the key, else `new`.
3. Each document member: `present` when the org has an org-level document (`project_id IS NULL`) with the slug
   `documentSlug(title)` and `status <> 'archived'`, else `new`.
4. Journey templates: id and name from `getJourneyTemplate`.
5. `blockers`: run the project resolution of `resolvePlaybookProject` without throwing. With several projects and no
   `projectId` the blocker is `project_required`; with none it is `no_project`.

**Install** (one `withAppendTx`; any throw rolls everything back):

1. `assertManager`, bundle lookup.
2. If the `org_industry_bundles` row exists with `removed_at IS NULL`, return
   `{ status: 'already_installed', rulePack: null, playbooks: {added: [], present: []}, documents: {added: [], present: []}, journeyTemplates: b.journeyTemplateIds }`.
   Write nothing and append no event.
3. Resolve the project first (`resolvePlaybookProject`), so a missing project fails before any write.
4. Rule pack: if `installedPackIds(tx, orgId)` has it, record `installedByBundle: false` and result `rulePack: null`.
   Otherwise call `installRulePackTx` and record `installedByBundle: true`. That appends `RulePackInstalled`, so the
   pack also shows as installed in the Rule packs dialog, and the single remove keeps working.
5. Playbooks: skip the keys already in `installedMap` (reported as `present`). Otherwise
   `installBriefPlaybookIn(…, { projectId, timezone, enabled: false })`, read the row back and store
   `fingerprint = scheduleFingerprint(row)`.
6. Documents, templates first, then samples: skip `present` ones. Otherwise
   `createDocumentIn(ctx, tx, who, { kind, title, content, tags: industryDocumentTags(b, kind), sourceThreadIds: [] })`
   (org-level, status draft), and record `{ memberId, docId, kind, tags }`.
7. Journey templates: `getJourneyTemplate(id)` must resolve. Throw `conflict('bundle_member_missing', …)` otherwise;
   the catalogue test makes this unreachable.
8. Append **one** `IndustryBundleInstalled` (stream `streamId.industryBundle(orgId, b.id)`, `userActor`,
   `orgScope`) with `items`. Return the result.

`scheduleFingerprint(row)`: sha-256 hex of a key-sorted JSON of `{ name, enabled, trigger, action }`, with
`trigger.secretHash` and `action.deliverOutput.secretEnc` / `action.secretEnc` removed. Run, link and next-fire columns
are not part of it. Compute it from the projected row at install and at uninstall, so both sides read jsonb the same
way.

`who` for the document helpers: `{ userId: user.id, orgId, role }`, where the role comes from `orgRoleOf`.

**Uninstall** (one `withAppendTx`):

1. `assertManager`, bundle lookup.
2. No live row: `conflict('bundle_not_installed', 'the <name> bundle is not installed')` (409).
3. From `items`:
   - Rule pack with `installedByBundle`: `removeRulePackTx`. Its `retired` ids go to `removed.ruleEntries` and its
     `kept` ids to `kept` (reason `edited`, title from the row). If the pack had been removed on its own in the
     meantime, nothing happens. `installedByBundle: false`: nothing is touched.
   - Each playbook: no row means `gone`. A fingerprint that differs means `kept` (`edited`). Switching the playbook on
     or adding a destination counts as an edit. Otherwise call `deleteScheduleIn`.
   - Each document: missing or archived means `gone`. It is `kept` (`edited`) when `current_version > 1`, the status
     is not `draft`, or the tags differ from the recorded ones (sorted compare). Otherwise call
     `archiveDocumentIn(…, 'Removed with the industry bundle "<name>"')`.
4. Append **one** `IndustryBundleRemoved` with removed and kept, and return the result.

Removal means retired (rules), deleted (schedules) and archived (documents). These are the existing removal semantics
of each member type. Documents have no hard delete, and archived ones stay visible greyed out under the Archived
filter.

### 4.9 Server: routes (`apps/server/src/routes/industry-bundles.ts`, registered in `app.ts` after `ledgerRoutes`)

| Method and path | Body / query | Who | Returns |
| --- | --- | --- | --- |
| `GET /api/industry-bundles` | | member | `{ bundles }` |
| `GET /api/industry-bundles/:bundleId` | `?projectId=` | member | `IndustryBundlePreview` |
| `POST /api/industry-bundles/:bundleId/install` | `InstallIndustryBundleRequest` | manager | `IndustryBundleInstallResult` (200, also when `already_installed`) |
| `POST /api/industry-bundles/:bundleId/remove` | | manager | `IndustryBundleRemoveResult`; 409 `bundle_not_installed` |

Resolve the org exactly like `packOrg` in `routes/ledger.ts` (`resolveOrgId(ctx, s, requestedOrgId(req))`, 403 without
one). Params: `z.object({ bundleId: z.string().min(1).max(80) })`.

### 4.10 Web (minimum needed to compile; the UI itself is GWP-234)

`apps/web/src/pages/Documents.tsx` `KIND_LABEL`: add `template: 'Template'` and `sample: 'Sample data'`. The record is
exhaustive, so the web type check fails without them. Nothing else in web.

## 5. Acceptance criteria → design

| AC | Where it is met | Test |
| --- | --- | --- |
| Shared catalogue defines accounting and law bundles naming all members; a unit test checks every member resolves | §4.1–4.3 | **`packages/shared/test/industry-bundles.test.ts`** (under `test/`; vitest only collects `test/**`): ids unique; `rulePackById(rulePackId)?.industry === b.industry`; each `isBriefPlaybookKey` with `BRIEF_PLAYBOOKS[k].industry === b.industry`; each `getJourneyTemplate(id)?.industry === b.industry`; document member ids unique per bundle; `documentSlug(title)` unique across **all** bundles; samples start with `Sample:` and `SAMPLE_BANNER`; templates contain `GUIDANCE_NOTE`; content ≤ `DOCUMENT_MAX_CHARS`; tags survive `normalizeDocumentTags` unchanged |
| POST install installs all members in one transaction; any failure installs nothing | §4.7 refactor + §4.8 install in one `withAppendTx` | server: a test-only Postgres trigger (`BEFORE INSERT ON documents … WHEN (NEW.kind='sample') RAISE EXCEPTION`), created and dropped in the test through the admin pool. Install → 500, and then no linked ledger rows, no `org_rule_packs` row, no playbook schedules, no bundle documents, no `org_industry_bundles` row, and the event count is unchanged |
| After install: rules in Rules & decisions, playbooks, knowledge templates, sample data, journey templates available | §4.8 steps 4–7 | server: fresh org, install `accounting`. Then `GET /api/ledger?scope=standing_order` has every pack rule with `rulePack.id='accounting'`; schedules with `action.playbook.key='accounting_deadline_brief'`, `enabled=false`; `GET /api/documents?tags=industry-template` and `?tags=sample` match the catalogue; `GET /api/industry-bundles` shows `installed: true`; result `journeyTemplates` equals the catalogue |
| Install of an installed bundle changes nothing, reports already installed | §4.8 step 2 | server: second install → `status: 'already_installed'`; row counts and event count unchanged |
| Uninstall removes exactly what the bundle installed; edited or org items kept and listed | §4.8 uninstall | server: (a) plain round trip leaves no live bundle rule, schedule or draft document; (b) edit one pack rule (`PATCH /api/ledger/:id`) and save a version of one template, then uninstall: both appear in `kept` with `edited` and stay live; (c) a rule pack installed **before** the bundle stays installed after uninstall; (d) uninstall again → 409 `bundle_not_installed` |
| Preview returns adds plus contradictions/near-duplicates, writes nothing | §4.8 preview | server: add a conflicting own standing order first; preview shows `may_conflict` (or `covered`) for that rule, and the event count and row counts do not change |
| Install/uninstall rejected for non-managers; preview and list work for members | asserts in §4.8 | server: `addMember` (member role) → 403 on install and remove, 200 on list and preview |
| Install and uninstall each append one bundle event through the append transaction | §4.8 step 8, uninstall step 4 | server: `SELECT count(*) FROM events WHERE stream_id = 'industry-bundle-<org>-accounting'` is 1 after install and 2 after uninstall; replay (rebuild projections) gives the same `org_industry_bundles` row, as in `rule-packs.test.ts › replays` |
| Existing single rule pack install/preview/remove unchanged | §4.7 wrappers | `rule-packs.test.ts`, `rule-packs-catalogue.test.ts`, `brief-playbooks.test.ts`, `documents*.test.ts` and web `brief-playbooks.test.tsx` and `documents.test.tsx` stay green unchanged. Add one `brief-playbooks.test.ts` case: the list for an org without a bundle has exactly the two general keys |

Repeat the round trip for `law` with `it.each(['accounting', 'law'])`.

Test placement: shared unit tests run with the build. Every server test above uses `createWorld` (Postgres), so it is
an integration test for the testers. The builder names them in the handoff. File: `apps/server/test/industry-bundles.test.ts`.

## 6. Risks and traps

1. **Refactor regressions.** Keep the public functions' error codes and messages. In particular, `installRulePack`'s
   `assertManager` message mentions rule packs; the bundle passes its own message. Run the existing suites unchanged.
2. **Playbook list change.** `listBriefPlaybooks` must not show the industry playbooks to orgs without a bundle. The
   web `playbookDto` (`Automations.tsx:168`) already resolves any key through `isBriefPlaybookKey`, so the new keys
   edit correctly.
3. **Slug collisions.** Two bundles installed together share the org slug space. Hence the cross-bundle unique-slug
   test and the distinct titles.
4. **`items` and catalogue drift.** Uninstall works from the stored `items` only, never from the current catalogue.
   A later catalogue version cannot make uninstall remove something it never created.
5. **Fingerprint stability.** Compute it from the DB row on both sides with key-sorted JSON. Never compute it from the
   request object.
6. **Event payload limits.** Keep `max()` bounds generous but finite (§4.5).
7. **Content tone.** All content is process guidance. Do not interpret statutes, give advice or use real names.
   Dates in samples say "to be verified by the fee-earner". No blog content.
8. **E2E.** Adding two Documents kinds adds two options to the Documents kind filter. Check
   `e2e/**/documents*.spec.ts` for exact option counts. If a spec counts them, the tester updates it (builders may
   not edit E2E).
9. **Size.** About 900 to 1,200 changed lines (content included), across shared, server, a migration and one web
   line. The card is already tier `large`.

## 7. Assumptions about unlanded dependencies (GWP-232)

1. `packages/shared/src/journeys/templates.ts` exports templates with ids `accounting-client-onboarding` and
   `law-client-matter` (constants `ACCOUNTING_TEMPLATE_ID`, `LAW_TEMPLATE_ID`), reachable via `getJourneyTemplate`.
   *If different:* change the two `journeyTemplateIds` in the bundle content. The catalogue test catches it.
2. `JourneyTemplate` gains `industry?: 'real_estate' | 'accounting' | 'law'`, the same values as `RulePack.industry`.
   *If absent:* drop the industry equality check in the catalogue test and keep the resolve check.
3. GWP-232 leaves journey templates global (no per-org gating) and the gallery shows them to every org. *If it adds
   gating:* bundle install must also grant availability in the same transaction, which needs a new member step.
4. GWP-232 does not change `createJourney` or `GET /api/journey-templates`. *If it does:* nothing changes here, as
   long as `getJourneyTemplate` still resolves ids.

## 8. Decisions recorded for the card

- Playbooks = Brief playbooks. New keys: `accounting_deadline_brief` and `law_matter_dates_brief`, installed by the
  bundle as **disabled** schedules without destinations. The owner switches them on in Automations.
- Knowledge templates = org Documents of the new kind `template`, created as drafts. They reach the vault only when
  the owner approves them.
- Sample data = org Documents of the new kind `sample`, tagged `sample`, with titles that start with `Sample:` and a
  SAMPLE banner.
- Journey templates stay global (GWP-232). The bundle references them, and "availability" is the bundle's installed
  state, for GWP-234 to surface.
- Uninstall = retire (rules), delete (schedules) and archive (documents), only for items in the bundle's `items` record
  and only when unedited.
