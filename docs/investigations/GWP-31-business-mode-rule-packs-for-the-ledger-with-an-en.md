# GWP-31: Business mode: rule packs for Rules & decisions, with an "enforced by" badge

## Revision of 31 Oct: checked against the landed code

The design was written before the org mode flag, the wording rename and the review dates landed. They are all on the
working branch now, and I checked each assumption against that code:

1. **Org mode flag: holds.** `packages/shared/src/orgs/mode.ts` exports `OrgMode`, `OrgModeSchema` and
   `isBusinessOrg`. `apps/server/src/orgs/mode.ts` has `orgModeOf(db, orgId)` and `assertDevMode(db, orgId, message)`.
   The web has `useBusinessMode()` in `apps/web/src/lib/orgMode.ts`.
2. **Refusal shape: holds.** `assertDevMode` throws `conflict('business_mode', message)`, which is a 409 with a plain
   message. It reads the mode with `SELECT mode FROM organizations WHERE id=$1 FOR SHARE`, so the check is serialised
   with a mode switch running at the same time. `assertBusinessOrg` goes in `apps/server/src/orgs/mode.ts`, next to
   `assertDevMode`, and does the same thing the other way round: a `FOR SHARE` read inside the caller's transaction,
   then `conflict('business_only', 'Rule packs are available in business organizations.')`. The code is
   `business_only`, not `business_mode`, because it is refused for the opposite reason. A similar inverse already
   exists: `role_not_in_mode`.
3. **Wording: holds.** `useOrgTerms()` is in `apps/web/src/lib/terms.ts`. It returns the `OrgTerms` keys plus `mode`
   and `reword`. `ORG_TERMS.business.ledger` is "Rules & decisions", and `Ledger.tsx` already uses `t.reword` and
   `scopeLabel(e.scope, t.reword)`. The new strings use these keys (`t.ledger`, `t.standingOrder`, `t.StandingOrders`).
   No local constant is needed.
4. **Review dates: this assumption was wrong. They have merged** (GWP-39, which replaced GWP-24). These changes follow
   from it:
   - Data model: there are nullable columns `ledger_entries.review_date` and `reviewed_at` (migration
     `2750_ledger_review_date.sql`). The events have an optional `reviewDate` on `LedgerEntryAdded` and a separate
     `LedgerEntryReviewDateSet`. The DTOs have `reviewDate` (nullable, default null) and `reviewDue`.
   - **Pack rules get no review date.** The installer leaves `reviewDate` out of the request it passes to
     `addLedgerEntryTx`, so the column stays NULL. The owner can set a date afterwards, like on any rule. This design
     adds no review-date field.
   - **A review date does not count as an edit.** `LedgerEntryReviewDateSet` does not touch `version`.
     `editLedgerEntry` sends a date-only change as that event alone. So a pack rule whose review date was set or
     confirmed still has `version = 1`, and removing the pack retires it. That fits the card's rule ("edited ones stay
     as the org's own"), because only the wording makes a rule the org's own. The server test covers it (§6).
   - **The split of `addLedgerEntryChecked` has to carry the review-date code.** `assertReviewDateNotPast(...)` runs
     before `withAppendTx` (line 76). Keep it in the wrapper. The core `addLedgerEntryTx` is the transaction body,
     now lines 78 to about 180, and it still writes `reviewDate` into `LedgerEntryAdded` when the request has one. The
     merge tail of the wrapper still passes `reviewDate` to `editLedgerEntry`. The line numbers in §3 below are
     updated.
   - **Where the badge goes.** In the metadata row of `Entry` (`Ledger.tsx` about lines 256-292), the order is: scope
     badge, then **`EnforcedByBadge`** and `from <pack name>` (new), then project key, card ref, author/date, Retired,
     May contradict, `ledger-review-date`, Review due, edited. All of these sit in the same `flex-wrap` row. The
     review-date elements stay where they are and keep their markup.
   - Migration number: GWP-27 and GWP-39 both used `2750`, and the latest migration is `2770_release_proposals.sql`.
     Use the next free number when you build (for example `2780_rule_packs.sql`).

The open point about the pack contents (the research file) does not change. The rest of the design stands as written
below.

## Question

Business organizations need ready-made sets of rules (standing orders) that the manager can preview and install in one
action. Each rule says how it is held: by a server gate that actually blocks a violation, or only as an instruction in
the agents' brief. The rules must reach agents exactly like hand-written standing orders. Installing a pack twice must
not duplicate anything. Removing a pack retires only the rules nobody edited. Dev organizations see no change.

The design question: how do we build this on the existing ledger path, without a second review-date field, without
claiming a "server check" that does not exist, and without any change for dev orgs?

## Blocker: the pack contents

