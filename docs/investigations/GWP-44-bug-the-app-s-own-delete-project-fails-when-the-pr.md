# Delete project fails when the project has archived (or read) chats

## Question

Deleting an archived project from Archived projects > Delete project fails when one of its chats is closed
(archived). Why, where is the fix, and does deleting a single chat have the same defect?

## Findings

### Root cause

`deleteProject` (`apps/server/src/commands/projects.ts:920`) checks ownership, status and key, then appends
`ProjectDeleted` inside `withAppendTx`. The event's projector (`apps/server/src/projections/projects.ts:489`) calls
`deleteProjectRows`, which deletes the project's rows in foreign-key order. For threads it does:

```ts
// apps/server/src/projections/projects.ts:107-108
await exec(tx, `DELETE FROM thread_messages WHERE thread_id IN (${threads})`, P);
await exec(tx, `DELETE FROM threads WHERE id IN (${threads})`, P);
```

Every table with a foreign key to `threads` (searched all migrations for `REFERENCES threads`):

| Table | Migration | FK | Cleared by `deleteProjectRows` today |
|---|---|---|---|
| `thread_messages` | 0008_shifts_threads.sql | `thread_id REFERENCES threads(id)`, no cascade | yes |
| `chat_archives` | 1307_chat_archive.sql | `thread_id REFERENCES threads(id)`, no cascade | **no** |
| `chat_reads` | 2270_chat_reads.sql | `thread_id REFERENCES threads(id)`, no cascade | **no** |

So `DELETE FROM threads` breaks the FK as soon as one of the project's threads has a `chat_archives` row (a chat closed
by any user) **or a `chat_reads` row** (any user opened the chat after it had a message, which is nearly every chat).
The second case is broader than the card describes: in practice almost any project with a chat someone has read cannot
be deleted. The fix covers both.

Why the existing test missed it: `project-archive.test.ts` > "removes every row of the project" checks every table
with a `project_id`/`card_id` column. `chat_archives` and `chat_reads` have neither (only `thread_id`, `user_id`), and
the fixture project has no closed or read chat.

### Atomicity is already given

`withAppendTx` wraps the whole command in one transaction (`apps/server/src/db/tx.ts:31`), and the projector runs
inside the append in that same transaction. Today the FK error rolls back the event and every delete before it. That is
why the project is still intact after the failed attempt and the UI shows the error. Adding the two deletes inside
`deleteProjectRows` keeps them in that transaction. Nothing else is needed for requirement 2.

### Replay safety

`ProjectDeleted` has never been committed for a project with archive or read rows, because the FK failure rolled the
append back. So no stored history holds a `ProjectDeleted` that fails on replay. With the fix, a rebuild replays
`ChatThreadCreated`, `ChatArchived`, `ChatRead` and then `ProjectDeleted`, and the projector clears them in order.
After a project is deleted, no `ChatArchived` or `ChatRead` can be appended for its threads: `setChatArchived`,
`markChatRead` and `archiveAllChats` all go through `getChatRow` or a `threads` join, and those rows are gone, so the
command returns 404.

### The other caller

`deleteInterest` (`apps/server/src/commands/interests.ts:~404`) also appends `ProjectDeleted` for the interest's backing
project. It has the same defect and gets the same fix, because the change sits in the shared projector.

### Single-chat delete (requirement 5)

`deleteChat` (`apps/server/src/commands/chats.ts:290`) appends `ChatDeleted`. Its projector
(`apps/server/src/projections/chats.ts:47-54`) already deletes `thread_messages`, `chat_archives` and `chat_reads`
for the thread, and it keeps the `threads` row as a tombstone (`deleted_at`) rather than deleting it. **deleteChat does
not have the defect.** No change is needed. The builder adds one regression case for it (see Tests) so this stays
true.

### Production

guildwise-cloud has no project or chat deletion code of its own and no extra tables referencing `threads`. It runs
GuildwiseHQ as the `core` submodule, currently pinned at v1.3.0, and
`core/apps/server/src/projections/projects.ts:107-108` has the same two lines. Production is affected. It gets the fix
only when the submodule or dependency is bumped and redeployed. That is a follow-up outside this card.

### Overlap with GWP-43

GWP-43 (same group, now in review, base `release/1.4.0`) already has commit `5bb73cb9`. It adds exactly the two
deletes below to `deleteProjectRows`, plus a setup step and three assertions in `project-archive.test.ts`. GWP-44 is
based on `main`. To keep the two branches compatible when both land:

- make the **projector change byte-identical** to `5bb73cb9`: same two lines, same place, same order. Either merge
  order then applies cleanly or resolves trivially;
- put GWP-44's broader tests in a **new test file**, not in `project-archive.test.ts`, so they do not conflict with
  GWP-43's test edits.

## Options

| | A. Explicit deletes in `deleteProjectRows` | B. `ON DELETE CASCADE` migration on `chat_archives` and `chat_reads` |
|---|---|---|
| Change | 2 lines in one projector | migration that drops and re-adds 2 FK constraints (constraint names are auto-generated, so look them up), plus a change to test expectations |
| Consistency | matches the existing style: `deleteProjectRows` deletes in explicit FK order, and `ChatDeleted` deletes explicitly | first cascade in this schema; hides deletes from readers of the projector |
| Prod risk | none: no DDL | DDL on live tables; a lock while each constraint is re-validated |
| Replay | safe (see above) | safe |
| Also fixes `deleteInterest` | yes (shared projector) | yes |
| Matches GWP-43 | identical | conflicts in approach |

## Recommendation

**Option A: an explicit delete in the same transaction. No migration.** (This is the choice requirement 1 asks the
Architect to make.)

