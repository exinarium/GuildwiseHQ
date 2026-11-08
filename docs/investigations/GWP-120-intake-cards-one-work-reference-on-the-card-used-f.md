# GWP-120: one work reference on the card, used for branch names and recognised by the branch guard

Part 1 of 3 (GWP-120 → GWP-121 prompts/client outputs → GWP-122 completion/PR + internal-key guard).
All changes are in GuildwiseHQ: `packages/shared`, `apps/server`, `apps/runner`. No change to guildwise-cloud.

## 1. Question

Where does a card keep its intake ticket reference? How do we work out one "work reference" from it? How does that
reference reach the branch name, card facts and the shift brief? And how does the runner's other-branch guard learn to
recognise ticket-named branches, while non-intake cards and in-flight branches stay exactly as they are?

## 2. Findings (code as of main 104c3122)

### 2.1 Where the ticket reference lives today

| Source | Written by | Notes |
|---|---|---|
| `cards.fields.externalRef` (text, inside the `fields` JSON) | `createDraft` (`apps/server/src/commands/intake.ts:569`, which falls back to `intake.external_key`), `specify/patch` (`intake.ts:663`), `ba-intake.ts:110`, `ceo/actions3.ts:60`, batch intake through `aom card create ... externalRef` | Covers **every** path a card is made from a ticket. It is raw text: whatever the BA typed (`ABC-1`, `abc-1`, a URL, `owner/repo#12`). Shown on the board as "External reference" (`cards/fields.ts:174`) and searched on the board (`queries/cards.ts:488`). |
| `intakes.external_key` via `intake_cards` | intake start | Only intakes, not batch/CEO/BA-direct cards. Read once in `finalize.ts:149` (`prBranchTicket`) for the PR branch. |
| `cardTicket(card)` in `apps/server/src/commands/drafts.ts:33` | (reader) | `parseExternalRef(fields.externalRef)`, **without** normalisation. A lowercase `abc-1` gives `null`, because `JIRA_KEY` only matches upper case. |

`parseExternalRef` (`packages/shared/src/external/index.ts:30`) only ever returns tightly shaped keys: Jira
`[A-Z][A-Z0-9]{1,9}-\d+` and GitHub `owner/repo#N` (owner `[A-Za-z0-9-]`, repo `[A-Za-z0-9._-]`).
`canonicalTicketKey` (`intake/batch.ts:39`) uppercases Jira and leaves GitHub as typed. Batch parsing
(`parseBatchTickets`) uppercases a Jira-shaped entry *before* it parses it; `cardTicket` does not.

**Conclusion:** `fields.externalRef` is the one durable field every intake path already fills. Reuse it; add no
column. Normalise on read with one shared function.

### 2.2 Branch naming

`branchName(prefix, ref, title)` (`packages/shared/src/ids.ts:102`) gives `<prefix><ref-lowercase>-<slug(title,40)>`.
It has four callers, all with the same pattern `wcard.branch_name ?? branchName(project.branch_prefix, wcard.ref, wcard.title)`:

