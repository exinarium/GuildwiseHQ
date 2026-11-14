# GWP-225: Creating a discovery session fails with 500 when the owner's display name is longer than 100 characters

## 1. Question

`POST /api/discovery` returns 500 for an owner whose display name is 120 characters. Which event on the create path carries
the unclipped name? How do we clip it with the same rule as the earlier `userName()` fix in the discovery service, without
adding a second rule and without changing short names or the event schema?

## 2. Findings (confirmed in code)

### 2.1 The failing event

`DiscoveryService.create` (`apps/server/src/sessions/discovery.ts:244`) calls `createSession`
(`apps/server/src/commands/sessions.ts:245`).

- `createSession` puts the creator first in the participant list as `{ kind: 'user', refId: who.userId, seat: 'Owner' }`
  (`sessions.ts:274-275`).
- For each participant it calls `checkParticipant` (`sessions.ts:308`). In the user branch, `checkParticipant` returns
  `p.displayName ?? u.display_name` (`sessions.ts:189`), straight from `users.display_name`, with no clip.
- `participantEvent` (`sessions.ts:212-236`) writes that value into `ThreadParticipantAdded.payload.displayName`.
- The schema in `packages/shared/src/events/session.ts:60` is `displayName: z.string().min(1).max(100)`. The event store
  validates on append, so a 120-character name throws inside `withAppendTx`. That is the 500.

`users.display_name` has no length limit in the database (`migrations/0002_users.sql:4`, `text NOT NULL`). Invitation
accept allows up to 120 characters (`packages/shared/src/api/invitations.ts:26`), so a valid user can reach this path with
a name longer than 100.

An explicit `p.displayName` from the request cannot cause this: `ParticipantInputSchema.displayName` is already
`max(100)` (`packages/shared/src/sessions/index.ts:35`).

### 2.2 The other events on the create path do not carry the owner's name

| Event / step | Where | Name field | Verdict |
|---|---|---|---|
| `SessionThreadCreated` | `sessions.ts:288-305` | none (`createdBy` is an id) | fine |
| `ThreadParticipantAdded` (owner) | `sessions.ts:307-310` | `displayName` from `users.display_name`, max(100) | **the bug** |
| `ThreadParticipantAdded` (facilitator agent, CEO agent) | same loop | `agents.name`, max(60) on input (`api/agents.ts:81`) | fine |
| `ThreadParticipantAdded` (analyst persona fallback) | same loop | registry persona name | fine (not a user name) |
| seed notes (`noteEvent`) | `discovery.ts:328-333` | `by.name = 'Boardroom'` (constant) | fine |
| `requestFacilitator(start)` | `discovery.ts:335` → `:476` | turn and prompt, no user name in a limited event field | fine |
| `followProjectPacks` (after the transaction) | `pack-follow.ts:45-77` | the name goes into the free text `DeskItemCreated.body` (`pack-holders.ts:192`), not a 100-character name field. It also runs after the commit with `.catch(warn)` | fine, cannot cause the 500 |

### 2.3 The existing fix and its helper

`DiscoveryService.userName` (`discovery.ts:1122-1125`):

```ts
return clip((u?.display_name ?? '').trim(), AUTHOR_NAME_MAX) || 'Owner';
```

`AUTHOR_NAME_MAX = 100` and `clip` are module-local in `discovery.ts:97-98`:

```ts
const AUTHOR_NAME_MAX = 100;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
```

The rule is: trim, then if the length is over 100, keep the first 99 characters and add `…` (U+2026, one UTF-16 unit). The
result is exactly 100 `.length`, which is what zod measures. `AUTHOR_NAME_MAX` is used only at line 1124. The local `clip`
is used for many unrelated text clips in the file and must stay.

### 2.4 Shared callers of the same path

- `addParticipant` (`sessions.ts:389-413`) calls `checkParticipant` (401) and `participantEvent` (408), via
  `POST /api/sessions/:id/participants`.
- `BoardService.create` (`board.ts:304`) calls `createSession`, which adds the owner participant. `BoardService.start`
  (`board.ts:389-397`) and `suggest` (`board.ts:333`) add participants through `addParticipant`.
- Side benefit: board events that copy a participant's `display_name` from `thread_participants` into max(100) fields
  (`board.ts:451` speakers, `board.ts:1487`) are safe once the participant row holds the clipped name.