The rule text, the pack list and the proposed enforcement come from the owner's research file
`projects/gwp/docs/business-mode/2026-10-27-business-mode-game-plan.md` (GWP vault). The industry packs come from
`projects/gwp/docs/business-mode/industry-roadmap.md`. **Neither file is on this workstation.** The local vault clone
holds only `org/` and `standing-orders.md`. I asked DevOps to sync the project vault (request f002bef9), and asked the
manager, in a non-blocking question, to attach both files to the card.

So this design fixes the mechanism, the data shape and the rules for the "enforced by" value. It does not fix the
rule text. **The builder copies the packs from the files word for word, and stops with a question if they cannot read
them.** Do not write placeholder rules, and do not paraphrase.

Scope of the packs. The card says "no vertical packs". For this card, the CEO's comment of 30 Oct (Johnny) overrides
that: "take the rule-pack contents from the research file; add industry packs for real estate, accounting and law"
(owner decision 4: the 1.4.0 verticals are real estate, accounting firms and law firms). The design ships:

- every general Phase 1 pack the research file lists, and
- one industry pack each for real estate, accounting and law, **but only where the files give word-for-word rule text
  for that industry**. An industry with no rule text in the files is not shipped, and the builder names it in the
  handoff.

I asked the manager to update requirement 2 and the "no vertical packs" constraint, so that review does not flag the
industry packs as out of scope.

## Findings

### The ledger write path

- `apps/server/src/commands/ledger.ts:68` `addLedgerEntryChecked` checks the review date
  (`assertReviewDateNotPast`) and then runs everything else in one `withAppendTx`. That transaction holds the global
  append lock `APPEND_LOCK_ID`, so every read-then-append is serialised across the server. Inside it:
  - Permissions: an org-wide entry needs `isOrgManager`.
  - It loads the live orders: `liveOrdersFor`, line 35, returns the org-wide orders plus this project's live standing
    orders.
  - Near-duplicate check: `findNearDuplicate` matches on the same normalised title, Jaccard ≥ 0.7, or containment
    ≥ 0.9. A match throws 409 `duplicate_order`. With `onDuplicate: 'merge'` the new text is merged instead, which
    rewrites the existing entry through `editLedgerEntry`.
  - Contradiction check: when `findContradictions` hits, it saves the entry and appends `LedgerEntryFlagged`. Then
    `raiseOrCoalesce` raises one `ledger_conflict` desk alert per entry in the same transaction
    (`{ tx, extra: events }`).
  - Otherwise it appends `LedgerEntryAdded`, with a `vaultPath` from `plannedVaultPath` for standing orders and an
    optional `reviewDate`.
- `PgEventStore.append` runs the projectors inside the caller's transaction. A second `liveOrdersFor` call in the same
  transaction therefore sees the rows just added.
- `editLedgerEntry` raises `ledger_entries.version` by one (the projection of `LedgerEntryEdited`) and keeps the
  earlier wording in `ledger_entry_versions`. A change to the review date alone appends only
  `LedgerEntryReviewDateSet` and leaves `version` alone. **`version = 1` means the wording was never edited**, which
  is exactly the "untouched" test that removal needs. Tags survive an edit (`req.tags ?? e.tags`), and the web edit
  form does not send tags.
- `commands/ledger-retire.ts:23` `retireLedgerEntryAs` appends `LedgerEntryRetired` (plus `voidAuthorityEvents`) in its
  own transaction, with no permission check. A retired entry is never put in a brief and never found by a search.

### How standing orders reach agents

`queries/ledger.ts` `standingOrdersFor` and `standingOrdersForProjects` select every live `standing_order` row of the
org (and of the project). They are called from `runner-gateway/brief.ts` (the card shift brief and the DevOps request
brief), `runner-gateway/ba-task-brief.ts` and `chat/relay.ts`. A pack rule stored as an ordinary `ledger_entries` row
reaches all of them **with no change to these files**. That is what requirement 5 asks for.

### Data model today

Apart from `source_desk_item_id`, `ledger_entries` has no column that says where an entry came from. Every field of the
`LedgerEntryAdded` event beyond the core ones is optional. The DTO `LedgerEntryDtoSchema` uses
`.default()`/`.optional()` for each field added since M2, including the new `reviewDate`, so adding more optional
fields follows the existing pattern. The names `RulePack`, `EnforcedBy` and `rule-pack` appear nowhere in GuildwiseHQ
or Guildwise Cloud, so the new exports do not clash. Capability packs already use `streamId.pack`, `commands/packs.ts`
and `/api/packs`. This feature therefore says **rule pack** everywhere (`rulePack`, `rule_pack_*`,
`/api/ledger/rule-packs`), so the two kinds of pack never get mixed up.