- `apps/server/src/dispatcher/claim.ts:164` (claim → `CardClaimed.worktree.branchName`)
- `apps/server/src/commands/card-facts.ts:91`
- `apps/server/src/commands/runs.ts:555` (selects only `branch_name, ref, title` of the worktree card; the fallback
  wrongly uses `card.ref/title`, not the worktree card's)
- `apps/server/src/commands/test-environments.ts:211-212`

A computed name is persisted once, with `COALESCE`, on the **first claim** that carries a worktree, including read-only
claims (planning, design before dependencies land): `projections/cards.ts:522` (CardClaimed) and
`projections/shifts.ts:74` (ShiftStarted). From then on every reader uses `cards.branch_name`. So **AC7 (in-flight cards
keep their branch) holds by construction** as long as the new naming is only applied in the `?? fallback`. The one
exception is `CardRehomed` (`projections/sharing.ts:118`), which clears `branch_name` because the card starts again on
another workstation. See risk R3.

### 2.3 Card facts and the shift brief

- `cardFactsRpc` (`apps/server/src/commands/card-facts.ts`) returns an untyped object with `ref`, `branch.name`, ...
- `ShiftBriefSchema.card` (`packages/shared/src/protocol/runner.ts:286`) carries `ref` and the raw `fields` (built in
  `apps/server/src/runner-gateway/brief.ts:280`). It has no derived work reference. `brief.project` has `key` but no
  `branchPrefix`.

### 2.4 Runner guard

`otherBranchViolation` (`apps/runner/src/shifts/guard.ts:589`) skips `b === input.branchName` (the card's own branch),
so **AC5 already holds once the brief's branch name is the ticket branch**: committing on the card's own branch never
counts as "other branch", whatever its name. For every other moved branch it decides *provenance*:

- `provenance = false` → refused whenever it gains commits. This applies to protected branches, the card's **own other**
  branches (`cardRefOfBranch(b) === ownRef`) and non-card branches.
- `provenance = true` → refused only if this shift made the commits (HEAD reflog). This applies to sibling worktrees,
  other cards' branches (`cardRefOfBranch(b) !== null`) and the default card prefixes `guildwise/` and `aom/`.

`cardRefOfBranch(name, projectKey)` (`guard.ts:553`) matches only `<projectKey>-<n>` at a segment start with a
boundary. Ticket-named branches therefore fall through:

- another card's `guildwise/abc-2-…` is still a card branch through the default prefix (good);
- another card's `feature/ABC-2-…` under a **custom project prefix** is a "non-card" branch, so `provenance=false`. It
  is flagged even when a different worktree's shift moved it. This is the GWP-85 false positive again, now for ticket
  branches;
- the card's own leftover `backup/ABC-1-x` gets null, so `provenance=false` (flagged, the same result as today's own-ref
  branches).

Contrary to the card's note, `cardRefOfBranch` already has tests in `apps/runner/test/guard.test.ts:400`. Extend them.

### 2.5 Jira and the case of the key

Jira links a branch to an issue when the branch name contains the issue key in Jira's key format (upper case,
`ABC-123`). GitKraken's Jira integration also writes the key in upper case into branch templates (`${issuekey}-${summary}`).
So the ticket key keeps its canonical case in the branch (`aom/ABC-1-fix-login`), unlike today's lowercased internal
ref. That is also the literal reading of the AC "the branch contains ABC-1".

## 3. Options

### 3.1 Where the reference lives

| Option | Pros | Cons |
|---|---|---|
| **A. Reuse `fields.externalRef`, canonicalise on read (chosen)** | Already filled by every path; board shows and searches it; no migration; `cardTicket` already reads it | Raw text; must be normalised on every read (solved by one shared function) |
| B. New `cards.work_ref` column filled at creation | Indexed; normalised once | Second copy (the requirement says reuse); migration and backfill; drifts when the BA patches `externalRef` |
| C. `intakes.external_key` via `intake_cards` | Already canonical | Misses batch, CEO and BA-direct cards; join on every read |

### 3.2 Branch ref part for a ticket

