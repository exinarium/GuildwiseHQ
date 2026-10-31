# POST /api/projects/:id/delete fails on chat_archives_thread_id_fkey

## Question

Deleting an archived project (`POST /api/projects/:id/delete`) answers 500:

> update or delete on table "threads" violates foreign key constraint "chat_archives_thread_id_fkey" on table "chat_archives"

Why, and where must the fix go so a project delete succeeds?

## Findings

### Path

`projectRoutes` → `deleteProject` (`apps/server/src/commands/projects.ts`, ~line 916) appends `ProjectDeleted` in a
`withAppendTx`; the projector `ProjectDeleted` (`apps/server/src/projections/projects.ts:489`) calls
`deleteProjectRows(tx, projectId)` in the same transaction. Any failure in the projector rolls the whole delete back
and the route answers 500.

### Cause

`deleteProjectRows` (`apps/server/src/projections/projects.ts:27`) removes the project's rows "in foreign-key order".
For threads it does:

```ts
const threads = `SELECT id FROM threads WHERE kind <> 'intake' AND (project_id=$1 OR card_id IN (${cards}))`;
...
await exec(tx, `DELETE FROM thread_messages WHERE thread_id IN (${threads})`, P);   // ~line 107
await exec(tx, `DELETE FROM threads WHERE id IN (${threads})`, P);                  // ~line 108
```

Every foreign key to `threads(id)` in the migrations:

| Table | Migration | FK | Cleared by `deleteProjectRows`? |
| --- | --- | --- | --- |
| `thread_messages` | `0008_shifts_threads.sql:41` | `REFERENCES threads(id)` (no cascade) | yes |
| `chat_archives` | `1307_chat_archive.sql:5` | `REFERENCES threads(id)` (no cascade) | **no** → the reported error |
| `chat_reads` | `2270_chat_reads.sql:4` | `REFERENCES threads(id)` (no cascade) | **no** → the same error, next in line |

(Searched `apps/server/migrations` for `REFERENCES threads`; every other `thread_id` column is a plain uuid with no FK.)

So a project delete fails as soon as any user has **closed (archived)** one of the project's chats (`ChatArchived` →
`chat_archives` row) or **read** one of them (`ChatRead` → `chat_reads` row). `chat_reads` is the more common case: any
user who opened a project chat with at least one message has a row. The reported error names `chat_archives` only
because Postgres stopped at the first violated constraint; fixing only `chat_archives` would surface
`chat_reads_thread_id_fkey` next.

The single-thread delete already does it right: `ChatDeleted` in `apps/server/src/projections/chats.ts:49-55` deletes
`thread_messages`, `chat_archives` and `chat_reads` for the thread. `deleteProjectRows` was written before (or missed)
migrations 1307 and 2270.

Why the existing test did not catch it: `apps/server/test/project-archive.test.ts` "removes every row of the project"
creates no chats; its leftover check only scans tables with a `project_id`/`card_id`/`phase_id` column, and
`chat_archives`/`chat_reads` have only `thread_id`.

## Options

1. **Delete the rows explicitly in `deleteProjectRows`** (two `DELETE` statements before the `threads` delete).
   - Matches the function's documented style ("in foreign-key order") and the `ChatDeleted` pattern.
   - No migration, no schema change; replay/rebuild behaves the same as live (projector is idempotent).
2. **Migration: `ON DELETE CASCADE` on both FKs.**
   - Also fixes it, but changes schema behaviour for every thread delete, is inconsistent with the rest of the schema
     (no cascades on `threads` anywhere), and is a bigger change than the card allows ("keep the change minimal").

## Recommendation

Option 1.

## Design

### Change (one file)

`apps/server/src/projections/projects.ts`, in `deleteProjectRows`, right after the `thread_messages` delete and before
the `threads` delete:

```ts
await exec(tx, `DELETE FROM thread_messages WHERE thread_id IN (${threads})`, P);
// Per-user chat state (closed/read markers, migrations 1307 and 2270) points at the threads.
await exec(tx, `DELETE FROM chat_archives WHERE thread_id IN (${threads})`, P);
await exec(tx, `DELETE FROM chat_reads WHERE thread_id IN (${threads})`, P);
await exec(tx, `DELETE FROM threads WHERE id IN (${threads})`, P);
```