### Server gates that exist today (candidates for "server check")

A rule may be badged "server check" only when a gate in this release refuses the action the rule forbids. The table
lists the gates I found that a business rule could plausibly point at. Each one needs a proof test (see §6):

| Check id (proposed) | What the server refuses | Where |
|---|---|---|
| `client_mail_sent_by_person` | An e-mail reply to a client goes out only when a person sends it. The BA only drafts replies (`mail_reply_drafts`), and the reply route needs a user session. | `commands/mail-reply.ts`, mail reply route |
| `client_mail_no_ai_mention` | A reply that names agents, AI or the product is refused with 422, so the person rewords it. | `commands/mail-reply.ts` (`revealedMarkers`) |
| `client_mail_rate_limit` | Replies beyond the org's hourly cap are refused (`reply_rate_limited`). | `commands/mail-reply.ts` |
| `outbound_post_needs_approval` | Nothing is posted to an outside system until the card owner approves it, and every draft and edit goes through the leak check. | `commands/outbox.ts`, `commands/leak-check.ts` |
| `monthly_budget_hold` | A project over its monthly budget, or paused by an Owner/Admin, starts no new work. | `dispatcher/candidates.ts`, `dispatcher/project-hold.ts`, `commands/budgets.ts` |
| `approval_step_waits_for_person` | A card at an approval step waits for a person's decision. | `commands/approval.ts` |
| `org_rules_by_managers` | Only the Owner and Admins add, edit or retire org-wide rules. | `commands/ledger.ts`, `ledger-retire.ts` |
| Business mode guards (landed) | In a business org: adding a repository, hiring builder/reviewer/tester/DevOps, adding a pack by git URL. | `apps/server/src/orgs/mode.ts` `assertDevMode`, `BUSINESS_MODE_MSG` |

These are candidates, not the answer. The builder maps a research-file rule to a check **only when the rule forbids
exactly what the gate refuses**. Every other rule is "Agent instruction", even when the research file proposes server
enforcement for it. List every such downgrade in the handoff, and put a follow-up for the missing gate on the backlog
(`aom backlog suggest`). This card builds no new gate, because the card says: "do not mark a rule 'server check'
unless the check exists in this release".

## Options

### Where the pack link lives

- **A. Tags only** (`rule-pack:<pack>`, `rule-pack-rule:<pack>/<rule>` in `ledger_entries.tags`). No migration is
  needed. But any API caller can change tags through `PATCH /api/ledger/:id` and `POST /api/ledger`. A caller could
  forge a pack link or drop one by accident, and idempotence would then rest on free text. It also cannot be enforced
  with a unique index.
- **B. Two nullable columns on `ledger_entries`** (`rule_pack_id`, `rule_pack_rule_id`). They are set only from an
  optional `rulePack` field of `LedgerEntryAdded`. Only the install command writes that field, and it is not in
  `CreateLedgerEntryRequestSchema`. A partial unique index guards idempotence. The change is additive: two nullable
  columns, an optional event field and an optional DTO field.
- **C. A separate link table** `rule_pack_entries(entry_id, pack_id, rule_id)`. It gives the same guarantees as B, but
  adds one more projection table and a join in every DTO query.

**Recommendation: B.** It is the smallest change that keeps the pack link out of users' hands. `DTO_SELECT` already
selects `e.*`, so the DTO picks the columns up with no join. An org-level table of installed packs (§2) records the
install state and the history.

### How install uses the ledger path

- **A. Call `addLedgerEntryChecked` once per rule.** That is one transaction per rule. A failure halfway leaves the
  pack half installed. Running the install again repairs it, because install is idempotent. But there is no single
  "pack installed" event to hang the history on, and the 409 from a near-duplicate has to be caught rule by rule.
- **B. Split `addLedgerEntryChecked` into a wrapper and a core that runs inside a given transaction**
  (`addLedgerEntryTx`), and run the whole install in one `withAppendTx`. The existing wrapper keeps its signature and
  its behaviour. The pack installer calls the core with an internal "skip duplicates" mode. Every check (permissions,
  near-duplicate, contradiction, the desk alert, the vault path, the review date) runs the same code.

**Recommendation: B.** It meets the requirement "through the existing ledger path (addLedgerEntryChecked, so
near-duplicate and contradiction checks apply)", because the function body is the same, and the install is atomic.
`retireLedgerEntryAs` is split the same way (`retireLedgerEntryTx`) for removal.

### What "enforced by" shows for an edited rule