| Option | Example | Verdict |
|---|---|---|
| **Jira: canonical key, case kept** | `aom/ABC-1-fix-login` | Chosen: Jira dev panel links it; contains `ABC-1` literally |
| Jira lowercased (today's style) | `aom/abc-1-fix-login` | Rejected: Jira may not link it; client-facing branch should show the key as the client writes it |
| **GitHub: `<slug(repo,30)>-<n>`** | `acme/web#12` → `aom/web-12-fix-login` | Chosen: `#` is legal in git but is a shell comment character and must be escaped in URLs; `/` would add a path level |
| GitHub `owner/repo#n` verbatim | `aom/acme/web#12-…` | Rejected (shell, URL, extra path levels) |

### 3.3 Guard recognition of ticket branches

| Option | Verdict |
|---|---|
| **Own ticket from the brief + project branch prefix from the brief (chosen)** | Exact: the card's own ticket branch maps to its own ref; any branch under the project's prefix counts as a card branch (provenance check), the same as `guildwise/` and `aom/` today |
| Treat any Jira-shaped token in a branch name as a card | Rejected: turns human branches such as `feature/v2-3-…` or `fix-12` into "other card" (looser guard) |
| Send all ticket keys of the project's open cards to the runner | Rejected: large and goes stale; the prefix already identifies card branches |

## 4. Recommendation and design

### 4.1 Shared: `packages/shared/src/cards/work-ref.ts` (new, export from `cards/index.ts`)

The **single** source of truth. GWP-121 and GWP-122 import it; nobody re-derives it.

```ts
import { type ExternalRef, parseExternalRef, parseGithubKey } from '../external/index.ts';
import { canonicalTicketKey } from '../intake/batch.ts';
import { branchName, slugify } from '../ids.ts';
import { isSafeGitRef } from '../safe.ts';

const JIRA_SHAPED = /\b[A-Za-z][A-Za-z0-9]{1,9}-\d+\b/g;

/** The ticket a card came from (`fields.externalRef`), normalised like batch intake; null when none or unparseable. */
export function cardTicketRef(fields: unknown): ExternalRef | null {
  const raw = (fields as { externalRef?: unknown } | null | undefined)?.externalRef;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const text = raw.trim();
  // Exact parse first (keeps GitHub case, finds real upper-case keys); then accept Jira keys typed in lower case.
  const ref = parseExternalRef(text) ?? parseExternalRef(text.replace(JIRA_SHAPED, (k) => k.toUpperCase()));
  return ref ? { ...ref, key: canonicalTicketKey(ref) } : null;
}

export interface WorkReference {
  /** What the work is called outside the platform: `ABC-1`, `acme/web#12`, or the internal ref `GWP-123`. */
  ref: string;
  /** `ref` is the client's ticket (the card came from one), not the internal card ref. */
  isClientRef: boolean;
  /** The parsed ticket when `isClientRef`. */
  ticket: ExternalRef | null;
}

export function workReference(card: { ref: string; fields?: unknown }): WorkReference {
  const ticket = cardTicketRef(card.fields);
  return ticket ? { ref: ticket.key, isClientRef: true, ticket } : { ref: card.ref, isClientRef: false, ticket: null };
}

/** The ref part a ticket contributes to a branch name: `ABC-1` (case kept), GitHub `web-12`; null if none is safe. */
export function ticketBranchPart(ticket: ExternalRef): string | null {
  if (ticket.system === 'jira') return /^[A-Z][A-Z0-9]{1,9}-\d+$/.test(ticket.key) ? ticket.key : null;
  const gh = parseGithubKey(ticket.key);
  if (!gh) return null;
  const repo = slugify(gh.repo.split('/').pop() ?? '', 30);
  return repo ? `${repo}-${gh.number}` : `gh-${gh.number}`;
}

/** Same as ticketBranchPart, from a work reference string (the runner gets `workRef` in the brief). */
export function workRefBranchPart(workRef: string): string | null {
  const t = parseExternalRef(workRef);
  return t ? ticketBranchPart({ ...t, key: canonicalTicketKey(t) }) : null;
}

export interface CardBranch {
  name: string;
  /** Set when the card has a ticket that could not be used: the name fell back to the internal ref. */
  fallbackReason?: string;
}

/**
 * The branch a card gets when it has none yet. Non-intake cards: exactly `branchName(prefix, ref, title)`.
 * Intake cards: `<prefix><ticket part>-<slug(title, 40)>`, checked with isSafeGitRef; an unusable ticket falls back.
 */
