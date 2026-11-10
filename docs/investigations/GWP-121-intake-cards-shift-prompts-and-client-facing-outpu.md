# GWP-121: Intake cards use the ticket reference in shift prompts and client-facing outputs

Part 2 of 3 of GWP-119. The first version of this design was written on `origin/release/1.6.0` (104c3122), before GWP-120 landed. This version has been checked against the landed GWP-120 code (`main` at 9288c422: `packages/shared/src/cards/work-ref.ts`, `ShiftBriefSchema.card`, `apps/server/src/runner-gateway/brief.ts`, `drafts.ts`, `card-facts.ts`). Section 8 records what was checked and what changed.

## 1. Question

When a card was made from an intake that carries a client ticket (for example `ABC-1`), how do we make sure of two things?

- Every agent prompt (builder, reviewer, tester, DevOps; the BA's Finalize prompt is the same card prompt) tells the agent to use `ABC-1`, never the internal key `GWP-123`, in commits, branch names, PR texts and client texts.
- Every client-facing text the platform drafts or composes (ticket comments and status updates through the outbox, and changelog lines from release prep) names `ABC-1` and never `GWP-123`.

Cards without a ticket must stay byte-for-byte as they are today.

## 2. Findings (current code)

### 2.0 What GWP-120 provides (landed)

- `packages/shared/src/cards/work-ref.ts` (exported from `@aom/shared`):
  - `cardTicketRef(fields): ExternalRef | null`: the ticket from `fields.externalRef`, with the key canonicalised (`canonicalTicketKey`: Jira upper-case, GitHub `owner/repo#12` as it is).
  - `workReference({ ref, fields }): { ref, isClientRef, ticket }`: the ticket key when the card has one, otherwise the internal ref. It is pure and needs no DB.
  - `cardBranchName`, `ticketBranchPart`, `workRefBranchPart`: branch naming (not used here).
- `ShiftBriefSchema.card` has two **flat** optional fields: `workRef?: string` and `isClientRef?: boolean`. Older servers send neither.
- `apps/server/src/runner-gateway/brief.ts` exports `briefWorkRef(card: Row): { workRef, isClientRef }`, and `buildBrief` spreads it into `card`. `DevopsShift.card` (`devopsCardBrief`) does **not** get it yet.
- `card-facts` returns `workRef` / `isClientRef`.
- `drafts.ts` `cardTicket(card)` now delegates to `cardTicketRef(card.fields)`. So for an intake card `cardTicket(card).key === workReference(card).ref`.
- There is no new column and no migration. Several cards of one ticket share the work reference. Only their **branch names** get a `-2`, `-3` suffix (`uniqueCardBranch`).

### 2.1 Prompts

| Where | What it says about references today |
|---|---|
| `packages/shared/src/prompt/instructions.ts` `renderInstructions` (the agent's CLAUDE.md), "How to report" | A generic sentence: "Write each commit message as a short plain description of the change (start it with the ticket key, such as DCPL-4276, only when the card came from a ticket)". It never names the card's actual ticket. This text is built to be the same for the whole role and project, so the prompt cache prefix can be shared. Card data does not belong here. |
| `packages/shared/src/prompt/shift-prompt.ts` `renderShiftPrompt` (the `-p` prompt, per card) | Heading `# ${card.ref}`. The ticket only shows up as the raw `externalRef` field if the agent opens the fields. There is no instruction about the reference, and it does not read `card.workRef` yet. Builder, reviewer, tester, pre-reviewer, BA (Finalize, where it drafts the ticket update), architect and planner all get this same prompt through `apps/runner/src/devops/requests.ts` `rawShiftTexts` → `renderShiftPrompt(brief)`. |
| `packages/shared/src/prompt/devops.ts` `cardSection` / `renderDevopsPrompt` / `renderDevopsInstructions` | The DevOps card comes from `DevopsShift.card`, which the server builds in `devopsCardBrief`. It has `ref`, `title` and the raw `fields` JSON, and no work reference. DevOps does make commits: it resolves merge conflicts in card worktrees and writes merge commits. |
| `packages/shared/src/roles/builtin.ts` | The role texts are generic ("with the ticket key if it helps" in the BA's outbound rule, ~181). No card data, so nothing to change. |
| `apps/runner/src/aom/aom-cli.ts` `aom card` | Prints `renderShiftPrompt(brief)` / `renderDevopsPrompt(brief.devops)` again, so it picks up the new sections automatically. |

Note: the "rawShiftTexts" function named on the card lives in `apps/runner/src/devops/requests.ts`, not in `aom-cli.ts`.

### 2.2 Outbound (ticket comments and status updates)

- `apps/server/src/commands/drafts.ts` `draftOutboundIn` takes the target from `cardTicket(card)`. The body is written by the BA (`outboundDraftRpc`) or the manager (`createManagerDraft`) and posted **as is**: `GithubAdapter.postApproved` / the Jira adapter add nothing, and nothing the platform adds names the card.
- So the only way `GWP-123` reaches the client is through the text someone writes. The leak check (`packages/shared/src/external/leak-check.ts` `checkOutboundLeaks`) runs on the draft (server), on the manager's edit (`outbox.ts` `resolveOutboundIn`) and once more before posting (runner `OutboundExecutor.post`). It only catches `card GWP-123` (the 'card reference' pattern). A bare `GWP-123` gets through.
- The `outbound.post` payload already carries `cardRef`, so the runner can scrub the internal key without a protocol change. `payload.ref.key` is the canonical ticket key, because it comes from `cardTicket`.
- Desk titles and thread messages around drafts ("An update for ABC-1 …") are internal and already use the ticket key.

### 2.3 Changelog / release notes

- `releaseChangelog` / `composeReleaseSection` (`changelog-rewrite.ts`, `components.ts`) only move the Unreleased block and write the intro from component bumps. They never name a card. **No change is needed there.**
- The lines themselves come from release prep's 'Write changelog' step. The runner `analyse` (`apps/runner/src/git/release-docs-prep.ts` `cardKeys`) collects every `[A-Z][A-Z0-9]+-\d+` in the merge commit messages as `cardKeys`. That already includes ticket keys, because `completion.ts` `mergeMessage` uses the ticket. The server's `buildReleaseChangelogTask` (`apps/server/src/release/docs-prep-changelog-task.ts`) looks up titles with `cards.ref = ANY(keys)` and gives the BA writer `cards: [{key, title}]`. So for an intake card the writer sees the internal key, and a ticket key matches no card.
- The writer is told never to write ticket keys, and `scrubChangelogEntry` refuses any `[A-Z][A-Z0-9]+-\d+`. So today **no** line has any key, internal or ticket. AC5 needs the ticket reference on lines for intake cards, so the platform has to add it after the gate, in code. The model must not write it.
- `release-notes` / blog pages read the CHANGELOG. `publicText` removes `#12` and `@handles` but leaves `ABC-1` (and `owner/repo#12`) alone.

### 2.4 Not client-facing (stays as it is)

The board, card thread, desk items, phase reports, the `# GWP-123` prompt heading, `aom` commands and the e-mail templates in `apps/server/src/mail/templates.ts`. Those templates are support-request refs, not cards.

## 3. Options

### 3.1 Where the instruction goes in the prompt

| Option | For | Against |
|---|---|---|
| A. Put the card's reference into `renderInstructions` (CLAUDE.md) | One place | Breaks the shared prompt-cache prefix (card data in a role/project text). It also changes the instructions of every card if done without a condition. |
| **B. New `## Work reference` section in `renderShiftPrompt`, only for intake cards** (recommended) | Per-card text in the per-card prompt. Every card role gets it through one function. A non-intake card's prompt stays byte-identical (AC3). | None worth noting. |
| C. A section for every card, with the project key for non-intake cards | Same shape everywhere | It changes non-intake prompts. It would also push agents to put `GWP-123` into commit messages, which is not what happens today (today's rule is a plain description). That breaks requirement 2. |

### 3.2 Stopping the internal key in outbound texts

| Option | For | Against |
|---|---|---|
| A. Prompt instruction only | Simple | The model can still slip, and the manager's own text is not covered. |
| B. Rewrite `GWP-123` to `ABC-1` silently | No retry | It changes approved text behind the manager's back (the outbox contract is "posted exactly as approved"). |
| **C. Prompt instruction plus a leak-check rule that refuses the card's internal key** (recommended) | Uses the existing three checkpoints (draft, manager edit, runner before posting) and the existing "refused, rewrite it" flow | One more refusal message. |

### 3.3 Ticket reference on changelog lines

| Option | For | Against |
|---|---|---|
| A. Keep lines free of all keys | No change | Fails AC5 ("references ABC-1"). |
| B. Let the writer (model) include the ticket key | Little code | The gate would need an exception per key. The model is unreliable and could still copy the internal key. |
| **C. Pass the work reference to the writer instead of the internal key, then have the platform add ` (ABC-1)` to each accepted entry whose sources include an intake card** (recommended) | Deterministic and testable. The writer never sees `GWP-123` for an intake card. Non-intake lines are untouched. | The public changelog of a repository now carries client ticket keys for intake work. That is intended: the repository and its changelog belong to the client. See the risks. |

## 4. Recommendation and design

All work is in GuildwiseHQ: `packages/shared`, `apps/server` and `apps/runner`. Nothing changes in guildwise-cloud.

### 4.1 One reader for the brief's work reference (shared)

`packages/shared/src/prompt/work-ref.ts` (new, exported from the prompt index). It reads GWP-120's flat brief fields. It does **not** re-derive anything from `externalRef`. It is named `shiftWorkRef`, not `briefWorkRef`, because the server already exports a `briefWorkRef` in `brief.ts` (GWP-120) that fills these fields.

```ts
/** The fields GWP-120 puts on ShiftBrief.card (and this card adds to DevopsShift.card). */
export interface WorkRefFields { ref: string; workRef?: string; isClientRef?: boolean }

/** The card's work reference as the server sent it. An older server sends none: the internal ref, not a client one. */
export function shiftWorkRef(card: WorkRefFields): { ref: string; client: boolean } {
  return card.isClientRef === true && card.workRef
    ? { ref: card.workRef, client: true }
    : { ref: card.workRef ?? card.ref, client: false };
}

/** A ticket key safe to print as a plain value: Jira `ABC-1` or GitHub `owner/repo#12` (same shapes as parseExternalRef). */
const SAFE_REF = /^(?:[A-Z][A-Z0-9]{1,9}-\d+|[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+#\d+)$/;
export const isPlainTicketKey = (s: string): boolean => SAFE_REF.test(s);

/** One sentence naming the client reference, shared by the card prompt and the DevOps texts (see 4.2/4.3). */
export function workRefLine(ref: string, internal: string): string
```

The landed `workReference` only ever returns a canonical key for a client ref (it is cut out of the text by the `parseExternalRef` regexes). So in practice `isPlainTicketKey` is always true. It stays as a cheap defence: a value from a server that is newer or older, or from a hand-edited brief, still goes through `renderUntrusted` if it has an unexpected shape.

### 4.2 Card prompt: `renderShiftPrompt` (builder, reviewer, tester, BA Finalize, everyone on the card)

In `packages/shared/src/prompt/shift-prompt.ts`, right after the type/risk/rework list and before Details/Context, add `workRefSection(card)`. It returns `null` unless `shiftWorkRef(card).client`, so non-intake cards get exactly today's text.

```ts
function workRefSection(card: ShiftBrief['card']): string | null {
  const w = shiftWorkRef(card);
  if (!w.client || w.ref === card.ref) return null;
  const plain = isPlainTicketKey(w.ref);
  // The reference is outside data: shown as a value in backticks, or fenced as untrusted text if it has an unexpected shape.
  const head = plain
    ? `This card came from the client's ticket \`${w.ref}\`: that is the reference of this work outside. \`${card.ref}\` is only the internal board key.`
    : `This card came from the client's ticket shown below: its key is the reference of this work outside. \`${card.ref}\` is only the internal board key.\n${renderUntrusted('Ticket reference', w.ref)}`;
  const r = plain ? `\`${w.ref}\`` : 'the ticket key';
  return section('Work reference', [
    head,
    `- Use ${r} in commit messages, branch names, pull request titles and descriptions, and in every text that goes to the client: release notes, changelog lines, ticket comments and status updates.`,
    `- Never write \`${card.ref}\` in any of these. \`${card.ref}\` is for \`aom\` commands and the card thread only.`,
    `- A commit message, branch name or pull request text on this card that names \`${card.ref}\` instead of ${r} does not meet this rule (reviewers and testers: flag it).`,
  ].join('\n'));
}
```

- Leave the `# ${card.ref}` heading as it is (internal surface, AC6).
- Do **not** touch `renderInstructions`. Its generic sentence ("start it with the ticket key … only when the card came from a ticket") already agrees with the new section, and keeping it unchanged keeps AC3 exact and the cache prefix shared.
- The branch name is already set by GWP-120 (`cardBranchName`). The prompt line about branch names covers branches the agent creates itself, and it agrees with GWP-120's branch guard.
- Question shifts (`renderQuestionPrompt`) answer desk items on the internal side and are not in scope.

### 4.3 DevOps prompt

1. `packages/shared/src/devops/index.ts` `DevopsShiftSchema.card`: add the **same two flat fields as `ShiftBriefSchema.card`**: `workRef: z.string().optional()` and `isClientRef: z.boolean().optional()`. This is additive, and an older runner ignores them.
2. `apps/server/src/runner-gateway/brief.ts` `devopsCardBrief`: spread GWP-120's existing `briefWorkRef(card)` into the card (the row has `ref` and `fields`). Do not compute it any other way.
3. `packages/shared/src/prompt/devops.ts`:
   - `cardSection`: after the first line, when `shiftWorkRef(card).client`, add `workRefLine(...)`: ``Work reference: `ABC-1` (the client's ticket). Use it, never `GWP-123`, in any commit or merge message, branch name, pull request text and anything that goes to the client.`` Use the same `isPlainTicketKey` / `renderUntrusted` fallback as 4.2.
   - `renderDevopsInstructions`, "# The card of this request": add the same one line under the same condition, so it is also there when DevOps reads its instructions without the prompt (resumed sessions).
   - Without a client reference nothing is added, so the DevOps texts stay byte-identical.

### 4.4 Outbound drafts and ticket comments

1. `packages/shared/src/external/leak-check.ts`: extend the signature in a backwards-compatible way:
   ```ts
   export interface InternalRefs { refs?: readonly string[]; projectKey?: string; ticketKey?: string }
   export function checkOutboundLeaks(body: string, agentNames: readonly string[] = [], internal: InternalRefs = {}): LeakResult
   ```
   - For each `refs` entry: match `(?<![A-Za-z0-9])${escape(ref)}(?![0-9])`, case-insensitive. Label: `internal card key (name the ticket ${ticketKey} instead)` when `ticketKey` is given, otherwise `internal card key`.
   - `projectKey`: match `\b${projectKey}-P?\d+\b`. **Skip this rule** when the ticket is a Jira key with the same prefix (a client project `ABC` and an internal project `ABC`), because it would refuse the client's own ticket keys. In that case only the exact `refs` apply.
   - Keep the old two-argument calls working unchanged.
2. `apps/server/src/commands/leak-check.ts` `screenOutbound(db, orgId, body, internal?)` passes it through.
3. `drafts.ts` `draftOutboundIn`: call `screenOutbound(tx, card.org_id, body, { refs: [card.ref], projectKey, ticketKey: ticket.key })`. `ticket` is the `cardTicket(card)` the function already resolves for the target. Since GWP-120 it is `cardTicketRef(card.fields)`, the same value as `workReference(card).ref`, so there is no second lookup. `projectKey` comes from `projects.key`. This covers `outboundDraftRpc` (BA) and `createManagerDraft` (manager). A BA draft that names `GWP-123` is recorded as `OutboundBlocked`, as today, and the manager's own text is refused with `internal_details`.
4. `apps/server/src/commands/outbox.ts` `resolveOutboundIn` (manager edit before approving): same arguments.
5. Runner `apps/runner/src/external/outbound.ts` `OutboundExecutor.post`: `checkOutboundLeaks(payload.body, payload.agentNames, { refs: [payload.cardRef], projectKey: payload.cardRef.replace(/-P?\d+$/, ''), ticketKey: payload.ref.key })`. No schema change, because `cardRef` is already in the payload. This is a defence-in-depth check for drafts approved before this lands.
6. The draft **target** stays `cardTicket(card)` (already delegating to GWP-120's `cardTicketRef`). Desk titles and thread messages are unchanged.

### 4.5 Changelog lines (release prep 'Write changelog')

1. `packages/shared/src/release/changelog-task.ts`:
   - `ReleaseChangelogTaskSchema.changes[].cards[]`: add `client: z.boolean().optional()`.
   - New pure function:
     ```ts
     /** Adds the client ticket reference(s) of an entry's changes after the public gate: `text (ABC-1)` / `text (ABC-1, ABC-7)`. */
     export function withClientRefs<E extends { text: string; sources: string[] }>(
       entries: readonly E[], changes: ReleaseChangelogTask['changes'],
     ): E[]
     ```
     For each entry it collects, in source order, the unique `cards[].key` with `client === true` from the changes listed in `entry.sources` (at most 5), and adds them unless the text already ends with them. Entries without client cards are returned unchanged.
   - `renderReleaseChangelogInstructions`: add one neutral clause to the "Never write ticket keys…" bullet: "(the platform adds the client's ticket reference itself where one applies)". This wording is the same for every release.
2. `apps/server/src/release/docs-prep-changelog-task.ts`:
   - Move the change-list building into `changeListFor(db, run, repo, summary, uncovered)` and use it from both `buildReleaseChangelogTask` and `applyReleaseChangelogReport`, so both see the same mapping.
   - Card resolution `resolveChangeCards(db, projectId, keys)`: load `SELECT id, ref, title, fields FROM cards WHERE project_id=$1 AND status<>'cancelled' AND (ref = ANY($2) OR coalesce(fields->>'externalRef','') <> '')`. Compute `workReference({ ref, fields })` (GWP-120) per row in JS, and index each card by its internal `ref` **and**, when `isClientRef`, by its work reference. Merge keys are compared the same way: Jira-shaped keys upper-case, through `canonicalTicketKey`. GWP-120 added no column (confirmed), so this scan stays. It is the same approach `intake-batch.ts` already uses at ~202.
   - For each merge key: matched cards become `{ key: wr.ref, title, client: wr.isClientRef }`. The **internal key of an intake card is replaced by its ticket reference**, so the writer never sees it. Merges of cards in flight from before this lands carry `GWP-123`, and they map the same way. Unmatched keys stay `{ key, title: summary title ?? null }` as today. Several cards of one ticket (confirmed possible: GWP-120 only suffixes their branch names) give one reference.
   - In `applyReleaseChangelogReport`, after `checkChangelogProposal` accepts: `const entries = withClientRefs(check.entries, changes)`, and send `entries` in the `changelog` step command. The runner's `mergeUnreleased` writes them as they are.
3. `releaseChangelog` / `composeReleaseSection` / the runner's `commitRelease` need no change: the ticket reference is already in the Unreleased lines when the release commit moves them.

### 4.6 Help text

- `apps/web/src/help/articles/intake-and-outbox.md`. Under Intake, add a short "Ticket reference" paragraph: a card made from a ticket uses the ticket key (e.g. `ABC-123`) everywhere outside Guildwise HQ (commits, branch, pull request, changelog lines and updates posted to the ticket), while the board keeps showing the card's own key. Under Guardrails, add: a draft that names the card's own key is refused, so name the ticket instead.
- Mirror both in `apps/server/src/assistant/pack/topics/intake-and-outbox.md`. GWP-122 adds the PR/merge details to the same paragraph.

### 4.7 Files

| File | Change |
|---|---|
| `packages/shared/src/prompt/work-ref.ts` (new) + prompt index | `shiftWorkRef`, `isPlainTicketKey`, `workRefLine` |
| `packages/shared/src/prompt/shift-prompt.ts` | `workRefSection`, inserted after the meta list |
| `packages/shared/src/devops/index.ts` | `DevopsShiftSchema.card.workRef` / `isClientRef` (optional, same as `ShiftBriefSchema.card`) |
| `packages/shared/src/prompt/devops.ts` | `cardSection` + `renderDevopsInstructions` card block |
| `apps/server/src/runner-gateway/brief.ts` | `devopsCardBrief` spreads the existing `briefWorkRef(card)`. `buildBrief` is already done by GWP-120 (no change). |
| `packages/shared/src/external/leak-check.ts` | `InternalRefs` argument and the internal-key rule |
| `apps/server/src/commands/leak-check.ts`, `drafts.ts`, `outbox.ts` | pass the card ref, project key and ticket key |
| `apps/runner/src/external/outbound.ts` | scrub `payload.cardRef` |
| `packages/shared/src/release/changelog-task.ts` | `cards[].client`, `withClientRefs`, the instruction clause |
| `apps/server/src/release/docs-prep-changelog-task.ts` | `resolveChangeCards` (via `workReference`), `changeListFor`, append refs on accept |
| `apps/web/src/help/articles/intake-and-outbox.md`, `apps/server/src/assistant/pack/topics/intake-and-outbox.md` | help |

No migration and no new event.

## 5. How each acceptance criterion maps to the design and its test

| AC | Design | Test |
|---|---|---|
| Builder prompt for intake card ABC-1 names ABC-1 for commits, branch, PR and client texts and forbids the internal key | 4.2 | `packages/shared/test/prompt.test.ts`: `buildBrief()` with `card.workRef = 'ABC-1', card.isClientRef = true` (fixture `packages/shared/test/fixtures.ts`). Inline snapshot of the section. Assert it contains `ABC-1` and "Never write `GWP-…`". Assert the commit/PR line does not contain the internal key except in the "never" sentence. |
| Reviewer, tester and DevOps prompts carry the same | 4.2 (one function for every card role) and 4.3 | The same test with `reworkReviewBrief()` (reviewer) and a tester-stage brief. `renderDevopsPrompt` and `renderDevopsInstructions` with `card.workRef = 'ABC-1', isClientRef: true` (existing DevOps prompt tests in `packages/shared/test/m3.test.ts`). Server: `devopsCardBrief` for an intake card row carries both fields. |
| Non-intake prompts unchanged, still name the project key | The section is only added when `isClientRef` is true. Instructions untouched. | The existing inline snapshots in `prompt.test.ts` / `m3.test.ts` must pass **unchanged**. Add an explicit `toBe` comparison: the prompt with `workRef: 'GWP-123', isClientRef: false` (what GWP-120's server now sends for a non-intake card) equals the prompt with neither field (older server). |
| An outbound draft or ticket comment for ABC-1 references ABC-1 and has no internal key | 4.2 (the BA's Finalize prompt), 4.4 (refusal at draft, edit and post) | Shared: `checkOutboundLeaks('Fixed in GWP-123', [], {refs:['GWP-123'], ticketKey:'ABC-1'})` is refused. `'Fixed (ABC-1)'` passes. Same-prefix case: project `ABC`, ticket `ABC-1`, body names `ABC-7` → passes, body names the card ref `ABC-123` → refused. Server (`apps/server/test/outbox.test.ts`): a BA draft naming the card ref is blocked (`OutboundBlocked`), a manager draft is refused with `internal_details`, and a draft naming ABC-1 lands with `externalKey` ABC-1. Runner: `OutboundExecutor` refuses a payload whose body names `cardRef`. |
| The changelog line for a release containing ABC-1 references ABC-1 and not the internal key. Non-intake lines unchanged | 4.5 | Shared: `withClientRefs` with a mix (one entry with an intake source gets ` (ABC-1)`, a non-intake entry is unchanged, an entry with two tickets gets both, nothing is appended twice). Server (`apps/server/test/release-docs-prep-changelog*.test.ts`): a merge whose message names `GWP-123` (an intake card) and one naming `ABC-1` both map to `{key:'ABC-1', client:true}` in the task brief, the brief does not contain `GWP-123`, and the accepted entries sent to the runner end in `(ABC-1)`. A lower-case `externalRef` (`abc-1`) still maps (GWP-120 canonicalises it). A non-intake card's change keeps `{key:'GWP-124'}` and its entry text is unchanged. |
| Internal surfaces keep the internal ref | No change to board, thread, desk or phase-report code. The prompt heading stays `# GWP-123`. | Assert the intake prompt still starts with `# GWP-123`. Assert the draft's thread message and desk title are unchanged (existing outbox test). |

End-to-end: a build shift on an intake card checking commits and the PR is for the testers, after GWP-122 lands. The PR title/body and merge message belong to GWP-122.

## 6. Risks

- **Public changelog now has client ticket keys** for intake work (`… (ABC-1)`). This is what the AC asks for. The key is only added when the card's work reference is a client one. The blog/release-post writer's pattern gate (`ceo/topic-denylist.ts`) rejects ticket keys in *its own* output: it may need one retry when its source entries contain `(ABC-1)`. That is acceptable, and its output must not have them anyway.
- **Same prefix for client and internal keys** (`ABC-1` vs internal `ABC-123`): handled by matching exact refs only and skipping the prefix rule (4.4).
- **The model ignoring the prompt**: the outbound path is enforced (refusal). Branch names are set and guarded by GWP-120. Commits are guarded by GWP-122. This card only gives the instruction.
- **Prompt snapshot churn**: none for non-intake cards (byte-identical is required). New snapshots only for intake cases.
- **Older runner with a newer server**: the new fields are optional and ignored, so it falls back to today's text. Older server with a newer runner: `shiftWorkRef` sees no fields and returns the internal ref with `client:false`, which is also today's text.
- **Name clash**: the server's `briefWorkRef` (GWP-120, fills the brief) and the shared `shiftWorkRef` (reads it) are different functions. Do not add a second `briefWorkRef` to `@aom/shared`: the server imports from `@aom/shared` and would get an ambiguous name.

## 7. Overlaps in the group

- GWP-120 (dependency, landed): the work-reference function, the `ShiftBrief` / card-facts fields, branch names and the branch guard. This card only reads the reference.
- GWP-122: `apps/runner/src/git/completion.ts` (merge message, PR title/body), `finalize.ts` `prBranchTicket`, runner `supervisor.ts` `ticketOf` / `autocommit.ts`, and the guard that flags the internal key on commits. **Do not touch these here.** (`ticketOf` only accepts Jira-shaped keys. GWP-122 should move it to `brief.card.workRef` so GitHub tickets work too.)

## 8. Assumption review against the landed GWP-120

| # | Assumption | Result | What the design does now |
|---|---|---|---|
| A1 | `ShiftBrief.card` gets an optional nested `workRef: { ref, client }`, filled in by `buildBrief`. | **Did not hold (shape).** GWP-120 added two flat optional fields, `card.workRef: string` and `card.isClientRef: boolean`, filled by `buildBrief` through the server's `briefWorkRef(card)`. | The shared reader is `shiftWorkRef(card)` and reads the flat fields (4.1). It is renamed so it does not clash with the server's `briefWorkRef`. `DevopsShiftSchema.card` gets the same two flat fields, and `devopsCardBrief` spreads `briefWorkRef(card)` (4.3). `buildBrief` needs no change. The tests use the flat fields. |
| A2 | GWP-120 exports one shared function that gives a card row's work reference from `ref` and `fields`. | Holds: `workReference({ ref, fields })` in `packages/shared/src/cards/work-ref.ts`, pure, no DB. | `resolveChangeCards` calls `workReference`. `devopsCardBrief` uses the server wrapper `briefWorkRef`. `draftOutboundIn` uses `cardTicket`, which delegates to `cardTicketRef` (same source). |
| A3 | The work reference is the canonical ticket key (Jira upper-case, GitHub `owner/repo#12`), never a URL or free text. | Holds: `cardTicketRef` keeps only the key the `parseExternalRef` regexes cut out, then applies `canonicalTicketKey`. Lower-case Jira input is upper-cased. | No change. `isPlainTicketKey` uses the same character sets as `parseExternalRef`, so it is always true for a value from GWP-120. It stays as a defence. |
| A4 | Several cards can share one work reference. | Holds: the work reference is not made unique. Only branch names get a `-2` suffix (`uniqueCardBranch`). | No change. |
| A5 | The ticket stays in `fields.externalRef`, so `cardTicket` stays the outbound target and equals the work reference for intake cards. | Holds: `cardTicket` now delegates to `cardTicketRef(card.fields)`, and `workReference(card).ref === cardTicket(card).key` by construction. | No change. `draftOutboundIn` takes `ticketKey` from the ticket it already resolves. |
| A6 | GWP-120 adds no indexed column for the work reference. | Holds: no migration in GWP-120. | No change: `resolveChangeCards` scans the project's cards that have `externalRef`. |
| A7 | GWP-122 makes intake merges and commits carry `ABC-1`. | Not yet landed; not needed for correctness. | The changelog mapping handles both `GWP-123` and `ABC-1` in merge messages. |