### 2.5 Out of scope, filed as a follow-up

`BoardService.userName` (`board.ts:1402-1405`) returns `users.display_name` unclipped. It feeds board events with max(100)
name fields (`packages/shared/src/events/board.ts:14, 95, 113, 134`), for example `BoardDecisionResolved` at
`board.ts:1623`. This is the same class of bug, but on the board decision and note path, not on session create. It goes on
the backlog and is not fixed here. Once the helper below exists, that fix is a one-liner.

## 3. Options for where the clip lives

| Option | Description | Pros | Cons |
|---|---|---|---|
| A. Shared server helper in `apps/server/src/commands/common.ts` | Export `EVENT_NAME_MAX = 100` and `clipEventName(name)` (trim plus clip). Use it in `checkParticipant` and in `DiscoveryService.userName`. | One rule, one place. `common.ts` is already imported by both `sessions.ts` and `discovery.ts` (and `board.ts`) for `userActor` and `orgScope`, so there is no new dependency direction. | Touches `discovery.ts` (a tiny, behaviour-identical refactor). |
| B. Helper in `packages/shared` | Same helper, exported from shared. | Next to the schemas. | Larger blast radius (shared package build and exports) for a server-only concern. The card says to keep it in apps/server unless that is not possible. |
| C. Copy the rule locally in `sessions.ts` | Another `clip` plus `100`. | Smallest diff. | A second copy of the rule, which the card forbids. |
| D. Clip in `participantEvent` | Clip every `displayName` that goes into the event. | Covers all participant kinds. | Also changes agent and persona names and the explicit `p.displayName` (already ≤ 100). It moves the rule away from the user lookup and widens the behaviour change. |

## 4. Recommendation: Option A

### 4.1 `apps/server/src/commands/common.ts`: add the helper

```ts
/**
 * Longest person name an event may carry (ThreadParticipantAdded.displayName, discovery and board author names).
 * A user's display name can be longer.
 */
export const EVENT_NAME_MAX = 100;

/** A user's display name as an event may carry it: trimmed, and clipped to EVENT_NAME_MAX with an ellipsis. */
export const clipEventName = (name: string): string => {
  const s = name.trim();
  return s.length > EVENT_NAME_MAX ? `${s.slice(0, EVENT_NAME_MAX - 1)}…` : s;
};
```

This is exactly today's `clip((x).trim(), AUTHOR_NAME_MAX)` from `discovery.ts`, given a name and a home.

### 4.2 `apps/server/src/sessions/discovery.ts`: use the shared helper (behaviour unchanged)

- Add `clipEventName` to the existing import from `'../commands/common.ts'` (line 43).
- Line 1124: `return clipEventName(u?.display_name ?? '') || 'Owner';`
- Delete `AUTHOR_NAME_MAX` (line 96 comment and line 97). It has no other use. Keep the local `clip` because many other
  call sites use it.

### 4.3 `apps/server/src/commands/sessions.ts`: clip in the user branch of `checkParticipant`

```ts
import { clipEventName, orgScope, userActor } from './common.ts';
...
if (!u) throw badRequest('unknown_participant', 'that user is not a member of the organization');
// The event's displayName is max 100; a user's display name can be longer (users.display_name is unbounded).
return { displayName: p.displayName ?? (clipEventName(u.display_name) || u.display_name) };
```

- Clip only the value from `users.display_name`. Leave an explicit `p.displayName` alone: the input schema already caps it
  at 100.
- `|| u.display_name` keeps today's behaviour for the degenerate case of a name that is only whitespace (trim would make it
  empty and break `min(1)`, where today it passes). It is not reachable with real names and does not change any normal
  name.
- Agent and persona branches are untouched.

This single change covers `createSession` (discovery and board create), `addParticipant`, and through it board
`start`/`suggest`.

### 4.4 What does not change

- The event schemas (`max(100)` stays), `users.display_name`, the API contract of `POST /api/discovery` and
  `POST /api/sessions`, and the web app.
- Names of 100 characters or fewer with no surrounding whitespace are stored exactly as before.
- One small, intentional side effect: a display name with leading or trailing spaces is stored trimmed in the participant
  event. That is the same as the discovery note author name has been since the earlier fix, so the two now match.
- Already-stored events: replay reads the stored value. Nothing is migrated.