## Design

### Change: `apps/server/src/projections/projects.ts`, `deleteProjectRows`

Between the `thread_messages` delete and the `threads` delete:

```ts
await exec(tx, `DELETE FROM thread_messages WHERE thread_id IN (${threads})`, P);
await exec(tx, `DELETE FROM chat_archives WHERE thread_id IN (${threads})`, P);
await exec(tx, `DELETE FROM chat_reads WHERE thread_id IN (${threads})`, P);
await exec(tx, `DELETE FROM threads WHERE id IN (${threads})`, P);
```

- Use the existing `threads` constant unchanged:
  `SELECT id FROM threads WHERE kind <> 'intake' AND (project_id=$1 OR card_id IN (cards))`. The filter for archive and
  read rows is then exactly the set of threads that are deleted. Intake threads, other projects' threads and org-level
  chats are untouched (requirement 4).
- Tombstoned chats (`deleted_at` set) are in the set too. Their archive and read rows were already removed by
  `ChatDeleted`, so the deletes simply match nothing.
- Optionally, add "chat archive and read markers" to the doc comment above the function. Nothing else changes: no
  command, route, permission check, UI, migration or shared type.

### Tests: new file `apps/server/test/project-delete-chats.test.ts`

Use the same harness as `project-archive.test.ts` (`createWorld`, `ok`, `q`, `closeAdminPool`, `rebuildProjections`).
Create chats with `POST /api/chats { agentId, projectId }`; hire a non-DevOps agent with `w.hire(...)`. Close a chat
with `POST /api/chats/:id/close`. For a read marker, append a `ChatRead` event through `w.t.app.ctx.store.append`
(as in `5bb73cb9`), or insert a message and call `POST /api/chats/:id/read` (as in `chat-read.test.ts`). The delete
goes through the real route: `POST /api/projects/:id/archive`, then `POST /api/projects/:id/delete { confirmKey }`.

1. **Regression (AC 1, 2, 6).** Project P1 has chat A (closed, so it has a `chat_archives` row), chat B (active, with
   a `chat_reads` row), and a card-linked chat if that is cheap to set up. Archive P1, then delete it. Expect 200.
   Expect 0 rows for P1's thread ids in `threads`, `chat_archives`, `chat_reads` and `thread_messages`, and `projects`
   has no P1. On current code this fails: the delete returns 500 with an FK violation.
2. **Isolation (AC 3).** Before the delete, seed P2 in the same organisation, and P3 in a second organisation (a second
   `createWorld({ listen: false })`, as `org-agents.test.ts:334` does), each with a closed and a read chat. Seed also
   an org-level chat (no `projectId`) that is closed. Snapshot their `threads`, `chat_archives` and `chat_reads` rows
   before the P1 delete and assert they are equal after it.
3. **No regressions (AC 4).** Delete a project with no chats, and a project whose only chat is open and has no read
   marker. Both return 200 and the project is gone.
4. **Atomicity (AC 5).** Force a failure late in `deleteProjectRows`, after the archive, read and thread deletes. In the
   test, create a `BEFORE DELETE ON projects` trigger with `q(...)` that raises only for that project's id. Delete the
   project and expect a non-2xx response. Assert the project, its threads, its `chat_archives` and `chat_reads` rows
   and its cards are all still present, and that there is no `ProjectDeleted` event for it. Drop the trigger and its
   function in `finally`. Fallback if DDL is not allowed in the test DB: open a transaction on the pool, call
   `deleteProjectRows` and then throw, and assert the rollback left everything in place.
5. **Replay.** After test 1 and test 2, run `rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store)`. It must not
   throw. P1's threads and archive and read rows stay absent, and P2 and P3 rows are unchanged.
6. **deleteChat (AC 7).** Close a chat that has a read marker, then send `DELETE /api/chats/:id` as its creator. Expect
   204. Expect no `chat_archives` or `chat_reads` rows for it, and the thread row is still there with `deleted_at`
   set. This passes on current code and guards the existing behaviour.

Run only `apps/server` with a hang limit, for example
`timeout 600 pnpm --filter @aom/server exec vitest run test/project-delete-chats.test.ts test/project-archive.test.ts test/chat-read.test.ts`.
These suites need the local test Postgres, which the earlier infra card made reachable from the sandbox. To confirm that
test 1 fails on current code, run it once before applying the projector change.

### Acceptance criteria → design

| AC | Covered by |
|---|---|
| Project with an archived chat deletes from the UI in one attempt | projector change; test 1. No UI change: `DeleteProjectDialog` and `useDeleteProject` call the same route |
| No `chat_archives` row and no thread of the project remain | the archive and read deletes before the threads delete; test 1 |
| Other projects' and organisations' rows unchanged | identical `threads` filter; test 2 |
| Projects with no chats or only active chats delete as before | test 3 |
| A failure part-way deletes nothing | the existing `withAppendTx`; test 4 |
| Regression test fails before the fix and passes after | test 1 (run it once on the base commit) |
| Card states the deleteChat finding | this report: no defect, because the `ChatDeleted` projector already clears archive and read rows; test 6 guards it |

### Risks

- **Merge with GWP-43.** Both branches add the same lines. Keep them identical and keep the tests in a separate file.
- **A future table referencing `threads`.** It would bring the same bug back. Optional hardening for the test: query
  `information_schema` (or `pg_constraint`) for every FK to `threads` and assert that none of them has rows for the
  deleted thread ids, in the same spirit as the existing `project_id` sweep in `project-archive.test.ts`.
- **Production stays broken** until guildwise-cloud bumps `core` (now v1.3.0) and redeploys. That is a follow-up for
  the manager.