Once the org edits a pack rule, the wording is the org's own, and the product can no longer promise that the server
gate matches the new text. **Decision: the badge shows the pack's value only while `version = 1`. An edited pack rule,
and every hand-written rule, shows "Agent instruction".** This keeps AC 2 ("no rule claims server enforcement without
one") true by construction. A review-date change does not raise `version`, so it does not change the badge.

## Recommendation and design

### 1. Pack catalogue: `packages/shared/src/ledger/rule-packs.ts` (new; export it from the package index)

The module holds only data and types, so the server (install, preview, DTO) and the web (badge labels) read one
source. Additive only.

```ts
/** How a rule is held. `server_check`: a server gate refuses the violation; `agent_instruction`: agents are told in the brief. */
export const EnforcedBy = z.enum(['server_check', 'agent_instruction']);
export type EnforcedBy = z.infer<typeof EnforcedBy>;

/** The server gates a rule may point at. Each one has a proof test (apps/server/test/rule-pack-server-checks.test.ts). */
export const SERVER_CHECKS = {
  // Fill in ONLY the checks a shipped rule uses, from the candidate table in the design report, e.g.:
  // client_mail_no_ai_mention: { summary: 'Replies to clients that mention AI or agents are refused.' },
} as const satisfies Record<string, { summary: string }>;
export type ServerCheckId = keyof typeof SERVER_CHECKS;

export interface RulePackRule {
  /** Stable within the pack (kebab-case); never reused for different text. */
  id: string;
  /** Verbatim from the research file. */
  title: string;
  body: string;
  /** Phase 1: org-wide standing orders only. */
  scope: 'standing_order';
  enforcedBy: EnforcedBy;
  /** Required when enforcedBy is server_check, absent otherwise. */
  serverCheck?: ServerCheckId;
  /** Where the text comes from, for the reviewer: file and table/row, e.g. 'game-plan §Rule packs, row 3'. */
  source: string;
}

export interface RulePack {
  id: string;            // kebab-case, unique
  version: number;       // 1 for this release
  name: string;          // verbatim
  description: string;   // verbatim
  kind: 'general' | 'industry';
  industry?: 'real_estate' | 'accounting' | 'law';
  rules: RulePackRule[];
}

export const RULE_PACKS: readonly RulePack[] = [ /* from the research file, verbatim */ ];
export const rulePackById = (id: string) => RULE_PACKS.find((p) => p.id === id);

/** Display labels, one place. */
export const ENFORCED_BY_LABEL: Record<EnforcedBy, string> = {
  server_check: 'Guildwise (server check)',
  agent_instruction: 'Agent instruction',
};

/** The value a ledger row shows: the pack's own while the rule is unedited, else agent instruction. */
export function enforcedByFor(row: { rulePackId: string | null; rulePackRuleId: string | null; version: number }): EnforcedBy;
```

Label spelling: the web app writes the product name as "Guildwise" (314 occurrences), while the card writes
"GuildWise". The constant uses the app's spelling. If the owner prefers the card's spelling, it is a one-line change.

How the research file maps to the fields: the pack's name and description go to `name` and `description`. A rule's
short form, if the file has one, goes to `title`, and its full text to `body`. If the file has only one text per rule,
`title` is its first sentence (cut at the first full stop, at most 300 characters) and `body` is the whole text, both
word for word; do not rewrite either. The file's "compliance rules" are rules like the others. Each goes into the pack
the file puts it in, and its `enforcedBy` follows the gate test above.

### 2. Data model (server)

Migration `apps/server/migrations/<next>_rule_packs.sql`. Use the next free number after `2770` (for example `2780`).

```sql
-- Rule packs (business mode): built-in sets of standing orders an organization installs in one action.
ALTER TABLE ledger_entries
  ADD COLUMN IF NOT EXISTS rule_pack_id      text,
  ADD COLUMN IF NOT EXISTS rule_pack_rule_id text;
-- One live row per pack rule and organization: a second install finds it and adds nothing.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_rule_pack_live ON ledger_entries (org_id, rule_pack_id, rule_pack_rule_id)
  WHERE rule_pack_rule_id IS NOT NULL AND retired_at IS NULL AND superseded_by IS NULL;

-- Projection of RulePackInstalled / RulePackRemoved: which packs an organization has installed.
CREATE TABLE IF NOT EXISTS org_rule_packs (
  org_id        uuid NOT NULL,
  pack_id       text NOT NULL,
  pack_version  integer NOT NULL,
  installed_at  timestamptz NOT NULL,
  installed_by  uuid,
  removed_at    timestamptz,
  removed_by    uuid,
  PRIMARY KEY (org_id, pack_id)
);
```

Add `org_rule_packs` to `PROJECTION_TABLES` in `apps/server/src/projections/index.ts`. The design adds no review-date
column: pack rules use the existing `review_date` and leave it NULL.

Events (`packages/shared/src/events/ledger.ts`, additive):

```ts
// LedgerEntryAdded payload gains (next to the existing optional reviewDate):
rulePack: z.object({ packId: z.string().min(1).max(80), ruleId: z.string().min(1).max(80),
                     packVersion: z.number().int().positive() }).optional(),

defineEvent('RulePackInstalled', z.object({
  packId: z.string().min(1).max(80), packVersion: z.number().int().positive(),
  added: z.array(Id).max(200),                                   // new entries
  kept: z.array(Id).max(200).default([]),                        // already installed (edited or not)
  skipped: z.array(z.object({ ruleId: z.string(), existingId: Id })).max(200).default([]), // covered by the org's own rule
})),
defineEvent('RulePackRemoved', z.object({
  packId: z.string().min(1).max(80),
  retired: z.array(Id).max(200), kept: z.array(Id).max(200).default([]),               // kept = edited, stay as the org's own
})),
```

Stream: add `rulePack: (orgId, packId) => \`rule-pack-${orgId}-${packId}\`` to `streamId` (`packages/shared/src/ids.ts`).
Projectors (`apps/server/src/projections/ledger.ts`):

- `LedgerEntryAdded` also writes `rule_pack_id` and `rule_pack_rule_id` (null when the event has no `rulePack`). Keep
  the existing `review_date` handling as it is.
- `RulePackInstalled` upserts the `org_rule_packs` row and clears `removed_*`.
- `RulePackRemoved` sets `removed_at` and `removed_by`.

DTO (`packages/shared/src/api/ledger.ts`, additive optional):

```ts
/** Set when the entry came from a rule pack (business mode). */
rulePack: z.object({ id: z.string(), name: z.string(), ruleId: z.string() }).nullable().default(null),
/** Standing orders: how the rule is held (business mode shows it as a badge). */
enforcedBy: EnforcedBy.optional(),
```

`toLedgerDto` (`queries/ledger.ts`) fills both fields. `rulePack` comes from the columns plus the pack name from the
catalogue; if the pack no longer exists in the code, the pack id stands in as the name. For standing orders,
`enforcedBy` comes from `enforcedByFor`.

### 3. Commands: `apps/server/src/commands/rule-packs.ts` (new)

Refactor first, with no change in behaviour:

- `commands/ledger.ts`: move the transaction body (the callback passed to `withAppendTx`, today lines 78 to about 180)
  into `export async function addLedgerEntryTx(ctx, tx, user, requestOrg, req, opts?: { rulePack?: {...}; onDuplicate?: 'skip' })`.
  The wrapper `addLedgerEntryChecked` keeps, in this order:
  1. `assertReviewDateNotPast(req.reviewDate, ...)` before the transaction;
  2. `withAppendTx(ctx.pool, (tx) => addLedgerEntryTx(...))`;
  3. the existing merge tail, which still passes `reviewDate` to `editLedgerEntry`.

  With `opts.onDuplicate === 'skip'`, a near-duplicate returns `{ skipped: true, existingId, existingTitle }` instead
  of throwing. `opts.rulePack` adds `rulePack` to the `LedgerEntryAdded` payload. Neither option is in the request
  schema, so `POST /api/ledger` cannot set them. Export `liveOrdersFor`.
- `commands/ledger-retire.ts`: move the body into `retireLedgerEntryTx(ctx, tx, entryId, input, by)`. The wrapper
  `retireLedgerEntryAs` calls it inside its own transaction.
- `apps/server/src/orgs/mode.ts`: add `assertBusinessOrg(db, orgId)`. It is the inverse of `assertDevMode`: a
  `FOR SHARE` read of `organizations.mode` and `conflict('business_only', ...)` when the org is not a business org.

Then the new module:

```ts
export async function previewRulePack(ctx, user, orgId, packId): Promise<RulePackPreviewDto>;
export async function installRulePack(ctx, user, orgId, packId): Promise<RulePackInstallResultDto>;
export async function removeRulePack(ctx, user, orgId, packId): Promise<RulePackRemoveResultDto>;
```

**Preview.** Any active member of the org may read it, in business orgs only. It reads the live rows linked to the
pack and `liveOrdersFor(org, undefined)`, and gives each rule one of these statuses:

| Status | When |
|---|---|
| `new` | No live row is linked to the rule. |
| `installed` | A live linked row with `version = 1`. |
| `edited` | A live linked row with `version > 1`. |
| `covered` | `findNearDuplicate` finds one of the org's own rules. The preview shows that rule's title. |
| `may_conflict` | `findContradictions` finds rules the pack rule may contradict. The preview names them. |

The pack-level `installed` flag is read from `org_rule_packs` (`removed_at IS NULL`).

**Install.** Org managers only, in business orgs only. All of it runs in one `withAppendTx`:

1. Run `assertBusinessOrg` and `isOrgManager`. `rulePackById` returns 404 for an unknown pack.
2. Read the live rows already linked to this pack in the org. Their rule ids go to `kept` and are not added again.
3. For every other rule, in catalogue order, call
   `addLedgerEntryTx(ctx, tx, user, orgId, { scope: 'standing_order', title, body, tags: [] }, { rulePack, onDuplicate: 'skip' })`.
   The request has no `reviewDate`, so the rule gets no review date. A skipped rule goes to `skipped`: the org's own
   rule stays as it is and gets no pack link. An added rule goes to `added`. Contradictions are flagged and raise the
   desk alert, exactly as for a hand-written rule.
4. Append `RulePackInstalled` (stream `rulePack(orgId, packId)`, org scope, user actor).

Installing again: every rule is already in `kept` or `skipped`, so nothing is added. `RulePackInstalled` is still
appended, so the history shows the click; its projection upsert changes nothing. If two installs ever race, the unique
index is the safety net, but the global append lock already serialises them.

**Remove.** Org managers only, in business orgs only, in one `withAppendTx`. It goes through every live row linked to
the pack:

- `version = 1` (wording never edited, even if a review date was set): retire it with
  `retireLedgerEntryTx(..., { reason: \`Removed with the rule pack "${pack.name}"\` }, { actor: userActor(user.id), label: 'owner' })`
  and record it in `retired`.
- `version > 1`: record it in `kept` and leave the row alone. It stays as the org's own rule and keeps its pack link,
  so a later install does not add the pack's wording next to it.

Then append `RulePackRemoved`. Removing a pack that is not installed returns zero counts and appends nothing.

Installing after a remove: the retired rows are no longer live, so the install adds fresh rows. The edited rows are
still live and linked, so they go to `kept`.

### 4. API: `apps/server/src/routes/ledger.ts` (new routes, registered before the `:id` routes)

| Method and path | Who | Response |
|---|---|---|
| `GET /api/ledger/rule-packs` | org member, business org | `{ packs: [{ id, name, description, kind, industry, ruleCount, installed }] }` |
| `GET /api/ledger/rule-packs/:packId` | org member, business org | `RulePackPreviewDto`: the pack, `installed`, and `rules: [{ id, title, body, enforcedBy, serverCheckSummary, status, existing?: { id, title }[] }]` |
| `POST /api/ledger/rule-packs/:packId/install` | Owner/Admin, business org | `{ added, kept, skipped: [{ ruleId, existingId, existingTitle }], flagged: [entryId] }`, 200 |
| `POST /api/ledger/rule-packs/:packId/remove` | Owner/Admin, business org | `{ retired, kept }`, 200 |

The org comes from `resolveOrgId(ctx, s, requestedOrgId(req))`, the same as for `/api/ledger`. In a dev org every route
returns 409 `business_only` with the message "Rule packs are available in business organizations." The request and
response schemas go in `packages/shared/src/api/ledger.ts` (additive).

### 5. Web

- `apps/web/src/api/queries/ledger.ts`: add `useRulePacks()`, `useRulePackPreview(id)`, `useInstallRulePack()` and
  `useRemoveRulePack()`. The two mutations invalidate `['ledger']` and `['rule-packs']`.
- `apps/web/src/components/EnforcedByBadge.tsx` (new): `<Badge tone={server ? 'green' : 'neutral'} icon={…}
  data-testid="enforced-by" title={explanation}>{ENFORCED_BY_LABEL[value]}</Badge>`. Use the lucide icons
  `ShieldCheck` for a server check and `MessageSquare` for an agent instruction. A tooltip does not show on touch, so
  the dialog also shows the explanation as text (below).
- `apps/web/src/components/RulePacksDialog.tsx` (new):
  - A list of packs, grouped "General" and "Industry". Each shows its name, description, rule count and an
    "Installed" badge.
  - Choosing a pack opens its preview. Each rule shows its title, its body (with "Show more", like `Entry`),
    `EnforcedByBadge` and a status line: `Already installed`, `You edited this rule`,
    `Covered by your rule "…" (not added)` or `May contradict "…"`. One legend line explains both badge values in
    text.
  - Buttons: **Install pack** (primary; hidden when everything is installed) and **Remove pack** (shown when the pack
    is installed). Only an Owner or Admin sees them (`useActiveOrgRole`). Remove asks for confirmation first: "Rules
    from this pack that nobody edited are retired. Rules you edited stay as your own." The success toast states the
    counts.
  - The dialog must work on a phone: it scrolls, its buttons get the `[@media(pointer:coarse)]` touch height like the
    rest of `ui.tsx`, and no control works on hover only.
- `apps/web/src/pages/Ledger.tsx`, business orgs only (`useBusinessMode()` from `apps/web/src/lib/orgMode.ts`):
  - Header actions: a **Rule packs** button next to "Add entry", which opens `RulePacksDialog`.
  - `Entry`: when `scope === 'standing_order'`, add `<EnforcedByBadge value={e.enforcedBy ?? 'agent_instruction'} />`
    right after the scope badge in the metadata row, and add `from <pack name>` when `e.rulePack` is set. The existing
    `ledger-review-date` and `ledger-review-due` elements stay where they are, later in the same `flex-wrap` row, and
    keep their markup. No new review-date element is added.
  - Dev orgs: neither element is rendered, and the new DTO fields are ignored. Dev markup stays byte-identical.
- Wording: only business orgs see the new strings. Build them from the `useOrgTerms()` keys (`t.ledger`,
  `t.standingOrder`, `t.StandingOrders`) or `t.reword`, so the words come from the one helper.

### 6. Tests (builder)

| Test file | What it proves |
|---|---|
| `packages/shared/test/rule-packs.test.ts` (new) | Catalogue checks: pack ids are unique; rule ids are unique within a pack; every rule has `enforcedBy`; a rule is `server_check` exactly when `serverCheck` is set, and the id is in `SERVER_CHECKS`; titles are 1 to 300 characters and bodies 1 to 20000 (the event limits); `kind` and `industry` agree; the pack id list equals the expected list, so adding or dropping a pack is a visible change. `enforcedByFor` gives the pack value at version 1, and `agent_instruction` when the rule is edited or hand-written. |
| `apps/server/test/rule-packs-catalogue.test.ts` (new, no DB) | No two rules in the catalogue are near-duplicates (`isNearDuplicate`), and none contradicts another (`contradicts`), so an install never flags itself. |
| `apps/server/test/rule-pack-server-checks.test.ts` (new, DB) | `const PROOFS = { … } satisfies Record<ServerCheckId, (w: World) => Promise<void>>`, so a server check without a proof is a type error. One `it` per shipped `server_check` rule runs its check's proof: it performs the forbidden action and expects the refusal (for example, a reply that names the agents gets 422; a project over budget is not a dispatch candidate). AC 2. |
| `apps/server/test/rule-packs.test.ts` (new, DB; copy the setup of `ledger-retire.test.ts`) | **Dev org:** all four routes return 409 `business_only`. **Install:** an Admin installs; the entries get `rule_pack_*` set and `review_date` NULL, and an `org_rule_packs` row appears; a member cannot install (403); a second install adds nothing and the ledger count is unchanged. **Overlap with the org's own rules:** an own near-duplicate rule is `skipped` and stays unlinked and unchanged; a contradicting own rule is flagged and raises one desk alert. **Briefs:** `standingOrdersFor` and `standingOrdersForProjects` include the pack rules (AC 4), and the brief built by `runner-gateway/brief.ts` contains a pack rule's title. **Remove:** edit one rule's wording and set only a review date on another, then remove the pack: the date-only rule and the other unedited ones are retired with the reason, and the edited one stays live and is in `kept`. **Reinstall:** the retired rules come back as new rows, and the edited one is `kept`. **DTO and API:** `GET /api/ledger` carries `rulePack` and `enforcedBy`; an edited server-check rule shows `agent_instruction`; `POST /api/ledger` cannot set a pack link. |
| Existing suites unchanged | `ledger-edit`, `ledger-retire`, `ledger-search`, `ledger-cleanup`, `ledger-review-date`, `questions` and the web `ledger-edit.test.tsx` must pass with no edits. They prove that splitting out `addLedgerEntryTx` and `retireLedgerEntryTx` changed no behaviour. Do not edit existing test files: a modified test file outside the card's affected areas trips the runner's `out_of_scope_test_change` flag. |
| `apps/web/src/test/rule-packs.test.tsx` (new) | **Business mode:** an Admin sees the Rule packs button; the dialog lists the packs; the preview shows an `enforced-by` badge with the right label on each rule; install calls the API and toasts the counts; remove asks for confirmation; a member sees the preview with no install button. **Ledger page:** a pack rule shows its badge and "from …"; a hand-written rule shows "Agent instruction"; a rule with a review date shows both the badge and `ledger-review-date`. **Dev mode:** no button and no `enforced-by` badge. |
| `apps/web/src/test/enforced-by-badge.test.tsx` (new, or part of the file above) | Both labels and both test ids. |
| E2E `e2e/tests/business-rule-packs.spec.ts` | **The tester writes this one**: builders may not edit `e2e/**` (CEO ruling, ledger aadf93f9 and later). A business org manager installs a pack and sees the badged rules. |

The word-for-word check (AC 5) cannot be a repository test, because the research file is not in the repository.
Instead, every rule carries `source` (file and row), and the reviewer compares the text with the file. If the file's
tables can be parsed, the builder may add a test that reads the file from the vault path when it exists and skips
otherwise. Do not copy the file into the repository.

## Acceptance criteria → design → test

| AC | Design | Test |
|---|---|---|
| A business org manager can preview each shipped pack and install it; its rules appear in Rules & decisions, each with an "enforced by" badge | §3 preview and install, §4 routes, §5 dialog and `Entry` badge | `apps/server/test/rule-packs.test.ts` (install, preview, DTO); `apps/web/src/test/rule-packs.test.tsx`; the tester's e2e |
| A "server check" rule is actually blocked by a server check (a test proves it); no rule claims server enforcement without one | §1 `SERVER_CHECKS`, with `serverCheck` required; the mapping rule in Findings ("Server gates that exist today": the exact gate only, otherwise Agent instruction); `enforcedByFor` downgrades edited rules | `rule-pack-server-checks.test.ts` (`PROOFS satisfies Record<ServerCheckId, …>`); `packages/shared/test/rule-packs.test.ts` |
| Installing twice creates no duplicates; removing retires only unedited pack rules | §2 columns and unique index; §3 `kept`/`skipped`, and the `version = 1` test on remove (a review date does not count as an edit) | `apps/server/test/rule-packs.test.ts` (reinstall, remove, install after remove) |
| Installed rules appear in agents' standing orders in their next shift brief | Pack rules are plain `ledger_entries` standing orders; `standingOrdersFor*` is unchanged | `rule-packs.test.ts`: `standingOrdersFor`, `standingOrdersForProjects` and the shift brief contain the rule |
| Pack rule text matches the research file verbatim | §1: text copied word for word, a `source` per rule, and the builder stops if the file cannot be read | The reviewer compares the text with the file; an optional file-reading test skips when the file is absent |

## Risks

- **The research file is missing on this workstation.** Without it, no pack can be shipped. The builder checks the
  vault path and the card attachments at the start, and asks if both are missing.
- **Claiming "server check" too often.** The type-level proof table and the rule "exact gate or Agent instruction"
  guard against it. The reviewer should read every `server_check` rule next to its proof.
- **Refactoring `addLedgerEntryChecked`.** Its only caller today is `POST /api/ledger`. The other modules that append
  `LedgerEntryAdded` (`decisions.ts`, `escalation.ts`, `investigation.ts`, `desk.ts`, `ceo/actions*.ts`, `hr/hr.ts`)
  write their own events and are not touched. Keep the wrapper's signature, the review-date check before the
  transaction, and the merge tail exactly as they are; the existing ledger suites, including `ledger-review-date`, prove
  it. The projector change (two new nullable columns) affects every `LedgerEntryAdded`, so run those modules' tests
  too.
- **Desk noise.** Each pack rule that contradicts an existing org rule raises its own `ledger_conflict` alert, as a
  hand-written rule does today. That is acceptable, because the preview shows `may_conflict` before the click.
- **Industry packs vs. the card text.** The design follows the CEO comment. If the manager answers "general packs
  only", drop the `industry` packs from `RULE_PACKS` and from the expected-id list; nothing else changes.
- **A future pack version changes a rule's text.** Out of scope. `packVersion` is recorded so that an upgrade path can
  be built later. Today, changed text under the same rule id is not applied again.
- **Switching a business org back to dev.** Installed rules stay ordinary standing orders, and agents keep getting
  them. Only the badges and the dialog disappear, and no data is lost.
- **Guildwise Cloud** imports `@aom/shared` and `@aom/server`. Every change is additive: new exports, optional event
  and DTO fields, new events and a new `streamId` key.

## Assumptions (checked 31 Oct against the landed code)

1. Org mode flag: **holds** (`isBusinessOrg`/`OrgMode`, `orgModeOf`/`assertDevMode`, `useBusinessMode`).
2. A refused mode action is a 409 with a plain message: **holds**. The new code is `business_only`, read `FOR SHARE`
   like `assertDevMode`.
3. `useOrgTerms()` with keys and `reword`, and the page named "Rules & decisions" in business orgs: **holds**.
4. Review dates not merged: **wrong, they have merged** (GWP-39). Pack rules leave the optional `review_date` empty, a
   date-only change does not count as an edit, the badge goes in the same metadata row before the review-date
   elements, and no second review-date field is added. See the revision section at the top.
5. The research file and the industry roadmap list the Phase 1 packs and the per-industry rules in a form that can be
   copied word for word. An industry with no rule text in the roadmap gets no pack. **Still open**: the files are not
   on this workstation.