export function cardBranchName(prefix: string, card: { ref: string; title: string; fields?: unknown }): CardBranch {
  const legacy = branchName(prefix, card.ref, card.title);
  const ticket = cardTicketRef(card.fields);
  if (!ticket) return { name: legacy };
  const part = ticketBranchPart(ticket);
  const slug = slugify(card.title, 40);
  const name = part ? `${prefix}${part}${slug ? `-${slug}` : ''}` : '';
  if (part && isSafeGitRef(name)) return { name };
  return { name: legacy, fallbackReason: `the ticket reference ${ticket.key} cannot be used in a branch name` };
}
```

Notes:
- Leave `branchName` in `ids.ts` **unchanged** (byte-identical for non-intake cards; AC3). Check for an import cycle
  (`ids.ts` must not import `cards/`). If `cards/index.ts` → `intake/batch.ts` creates one, move `canonicalTicketKey`
  into `external/index.ts` and re-export it from `intake/batch.ts`.
- The raw `externalRef` text never reaches git. Only `ticketBranchPart`'s output does, and it is built from
  `[A-Z0-9-]` (Jira) or `slugify` output plus digits (GitHub), then checked with `isSafeGitRef` (AC8). Free text with no
  ticket in it is "no intake ref", so the card keeps today's naming.
- AC4: `abc-1`, `ABC-1`, `see ABC-1 please`, `https://x.atlassian.net/browse/ABC-1` all give `ABC-1`.
- Make `drafts.ts:cardTicket(card)` a one-line delegate: `return cardTicketRef(card.fields)`. Lowercase refs then also
  work for outbound drafts, which is a strict improvement. Its callers (`drafts.ts:148` etc.) keep their contract.

### 4.2 Server

1. **Branch callers** (the four in 2.2): replace `branchName(project.branch_prefix, wcard.ref, wcard.title)` with
   `cardBranchName(project.branch_prefix, wcard).name`, still only behind `wcard.branch_name ??`.
   - `runs.ts:553`: select `branch_name, ref, title, fields` and pass the same row (worktree card or card) to
     `cardBranchName`. This also fixes the mismatch where the fallback used `card` instead of the worktree card, and
     makes it match `claim.ts`.
   - `claim.ts`: when `worktree.created` and `fallbackReason` is set, append one
     `cardMessage(card, { kind: 'system' }, 'system', '<reason>; the branch uses <ref> instead.')` to the claim's event
     batch (the "clear card message" of AC8). Use the thread message kind the server already uses for system notices;
     the builder checks `ThreadMessageKind`.
2. **Card facts** (`card-facts.ts`): add `workRef: wr.ref` and `isClientRef: wr.isClientRef` at the top level next to
   `ref` (`wr = workReference(card)`; for a bug child use the **card's own** fields, not the worktree card's). `ref` stays
   the internal ref.