Use the same `threads` subquery (intake threads stay, as today, so their markers stay too). No data model or API change.
No web change (`DeleteProjectDialog`/`useDeleteProject` only call the endpoint).

### Regression test

Extend `apps/server/test/project-archive.test.ts` (it already drives the real `POST /api/projects/:id/delete` against
the test database and then checks a projection rebuild). In the `deleting a project permanently` describe, before the
project is archived (the first describe ends with the project restored to `active`, so the chat commands' membership
checks pass), set up a project chat that has both markers:

```ts
let chatThreadId: string;

it('setup: a project chat the owner has read and closed', async () => {
  const agentId = (await q(`SELECT id FROM agents WHERE name='Una'`))[0]!.id;
  const chat = await ok<any>(owner('POST', '/api/chats', { agentId, projectId: w.projectId }), 201);
  chatThreadId = chat.chat.threadId;
  await ok(owner('POST', `/api/chats/${chatThreadId}/close`));             // -> chat_archives row
  // markChatRead needs a message; seed the read marker event directly (ChatRead projector -> chat_reads row)
  await seed(w, [{
    streamId: streamId.thread(chatThreadId),
    event: { type: 'ChatRead', payload: { threadId: chatThreadId, userId: w.owner.id, readUpTo: new Date().toISOString() } },
    actor: { kind: 'user', id: w.owner.id },
    scope: { orgId: null, projectId: null, audience: 'user', userId: w.owner.id },   // same shape as userScope()
  }]);
  expect((await q('SELECT 1 FROM chat_archives WHERE thread_id=$1', [chatThreadId])).length).toBe(1);
  expect((await q('SELECT 1 FROM chat_reads WHERE thread_id=$1', [chatThreadId])).length).toBe(1);
});
```

(Scope shape from `userScope()` in `apps/server/src/commands/common.ts:12`; any agent
the owner can direct works, `Una` exists from the first describe. Alternative for the read marker: post a message so
`POST /api/chats/:id/read` works, if a simple helper for that exists.)

Then in `removes every row of the project and keeps the audit record`, after the delete, add:

```ts
expect((await q('SELECT 1 FROM threads WHERE id=$1', [chatThreadId])).length).toBe(0);
expect((await q('SELECT 1 FROM chat_archives WHERE thread_id=$1', [chatThreadId])).length).toBe(0);
expect((await q('SELECT 1 FROM chat_reads WHERE thread_id=$1', [chatThreadId])).length).toBe(0);
```

Without the fix the `ok(owner('POST', .../delete))` call fails with 500 (`chat_archives_thread_id_fkey`); with only the
`chat_archives` line it fails on `chat_reads_thread_id_fkey`. The existing `a projection rebuild does not resurrect the
deleted project` test then also covers replay: `ChatThreadCreated`, `ChatArchived`, `ChatRead` replay before
`ProjectDeleted`, and the snapshot must match (`chat_archives`/`chat_reads` are in `PROJECTION_TABLES`).

Optional, if cheap: a second chat on a card of the project (`cardId`) with a close, to cover the `card_id` branch of
the `threads` subquery. Not required.

### Callers / regression check

- `deleteProjectRows` is only called by the `ProjectDeleted` projector (live and on rebuild).
- Readers of `chat_archives`/`chat_reads` (`apps/server/src/commands/chats.ts` list/get queries, `apps/server/src/ceo/home.ts`)
  use `EXISTS`/`NOT EXISTS`/joins keyed by thread; removing rows for deleted threads cannot affect other threads.
- `ChatDeleted` / `ChatRestored` / `ChatArchived` / `ChatRead` projectors are unchanged.

### Risks

- Low. Two scoped deletes inside the existing transaction. The only behavioural change: per-user closed/read markers of
  the deleted project's chats are removed, which is required for the threads to go.
- The test file is a DB-backed server test (Postgres test database), like the rest of `apps/server/test`; run it on its own.

### Acceptance criteria mapping

| AC | Covered by |
| --- | --- |
| The failure no longer happens | The two `DELETE` statements in `deleteProjectRows` before the `threads` delete |
| A regression test reproduces the bug without the fix and passes with it | New setup test + assertions in `apps/server/test/project-archive.test.ts`: the delete returns 500 without the fix, succeeds with it, and no `chat_archives`/`chat_reads` row is left |