### 4.5 Data model

No migration. `thread_participants.display_name` (`text`) receives the clipped value through the existing projector.

## 5. Tests

The server suites use Postgres (`DATABASE_URL` must point at `aom_test`, `test/helpers/db.ts`). If the database is not up
in the build sandbox, ask DevOps to start it or run these suites, and say so in the handoff.

1. **Regression, `apps/server/test/discovery.test.ts`** (next to the existing long-name test at line 255, which sets the
   name *after* create and so never exercised this path):
   - Save the owner's `display_name`. Set it to `'N'.repeat(120)` **before** `create(...)`. Restore it in `finally`.
   - Check that `POST /api/discovery` returns 201 (use `raw` so a 500 shows up as a status assertion), and that
     `GET /api/discovery/:id` succeeds.
   - Read the stored event and check the clip: either `SELECT payload FROM events WHERE type='ThreadParticipantAdded' AND
     payload->>'threadId'=$1 AND payload->>'kind'='user'`, or `thread_participants.display_name` for the owner. Expected:
     `'N'.repeat(99) + '…'` (length 100).
   - Drain the facilitator start (`await finish(await nextStart())`) so later tests keep their order.
   - On the current code this test fails with 500 (AC5). Check that once by running it without the fix.
2. **Boundaries** (same file, a small `it.each` or a loop): exactly 100 characters gives the name stored unchanged. 101
   characters gives `99 + '…'`. A short name (`'Ada Lovelace'`) is stored unchanged.
3. **Shared paths, `apps/server/test/sessions.test.ts`:**
   - `POST /api/sessions` (kind `boardroom` or `discovery`) as an owner with a 120-character name returns 201, and the
     owner participant's `displayName` is the clipped value.
   - `addParticipant`: seed a second active org member with a 120-character `display_name` (insert into `users` and
     `org_members` the way other suites seed members, or invite and accept). Then `POST /api/sessions/:id/participants`
     `{kind:'user', refId, seat:'Guest'}` returns 201 with the clipped `displayName`. With a short name it is unchanged.
   - Optional, in `boardroom.test.ts`: board create with the 120-character owner returns success. The `createSession` test
     above already covers the code path.
4. **Helper unit test (no database)**, for example `apps/server/test/clip-event-name.test.ts`: `clipEventName` on `''`,
   `'  Ada  '` → `'Ada'`, 100 → unchanged, 101 and 120 → length 100 ending in `…`.
5. Run `discovery.test.ts`, `sessions.test.ts`, `r2-sessions.test.ts` and `boardroom.test.ts`, then
   `pnpm --filter <server> typecheck` and lint (biome).

## 6. How each acceptance criterion is met

| AC | Design |
|---|---|
| POST /api/discovery with a 120-character name succeeds, and the session is created and retrievable | §4.3 clips the owner's participant name. Test 5.1 |
| Every create-path event passes validation, and the stored name is the clipped name made by the same clipping as the earlier fix | §2.2 lists every create-path event. §4.1–4.2 make `userName()` and `checkParticipant` call the one `clipEventName`. Test 5.1 asserts the stored value |
| A name of exactly 100 characters and a short name are stored unchanged | `clipEventName` keeps any name of 100 characters or fewer. Test 5.2 |
| The shared helper changed, so board create/start/suggest and addParticipant succeed at 120 characters and are unchanged for short names | §2.4 and §4.3 (one change in `checkParticipant`). Test 5.3 |
| A new regression test fails on the current code and passes with the fix | Test 5.1 (sets the name before create, unlike the existing test) |
| Existing discovery and sessions suites pass | Test 5.5. The `discovery.ts` refactor is behaviour-identical |

## 7. Risks

- **Low.** About 15 changed product lines and about 80 test lines. No schema change, no migration, no API change.
- Order of tests in `discovery.test.ts`: the suite shares one fake runner. The new test must drain its facilitator
  `chat.start`, or `nextStart()` in the next test picks up the wrong turn.
- `slice(0, 99)` can split a UTF-16 surrogate pair (an emoji at position 99). That is existing behaviour of the earlier
  rule, kept on purpose (same rule). zod still passes because it counts `.length`.
- Follow-up (not this card): `BoardService.userName` (`board.ts:1402`) should use `clipEventName` too. Filed on the
  backlog.