3. **Shift brief** (`runner-gateway/brief.ts:280` and the shared schema): add to `brief.card`:
   ```ts
   /** The card's work reference (intake ticket key, else the internal ref) and whether it is the client's ticket. Absent: older servers. */
   workRef: z.string().optional(),
   isClientRef: z.boolean().optional(),
   ```
   and to `brief.project`: `branchPrefix: z.string().optional()` (the project's card branch prefix, for the guard).
   Fill them in the main card brief only. The other brief builders (`ba-task-brief.ts`, `question-brief.ts`,
   `release/docs-prep-tasks.ts`, `ceo/pass.ts`) may leave them out, because they are optional.
4. **Board / URLs / events**: no change; everything keeps `card.ref` (requirement 7).

### 4.3 Runner guard (`apps/runner/src/shifts/guard.ts`, `supervisor.ts:2321`)

`GuardInput` gains:
```ts
/** The branch part of this card's client ticket (`ABC-1`, `web-12`): its ticket-named branches are the card's own. */
ownTicketBranchPart?: string;
/** The project's card branch prefix (brief.project.branchPrefix): branches under it are card branches. */
cardBranchPrefix?: string;
```
`guardInput()` sets `ownTicketBranchPart` to `workRefBranchPart(brief.card.workRef)` when `brief.card.isClientRef`, and
`cardBranchPrefix` to `brief.project.branchPrefix` when it is non-empty.

```ts
export function cardRefOfBranch(
  name: string,
  projectKey: string | undefined,
  own?: { cardRef: string; ticketPart: string },
): string | null {
  if (projectKey) {
    const key = escapeRe(projectKey);
    const m = new RegExp(`(?:^|/)(${key}-\\d+)(?=$|[-/_.])`, 'i').exec(name);
    if (m?.[1]) return m[1].toUpperCase();
  }
  if (own?.ticketPart) {
    const t = escapeRe(own.ticketPart);
    if (new RegExp(`(?:^|/)${t}(?=$|[-/_.])`, 'i').test(name)) return own.cardRef.toUpperCase();
  }
  return null;
}
```
The boundary works as today: `ABC-10-x` is not `ABC-1`. In `otherBranchViolation`:
```ts
const ref = cardRefOfBranch(b, input.projectKey, input.cardRef && input.ownTicketBranchPart
  ? { cardRef: input.cardRef, ticketPart: input.ownTicketBranchPart } : undefined);
if (ref && ref === ownRef) provenance = false;
else provenance = ref !== null
  || CARD_BRANCH_PREFIXES.some((p) => b.startsWith(p))
  || (!!input.cardBranchPrefix && b.startsWith(input.cardBranchPrefix));
```
How each case comes out:
- (a) intake card ABC-1 on its own branch `aom/ABC-1-…`: skipped as `b === branchName`, so no violation (AC5).
- (b) intake card ABC-1, this shift commits to another card's `aom/ABC-2-…` or `aom/gwp-7-…` or `feature/ABC-2-…`
  (under the project prefix): `provenance=true` and made by this shift, so flagged (AC6). A ticket branch outside every
  card prefix is "non-card", so flagged always (stricter, still flagged).
- (c) non-intake card GWP-5 on `aom/gwp-5-…`: unchanged.
- The card's own leftover ticket branch (`backup/ABC-1-x`) maps to the own ref, so `provenance=false`, the same as
  `backup/gwp-63-x` today.

Do not change `isRunnerOwnedBranch` or `CARD_BRANCH_PREFIXES`.

### 4.4 What GWP-121 / GWP-122 take from this card

- GWP-121: prompts and client outputs read `brief.card.workRef` / `isClientRef`. Replace the raw reads of
  `fields.externalRef` (`runner/src/shifts/supervisor.ts:388`, `chat/relay.ts:166/1286`, `adapters/mock-agent.ts:223`)
  where they mean "the work reference".
- GWP-122: replace `prBranchTicket(intake.external_key, card.ref)` in `finalize.ts:133-153` (second source of truth;
  it misses batch, CEO and BA-direct cards) with `workReference(card)` / `ticketBranchPart`. The internal-key guard uses
  `isClientRef`.

## 5. Risks

- **R1 (case-sensitive refs)**: `aom/ABC-1-x` and `aom/abc-1-x` are different refs. On case-insensitive file systems
  (macOS, Windows) loose refs collide. No collision arises in practice: one ticket gives one canonical spelling, and
  internal refs are lowercase `gwp-…`, not ticket keys. Accepted.
- **R2 (two cards, same ticket)**: an intake split into several cards gives every card the same ticket key, so they
  would share a ref part. The **title slug** usually makes the names differ (`aom/ABC-1-api-…` vs `aom/ABC-1-ui-…`),
  but two cards with the same ticket and the same first 40 slug characters (or a re-made card) would collide. This is
  dangerous: `addWorktreeOnBranch` (`apps/runner/src/git/worktrees.ts:91`) **silently reuses** an existing branch, so
  the second card would build on the first card's branch. **Required:** when `cardBranchName` returns a ticket-based
  name and the card has no `branch_name` yet, `claim.ts` checks
  `SELECT 1 FROM cards WHERE project_id=$1 AND id<>$2 AND lower(branch_name)=lower($3)` (any status: finished branches
  can stay in the clone; `lower()` covers R1). If a row exists, it appends `-2`, `-3`, … until the name is free. Put the
  helper next to the claim, for example `uniqueCardBranch(tx, projectId, cardId, name)`, and test it. Card facts,
  runs and test-environments only fall back when `branch_name` is null and no claim has happened, so they show the
  unsuffixed candidate until the first claim persists the real name (acceptable: no branch exists yet). Non-intake
  names are never suffixed: they cannot collide (unique refs) and must stay byte-identical (AC3), so skip the check
  for them.
- **R3 (rehome)**: `CardRehomed` clears `branch_name`, so a card that was in flight before this lands and is later
  rehomed gets a ticket-named branch on its new workstation. This is a fresh start on another machine (the old local
  branch is not there), not a rename of an existing branch. Accepted; note it in the handoff.
- **R4 (BA edits externalRef after the branch exists)**: the branch keeps its name (COALESCE). The work reference then
  follows the new field value. GWP-122's internal-key guard must compare against the work reference, not parse the
  branch name.
- **R5 (older runners)**: `workRef`, `isClientRef` and `branchPrefix` are optional. An older runner ignores them; its
  guard then treats a custom-prefix ticket branch of another card as non-card (stricter). No false pass.
- **R6 (import cycle)** in shared: see 4.1 notes.

## 6. Acceptance criteria → design

| AC | Design | Test |
|---|---|---|
| Intake card ABC-1 shows ABC-1 as work reference in card facts and brief; internal ref on board | `workReference` → `cardFactsRpc.workRef/isClientRef`, `brief.card.workRef/isClientRef`; `ref` untouched | server: card facts + brief for a card with `fields.externalRef='ABC-1'`; shared: `workReference` |
| Branch contains ABC-1, not GWP-123 | `cardBranchName` in claim/runs/card-facts/test-environments | shared: `cardBranchName('aom/', {ref:'GWP-123', title:'Fix login', fields:{externalRef:'ABC-1'}}).name === 'aom/ABC-1-fix-login'`, and `not.toMatch(/gwp-123/i)`; server claim test checks `CardClaimed.worktree.branchName` |
| Non-intake card: identical name | `cardBranchName` returns `branchName(...)` when no ticket; `branchName` unchanged | shared: snapshot `branchName('guildwise/','WEB-12','Add login page') === 'guildwise/web-12-add-login-page'` and `cardBranchName` equal to it for no/empty/unparseable `externalRef` |
| Format variants give the same work reference | `cardTicketRef` normalisation + `canonicalTicketKey` | shared: `abc-1`, `ABC-1`, ` see abc-1 `, Jira browse URL → `ABC-1`; GitHub URL and `acme/web#12` → `acme/web#12` |
| Own ticket branch not flagged | own branch skip + `cardRefOfBranch` own-ticket mapping | runner guard: case (a) |
| Other card's branch (ticket or key) flagged | provenance via ref, default prefixes, `cardBranchPrefix` | runner guard: case (b) with `aom/ABC-2-x`, `aom/gwp-7-x`, `feature/ABC-2-x` + `cardBranchPrefix:'feature/'`; `cardRefOfBranch` unit cases incl. boundary `ABC-10` ≠ `ABC-1` |
| In-flight card keeps its branch | new naming only behind `branch_name ??`; persisted on first claim | server: card with `branch_name='aom/gwp-9-old'` and `externalRef='ABC-1'` → claim and card facts return `aom/gwp-9-old` |
| Unsafe ref never reaches git | only `ticketBranchPart` output + `isSafeGitRef`; fallback + card message | shared: GitHub repo `..evil.lock`/`.x` → safe or fallback; free text `$(rm -rf)` → legacy name; server: fallback posts one card message |

Regression: run the shared, runner (`guard.test.ts`, `architect-guard.test.ts`) and server unit suites, plus
`apps/server/test/pr-branch-prefix.test.ts` and the drafts tests (because `cardTicket` now delegates). The server
integration test (intake → claim → facts/brief) needs Postgres; leave it to the testers if the build shell cannot
reach it, and name it in the handoff. E2E claim/run and intake flows are for the testers.
