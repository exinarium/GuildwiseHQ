# Guildwise HQ — v1 Architecture

Status: design baseline for v1 · Source of truth for product behaviour: `docs/SPEC.md` · Build order: `docs/PLAN.md`

This document is written so an implementer can build without further design decisions. Where the spec is silent or ambiguous, the default chosen here is listed in §24 and is binding until changed.

---

## 0. System overview

```
                         VPS (Docker Compose)
  ┌───────────────────────────────────────────────────────────────────┐
  │  caddy (TLS, :443)                                                │
  │    └── server (Fastify, :4600)                                    │
  │          ├── REST /api/*            ◄── browser (React SPA)       │
  │          ├── WS   /api/ws           ◄── browser                   │
  │          ├── WS   /api/runner/ws    ◄── runners (outbound only)   │
  │          ├── command handlers ──► EventStore.append (+projections)│
  │          ├── dispatcher  (claims cards)                           │
  │          ├── scheduler   (ScheduleFired)                          │
  │          ├── reaper      (lease expiry, offline 1h)               │
  │          └── static SPA  (apps/web/dist)                          │
  │  postgres 18  (events + projections, LISTEN/NOTIFY)               │
  └───────────────────────────────────────────────────────────────────┘
                  ▲  wss (runner token)
  Workstation     │
  ┌───────────────┴───────────────────────────────────────────────────┐
  │ aom-runner (Node CLI, long running)                               │
  │   ├── connection (WS client, reconnect, persistent outbox)        │
  │   ├── shift supervisor ── runtime adapter (claude-code | mock)    │
  │   │        └── agent session in git worktree, private sandbox     │
  │   ├── IPC server 127.0.0.1:<ephemeral>  ◄── `aom` CLI in session  │
  │   ├── git (worktrees, rebase, completion actions)                 │
  │   └── vault sync loop (pull/commit/push)                          │
  └───────────────────────────────────────────────────────────────────┘
```

Rules that hold everywhere:

- Domain state changes only by appending events. Every projection row that represents domain state is written by a projector inside the same transaction as the append.
- Operational state that is not domain state (auth sessions, heartbeat timestamps, lease expiry refresh, WS connection flags, runner inbox dedupe, shift progress tail) is written directly and is documented as such. It is never needed to rebuild the board.
- The server never holds repo credentials, provider credentials or vault content. Anything that touches a repo, a vault or a provider happens on the runner.

---

## 1. Stack and repository layout

| Concern | Choice | Notes |
| --- | --- | --- |
| Language | TypeScript 5.x, `"strict": true`, ESM everywhere | Node 22.23 |
| Package manager | pnpm 12 workspaces (corepack) | |
| Shared contract | `packages/shared`: zod v4 schemas, event union, workflow + role definitions, protocol messages, prompt renderer | Consumed as TS source (`"exports": {".": "./src/index.ts"}`); no build step. Server and runner bundle it with tsup; web via Vite. |
| Server | Fastify 5, `@fastify/cookie`, `@fastify/websocket` (ws), `@fastify/static`, `@fastify/rate-limit`, `pg` (node-postgres), `@node-rs/argon2`, `nodemailer`, `cron-parser`, `pino` (Fastify logger) | No ORM: raw SQL through a 30-line typed helper. The event store needs explicit transactions and conditional updates; an ORM adds nothing. |
| Web | React 19, Vite 7, TanStack Query v5, React Router v7 (library mode), Tailwind CSS v4 | Deviation: React Router instead of TanStack Router; the app has ~12 routes and no need for typed search params. |
| Runner | Node CLI: `commander`, `ws`, `execa`, `picomatch`; bundled to a single `aom-runner.mjs` + `aom.mjs` with tsup | Runs on Linux, macOS, Windows. |
| Tests | vitest (unit + integration), Playwright (web E2E) | Server integration tests use DB `aom_test`. |
| Lint/format | Biome | Deviation from eslint+prettier: one fast tool, zero plugin config. |
| IDs | `uuidv7()` (built into Postgres 18) as column default; `uuid` v7 in TS where IDs are minted client-side (message ids) | Time-ordered keys. |

Dev ports: server **4600**, web (Vite) **5173** with proxy `/api` → `http://127.0.0.1:4600` (including WS). Postgres 127.0.0.1:5433, dev Mailpit SMTP 127.0.0.1:1026 (UI 8026; `docker-compose.dev.yml`, host ports `AOM_MAILPIT_SMTP_PORT`/`AOM_MAILPIT_UI_PORT`; the e2e suite uses `AOM_E2E_SMTP_URL`/`AOM_MAILPIT_API`, default 1025/8025). Runner IPC binds `127.0.0.1:0` (ephemeral).

```
agent-org-manager/
  package.json                 # root scripts: dev, test, lint, typecheck, e2e, db:migrate
  pnpm-workspace.yaml          # packages/*, apps/*
  tsconfig.base.json
  biome.json
  docker-compose.dev.yml       # exists: postgres
  docker-compose.prod.yml      # app + postgres + caddy
  Dockerfile                   # multi-stage: build web + server bundle
  .env.example
  packages/shared/src/
    index.ts
    ids.ts                     # Uuid brand, card ref helpers, slugify
    events/                    # envelope.ts + one file per domain + index.ts (union)
    workflows/                 # schema.ts, validate.ts, builtin/{code,code-bugfix,research,feed}.ts, index.ts
    roles/                     # schema.ts, builtin.ts
    cards/                     # fields.ts (per-workflow field schemas), columns.ts (board column derivation)
    api/                       # REST request/response zod schemas, one file per resource
    protocol/                  # runner.ts (runner WS), browser.ts (browser WS), ipc.ts (aom CLI <-> runner)
    prompt/                    # renderShiftPrompt(brief), renderInstructions(brief)
    authz/                     # pure policy predicates shared by server and web (for hiding buttons)
  apps/server/
    migrations/                # 0001_events.sql, 0002_users.sql, ... (plain SQL)
    src/
      main.ts  app.ts  config.ts
      db/        pool.ts  tx.ts  sql.ts  migrate.ts
      eventstore/ types.ts  pg-event-store.ts  notifier.ts
      projections/ index.ts  users.ts  workstations.ts  projects.ts  cards.ts  agents.ts  shifts.ts  threads.ts  ...
      commands/  auth.ts  invitations.ts  workstations.ts  projects.ts  cards.ts  agents.ts  shifts.ts  ...
      dispatcher/ dispatcher.ts  candidates.ts  claim.ts  reaper.ts
      scheduler/ scheduler.ts
      runner-gateway/ gateway.ts  registry.ts  handlers.ts  brief.ts  commands-queue.ts
      browser-gateway/ gateway.ts  visibility.ts
      routes/    auth.ts  admin.ts  invitations.ts  workstations.ts  runner-pair.ts  projects.ts  cards.ts  agents.ts  board.ts  ...
      auth/      password.ts  sessions.ts  origin-check.ts  guards.ts
      authz/     scope.ts  (SQL visibility helpers)
      mail/      mailer.ts  templates.ts
    test/        helpers/ (db reset, fixtures, fake runner WS client)  *.test.ts
  apps/runner/src/
    cli.ts                     # aom-runner pair | start | status | doctor
    config.ts  paths.ts
    connection/ client.ts  outbox.ts
    shifts/    supervisor.ts  brief-to-files.ts  guard.ts  autocommit.ts
    adapters/  types.ts  registry.ts  claude-code.ts  claude-stream-parser.ts  mock.ts  mock-agent.ts
    ipc/       server.ts
    aom/       aom-cli.ts      # the in-session `aom` command
    git/       git.ts  worktrees.ts  repo-scan.ts  diffstat.ts  completion.ts
    sandbox/   sandbox.ts
    vaults/    sync.ts  write.ts          (M3)
    devops/    requests.ts                (M3)
  apps/web/src/
    main.tsx  router.tsx
    api/       client.ts  queries/*.ts
    ws/        socket.ts  invalidate.ts
    pages/     Login, AcceptInvite, Board, CardDetail, CardNew, Projects, ProjectSettings, Workstations, Agents, Admin, Desk(M2), Ledger(M2), Chat(M2), Hr(M9), OrgDesigner(M10)
    components/
  e2e/         playwright.config.ts  global-setup.ts  tests/*.spec.ts
```

---

## 2. Core concepts and identifiers

- **Organization = user.** Every user owns exactly one organization; `org_id` is the owner's `users.id`. No separate orgs table. A shared project lives in its owner's org; members act inside it for that project only.
- **Streams.** `user-<uuid>`, `invitation-<uuid>`, `workstation-<uuid>`, `project-<uuid>`, `card-<uuid>`, `agent-<uuid>`, `thread-<uuid>`, `desk-<uuid>`, `ledger-<uuid>`, `schedule-<uuid>`, `workflow-<orgId|builtin>-<key>`, `role-<orgId|builtin>-<key>`, `shift-<uuid>`, `vault-<uuid>`. Optimistic concurrency per stream via `stream_version`.
- **Card ref.** `<PROJECT_KEY>-<n>` (e.g. `WEB-12`), `n` from `projects.next_card_number`, allocated inside the `CardCreated` transaction.
- **Card owner.** The user who created or imported the card (`cards.owner_user_id`). Defaults decision rights and outbound updates (spec: "the card's owner, who imported the ticket").
- **Agent scope.** Agents belong to the organization (`agents.org_id`), not to a project (docs/design/restructure.md, Part A). `agents.allowed_project_ids` is the per-agent allow-list set by the manager (NULL = any project of the org; a list = those projects only; an empty list = benched), `agents.focus_project_ids` the soft preference inside it (at most 10), and `agents.hired_for_project_id` (the former `project_id`) only keeps the project the agent was hired for as history. An agent may work a card only when the card's project is on its allow-list **and** the user who owns the agent's workstation is an active member of that project (`project_members`: the Owner and Admins hold a row in every project of their org, a guest only in the shared ones). The DevOps engineer is outside allow-lists (it works DevOps requests and hygiene only). `agents.workstation_id` (where it runs), `agents.hired_by_user_id` (HR rights), `agents.manager_user_id` (current HR manager; changes to the owner when a member is removed).

---

## 3. Event store

### 3.1 Interface (`apps/server/src/eventstore/types.ts`)

```ts
export interface AppendInput<E extends DomainEvent = DomainEvent> {
  streamId: string;
  expectedVersion?: number | 'any' | 'no_stream';   // default 'any'
  event: E;                                          // { type, payload } validated by zod before insert
  actor: { kind: 'user' | 'agent' | 'system' | 'runner'; id: string | null };
  scope: { orgId: string | null; projectId: string | null; audience: 'org' | 'project' | 'admin' | 'system' };
  correlationId?: string; causationId?: string;
}
export interface StoredEvent<E extends DomainEvent = DomainEvent> extends AppendInput<E> {
  seq: bigint; id: string; streamVersion: number; createdAt: Date;
}
export interface EventStore {
  /** Appends atomically (all or nothing) inside `tx` (or a new tx), runs projectors, notifies on commit. */
  append(inputs: AppendInput[], opts?: { tx?: Tx }): Promise<StoredEvent[]>;
  read(streamId: string, fromVersion?: number): Promise<StoredEvent[]>;
  readAll(afterSeq: bigint, limit?: number): Promise<StoredEvent[]>;
  /** In-process fan-out of committed events in seq order; at-least-once; handler must be idempotent. */
  subscribe(handler: (e: StoredEvent) => void | Promise<void>, opts?: { afterSeq?: bigint }): () => void;
}
```

### 3.2 Append algorithm (PgEventStore)

Inside one transaction:

1. `SELECT pg_advisory_xact_lock(7311)` — a single global append lock. This makes commit order equal `seq` order, so subscribers reading `seq > lastSeq` can never skip an event that commits late. Volume is low (tens of events per minute); commands are short. Revisit only if append latency matters.
2. For each input: resolve current stream version (`SELECT max(stream_version) FROM events WHERE stream_id=$1`), check `expectedVersion`, insert with `stream_version = current + 1`. `UNIQUE (stream_id, stream_version)` is the backstop.
3. For each stored event, call `projectors.apply(tx, event)` (§3.3).
4. `SELECT pg_notify('aom_events', <last seq>::text)` — delivered only on commit.

Command handlers do their reads/conditional updates (e.g. the claim) **after** taking the lock in the same transaction, via `withAppendTx(async (tx) => { ... })`, which takes the lock first.

### 3.3 Projections: synchronous, same transaction

Decision: projections update synchronously in the append transaction. A command's response therefore always reflects its own effects, the dispatcher reads consistent queues, and there is no projection lag to reason about. Rejected: async projector worker (eventual consistency complicates claim and authorization checks for no v1 benefit).

- Projectors live in `apps/server/src/projections/<domain>.ts`, each exporting `{ [eventType]: (tx, e) => Promise<void> }`; `projections/index.ts` merges them; an event type with no projector is allowed (pure audit events).
- Projectors must be deterministic functions of the event and prior projection state: they use `e.createdAt`, never `now()`, and never call external services.
- `pnpm --filter @aom/server projections:rebuild` truncates every projection table (list in `projections/index.ts`) and replays all events in `seq` order in batches of 1000 within one transaction. Operational columns (lease expiry, `connected`, `last_seen_at`) are reset to safe values (leases recomputed as `claimed_at + 1h`).

**Operational tables survive a rebuild.** The `TRUNCATE ... RESTART IDENTITY CASCADE` of the projection tables also empties every table with a foreign key (direct or indirect) to them, so `projections/rebuild.ts` copies those tables to temp tables first (`SAVED`) and re-inserts them after the replay, parents before children, keeping only rows whose users, organizations, workstations or projects exist again (a rebuild reproduces the same ids). Saved: `auth_sessions`, `pairing_codes`, `installer_sessions`, `user_totp`, `user_recovery_codes`, `login_challenges`, `password_resets`, `email_verifications`, `billing_subscriptions`, `billing_invoices`, `billing_profiles`, `support_tickets`, `support_messages`, `support_attachments`, `forge_repo_lists`, `runner_commands`, `workstation_keys`, `runner_token_rotations`, `workstation_repos`, `workstation_vaults`, `transcripts`. Login sessions are kept on purpose (nobody is signed out by a rebuild). Tables without a foreign key to a projection (`mail_inboxes`, `mail_addresses`, `mail_threads`, `mail_messages`, `inbound_counters`, `billing_fx_rates`, `billing_notices`, `blog_api_keys`, `blog_writer_runs`, `blog_api_log`, `blog_digests`, `social_*`, `cloud_workstations`, `assistant` counters, `data_migrations`, ...) are never touched. Two guards stop a new table from being lost: `rebuildProjections` first calls `unsavedCascadeTargets` and aborts, before truncating anything, if the CASCADE would empty a table that is neither a projection nor in `SAVED`; and `rebuild-operational.test.ts` asserts the same and that billing, support, verification, API key and cloud workstation rows survive. A new operational table with a foreign key to a projection table must be added to `SAVED`.

**Deleted projects and rebuild.** The event log is append-only and a project's events (its `project-`, `card-`, `thread-`, `shift-`... streams) are never purged. `ProjectDeleted` is a tombstone: its projector runs `deleteProjectRows()`, which deletes every row of the project in foreign-key order (cards and what hangs off them: transitions, handoffs, activity, dependencies, blockers, test runs, intake links, agent stats and review log, digest items, research publications, outbound drafts, shifts; threads and messages; desk items and project/card ledger entries; schedules, `feed_seen`, `transcripts`, repo requests, project repos and their `workstation_repos`, the project vault registration, members, the project row) and detaches rows that merely point at its cards (a parent/worktree reference from another project, a DevOps request's `card_id`, an intake's `mapped_project_id`). A rebuild replays the events in `seq` order, so the project's rows are recreated by its earlier events and removed again when the tombstone is reached: the end state equals the live state, and nothing is resurrected. Chosen over purging the streams because purging needs an exception to the append-only trigger (§3.5), leaves holes in `seq`/`stream_version` that subscribers and the optimistic-concurrency check do not expect, and loses the audit trail; the cost is that the deleted project's payloads (card titles, messages) remain in the `events` table, which is the accepted trade-off of an event-sourced audit log (the database *rows* the application reads are gone). Agents belong to the organization and are kept: `agents.hired_for_project_id` keeps the id as history (it has no foreign key), the project leaves every allow-list and focus (an agent allowed on that project only ends with an empty allow-list: benched, and `deleteProject` raises one org-level desk notice, subkind `agents_benched`, naming those agents), and nothing is retired or wiped. The vault folder is never touched. Covered by `apps/server/test/project-archive.test.ts` (including a rebuild after the delete).

### 3.4 Subscriptions

`notifier.ts` holds one dedicated `pg.Client` with `LISTEN aom_events`. On each notification (and every 5 s as a safety poll) it reads `readAll(lastSeq, 500)` and fans out to in-process subscribers in order: browser gateway, runner gateway, dispatcher trigger, scheduler trigger. `lastSeq` starts at `max(seq)` on boot. v1 runs a single server instance; the design still works with two instances for browser fan-out because everything goes through NOTIFY (runner connections would need sticky routing; out of scope).

### 3.5 Append-only enforcement

A trigger rejects UPDATE/DELETE on `events` (see DDL). Tests clean up with `TRUNCATE`, which the row trigger does not block.

---

## 4. Database schema

Migrations are plain SQL files `apps/server/migrations/NNNN_name.sql`, applied in lexical order by `apps/server/src/db/migrate.ts`:

- takes `pg_advisory_lock(7300)`; creates `schema_migrations(version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())` if missing;
- for each file not applied: run it in its own transaction and insert the row; for applied files, compare sha256 checksum and abort with an error if a file changed;
- runs on server boot (`AOM_MIGRATE_ON_BOOT=true`, default) and via `pnpm db:migrate`; tests run it against `aom_test` once in vitest `globalSetup`.

Migration number ranges are reserved per milestone so parallel builders never collide: M1 `0001–0099`, M2 `0200–0299`, M3 `0300–0399`, M4 `0400–0499`, M5 `0500–0599`, M6 `0600–0699`, M7 `0700–0799`, M8 `0800–0899`, M9 `0900–0999`, M10 `1000–1099`. Organizations added `1310_organizations.sql` (tables, `users.kind`, invitation kinds, `org_id` on the projections that lacked it), `1311_org_fks.sql` (the `org_id` foreign keys re-pointed from `users` to `organizations`, `DEFERRABLE INITIALLY DEFERRED` and validated by the data migration) and `1312_two_factor.sql` (`user_totp`, recovery codes, login challenges, `organizations.require_two_factor`). Data migrations (`apps/server/src/data-migrations/`, recorded in `data_migrations`) run on boot after the schema: `orgs-2026-10` appends `OrganizationCreated` + `OrgMemberAdded(owner)` for every user (org id = user id) and is idempotent; `pnpm --filter @aom/server orgs:migrate [--dry-run]` runs or previews it. Both data-migration CLIs (`orgs:migrate`, `restructure:migrate`) do their `--dry-run` through `withPendingMigrations` (`db/migrate.ts`): the pending SQL migrations are applied inside one transaction on one connection, the plan reads that migrated schema, and the transaction is rolled back (nothing is written; the CLI says how many migrations were pending). Costs and budgets added `1317_costs_budgets.sql` (section 26). Dropping the work/personal domain added `1322_project_ranking.sql`: `projects.rank` (seeded in the old order: work before personal, then tier, then age), the snapshot table `legacy_project_domains` (what `projects.domain` and `priority_tier` held, kept for the data migration; not a projection, a rebuild leaves it alone), `DROP COLUMN` of `projects.domain`, `projects.priority_tier` and `interests.domain`, and the vault kinds (`work` becomes `org`, `personal` stays until it is merged). `1323_card_last_rejection.sql` adds `cards.last_rejection jsonb` (the latest runner rejection of a queued card, from `ClaimReleased.rejection`; read by the workability check).

**Data migration `no-personal-2026-10`** (`data-migrations/no-personal.ts`, boot after `restructure-2026-10`, `ranking:migrate [--dry-run]` CLI, `dist/ranking-migrate.mjs` in the image). For every organization that existed when 1322 took its snapshot (or still holds a personal vault), in one transaction per organization under `pg_advisory_lock(7332)` and in two steps, each recorded in `data_migrations` (`no-personal-2026-10/rank/<org>` and `.../vault/<org>`) in the same transaction as its events, so a second run or a crash changes nothing and never overwrites a ranking the Owner made since: (1) one `ProjectsRanked(reason 'migration')` puts the projects in the order work (tier, age) then personal (tier, age), projects created later last; (2) the personal vault: with an organization vault, `VaultMerged` retires the row, a `ProjectVaultDirSet` points each personal project without a vault of its own at `personal/<its folder>`, and one durable runner command `vault.merge` is queued on a workstation of the Owner or an Admin; without an organization vault, `VaultMerged{intoVaultId: null}` makes the personal vault the organization vault and nothing moves; with no workstation to run the merge the step waits for the next run (the ranking does not). One desk alert (`no_personal_migrated`) tells the Owner. `vault.merge` (`apps/runner/src/vaults/merge.ts`, `VaultManager.merge`) clones the source from the URL the command carries (it is no longer registered), syncs it, copies its files under `personal/` into the organization vault clone without overwriting (identical files are skipped, differing ones are reported), lifts the folders of personal interests (`interests/<slug>`) to the same path at the root, commits and pushes; it never changes the source (the old repository stays as a backup) and is idempotent and safe to interrupt. `--dry-run` applies the pending SQL migrations in a rolled-back transaction (`withPendingMigrations`) and prints the plan. `no-personal-migration.test.ts` runs it against the shape of the UAT database, plus a rebuild comparison.

### 4.1 Core DDL (M1)

```sql
-- 0001_events.sql
CREATE TABLE events (
  seq             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id              uuid        NOT NULL DEFAULT uuidv7() UNIQUE,
  stream_id       text        NOT NULL,
  stream_version  integer     NOT NULL,
  type            text        NOT NULL,
  schema_version  smallint    NOT NULL DEFAULT 1,
  payload         jsonb       NOT NULL,
  actor_kind      text        NOT NULL CHECK (actor_kind IN ('user','agent','system','runner')),
  actor_id        uuid,
  org_id          uuid,
  project_id      uuid,
  audience        text        NOT NULL CHECK (audience IN ('org','project','admin','system')),
  correlation_id  uuid,
  causation_id    uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stream_id, stream_version)
);
CREATE INDEX events_org_seq     ON events (org_id, seq);
CREATE INDEX events_project_seq ON events (project_id, seq) WHERE project_id IS NOT NULL;
CREATE INDEX events_type_seq    ON events (type, seq);

CREATE FUNCTION events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'events is append-only'; END $$;
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_append_only();

-- 0002_users.sql
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  email          text NOT NULL,
  display_name   text NOT NULL,
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('admin','member')),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deactivated')),
  created_at     timestamptz NOT NULL,
  deactivated_at timestamptz,
  last_login_at  timestamptz                         -- operational
);
CREATE UNIQUE INDEX users_email_lower ON users (lower(email));

CREATE TABLE invitations (
  id               uuid PRIMARY KEY,
  email            text NOT NULL,
  role             text NOT NULL CHECK (role IN ('admin','member')),
  token_hash       text NOT NULL UNIQUE,              -- sha256 hex of the 32-byte token
  invited_by       uuid REFERENCES users(id),
  status           text NOT NULL CHECK (status IN ('pending','accepted','revoked')),
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL,
  accepted_at      timestamptz,
  accepted_user_id uuid REFERENCES users(id)
);
CREATE UNIQUE INDEX invitations_one_pending_per_email ON invitations (lower(email)) WHERE status = 'pending';

-- Operational (not event sourced): login sessions
CREATE TABLE auth_sessions (
  id           text PRIMARY KEY,                      -- sha256 hex of cookie token
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  user_agent   text,
  ip           inet
);
CREATE INDEX auth_sessions_user ON auth_sessions (user_id);

-- 0003_workstations.sql
CREATE TABLE workstations (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id),
  name           text NOT NULL,
  platform       text,                                -- linux | darwin | win32
  hostname       text,
  runner_version text,
  token_hash     text NOT NULL UNIQUE,                -- sha256 hex of runner token
  status         text NOT NULL CHECK (status IN ('active','unlinked')),
  runtimes       jsonb NOT NULL DEFAULT '[]',         -- [{id, version, available, capabilities[]}] from hello
  paired_at      timestamptz NOT NULL,
  unlinked_at    timestamptz,
  connected      boolean NOT NULL DEFAULT false,      -- operational
  last_seen_at   timestamptz                          -- operational
);
CREATE INDEX workstations_user ON workstations (user_id);

CREATE TABLE pairing_codes (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id     uuid NOT NULL REFERENCES users(id),
  code_hash   text NOT NULL UNIQUE,                   -- sha256 hex of normalized code
  expires_at  timestamptz NOT NULL,                   -- created_at + 10 min
  used_at     timestamptz,
  attempts    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL
);

-- 0004_projects.sql
CREATE TABLE projects (
  id                 uuid PRIMARY KEY,
  org_id             uuid NOT NULL REFERENCES users(id),
  key                text NOT NULL CHECK (key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  name               text NOT NULL,
  workflow_key       text NOT NULL DEFAULT 'code',     -- default workflow for new cards
  rank               integer,                          -- the organization's ranking (1 = most important); NULL for an interest's project (migration 1322)
  branch_prefix      text NOT NULL DEFAULT 'aom/',
  working_branch     text NOT NULL DEFAULT 'main',
  sub_categories     text[] NOT NULL DEFAULT '{}',
  vault_folder       text,                             -- projects/<name> inside the organization vault
  architectural_globs text[] NOT NULL DEFAULT '{}',    -- touching these makes risk tier large
  e2e_globs          text[] NOT NULL DEFAULT '{e2e/**,tests/e2e/**,playwright/**}',
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  next_card_number   integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL,
  UNIQUE (org_id, key)
);

CREATE TABLE project_repos (
  id                    uuid PRIMARY KEY,
  project_id            uuid NOT NULL REFERENCES projects(id),
  name                  text NOT NULL,
  remote_url            text NOT NULL,
  remote_url_normalized text NOT NULL,   -- lowercased host/path, no scheme/user/.git: github.com/acme/web
  working_branch        text,            -- overrides projects.working_branch
  removed_at            timestamptz,
  UNIQUE (project_id, remote_url_normalized)
);

CREATE TABLE project_members (
  project_id  uuid NOT NULL REFERENCES projects(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  role        text NOT NULL CHECK (role IN ('owner','manager')),
  status      text NOT NULL CHECK (status IN ('invited','active','removed')),
  invited_by  uuid REFERENCES users(id),
  invited_at  timestamptz,
  joined_at   timestamptz,
  removed_at  timestamptz,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user ON project_members (user_id) WHERE status = 'active';
-- The owner always has an 'owner' row (written by the ProjectCreated projector) so visibility is one join.

CREATE TABLE workstation_repos (                     -- projection of runner hello/repos.report (operational)
  workstation_id  uuid NOT NULL REFERENCES workstations(id),
  project_repo_id uuid NOT NULL REFERENCES project_repos(id),
  local_path      text NOT NULL,
  reported_at     timestamptz NOT NULL,
  PRIMARY KEY (workstation_id, project_repo_id)
);

-- 0005_catalogue.sql  (built-ins are upserted at boot from packages/shared; immutable per version)
CREATE TABLE workflow_versions (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id      uuid REFERENCES users(id),           -- NULL = built-in
  key         text NOT NULL,
  version     integer NOT NULL,
  name        text NOT NULL,
  department  text,
  definition  jsonb NOT NULL,                       -- WorkflowDefinition (shared/workflows/schema.ts)
  status      text NOT NULL CHECK (status IN ('draft','pending_approval','active','superseded','rejected')),
  created_at  timestamptz NOT NULL,
  UNIQUE NULLS NOT DISTINCT (org_id, key, version)
);
CREATE TABLE workflow_stages (                     -- flattened for dispatcher joins
  workflow_version_id uuid NOT NULL REFERENCES workflow_versions(id),
  stage_id            text NOT NULL,
  ordinal             smallint NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('agent','manual','terminal')),
  claim_role          text,                          -- role key; NULL for manual/terminal
  senior_only         boolean NOT NULL DEFAULT false,
  column_key          text NOT NULL,
  PRIMARY KEY (workflow_version_id, stage_id)
);
CREATE TABLE role_definitions (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id      uuid REFERENCES users(id),           -- NULL = built-in
  key         text NOT NULL,
  version     integer NOT NULL,
  definition  jsonb NOT NULL,                       -- RoleDefinition
  status      text NOT NULL CHECK (status IN ('draft','pending_approval','active','superseded','rejected')),
  created_at  timestamptz NOT NULL,
  UNIQUE NULLS NOT DISTINCT (org_id, key, version)
);
CREATE TABLE role_extensions (                     -- owner's additions to a built-in role (M9/M10; table in M1)
  org_id       uuid NOT NULL REFERENCES users(id),
  role_key     text NOT NULL,
  base_version integer NOT NULL,
  extensions   jsonb NOT NULL,                      -- {instructions, skills[], standingOrders[]}
  updated_at   timestamptz NOT NULL,
  PRIMARY KEY (org_id, role_key)
);

-- 0006_agents.sql
CREATE TABLE agents (
  id                  uuid PRIMARY KEY,
  org_id              uuid NOT NULL REFERENCES users(id),
  project_id          uuid REFERENCES projects(id),   -- NULL = org-wide (1313: renamed hired_for_project_id, history only,
                                                       --   no FK; allowed_project_ids uuid[] NULL = any, focus_project_ids uuid[] added)
  hired_by_user_id    uuid NOT NULL REFERENCES users(id),
  manager_user_id     uuid NOT NULL REFERENCES users(id),
  workstation_id      uuid REFERENCES workstations(id), -- NULL while needs_rehome
  name                text NOT NULL,
  role_key            text NOT NULL,
  role_version        integer NOT NULL,
  seniority           text NOT NULL CHECK (seniority IN ('junior','senior')),
  runtime             text NOT NULL,                  -- 'claude-code' | 'mock' | ...
  model               text NOT NULL,
  effort              text,                           -- 'low'|'medium'|'high'|'xhigh'|'max'
  skills              text[] NOT NULL DEFAULT '{}',
  permissions         jsonb NOT NULL DEFAULT '{}',    -- AgentPermissions
  capacity            smallint NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 8),
  is_devops           boolean NOT NULL DEFAULT false,
  status              text NOT NULL CHECK (status IN ('active','retired','needs_rehome')),
  hired_at            timestamptz NOT NULL,
  retired_at          timestamptz,
  last_shift_ended_at timestamptz
);
CREATE UNIQUE INDEX agents_name_per_org ON agents (org_id, lower(name));   -- includes retired: never reused
CREATE UNIQUE INDEX agents_one_devops ON agents (org_id, workstation_id) WHERE is_devops AND status = 'active';

-- 0007_cards.sql
CREATE TABLE cards (
  id                       uuid PRIMARY KEY,
  org_id                   uuid NOT NULL REFERENCES users(id),
  project_id               uuid NOT NULL REFERENCES projects(id),
  number                   integer NOT NULL,
  ref                      text NOT NULL,                      -- WEB-12
  title                    text NOT NULL,
  card_type                text NOT NULL CHECK (card_type IN ('feature','bug','support','refactor','docs','research','feed','regression')),
  workflow_version_id      uuid NOT NULL REFERENCES workflow_versions(id),  -- pinned at creation
  stage                    text NOT NULL,
  status                   text NOT NULL CHECK (status IN ('draft','queued','claimed','blocked','waiting','done','cancelled')),
  fields                   jsonb NOT NULL DEFAULT '{}',        -- workflow field schema (shared/cards/fields.ts)
  owner_user_id            uuid NOT NULL REFERENCES users(id),
  decision_policy          text NOT NULL DEFAULT 'owner_only' CHECK (decision_policy IN ('owner_only','any_manager')),
  risk_tier                text CHECK (risk_tier IN ('small','large')),
  risk_tier_overridden     boolean NOT NULL DEFAULT false,
  docs_needed              boolean NOT NULL DEFAULT false,
  completion_action        text CHECK (completion_action IN ('pr','push_branch','merge')), -- push_branch retired 2026-10 (#61): old rows only
  repo_id                  uuid REFERENCES project_repos(id),
  base_branch              text,
  branch_name              text,
  worktree_path            text,
  home_workstation_id      uuid REFERENCES workstations(id),   -- set on first claim that creates the worktree
  worktree_card_id         uuid REFERENCES cards(id),          -- bug child shares parent's worktree
  parent_card_id           uuid REFERENCES cards(id),
  origin                   text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','intake','schedule','test_failure','full_suite','regression')),
  scheduled                boolean NOT NULL DEFAULT false,
  schedule_id              uuid,
  priority                 smallint NOT NULL DEFAULT 2,        -- within project, 1 = highest
  rework_round             integer NOT NULL DEFAULT 0,
  is_rework_or_bug         boolean GENERATED ALWAYS AS (rework_round > 0 OR card_type = 'bug') STORED,
  original_builder_agent_id uuid REFERENCES agents(id),
  last_agent_id            uuid REFERENCES agents(id),
  excluded_agent_ids       uuid[] NOT NULL DEFAULT '{}',       -- agents not allowed to claim current stage
  review_approvals         smallint NOT NULL DEFAULT 0,        -- approvals in current review round
  required_capabilities    text[] NOT NULL DEFAULT '{}',
  -- claim / lease
  claim_id                 uuid,
  claimed_by_agent_id      uuid REFERENCES agents(id),
  claim_workstation_id     uuid REFERENCES workstations(id),
  claim_shift_id           uuid,
  claimed_at               timestamptz,
  lease_expires_at         timestamptz,                        -- refreshed by heartbeat (operational)
  claim_overflow           boolean NOT NULL DEFAULT false,
  queued_at                timestamptz,
  blocked_since            timestamptz,
  created_at               timestamptz NOT NULL,
  updated_at               timestamptz NOT NULL,
  finalized_at             timestamptz,
  UNIQUE (project_id, number),
  CHECK ((claim_id IS NULL) = (claimed_by_agent_id IS NULL))
);
CREATE INDEX cards_queue    ON cards (stage, queued_at) WHERE status = 'queued' AND claim_id IS NULL;
CREATE INDEX cards_project  ON cards (project_id, stage);
CREATE INDEX cards_claimed  ON cards (claimed_by_agent_id) WHERE claim_id IS NOT NULL;
CREATE INDEX cards_lease    ON cards (lease_expires_at) WHERE claim_id IS NOT NULL;

CREATE TABLE card_dependencies (
  card_id            uuid NOT NULL REFERENCES cards(id),
  depends_on_card_id uuid NOT NULL REFERENCES cards(id),
  PRIMARY KEY (card_id, depends_on_card_id),
  CHECK (card_id <> depends_on_card_id)
);

CREATE TABLE card_handoffs (
  id         uuid PRIMARY KEY,
  card_id    uuid NOT NULL REFERENCES cards(id),
  shift_id   uuid,
  agent_id   uuid REFERENCES agents(id),
  stage      text NOT NULL,
  outcome    text NOT NULL,
  note       text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}',      -- diffStats, score, reasons, evidence, ...
  event_seq  bigint NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX card_handoffs_card ON card_handoffs (card_id, created_at);

CREATE TABLE card_transitions (                 -- assignee history + metrics source
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  card_id     uuid NOT NULL REFERENCES cards(id),
  from_stage  text, to_stage text NOT NULL,
  from_status text, to_status text NOT NULL,
  agent_id    uuid REFERENCES agents(id),
  user_id     uuid REFERENCES users(id),
  reason      text NOT NULL,                     -- event type
  event_seq   bigint NOT NULL,
  at          timestamptz NOT NULL
);
CREATE INDEX card_transitions_card ON card_transitions (card_id, id);

-- 0008_shifts_threads.sql
CREATE TABLE shifts (
  id                 uuid PRIMARY KEY,
  org_id             uuid NOT NULL REFERENCES users(id),
  agent_id           uuid NOT NULL REFERENCES agents(id),
  workstation_id     uuid NOT NULL REFERENCES workstations(id),
  card_id            uuid REFERENCES cards(id),
  kind               text NOT NULL CHECK (kind IN ('card','chat','question','devops')),
  stage              text,
  status             text NOT NULL CHECK (status IN ('starting','running','ended')),
  outcome            text,              -- reported | no_report | stopped | crashed | timeout | rejected | lost
  report_outcome     text,              -- stage outcome id reported via aom
  runtime            text NOT NULL,
  model              text NOT NULL,
  runtime_session_id text,
  overflow           boolean NOT NULL DEFAULT false,
  started_at         timestamptz NOT NULL,
  ended_at           timestamptz,
  duration_ms        integer,
  tokens_input       bigint, tokens_output bigint, tokens_cache_read bigint, tokens_cache_write bigint,
  progress_tail      jsonb NOT NULL DEFAULT '[]'   -- operational: last 50 progress items
);
CREATE INDEX shifts_agent ON shifts (agent_id, started_at DESC);
CREATE INDEX shifts_card  ON shifts (card_id, started_at);

CREATE TABLE threads (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES users(id),
  project_id uuid REFERENCES projects(id),
  card_id    uuid REFERENCES cards(id),
  kind       text NOT NULL CHECK (kind IN ('card','chat','devops','intake')),
  agent_id   uuid REFERENCES agents(id),    -- chat/devops counterpart
  title      text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX threads_one_per_card ON threads (card_id) WHERE kind = 'card';

CREATE TABLE thread_messages (
  id              uuid PRIMARY KEY,
  thread_id       uuid NOT NULL REFERENCES threads(id),
  author_kind     text NOT NULL CHECK (author_kind IN ('user','agent','system')),
  author_user_id  uuid REFERENCES users(id),
  author_agent_id uuid REFERENCES agents(id),
  kind            text NOT NULL CHECK (kind IN ('comment','question','answer','handoff','review','evidence','chat','system')),
  body            text NOT NULL,
  data            jsonb NOT NULL DEFAULT '{}',
  event_seq       bigint NOT NULL,
  created_at      timestamptz NOT NULL
);
CREATE INDEX thread_messages_thread ON thread_messages (thread_id, created_at);

-- 0009_runner_ops.sql  (operational)
CREATE TABLE runner_commands (                  -- durable server->runner commands for offline delivery
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  workstation_id uuid NOT NULL REFERENCES workstations(id),
  type           text NOT NULL,                 -- agent.wipe | worktree.remove | vault.write | vault.configure | finalize.execute | repos.rescan
  payload        jsonb NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','done','failed')),
  attempts       integer NOT NULL DEFAULT 0,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz, done_at timestamptz
);
CREATE INDEX runner_commands_pending ON runner_commands (workstation_id, created_at) WHERE status IN ('pending','sent');

CREATE TABLE runner_inbox (                     -- idempotency for runner->server acked messages
  message_id     uuid PRIMARY KEY,
  workstation_id uuid NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now()
);
```

### 4.2 Later-milestone tables (columns fixed here; DDL written in the milestone)

| Table | Milestone | Columns |
| --- | --- | --- |
| `desk_items` | M2 | `id, org_id, project_id, card_id, kind ('question','approval','escalation','alert','rating'), subkind (e.g. 'outbound','large_merge','devops','taste_rule','tester_bottleneck','vault_conflict','unmapped_ticket','workflow','role'), status ('open','answered','dismissed','superseded'), routed_to ('manager' or 'agent'), routed_agent_id, title, body, doing (what the asker was doing), options jsonb [{id,label,description}], recommendation (option id), blocking bool, affected_card_ids uuid[], asked_by_kind, asked_by_agent_id, asked_by_user_id, asked_by_role, pinned bool, dedup_ledger_ids uuid[], answer text, answer_option text, answered_by uuid, answered_at, created_at, updated_at` |
| `card_blockers` | M2 | `card_id, desk_item_id, PK(card_id, desk_item_id)` |
| `ledger_entries` | M2 | `id, org_id, project_id NULL, card_id NULL, scope ('feature','decision','standing_order'), title, body, tags text[], source_desk_item_id, vault_path, created_by_kind, created_by_id, superseded_by, created_at, search tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || body)) STORED` + GIN index |
| `vaults` | M3 | `id, org_id, project_id NULL, kind ('org','project'; 'personal' only until `no-personal-2026-10` has merged it), name, remote_url, sync_interval_sec default 300, created_at` |
| `workstation_vaults` | M3 | `workstation_id, vault_id, local_path, last_pull_at, last_push_at, last_error, PK` (operational) |
| `devops_requests` | M3 | `id, org_id, workstation_id, devops_agent_id, thread_id, requested_by_kind, requested_by_id, card_id, summary, status ('queued','running','needs_approval','done','failed'), created_at, updated_at` |
| `environment_changes` | M3 | `id, request_id, workstation_id, summary, commands text[], created_at` |
| `test_runs` | M4 | `id, card_id, shift_id, kind ('feature','full_suite','regression'), platform, result ('passed','failed'), evidence jsonb, created_at` |
| `schedules` | M5 | `id, org_id, project_id, name, kind ('feed','regression','card'), cron, timezone, card_template jsonb, enabled, next_fire_at, last_fired_at, created_at` |
| `digest_items` | M5 | `id, card_id, project_id, kind ('article','video',...), url, url_normalized, title, source, published_at, summary, verdict ('useful','irrelevant','boring') NULL, verdict_reason, rated_by, rated_at, created_at` |
| `feed_seen` | M5 | `project_id, url_normalized, first_seen_at, PK` |
| `research_publications` | M6 | `id, card_id, project_id, vault_path, title, citations jsonb, created_at` |
| `intakes` | M7 | `id, org_id, thread_id, external_system, external_key, mapped_project_id, card_id, status, created_at` |
| `outbound_drafts` | M8 | `id, org_id, project_id, card_id, external_system, external_key, external_url, kind ('comment','resolution','decision'), body (the draft), final_body (what was approved and is posted), edited, status ('pending','approved','rejected','posted','failed','blocked'), desk_item_id, drafted_by_kind/_id, approved_by, reject_reason, blocked_matches, external_ref (URL or id returned), error, attempts, created_at, approved_at, posted_at, updated_at` |
| `agent_card_stats`, `agent_review_log`, `agent_stats_daily`, `hr_applied` | M9 | HR track record, projected from events by `projections/track-record.ts` (no refresh job; a rebuild reproduces them): per agent and card (questions, rework rounds, bugs, tokens, diff and test files), per review verdict (score, reasons, criteria missed), per agent and day (shift time, tokens, cards done), applied recommendations. Stats over the rolling 30-day window are computed from them at read time (`hr/track-record.ts`). `schedules` gains `fail_count`, `last_error`, `failure_desk_item_id` |
| `deploy_targets`, `phases`, `phase_followups`, `ba_tasks` | phases (migration 1303) | Named phases of a project and what runs after them (`docs/design/phases.md`, Part A). `deploy_targets`: `id, org_id, project_id, name, kind ('local_docker','remote_ssh'), workstation_id (remote_ssh only; NULL for a local target, which fans out to every member workstation), host, app_url, notes, removed_at`. `phases`: `id, org_id, project_id, number, ref ('WEB-P2'), name, description, status ('proposed','open','reporting','awaiting_approval','running_followups','reporting_results','done','done_with_failures','followups_rejected','discarded','cancelled'), working_branch, created_by_*, intake_id, proposal/report/results_desk_item_id, card_outcomes jsonb, report, outstanding jsonb, results_report, completed_at, approved_by/at, finished_at`. `phase_followups`: `id, phase_id, position, kind ('deploy','regression','custom'), target_id, platform, instruction, note, status ('pending','queued','briefed','running','succeeded','failed','skipped','cancelled'), delegate ('devops','tester','ba'), brief, devops_request_ids uuid[], regression_card_ids uuid[], ba_task_id, result_summary, evidence jsonb, mock jsonb`. `ba_tasks`: `id, org_id, project_id, phase_id, followup_id, kind ('phase_report','followups_brief','followup_custom','followups_report'), status ('queued','running','done','failed','fallback','cancelled'), preferred_agent_id, agent_id, shift_id, attempts, note`. `projects` gains `next_phase_number, default_followups`; `cards` gains `phase_id, phase_assignment ('proposed','confirmed'), phase_followup_id, merged_into_working_at`; `shifts` gains `kind 'ba_task'` and `ba_task_id`; `threads.kind` gains `'phase'` (thread id = phase id) |
| `interests`, `interest_runs`, `interest_deliveries`, `taste_seeds` | interests (migrations 1306 and 1316) | Org-level interests (`docs/design/restructure.md` Part D). `interests`: `id, org_id, name, description, project_id` (the hidden backing project, unique), `slug` (the folder `interests/<slug>/` of the organization vault, immutable, unique per org), `sub_category, preferred_sites text[], kinds text[], scan jsonb {cron, timezone, windowHours, maxItems, manual}` (the **run schedule**), `delivery jsonb {mode ('immediate','scheduled'), cron, timezone}` (the **delivery schedule**), `agents jsonb {scout?, curator?, researcher?, checker?}` (a soft preference), `taste_rules jsonb string[], taste_version, status ('active','paused'), next_scan_at, next_delivery_at, last_delivered_at, fail_count, last_error, failure_desk_item_id, archived_at, created_by, created_by_rank, legacy_feed_project_id, legacy_research_project_id, legacy_schedule_id` (the first model, read by the migration), unique `(org_id, lower(name))`. `interest_runs`: `id, interest_id, org_id, kind ('scan','research'), trigger ('cron','manual','after_scan','migrated'), card_id` (unique), `parent_run_id, status ('queued','scanning','curating','researching','checking','published','nothing','failed','cancelled'), found, published, duplicates_dropped, over_max_dropped, started_by, started_at, finished_at`. `interest_deliveries`: `id, interest_id, org_id, at, item_count, held_back, trigger, desk_item_id`. `projects` gains `kind ('project','interest')` and `vault_dir` (the full folder of a backing project; `projectVaultFolder` returns it first); `cards` gains `interest_run_id`, `preferred_agents jsonb` and the origin `interest`; `digest_items` gains `delivered_at` (NULL while the item waits for a delivery). `taste_seeds` (`project_id PK, version, rules`) is the first model's project-wide rules, read only after the migration. `data_migrations` (operational, not rebuilt) records `restructure-2026-10`. All the others are projections; a rebuild reproduces them |
| `departments` | M10 | `id, org_id, name, created_at` (unique per org, case-insensitive); built-in department names (delivery, research, feeds, operations) are not rows. `role_definitions` gains `department, desk_item_id, drafted_by_kind, vault_path`; `workflow_versions` gains `desk_item_id, drafted_by_kind, vault_path` (migration 1000) |

---

## 5. Event catalogue

### 5.1 Shape

`packages/shared/src/events/` defines one zod schema per event; `index.ts` builds the union. Each domain file is append-only in practice so parallel milestones only conflict on the one-line import list in `index.ts`.

```ts
// events/define.ts
export const defineEvent = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({ type: z.literal(type), payload });

// events/index.ts
export const DomainEventSchema = z.discriminatedUnion('type', [
  ...userEvents, ...workstationEvents, ...projectEvents, ...cardEvents, ...shiftEvents,
  ...agentEvents, ...deskEvents, ...ledgerEvents, ...testingEvents, ...scheduleEvents,
  ...feedEvents, ...researchEvents, ...intakeEvents, ...outboundEvents, ...devopsEvents,
  ...vaultEvents, ...catalogueEvents,
]);
export type DomainEvent = z.infer<typeof DomainEventSchema>;
export type EventType = DomainEvent['type'];
export type EventOf<T extends EventType> = Extract<DomainEvent, { type: T }>;
```

Common field schemas: `Id = z.uuid()`, `Stage = z.string().min(1)`, `Note = z.string().min(1).max(20000)`, `Usage = z.object({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: z.number().int().nonnegative() })`.

### 5.2 Events, payloads and projection effects

Names in **bold** are from the spec; the rest are infrastructure events the spec implies (accounts, pairing, catalogue, card editing, claim release). A transition event always carries `fromStage`/`toStage` (resolved from the pinned workflow at emit time) so replay never needs workflow lookups.

#### Accounts and workstations (`events/user.ts`, `events/workstation.ts`) — audience `admin` for invitation/user admin events, `org` otherwise

| Event | Payload | Projection effect |
| --- | --- | --- |
| `UserBootstrapped` | `{userId, email, displayName, passwordHash, role:'admin'}` | insert users (first admin, created by `pnpm admin:create` CLI) |
| `UserInvited` | `{invitationId, email, role, tokenHash, expiresAt, invitedBy}` | insert invitations (pending) |
| `InvitationResent` | `{invitationId, tokenHash, expiresAt}` | replace token_hash, expires_at |
| `InvitationRevoked` | `{invitationId}` | status revoked |
| `InvitationAccepted` | `{invitationId, userId, email, displayName, passwordHash, role}` | invitation accepted; insert users |
| `UserRoleChanged` | `{userId, role}` | users.role |
| `UserDeactivated` / `UserReactivated` | `{userId}` | users.status; deactivation also deletes auth_sessions (side effect in command handler) and, in the same transaction, appends `ProjectMemberRemoved` for every shared project the user is a manager of and `WorkstationUnlinked` (by `admin`) for every active workstation of the user; the projection parks the user's own remaining agents (`needs_rehome`, no workstation). Reactivation does not restore workstations (re-pair) or memberships (re-share) |
| `PasswordChanged` | `{userId, passwordHash}` | users.password_hash |
| `WorkstationPaired` | `{workstationId, userId, name, platform, hostname, runnerVersion, tokenHash}` | insert workstations; pairing code marked used (command handler, same tx); triggers auto-hire of DevOps engineer (M3) |
| `WorkstationRenamed` | `{workstationId, name}` | name |
| `WorkstationUnlinked` | `{workstationId, by:'owner'|'admin'}` | status unlinked; token invalid; open WS closed with 4403; claims on it released (ClaimReleased reason `workstation_unlinked`) |
| `WorkstationConnected` / `WorkstationDisconnected` | `{workstationId, runnerVersion?}` | connected flag (also operational); used for presence and metrics |

Heartbeats are not events.

#### Projects (`events/project.ts`) — audience `project`

| Event | Payload | Projection effect |
| --- | --- | --- |
| `ProjectCreated` | `{projectId, orgId, key, name, workflowKey, branchPrefix, workingBranch, subCategories, vaultFolder}` (events from before the ranking also carry `domain` and `priorityTier`: accepted, ignored) | insert projects (`rank` = last place of the organization for a visible project, NULL for an interest's) + project_members(owner, active) |
| `ProjectsRanked` | `{orgId, projectIds[], rankedBy?, reason ('manual','migration')}` | `projects.rank` = the position in `projectIds` (the whole order, most important first, archived projects last). Appended by `PUT /api/projects/ranking` (Owner and Admins; the body must name every active project of the organization, else 409 `ranking_stale`; an unchanged order appends nothing) and by `no-personal-2026-10` |
| `ProjectVaultDirSet` | `{projectId, vaultDir}` | `projects.vault_dir`: the data migration pointed a personal project at `personal/projects/<key>` in the organization vault |
| `ProjectUpdated` | `{projectId, changes: Partial<...>}` | update columns |
| `ProjectConverted` | `{projectId, fromWorkflowKey, toWorkflowKey, cardDecisions[{cardId, decision:'keep'\|'cancel'}], cancelledCardIds[], repoIds[], note?, by}` | `workflow_key`, `converted_at`, `converted_by`, `pending_conversion = NULL` (`started_as` never changes). Appended by `POST /api/projects/:id/convert` (Owner and Admins) in one transaction together with the `ProjectRepoAdded` of the repositories it adds and, for each card decided `cancel`, `ClaimReleased` + `CardCancelled{reason:'Project converted', cause:'project_converted'}` (+ the worktree removal). The gateway reacts after commit: the working-branch question for each of `repoIds` (`reason 'conversion'`) and the `PROJECT.md` research index. The Part B schedule trigger `project_converted` matches this event |
| `ProjectConversionRequested` | `{projectId, conversionId, toWorkflowKey, cardDecisions[], repoRequestIds[], note?, by}` | `projects.pending_conversion` (jsonb). A conversion whose target needs repositories and none exists yet waits for the repository requests (`RepoCreateRequested` by the manager, `requestedByUserId`) to be approved and created; `ProjectConverted` follows in the transaction that records the last answer |
| `ProjectConversionCancelled` | `{projectId, conversionId, by?, reason?}` | `pending_conversion = NULL`. By the Owner (`DELETE /api/projects/:id/convert`, which also declines the pending requests), by archiving the project, or when every request was declined |
| `ProjectRepoAdded` | `{projectId, repoId, name, remoteUrl, remoteUrlNormalized, workingBranch?}` | insert project_repos; runner gateway sends `repos.rescan` to owner/member runners |
| `ProjectRepoRemoved` | `{projectId, repoId}` | removed_at |
| **`ProjectShared`** | `{projectId, userId, invitedBy}` | project_members row status invited |
| `ProjectShareAccepted` | `{projectId, userId}` | status active, joined_at |
| `ProjectShareDeclined` | `{projectId, userId}` | status removed |
| `ProjectMemberRemoved` | `{projectId, userId, inheritedAgentIds[], transferredCardIds[]}` | status removed; agents → manager_user_id = owner, status needs_rehome, workstation_id NULL; cards owner_user_id → owner (claims released via separate ClaimReleased events in same append) |
| `ProjectFullSuiteSet` | `{projectId, enabled, by}` | `projects.full_suite_after_finalize` (default true); project Owner or org Owner/Admin (`PUT /api/projects/:id/full-suite`); `applyFinalizeResult` in `commands/finalize.ts` skips the "Full E2E suite after ..." regression card when off |
| `ProjectMergePolicyChanged` | `{projectId, mergeLargeWithoutApproval, changedBy}` | `projects.merge_large_without_approval/_changed_by/_changed_at`; owner only (`PUT /api/projects/:id/merge-policy`); `mergeGate()` in `commands/finalize.ts` reads it for the manager's Finalize button and the BA's `aom finalize` |
| `ProjectArchived` | `{projectId, archivedBy?}` | status archived. Appended by `POST /api/projects/:id/archive` (any active member) together with, in one transaction: `ClaimReleased(manual)` + `CardCancelled{cause:'project_archived'}` + a system thread message for every open card (the runner gateway turns the release of a cancelled card into `shift.stop`), `ScheduleUpdated{enabled:false, nextFireAt:null}` for every enabled schedule, `DeskItemResolved{dismissed}` for every open desk item of the project, and a `worktree.remove` runner command (branch kept) per distinct worktree of those cards. Agents are not touched: the dispatcher, scheduler, intake mapping and hiring already skip a project whose status is not `active` |
| `ProjectRestored` | `{projectId, restoredBy?}` | status active (`POST /api/projects/:id/restore`, any active member). Cards closed by the archive stay closed, schedules stay disabled; the manager re-enables what they want |
| `ProjectDeleted` | `{projectId, key, name, deletedBy}` | `deleteProjectRows()` removes every row of the project (see "Permanent delete" below). Only for an archived project, only the owner, `POST /api/projects/:id/delete {confirmKey}` where `confirmKey` must equal the project key |

#### Cards (`events/card.ts`) — stream `card-<id>`, audience `project`

| Event | Payload | Projection effect |
| --- | --- | --- |
| `CardCreated` | `{cardId, projectId, number, ref, title, cardType, workflowVersionId, stage, status:'draft'|'queued', fields, ownerUserId, origin, parentCardId?, worktreeCardId?, scheduled, scheduleId?, repoId?, priority, docsNeeded, completionAction?, riskTier?, dependencies: uuid[], requiredCapabilities}` | insert cards (+card_dependencies), increment projects.next_card_number, create card thread (threads row), card_transitions |
| `CardUpdated` | `{cardId, changes: {title?, fields?, priority?, repoId?, docsNeeded?, completionAction?, riskTier?, riskTierOverridden?, dependencies?}}` | update columns |
| `CardAttachmentAdded` / `CardAttachmentRemoved` | `{cardId, attachmentId, name, contentType, size, sha256, source?}` / `{cardId, attachmentId, name}` | insert / delete `card_attachments` (metadata) and a `card_activity` row. The bytes are in `card_attachment_data` (migration 1780): operational, written by the command, never in the event log, kept over a rebuild |
| **`CardSpecified`** | `{cardId, fromStage, toStage}` | status queued, stage = toStage (`build` for code), queued_at; transition |
| `DecisionPolicyChanged` | `{cardId, policy}` | decision_policy |
| **`CardClaimed`** | `{cardId, claimId, agentId, workstationId, shiftId, stage, overflow, worktree: {repoId, baseBranch, branchName, worktreePath, homeWorkstationId, created: boolean}}` | claim columns, status claimed, lease = createdAt + 1h, last_agent_id; original_builder_agent_id set if stage claim role is builder and it is NULL; branch/worktree/home set on first; transition |
| `ClaimReleased` | `{cardId, claimId, agentId, rejection?:{reason, detail, kind?:'branch', repoId?}, reason:'handoff'|'question'|'agent_retired'|'lease_expired'|'runner_rejected'|'runner_lost_shift'|'shift_failed'|'manual'|'workstation_unlinked'|'member_removed', lastHandoffId?}` | clear claim columns; if status was claimed → queued (queued_at = createdAt); transition |
| **`CardRetryDeferred`** | `{cardId, until, failures, episodeId, newEpisode}` | cards.retry_after = until, retry_failures, retry_episode_id (loop breaker, §9.7) |
| **`CardRetryReleased`** | `{cardId, episodeId, releasedBy, reason?}` | cards.retry_after = NULL (the failure count stays) |
| **`HandoffWritten`** | `{cardId, handoffId, shiftId, agentId, stage, outcome, note, data}` | insert card_handoffs; thread_messages kind handoff. Does **not** move the card. |
| **`ReviewRequested`** | `{cardId, fromStage:'build', toStage:'review', riskTier, diffStats:{files, added, removed, architecturalPaths[]}}` | stage review, status queued, risk_tier (unless overridden), review_approvals 0, excluded_agent_ids = {original builder} |
| **`ChangesRequested`** | `{cardId, fromStage:'review', toStage:'build', reviewerAgentId, reasons: ReworkReason[], score:1..5, criteriaMissed: string[], comments}` | stage build, rework_round+1, status queued, excluded_agent_ids '{}', thread message kind review |
| **`ReviewApproved`** | `{cardId, reviewerAgentId, score, comments, approvalsSoFar, approvalsRequired, toStage: 'review'|'test'}` | if toStage review: review_approvals+1, add reviewer to excluded_agent_ids, status queued; else stage test, status queued |
| **`TestPassed`** | `{cardId, testerAgentId, evidence:{commands[], summary, outputExcerpt}, toStage:'docs'|'finalize'}` | stage toStage, queued; test_runs (M4) |
| **`TestFailed`** | `{cardId, testerAgentId, bugCardId, evidence, summary}` | parent status waiting (stage stays test); bug card created by a `CardCreated` in the same append (`origin:'test_failure'`, `cardType:'bug'`, workflow `code-bugfix`, `worktreeCardId: parent`, `parentCardId: parent`, original builder copied) |
| `ChildCardResolved` | `{cardId (parent), childCardId, toStage:'test'}` | parent status queued at test |
| **`RebaseConflict`** | `{cardId, stage, baseBranch, conflictedFiles[]}` | stage build, rework_round+1, queued |
| `StageCompleted` | `{cardId, fromStage, toStage, outcome}` | generic move for custom/research/feed workflows and docs stage |
| `CardMovedByManager` | `{cardId, fromStage, toStage, status, reason}` | manual override (manager) |
| `CardReopened` | `{cardId, fromStage, fromStatus, toStage, status, reason, by}` | a done or cancelled card goes back to an agent or manual stage (`POST /api/cards/:id/reopen`); branch, worktree and the finalize result stay |
| `FinalizeRequested` | `{cardId, action, requestedBy, withoutApproval?}` (`withoutApproval`: a large merge that skipped the desk because the project setting allows it; adds a `merge_policy` row to the card timeline) | (M4) status `waiting`; runner command `finalize.execute` queued to the card's home workstation; its `command.result` produces `CardFinalized` (or a desk escalation on failure) |
| **`CardFinalized`** | `{cardId, action, resultRef: {mergeCommit?, prUrl?, pushedBranch?}, toStage:'done'}` | stage done, status done, finalized_at; queues `worktree.remove` runner command; dependents become claimable |
| `CardCancelled` | `{cardId, reason}` | status cancelled; claim released first |
| `ThreadMessagePosted` | `{threadId, messageId, cardId?, authorKind, authorUserId?, authorAgentId?, kind, body, data}` | thread_messages |

`ReworkReason = 'missed_requirement' | 'broke_convention' | 'weak_tests' | 'poor_structure' | 'spec_unclear' | 'out_of_scope_test_change'`.

#### Shifts and agents (`events/shift.ts`, `events/agent.ts`) — audience `project` when the shift has a card, else `org`

| Event | Payload | Projection effect |
| --- | --- | --- |
| `ShiftStarted` | `{shiftId, agentId, workstationId, cardId?, kind, stage?, runtime, model, overflow, runtimeSessionId?}` | shifts status running |
| `ShiftSessionRecorded` | `{shiftId, runtimeSessionId?, contextTokens?, resumeState?}` | shifts.runtime_session_id, context_tokens, resume_state |
| **`ShiftEnded`** | `{shiftId, agentId, cardId?, outcome, reportOutcome?, durationMs, usage, exitCode?, guardViolations[]}` | shifts ended, tokens, duration; agents.last_shift_ended_at |
| **`AgentHired`** | `{agentId, orgId, projectId?, hiredByUserId, workstationId, name, roleKey, roleVersion, seniority, runtime, model, effort?, skills, permissions, capacity, isDevops}` | insert agents |
| `AgentChanged` | `{agentId, changes:{model?, effort?, runtime?, roleKey?, roleVersion?, seniority?, skills?, permissions?, capacity?}}` | update |
| **`AgentRetired`** | `{agentId, by, releasedCardIds[]}` | status retired, retired_at; ClaimReleased events in the same append; `agent.wipe` runner command queued |
| `AgentReset` | `{agentId}` (DevOps only) | no column change; `agent.wipe` queued |
| `AgentPermissionsRebased` | `{agentId, roleKey, fromRoleVersion, toRoleVersion, previous, permissions}` | agents: `role_version`, `permissions`. Agents follow the current version of their role: `permissions` = the new version's permissions + the agent's own deviations from the version it was derived from (`rebasePermissions`, `roles/follow.ts`). Appended by `rebaseAgentsToCurrentRoles` at boot after `registerBuiltins` and when an org role version is approved; values any earlier version carried are not deviations |
| `AgentRehomed` | `{agentId, workstationId, runtime, model}` | workstation, status active; old sandbox treated as wiped |

#### Decision desk and ledger (`events/desk.ts`, `events/ledger.ts`) — M2

| Event | Payload | Projection effect |
| --- | --- | --- |
| **`QuestionRaised`** | `{deskItemId, cardId?, projectId?, askedBy:{kind, agentId?, role?}, doing, question, options[], recommendation?, blocking, routedTo:'manager'|'agent', routedAgentId?, dedupLedgerIds[]}` | desk_items (kind question); if blocking and cardId: card status blocked, blocked_since, card_blockers; ClaimReleased in same append (reason question) |
| `QuestionEscalated` | `{deskItemId, fromAgentId?, routedTo, routedAgentId?, note}` | desk_items.routed_to |
| **`QuestionAnswered`** | `{deskItemId, answer, answerOption?, answeredBy:{kind, userId?, agentId?}, ledgerEntryId, unblockedCardIds[]}` | desk_items answered; for each unblocked card with no remaining blockers: status queued; ledger_entries insert (in the same append via LedgerEntryAdded); runner command `vault.write` decision file |
| `DeskItemCreated` | `{deskItemId, kind, subkind, title, body, options, recommendation, blocking, pinned, cardId?, affectedCardIds[]}` | generic approvals/alerts/escalations |
| `DeskItemResolved` | `{deskItemId, resolution:'approved'|'rejected'|'acknowledged'|'dismissed', note?, by}` | status answered/dismissed |
| `LedgerEntryAdded` | `{entryId, scope, projectId?, cardId?, title, body, tags[], sourceDeskItemId?, vaultPath?}` | ledger_entries; `vault.write` command when vaultPath |
| `LedgerEntrySuperseded` | `{entryId, supersededBy}` | superseded_by |

#### Testing (`events/testing.ts`) — M4

| Event | Payload | Projection effect |
| --- | --- | --- |
| **`FullSuiteStarted`** | `{cardId, branch, testerAgentId?, suiteCardId}` | a `regression`-type card (origin full_suite) is created in the same append and queued at `test` for testers, scheduled=true |
| `FullSuitePassed` | `{suiteCardId, evidence}` | suite card done |
| **`FullSuiteFailed`** | `{suiteCardId, evidence, testSideFixed: boolean}` | suite card stays/returns to test for triage; desk notice |
| **`BugReported`** | `{suiteCardId?, regressionCardId?, title, description, evidence, bugCardId}` | CardCreated (bug, spec stage for BA) in same append; desk `alert` (notice, non-blocking) |
| **`RegressionRequested`** | `{projectId, platform:'web'|'mobile'|'both', requestedBy, regressionCardId}` | regression card(s) queued at test |
| **`TesterBottleneck`** | `{projectId, waitingCardIds[], busyTesterIds[], recommendation:{hire:'tester', count:1}}` | desk alert pinned; de-duplicated (one open per project) |

#### Scheduling, feeds and research (`events/schedule.ts`, `events/feed.ts`, `events/research.ts`) — M5/M6

| Event | Payload | Projection effect |
| --- | --- | --- |
| `ScheduleCreated` / `ScheduleUpdated` / `ScheduleDeleted` | `{scheduleId, projectId: Id\|null, name, kind, cron\|null, timezone\|null, trigger?, action?, ownerUserId?, cardTemplate?, enabled, nextFireAt}`; `ScheduleCreated` also takes an optional `interestId`. Without `trigger`/`action` (events before Part B) they are derived from `cron`, `kind` and `cardTemplate` | schedules (`ScheduleUpdated` never touches `interest_id`, so old and new events replay the same) |
| `ScheduleLinked` | `{scheduleId, interestId: Id \| null}` | (replay only) sets `schedules.interest_id`; linking back-fills `cards.interest_id` of the schedule's earlier cards |
| `InterestCreated` / `InterestUpdated` | `InterestBody` = `{interestId, orgId, name, description, subCategory, preferredSites, kinds, scan, delivery, agents, status, creatorRank?, projectId?, slug?, nextScanAt?, nextDeliveryAt?}` plus the optional first-model fields `feedProjectId, researchProjectId, scheduleId, adoptedFrom` (full snapshot, stream `interest-<id>`, scope = the backing project, so visibility follows its members) | upsert `interests` (a body without `projectId` fills the `legacy_*` columns) |
| `InterestArchived` / `InterestRestored` | `{interestId, by}` | `archived_at`; appended with `ProjectArchived` / `ProjectRestored` of the backing project (which cancels the open run cards) |
| `InterestDeleted` | `{interestId}` | delete the row, its runs and deliveries (appended with a permanent `ProjectDeleted` of the backing project) |
| `InterestTasteSet` | `{interestId, version, rules: string[]}` | `taste_rules`, `taste_version`; the taste hook mirrors it as the managed `seed` section of `<folder>/taste.md` |
| `InterestRunStarted` | `{runId, interestId, kind, trigger, cardId, parentRunId?, startedBy?, nextScanAt?}` (always with the `CardCreated{interestRunId, origin 'interest'}` of its card) | insert `interest_runs` (`queued`), `interests.next_scan_at`, `fail_count 0` |
| `InterestRunFailed` | `{interestId, kind, attempts, error, nextScanAt, counted, deskItemId?}` | back-off (`scheduleBackoffMs`); `counted false` is a skipped fire (the previous run is still active, the organization is suspended, the feature is off) |
| `InterestRunDone` | `{runId, interestId, cardId, kind, status ('published','nothing'), found?, published, duplicatesDropped, overMaximumDropped, itemIds}` | the run's result and `finished_at`; the **event the `interest_run_done` schedule trigger listens to** (one mapping table, `SCHEDULE_EVENT_TRIGGERS`) |
| `InterestDigestDelivered` | `{deliveryId, interestId, itemIds, deskItemId?, heldBack, trigger, nextDeliveryAt}` | `digest_items.delivered_at` and `desk_item_id`, an `interest_deliveries` row, `next_delivery_at`; appended with the rating desk item. With no items it only moves the next delivery |
| `InterestMigrated` | `{interestId, projectId, slug, fromFeedProjectId?, fromScheduleId?, cardFilter {projectId, scheduleId?, untaggedFeedCards}, copySeenFrom?}` | the data migration: sets the backing project, back-fills `cards.interest_id`, derives `cards.interest_run_id` and the migrated run log from those cards (deterministic ids), copies the seen-list |
| `ProjectKindChanged` | `{projectId, kind, interestId, vaultDir?}` | the data migration: a feed project becomes an interest's backing project |
| `TasteSeedSet` | `{projectId, version, rules: [{text, interestId\|null}]}` (stream `project-<id>`) | upsert `taste_seeds`; the taste hook mirrors it to `taste.md` as a managed section (16.4) |
| **`ScheduleFired`** | `{scheduleId, cardId?, runId?, firedFor: ISO time, nextFireAt}` | last_fired_at, next_fire_at, last_card_id; appended with the action's events and `ScheduleRunRecorded` (for a card action `CardCreated{scheduled:true, origin:'schedule', status:'queued'}`) |
| `ScheduleRunRecorded` | `{runId, scheduleId, trigger: cron\|manual\|event\|issue\|test, sourceKey?, label?, status: ok\|failed\|pending, summary, result?, error?, delivery?, nextAttemptAt?}` | `schedule_runs` row (unique `(schedule_id, source_key)`), `schedules.last_status/last_summary`, seen issues |
| `ScheduleDeliveryAttempted` | `{runId, scheduleId, attempt, ok, httpStatus?, error?, durationMs?, status, nextAttemptAt?}` | `schedule_attempts` row (the delivery log), the run's attempts, status and next try |
| `ScheduleRunCompleted` | `{runId, scheduleId, status, summary, result?, error?}` | the run's outcome learned later (an issue poll answered); `schedule_issues` |
| `FeedRunRequested` | `{projectId, scheduleId?, cardId, requestedBy}` | (replay only) the old "run now" |
| `ScheduleFireFailed` | `{scheduleId, error, attempts, nextFireAt, deskItemId?}` | M9: a due schedule could not emit its card; `next_fire_at` moves to the retry time (1 min doubling to 6 h), `fail_count`/`last_error` set; the first failure of a streak also raises one desk alert (`schedule_failed`), resolved by the next `ScheduleFired` |
| `RecommendationApplied` | `{orgId, recommendationId, kind, agentId?, appliedBy, effect, deskItemId?}` | M9: one-click HR recommendation applied (the change is its own event in the same append: `AgentChanged`, `AgentHired`, `AgentRetired` or a `DeskItemCreated` approval `standing_order`); `hr_applied` hides it for the window |
| **`DigestPosted`** | `{cardId, projectId, items:[{itemId, kind, url, urlNormalized, title, source, publishedAt, summary}], nothingQualified: boolean, held}` | digest_items (`delivered_at` NULL when `held`), feed_seen; an interest's cards post `held` and the delivery (`InterestDigestDelivered` + the grouped rating desk item) follows in the same append when it delivers immediately |
| **`ItemRated`** | `{itemId, verdict, reason?, ratedBy}` | digest_items verdict; `vault.write` append to taste.md |
| `TasteRuleProposed` | `{projectId, deskItemId, rule, evidenceItemIds[]}` | desk approval item |
| **`ResearchPublished`** | `{cardId, projectId, vaultPath, title, citations:[{url,title,accessedAt}]}` | research_publications. The note itself is written by the checker's runner into its local vault clone and pushed by vault sync (§16.3); the event carries only the path and citations |

#### Intake and outbound (`events/intake.ts`, `events/outbound.ts`) — M7/M8

| Event | Payload | Projection effect |
| --- | --- | --- |
| **`IntakeStarted`** | `{intakeId, threadId, externalSystem, externalKey?, startedBy, baAgentId}` | intakes; chat shift for BA |
| **`TicketMapped`** | `{intakeId, projectId?, cardId?, unmapped: boolean, deskItemId?}` | intakes mapped; unmapped → QuestionRaised |
| **`OutboundDrafted`** | `{draftId, cardId, externalSystem, externalKey, kind, body, deskItemId}` | outbound_drafts pending + desk approval |
| **`OutboundApproved`** | `{draftId, finalBody, approvedBy}` | approved; runner command `outbound.post` queued to a workstation of the card owner (external credentials live only there, §16.5) |
| `OutboundRejected` | `{draftId, by, reason?}` | rejected |
| `OutboundPosted` / `OutboundPostFailed` | `{draftId, externalRef?, error?}` | posted/failed |

#### DevOps and vaults (`events/devops.ts`, `events/vault.ts`) — M3

| Event | Payload | Projection effect |
| --- | --- | --- |
| **`DevOpsRequested`** | `{requestId, workstationId, devopsAgentId, threadId, requestedBy:{kind,id}, cardId?, summary}` | devops_requests queued; thread |
| **`EnvironmentChanged`** | `{requestId?, workstationId, summary, commands[]}` | environment_changes; thread message |
| **`DevOpsApprovalNeeded`** | `{requestId, deskItemId, action, reason, commands[]}` | request needs_approval; desk approval |
| `DevOpsRequestCompleted` | `{requestId, status:'done'|'failed', summary}` | status |
| `VaultRegistered` / `VaultUpdated` | `{vaultId, orgId, projectId?, kind, name, remoteUrl, syncIntervalSec}` (`kind` `org` or `project`; old events say `work`, projected as `org`, or `personal`) | vaults; `vault.configure` command to the org's runners |
| `VaultMerged` | `{vaultId, orgId, intoVaultId \| null, folder}` | `no-personal-2026-10`: the personal vault was merged into the organization vault (the row and its workstation rows go; `vault.merge` copied the files) or, with `intoVaultId` null, became the organization vault (`kind 'org'`) |
| `VaultSyncConflict` | `{vaultId, workstationId, files[], deskItemId}` | desk escalation |

#### Catalogue (`events/catalogue.ts`) — M1 built-ins, M10 custom

| Event | Payload | Projection effect |
| --- | --- | --- |
| `WorkflowVersionRegistered` | `{workflowVersionId, orgId|null, key, version, name, department?, definition, status, projectId?, variantSpec?}` | workflow_versions + workflow_stages (built-ins registered at boot if missing); `projectId` + `variantSpec` mark a project variant (insertions on a base, `definition.extends`) |
| `ProjectWorkflowsSet` | `{projectId, enabled: [{workflowKey, defaultCardTypes}], by}` | project_workflows (the project's enabled workflows; the primary row follows `ProjectCreated` / `ProjectConverted`) |
| `WorkflowVersionApproved` / `WorkflowVersionRejected` | `{workflowVersionId}` | status active (previous active → superseded) |
| `RoleVersionRegistered` / `RoleVersionApproved` / `RoleVersionRejected` | analogous for roles | role_definitions |
| `RoleExtended` | `{orgId, roleKey, baseVersion, extensions}` | role_extensions |
| `RoleResetToDefault` | `{orgId, roleKey, toVersion, droppedExtensions}` | delete role_extensions row |
| `DepartmentCreated` | `{departmentId, orgId, name}` | departments |
| `WorkflowDraftUpdated` / `RoleDraftUpdated` | `{workflowVersionId, name, department?, definition}` / `{roleVersionId, definition}` | M10: edits an open draft (status `draft` only) |
| `WorkflowVersionSubmitted` / `RoleVersionSubmitted` | `{…VersionId, deskItemId}` | M10: status `pending_approval`; the desk approval (`kind approval`, subkind `definition`) is raised in the same append |
| `DefinitionDraftDiscarded` | `{kind:'role'|'workflow', versionId}` | M10: deletes a draft or rejected version; approved and superseded versions are never removed |

#### Phases (`events/phase.ts`) — audience `project`; streams `phase-<id>`, `ba-task-<id>`, `project-<id>`, `card-<id>`

A phase groups cards of one project; when every confirmed member card's work is in the working branch the BA reports to the manager, who approves the follow-ups (deploy, regression run, custom instruction) that the server then runs in order. Any active project member may do everything (owner decision A1).

| Event | Payload | Projection effect |
| --- | --- | --- |
| `PhaseCreated` | `{phaseId, projectId, number, ref, name, description, status:'proposed'\|'open', createdBy, intakeId?, workingBranch?, followups[]}` | insert `phases` + `phase_followups` (pending) + the phase thread; `projects.next_phase_number` |
| `PhaseUpdated`, `PhaseFollowupsSet` | `{phaseId, changes}` / `{phaseId, followups[]}` | edit; the follow-up list is replaced (ids kept) |
| `CardPhaseChanged` (card stream) | `{cardId, phaseId\|null, previousPhaseId?, assignment, by, cause?}` | `cards.phase_id/phase_assignment`, timeline entry. `cause 'bug_filed'`: a bug card filed after finalize joined the phase it came from |
| `CardMergeVerified` (card stream) | `{cardId, workingBranch, branchName?, branchDeleted, remoteBranchDeleted, manual}` | `cards.merged_into_working_at`; the runner checked it with git (`branch.check_merged`) or a member confirmed it by hand. A `CardFinalized` with action `merge` sets the same column |
| `PhaseProposalSubmitted`, `PhaseConfirmed`, `PhaseProposalRejected` | `{phaseId, deskItemId, proposedCardIds…}` | the BA's proposal and the manager's answer: status `open` and the listed cards `confirmed`, or `discarded` and the assignments cleared |
| `PhaseCompleted` | `{phaseId, cardOutcomes[], baTaskId}` | status `reporting`; the `phase_report` BA task is queued in the same append |
| `PhaseReportPosted` | `{phaseId, deskItemId, report, outstanding[], by}` | status `awaiting_approval` (desk item `phase_done`: an approval of N follow-ups, or an alert when there are none) |
| `PhaseReopened` | `{phaseId, by, reason}` | back to `open` (allowed before approval only); the desk item is dismissed |
| `PhaseFollowupsApproved` / `PhaseFollowupsRejected` | `{phaseId, by, followups[] (the approved snapshot), baTaskId?}` | `running_followups` (follow-ups `queued`, a `followups_brief` task queued) / `followups_rejected` (follow-ups cancelled) |
| `PhaseFollowupBriefed` | `{phaseId, followupId, delegate, brief, by}` | follow-up `briefed` |
| `PhaseFollowupStarted` | `{phaseId, followupId, delegate, devopsRequestIds[], regressionCardIds[], baTaskId?}` | `running`; a local deploy has one DevOps request per workstation |
| `PhaseFollowupFinished` | `{phaseId, followupId, status, summary, evidence}` | `succeeded`, `failed`, `skipped` or `cancelled` |
| `PhaseFollowupsFinished`, `PhaseResultsReported` | `{phaseId, status, baTaskId?}` / `{phaseId, deskItemId, report, finalStatus, by}` | `reporting_results`, then `done` or `done_with_failures` (desk notice `phase_results`, pinned when something failed) |
| `PhaseCancelled` | `{phaseId, reason}` | the project was archived: status `cancelled`, pending follow-ups cancelled |
| `ProjectFollowupDefaultsSet`, `DeployTargetAdded/Updated/Removed` | on the project stream | `projects.default_followups`, `deploy_targets` |
| `BaTaskQueued`, `BaTaskDispatched`, `BaTaskRequeued{attempt}`, `BaTaskCompleted{status}` | `{taskId, phaseId, kind…}` | `ba_tasks`; `BaTaskDispatched` also creates the `ba_task` shift row |

`CardCreated` gained `homeWorkstationId?` (a regression card of a follow-up runs where the local stack was deployed) and `phaseFollowupId?`; card fields gained `targetUrl` and `deployTarget`.

#### BA reporter (retired; `events/reporter.ts`, plus `UserTimezoneChanged` in `events/user.ts`) — Part B of `docs/design/phases.md`

Retired in step 3 of `docs/design/ceo-front-door.md` (section 9.9): nothing appends the reporter's task, triage, note or report events any more, but **every projector stays** so old streams replay (`reporter-replay.test.ts`). `DeskItemCreated.triage` is now written by the CEO routing (`ceo/routing.ts`).

Streams `user-<id>`, `desk-<id>`, `ba-signal-<id>`, `ba-task-<id>`; audience `org` (preferences, floor report) or `project`. The routing decision is always recorded in the event (`DeskItemCreated.triage`), never recomputed from settings on replay.

| Event | Payload | Projection effect |
| --- | --- | --- |
| `UserTimezoneChanged` | `{userId, timezone}` (IANA, validated) | `users.timezone` |
| `ReportingPrefsChanged` | `{userId, routeViaBa?, dailyAt?, interestDigestCap?}` | merged into `users.reporting` (absent keys = defaults: `08:00`; `routeViaBa` is legacy, nothing routes by it) |
| `BaChatLinked` | `{userId, threadId}` | `users.ba_chat_thread_id`: the standing "BA reports" chat of the organization owner |
| `DeskItemCreated` (extended) | `…, triage?:{deadline}, data?, chatThreadId?` | `triage 'pending'` + `triage_deadline` (held: hidden from the desk list), `data` (the floor digest), `chat_thread_id` |
| `DeskItemTriaged` | `{deskItemId, outcome:'passed'\|'released'\|'dismissed'\|'merged', note?, intoDeskItemId?, by}` | `triage`, `ba_note`; `dismissed` → status `dismissed`, `merged` → status `superseded` + `superseded_by` |
| `DeskItemAnnotated` | `{deskItemId, note, by, relatedDeskItemIds[], signalId?}` | `desk_items.ba_note` |
| `BaSignalRaised` / `BaSignalUpdated` / `BaSignalReported` / `BaSignalResolved` | `{signalId, kind, fingerprint, urgency, subject, evidence, count}` … | `ba_signals`: one open row per `(org, fingerprint)` |
| `BaTaskQueued` (extended), `BaTaskItemsAdded` | `…, signalIds?, deskItemIds?, localDate?` / `{taskId, deskItemIds?, signalIds?}` | `ba_tasks.signal_ids / desk_item_ids / local_date`; a `floor_report` also sets `users.floor_report_day` |
| `WorkstationHygieneChanged` | `{workstationId, intervalHours (0,1,6,12,24,168), changedBy}` | `workstations.hygiene_interval_hours` |
| `DevOpsRequested` (extended) | `…, hygiene?: HygieneSpec` | `devops_requests.hygiene` (the repositories the run covers); sets `workstations.hygiene_last_at` |
| `ProjectRepoWorkingBranchSet` | `{projectId, repoId, workingBranch, previousBranch, reason:'unconfirmed'\|'phase'\|'intake'\|'manual', setBy, deskItemId?}` | `project_repos.working_branch / working_branch_set_by / working_branch_set_at` |
| `HygieneRepoReported` | `{requestId, workstationId, repos:[{repoId, projectId, name, problem:{kind, detail}\|null, files[], branches[]}]}` | `hygiene_findings` (one open row per workstation, repository and kind; other kinds of the repository close; a repository in order closes all; `needs_branch` is a question, not a finding), `project_repos.known_branches` |
| `WorktreeSweepReported` | `{workstationId, requestId?, removed, kept, dirty:[{path, branch, files[]}]}` | `hygiene_findings` kind `dirty_worktree` (those no longer reported close) |
| `QuestionRaised` (extended) | `…, triage?:{deadline}, data?` | `desk_items.triage / triage_deadline / data` (the working-branch question carries `{repoId, reason, current?, phaseId?}`) |

#### Claude accounts (`events/project.ts`, `card.ts`, `intake.ts`, `phase.ts`, `workstation.ts`; design: `docs/design/claude-accounts.md`)

| Event | Payload | Projection effect |
| --- | --- | --- |
| `ProjectClaudeAccountSet` | `{projectId, accountKey: string \| null, fallbackToMain: boolean, changedBy}` (`accountKey` null = each workstation's main account) | `projects.claude_account_key`, `projects.claude_account_fallback` (migration `2250_claude_accounts.sql`). Project Owner or org Owner/Admin (`setClaudeAccount`, `PUT /api/projects/:id/claude-account`). Appends nothing when the value is unchanged; always queues `claude.account.ensure` (§11.2) for the key on eligible workstations, so setting the same key again asks again |

Optional fields added to existing events. An absent field means **main**, so old events replay unchanged:

| Event | Added field | Projection effect |
| --- | --- | --- |
| `CardClaimed` | `accountKey?` (omitted for main) | `shifts.account_key` |
| `QuestionShiftDispatched` | `accountKey?` (non-main only; a question with a `card_id`) | `shifts.account_key` |
| `BaTaskDispatched` | `accountKey?` (non-main only; a task with a `card_id`) | `shifts.account_key` |
| `WorkstationRuntimesChanged` | `runtimes[].accounts?: {key, login, usage, limitedUntil?}[]` | operational live view only (no projection) |

`shifts.account_key` (NULL = main) and `workstations.claude_account_ensure` (the last `claude.account.ensure` answer per key, operational) are the only new columns. How the account is chosen: §9.12.

---

## 6. Workflows as data and the card lifecycle

### 6.1 Definition schema (`packages/shared/src/workflows/schema.ts`)

```ts
export const OutcomeSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),       // 'handoff' | 'approve' | 'changes' | 'pass' | 'fail' | 'done' | ...
  label: z.string(),
  kind: z.enum(['success', 'failure']),
  to: z.string(),                                   // target stage id (may equal current stage for 'waiting' effects)
  event: z.enum(['ReviewRequested','ReviewApproved','ChangesRequested','TestPassed','TestFailed',
                 'StageCompleted','CardFinalized','ResearchPublished','DigestPosted']),
  data: z.enum(['none','diffStats','review','testEvidence','publication','candidates','digest','finalize']).default('none'),
  rework: z.boolean().default(false),               // increments rework_round, routes to original builder first
  effect: z.enum(['none','spawn_bug_child','resume_parent','finalize']).default('none'),
});
export const StageSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string(),
  column: z.string(),                               // board column label
  kind: z.enum(['agent', 'manual', 'terminal']),    // manual = moved by a user/BA command, never dispatched
  claimRole: z.string().nullable(),                 // required for kind 'agent'
  seniorOnly: z.boolean().default(false),
  requiredFields: z.array(z.string()).default([]),  // card field keys that must be filled to ENTER the stage
  doneCriteria: z.string(),                         // rendered into the shift prompt
  outcomes: z.array(OutcomeSchema).default([]),
  when: z.object({ field: z.string(), equals: z.unknown() }).optional(), // stage skipped when false
  worktree: z.enum(['create', 'reuse', 'none']).default('none'),
  rebaseBefore: z.boolean().default(false),
  approvals: z.object({ small: z.number().int().min(1), large: z.number().int().min(1) }).optional(),
  maxShiftMinutes: z.number().int().min(5).max(480).default(60),
  requiredCapabilities: z.array(z.string()).default([]),
});
export const WorkflowDefinitionSchema = z.object({
  key: z.string(), version: z.number().int().min(1), name: z.string(),
  department: z.string().optional(), builtIn: z.boolean(),
  fieldSet: z.string(),                             // 'code' | 'research' | 'feed' | custom field-set id
  customFields: z.array(z.object({ key: z.string(), label: z.string(), type: z.enum(['text','markdown','list','number','boolean','url-list']), required: z.boolean() })).default([]),
  cardTypes: z.array(z.string()),
  initialStage: z.string(),
  stages: z.array(StageSchema).min(2),
});
```

Resolution of a move: `resolveOutcome(def, card, stageId, outcomeId) → { event, toStage }` in `workflows/resolve.ts`. If `toStage` has a `when` that evaluates false against the card, follow that stage's first `success` outcome's `to` recursively. Pure function, unit tested, used by server only; its result is written into the event payload.

### 6.2 Built-in workflows (`packages/shared/src/workflows/builtin/*.ts`, version 1)

**code v1** (field set `code`)

| Stage | Kind / role | Enter requires | Outcomes (`id` → to, event) | Other |
| --- | --- | --- | --- | --- |
| `spec` | manual (BA in intake or manager) | title, cardType | `specified` → build (`CardSpecified`) | card status `draft` |
| `build` | agent / builder | title, cardType, context, requirements, acceptanceCriteria (≥1), affectedAreas, constraints, testPlan, completionAction, repoId | `handoff` → review (`ReviewRequested`, data diffStats) | worktree create/reuse; done criteria: builds, all unit tests pass, unit tests written for the change, work committed |
| `review` | agent / reviewer, seniorOnly | — | `approve` → test (`ReviewApproved`, data review); `changes` → build (`ChangesRequested`, failure, rework) | approvals small 1 / large 2 (distinct reviewers); worktree reuse |
| `test` | agent / tester | — | `pass` → docs (`TestPassed`, testEvidence); `fail` → test (`TestFailed`, failure, effect spawn_bug_child) | rebaseBefore; worktree reuse; requiredCapabilities `['shell']` |
| `docs` | agent / writer | — | `done` → finalize (`StageCompleted`) | `when: { field: 'docsNeeded', equals: true }` |
| `finalize` | agent / ba, seniorOnly | — | `finalized` → done (`CardFinalized`, data finalize, effect finalize) | rebaseBefore; manager may trigger finalize from the UI if the org has no BA |
| `done` | terminal | — | — | worktree removed |

**code v2** (adds the optional `investigate` stage; v1 stays registered and cards in flight finish on it; docs/design/architect-and-workflows.md): `spec` → `investigate` (agent / architect, seniorOnly, `when designNeeded`, worktree create, `syncMainBefore`, maxShiftMinutes 90; requires title, cardType, context, requirements, repoId) with two **guarded outcomes** (`Outcome.when`): `handoff` → build (`StageCompleted`, data `investigation`, `when investigationOnly=false`) and `report` → finalize (`when investigationOnly=true`); `build` also creates the worktree when investigate is skipped and has `syncMainBefore`. `designNeeded` (card column, default from `projects.design_step`, which is **false** for every project) and `investigationOnly` (implies `designNeeded`) are card columns; `resolveOutcome` skips the inactive investigate stage (`specifyTarget` uses it, so a card without the design step goes from Spec to Build) and refuses an outcome whose guard does not apply (`outcome_not_allowed`); the brief lists only the allowed outcomes. At specify the card needs `requiredForSpecify`: the required fields of every stage on its success path (an investigation-only card: title, cardType, context, requirements, repoId). Outcome transitions into an agent stage also check `requiredMissing`. The architect's outcome data is `InvestigationData {reportPath, summary, location repo|vault, commit?}` and appends `InvestigationReported`; the BA's Finalize of an investigation-only card needs `aom investigation record` first (ledger entry tagged `investigation` and the `investigations` managed section of `PROJECT.md`) and may use `--action none` (`FinalizeAction`, event `CardFinalized.action`) for a vault report. Project settings `design_step`, `merge_main_first`, `investigation_path`, `investigation_location` (event `ProjectArchitectSettingsSet`, migration `1670_architect.sql`).

**code-bugfix v1** (internal; used only for bug children created by `TestFailed`): `build` (builder, worktree reuse of `worktree_card_id`) → `review` (`approve` → done with effect `resume_parent` emitting `ChildCardResolved` on the parent; `changes` → build rework) → `done`.

**research v1** (field set `research`: question, scope, depth `quick|standard|deep`, subCategory, preferredSites[], maxPerKind): `question` (manual) → `research` (researcher, `handoff` → factcheck) → `factcheck` (checker; `published` → done via `ResearchPublished`, data publication; `unsupported` → research, failure, rework) → `done`.

**feed v1** (field set `feed`: topic, description (markdown), windowHours default 24, preferredSites[], maxItems default 10; a legacy `maxPerKind` is converted on read to the sum of its values; item kinds `article|video|podcast`, videos and podcasts carry `transcript {status, path?, chars?, autoGenerated?}`; the transcript text is stored in the vault by the runner and in the server table `transcripts`, written by the `transcript.store` rpc, not a projection): `scan` (scout; `handoff` → curate, data candidates) → `curate` (curator; `digest` → done via `DigestPosted`, data digest) → `done`. Feed cards are created directly in `scan` with status queued.

Built-ins are upserted at server boot: for each built-in `(key, version)` missing from `workflow_versions` append `WorkflowVersionRegistered` with `status:'active'`. Changing a built-in means adding a new version file; old versions stay because cards are pinned to them.

### 6.3 Card fields (`packages/shared/src/cards/fields.ts`)

`CodeFields = { context: md, requirements: md, acceptanceCriteria: string[], affectedAreas: md, constraints: md, linkedLedgerIds: uuid[], testPlan: md, externalRef?: string, mock?: MockScript }`. Lifecycle-relevant fields (`repoId`, `completionAction`, `riskTier`, `docsNeeded`, dependencies, decision policy) are real columns; everything else lives in `cards.fields` and is validated by the field-set schema on `CardCreated`/`CardUpdated`. "Filled" means non-empty string / non-empty array / non-null. `requiredMissing(card, stage)` in shared returns the missing keys (used by API validation and the UI).

### 6.4 Lifecycle state machine

`cards.stage` is the workflow position; `cards.status` is the queue state:

```
draft ──CardSpecified──► queued ──CardClaimed──► claimed ──(outcome event + ClaimReleased)──► queued (next stage)
                           ▲                        │
                           │                        ├─QuestionRaised(blocking)──► blocked ──QuestionAnswered──► queued
                           └──ClaimReleased─────────┘ (lease expiry, rejection, retire, manual)
claimed ──TestFailed──► waiting (parent) ──ChildCardResolved──► queued (test)
* ──CardFinalized──► done        * ──CardCancelled──► cancelled
```

Invariants (asserted in projector tests):

- `status = 'claimed'` ⇔ `claim_id IS NOT NULL`.
- Outcome events are only accepted from the shift holding the current claim (`claim_shift_id`) and only if the outcome id exists on the current stage of the card's pinned workflow version.
- Every outcome append is `[HandoffWritten, <outcome event>, ClaimReleased(reason handoff), ShiftEnded?]` in one transaction.
- Blocking questions release the claim; the card is re-queued in the same stage once all blockers are answered. The original agent gets no reservation (builder priority rule 1 routes rework anyway).

### 6.5 Board columns (`packages/shared/src/cards/columns.ts`)

`columnFor(card, stage)`: `draft` → **Spec**; `blocked` → **Blocked**; `waiting` → **Test (waiting on bug)**; stage `build` & `claimed` → **In progress**; stage `build` & queued & `is_rework_or_bug` → **Rework**; stage `build` & queued → **To do**; otherwise `stage.column`. Code board order: Spec, To do, Rework, In progress, Blocked, Review, Test, Docs, Finalize, Done.

### 6.5.1 Cards of other workflows on a board (restructure Part C)

A card carries the `workflow_version_id` it was created with, so a project's board may hold cards of several workflows: research cards created in a code project (`resolveCardWorkflow` in `commands/cards.ts`: the project's workflow when it lists the card type, else `CROSS_PROJECT_CARD_TYPES = {research: 'research'}`, else 400 `invalid_card_type`; also used by scheduled cards and the schedule template check) and cards kept through a conversion. `GET /api/board` adds the columns of those other workflows to the project's own with `boardColumnsWith(def, others)`: before the terminal column, de-duplicated by label, and only while a card of that workflow is open; each such card has `workflowKey` set (the web shows a chip). A card of a workflow that does not use repositories never takes a `repo_id`.

### 6.6 Validation of custom workflows (`packages/shared/src/workflows/validate.ts`)

`validateWorkflow(def, roleCatalogue): ValidationIssue[]`, run on draft save and again before approval. Errors:

1. Schema parses; stage ids unique; outcome ids unique per stage; `initialStage` exists.
2. At least one `terminal` stage; terminal stages have no outcomes; non-terminal stages have ≥1 outcome and ≥1 `success` outcome.
3. Every `agent` stage has `claimRole` naming an active role in the catalogue whose `claimableStages` includes `(def.key, stage.id)` or `(def.key, '*')` or `('*','*')`; `seniorOnly` stages need a role with a senior level.
4. Every outcome `to` names an existing stage.
5. Reachability: every stage is reachable from `initialStage` (BFS over outcome edges plus `when`-skip edges). No unreachable stage.
6. Termination: from every stage, some terminal stage is reachable; additionally, every `failure` outcome's target can reach a terminal (so every failure path ends somewhere). Cycles are allowed (rework loops) only because of rule 6.
7. `requiredFields` reference built-in field keys of the field set or `customFields`.
8. `effect` constraints: `spawn_bug_child` only on outcomes whose `to` is the same stage; `finalize` only on outcomes targeting a terminal stage; `resume_parent` only in workflows with `cardTypes` containing `bug`.
9. `when.field` must be a boolean field.
10. Sub-workflow stages (`kind: 'subworkflow'`, `Stage.subworkflow`). Target-independent (in `validateWorkflow`): the block exists exactly on `subworkflow` stages, no `claimRole`, each child field is mapped once, mapped parent fields exist, `fieldsOut` only in wait mode, a wait stage with `onFailure: 'fail'` has a `failure` outcome. Target-dependent (`validateSubworkflowTargets`, run when the caller supplies `subworkflowLookup`): the target exists, has an approved version, is enabled in the named project of the same organisation, runs the card type, mapped child fields exist with compatible kinds, no cycle through other workflows' sub-workflow stages (a workflow never starts itself), nesting depth at most `MAX_SUBWORKFLOW_DEPTH = 3` (root -> A -> B -> C). The server builds the lookup from the registry (`catalogue/subworkflow-lookup.ts`, one pass, only when the definition has such a stage) at draft save, submit, approval and for project variants (`VariantContext.subworkflowLookup`); an organisation workflow has no project, so a `'same'` target is judged by approval only and enabled-ness is checked when the stage runs.

Warnings (shown, not blocking): stage with no `doneCriteria` text; more than 12 stages; a queued sub-workflow start that leaves required child fields unmapped.

**Sub-workflow stages at run time** (`commands/subworkflows.ts`, migration `1720_subworkflows.sql`, `docs/design/workflow-builder.md` section 4). A `subworkflow` stage is run by the server and never dispatched (the dispatcher only claims `workflow_stages.kind = 'agent'`; the migration widens that CHECK, and the `cards.origin` CHECK with `subworkflow`, `trigger`, `email`). A reactor follows the event log after a stored cursor (`workflow_reactor_cursor`, created at the end of the log by the migration; operational, kept across a projection rebuild), like the schedule triggers (10.3), once per scheduler tick and when the notifier sees new events (`sweepSubworkflows`). Events looked at: `StageCompleted`, `CardSpecified`, `CardMovedByManager`, `DeskItemResolved` (a blocked card released), and, for child endings, `StageCompleted`, `CardFinalized`, `CardCancelled`, `CardMovedByManager`. Each handler re-reads the projected state in its own append transaction (global append lock, row lock on the card), so a replayed event or a crash before the cursor moved changes nothing; an event that fails is retried by the next sweep and, after five failures, skipped.

- ENTER (`enterSubworkflow`): a `queued`, unclaimed card in a `subworkflow` stage. The run is keyed `(parent card, stage, entry_seq)` in the projection `subworkflow_runs`, where `entry_seq` is the event sequence of the move that brought the parent into the stage (from `card_transitions`), so rework rounds and manual moves back in start a new child while a replay starts nothing; at most one `open` run exists per (card, stage). The child is created with `createCardIn` (field parsing, repository, project rules) as the card owner, origin `subworkflow`, `parent_card_id` the parent, title `<step>: <parent title>`, fields from `fieldsIn` (`{field}`, `{value}`, or a `{template}` expanded with `card.ref`, `card.title`, `card.fields.<key>`), and `start` (`effectiveSubworkflowStart`): queued children are specified at once, drafts stay in the first stage. The child may live in another project of the organisation when that workflow is enabled there and the card owner is an active member of that project. `SubworkflowStarted{cardId, stageId, childCardId, childProjectId, workflowKey, workflowVersion, mode, reworkRound}` is appended after the child's `CardCreated`: wait mode projects the parent `waiting` (it stays in the step's column, `columnFor`), continue mode appends the success `StageCompleted` in the same transaction and the run is `continued`.
- RESOLVE (`resolveSubworkflow`): the child of an `open` run is `done` or `cancelled`. `SubworkflowResolved{cardId, stageId, childCardId, result: 'done'|'cancelled', fields}` closes the run and merges `fields` (the `fieldsOut` copy of a finished child, limited to fields the parent has) into the parent; if the parent still waits in that stage it then takes the `StageCompleted` of its success outcome (`done`, or a cancelled child with `onFailure: 'continue'`) or its failure outcome (`failed` by preference), through `resolveOutcome` (so `when` skipping and `rework` apply). A parent that was cancelled or moved on is left alone: only the run is closed.
- REFUSE: depth (the card already sits `MAX_SUBWORKFLOW_DEPTH` sub-workflow levels deep, from the `parent_card_id` chain of `subworkflow` cards), cycle (the target is the workflow itself or one of its ancestors), the project or workflow cannot be found or is not approved, not enabled in the target project, the card owner is not a member of the target project, or the mapping fails (unknown child field, card type not run, `createCardIn` refuses). The reactor appends `SubworkflowRefused{cardId, stageId, workflowKey, reason: depth|cycle|not_found|not_approved|not_enabled|not_member|invalid_mapping, detail}`, a card message and a blocking desk alert (`DESK_SUBKIND.subworkflowRefused`); the parent is `blocked` through the usual `card_blockers`. Acknowledging the alert returns the card to `queued` and `DeskItemResolved` makes the reactor try again.
- RE-ENTER: a card moved back (by a manager) into a stage whose earlier `open` run still has a running child is not given a second child: ENTER appends `SubworkflowAttached{cardId, stageId, childCardId, reworkRound}` plus a card note, and the projection sets the parent `waiting` again (no new run row; the existing run resolves the parent as usual).
- CANCEL: `POST /api/cards/:id/cancel` takes `alsoCancelChildren` (default false). With it, a `waiting` card's open run children (nested ones too) that the caller may cancel (`canManageCard` in the child's own project) are cancelled in the same transaction through `cancelCardIn`, with the reason "Cancelled together with REF (title): reason"; the others keep running. The card detail panel marks each child `child.canCancel` for the dialog's checkbox.
- BUILDER LOOKUP: `GET /api/subworkflow-targets` (org members; `?projectId=` selects the org of a shared project) lists the approved workflows with their card fields (`required` = needed before work starts) and the caller's own active projects with the workflows enabled in each. The builder step editor (`SubworkflowEditor`) and its in-browser rule 10 checks (`buildSubworkflowLookup` + `validateSubworkflowTargets`) use it; project variants cannot insert sub-workflow steps (inserted steps are agent stages).
- The existing bug-child path (`ChildCardResolved`, origin `test_failure`) is separate and unchanged. Board DTO: a waiting parent has `waitingFor: 'subworkflow'` and `waitingOn {id, ref, title, column, projectKey, projectName}` (title, column and project name only for a viewer who is a member of the child's project), a child has `startedBy`; card detail has `subworkflows {children[], startedBy}`.

---

### 6.6.1 Research stage and conversion (restructure Part C, `commands/convert.ts`)

**Stage.** `projects.started_as` (the workflow of `ProjectCreated`; migration `1315_project_stage.sql` reads it from the creation event, so a legacy workflow change does not rewrite history) never changes; `workflow_key = 'research'` is the research stage. In it `addRepo` answers 409 `research_stage_no_repos`, `aom repo create` is refused, `PATCH workflowKey` answers 400 `use_convert` (for every project), and `hygieneSpecFor` leaves the project out. A research project that already has repositories (legacy) keeps them.

**Convert (`POST /api/projects/:id/convert`, preview `GET .../convert-preview?toWorkflowKey=`).** Owner and Admins of the project's organization (`canConvertProject`); the project must be active with no waiting conversion; the target is any workflow of the organization except `feed`, and not the current one (any to any). Open cards whose workflow is not the target are the "foreign" cards: each gets `keep` (default `defaultDecision`) or `cancel` (`cardDecisions` by id; an unknown id is 400 `invalid_card`). A target that uses repositories (`workflowUsesRepos`) needs at least one active repository after the request: `repos[]` entries are `{name, remoteUrl, workingBranch?}` (added now, `ProjectRepoAdded`) or `{create: {name, visibility, description?}}`. A `create` goes through the same request, desk approval (`subkind 'repo_create'`, asked by the manager) and runner flow as `aom repo create` (`repoCreateRequestEvents`); when no other repository exists (400 `repo_required` with no `create` either) the conversion waits: `ProjectConversionRequested`, `projects.pending_conversion`; `settleConversionIn` (called inside the transaction of `applyRepoCreateResult` and of a rejection) converts when every request is `created` or `rejected` and at least one is `created`, and cancels the conversion when all were rejected. Otherwise `ProjectConverted` follows at once and a `create` is added when the runner creates it.

**After commit** (gateway `onEvent`): `confirmBranchOnEvent` asks the working-branch question for each `repoIds` (without requiring a clone) and `writeResearchIndex` queues a `vault.write` `{path: '<folder>/PROJECT.md', mode: 'section', section: {id: 'research-index', version: <event seq>}}` with `renderResearchIndex` (shared) listing the published notes; no vault or no notes: nothing. The Research tab (`/p/:key/research`) reads `GET /api/research/publications?projectId=`; `ProjectDto` carries `startedAs`, `convertedAt`, `publishedNotes` and (detail only) `pendingConversion`.

**Knock-ons.** Phases: a card of any workflow may be a member; `memberOutcome` has `published` (a research card whose note was published) which counts as resolved. Deploy and regression follow-ups need a repository and (regression) a test stage: `normalizeFollowups` answers 400 `followup_needs_repos`, stale defaults are left out of new phases. Archiving a project cancels a waiting conversion. The sweep's detectors (`ceo/detectors.ts`) need nothing: they read cards and shifts, not workflows.

### 6.7 Organization designer (M10)

Custom roles and workflows (org-owned rows, `org_id` = the owner) are drafted by the owner (`POST /api/roles|workflows`, `PUT …/:id`) or by the BA in a chat (`aom org role|workflow draft`, rpc `org.*`, only in the owner's own chat with a BA), validated on every save (`validateCustomWorkflow` = the nine rules of 6.6 plus: not a built-in key, field set `custom`, card types of `feature|bug|support|refactor|docs`, `StageCompleted`/`CardSpecified` outcomes only, no data and no effects, `manual` only as the first stage, department exists), and submitted with `…/:id/submit`, which raises one desk approval per definition. Approving re-validates against the catalogue as it is then (a workflow whose custom role is not approved yet is refused), emits `…VersionApproved` (the previous active version becomes `superseded`) and a hook writes the YAML file (`organization/<roles|workflows>/<key>/v<N>.yaml`, `shared/definitions`) to the owner's vault with `vault.write` (no vault: only the site copy). Roles and workflows of built-in keys cannot be drafted, replaced or removed; approved versions are never removed. The dispatcher needs nothing new: it routes by `workflow_stages.claim_role`, and every card is pinned to its `workflow_version_id`, so approving v2 changes only cards created afterwards. A custom role claims stages of custom workflows only (`claimableStages`, `*` for any stage). All writes take `?projectId=` to name the organization of a shared project and are refused for anyone but its owner; reads (`GET /api/roles|workflows|org/catalogue|departments?projectId=`) work for every member, so the Hire form of a shared project lists the owner's catalogue. Owner extensions of a built-in role (`PUT /api/roles/:key/extensions`, strict body: instructions, skills, standing orders) are added to the shift brief; core rules are never part of the request or the effective role.

## 7. Role catalogue

The built-in `architect` role (docs/design/architect-and-workflows.md) is senior only (Opus, effort high), claims `('*', 'investigate*')` (`stageIdMatches` supports a trailing `*`), may commit, writes only `docs/**` and `**/*.md` (the runner adds the project's investigation folder and the card's report path) and has `permissions.readOrgRepos`, which makes the server add every repository of the organization's active projects to its `readRepos` (`kind: 'org'`, `orgReadRepos`). Its raw `git push|fetch|pull|remote|rebase` stay denied: `aom git push|fetch|merge-main|verify-merge` are runner-run (§13.5). It is not claimable in `code-bugfix`.

`packages/shared/src/roles/schema.ts`:

```ts
export const RoleDefinitionSchema = z.object({
  key: z.string(), version: z.number().int(), name: z.string(), purpose: z.string(),
  department: z.string().optional(), builtIn: z.boolean(),
  instructions: z.string(),                 // markdown, provider neutral
  coreRules: z.array(z.string()),           // immutable for built-ins (test ownership, review gates)
  seniorityLevels: z.array(z.enum(['junior','senior'])).min(1),
  defaultModel: z.object({ runtime: z.string(), model: z.string(), effort: z.string().optional() }),
  permissions: AgentPermissionsSchema,      // default for hires
  skills: z.array(z.string()),
  claimableStages: z.array(z.object({ workflowKey: z.string(), stageId: z.string() })),
});
export const AgentPermissionsSchema = z.object({
  allowedTools: z.array(z.string()),        // provider-neutral: 'read','edit','shell','web','mcp:<name>'
  deniedShellPatterns: z.array(z.string()), // e.g. 'git push*', 'git rebase*', 'git checkout*', 'rm -rf /*'
  writableGlobs: z.array(z.string()).nullable(),   // null = whole worktree; tester: project.e2e_globs
  mayCommit: z.boolean(),
  riskTiers: z.array(z.enum(['small','large'])).default(['small','large']),
  repoIds: z.array(z.uuid()).nullable(),    // null = all project repos
});
```

Built-in roles v1 (`roles/builtin.ts`): `ba` (senior only; claims code.spec/finalize, code-bugfix none; interactive intake), `builder` (code.build, code-bugfix.build), `reviewer` (senior only; code.review, code-bugfix.review; `mayCommit:false`, no edit), `tester` (code.test; `writableGlobs` = project e2e globs), `writer` (code.docs; writable `docs/**`, `*.md`), `devops` (no stages; one per user per workstation), `researcher` (research.research), `checker` (research.factcheck), `scout` (feed.scan), `curator` (feed.curate). Instruction texts are in the same file as markdown template strings.

Effective role for a shift = built-in/custom role definition at the agent's `role_version` + `role_extensions` of the org (owner-only edits) + the agent's own `skills`.

---

## 8. Exclusive claim, lease and release

### 8.1 Claim (`apps/server/src/dispatcher/claim.ts`)

Executed inside `withAppendTx` (global append lock already held), for one candidate card and one agent:

```sql
-- $1 card_id, $2 agent_id, $3 workstation_id, $4 shift_id, $5 claim_id, $6 expected stage, $7 overflow
UPDATE cards
   SET claim_id             = $5,
       claimed_by_agent_id  = $2,
       claim_workstation_id = $3,
       claim_shift_id       = $4,
       claimed_at           = now(),
       lease_expires_at     = now() + interval '1 hour',
       claim_overflow       = $7,
       status               = 'claimed',
       updated_at           = now()
 WHERE id = $1
   AND status = 'queued'
   AND claim_id IS NULL
   AND stage = $6
RETURNING id, stage, repo_id, home_workstation_id, worktree_path, branch_name, worktree_card_id;
```

Zero rows → the card was taken or moved; the dispatcher moves on to its next candidate (no error). One row → compute worktree info (§13.5), append `CardClaimed` (its projector re-sets the same columns idempotently from the event, so replay produces identical state) and send `shift.start` to the runner after commit. The conditional `WHERE` is the atomicity guarantee; it does not depend on the advisory lock, so it stays correct if the lock is ever removed. Test: 50 concurrent claim attempts on one card → exactly one `CardClaimed`.

Clock: all time-dependent server code uses `clock.now()` (`apps/server/src/clock.ts`) and passes it into SQL as a parameter instead of `now()` (the SQL above shows `now()` for readability), and `events.created_at` is set explicitly from `clock.now()`. This lets tests advance time (`AOM_TEST_CLOCK`) to exercise the 1-hour lease, invitation expiry and schedules.

### 8.2 Lease and heartbeat

- Lease length: **1 hour**, which is the spec's offline timeout. Each runner `heartbeat` (every 15 s) refreshes leases of the shifts it reports:

```sql
UPDATE cards SET lease_expires_at = now() + interval '1 hour'
 WHERE claim_workstation_id = $1 AND claim_shift_id = ANY($2::uuid[]) AND claim_id IS NOT NULL;
UPDATE workstations SET last_seen_at = now() WHERE id = $1;
```

- A shift that the server has but the heartbeat does not report for 2 consecutive heartbeats after `shift.started` is treated as lost: `ClaimReleased(reason runner_lost_shift)`.
- Server-side max: if `now() > claimed_at + stage.maxShiftMinutes + 10 min`, the server sends `shift.stop {reason:'timeout'}`; the runner enforces `maxShiftMinutes` locally too.

### 8.3 Reaper (`apps/server/src/dispatcher/reaper.ts`, every 60 s)

```sql
SELECT id, claim_id, claimed_by_agent_id FROM cards
 WHERE claim_id IS NOT NULL AND lease_expires_at < now()
 FOR UPDATE SKIP LOCKED;
```

For each row append `ClaimReleased{reason:'lease_expired', lastHandoffId}` and a system `ThreadMessagePosted` ("Released after workstation offline for 1h; last handoff attached"). The card returns to the queue of its stage. Because the card keeps `home_workstation_id` (§13.5), only agents on that workstation can pick it up again unless the manager re-homes it (`POST /api/cards/:id/rehome`, which clears `home_workstation_id`, `worktree_path` and restarts the stage from the base branch with a system note).

Pending shift starts: if `shift.accepted` is not received within 30 s of `CardClaimed`, release with `runner_rejected`.

### 8.4 Release paths

| Trigger | Reason | Card goes to |
| --- | --- | --- |
| Outcome reported | `handoff` | next stage queue |
| Blocking question | `question` | `blocked` |
| Agent fired / reset (DevOps) | `agent_retired` | same stage, queued, last handoff attached |
| Lease expired | `lease_expired` | same stage, queued |
| Shift ended without report, crashed, timed out | `shift_failed` | same stage, queued; agent added to `excluded_agent_ids` for one retry cycle only if it failed twice in a row on this card (prevents hot loops); desk alert after 3 consecutive failed shifts on one card |
| Runner rejected / never accepted | `runner_rejected` | same stage, queued |
| Manager release | `manual` | same stage, queued |
| Workstation unlinked | `workstation_unlinked` | same stage, queued, `home_workstation_id` cleared |
| Member removed | `member_removed` | same stage, queued |

---

## 9. Dispatcher

### 9.1 Triggering

`apps/server/src/dispatcher/dispatcher.ts` runs a **pass** when (a) an event of type `CardSpecified, CardCreated(status queued), ClaimReleased, ShiftEnded, ReviewRequested, ChangesRequested, ReviewApproved, TestPassed, StageCompleted, ChildCardResolved, QuestionAnswered, AgentHired, AgentChanged, AgentRehomed, WorkstationConnected, ScheduleFired, RebaseConflict, CardCancelled, CardPhaseChanged, CardMergeVerified, PhaseConfirmed, PhaseReopened, PhaseFollowupsApproved, PhaseFollowupBriefed, PhaseFollowupFinished, BaTaskQueued, BaTaskCompleted, BaTaskRequeued, FullSuitePassed, FullSuiteFailed` is observed (debounced 250 ms), or (b) every 10 s. Passes are serialized in-process and guarded by `pg_try_advisory_lock(7320)` on a dedicated connection so only one server instance dispatches.

### 9.2 Pass algorithm

```
phasePass()                                          -- §9.8, first: what it creates is dispatched in this pass
freeAgents = SELECT a.*, ws.runtimes, count(active claims) AS active
             FROM agents a JOIN workstations ws ON ws.id = a.workstation_id
             WHERE a.status='active' AND NOT a.is_devops
               AND ws.status='active' AND ws.connected AND ws.last_seen_at > now() - interval '45 seconds'
               AND runtime a.runtime is available on ws (from ws.runtimes)
               AND active < a.capacity
             ORDER BY a.last_shift_ended_at NULLS FIRST, a.hired_at   -- longest idle first (fairness)
for agent in freeAgents:
    for card in candidates(agent) LIMIT 5:          -- §9.3, already in priority order
        if claim(card, agent): send shift.start; break
overflowPass()                                       -- §9.4
devopsPass(); questionPass(); baTaskPass()           -- non-card queues, one shift at a time per agent (§9.8)
testerBottleneckCheck()                              -- M4 (§9.5)
```

An agent claims at most one card per pass. Agents with capacity > 1 (and agents that become free) are picked up by the next pass: the dispatcher re-runs a pass immediately whenever the previous pass made at least one claim, up to 20 consecutive passes, then falls back to event triggers and the 10 s tick.

### 9.3 Candidate query (`dispatcher/candidates.ts`)

```sql
-- $1 agent_id, $2 org_id, $3 allowed projects (uuid[]|null = any), $4 role_key, $5 is_senior,
-- $6 workstation_id, $7 runtime capabilities text[], $8 agent risk tiers text[], $9 now (the server clock),
-- $10 the agent's focus projects (uuid[])
SELECT c.id, c.stage
FROM cards c
JOIN projects p          ON p.id = c.project_id AND p.status = 'active'
JOIN workflow_stages st  ON st.workflow_version_id = c.workflow_version_id AND st.stage_id = c.stage
WHERE c.status = 'queued'
  AND c.claim_id IS NULL
  AND c.org_id = $2                                             -- only the agent's organization
  AND ($3::uuid[] IS NULL OR c.project_id = ANY ($3))           -- the manager's allow-list for this agent
  AND EXISTS (SELECT 1 FROM workstations aw JOIN project_members apm ON apm.user_id = aw.user_id
               WHERE aw.id = $6 AND apm.project_id = c.project_id AND apm.status = 'active')
                                                                -- the workstation owner is on the project
  AND (p.max_concurrent_shifts IS NULL OR                       -- optional per-project cap (off by default)
       (SELECT count(*) FROM cards pc WHERE pc.project_id = c.project_id AND pc.claim_id IS NOT NULL)
         < p.max_concurrent_shifts)
  AND st.kind = 'agent'
  AND st.claim_role = $4                                        -- role/stage matching from workflow data
  AND (NOT st.senior_only OR $5)
  AND NOT ($1 = ANY (c.excluded_agent_ids))                     -- e.g. builder can't review own work; 2nd reviewer differs
  AND (c.risk_tier IS NULL OR c.risk_tier = ANY ($8))           -- split roles by risk tier
  AND c.required_capabilities <@ $7
  AND (c.home_workstation_id IS NULL OR c.home_workstation_id = $6)
  AND (c.repo_id IS NULL OR EXISTS (                            -- workstation holds the repo
        SELECT 1 FROM workstation_repos wr
         WHERE wr.workstation_id = $6 AND wr.project_repo_id = c.repo_id))
  AND (c.worktree_card_id IS NULL OR EXISTS (                   -- bug child: parent's worktree must be here
        SELECT 1 FROM cards pc WHERE pc.id = c.worktree_card_id AND pc.home_workstation_id = $6))
  AND (c.retry_after IS NULL OR c.retry_after <= $9)            -- loop breaker (§9.7): not while in back-off
  AND NOT EXISTS (                                              -- dependencies: only gate the first stage that creates the branch (investigate or build)
        SELECT 1 FROM card_dependencies d JOIN cards dc ON dc.id = d.depends_on_card_id
         WHERE d.card_id = c.id AND c.stage = 'build' AND c.rework_round = 0
           AND dc.status NOT IN ('done','cancelled'))
ORDER BY
  c.scheduled DESC,                                             -- 1. scheduled tasks first
  CASE                                                          -- 2. the agent's own rework, then other rework
    WHEN c.is_rework_or_bug AND c.original_builder_agent_id = $1 THEN 0
    WHEN c.is_rework_or_bug THEN 1
    ELSE 2
  END,
  (c.project_id = ANY ($10)) DESC,                              -- 3. the agent's focus projects (soft preference)
  (preferred agent of an interest run) DESC,                    -- 4. an interest's preferred agent (soft)
  p.rank ASC NULLS LAST,                                        -- 5. the organization's project ranking (1 = most important)
  c.priority ASC,                                               -- 6. card priority
  c.queued_at ASC                                               -- 7. FIFO
LIMIT 5;
```

Allow-list, membership and cap are one place: `eligibility().scope` (shared with `queries/workability.ts`, so "could anyone ever take this card" cannot drift from "can this agent take it now") and the `max_concurrent_shifts` line in the candidate SQL. The cap is hard: it also binds the overflow path (`isCandidate`). The BA-task, tester-bottleneck, question-escalation and CEO paths use the same rule on the agent's allow-list and its workstation owner's membership.

Notes: the "builder priority" CASE is harmless for other roles (they rarely see rework flags; reviewers of rework cards simply sort them first, which is desired). Scheduled cards include the runs of interests (`scheduledCard`: scans and "Research this"), which is why an interest's hidden project needs no rank (`rank` is NULL, sorted last). The ranking replaced the work/personal domain and the priority tier (owner decision 2026-10-07): the Owner and Admins order the projects of the organization on the Projects page (`PUT /api/projects/ranking`), a new project goes to the bottom, and the focus projects of an agent stay a soft preference ahead of the rank. "A new important card waits for the current shift" falls out of claims never being preempted. M3 adds for cards without a repo (research/feed): `EXISTS (SELECT 1 FROM workstation_vaults wv JOIN vaults v ... WHERE v.project_id = c.project_id OR v.kind = 'org')`, the organization vault counting only on the workstations of the organization's Owner and Admins.

The candidate query also carries `AND NOT budgetPausedSql(p, $9)` (`costs/index.ts`): a project over its monthly budget offers nothing to any agent (section 26). The claim re-checks it through `isCandidate`, so a claim cannot slip through a pause. The BA task pass skips the tasks of paused projects the same way.

### 9.4 Overflow for late scheduled cards

Spec rule 1: if a scheduled card has no free agent, start one extra shift at a time. After the main pass:

```
late = queued scheduled cards (status queued, scheduled, queued_at < now() - 30s) ordered by queued_at
for card in late:
   if org(card) already has a shift with claim_overflow = true active: continue   -- second late schedule waits
   agent = an active agent of the stage's role on an eligible, online workstation,
           at capacity (active = capacity), not already overflowing, ordered by fewest active then idle time
   if agent: claim(card, agent, overflow=true)
```

Overflow is per organization (one extra shift at a time per org).

### 9.5 Tester bottleneck (M4)

At the end of each pass: for each project with queued cards in a stage claimed by `tester` older than 5 min and no free tester agent (all testers at capacity), append `TesterBottleneck` unless an open bottleneck desk item exists for that project. Resolved automatically (DeskItemResolved acknowledged) when the queue drains.

### 9.7 Loop breaker (B0)

A card whose shifts keep ending without a report would be re-claimed every pass. `commands/loop-breaker.ts`, called from `applyShiftEnded` when a card shift ends without a report (not `stopped`, no handoff, no question), counts the card's failed shifts (`no_report`, `crashed`, `timeout`, `lost`, without a report) since its last report. The 3rd failure within 10 minutes starts an **episode**: `CardRetryDeferred{cardId, until, failures, episodeId, newEpisode}` sets `cards.retry_after`, `retry_failures` and `retry_episode_id`. The back-off is 1 minute for the 3rd failure and doubles with each further failure of the episode, capped at 1 hour (`loopBackoffMinutes` in `packages/shared/src/testing`). The candidate query (§9.3) and therefore the claim and overflow paths skip a card until `retry_after` has passed; no pass runs when the back-off ends, the 10 s tick picks the card up. An episode ends when a `HandoffWritten` clears the three columns (any report), or when the manager moves the card (`CardMovedByManager`). `POST /api/cards/:id/release-backoff` appends `CardRetryReleased` (clears only `retry_after`, so a failure after a manual release backs off longer) and resolves the alert.

Thread messages collapse: the 1st failure posts the usual "Shift ended without a report", the 2nd none, the engaging 3rd one message that names the hold; later failures of the episode post nothing. The episode's first back-off also creates one desk alert (`DeskItemCreated`, kind alert, subkind `loop_backoff`, bound to the card, same append). Not counted: shifts of other kinds, runner rejections (they have their own cooldown) and server-side lost-shift releases from the reaper, which do not pass through `applyShiftEnded`.

Back-off for every rejection (S1b): `applyShiftRejected` holds the card back (`rejectionBackoffEvents`, 1 minute doubling to 1 hour) for every rejection kind that will not fix itself (`repo_missing`, `worktree_failed`, `runtime_unavailable`, `internal`), not only a missing branch. The third identical rejection in a row (same reason and detail as `cards.last_rejection`) raises one `worktree_rejections` desk item for the card (later ones only count on it). The reason is stored on the shift (`ShiftEnded.rejectionReason`, `shifts.rejection_reason`) and logged. The DevOps, question and BA task passes take the same `full()` closure as the card passes: a workstation at its shift limit is offered nothing, and every shift they start counts for the passes after them.

Measurement (S1b): a shift that reported and was then stopped ends as `reported` (`applyShiftEnded` and the `ShiftEnded` projector, migration 2125 for history); usage that the runner sends after the server closed a shift at zero is recorded by `ShiftUsageRecorded` (tokens and price). `costs/causes.ts` splits `shift_costs` by cause (working, asking, answering, reviewing, re-review after conflict, rejected, other) for one card (`GET /api/cards/:id/cost-causes`) or per local day (`GET /api/costs/causes`); the board card carries `spend`. The price table (`packages/shared/src/costs`) has Sonnet 5/5.5 $2/$10, Sonnet 4.x $3/$15, Opus 5.5 $4/$20, Opus 5 and earlier $5/$25, Haiku 5.5 $0.10/$0.50, Haiku 4.x $1/$5, with the 1-hour cache-write rate (2x input) used for the tokens `usage.cacheWrite1hTokens` names.

Noise (S1b): the signal sweep compares signals with `ceo/same-json.ts` (key-order independent; jsonb reorders keys), the web socket does not invalidate everything on the first `ready` and gathers a burst of events for 120 ms (`InvalidationBatcher`), the reaper prunes `runner_inbox` after 7 days (`runner-gateway/inbox-prune.ts`), and the runner's vault sync backs off (doubling to 6 h) after a permanent error such as a refused login or a missing repository (`vaults/sync.ts isPermanentSyncError`).

### 9.8 Phases: `phasePass` and the BA task queue

`dispatcher/phases.ts phasePass` is state based and idempotent: each step locks the phase row (`FOR UPDATE`), re-checks its status and appends in one transaction, and a failure in one phase is logged without starving the others. Archived projects are skipped. Steps:

1. **Merge checks (owner decision A2).** For a finalized `pr` card (or an older `push_branch` one) of an `open` phase whose branch is not merged yet, a `branch.check_merged` runner command goes to the card's home workstation (one at a time per card, repeated every `AOM_MERGE_CHECK_SECONDS`, default 180). The runner fetches and tests `git merge-base --is-ancestor <card branch> <working branch>`; a merged branch is deleted (locally; on the remote for `push_branch`) and `command.result` appends `CardMergeVerified`. A `merge` finalize counts at once. A member can confirm a merge the check cannot see (a squash merge, a deleted branch) with `POST /api/cards/:id/confirm-merged`. The working branch is `phases.working_branch`, else the card's base branch, else the repository's, else the project's.
2. **Completion.** An `open` phase with at least one confirmed member, no member that is only proposed, and every confirmed member resolved (`finalized` and merged, `closed_manually` = done without a completion action, or `cancelled`; `phaseCompletion` in `packages/shared/src/phases`) appends `PhaseCompleted` and queues the BA's `phase_report` task. Completion does not wait for post-merge full suites (they are listed as outstanding). A bug card filed after finalize joins the phase it came from (`bugJoinEvents`, owner decision A6) and reopens a phase that still awaits its report.
3. **Results.** A running DevOps follow-up succeeds when all its requests are `done` and fails as soon as one failed; a regression follow-up decides from the latest `test_runs` row of each of its cards (bug cards are named in the evidence).
4. **Sequencing.** Follow-ups run strictly in order, one at a time (`nextFollowup`). Any failed follow-up skips the ones after it (owner decision A7). The next `briefed` follow-up starts: a deploy creates DevOps requests through `createDevOpsRequestIn` (a remote target: its workstation; the local stack: one request per workstation of every active project member, owner decision A9), a regression follow-up creates regression cards through `regressionRunEvents` pinned (`home_workstation_id`) to a workstation that was just deployed and has a tester, with `targetUrl` and `deployTarget` in the card fields (testers also get `AOM_TARGET_URL`), a custom one for the BA queues a `followup_custom` task. When all are terminal, `PhaseFollowupsFinished` queues the `followups_report` task.

`dispatcher/ba-tasks.ts baTaskPass` is the structure of `questionPass`: queued tasks oldest first, one `ba_task` shift at a time per BA agent (outside card capacity), the intake's BA preferred. The shift has no card or worktree (`shift.start kind 'ba_task'`, a placeholder card, `baTask` with the phase, its cards and suites, the follow-ups and what is outstanding) and ends with exactly one terminal `aom phase` report, validated by `commands/ba-tasks.ts applyBaTaskReport`; questions are refused. A shift that is rejected, lost or stopped requeues the task unharmed; a crash, timeout or missing report counts an attempt. **No agent ever blocks:** a task with no BA hired, no BA online for 15 minutes or two failed attempts is done by the server from a template (`runBaTaskFallback`: a report starting "Your BA was not available; this summary was generated.", template briefs, "no BA was available" for a custom follow-up the BA was to do) and marked `fallback`. Archiving a project cancels its phases (`PhaseCancelled`), their pending follow-ups and queued tasks; a DevOps request already running is left to finish.

### 9.9 Desk routing, signals and the daily report (the BA reporter, retired)

The BA reporter of Part B (`docs/design/phases.md`) was retired in step 3 of `docs/design/ceo-front-door.md`: with a built-in CEO there is no "no CEO" organisation, so the BA is a **spec writer only** (role version 18). What the reporter did now runs in the CEO's own code under `apps/server/src/ceo/`.

**Routing (`ceo/routing.ts`).** `PgEventStore.intercept` registers a hook that runs inside every append transaction (so every emitter of `DeskItemCreated` and `QuestionRaised` is covered, and the decision lands in the stored event, never recomputed on replay). When the organisation's CEO is **active** (`ceoActive`: enabled, not paused, active agent) **and reachable** (`ceoReachable`), an item is *urgent* when it is blocking, pinned, not an `alert` (approvals, escalations) or the loop breaker's alert; it is stored unchanged. Any other item is **held**: the payload gets `triage:{deadline: now + 10 min}`, the projection sets `triage='pending'`, `DESK_VISIBLE` hides it from the manager (its `status` stays `open`, so the emitters' own dedup checks still see it) and the CEO is woken by the item (`ceo/wakes.ts`), which it triages with `aom ceo act triage` (pass, dismiss, merge). The DevOps working-branch question is held the same way. Exempt: ratings, phase items and the CEO's own items (`ROUTING_EXEMPT_SUBKINDS`). With the CEO paused or its workstation offline **nothing is held** and nothing is queued for anybody: there is no BA fallback and no switch. The old `users.reporting.routeViaBa` key and `ReportingPrefsChanged.routeViaBa` stay in the data for replay but nothing routes by them; the only thing that still reads the key is where a non-blocking agent *question* starts in the escalation chain (`commands/questions.ts`, `via:'ba'`; the BA answers from the ledger or escalates, section 15). `GET/PUT /api/reporting` no longer carries it.

**The CEO never blocks.** The deadline is enforced by the sweep (below): `DeskItemTriaged{outcome:'released'}` ends the hold and the item reaches the desk exactly as raised. A hold needs a reachable CEO, so an offline CEO releases nothing late: it holds nothing in the first place.

**The sweep (`ceo/signals.ts` `SignalSweep`, `AOM_REPORTER_SECONDS`, default 60; `ctx.services.signals`; `POST /api/test/clock` runs it too).** (1) Releases expired holds (`releaseHeldEvents`). (2) Runs the deterministic detectors (`ceo/detectors.ts`; thresholds are the single `REPORTER` object in `packages/shared/src/reporter`): `loop` (an open loop-breaker episode: `retry_failures >= 3` with `retry_after` set), `repeated_approval` (approval desk items clustered by subkind and `topicWords` overlap >= 0.6, >= 3 in 24 h; urgent if one was rejected), `blocked` (> 4 h), `unclaimed` (queued > 30 min and `cardWorkability` not ok), `rework` (round >= 3), `finalize_failures` (>= 2), `repo_hygiene` and `budget`; and reconciles `ba_signals` (UI name: signals) by fingerprint (raise, update when count/urgency/subject changed, resolve when the condition clears, acknowledging the signal's open `ba_report` item of old BA reports). A raised or worsened urgent signal wakes the CEO through the wake sources (`BaSignalRaised`/`BaSignalUpdated`); no task is queued. (3) `queueCeoReviews` (`ceo/pass.ts`) queues the daily `daily_review` wake once the manager's local clock passes the CEO's `reportAt`, else the organisation's `dailyAt` (`floorReportDue`; local date from `users.timezone` via `Intl`, UTC while unset; once per local date, tracked in `ceo_settings.report_day`; skipped when the digest is empty and the CEO did nothing). (4) `sweepTopics` (`ceo/topics-handoff.ts`: problem notes, expiry, the one-way hand-off to the blog queue, read-back; blog topics phase 2). The digest (`ceo/digest.ts buildFloorDigest`) is deterministic SQL: open phases and the open bug cards that hold them, signals, cards in back-off, open DevOps requests, items resolved without the owner (`triage` dismissed/merged, or questions answered by an agent) and failed shifts since the previous report; the CEO's report starts from it and the server appends it.

**Fallbacks when the CEO cannot run (deterministic, no model).** Held items are released at the deadline (or never held). An urgent wake that waits more than 30 minutes becomes one desk notice and e-mail (`offlineNotice` in `ceo/pass.ts`). A daily review nobody wrote in two hours is posted from the template (`postFallbackReview`, `renderFloorReportFallback`). A schedule's `scheduled_brief` wake nobody took in two hours becomes a notice that the task was skipped (`postMissedScheduledBriefs`).

**Scheduled tasks.** A schedule's `ba_task` action (the name stays so old schedules keep working) enqueues a `scheduled_brief` CEO wake (`urgency 'scheduled'`, `detail {scheduleId, scheduleName, instructions, deliver, projectKey?}`) instead of a BA task; the CEO brief lists the instructions (the manager's own words) and tells the CEO to deliver the answer with `aom ceo notify --kind task_done`.

**What is left of BA reporter tasks.** `ba_tasks` keeps the retired kinds (`desk_triage`, `urgent_note`, `floor_alert`, `floor_report`) in the schema for replay; nothing enqueues them, `BaTaskQueued`, `BaTaskItemsAdded`, `BaSignal*`, `DeskItemTriaged`, `DeskItemAnnotated`, `BaChatLinked` and the floor-report projector still project. The one BA task that still travels as the reporter kind `scheduled_brief` is the CEO-BA review of a corrected decision (`ceo/review.ts`, `commands/review-tasks.ts`: `buildReviewTask`, `applyReviewReport`, `runReviewFallback`; the prompt is `prompt/review-task.ts`). `aom report triage|notes|signals|floor` answer "retired" for one runner version. The standing "BA reports" chat is read-only (`CHAT_ERROR.baReportsRetired`).

**Migration.** Data migration `reporter-retired-2026-10` (`data-migrations/reporter-retired.ts`, once): queued reporter tasks are cancelled (a queued schedule task becomes a CEO wake), held items are released, and a changed `dailyAt` becomes the CEO's `reportAt` where that is unset. No SQL migration was needed (the `routeViaBa` key lives in the `users.reporting` JSON).

### 9.11 The CEO agent

**Built in (Step 0 of `docs/design/ceo-front-door.md`).** Every organisation has exactly one CEO from the moment it exists; there
is no appoint, dismiss, disable or training period. `ceo/provision.ts ceoProvisionEvents` returns the `AgentHired{roleKey:'ceo',
isBuiltin:true}` and `CeoEnabled` (no `training`: absent means graduated) events and is appended in the same write as
`OrganizationCreated` (`billing/signup.ts`, `commands/invitations.ts`, `data-migrations/orgs.ts`); it is a no-op when a live CEO
exists. `agents.is_builtin` (migration `2220_ceo_builtin.sql`, true for DevOps and the CEO) keeps it out of the plan limits
(`orgs/limits.ts`), the partial unique index `agents_one_ceo` allows one live CEO per organisation, and `fireAgent` refuses it
(409 `builtin_agent`). `AgentHired.workstationId` is nullable: a CEO whose Owner has no workstation is bound with `AgentRehomed`
in the same append as the Owner's `WorkstationPaired` (`ceoBindEvents`), and re-homed when ownership moves
(`ceoOwnerChangeEvents`); the CEO page then says "Pair a workstation". Pause and Resume stay as an emergency stop; settings,
policy and the workstation picker stay. Data migration `ceo-builtin-2026-10` (run at every boot, idempotent) gives an
organisation without a live CEO one (also after an old Disable: the retired agent keeps its history) and graduates a CEO still in
training (`CeoTrainingChanged{reason}`); an organisation with an active CEO, paused or not, is left alone. `evaluatePolicy` has
no training input any more: staffing classes follow the policy table from day one.

**Flagged bugs reach the CEO.** A `CardCreated` of a bug in `draft` wakes the CEO (`bug_flagged`, subject the card, urgent when a
suite, regression or test found it, keyed like its `bug_reported` desk alert so card and alert are one wake; the wake source
handles events one at a time so events of one append do not race on that dedupe). The new class `card.specify` and verb
`aom ceo act specify --card <REF>` call `specifyCardIn`; when required fields are empty and are all text or list fields, it
queues a BA task `spec_card` (`commands/spec-card.ts`, migration `2221_ba_spec_card.sql`, `ba_tasks.card_id`): the BA reports
`aom report spec-card --file <fields.json>`, the server patches the card as its owner and specifies it, or refuses a report that
still leaves fields empty. A missing repository or other non-text key stays with a person (the verb says so); a task no BA takes
becomes a pinned `spec_needed` alert. `intake` takes `cardType`, `ticket` (the card's `externalRef`) and `priority`, uses the
same completion path, and without a BA reports "recommend hiring a BA" instead of refusing. The reporter sweep and routing use the
same test for "the CEO holds items" (`ceoActive` and `ceoReachable`).

**The front door, step 1 (`docs/design/ceo-front-door.md` sections 3 to 8, with the owner decisions of section 14).**

*Provenance.* Every `aom ceo` call has an origin the SERVER derives from its own records, never from a field the runner or the
model supplies (`ceo/gateway.ts`): `owner` (a `chat` shift with a `ceo_turns` row of mode `owner`; no row means a legacy chat,
still `owner`), `order` (a `ceo_turns` row of mode `order`) and `wake` (a `ceo_batches` row; untrusted when any of its wakes is).
`evaluatePolicy` takes `origin: {kind, covers?}`: an `owner` turn turns a `recommend` verdict caused by mode, reserved key,
confidence or desk mode into an inline confirmation (`verdict.inline`; the desk item `ceo_recommendation` carries
`data.inlineTurnId`, the chat shows Approve / No, and `POST /api/ceo/turns/:id/confirm` resolves it through the Owner's session,
never through text); an `order` turn may act on an owner-reserved key only when the authority's `covers` lists it; a wake keeps
today's rules. New classes `card.specify` (step 0), `deploy.run` (reserved for step 2) and `order.invoke`; policies saved before a
class existed take its default (`ceo/state.ts withNewClasses`). New verbs: `draft-cards` (up to ten draft cards), `devops` by
`--project`, `--env` or `--workstation` (`actions.ts devopsWorkstation`: the target's workstation, else the Owner's DevOps
workstation; origin `ceo`), `invoke-order` (`actions3.ts`), plus the rpc ops `correction`, `job`, `order`, `permission`,
`devops_status`, `dir` and `restart` (`packages/shared/src/ceo/ipc.ts`).

*The owner turn.* `ChatRelay.send` on the CEO thread (`chat/relay.ts sendCeo`, `chat/ceo-turns.ts`) resolves the model, persists
the turn (`ceo_turns`: `CeoTurnQueued`, then `CeoTurnStarted` with `ShiftStarted.mode`, then `CeoTurnFinished`; the turn id is the
chat id and the shift id), and sends `chat.start` with `ceoMode`, `cwd` (`settings.ownerTurn.cwd`), `addDirs` (the thread's
`dirs`), `context.ceo.brief` (the static brief, every turn: a resumed session does not keep its system prompt) and `briefDelta` (a
fenced context block: the full context on the first turn of a session, the changes since the last finished turn after that).
`ceoMode` is sent only when the CEO's workstation belongs to the Owner; the runner additionally needs its local opt-in
(`aom-runner ceo full-power on`, announced as the hello capability `ceo-full-power:1`) or it runs the restricted profile and
reports `chat.done.degraded='full_power_off'`. Order turns are refused by the runner without the Owner's mark and a hash match.
*Model switch*: message override, else `threads.model_override` (`ChatThreadModelSet`), else `settings.models.chat`, validated
against `MODEL_CHOICES` (`packages/shared/src/models/choices.ts`); a reply stores `data.runtime`, `data.runtimeSessionId`,
`data.cwd` and `data.sessionStartedAt`, and the next turn resumes the session of the chosen runtime unless the working directory
changed, 24 hours or 120K context tokens passed (a new session then starts with a handover: the last 20 messages, open tasks and
corrections). *Queueing*: an offline workstation (or an earlier queued message) queues the turn (`data.queued`, the browser gets
`chat.queued`, a push says so); `reconcile` (after `hello`) drains one turn at a time through `ChatRelay.onReconnect`, and a turn
older than 72 hours is not sent until the Owner presses Send or Drop (`POST /api/ceo/queue/:id`). A CEO owner or order turn
is not failed when the runner's socket drops (`workstationLost` skips it); the runner reports the chats it still holds in
`hello.activeChats` and `reconcileCeoTurns` fails the rest. State survives a server restart: `ChatRelay.hydrate` rebuilds the
in-flight record from `ceo_turns`. `GET /api/ceo/chat/state` (`ceo/chat-state.ts`) gives the page the model, full power, the queue,
pending permissions, inline confirmations and corrections. `aom runner restart` (rpc op `restart`, `RunnerRestartRequested`)
restarts after the reply; the next `hello` posts "<workstation> restarted (runner <version>)" in the thread (`ceo/restart.ts`).

*Permissions (section 14.1).* Turns run in auto mode; the runner's relay MCP server (`--permission-prompt-tool`) calls the rpc op
`permission`: `ask` raises a desk approval `ceo_permission` (`ceo/permissions.ts`: options once / turn / deny, blocking for an owner
turn and not for an order turn, never routed or woken for the CEO, pushed like any approval) and `poll` returns `pending | once |
turn | deny | timeout`. Any Owner or Admin answers (`POST /api/ceo/permissions/:id`, or the generic desk resolve: approved is once);
10 minutes without an answer is a `timeout` (closed lazily on the next poll, and with the turn at its end). Projection
`ceo_permission_asks`; events `CeoPermissionAsked` / `CeoPermissionAnswered`.

*Standing orders with full power (section 3.4, 14.4).* `ceo/orders.ts`: `POST /api/ledger/:id/authorize` (Owner only) appends
`StandingOrderAuthorized {versionHash = sha256(title \n body), scope {projectIds, triggers}, covers}`; the entry must be eligible
(written by the Owner in his own session with no CEO causation, or approved by him on the desk, or escalated by an Admin with
`POST /api/ledger/:id/escalate`, which raises an `order_escalation` desk notice for the Owner); `LedgerEntryEdited` voids it in the
same append (`StandingOrderAuthorityVoided`) unless the Owner edits with `keepFullPower` (a fresh authorization of the new hash),
retiring and an ownership change void it too, and `/revoke` ends it. Projection `standing_order_authority`. The restricted wake
brief lists the orders in force; `aom ceo order invoke` runs the action `invoke-order` through the engine (idempotency, policy:
an untrusted wake only recommends unless the order's trigger pre-filter matched, audit): authority current, scope and trigger
match, per-order limits (5 a day, one per subject per 6 hours, one running), the Owner's workstation online with full power. The
server then creates the hidden per-order thread (`threads.kind='ceo_order'`) and an `order` turn whose prompt is the order text
plus fenced event data; calls in it carry `CeoActionTaken.order` and the turn id, and the authority is checked on every call.
`order done|decline` and `chat.done` end it (`CeoOrderTurnFinished` with the commands); the daily report lists order turns.

*The job log and corrections (sections 4 and 7).* `ceo/jobs.ts` writes `CeoOffboardJobLogged`; the server backstop
(`chat/ceo-turns.ts backstopJobEvents`) logs an `unlabelled` job for an owner turn that used tools, made no board object and
logged nothing. `ceo/signals.ts` applies the repeat rule (4 in 7 days or 10 in 30; a dismissed key is quiet for 90 days) to each job
and again when the report is written, appending `CeoRepeatDetected`; the report's `data.ceo.repeats` and `orderTurns` feed the web
page. `ceo/corrections.ts` records `CeoCorrected` with an active `correction` memory (source `owner_correction`, confidence 1),
lowers the cited memories, and offers Undo (`undoCeoAction`) or Redo (`runAction` with `force`, idempotency key `redo:<id>`);
the desk path (`correctCeoDecision`) appends the same event. `relevantMemories` ranks corrections first and drops an inferred
`decision_pattern` when a correction or rule of the same class exists. Admins record rule-only corrections.

*DevOps behind the CEO (section 8).* `POST /api/chats` for a DevOps agent is 409 `devops_via_ceo`, a `chat.send` on an old DevOps
thread fails with the same reason; the CEO files requests with `aom ceo act devops` and follows them with the rpc op
`devops_status` (`--wait`). Migration `2222_ceo_front_door.sql`; operational flags use `ceo_flags` (`jobstart:<turn>`,
`restart:<workstation>`).

A built-in role `ceo` (one per organisation) does the work the BA reporter used to do (retired in step 3, section 9.9; `ceo/state.ts`
`ceoActive`, `ceoReachable`): the routing interceptor (`ceo/routing.ts`) holds non-urgent items for the CEO while it is active and
reachable, the sweep (`ceo/signals.ts`) queues the daily review wake, and urgent signals and schedules' tasks become wakes. Wake sources (`ceo/wakes.ts`) are an event subscriber that fills the operational table `ceo_wakes`; the
dispatcher pass `ceoPass` (`ceo/pass.ts`) batches pending wakes into one `kind: 'ceo'` shift per organisation. The CEO acts
only through the rpc method `ceo` (`ceo/gateway.ts`, `ceo/engine.ts`): every write is checked by `evaluatePolicy`
(`packages/shared/src/ceo/policy.ts`), limited, executed by the existing command functions under `withActingAgent` (events carry
the CEO as actor and the action id as `causation_id`), and audited as `CeoActionTaken`. Owner responses to recommendations are
learning signals (`ceo/learning.ts`). Full design: `docs/design/ceo-agent-v2.md`.

Once per subject (S1b): `ceo_wakes.dedupe_key/dedupe_state` (`NewWake.dedupe`): while a wake with the same key and state is pending, taken or done (24 h), the same subject does not wake the CEO again; a desk item with a card is keyed by the card and the kind, its state is the card's stage and status. `notifyOwner({ once })` and the notify rpc use the subject (card, desk item or task) and its state, not the text, kept in `ceo_flags` (`once:<key>`); the notice's desk item is one per subject with a counter. The `offline_notice` flag is cleared only when a CEO shift has started since it was raised. Models: `settings.models` has `wake`, `review`, `chat` (Sonnet by default) and `handover` (Opus; used for a wake whose reason starts with `handover`); data migration `ceo-models-2026-10` moves only values that still equal the old defaults.

CEO shift failures (backlog #79): whatever ends a CEO shift without its report (the runner's `shift.rejected` reason and detail,
the reaper's 30 s accept timeout, a lost connection, a crash) is written on `ceo_batches.outcome/error`. `ceoPass` backs off
1, 2, 4 ... 30 minutes after shifts the runner never started (rejected, lost; they do not count against `maxWakesPerHour`), raises
one desk notice "Your CEO cannot start: <reason>" after three failures in a row (flag `start_failed`, cleared once a shift is
accepted), frees batches whose shift is gone, and takes every pending wake into one batch whose brief is compact. The CEO
Overview (`GET /api/ceo/status`) returns `lastError`. A CEO shift is held by the server while it has not ended (like question and
BA task shifts), so the heartbeat never stops it as "claim lost".

### 9.6 Hire cap for first runs (removed in M9)

The first-run cap (2 builders, 1 of each other role) and `AOM_FIRST_RUN_HIRE_CAP` are gone; the HR board's recommendations (model, split, fire or reassign) replace the guard rail.

---

### 9.10 Repository hygiene and the working branch

Owner decisions of 2026-10-05 (docs/design/phases.md, addendum "DevOps repository hygiene and the working branch"). Migration `1305_repo_hygiene.sql`: `workstations.hygiene_interval_hours / hygiene_last_at`, `devops_requests.hygiene`, `project_repos.working_branch_set_by / working_branch_set_at / known_branches`, table `hygiene_findings`.

**The working branch is confirmed, never guessed.** `project_repos.working_branch` is NULL until the manager names a branch (`ProjectRepoWorkingBranchSet`). The branch hygiene uses is `effectiveWorkingBranch`: the latest non-final phase's `working_branch`, else the repository's, else none; the project-level `projects.working_branch` default (`main`) is deliberately not a fallback. With none, nothing is committed, pulled or pushed there.

**The scheduled job (`commands/hygiene.ts`, `Scheduler.runHygiene`).** Every 15 s the scheduler tick (when `AOM_HYGIENE_SCHEDULE`, default on) finds active workstations with a DevOps engineer whose `COALESCE(hygiene_last_at, paired_at) + hygiene_interval_hours` has passed (default 24 h; the cadence is per workstation, `PUT /api/workstations/:id/hygiene`) and calls `requestHygiene`. "Run hygiene now" calls the same function. `requestHygiene` builds a `HygieneSpec` (`hygieneSpecFor`: `workstation_repos` joined to `project_repos` and `projects`: local path, remote, effective branch and its source, the project's branch prefix, up to 200 branches of done or cancelled cards), creates one DevOps request carrying it, and queues the runner command `worktrees.sweep`. One hygiene request is open per workstation: a second click or tick returns the open one; a workstation with no clone of a project repository gets none.

**The DevOps shift (`aom hygiene run`, `apps/runner/src/devops/hygiene.ts`).** The agent (or the mock) runs one deterministic command that does the git work per repository and ends the request with `devops_done` whose data carries the structured `HygieneReport`. Rules, in order: fetch `origin` (failure: `auth_failed` or `error`); list the clone's branches (agent branches under the prefix left out); unset working branch: report the uncommitted files and the branches, `needs_branch`, and stop; a working branch that exists nowhere: `branch_missing`. Checkout on the working branch: `git add -A` and commit uncommitted changes (`chore: save work in progress`), `pull --ff-only`, else `pull --rebase` (a failure aborts the rebase: `conflict`), push if ahead (`push -u`). Checkout on another branch: its working tree is not touched (dirty: `dirty_other_branch`, reported); the working branch ref is moved forward from `origin` or pushed when it is only ahead (`conflict` when it diverged). Then local branches of finished cards under the prefix are deleted when they are merged into the working branch, not checked out in any worktree; `git worktree prune`. Every mutating git command is logged in `commands` of `devops_done`.

**Integrations page (migration 1870, `commands/integrations.ts`, `routes/integrations.ts`; design `docs/design/integrations-page.md`).** The runner reports `integrations.report {integrations:IntegrationStatus[], registryVersion, policy?}` (facts only; stored in `workstation_integrations`, an operational table restored by the rebuild) and `integration.session {sessionId, kind, instance, state, prompt?, status?, error?}` (acked; stored on `integration_requests`, which hold the sign-in link and device code, never a secret, and are deleted after a day). The server sends `integration.connect|begin|input|cancel|test|remove`. `connect` and `input` carry a **sealed envelope** (RSA-OAEP-256 wraps an AES-256-GCM key; the AAD binds workstation, request, kind, instance and op), have `runner_commands.expires_at` (10 minutes; a sweep fails and empties the unclaimed ones, and `claimPendingCommands` never delivers an expired one), and their payload is emptied on the result. Every `integration.*` result is terminal. The server never decrypts, logs (pino `redact` on `*.envelope`) or echoes an envelope; events (`WorkstationIntegrationConnected|Removed|SignInStarted`) carry kind, instance, method and the user, never a value. Routes (owner of the workstation only, anyone else 404): `GET /api/integrations/registry`, `GET /api/integrations/workstations`, `GET /api/workstations/:id/integrations`, `POST .../integrations/connect|test|remove`, `POST .../integrations/sessions`, `POST .../sessions/:sid/input|cancel`, `GET .../requests/:rid`; refusals are 409 `workstation_offline|runner_key_changed|runner_too_old|session_busy|request_exists`. A runner that does not announce `integrationsVersion` is shown read-only from the legacy columns (git, Jira, MCP servers, runtimes). Threat model: honest-but-curious server, backups and logs are protected; an actively malicious server (altered JS, swapped public key) is not, which the key id on the page and in `aom-runner doctor`, the local audit log `logs/integrations.jsonl` and `aom-runner integrations allow-web off` mitigate.

**Workstation setup (migration 1370, `commands/workstation-setup.ts`, `projections/environment.ts`).** Events: `RepoCloneRequested{requestId, repoId, projectId, workstationId, mode:'clone'|'create', create?}` and `RepoCloneReported{..., state, detail?, localPath?}` -> `repo_clones` (one row per repository and workstation: `cloning|cloned|created|failed|needs_manager`, shown under the repository in Project settings); `EnvironmentPrepareRequested{requestId, projectId, workstationId, reason}` and `EnvironmentPrepared{..., report}` -> `project_environments` (`preparing|ready|failed|needs_access` with the report); `DevOpsRightsVerified{workstationId, report}` -> `workstations.devops_rights` (made `stale` by `DevOpsAccessChanged`); `DevOpsSudoPasswordSet{workstationId, by, keyId, works?}` / `DevOpsSudoPasswordCleared` -> `workstations.devops_sudo_*`. **No event, log line or DTO carries the sudo password or its ciphertext**; the ciphertext lives only in the payload of the durable `sudo.set` command (emptied when the runner answers) and on the runner. `workstation_keys` (the runner's public key from `hello`) is operational and restored by the projection rebuild. Adding a repository in Project settings (`POST /api/projects/:id/repos`, optional `create:{name, visibility, description}`) queues `repo.clone` for each active workstation of the project's members (a workstation that already reports the clone is recorded as cloned); `POST /api/projects/:id/repos/:repoId/setup` retries; a runner `repos.report` that shows a project repository on a workstation with no `project_environments` row queues `env.ensure`; `POST /api/projects/:id/environment/check` re-runs it; changing the DevOps access queues `rights.verify` and re-runs environments that were `needs_access` or `failed`. **Dispatcher gating:** eligibility clause `env` (`dispatcher/candidates.ts`): a card with a repository, whose stage is claimed by the builder or tester role, is not claimable on a workstation where `project_environments.state <> 'ready'`; `queries/workability.ts` reports it ("the development environment on <workstation> is not ready (...)"). Routes: `GET /api/workstations/:id/sudo-key`, `PUT|DELETE /api/workstations/:id/sudo-password` (202), `POST /api/workstations/:id/verify-rights` (202).

**Applying the report (`hygieneReportEvents`, inside `applyDevopsReport`).** One `HygieneRepoReported`, plus for each `needs_branch` repository a `QuestionRaised` (`subkind 'working_branch'`, asked by the DevOps agent, no card): options are the clone's branches (`branch:<name>`) and `other`; blocking and pinned only when uncommitted changes wait for the answer, otherwise non-urgent. At most one open question per repository (`desk_items.data->>'repoId'`). The routing interceptor treats the non-urgent one like other non-urgent items: held for the BA's triage until `REPORTER.triageWindowMinutes`, then shown unchanged; the blocking one goes straight to the manager with an `urgent_note` task. Answering (`answerDeskItem` hook `workingBranchAnsweredEvents`) maps the option (`branch:<name>`, `keep`, or `other` with the typed name, validated with `isSafeGitRef`) to a `ProjectRepoWorkingBranchSet`, in the same append as the standard `QuestionAnswered` + `LedgerEntryAdded` (the ledger entry is what keeps later shifts from asking again); a branch confirmed for a repository that had none starts a `branch_confirmed` hygiene run right after the commit. The project owner can also set it directly (`PUT /api/projects/:id/repos/:repoId/working-branch`), which settles an open question.

**Re-confirming on change (`commands/branch-confirm.ts`, called from the gateway's event reactions).** `TicketMapped` (an intake mapped to a project), `PhaseCreated{status:'open'}` without its own `workingBranch` and `PhaseConfirmed` raise the same question (`reason 'intake'` or `'phase'`, "Keep `<branch>` ... or use another branch?", recommendation `keep`) for each repository of the project that some workstation holds and that already has a confirmed branch. Skipped when a question is open or the branch was set in the last hour; an unconfirmed repository is left to the hygiene run. Keeping changes nothing; naming another sets it on the repository.

**Findings and signals.** `hygiene_findings` (see events above) feed `detectHygiene` (`ceo/detectors.ts`): signal kind `repo_hygiene`, normal urgency, fingerprint `hygiene:<workstation>:<subject>:<kind>`, resolved by the signal sweep when the finding closes. The CEO's daily report lists them under "Failures".

**The stale-worktree sweep (runner `git/sweep.ts`, server `commands/worktree-sweep.ts`).** At start-up (15 s after the first connection, once per process), and for each hygiene run (`worktrees.sweep`), the runner lists `worktrees/<KEY>-<id>/<REF>`, asks the server `worktrees.query`, and removes the worktrees the server does not call live, removes empty project folders and runs `git worktree prune` in the known clones. The server answers with the paths of cards of this workstation that are not done or cancelled, or are done with a finalize still pending (`finalize_state` set, `finalized_at` null), or whose worktree a live card shares. Conservative: no answer, or messages still in the outbox: nothing is removed; a running shift's worktree is never touched; a worktree with uncommitted changes is never deleted: for a dead card it is reported (`WorktreeSweepReported`, a `dirty_worktree` finding); branches are never deleted by the sweep.

### 9.12 Claude accounts: which account a shift runs on

Each project may name a Claude account (a key such as `work`). The account is chosen **per shift**, not per agent, so an agent may work on several accounts over time. Code: `apps/server/src/dispatcher/accounts.ts`, the resolver `resolveShiftAccount` / `accountUsable` in `packages/shared/src/claude/accounts.ts`.

| Shift | Account |
| --- | --- |
| `card` (claim, preferred and overflow passes) | the card's project account |
| `question` | the project account when the desk item has a `card_id`, else main |
| `ba_task` | the project account when the task has a `card_id` (`spec_card`), else main |
| `devops`, `ceo`, chats (including the CEO owner turn) | always main |

**Resolution** (pure function, run for every candidate):

```
key = project.accountKey ?? 'main'
if usable(workstation, key)                                   -> key
else if key != 'main' && project.fallbackToMain && usable(ws, 'main') -> main   (fallback)
else                                                          -> null          (pause)
usable(ws, k): runtime available, and the runner's accounts[] entry k has login 'ok' and usage 'ok'.
               A runtime without accounts[] (old runner) knows only main, with the legacy rule
               (available, auth not expired, no usage limit in force).
```

- **Gating.** `freeAgents()` offers a workstation while **any** account of its runtime is usable (`runtimeUsable`). Before the card loops, `accountScope()` removes from the candidate query the projects whose account is out (no fallback), or, when main is out, offers only projects that have a usable account. DevOps, CEO, chat and question/BA passes gate on main (`mainUsable`) or on their own resolution, not on the old `available` flag.
- **Claim.** `claim(…, {accountKey})` writes the key into `CardClaimed`. `buildShiftStart` sends `shift.start.account: {key}` only for a non-main key. A card that resolves to null is skipped for that agent (the ticket waits; no penalty).
- **Running shifts keep their account** (the runner pins it in the persisted `active-shifts` file). The next claim, question or BA task resolves again, so a project returns to its account by itself as soon as the runner reports the account usable (no manual step).
- **Limit or expired login mid-shift.** The runner rejects with `usage_limited` or `auth_expired` plus `accountKey` (§11.2). `commands/shifts.ts` patches that account in `workstations.runtimes` at once (`markAccountOut`, so the next pass already knows) and puts the card back **without penalty**. These reasons do not count toward the rejection desk item or the back-off. `runtime_unavailable` with `account_missing:<key>` also marks the account `login: 'none'` and has no penalty.
- **Notices** (`commands/workstation-notices.ts`, `commands/claude-account-notices.ts`): one `claude_usage_limit` notice per (workstation, account), closed on recovery; a `claude_account_login` notice when a referenced account is `none` or `expired`, or when provisioning needs the owner. `usageLimitsFor()` (`queries/usage-limit.ts`) reports each project as `mode: 'paused'` or `mode: 'fallback'`.
- **Provisioning.** Setting a key queues `claude.account.ensure` on every active workstation that serves the org, hosts an active Claude agent allowed on the project, and reports `claude-accounts:1`. On `hello`, a key the runner does not report is asked for at most once per 24 hours (`commands/claude-accounts.ts`). Until the account has a login it is unusable, so its project pauses or falls back.
- **Recovery.** The runner probes each account on its own clock (`probeUsage` / `probeLogin`, every 3 minutes, state in `claude-accounts-state.json`). When the probe clears the account and reports it, the next dispatch pass resolves to the project account again.

## 10. Scheduler and generic schedules (M5, restructure Part B)

A schedule is **a trigger and one action** (`schedules.trigger`, `schedules.action`, both jsonb; `kind` is the denormalized action kind, `cron`/`timezone` the cadence of a cron or polling trigger). The shapes are `ScheduleTriggerSchema` and `ScheduleActionSchema` in `packages/shared/src/events/schedule.ts`; migration `1314_generic_schedules.sql` adds the columns, `schedule_runs`, `schedule_attempts`, `schedule_issues`, the operational `schedule_trigger_cursor` and the `scheduled_brief` BA task kind. Events written before it (no `trigger`, no `action`) read as a cron trigger with `create_card` (`feed`, `card`) or `regression_run` (`legacyAction`), in the projector and in the migration backfill, so a rebuild equals the migrated data (`schedules-generic.test.ts`).

### 10.1 The cron sweep

`apps/server/src/scheduler/scheduler.ts`, every 15 s and on boot: `fireDueSchedules` (`commands/schedules.ts`) selects `enabled AND next_fire_at <= now` with a `cron` or `issue_labelled` trigger, `FOR UPDATE SKIP LOCKED LIMIT 20`. Per schedule, in one append: the action's own events, `ScheduleRunRecorded` (the history entry) and `ScheduleFired{runId, cardId?, firedFor, nextFireAt}`, with the next fire strictly after `now` (missed fires happen once). A suspended organization, an archived project or a switched-off feature skips the fire and records `ScheduleSkipped`. The schedule's owner must still be an active user with access to its project (`assertOwnerStillAllowed`). An action that throws backs the schedule off (1 min doubling to 6 h, `ScheduleFireFailed`, one desk notice per streak, a failed run in the history). Work that must not happen inside the transaction (waking the dispatcher, runner commands, deliveries) is returned as `after` hooks and runs once the append committed.

### 10.2 Actions (`commands/schedule-actions.ts executeAction`)

| Action | What it does |
| --- | --- |
| `create_card` | `scheduledCard` (the old path): `CardCreated{origin:'schedule', scheduled:true}`; the title is expanded with `{date}`, `{week}`, `{event}`, `{ref}`, `{project}`, `{issue...}` (`expandTitle`) |
| `regression_run` | `regressionRunEvents`, one card per platform |
| `devops_request` | `createDevOpsRequestIn` (requested by the system, named after the schedule), or `requestHygiene` for `hygiene: true`; the runner commands are delivered after commit |
| `ba_task` | Enqueues a `scheduled_brief` **CEO wake** (`enqueueWake`, urgency `scheduled`, `detail {scheduleId, scheduleName, instructions, deliver, projectKey?}`); no BA task. The CEO does what the instructions say read-only and delivers the answer with `aom ceo notify --kind task_done`; a wake nobody took in two hours becomes a "was not carried out" notice (section 9.9). Old schedules keep the action name and their ids |
| `integration` `github`/`jira` `issues_poll` | enqueues the runner command `integration.run`; the run stays `pending` until the answer (below) |
| `integration` `webhook` | builds the JSON body (`webhookBody`: generic, `slack`, `teams`; all have a `text`) and stores it with the run as `delivery`; the request is made after commit |
| `integration` `email` | builds the digest text (`commands/schedule-digest.ts`: `floor_report`, `project_summary`; `interests`, the items the interests delivered in the last 24 hours with their failing interests; `registerDigest` stays the hook for more kinds) and stores `{to, subject, text}` as `delivery` |

### 10.3 Event triggers: a cursor sweep

Evaluated by the server, never by an agent. **A sweep, not a hook on the append path** (`commands/schedule-triggers.ts sweepEventTriggers`): `schedule_trigger_cursor` holds the last `events.seq` handled; each sweep reads the matching event types after it (`PhaseCompleted` = `phase_completed`, `CardFinalized` = `card_finalized`, `DigestPosted` of a card of an interest = `interest_run_done`, `ProjectConverted` = `project_converted`, up to the head of the log, finds the enabled schedules of the event's organization whose trigger matches (project and interest filters), and runs the action. Why a sweep: the event log is the source of truth, so a restart, a crash or a slow action never loses an event (the cursor moves only after its events were handled); the action runs after the event's own transaction committed, so a failing schedule can never fail a phase or a card; and the dedupe key `schedule_runs (schedule_id, source_key = 'event:<seq>')` makes a replay run a schedule once. The sweep runs on the scheduler tick and, for latency, 750 ms after the notifier sees new events (`store.subscribe`). A schedule never runs for events older than itself, nor for an event of a project its owner is not on. The first sweep after a deployment starts at the end of the log.

**Labelled issues** (`issue_labelled`): the cron fire enqueues `integration.run` with the label; the answer (`applyIntegrationResult`) runs the action once per issue not in `schedule_issues` (source key `issue:<provider>:<key>`, run trigger `issue`, the issue available as `{issue.key}`, `{issue.title}`, `{issue.url}`). A failing action leaves the issue unseen, so the next poll tries again.

### 10.4 Integrations

- **Runner** (`apps/runner/src/integrations/poll.ts`, command `integration.run`): GitHub through `gh issue list --json` (the owner's own login), Jira through REST search with the token of the runner config. In the mock runtime `<data dir>/mock-issues.json` stands in for both. The result is `{ok, error?, issues:[{key, title, url, body, labels}]}`; a failed poll is an answer (`ok:true, result.ok:false`).
- **Poll answer to intake**: `issues_poll` runs get `ScheduleRunCompleted` with `result.issueKeys`/`intakeIds`; each new issue starts an intake (`commands/intake.ts startIntakeIn`, the role check is the schedule's own authorization). An issue is taken once (`schedule_issues`, projected from the run events); an issue whose intake could not start (no BA online) is tried again.
- **Webhook delivery** (`commands/schedule-delivery.ts`): the run is recorded `pending` with `delivery.body`; `attemptDelivery` posts it outside any transaction (10 s timeout, redirects not followed), then appends `ScheduleDeliveryAttempted`. Headers: `X-AOM-Event` (`schedule.run`, `schedule.test`), `X-AOM-Delivery` (run id), `X-AOM-Timestamp`, `X-AOM-Signature: sha256=hex(HMAC-SHA256(secret, "<timestamp>.<body>"))`. The per-webhook secret (`whsec_...`) is encrypted with `AOM_SECRET_KEY` (`auth/secrets.ts`) inside the action (event and column), shown once at create or rotate and never in a DTO. Retries: 5 tries, pauses 1 min, 5 min, 30 min, 2 h (`webhookBackoffMs`) for 5xx, 429, 408 and network errors; other 4xx answers are final. `deliverDue` (scheduler tick) makes the tries that are due. SSRF: a URL must be http(s) without credentials; loopback, private, link-local and `.local` addresses are refused at creation and, on the resolved address, at every try, unless `AOM_WEBHOOK_ALLOW_PRIVATE` (tests and the e2e stack).
- **E-mail** uses the site mailer (`AOM_SMTP_URL`) and the same retry machinery; a Member or guest may mail only their own address.
- **Test button** (`POST /api/schedules/:id/test`): one signed delivery recorded as a `test` run, never retried, not mirrored to `last_status`.

### 10.5 Authorization (`commands/schedules.ts authorize`)

Project-bound actions: any active member of the project (guests on shared projects included). Organization-level actions (`isOrgLevelAction`: no project, or hygiene) need an Owner or Admin of the organization (the request's `X-AOM-Org`, or the project's). Workstation-bound actions (DevOps, issue polling, the `issue_labelled` trigger) need the workstation's user. Changing an action's kind is refused (`action_kind_fixed`); a feed schedule cannot be created (`use_interests`) but an existing one stays editable. The list shows project-bound schedules to the project's members and organization-level ones to Owners and Admins, plus read-only system rows (hygiene per workstation, the BA floor report per organization) built in `listSystemSchedules`.

"Run now" (`POST /api/schedules/:id/run`) runs the action once with trigger `manual` and records the run; the schedule's timing is untouched (a feed schedule keeps `runFeedNow`).

---

### 10.6 Interests (restructure Part D)

**The model.** An interest is org-level; a hidden backing project (`projects.kind 'interest'`, workflow `feed`, `vault_dir interests/<slug>`) carries its feed and research cards, so the card pipeline, dispatcher, claims, shifts, ratings, transcripts and vault paths work unchanged. `VISIBLE` lists never include it: every list query filters `p.kind = 'project'` (projects, guest orgs, member and guest pages, intake mapping, agent pickers and allow-lists, metrics, the reporter's fallback project, the project limit), `loadVisibleProject` and `requireProjectMember` refuse it with 409 `managed_by_interest` (`{interestId}` in the details) unless the caller works on the interest (`allowInterest`), and the web redirects `/p/<key>/...` to the interest.

**Runs.** `commands/interest-runs.ts interestRunEvents` appends `InterestRunStarted` and a `CardCreated{origin 'interest', scheduled true, interestId, interestRunId, preferredAgents}` (a feed card for a scan from the interest's template with `kinds`, a research card from `researchRunFields` for "Research this"). `fireDueInterests` (scheduler tick, `FOR UPDATE SKIP LOCKED LIMIT 20` on `next_scan_at`) fires the run schedule: a suspended organization or a switched-off feature records `InterestRunFailed{counted false}` and moves on; a scan whose previous run is still open does the same (`previous_run_active`), and so does one whose backing project is paused by its budget (`budget_paused`; a manual run is refused with 409 `budget_paused`); a failure to even start (archived project, missing workflow) backs off like a schedule and opens one `interest_failing` desk alert at the third failure. A manual run while a scan is open is 409 `run_in_progress`. `projections/interest-runs.ts` follows the card's events (claims, stage changes, the scan handoff's candidate count, back-off, cancel, `ResearchPublished`) through `cards.interest_run_id`; `InterestRunDone` is appended with the `DigestPosted` or the publication.

**Delivery.** A digest of an interest is posted `held` (no desk item). `deliveryEvents` turns held items into `InterestDigestDelivered` plus one grouped rating desk item, **within the quiet cap**: `reporting.interestDigestCap` (on the Owner's user row with the other reporting preferences) minus the items delivered in the last 24 hours across the organization's interests (`digest_items.delivered_at`); what does not fit stays held. An immediate interest delivers in the same append as the digest; a scheduled one at `next_delivery_at` (`deliverDueInterests`, scheduler tick), and an immediate interest with items the cap held back tries again each tick. "Deliver now" is the manual path. The floor report, the interests e-mail digest and the Digest tab read only delivered items.

**Preferred agents.** `cards.preferred_agents` is a soft preference: it sorts a card ahead for that agent and lets an agent with a restricted allow-list work the interest's card (`eligibility().scope`); it never reserves the card (no claim window).

**Taste and files** (`commands/taste.ts registerTasteHook`). In the backing project's folder: `feed.md` (a posted digest appends), `runs.md` (a line per finished run), `taste.md` (rating lines routed by the item's card to its interest's folder; the managed `seed` section from `InterestTasteSet`; approved proposals), `INTEREST.md` (a managed `interest` section, version = the event seq). The brief's `feed.tasteSeed` is `interests.taste_rules` (a card of no interest falls back to the read-only `taste_seeds`).

**Data migration `restructure-2026-10`** (`data-migrations/restructure.ts`, boot after `orgs-2026-10`, `restructure:migrate [--dry-run]` CLI). Per organization, in one transaction under `pg_advisory_lock(7331)`: each feed project becomes the backing project of its first interest (`ProjectKindChanged`, which also sets `vault_dir`); its other interests and unadopted feed schedules get a new hidden project (members copied) and an `InterestCreated` / `InterestUpdated` v2 body; `InterestTasteSet` carries the project-wide rules plus the interest's own; every feed schedule gets `ScheduleDeleted`; `InterestMigrated` back-fills `cards.interest_id` (the first interest takes the untagged feed cards, the others first take their schedule's), derives `cards.interest_run_id` and the migrated run log deterministically, and copies the seen-list; the transcripts (operational) are copied in the same transaction; a research-only interest gets a backing project and keeps its research cards as notes. Vault commands are queued durably in order: `vault.move` of the first interest's folder, then the `INTEREST.md` and taste `seed` writes of every interest and an `imported` section with the rating lines for each new folder. One desk alert tells the Owner. A project that is already an interest is skipped, so a crash or a second run changes nothing, and a rebuild reproduces the result (`restructure-migration.test.ts`).

**`vault.move`** (runner `vaults/write.ts moveVaultFolder`): renames the folder in the clone and commits it as one change (git sees renames), then syncs. Idempotent and safe if interrupted: a folder gone from `from` and present at `to` only needs its commit; a folder at both places is merged without overwriting (differing files stay put and are reported); a path through a symlink or one folder inside the other is refused.

### 10.7 Inbound e-mail (`docs/design/workflow-builder.md` D9, migration `1760_inbound_mail.sql`)

**Receiving.** `POST /api/inbound/mail/:provider` (`routes/inbound.ts`) is exempt from the Origin check like the payment webhooks. Its `onRequest` hook checks that `:provider` is the configured `AOM_INBOUND_PROVIDER` (else 404) and the shared secret (`AOM_INBOUND_SECRET` as the Basic-auth password or `X-AOM-Inbound-Secret`, constant-time compare; else 401 and a counter) before the body (up to 36 MB) is read. A provider adapter (`mail/inbound/{postmark,fake}.ts`, registry in `providers.ts`) turns the body into a `NormalizedInbound` (sender, recipients including the `+tag` of a plus-address, subject, text and HTML, `Message-ID`/`In-Reply-To`/`References`, spam score from `X-Spam-Score`/`X-Spam-Status`, SPF/DKIM from `Received-SPF`/`Authentication-Results`, automatic-mail flags, attachment metadata). A new provider is one file with `parse` and one line in the registry. The answer is always 200 for a message we decided about (so the provider does not retry it); only an authentication failure (401) or our own failure (5xx) is retried.

**Routing and isolation** (`mail/inbound/ingest.ts`). The recipient addresses are looked up in `mail_addresses` (one active address per inbox; retired ones are kept so mail to them is recorded as skipped, never delivered elsewhere). No match: dropped and counted (`inbound_counters`). Every later lookup (thread by token, by `In-Reply-To`/`References`, duplicate by `Message-ID`) is restricted to that inbox, so a header or token from another organisation matches nothing. Order of checks for a matched inbox: organisation running, duplicate `Message-ID`, per-organisation hourly rate (`AOM_INBOUND_RATE_PER_HOUR`: over it recorded as skipped without text, at twice it only counted), then the skip reasons `address_retired`, `inbox_disabled`, `rate_limited`, `too_large` (`AOM_INBOUND_MAX_BYTES`), `automatic`, `spam` (`AOM_INBOUND_SPAM_THRESHOLD`) and `sender_check_failed` (DKIM failed and SPF did not pass). Otherwise the text is stored (HTML through `mail/inbound/sanitize.ts htmlToText`: scripts and styles removed, link targets kept as text; at most 100 000 characters), the thread is found or made, and `MailReceived` is appended in the same transaction. A skipped message gets a thread of its own that nothing links to.

**Retention.** `pruneMail` (every five minutes, with the licensing tick) deletes messages older than 180 days, threads left without messages and counters older than 90 days.

**Tables** (operational, no foreign keys to projections, so a rebuild leaves them alone): `mail_inboxes` (label, enabled, `allow_list`), `mail_addresses`, `mail_threads` (`token` for plus-addresses, `card_id`, `untrusted_fields`, `untrusted_title`), `mail_messages` (in and out; unique `(inbox_id, message_id)`; status `received|card_created|draft_created|comment_added|processed|skipped` with `reason`, `auth`, `spam_score`, `allow_listed`, attachment metadata), `inbound_counters`. **Events** (audit trail and trigger feed; none carries a body): `MailInboxCreated`, `MailInboxRotated`, `MailInboxUpdated`, `MailAllowListChanged`, `MailReceived`, `MailThreadLinked`.

**Triggers.** The sweep of 10.3 also reads `MailReceived` (and always reads it, even when no event schedule exists): `addReplyComment` turns a message in a thread that has a card into a card comment (`ThreadMessagePosted`, `data.source = 'email'`, once, because the message leaves `received`), then the enabled `email_received` (not a reply; optional `from` allow-list and `subjectContains`) or `email_reply` schedules of that inbox run once per message (`schedule_runs.source_key = 'event:<seq>'`). The tokens are `email.subject`, `email.body`, `email.from`, `email.date`, `email.thread`; values are inserted verbatim. In `executeAction` a `create_card` run for a message makes the card with `origin 'email'`, forces `start` to `draft` unless the automation says `queued` **and** the sender is on the inbox allow-list **and** `auth = pass`, links the thread (`MailThreadLinked`), records which mapped fields came from the message (`untrusted_fields`: any mapping text that uses `email.subject|body|from`) and sets the message status. `dedupe: 'thread'` keys on the thread id, `'subject_from'` on the normalised subject and the sender. After the run `finishMail` marks a message nobody used `skipped / no_automation`.

**Untrusted content in prompts.** `renderUntrusted(label, text)` (`packages/shared/src/prompt/untrusted.ts`) writes the notice and the text in a code fence longer than any backtick run in the text, with control characters removed and lines imitating the marker defused. `buildBrief` adds `card.untrusted {source, fields, title, from}` for a card whose thread is linked and marks card messages with `data.source = 'email'` as `untrusted` (author name replaced by "E-mail sender"); `renderShiftPrompt` then fences the title (the heading becomes the reference only), the listed fields and those messages. `devopsCardBrief` (the `aom card show` of a DevOps shift) fences the same values. A permission or role is never changed by mail content.

**Outgoing mail** (`mail/threading.ts`). `MailMessage` has `messageId`, `inReplyTo` and `references`; `conversationHeaders` makes deterministic ids (`<kind.key[.id]@domain>`, the domain of `AOM_SUPPORT_FROM`/`AOM_MAIL_FROM` or the public host): the support acknowledgement is the root of a ticket's conversation and each staff reply answers the one before and lists all earlier ones. `mail/inbound/reply.ts sendInThread` sends into an inbox thread with a stored `Message-ID` (a row with `direction 'out'`) and a `Reply-To` of `<inbox address>+<thread token>`, so a reply finds its thread by header or by token.

**Visibility.** `GET|POST /api/mail-inboxes`, `PATCH /:id` (label, switch; `allowList` is Owner only), `POST /:id/rotate`, `GET /:id/messages` (Owner and Admins, own organisation only); `GET /api/platform/inbound` (super admin: provider, domain, secret set, volumes, skip reasons, unknown-address and refused counts, limits). Web: Organization > E-mail inbox (`MailInboxTab`), the e-mail trigger tiles and mapping tokens of the automation wizard, Platform > Inbound mail.

## 11. Runner

### 11.1 Install, pairing, data directory

- Distributed as a tarball/npm package `@aom/runner` with bins `aom-runner` and `aom` (the in-session CLI). Requires Node 22, git ≥ 2.40.
- Data dir `AOM_RUNNER_HOME` (default `~/.aom-runner`; Windows `%LOCALAPPDATA%\aom-runner`):

```
config.json            # 0600: serverUrl, workstationId, runnerToken, repoRoots[], runtimes{claude-code:{bin, authMode, oauthToken?, accounts?[{key, configDir?, source}]}}, maxConcurrentShifts, vaultSyncIntervalSec
claude-accounts-state.json  # 0600: per Claude account (main included) limitedUntil and login 'expired'; restored on start
claude-credentials.lock # runner-wide lock for the main account's credentials copy (additional accounts: <configDir>/.aom-credentials.lock)
secrets/claude-accounts/<key>.json  # token accounts only (0600, same format as secrets/claude.json)
outbox/                # pending acked messages, one JSON file per message id
bin/aom, bin/aom.cmd   # shims to the bundled aom.mjs (prepended to PATH in sessions)
agents/<agentId>/
  home/                # agent HOME/USERPROFILE (.gitconfig with agent identity, tool caches)
  claude/              # CLAUDE_CONFIG_DIR of the main account: CLAUDE.md (regenerated each shift), settings.json, transcripts, memory
  claude-acct-<key>/   # the same agent on an additional account (one per account; `sandbox.ts accountConfigDirName`)
  scratch/
worktrees/<PROJECTKEY>-<project id[:8]>/<CARD-REF>/   # git worktrees (legacy: <PROJECTKEY>/<CARD-REF>, still reused)
integration/<repoId>/                # worktree on the working branch used for merges (M4)
vaults/<vaultId>/                    # vault clones (M3)
logs/runner.log, logs/shifts/<shiftId>.jsonl   # raw runtime stream per shift (local only)
```

- Pairing: in the web UI the user clicks *Pair workstation* → `POST /api/workstations/pairing-codes` returns a code `XXXX-XXXX` (Crockford base32, 40 bits, 10 min TTL, shown once). On the machine: `aom-runner pair --server https://aom.example.com --code XXXX-XXXX --name "Desktop"` → `POST /api/runner/pair {code, name, platform, hostname, runnerVersion}` → `{workstationId, runnerToken}` (token 32 random bytes base64url, prefix `aomr_`). The runner writes `config.json` (0600). Then `aom-runner start` (foreground; users run it under systemd/launchd/Task Scheduler; `aom-runner doctor` checks git, node, claude, docker, connectivity).
- **Several pairings (one runner, several workstations).** `pairings.json` in the data dir indexes the pairings (`{version:1, maxConcurrentShifts?, pairings:[{id, label, dir, serverUrl, workstationId, addedAt, disabled?}]}`). `RunnerHost` (`apps/runner/src/host.ts`) starts one `Runner` per enabled pairing, each with its own data dir (`.` for the first, `pairings/<id>` for later ones; `dir` is validated, never an arbitrary path) and its own server connection, so per-organization isolation (agent homes, worktrees, vault clones, secrets in `config.json`, outbox, IPC) is the existing single-pairing isolation repeated, not new sharing logic. The index is re-read every 5 s (mtime and size) and a changed `config.json` token restarts only that pairing; `pair`/`unpair` write the config before the index so a reader that sees an entry always finds its config. The shared concurrency budget is `Runner.opts.sharedCap`, supplied by the host: machine limit minus the other pairings' running shifts, combined with the per-pairing and server limits by `min`; the shift supervisor's existing `busy` rejection enforces it. A server-side `unpaired` (4403) disables only that pairing (`disabled: "unpaired"`); the process exits when none is left. Server side nothing changes: a workstation is owned by one user (`workstations.user_id`) and serves every organization that user belongs to; two pairings are two ordinary workstations (own token, own `workstation_repos`, own DevOps engineers). Migration of a pre-pairings data dir is in place and non-destructive: `loadIndex` creates `pairings.json` with one entry (`dir: "."`) around the existing `config.json`.
- Repo discovery: the runner scans `repoRoots` (default: none; set with `aom-runner repos add <path>`; each root scanned to depth 3 for `.git`) and reports `{remoteUrl (origin), localPath, headBranch}`. The server matches `remote_url_normalized` against project repos and writes `workstation_repos`. Re-scan on `repos.rescan` command and every 10 min.

### 11.2 WebSocket protocol (`packages/shared/src/protocol/runner.ts`)

Endpoint `wss://<host>/api/runner/ws`, header `Authorization: Bearer aomr_...`, subprotocol `aom.runner.v1`. The server looks up `sha256(token)` in `workstations.token_hash` with `status='active'`; failures close with `4401`. A second connection for the same workstation supersedes the first (old closed with `4409`).

Envelope for every frame (JSON text):

```ts
type Envelope<T extends string, P> = { v: 1; id: string /* uuid v7 */; type: T; ts: string /* ISO */ } & P;
```

Messages marked **acked** are retried until the peer replies `{type:'ack', ackOf:<id>}`. Runner-side acked messages are persisted in `outbox/` before sending and deleted on ack; the server dedupes via `runner_inbox(message_id)` inserted in the same transaction as the resulting events (so a duplicate is acked without effect).

Runner → server:

| type | Payload | Acked |
| --- | --- | --- |
| `hello` | `{runnerVersion, protocol:1, platform, hostname, runtimes:[{id, version, available, capabilities:string[]}], repos:[{remoteUrl, localPath, headBranch}], vaults:[{vaultId, localPath, clean}], activeShifts:[{shiftId, cardId?, agentId, startedAt}], outboxPending:number, maxConcurrentShifts?, sudoKey?:{keyId, publicKey}, integrationsVersion?}` | reply `welcome` (`sudoKey`: the runner's RSA public key for the sudo password, stored in `workstation_keys`) |
| `outbox.flushed` | `{}` | no — sent after resending all outbox entries post-reconnect |
| `heartbeat` | `{activeShifts: string[], load:{runningShifts:number}}` | no |
| `repos.report` | `{repos:[...]}` | no |
| `shift.accepted` | `{shiftId}` | yes |
| `shift.rejected` | `{shiftId, reason:'busy'|'runtime_unavailable'|'repo_missing'|'worktree_failed'|'rebase_conflict'|'internal', detail?, conflictedFiles?, branchProblem?:{base, defaultBranch?, branches[], createFailed?}}` | yes |
| `shift.started` | `{shiftId, runtimeSessionId?, worktree?:{path, branchName, baseBranch, created:boolean, headSha}, branchCreated?:{base, from, pushed}}` | yes |
| `shift.session` | `{shiftId, runtimeSessionId, contextTokens?, resume?:{state:'resumed'|'fresh_unknown_session'|'fresh_too_large'|'fresh_too_old'|'fresh_other_agent'|'fresh_transcript_missing', detail?}}` (Claude's session id arrives after `shift.started`; re-sent while the context grows; `resume` once, for a `shift.start` that carried `resumeSessionId`) | yes |
| `runner.error` | `{signature, message, stack?, version, context?}` (sanitised on the runner; stored once per signature with a counter) | yes |
| `devops.audit` | `{entries:[{at, sessionRef, kind:'shift'|'chat', decision:'allowed'|'refused', rule, command}]}` (the DevOps guard hook's audit trail) | yes |
| `role.smoke` | `{runnerVersion, results:[{roleKey, ok, detail?}]}` (a failed role gets no work on the workstation) | yes |
| `shift.progress` | `{shiftId, items:[{at, kind:'text'|'tool'|'status', text}]}` (batched ≤ 1/s, text ≤ 500 chars each) | no |
| `shift.report` | `{shiftId, reportId, report: ShiftReport}` (§13.4) | yes; server replies `shift.report.result {reportId, accepted, error?}` |
| `shift.ended` | `{shiftId, outcome:'reported'|'no_report'|'stopped'|'crashed'|'timeout', exitCode?, durationMs, usage:Usage, contextTokens?, finalText?:string(≤4000), guardViolations:[{rule, detail}]}` | yes |
| `rpc.request` | `{rpcId, shiftId, method:'card.get'|'ledger.search'|'thread.post'|'thread.read'|'devops.request', params}` | reply `rpc.response` |
| `chat.delta` | `{chatId, threadId, text}` | no |
| `chat.activity` | `{chatId, threadId, seq, segment: ChatSegment, replace?}` (only to a server that announced `chat-activity:1`) | no |
| `chat.done` | `{chatId, threadId, messageText, usage, segments?: ChatSegment[]}` | yes |
| `chat.error` | `{chatId, threadId, error}` | yes |
| `worktrees.query` | `{queryId, paths: string[]}`: the card worktrees the runner found under `worktrees/`; which are still in use? (stale-worktree sweep) | no; reply `worktrees.live` |
| `command.result` | `{commandId, ok, result?, error?}` | yes |
| `vault.status` | `{vaultId, lastPullAt, lastPushAt, error?}` (M3) | no |
| `vault.conflict` | `{vaultId, files[]}` (M3) | yes |

Server → runner:

| type | Payload | Acked |
| --- | --- | --- |
| `welcome` | `{workstationId, serverTime, heartbeatSec:15, limits:{maxConcurrentShifts}}` | — |
| `shift.start` | `{shiftId, claimId, kind:'card'|'question'|'devops', agent: AgentRuntimeSpec, brief: ShiftBrief, worktree: WorktreeSpec|null, prepare:{rebase:boolean}, maxShiftMinutes}` | runner replies `shift.accepted`/`shift.rejected` |
| `shift.stop` | `{shiftId, reason:'timeout'|'claim_lost'|'agent_retired'|'manager'|'card_cancelled'}` | yes |
| `shift.report.result` | `{reportId, accepted, error?}` | — |
| `rpc.response` | `{rpcId, ok, result?, error?}` | — |
| `worktrees.live` | `{queryId, live: string[]}`: the subset of the queried paths that belongs to a live card (not done-and-finalized, not cancelled, known to the server, on this workstation) | — |
| `chat.start` | `{chatId, threadId, agent: AgentRuntimeSpec, message:string, resumeSessionId?, context: ChatContext}` | runner replies with chat.* |
| `chat.cancel` | `{chatId}` | — |
| `command` | `{commandId, command: 'agent.wipe'|'worktree.remove'|'repos.rescan'|'vault.configure'|'vault.write'|'finalize.execute'|'outbound.post'|'repo.create'|'branch.check_merged'|'worktrees.sweep'|'integration.run'|'repo.clone'|'env.ensure'|'rights.verify'|'sudo.set'|'sudo.clear'|'claude.account.ensure', payload}` | runner replies `command.result`. The DevOps setup commands (docs/RUNNER.md "Repository setup, toolchain and rights"): `repo.clone {requestId, repoId, projectId, projectKey, projectName, name, remoteUrl, workingBranch?, create?:{name, visibility, description?}}` answers `{ok, state:'cloned'|'created'|'failed'|'needs_manager', localPath?, detail?, error?}`; `env.ensure {requestId, projectId, repos:[{repoId, name, remoteUrlNormalized}], access}` answers an `EnvironmentReport {state:'ready'|'failed'|'needs_access', stacks, tools:[{stack, tool, status, version?, detail?, fix?}], summary, logTail}`; `rights.verify {access}` answers a `RightsReport {checkedAt, platform, checks:{docker?, sudo?, install?, paths?: {status:'verified'\|'failed', reason, fix?}}, sudoPasswordStored}`; `sudo.set {ciphertext, keyId}` (RSA-OAEP ciphertext; the server empties the payload when answered) answers `{stored, works?, error?}`; `sudo.clear {}` |
| `ack` | `{ackOf}` | — |

```ts
type AgentRuntimeSpec = { agentId; name; roleKey; seniority; runtime; model; effort?; skills: string[]; permissions: AgentPermissions; isDevops: boolean };
type WorktreeSpec = { mode:'create'|'reuse'; repoId; remoteUrlNormalized; baseBranch; branchName; path?: string /* reuse */ };
type ShiftBrief = {
  shift: { id; kind; stage; stageLabel; doneCriteria; outcomes:[{id,label,kind,data}]; maxShiftMinutes };
  card: { id; ref; title; cardType; fields; riskTier; reworkRound; completionAction; docsNeeded; dependencies:[{ref,title,status}]; parent?:{ref,title} };
  project: { id; key; name; workingBranch; e2eGlobs; architecturalGlobs; vaultFolder? };
  role: { key; name; instructions; coreRules: string[]; extensions?: string; skills: string[] };
  handoffs: [{stage, agentName, outcome, note, at}];           // all, oldest first
  reviewComments: [{reviewerName, reasons, criteriaMissed, comments, at}];  // latest rework round
  thread: [{authorName, kind, body, at}];                       // last 30 messages
  standingOrders: [{title, body}];                              // ledger standing orders (M2), org + project
  ledger: [{id, scope, title, body}];                           // entries linked to the card
};
```

**Claude accounts (capability `claude-accounts:1`, `CLAUDE_ACCOUNTS_CAPABILITY`).** Runners that announce it in `hello.capabilities` understand the following. Older runners are never sent `claude.account.ensure`, and their project accounts count as missing (fallback or pause). A non-main `shift.start.account` only arises for a key a runner reported in `accounts[]`, so it is never sent to a legacy runner in practice:

- `hello` and `runtimes.report` `runtimes[]` for `claude-code` carry `accounts: ClaudeAccountInfo[]` (max 20): `{key, main, source: config_dir|token|api_key|default, configDir? (home-relative, display only), email?, plan?, login: ok|expired|none, usage: ok|limited, limitedUntil?, limitedLabel?, detail?}`. The top-level `auth`, `usage`, `limitedUntil`, `limitedLabel` still describe **main**; `available` is true when any account is usable.
- `shift.start` carries `account?: {key}`. Absent = main. Sent only for a non-main key; `ShiftSupervisor` uses it for the whole shift, including a shift resumed after a restart.
- `shift.rejected` carries `accountKey?`. Reasons: `usage_limited` (with `limitedUntil`), `auth_expired`, and `runtime_unavailable` with `detail: 'account_missing:<key>'` (the runner does not have the key; a race guard).
- `RESUME_STATES` gains `fresh_other_account`: the session ran on another account, so the shift starts fresh (`SessionRegistry.decide`, file `<dataDir>/sessions.json` records `accountKey`).
- Command `claude.account.ensure {key, configDir?}` (server → runner; answered with `command.result {ok, result: {key, state: ready|awaiting_login|needs_owner|failed, configDir?, aliasAdded, aliasConflict?, detail?}}`). Idempotent; the runner never adopts a folder or alias it did not create (`apps/runner/src/adapters/claude-account-provision.ts`, §9.12). The server keeps the last answer per key in `workstations.claude_account_ensure`.

Reconnection (runner): exponential backoff with full jitter, base 1 s, cap 30 s; reset after 60 s connected. On connect: send `hello`, wait for `welcome`, resend outbox entries in creation order, send `outbox.flushed`. Running agent sessions continue while disconnected; their `shift.report`/`shift.ended` are queued in the outbox. `shift.progress` and `chat.delta` produced while offline are dropped (chat is cancelled on disconnect: the runner kills the chat process and emits `chat.error` via outbox).

Reconciliation (server, on `outbox.flushed`): for every card with `claim_workstation_id = ws` and a `claim_shift_id` not in `hello.activeShifts` and whose shift is not ended → `ClaimReleased(runner_lost_shift)`. For every `activeShifts` entry whose claim the server no longer holds (e.g. released after 1 h offline) → `shift.stop {reason:'claim_lost'}`; the runner stops the session, discards any unsent terminal report for that shift and keeps the worktree. Then deliver pending `runner_commands` for the workstation in order.

Runner process restarts (decided in M1.5): the runner persists each accepted `shift.start` as `<dataDir>/active-shifts/<shiftId>.json` and deletes it when the shift ends. After a crash or restart it re-runs the persisted shifts under the **same shift id** in the same worktree before connecting, and lists them in `hello.activeShifts`, so the server keeps the claim ("restart within the lease keeps the claim"). A resumed shift does not re-send `shift.accepted`/`shift.started` (unless `shift.started` was never sent). The agent process itself is restarted, not re-attached: Claude sessions start a fresh run on the card branch, the mock agent counts it as the next attempt. If the server released the claim meanwhile (offline past the 1 h lease), `hello` is answered with `shift.stop {claim_lost}` and the runner stops the resumed session. A restart that loses the persisted file (data dir wiped) falls back to `runner_lost_shift` release as above.

Presence: server marks `connected=true` + `WorkstationConnected` on `welcome`, `connected=false` + `WorkstationDisconnected` on socket close or 45 s without heartbeat (WS ping/pong every 15 s too).

### 11.3 Runner command queue

`runner_commands` gives durable delivery to offline runners (`agent.wipe` after a firing, `worktree.remove` after finalize, `vault.write` after an answer, `finalize.execute`, `outbound.post`, `worktrees.sweep` with each repository hygiene run, `integration.run` for an issue poll of a schedule). Delivered on connect and immediately if connected; marked `done` on `command.result ok`; retried with backoff (max 10 attempts, then `failed` + desk escalation). Command handlers on the runner must be idempotent (wiping a missing dir is success; writing an identical vault file is success).

---

### 11.4 Cloud workstations (VPS over SSH, GitHub Codespaces)

Design: `docs/design/cloud-workstations-and-forges.md` Part 1, as adjusted by the owner's decisions C1 to C8. A cloud workstation is a machine somewhere else that runs the ordinary runner; the server adds a record (`cloud_workstations`, migration 1470; an operational table, not a projection, so a rebuild never touches it) plus the means to install, wake and stop it.

- **Records.** `cloud_workstations(org_id, project_id NULL = whole org, user_id, provider ssh|codespaces, state installing|running|stopped|starting|stopping|failed|needs_attention, state_detail, workstation_id, config jsonb, auth_mode api_key|subscription, idle_minutes (30), office_hours, monthly_price_usd, last_activity_at, last_wake_at, problem_notified_at)`. One per organization by default, one per project optionally (`assertSlotFree`, 409 `cloud_workstation_exists`). `cloud_github_connections(user_id, login, token_enc)` holds the user's GitHub token for Codespaces, encrypted (AES-256-GCM, `AOM_SECRET_KEY`, `auth/secrets.ts`). **Never stored**: SSH passwords and keys, and any Claude credential.
- **Services.** `ctx.services.cloud = {ssh, github, pending}` (`cloud/`): `ssh.ts` (`SshConnector` over `ssh2`; host key checked against a stored `SHA256:` fingerprint, trust on first use), `github.ts` (`GithubApi`: user, machines, contents, create/get/start/stop/remove codespace; errors typed `billing|auth|missing|other`). Tests replace both; nothing in the test suite reaches a real SSH server or GitHub.
- **VPS install** (`createVps` then `installVps`, in the background; credentials live only in that closure): connects, then runs the existing installer unattended: `createInstallerSession` (a fresh one-time pairing code) and `curl -fsSL <script url> | GUILDWISE_YES=1 GUILDWISE_SKIP_CLAUDE=1 [GUILDWISE_ALLOW_ROOT=1] GUILDWISE_NAME=... bash`. When it exits 0 the paired workstation is read from the installer session's pairing code; the row becomes `running`. The installer templates are unchanged (they already support unattended runs). Start and stop of a VPS are manual (`manualPower`: wake/stop return 409 `manual_power`) because no provider API is known.
- **Codespaces create** (`createCodespace`): needs a GitHub connection (`POST /api/cloud-workstations/github/connect`, a token with the `codespace` scope), checks the generated `.devcontainer/guildwise/devcontainer.json` exists in the repository, then `POST /repos/{o}/{r}/codespaces` (idle timeout 240, the GitHub maximum, because Guildwise stops it sooner). The devcontainer comes from `devcontainerText` (`packages/shared/src/cloud/devcontainer.ts`) using the stack ids of the runner's toolchain detection.
- **Enrollment** (`POST /api/runner/enroll`, unauthenticated, rate limited): the codespace presents `CODESPACE_NAME` and its own `GITHUB_TOKEN`; the server accepts only a name it created and a token whose GitHub user is the connected account of the user who created it, then pairs through the normal `pairRunner` (a rebuilt codespace may enroll again while its old workstation is not connected; the old one is unlinked). No secret is in the repository file. `GET /api/runner/codespaces-bootstrap.sh` serves the (secret-free) bootstrap script.
- **Wake and stop** (`cloud/tick.ts cloudTick`, called from the scheduler's 15 s pass; Codespaces only): `stopped` + inside office hours + a claimable queued card for an agent on that workstation (`candidateCards`, the dispatcher's own eligibility, so it cannot drift) gives `start`; `running` + no open shift + `idle_minutes` since the last shift/activity (or outside office hours) gives `stop`; `starting` is confirmed by the runner connecting (GitHub `Failed`/`Unavailable` or 15 minutes without a connection is a problem); a `running` row whose runner is gone and whose codespace GitHub reports shut down becomes `stopped`. Wake and stop buttons call the same functions.
- **Problems** (`problem` then `notifyProblem`): GitHub billing/credits/limit errors (402, or 403/422 with billing wording), an expired token, a missing or failed codespace set `needs_attention` and, once per episode (`problem_notified_at`, cleared when it runs again), create a desk alert (`DeskItemCreated`, subkind `cloud_workstation_problem`, addressed to the creating user) and send a branded email (`cloud/mail.ts`).
- **Deploy targets.** A Codespace cannot run Docker: `listMemberWorkstations` and `assertMemberWorkstation` exclude Codespace workstations, and the Workstations page shows a notice when the organization has no Docker-capable workstation or VPS.
- **Cost estimate** (`packages/shared/src/cloud/cost.ts`): VPS = the price the user entered; Codespaces = machine rate times office-hour hours (default 176) plus 0.07 per GB-month of disk. Shown, never billed (C8: the user pays the provider).
- **Routes** (`routes/cloud.ts`, Owner/Admin to change, members to read): `GET/POST /api/cloud-workstations[/vps|/codespaces]`, `PATCH|DELETE /:id`, `POST /:id/wake|stop`, `GET /devcontainer`, `GET/POST/DELETE /github/...`, `GET /github/machines`.

## 12. Runtime adapters

### 12.1 Contract (`apps/runner/src/adapters/types.ts`)

```ts
export interface RuntimeCapabilities { runtime: string; version: string; available: boolean; capabilities: string[] } // 'shell','edit','web','mcp','skills','sandbox_config','resume'
export interface ShiftStartInput {
  shiftId: string; prompt: string;               // rendered card prompt (§13.2)
  instructionsMarkdown: string;                  // rendered role + standing orders + PROJECT.md + aom contract
  cwd: string;                                   // worktree path or agent scratch dir
  sandbox: { home: string; configDir: string; scratch: string };
  agent: AgentRuntimeSpec;
  env: Record<string, string>;                   // AOM_IPC_URL, AOM_SHIFT_TOKEN, AOM_SHIFT_ID, PATH prefix
  addDirs: string[];                             // read access: the vault folder of the card's project
  maxShiftMinutes: number;
  resumeSessionId?: string;                      // chat only
}
export type RuntimeEvent =
  | { kind: 'session'; runtimeSessionId: string }
  | { kind: 'progress'; text: string }
  | { kind: 'tool'; name: string; summary: string }
  | { kind: 'usage'; usage: Usage }
  | { kind: 'final'; text: string }               // last assistant message
  | { kind: 'exit'; code: number | null; signal?: string; error?: string };
export interface RuntimeSession {
  events(): AsyncIterable<RuntimeEvent>;
  stop(reason: string): Promise<void>;           // SIGTERM, then SIGKILL after 10 s (tree kill on Windows)
  usage(): Usage;
}
export interface RuntimeAdapter {
  readonly id: string;
  capabilities(): Promise<RuntimeCapabilities>;  // probed at start and every 10 min
  writeInstructions(sandbox, markdown): Promise<void>; // where this runtime reads instructions
  start(input: ShiftStartInput): Promise<RuntimeSession>;
}
```

Questions, handoffs and verdicts do not come from the runtime stream; they arrive through the `aom` CLI (§13.4) and the shift supervisor merges them into the shift's event stream. This keeps the reporting path identical for every provider that can run a shell command.

### 12.2 Claude Code adapter (`claude-code.ts`)

- `capabilities()`: run `claude --version` (≥ 2.1); capabilities `['shell','edit','web','mcp','skills','sandbox_config','resume']`.
- `writeInstructions`: write `<configDir>/CLAUDE.md` (user-level memory for that `CLAUDE_CONFIG_DIR`). The repo's own `CLAUDE.md` in the worktree is still loaded by Claude Code and is never modified.
- Settings: write `<configDir>/settings.json` per shift (`adapters/claude-policy.ts`, keys verified against the Claude Code docs for 2.1.288; the full table is in docs/RUNNER.md, "Claude Code sandbox and permissions"): `permissions` (`allow` mapped from `allowedTools`: `read`→`Read,Glob,Grep`, `edit`→`Edit(//<worktree>/**)` or one `Edit(//<worktree>/<glob>)` per writable glob, `shell`→`Bash`, `web`→`WebFetch,WebSearch`; `deny`: `Edit,Write,NotebookEdit` without the `edit` tool, `WebFetch,WebSearch` without `web`, the role's shell patterns, git push/rebase/checkout/switch/reset, Edit on the vault/config dir/`.git`, Read on the runner's private files and credential stores; `defaultMode: "dontAsk"`; `blockReadsOutsideWorkingDirectories: true`) and `sandbox` (enabled, `failIfUnavailable`, no unsandboxed retry, per-role filesystem and network lists). `acceptEdits` is not used: it approved every edit in the worktree regardless of the role. **Exception:** shifts of the workstation's DevOps engineer (`agent.isDevops`) get no `sandbox` block and broad permissions (Bash, Read, Edit and web tools anywhere; denies only for the runner's private files, the user's Claude login, the agent's config dir, session tools and `git push`), run with the user's real `HOME` and are not blocked by a missing bwrap/socat; see docs/RUNNER.md, "DevOps shifts are unsandboxed".
- Spawn (execa, `cwd` = worktree, no shell):

```
claude -p <prompt> --output-format stream-json --verbose
       --model <model> [--effort <effort>]
       --permission-mode dontAsk --setting-sources user
       --strict-mcp-config --mcp-config <configDir>/mcp.json
       --add-dir <vault path> ...
env (not inherited from the runner: an allow-list of PATH/LANG/TERM/TZ/proxy and CA variables plus):
     CLAUDE_CONFIG_DIR=<configDir> HOME=<home> USERPROFILE=<home>
     PATH=<dataDir>/bin:<PATH>  AOM_IPC_URL AOM_IPC_SOCKET AOM_SHIFT_TOKEN AOM_SHIFT_ID
     + auth: CLAUDE_CODE_OAUTH_TOKEN (from runner config, created with `claude setup-token`) or ANTHROPIC_API_KEY
     + optional CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 (runtime config `scrubSubprocessEnv`)
```

  In print mode tool calls not covered by `allow` are denied rather than prompted, so the shift never blocks on a permission prompt.
- Stream parsing (`claude-stream-parser.ts`, line-delimited JSON): `system/init` → `session` (session_id); `assistant` content `text` → `progress`, `tool_use` → `tool` (name + first 200 chars of input); `result` → `usage` (`usage.input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) and `final` (`result`); process exit → `exit`. Unknown lines are ignored. Parser is unit-tested against recorded fixtures in `apps/runner/test/fixtures/claude-stream/*.jsonl`.
- Auth fallback (main account, no token configured): if `~/.claude/.credentials.json` exists, the runner **copies** it into each agent's `configDir` at shift start (`adapters/claude-auth.ts` `prepareAgentCredentials`). It is a copy on every platform, never a symlink: a symlink let one agent's token refresh replace the file under the others. The copy is made under the account's lock, after one refresh probe when the access token expires within 10 minutes. After the session `harvestAgentCredentials` writes a newer `claudeAiOauth` or `mcpOAuth` entry back to the account's canonical file. Credentials never leave the workstation.
- Accounts (`adapters/claude-accounts.ts`, `ClaudeAccountRegistry`): `main` plus the additional accounts of `config.json` `runtimes['claude-code'].accounts`. Each account has its own `ClaudeAuthMonitor` and `ClaudeUsageMonitor`, persisted to `claude-accounts-state.json`, and its own credential paths, bound when the session starts:
  - a `config_dir` account (default, `~/.claude-gw-<key>`) has canonical file `<configDir>/.credentials.json`, lock `<configDir>/.aom-credentials.lock`, and probes with `CLAUDE_CONFIG_DIR=<configDir>`. Its agent copy is `agents/<id>/claude-acct-<key>/.credentials.json`. No token variable is set; the login is the copied file.
  - a `token` account (`secrets/claude-accounts/<key>.json`) passes `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, like main's token.
  - Write-back goes only to the session's own account file, even if the config changed mid-session.
  - Login state is `ok`, `expired` or `none`. `none` means no `claudeAiOauth` in the file (or no token): the account is unusable, as an expired one is. The runner watches each config dir's `.credentials.json` mtime on its tick and probes at once when a login appears.
  - `ShiftSupervisor` checks the account before spawning (`adapter.accountGate`): unknown key → `runtime_unavailable` (`account_missing:<key>`), limited → `usage_limited`, `expired` or `none` → `auth_expired`. All carry `accountKey`, and the card goes back without penalty.
  - The CEO owner turn (`buildClaudeOwnerTurnCommand`) and chats use main only. Provisioning refuses `~/.claude` as an account folder.

### 12.3 Mock adapter (`mock.ts` + `mock-agent.ts`)

Deterministic, no tokens; it exercises the real `aom` CLI and IPC path. `start()` spawns `node mock-agent.mjs` with the same env/cwd as Claude would get. The mock agent reads the brief via `aom card --json` and acts by stage and role:

| Stage | Default behaviour |
| --- | --- |
| build | writes `aom-mock/<ref>.txt` (round number + title), adds a unit-test-like file `aom-mock/<ref>.test.txt`, `git commit`, then `aom handoff --note "mock build round N"` |
| review | `aom review approve --score 4 --note "mock approve"` |
| test | `aom test pass --evidence "mock: 1 passed"` |
| docs / finalize / research / feed stages | the stage's first success outcome with a mock note (feed: 2 fake digest items with `https://example.test/...` URLs) |

Overrides via `card.fields.mock` (validated by `MockScriptSchema`): `{ "<stage>": ["<action>", ...] }` consumed by round index, actions `ok | changes | fail | question | crash | hang | no_report | edit_outside_scope`. Example `{ "review": ["changes", "ok"] }` bounces once then approves. Emits `progress` lines every 100 ms and `usage {inputTokens:1000, outputTokens:200}`. Mock capabilities default to all; `config.runtimes.mock.capabilities` can narrow them to test capability filtering. The mock adapter is enabled only when `config.runtimes.mock.enabled` (default false; tests and dev set it).

### 12.4 Other providers

An adapter for another coding agent implements the same interface; its `writeInstructions` writes `AGENTS.md` into its config/home location (never into the worktree). Out of scope for v1 beyond the interface.

---

## 13. Agent shift contract

### 13.1 Shift lifecycle on the runner (`shifts/supervisor.ts`)

1. Receive `shift.start`. Check concurrency (`maxConcurrentShifts`, default 4), runtime availability, repo presence. Reply `shift.accepted` or `shift.rejected`.
2. Prepare sandbox (§13.3) and worktree (§13.5). If `prepare.rebase`: rebase (§13.6); on conflict reply `shift.rejected{reason:'rebase_conflict', conflictedFiles}` → server appends `RebaseConflict` (card → build, Rework) and `ClaimReleased`.
3. Render instructions (`renderInstructions(brief)`) and prompt (`renderShiftPrompt(brief)`) from `packages/shared/src/prompt/`; adapter `writeInstructions`; start IPC token for the shift.
4. `adapter.start`; send `shift.started`; forward progress (batched).
5. On a terminal `aom` report: validate locally (outcome exists for stage), run post-shift guard (§13.7) on the worktree, send `shift.report`. If the server accepts, the CLI tells the agent "Recorded. Finish now; do not make further changes." The runner waits up to 2 min for the session to exit, then stops it.
6. On exit: auto-commit leftovers (§13.7), send `shift.ended` with usage and outcome (`reported` if a terminal report was accepted, else `no_report`/`crashed`/`timeout`/`stopped`).
7. Fallback when no terminal report arrived: parse the last assistant text for a fenced block ` ```aom-report {json} ``` ` matching `ShiftReport`; if present and valid, submit it as the report before `shift.ended`. Otherwise outcome `no_report` → server releases the claim (`shift_failed`) and posts the final text as a system thread message.

### 13.2 What the agent sees

- **Instructions file** (`CLAUDE.md` in the agent's `CLAUDE_CONFIG_DIR`, regenerated each shift), sections in order: *Who you are* (name, role, seniority; "names are handles, not personas"), *Role instructions* (role definition + owner extensions), *Core rules* (immutable rules, e.g. builder: never modify unit tests outside the card's scope; no E2E; tester: change E2E tests only), *Standing orders* (vault `standing-orders.md` + project `standing-orders.md` + ledger standing orders; M2/M3), *Project* (`PROJECT.md` from the card's vault; M3), *How to report* (the `aom` contract below, with the exact allowed outcomes for this stage), *Boundaries* (work only in `cwd`; do not push, rebase, checkout or switch branches; do not touch other worktrees; search the ledger with `aom ledger search` before asking).
- **Prompt** (`-p`): the card rendered as markdown — ref, title, type, risk tier, rework round; Context, Requirements, Acceptance criteria (checklist), Affected areas, Constraints + linked ledger entries, Test plan, Completion action; Dependencies; prior handoffs (all); latest review comments if rework; last 30 thread messages; then *Your job in this shift*: stage label, done criteria, allowed outcomes and the exact `aom` command for each.

### 13.3 Private sandbox (`sandbox/sandbox.ts`)

`agents/<agentId>/{home,claude,scratch}` created on first shift (the OS-level sandbox that confines these directories is described in 12.2 and docs/RUNNER.md); `home/.gitconfig` sets `user.name = "<AgentName> (aom)"`, `user.email = "<agentId>@agents.aom.invalid"`, so commits are attributed to the agent. Everything the runtime accumulates (transcripts, memory, caches) lives under this directory. `agent.wipe` deletes `agents/<agentId>` recursively (and for re-homing, the old workstation's copy is simply abandoned and wiped if that runner ever reconnects).

### 13.4 Reporting: the `aom` CLI (chosen) over local IPC

Rationale: a shell command works for any provider's coding agent (provider neutral), is synchronous so the agent learns immediately whether the report was accepted, and keeps reporting out of free-form text. MCP was rejected as the primary path because not every runtime supports it; structured final JSON is kept only as a fallback (§13.1 step 7).

Transport: the runner runs an HTTP server on `127.0.0.1:<ephemeral>` and on a Unix socket (`AOM_IPC_SOCKET`, which the sandboxed `aom` CLI uses because the sandbox has no loopback route); each shift gets `AOM_SHIFT_TOKEN` (32 random bytes) valid only while the shift runs. `aom` posts JSON to `${AOM_IPC_URL}/v1/report` or `/v1/rpc` with `Authorization: Bearer`. Schemas: `packages/shared/src/protocol/ipc.ts`.

```
aom card [--json]                                  # print the brief
aom ledger search "<query>" [--scope all|feature|decision|standing_order]
aom comment --note "<text>"|--note-file <path>     # non-terminal thread message
aom question --text "<q>" [--option "<a>"]... [--recommend <n>] [--doing "<what I was doing>"] [--non-blocking]
                                                   # terminal when blocking (default): card -> Blocked, end shift
aom handoff --note "<text>"|--note-file <path>     # builder/writer/researcher/scout: stage's success outcome
aom review approve --score <1-5> --note ...        # reviewer
aom review changes --reason <r>[,<r>] --score <1-5> [--criteria-missed "<c>"]... --note ...
aom test pass --evidence-file <path>|--evidence "<text>" [--command "<cmd>"]...
aom test fail --title "<bug title>" --note ... --evidence-file <path>
aom outcome <outcomeId> --note ... [--data-file <json>]   # generic form for custom workflows
aom devops "<request>"                             # M3: ask the DevOps engineer (non-terminal, returns request id)
aom devops-approval --action ... --reason ... --command ...   # M3 DevOps only: terminal, desk approval
aom devops-done --summary ... [--command ...]...  # M3 DevOps only: terminal, EnvironmentChanged
aom publish --file <md> --path <vault-relative> --citations-file <json>   # M6 checker
aom digest --file <items.json>                     # M5 curator
aom finalize                                      # M7 BA: runs the card's own completion action (agents never choose it)
aom answer --item <deskItemId> --text ...          # M7 BA/senior in a question shift
aom escalate --item <deskItemId> --note ...        # M7
aom phase list|propose|assign|submit ...           # BA intake chat: propose a phase and its cards (the manager confirms on the desk)
aom phase followup brief <n> --to devops|tester|ba --text ... ; aom phase ready      # BA task: delegate each follow-up, then say all are briefed (terminal)
aom phase report --summary-file <md> [--outstanding ...]... ; aom phase results --summary-file <md>   # BA task: report the finished phase / the follow-up results (terminal)
aom phase followup done|fail <n> --summary ... [--link <url>]...   # BA task: a custom follow-up the BA did itself (terminal)
aom report triage|notes|signals|floor   # retired: answers "retired" for one runner version (the CEO triages, analyses signals and writes the daily report)
```

`ShiftReport` (zod discriminated union on `kind`): `{kind:'outcome', outcomeId, note, data}` (all sugar verbs map to this) | `{kind:'question', text, options, recommend?, doing, blocking}` | `{kind:'comment', note}` (non-terminal). The server validates `outcomeId` against the card's current stage and `data` against the outcome's `data` schema (`review` = `{score, reasons?, criteriaMissed?}`, `testEvidence` = `{commands[], summary, outputExcerpt}`, `diffStats` = attached by the runner, not the agent). Exactly one terminal report per shift; a second one gets `409 already reported`.

Runner-attached data: for build outcomes the runner computes `diffStats` with `git diff --numstat <merge-base>...HEAD` and matches paths against `project.architecturalGlobs`: `riskTier = large` if added+removed ≥ 200 or any architectural path matched or `cardType = 'refactor'`; otherwise `small` (BA override wins).

### 13.5 Worktrees and branches (`git/worktrees.ts`)

- Branch: `<project.branch_prefix><ref-lowercase>-<slug(title, 40)>`, e.g. `aom/web-12-add-login-page`. Fixed on first claim and stored on the card.
- Path: `<dataDir>/worktrees/<PROJECTKEY>-<project id[:8]>/<REF>` (keys are unique per organization only, so the project id keeps same-keyed projects of two organizations apart on one workstation; worktrees created under the old `<PROJECTKEY>/<REF>` path are reused through the path the server recorded). Paths from the server are confined to `<dataDir>/worktrees` and refs are validated before any git call.
- First claim (`mode:'create'`): `git -C <repo> fetch origin <base>` (skipped if no `origin`), then `git -C <repo> worktree add -b <branch> <path> origin/<base>` (or `<base>` if no remote). Base = repo `working_branch` or project `working_branch`, never another card's branch. `CardClaimed` sets `home_workstation_id`.
- Later stages and rework (`mode:'reuse'`): verify the path exists and is on the branch; if missing but the branch exists, `git worktree add <path> <branch>`; if both missing → `shift.rejected{worktree_failed}` and a desk escalation.
- Bug children reuse the parent's worktree and branch (`worktree_card_id`).
- Removal after `CardFinalized`: `worktree.remove` command → `git worktree remove --force <path>`, and `git branch -D <branch>` only if the completion action was `merge` and the merge commit exists.

**Merge latest main first.** A stage with `syncMainBefore` (code v2 `investigate` and `build`) on the first worktree creation of a card sends `prepare.syncMain {mainBranch?, workingBranch}` (not when the card or project says no, when the repository's main branch is its working branch, on reuse or for bug children). Before `ensureWorktree(create)` the runner (`git/sync-main.ts`, under the per-clone lock shared with the merge completion) merges `origin/<main>` into `origin/<working>` in a throwaway integration worktree and pushes; on a conflict, a protected branch or a failed push the card branch is cut and takes the merge inside its worktree (a conflict stays for the architect, is aborted for any other role). The result is `shift.started.syncMain`, which the server records as `CardMainSynced` (and a desk notice when skipped).

### 13.6 Rebase step (M4)

Before `test` and `finalize` shifts (`stage.rebaseBefore`), the runner (not the agent) runs in the worktree: `git fetch origin <base>`; `git rebase origin/<base>`; on non-zero exit `git rebase --abort`, collect `git diff --name-only --diff-filter=U` beforehand, and reject the shift with `rebase_conflict`. The conflict becomes Rework for the builder with the conflicted files in the event, but first (when the workstation has a DevOps engineer) `cardConflictAttemptEvents` (server `commands/conflict-attempts.ts`) raises a DevOps request with `origin: 'conflict'` for the card and appends `ConflictAttemptStarted`, which parks the card (`status waiting`, `park_problem 'conflict'`) on that request; the dispatcher's unpark pass posts the result on the card thread and releases it to Rework. A card thread note and a desk notice (`conflict_attempt`) make the attempt visible. The attempts are counted per card from `devops_requests`; the third conflict raises a desk escalation (`conflict_unresolved`) instead. Repository hygiene conflicts (`HygieneProblemKind 'conflict'`) follow the same rule per repository (two attempts in 24 hours).

### 13.7 Post-shift guard and auto-commit (`shifts/guard.ts`, `shifts/autocommit.ts`)

Before submitting a terminal report the runner checks the worktree against the role's permissions:

- reviewer / any role with `mayCommit:false`: HEAD unchanged and no working-tree changes, else violation `reviewer_modified_code`;
- tester: every changed path (committed since the shift's start SHA plus uncommitted) matches `project.e2e_globs`, else violation `tester_edited_non_e2e`;
- builder: no changes to test files outside the card's diff that were not created in this card (heuristic: modified files matching test globs that also exist on the base branch and are not in the card's `affectedAreas`) → flag `out_of_scope_test_change` in `diffStats` for the reviewer (not blocking).
- any role: no commits on any branch other than the card branch; no changes outside the worktree.
- architect: every changed path matches `writableGlobs` plus the investigation folder and report path (`architect_edited_non_docs`), except what a merge commit of a recorded `origin/<main>` SHA brought in and nothing changed afterwards; an unfinished main merge is `merge_unresolved`. The report named in `aom design|investigate` must be a committed file in the worktree without obvious secrets (or, for the vault location, is copied into the project vault by the runner).

A violation rejects the report (the CLI prints why so the agent can fix it within the same shift) and is recorded on `shift.ended.guardViolations`. After the session exits, any uncommitted changes in the worktree from roles with `mayCommit:true` are committed by the runner as `aom: <REF> <stage> leftovers (shift <shortId>)` so the next holder sees them.

---

## 14. Chat (M2)

- `POST /api/chats {agentId, projectId?, cardId?}` creates a `chat` thread (`ThreadMessagePosted` history lives in it). Allowed agents: any non-retired agent the user may direct (§17).
- Browser sends `chat.send {threadId, body, clientMsgId}` over `/api/ws`. Server appends `ThreadMessagePosted(kind chat, author user)`, checks the agent's workstation is connected; if not, replies `chat.error {reason:'workstation_offline'}` immediately and nothing is queued.
- Server sends runner `chat.start {chatId, threadId, agent, message, resumeSessionId, context}`; the runner runs one headless call per user message in the agent's sandbox with `cwd` = agent scratch dir (or the card worktree read-only if `cardId`): `claude -p <message> --resume <sessionId> --output-format stream-json --verbose --include-partial-messages`. Deltas stream back `chat.delta` → forwarded to the browser; `chat.done` → server appends `ThreadMessagePosted(kind chat, author agent)` and a `ShiftEnded` for a `chat` shift (tokens count toward the agent). `threads.runtime_session_id` (stored in `data` of the last agent message) is reused for `--resume`.
- Chat sessions do not count against capacity and never claim cards. Within chat the agent has the same `aom` CLI with a chat-scoped token that allows `comment`, `ledger search`, `devops`, and, for the BA in M7, `card create/specify`.
- **Turn timeline (chat activity).** A turn is an ordered list of `ChatSegment`s (`packages/shared/src/protocol/runner.ts`): `text` (an assistant text block), `tool` (`id?`, `name`, `summary?`, `status` running|ok|error|refused; refused = the permission mode denied it) and `thinking` (no content). The runner's `ClaudeStreamParser` reports thinking and text-block starts (from `--include-partial-messages`), tool calls and `tool_result` errors; `ChatManager.finishTurn` builds the segments (Bash summaries pass through the audit redaction). The runner sends `chat.activity {chatId, threadId, seq, segment, replace?}` (best effort, not acked) when a tool starts, when its result arrives (same id, `replace`), when thinking starts and when a new text block starts; text keeps streaming in `chat.delta` and appends to the last text segment. The server forwards it to the browser as `chat.activity {threadId, seq, segment, replace?}` (not stored). `chat.done` carries the full `segments` (optional; at most 300, text segments at most 64k characters, `capChatSegments`); the server stores them in `data.segments` of the agent `ThreadMessagePosted`, sets `body` to the text segments joined with a blank line (else `messageText`, the final answer, which push notifications still use) and sends the browser `chat.done {threadId, messageId, message?}` with the stored `ThreadMessageDto`. Version skew: the server announces `welcome.features: ['chat-activity:1']`; a runner sends `chat.activity` only to a server that did (an older server would log and drop the unknown type); `segments`, `features` and `message` are optional fields.
- **Clearing and bulk close.** `POST /api/chats/archive-all {exceptThreadIds?}` -> `{archived}` closes every open chat of the caller (one `ChatArchived` per chat, one transaction) except the listed ones and the live CEO standing chat (`ceo_settings.chat_thread_id`). `POST /api/ceo/chat/new` ("Clear") starts a fresh standing CEO thread and archives the previous one for the owner (nothing is deleted); it is 409 `turn_in_flight` while a turn of the current thread is queued or running.

## 15. Decision desk, questions and ledger (M2)

- **Raising**: an agent runs `aom question`. The server first runs a ledger full-text search (`websearch_to_tsquery` over `ledger_entries.search`, scoped to the card's org and project + standing orders, `ts_rank` ≥ 0.1, top 3). Hits are stored as `dedupLedgerIds`; the CLI response includes them and, if any hit exists and the question is non-blocking, asks the agent to confirm with `--force`. Then `QuestionRaised`.
- **Routing (escalation chain)**: M2 routes every question to the manager desk (`routed_to='manager'`). M7 adds steps 2–3: if a senior agent of the same role or the card's previous holder is in the org, a `question` shift is dispatched to that agent with the question; it may `aom answer` or `aom escalate`; escalation goes to the BA (another `question` shift), whose escalation lands on the desk. Question shifts have `kind:'question'`, no worktree, and are dispatched with the same candidate ordering but from a separate `desk_items` queue (`routed_to='agent'`).
- **Desk list**: `GET /api/desk` returns open items visible to the user (§17), ordered by `pinned DESC, blocking DESC, cardinality(affected_card_ids) DESC, created_at ASC`. Pinned: `blocking` questions, `tester_bottleneck`, `vault_conflict`, DevOps hard-stops.
- **Answering**: `POST /api/desk/:id/answer {answer, optionId?, ledger:{scope, title?}}` → one append: `QuestionAnswered` + `LedgerEntryAdded` (+ `ThreadMessagePosted` on the card thread). Every card in `card_blockers` for the item with no other open blocker goes back to `queued`. A `vault.write` command writes the decision file (§16.4). Already-answered items return `409`.
- **Direct entries**: `POST /api/ledger {scope, projectId?, cardId?, title, body, tags, onDuplicate?}` lets the manager add requirements and standing orders without a question. A standing order is first compared with the live ones (`commands/ledger-checks.ts`, word overlap): a near-duplicate is refused with `409 duplicate_order` and the existing entry's id (or merged into it with `onDuplicate: 'merge'`); a possible contradiction (same subject, opposite polarity) is saved, flagged by `LedgerEntryFlagged` (`ledger_entries.conflicts_with`) and raises one `ledger_conflict` desk item.
- **Retiring**: `POST /api/ledger/:id/retire {reason, supersededBy?}`, the BA's rpc `ledger.retire` (`aom ledger retire`) and the CEO action `retire-entry` append `LedgerEntryRetired` (`ledger_entries.retired_at/retired_reason/retired_by`). Every read that feeds a prompt or a search (`searchLedger`, `standingOrdersFor*`, `cardLedgerEntries`, the vault rewrite) skips retired entries; the Ledger page lists them only with `includeRetired=true`. `apps/server/scripts/ledger-cleanup-2026-10.ts` applies the owner-approved clean-up (dry run by default, `--apply` writes `LedgerEntryRetired` events).
- **Scope of decisions**: answers and HR/CEO proposals that come from a project stay at its scope (`registerHrHook` writes a project order when the desk item has a project). `projects.decisions_project_only` (event `ProjectPolicySet`) makes the desk refuse `orgWide`, makes HR clustering ignore the project's questions, and the CEO's `propose-order --card` always targets the card's project. HR no longer proposes an order from a card's answer (the "On <word>" rule is gone) and checks for a near-duplicate before proposing. `projects.test_without_environment` (same event) lets a tester shift start without a ready environment (dispatcher `envReady`, `ShiftBrief.testWithoutEnvironment`, `environmentNotReadyEvents` does not park the card on DevOps).
- **Brief caps** (`runner-gateway/brief.ts`, `queries/ledger.ts`): the brief carries the newest 5 card ledger entries as one-liners within 4 KB (`ledgerTotal` says how many exist; the prompt points at `aom ledger search`) and the last 3 thread messages within 3 KB. `aom card` and `aom thread read` still return 30 messages. "Constraints" is the card's own field only; the card's Q&A is under "Decisions on this card".
- **Desk coalescing**: `DeskItemCreated.subjectKey` and `DeskItemRepeated` (`commands/desk-coalesce.ts raiseOrCoalesce`): while an item with the same subject is open, the same subject raises `desk_items.repeat_count` instead of a second item (CEO notices, rejection storms, ledger conflicts).
- **Approvals** (`kind:'approval'`): outbound drafts, large-tier merges, DevOps destructive actions, taste rules, workflow/role definitions. `POST /api/desk/:id/resolve {resolution:'approved'|'rejected', editedBody?, note?}` → `DeskItemResolved` + the domain event (`OutboundApproved`, `WorkflowVersionApproved`, …).

## 16. Vaults, DevOps engineer and external systems

### 16.1 Vault model

- Vault = git repo registered on the site by URL only (`VaultRegistered`): each organization has one **organization vault** (`kind org`, registered by the Owner or an Admin, synced to their workstations only); a project may have its own `project` vault visible to its members. There is no personal vault (migration 1322 and `no-personal-2026-10`, below). The site never stores vault content.
- Layout (per spec): `standing-orders.md`, `projects/<name>/PROJECT.md`, `projects/<name>/decisions/`, `projects/<name>/standing-orders.md`, `projects/<name>/<sub-category>/`, `projects/<name>/taste.md`, plus `org/workflows/<key>/v<n>.yaml` and `org/roles/<key>/v<n>.yaml` for definitions (M10). `<name>` = `projects.vault_folder` (default lowercase project key).
- A card reads only the vault of its project (its project vault, else the organization vault when the shift runs on a workstation of the organization's Owner or an Admin): the runner passes only that clone as `--add-dir` and only that vault's files into instructions. Interests live in the organization vault under `interests/<slug>/`.

### 16.2 DevOps engineer

- Auto-hired on `WorkstationPaired` (same append): `AgentHired{isDevops:true, roleKey:'devops', name:'<generated>', runtime: first available runtime}`. Cannot be fired (`POST /fire` → 409); `POST /api/agents/:id/reset` → `AgentReset` + `agent.wipe`.
- Requests: `aom devops "<text>"` from any shift, or the manager's chat, or `POST /api/devops/requests` → `DevOpsRequested` (thread opened). The dispatcher starts a `devops` shift on that workstation's DevOps agent (capacity 1, FIFO). The DevOps instructions include the workstation's granted access (`workstations.devops_access` jsonb, M3: `{allowInstall:boolean, allowDocker:boolean, allowedPaths:[], sudo:false}`) and the rule: anything destructive or outside access → `aom devops-approval --action ... --reason ... --command ...` (terminal, creates `DevOpsApprovalNeeded` + desk approval). Completion: `aom devops-done --summary ... --command ...` → `EnvironmentChanged` + `DevOpsRequestCompleted`. On approval the request is re-queued with the approval attached.
- Project setup is a DevOps request created by the manager from project settings ("Set up on <workstation>").
- Repository hygiene (a request carrying `hygiene`, see 9.10) is ended with `aom hygiene run` instead of `devops-done`: the runner's deterministic git code does the work and the terminal `devops_done` report carries the structured result.

### 16.3 Vault sync (deterministic runner code, `vaults/sync.ts`)

Vault sync is a runner loop owned by the DevOps engineer's identity, not an LLM session (cheap, deterministic, testable). Per vault on each workstation, every `sync_interval_sec` (default 300):

1. If the clone is missing: `git clone <remote> vaults/<vaultId>` (credentials are the user's own git credentials on that machine).
2. `git add -A`; if changes: `git commit -m "aom sync <workstation-name> <ISO time>"` with the DevOps agent identity.
3. `git pull --rebase --autostash`; on conflict: `git rebase --abort`, send `vault.conflict {files}` → `VaultSyncConflict` + pinned desk escalation; stop syncing that vault until the manager resolves it (desk resolve sends `vault.configure {resume:true}`).
4. `git push`; on reject, retry once from step 3.
Status reported with `vault.status`.

### 16.4 Writes from the site into vaults

The server cannot write vault content, so it issues `vault.write` commands: `{vaultId, path, mode:'create'|'append'|'replace'|'section', content, commitMessage}` to one connected workstation of the vault's owner that holds a clone (preference: the DevOps engineer's most recently seen workstation). The runner writes the file, commits, and pushes in its next sync (or immediately with `push:true`). Used for: decision files on `QuestionAnswered` (`projects/<name>/decisions/<YYYY-MM-DD>-<slug>.md`, ADR-style: Title, Status: accepted, Context (question + who asked + card ref), Decision (answer), Consequences, Ledger id), standing orders added on the desk (append to the right `standing-orders.md`), `taste.md` rules after ratings, definition files for approved workflows/roles.

**Managed sections (`mode:'section'`).** `{mode:'section', section:{id, version}, header, content}` puts a site-managed block between `<!-- aom:section <id> v=<n> begin ... -->` and `<!-- aom:section <id> end -->` markers into a file (`applyManagedSection` in `packages/shared/src/feed`): a missing file becomes `header + block`; a block with `v >= version` is left alone (a stale or repeated write is a no-op without a commit); an older block is replaced between its markers; without a block it is inserted right after the header paragraph, above the first `- ` line. The only user is the explicit taste rules of the Interests page: every `TasteSeedSet` (`commands/taste.ts`) queues one section write of `renderTasteSeedSection` into `projects/<folder>/taste.md`, so the rules sit above the rating lines the append writes add. Edits inside the block are overwritten by design. The server is the source of truth: a shift brief carries the rules (`feed.tasteSeed`: the project-wide ones plus those tagged with the card's `interest_id`) and the runner strips the managed block from the `taste.md` it passes on (`stripManagedSection` in `vaults/context.ts`) so a curator never sees a rule twice. A runner older than this feature rejects a `section` write (zod enum); that only delays the mirror, the brief is unaffected.

### 16.5 External systems (M7/M8)

External credentials (Jira, git hosts) live only on workstations (git hosts: section 16.6). Inbound reads happen inside the BA's intake chat using the Jira skill / `gh` on the user's machine. Outbound posts run on the card owner's workstation via `outbound.post` command handled by a runner-side adapter (`apps/runner/src/outbound/{jira,github}.ts`) with two operations `readSource(ref)` and `postApproved(draft)`. If the owner has no connected workstation the draft stays `approved` and is retried on connect.

M8 as built: the BA drafts with `aom outbound draft` in its Finalize shift (`outbound.draft` rpc); the manager can also write one (`POST /api/cards/:id/outbound`). A server-side leak check (`packages/shared/src/external/leak-check.ts`: agent names of the org plus internal terms) blocks a draft (`OutboundBlocked`, never on the desk) and refuses an edit; the runner scrubs once more before posting. Approval is a desk item `approval/outbound` and only the card's owner resolves it (`DeskItemResolved.editedBody` is the edit; `OutboundApproved.finalBody` is posted exactly). The `outbound.post` command goes to the owner's own workstation (queued durably; approved drafts without a workstation are queued when one connects) and is terminal: the runner answers `{ok, externalRef | error}`, a failure becomes an `outbound_failed` alert plus `OutboundPostFailed`, and the owner retries with `POST /api/outbound/:id/retry`. The runner is idempotent per draft (`outbound/<draftId>.json`; an ambiguous failure first looks for the exact text on the ticket). GitHub: `gh issue comment`, or `gh issue close --comment` for a resolution. Jira: REST `POST /rest/api/2/issue/{key}/comment` with the owner's API token in the runner config (`jira: {baseUrl, email?, apiToken}`, bearer when no email); a resolution is a comment (transitions are workflow specific).

### 16.6 Git hosts (forges) (built Oct 10, 2026)

Design: `docs/design/cloud-workstations-and-forges.md` Part 2, with the owner's decisions G-Q6/C4 (credentials stay on the workstation; the DevOps agent or installer helps set up each connection), C5 (GitLab, Bitbucket, Azure DevOps after GitHub; the user picks the provider per project) and C9 (plain git keeps the direct `merge`, with a protected-branch check where the host is known).

- **Per repository.** `project_repos.forge_kind` (migration `1460_forges.sql`) is the manual choice; the effective provider is `forge_kind ?? detectForgeKind(remote_url)`. Events: `ProjectRepoAdded.forge`, `ProjectRepoForgeSet` (`PATCH /api/projects/:id/repos/:repoId`, project owner). `ProjectRepoDto` carries `forge` and `forgeOverride`. One organization (even one project) can mix GitHub, Azure DevOps and Bitbucket. Kinds: `github`, `gitlab`, `bitbucket-cloud`, `bitbucket-dc`, `azure-devops`, `git` (plain git, also the answer for an unrecognised host).
- **Shared (`packages/shared/src/forge/`).** `parseRemote`, `detectForgeKind`, `CREATE_FIELDS` / `createNameFor` / `cloneUrlFor` (the new-repository form per provider: GitHub owner/name, GitLab group path/project, Bitbucket workspace/repo, Azure organization/project/repo; none for plain git and Bitbucket Data Center), `connectSteps`, the `GitConnection` schema. `normalizeRemoteUrl` (`ids.ts`) maps the https, ssh, `ssh.dev.azure.com:v3/...` and `*.visualstudio.com` forms of an Azure DevOps repository to `dev.azure.com/<org>/<project>/_git/<repo>` and the `/scm/<proj>/<repo>` (https, optional context path) and `:7999/<proj>/<repo>` (ssh) forms of a Bitbucket Data Center repository to `<host>/scm/<proj>/<repo>`, so the same repository is never two repositories. (Rows stored before this change keep their old key until the repository is added again.)
- **Runner adapters (`apps/runner/src/forge/`).** `Forge` interface: `status`, `gitAuth`, `listRepos`, `createRepo`, `defaultBranch`, `openChange`, `changeState`, `branchRules`. `GitHubForge` (the `gh` CLI, GHES through `GH_HOST`), `GitLabForge` (REST, token from `glab config get token` or the runner's token store), `AzureDevOpsForge` (REST with an organization-scoped PAT, or the `az` sign-in for an Entra token), `BitbucketCloudForge` (REST with an Atlassian API token, user `x-bitbucket-api-token-auth` for git), `PlainGitForge` (push a branch only). `forgeForUrl(env, url, override)` picks the adapter; everything machine-bound goes through `ForgeEnv` (executor, `fetch`, token store) so tests stub the CLIs and HTTP. Nothing in a test reaches a real forge.
- **Completion.** `git/completion.ts` uses `forgePrCreator` for `pr` (a plain-git remote, a missing CLI or a missing login give `unavailable`: the branch is pushed and a desk notice says to open the pull request by hand). `merge` first calls `branchRules` for the working branch; when direct pushes are not allowed (or the push is refused with a policy message) the branch is pushed and a pull/merge request is opened instead (`ok`, no merge commit, a notice, the change URL). Unknown rules mean the direct merge as before. Git itself (clone, `ls-remote`, push) gets the credential through `gitAuth`: a helper that reads the token from the git process's environment, never argv.
- **Credentials.** They stay on the workstation: the CLI logins of `gh`/`glab`, or `secrets/git-tokens.json` (0600, 0700 directory) written by `aom-runner git-connect <provider>`. The runner reports facts only: `git.report {connections: [{provider, host, state, account?, method?, detail?}]}` after `hello`, on change (a marker file touched by `git-connect`, polled every 10 s), on rescan and on the `git.status` command; stored in `workstations.git_connections` and shown on the Workstations page and in the repository settings. The server's `repo.clone`/`finalize.execute` payloads carry the provider (`forge`, `create.provider`, `create.host`) but never a credential. This keeps the rule "external credentials live only on workstations" (owner decision G-Q6); the server-held org connections of the design (C4 option) are not built.
- **Agents on every host (F2/F3).** `aom repo create` takes `--provider` (default github) and `--host`; `RepoCreateParamsSchema` validates the provider's name shape (`createFullNameError`). The request keeps `provider`/`host` (`RepoCreateRequested`, `repo_requests` via migration `1500_repo_request_provider.sql`), the desk item names the git host and the runner payload carries them (`createViaForge`); the new project repository is added with that `forge`. `aom git status|connect` are the runner-answered rpcs `git.status`/`git.connect` (`forge/agent-git.ts`), allowed only for the DevOps engineer (chat or DevOps request): a browser/device-code login (`gh auth login --web`, `glab auth login --web`, `az login --use-device-code`) is spawned without stdin, its URL/code is returned to the agent, it finishes in the background and touches the recheck marker; a login that needs a secret is never started and the answer tells the user to run `aom-runner git-connect` or use the Connect helper. `AzureDevOpsForge` order: saved PAT, Microsoft Entra service principal from the runner environment (`AZURE_TENANT_ID`/`AZURE_CLIENT_ID` plus `AZURE_CLIENT_SECRET` or `AZURE_FEDERATED_TOKEN_FILE`, client-credentials token for resource `499b84ac-...`, cached; `GitConnection.method = 'service-principal'`), then `az account get-access-token`.
- **Repository picker.** `POST /api/workstations/:id/git/repos {provider, search}` queues `forge.repos` on the user's workstation and returns a request id; `GET .../git/repos/:requestId` is polled until `done|failed` (`forge_repo_lists`, short-lived, not event-sourced). `POST .../git/recheck` queues `git.status`.
- **Creating a repository** (`repo/create.ts`): GitHub keeps the `gh` flow; the other providers go through `createRepo` of their adapter, then clone, first commit and push, idempotent per request id like GitHub. `aom repo create` (agents) is unchanged and GitHub-only.
- **Not built:** Gitea/Forgejo and CodeCommit adapters, Bitbucket Data Center API support (plain git only), server-held forge connections and webhooks, an `aom git connect` command for agents (the DevOps engineer drives `aom-runner git-connect` for the user in a terminal).

---

## 17. Multi-user scoping and authorization

> **Organizations (October 2026).** The text below was written when every user was an organization (`userId === orgId`). That is gone: `org_id` is an `organizations.id`, the request's organization comes from `X-AOM-Org` (WebSocket: `org` query parameter) or `auth_sessions.active_org_id`, and "org owner" means the organization's Owner or an Admin (`org_members.role`). Section 25 is the current model; where this section says "owner", read "Owner or Admin of the project's organization", and "any user" creating a project is Owner or Admin only.

### 17.1 Visibility predicates (`apps/server/src/authz/scope.ts`, mirrored as pure functions in `packages/shared/src/authz/`)

```sql
-- projects the user can see
SELECT project_id FROM project_members WHERE user_id = $user AND status = 'active'
-- events the user can see (browser WS replay and fan-out)
(audience = 'org' AND org_id = $user)
OR (audience = 'project' AND project_id IN (<visible projects>))
OR (audience = 'admin' AND $isAdmin)
```

Admins get the administration view only; being admin grants no visibility into other users' projects, cards, agents or desk.

### 17.2 Rules

| Action | Allowed for |
| --- | --- |
| Organization members and invitations (`/api/org/*`): invite, resend, revoke, change role, remove | Owner and Admins (Admins only for Members; Owner alone for Admins and roles) |
| Platform (`/api/platform/*`): organizations, new-organization invitations, accounts, audit log | super admin only |
| Pair / rename / unlink own workstation; set DevOps access | the workstation's user |
| Create project | the organization's Owner and Admins |
| Update project, add/remove repos, share/remove members, register project vault | project owner |
| Archive and restore a project | any active project member |
| Delete an archived project permanently | project owner (type-the-key confirmation) |
| Accept/decline project share | invited user |
| View board/cards/threads/desk of a project | active project members (owner + managers) |
| Create card in project | any project member (becomes card owner) |
| Edit card fields, specify, set priority, set completion action, change decision policy, cancel, re-home | card owner or project owner |
| Comment on card | any project member |
| Manual move / release claim | card owner or project owner |
| Answer desk item for a card | `owner_only`: card owner; `any_manager`: any active member. Items always visible to all members |
| Answer project-level desk item (no card) | project owner; DevOps/vault/bottleneck items: the user whose workstation/vault it concerns |
| Create an interest | any member of the organization (Owner, Admin, Member) and a guest of one of its projects (in that organization); a Member or guest is the only member of the backing project besides the Owner and Admins, who see it through their organization grant | Part D |
| Edit, pause or resume, archive, restore, delete, run now, "Research this", deliver now, change the taste rules or the preferred agents of an interest | its creator, or someone whose current role in the organization is at least the creator's (the stored `created_by_rank` once the creator has no relationship with it any more): `canEditInterest`. Seeing needs an active membership of the backing project (404 otherwise) | Part D |
| Share an interest (`POST/DELETE /api/interests/:id/members`) | the Owner and Admins of its organization | Part D |
| Set the quiet cap (`PUT /api/reporting {interestDigestCap}`) | the Owner and Admins | Part D |
| Create and edit phases, assign cards, edit follow-ups, project default follow-ups, deploy targets, confirm a BA proposal, approve / reject the follow-ups, reopen a phase, confirm a merge | any active project member (owner decision A1); every route uses `loadVisibleProject` / `loadVisibleCard`, other users get 404. A remote deploy target's workstation must be an active workstation of a project member |
| Reporting preferences, time zone | the signed-in user for their own organization (each user owns their organization); the BA's `aom report brief` (the CEO-BA review only: `applyReviewReport`); the CEO's `triage` verb dismisses or merges only held non-urgent alerts |
| The BA's `aom phase` verbs | the BA of the conversation (propose, assign, submit: its intake chat) or of the task (`ba_task` shift: only that phase) |
| Hire an agent with any allow-list (including "any project") | the org Owner and Admins, onto own workstation |
| Hire an agent as a Member or guest | onto own workstation, from the org's role catalogue, with an allow-list of projects they are on (never "any project"; 403 otherwise); an agent hired for a guest project belongs to the org that owns the project; refused on archived projects |
| Set an agent's allowed projects or focus (`PUT /api/agents/:id/allowed-projects`, `/focus-projects`) | whoever may change the agent (Owner/Admins, or the hiring manager); a Member or guest manager only names projects they are on; the focus must lie inside the allow-list (400 `focus_not_allowed`); every project must belong to the agent's org (400 `invalid_project`); the DevOps engineer is refused (400 `devops_fixed`) |
| Set a project's concurrency cap (`PUT /api/projects/:id/concurrency-cap`) | any active project member |
| Add a standing order (`POST /api/ledger`, or `ledger.scope=standing_order` when answering a desk item) | project owner for project-wide orders (also when a `cardId` is given: the order is still project-wide); the organization owner for organization-wide orders (a guest manager's answer may carry decisions and requirements, never standing orders) |
| Change an agent's `permissions` | anyone who may change the agent, but only to narrow the role definition; widening non-core limits (web/MCP tools, risk tiers, repos) needs the org owner; the role's hard limits (`edit`/`shell` tools it lacks, `mayCommit`, its denied shell patterns, its writable globs) are never widened (`checkPermissions`, `permissions_exceed_role`); changing the role resets permissions to the new role's; a new version of the agent's own role is followed automatically (`AgentPermissionsRebased`: new role + the agent's deviations) |
| Change / fire / rehome agent | org owner (any agent of the org) or `manager_user_id` (own hires) |
| Direct / chat with an agent | org Owner and Admins for any agent; anyone else for an agent that is allowed on a project they are on (`sharesAllowedProject`, thread linked to that project). Re-checked on every `chat.send` (a removed member or deactivated account cannot keep using an old thread); project chats are labelled "visible to this project's managers" in the UI |
| Extend / reset built-in roles, create custom roles/workflows/departments | org owner |
| Rate digest items, approve outbound for a card | card owner (outbound) / project members (ratings) |

Member removal (`DELETE /api/projects/:id/members/:userId`, owner only): one append with `ClaimReleased(member_removed)` for every card on this project held by the member's agents, then `ProjectMemberRemoved`. The member's agents are re-homed (`manager_user_id = owner`, `status needs_rehome`, `workstation_id NULL`) **only when this was their last access in the organization** (no other active project of the org and no organization-wide grant); otherwise they keep working elsewhere and merely stop qualifying for this project, which also leaves their focus. An org Member keeps their agents until `OrgMemberRemoved`. Cards the member owned move to the owner, and `CardUpdated{ownerUserId: owner}` for cards the member owned (their desk items follow the card). The owner re-homes each agent with `POST /api/agents/:id/rehome {workstationId, runtime, model}` → `AgentRehomed`.

Enforcement: every route calls a guard from `apps/server/src/auth/guards.ts` (`requireUser`, `requireAdmin`, `requireProjectMember(projectId)`, `requireProjectOwner`, `requireCardDecisionRight(cardId)`, `requireAgentHr(agentId)`). Every list query joins the visibility predicate; there is no unscoped list endpoint outside `/api/admin/*`. Integration tests include a two-user isolation suite.

---

## 18. Security

- **Passwords**: argon2id via `@node-rs/argon2` (memoryCost 19456 KiB, timeCost 2, parallelism 1 — OWASP baseline). Minimum length 12, max 256. Login failure responses are uniform; `@fastify/rate-limit` 10/min per IP+email on `/api/auth/login` plus a global 30/min per IP on login, 5/min per account on `/api/auth/password`, 5/min per IP on `/api/runner/pair` and invitation accept.
- **Sessions**: cookie `aom_sid` = 32 random bytes base64url; DB stores `sha256(token)`. `HttpOnly; Secure (prod); SameSite=Lax; Path=/`; 30-day absolute expiry, 7-day idle expiry (sliding `last_seen_at`, updated at most every 5 min). Logout deletes the row; deactivation deletes all of the user's rows and closes their browser sockets.
- **CSRF**: SameSite=Lax cookie + strict `Origin` check on every non-GET request and on WS upgrades (`Origin` must equal `AOM_PUBLIC_ORIGIN`; requests without `Origin` are rejected for cookie-authenticated routes) + mutating endpoints accept only `application/json` (blocks HTML form posts). No CSRF token needed with these three.
- **Runner tokens**: 32 random bytes with prefix `aomr_`; only `sha256` stored (high-entropy secret; slow hashing unnecessary); compared via unique index lookup. Unlink invalidates immediately and closes the socket. Token rotation: `aom-runner rotate-token` (M2 hardening) issues a new token over the authenticated WS.
- **Deactivation**: also unlinks the user's workstations and removes their memberships (see `UserDeactivated`); the runner gateway and the dispatcher additionally refuse any workstation whose user is not `active`.
- **Pairing codes**: single use, 10 min, max 5 attempts per code, stored as `sha256(normalized code)`; at most 3 active codes per user.
- **Invitations**: 32-byte token in the link `/invite/<token>`; `sha256` stored; 7-day expiry; single use (status flip in the same transaction as user creation with `WHERE status='pending' AND expires_at > now()`); resend issues a new token and invalidates the old; revoke invalidates. Accepting checks no existing user with that email.
- **IPC**: bound to `127.0.0.1` and (not Windows) a Unix socket in a private `0700` temp directory, per-shift bearer token, rejected after shift end. A runner may only answer its own `runner_commands` (`command.result` of another workstation's command is dropped).
- **Untrusted owner-controlled strings**: branch prefix, working branches, vault folder and repository/vault URLs are validated in `packages/shared/src/safe.ts` at the API (git ref rules, no leading `-`, no `..`; `https://`, `ssh://`, `git@host:path` only, no userinfo password and no http(s) user name; `file://`/path remotes only with `AOM_ALLOW_LOCAL_REMOTES`) and again by the runner, which also confines every path to its own directories. Migration `1100_scrub_url_credentials.sql` and the projectors scrub credentials from URLs stored before the rule (the append-only guard on `events` is lifted for that one redaction). Feed and citation URLs must be http(s) and the web app renders only http(s) hrefs.
- **Access logs**: invitation tokens (`/api/invitations/<t>`, `/invite/<t>`) and `token=`/`code=` query values are redacted from logged URLs.
- **Headers** (set in the app's `onSend` hook; the behaviour of `@fastify/helmet` without the dependency): `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' <ws(s) origin>; object-src 'none'; base-uri 'self'; form-action 'self' https://www.payfast.co.za https://sandbox.payfast.co.za; frame-ancestors 'none'` (+ `upgrade-insecure-requests` on https), `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`, `Permissions-Policy`, and `Strict-Transport-Security` when `AOM_PUBLIC_ORIGIN` is https (Caddy adds it for real domains too). `style-src 'unsafe-inline'` is needed for React's inline `style` attributes only; there are no inline scripts. All input validated with zod at the route boundary (`fastify-type-provider-zod`).
- **Secrets on the site**: only `DATABASE_URL`, SMTP credentials and `ANTHROPIC_API_KEY` (the landing-page assistant; section 30) in env. Session, runner and invitation tokens are random values looked up by hash, so no signing secret exists to leak.

---

## 19. REST API (`/api`, JSON, zod schemas in `packages/shared/src/api/`)

Errors: `{error: {code, message, details?}}` with 400 validation, 401 unauthenticated, 403 forbidden, 404 not visible (also used for "exists but not yours"), 409 conflict/state, 429 rate limited.

| Method & path | Purpose | Milestone |
| --- | --- | --- |
| `GET /api/health` | liveness + DB check | M1 |
| `PUT /api/workstations/:id/hygiene` `{intervalHours: 0|1|6|12|24|168}` | the workstation's repository hygiene cadence (0 = off; owner of the workstation) → the workstation DTO with `hygiene` | hygiene |
| `POST /api/workstations/:id/hygiene/run` | "Run hygiene now": one hygiene DevOps request (201), or the one already queued/running (200, `alreadyRunning`); 409 `no_repositories` when the workstation holds no clone of a project repository | hygiene |
| `PUT /api/projects/ranking` `{projectIds[]}` | the Owner or an Admin orders the organization's active projects, most important first; the list must name every active project once (409 `ranking_stale` otherwise) → `{projects}` | `ProjectsRanked` |
| `PUT /api/projects/:id/repos/:repoId/working-branch` `{branch}` | the project owner confirms or changes the repository's working branch (`ProjectRepoWorkingBranchSet`) → project detail | hygiene |
| `POST /api/auth/login` `{email,password}` | set session cookie | M1 |
| `POST /api/auth/logout` | | M1 |
| `GET /api/auth/me` | user, isAdmin, visible project ids | M1 |
| `POST /api/auth/password` `{current,new}` | change password | M2 |
| `GET /api/invitations/:token` | validate link → `{email, expiresAt}` | M1 |
| `POST /api/invitations/:token/accept` `{displayName,password}` | create account, log in | M1 |
| `GET /api/admin/users` · `PATCH /api/admin/users/:id` `{role?, status?}` | admin | M1 |
| `GET /api/admin/invitations` · `POST /api/admin/invitations` `{email, role}` · `POST /api/admin/invitations/:id/resend` · `POST /api/admin/invitations/:id/revoke` | admin | M1 |
| `GET /api/admin/workstations` · `POST /api/admin/workstations/:id/unlink` | admin | M1 |
| `GET /api/workstations` · `PATCH /api/workstations/:id` `{name}` · `POST /api/workstations/:id/unlink` | own workstations (incl. connected, runtimes, repos) | M1 |
| `POST /api/workstations/pairing-codes` | → `{code, expiresAt}` | M1 |
| `POST /api/runner/pair` `{code,name,platform,hostname,runnerVersion}` | unauthenticated; → `{workstationId, runnerToken}` | M1 |
| `GET /api/projects` (`?status=active\|archived\|all`, default `active`: archived projects never appear unless asked for) · `POST /api/projects` · `GET /api/projects/:id` (also for an archived project, so shared members see the state) · `PATCH /api/projects/:id` | | M1 |
| `GET /api/projects/:id/impact` (open shifts, open cards, enabled schedules, open desk items: the archive dialog) · `POST /api/projects/:id/archive` · `POST /api/projects/:id/restore` · `POST /api/projects/:id/delete` `{confirmKey}` | archive lifecycle | — |
| `POST /api/projects/:id/repos` `{name, remoteUrl, workingBranch?}` · `DELETE /api/projects/:id/repos/:repoId` | | M1 |
| `GET /api/projects/:id/convert-preview?toWorkflowKey=` · `POST /api/projects/:id/convert` `{toWorkflowKey, repos[], defaultDecision, cardDecisions, note?}` → `{status:'converted'\|'waiting', cancelledCards, keptCards, repoRequests[], project…}` · `DELETE /api/projects/:id/convert` (cancel a waiting conversion) | convert a project to another workflow (Owner and Admins); 409 `conversion_pending`, 400 `repo_required` `same_workflow` `invalid_target` `invalid_card` | Part C |
| `POST /api/projects/:id/members` `{email}` · `POST /api/projects/:id/members/accept` · `POST /api/projects/:id/members/decline` · `DELETE /api/projects/:id/members/:userId` | sharing | M3 |
| `GET /api/board?projectId=` | columns with card summaries (ref, title, assignee, age, risk tier, blocked, rework round) | M1 |
| `POST /api/cards` `{projectId, title, cardType, fields, repoId?, completionAction?, docsNeeded?, priority?, dependencies?, specify?:boolean}` | create (draft, or specified if `specify` and valid) | M1 |
| `GET /api/cards/:id` | card + handoffs + transitions + thread + current shift. `:id` is the card uuid or a ref; a ref that matches cards in more than one of the caller's projects (same key in two organizations) is `409 ambiguous_ref` with `details.candidates` (use the uuid; the web app links by uuid) | M1 |
| `PATCH /api/cards/:id` | edit fields (owner) | M1 |
| `POST /api/cards/:id/specify` | → 422 with `missing[]` if required fields absent | M1 |
| `POST /api/cards/:id/comments` `{body}` | | M1 |
| `POST /api/cards/:id/move` `{toStage, reason}` · `POST /api/cards/:id/release` · `POST /api/cards/:id/release-backoff` · `POST /api/cards/:id/cancel` | manager overrides | M1 |
| `POST /api/cards/:id/decision-policy` `{policy}` | | M3 |
| `POST /api/cards/:id/rehome` | | M3 |
| `POST /api/cards/:id/finalize` `{action?}` | manager-triggered finalize | M4 |
| `GET /api/agents?projectId=` · `POST /api/agents` (hire) · `PATCH /api/agents/:id` · `POST /api/agents/:id/fire` · `POST /api/agents/:id/reset` · `POST /api/agents/:id/rehome` | | M1 (rehome/reset M3) |
| `GET /api/agents/name-suggestions?theme=&count=` | name generator (skips used + retired names) | M1 |
| `GET /api/roles` · `GET /api/workflows` | catalogue (built-in + org) | M1 |
| `GET /api/shifts?agentId=&cardId=` · `GET /api/shifts/:id` · `POST /api/shifts/:id/stop` | | M1 |
| `GET /api/desk` · `POST /api/desk/:id/answer` · `POST /api/desk/:id/resolve` · `POST /api/desk/:id/dismiss` | | M2 |
| `GET /api/ledger?q=&projectId=&scope=` · `POST /api/ledger` | | M2 |
| `POST /api/chats` · `GET /api/threads/:id/messages?before=` | | M2 |
| `GET /api/vaults` · `POST /api/vaults` · `PATCH /api/vaults/:id` | | M3 |
| `POST /api/devops/requests` `{workstationId, summary, cardId?}` · `GET /api/devops/requests` · `PATCH /api/workstations/:id/devops-access` | | M3 |
| `POST /api/projects/:id/regression` `{platform}` | | M4 |
| `GET/POST /api/schedules` · `PATCH/DELETE /api/schedules/:id` · `POST /api/schedules/:id/run` · `GET /api/schedules/:id/runs` · `POST /api/schedules/:id/test` · `POST /api/schedules/:id/rotate-secret` | `GET` returns `{schedules, system}`; `POST` takes `{name, trigger, action, enabled}` (or the legacy `{projectId, kind, cron, timezone, cardTemplate}`) and, for a webhook, answers with `webhookSecret` once; `ScheduleDto` carries `trigger`, `action` (no secret), `orgLevel`, `canEdit`, `lastStatus`, `interestId`/`interestName` (PATCH/DELETE of a linked schedule is a 409) | M5, Part B |
| `GET /api/interests?status=&archived=` (interests with stats, the quiet cap, the items delivered in the last 24 hours) · `GET /api/interests/:id` (the interest, its notes, its taste rules and rating lines, its members) · `POST /api/interests` · `PATCH /api/interests/:id` (the patch forms of `scan` and `delivery` have no defaults) | the Interests page | Part D |
| `POST /api/interests/:id/archive` · `/restore` · `DELETE /api/interests/:id?confirmSlug=` (409 `not_archived`, 400 `slug_mismatch`) · `POST /api/interests/:id/run {kind: 'scan'\|'research', question?, depth?, sourceItemId?}` → `{runId, cardId, ref}` (409 `run_in_progress` with the open scan's ref; `mock` only with `AOM_MOCK_UI`) · `POST /api/interests/:id/deliver` → `{delivered, heldBack}` (400 `quiet_cap_reached`) | lifecycle and runs | Part D |
| `GET /api/interests/:id/runs?before=&limit=&kind=` (the run log, ratings joined) · `GET /api/interests/:id/runs/:runId` (items with transcript status, notes, the shifts of the card) · `GET /api/interests/:id/deliveries` · `GET /api/interests/:id/digest?status=` (delivered items, oldest first) · `GET /api/interests/:id/agents/eligible` | read side | Part D |
| `PUT /api/interests/:id/taste {rules}` · `POST /api/interests/:id/taste/resync` · `POST /api/interests/:id/members {userId}` · `DELETE /api/interests/:id/members/:userId` | taste rules (versioned; the hook mirrors the managed section) and sharing | Part D |
| Removed: `/api/interests/adoptable`, `/api/interests/adopt`, `/api/projects/:id/taste-seed`, `/api/projects/:id/taste`, `/api/projects/:id/feed`, `/api/projects/:id/feed/run`; a feed schedule or a feed project cannot be created (400 `use_interests`); the project routes answer 409 `managed_by_interest` for a backing project | | Part D |
| `POST /api/cards` gains `interestId?` (a research card in an ordinary project that cites an interest the caller can see); `GET /api/digest-items` (delivered items only) and `GET /api/research/publications` gain `interestId`; `GET /api/desk` gives a digest rating item its `interest {id, name}` | "Research this" in a project, the desk link | Part D |
| `GET /api/digest-items?projectId=` · `POST /api/digest-items/:id/rate` `{verdict, reason?}` | | M5 |
| `POST /api/intakes` `{externalSystem?, externalKey?, note}` | start BA intake chat | M7 |
| `GET /api/outbound` · (approval via desk resolve) | | M8 |
| `GET /api/metrics?projectId=&from=&to=` · `GET /api/agents/:id/stats` · `GET /api/hr/recommendations` · `POST /api/hr/recommendations/:id/apply` | | M9 |
| `GET/POST /api/projects/:id/phases` · `GET /api/phases/:id` · `GET /api/phases/by-number/:key/:number` · `PATCH /api/phases/:id` · `PUT /api/phases/:id/followups` (409 `followups_frozen` once approved) · `POST /api/phases/:id/reopen` `{reason}` (409 `cannot_reopen` after approval) | phases and their follow-ups | phases |
| `PUT /api/cards/:id/phase` `{phaseId\|null}` (409 `card_terminal`, `phase_not_open`, `wrong_project`, `not_a_member_card`) · `POST /api/cards/:id/confirm-merged` · `GET /api/board?projectId=&phaseId=\|none` (cards carry a `phase` chip) | assignment, merge confirmation, board filter | phases |
| `GET/PUT /api/projects/:id/followup-defaults` · `GET/POST /api/projects/:id/deploy-targets` · `PATCH/DELETE /api/deploy-targets/:id` (409 `target_in_use`) | defaults and deploy targets | phases |
| `GET/PUT /api/reporting` `{dailyAt?, interestDigestCap?}` · `PUT /api/auth/timezone` `{timezone}` (400 `invalid_timezone`) | Report settings of the caller's organization (`dailyAt` is the default for the CEO's `reportAt`; `routeViaBa` is gone from the API); the manager's IANA time zone (`UserDto.timezone`, `DeskItemDto.baNote / triage / chatThreadId / floor`) | reporter |
| `POST /api/roles` · `POST /api/workflows` (draft) · `PUT /api/roles/:id` · `PUT /api/workflows/:id` · `POST /api/roles/:id\|workflows/:id/validate` · `…/submit` · `DELETE /api/roles/:id\|workflows/:id` (drafts only) · `PUT /api/roles/:key/extensions` · `POST /api/roles/:key/reset` · `GET/POST /api/departments` · `GET /api/org/catalogue` · `GET /api/org/definitions/:id/file`; all take `?projectId=` | org designer | M10 |

## 20. Browser WebSocket (`/api/ws`, `packages/shared/src/protocol/browser.ts`)

Authenticated by the session cookie at upgrade (+ Origin check). Messages `{type, ...}`:

- Client → server: `hello {lastSeq?}`; `chat.send {threadId, body, clientMsgId}`; `chat.cancel {threadId}`; `shift.watch {shiftId}` / `shift.unwatch {shiftId}`; `ping`.
- Server → client: `ready {seq}`; `event {event: VisibleEvent}` where `VisibleEvent = {seq, type, streamId, payload, actor, projectId, createdAt}` for events passing the visibility predicate; `resync {}` if `lastSeq` is more than 500 visible events behind (client then invalidates all queries); `shift.progress {shiftId, cardId, items}` (only to watchers who can see the card); `chat.delta {threadId, text}`, `chat.done {threadId, messageId}`, `chat.error {threadId, reason}`; `presence {workstationId, connected}`; `pong`.

The web client maps event types to TanStack Query keys in `apps/web/src/ws/invalidate.ts` (e.g. any card event → `['board', projectId]`, `['card', cardId]`; agent events → `['agents']`; desk events → `['desk']`). No client-side event projection in v1.

## 21. Web app

Routes: `/login`, `/invite/:token`, `/` (redirect to last board), `/p/:projectKey/board`, `/cards/:ref` (detail: fields, timeline from transitions + handoffs, thread with comment box, current shift live log, manager actions), `/cards/new`, `/projects` + `/projects/:id/settings` (repos, members, vault folder, globs), `/agents` (M1 list + hire/fire form; becomes HR board in M9), `/workstations` (pairing code, connection state, repos/runtimes reported, unlink), `/admin` (users, invitations, all workstations), `/desk` (M2), `/ledger` (M2), `/chat/:threadId` (M2, mobile friendly), `/schedules` (M5), `/p/:projectKey/research` (Research tab: published notes, citations, transcripts; shown for projects with notes or that started as research), the Stage panel and `ConvertProjectDialog` in project settings (and on the research board header), `/interests` (the Interests page, with the quiet cap) and `/interests/:id` (one interest: `?tab=overview|runs|digest|settings|taste`; `/interests?open=<id>`, `/p/:key/feed` and the board of a hidden project redirect to it), `/hr` (M9), `/org` (M10), `/org-chart` (the organization chart, section 26), `/costs` (Owner and Admin, section 26); project and interest settings carry the Monthly budget panel, the board header and project settings a spend line and a `BudgetBanner`. API client: `fetch` wrapper with `credentials:'include'` and JSON; zod-parses responses in dev only. Tailwind; no component library in v1 except Radix primitives for dialogs/menus (`@radix-ui/react-dialog`, `@radix-ui/react-dropdown-menu`).

## 22. Configuration, ports and deployment

Server env (`apps/server/src/config.ts`, zod-validated):

| Var | Dev default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://aom:aom@127.0.0.1:5433/aom` | tests: `.../aom_test` |
| `AOM_PORT` / `AOM_HOST` | `4600` / `127.0.0.1` | `0.0.0.0` in container |
| `AOM_PUBLIC_ORIGIN` | `http://localhost:5173` | used for links, Origin check, cookie Secure flag (https) |
| `AOM_SMTP_URL` | `smtp://127.0.0.1:1025` | Mailpit in dev |
| `AOM_MAIL_FROM` | `Guildwise <noreply@aom.local>` | |
| `AOM_SUPPORT_FROM` | unset | From of the support autoresponder and the super admin's replies (`MailMessage.from`); unset: `AOM_MAIL_FROM` |
| `ANTHROPIC_API_KEY` | unset | **Secret.** Key of the Anthropic API for the public landing-page assistant (section 30). Server environment only; never in the web bundle, a response, an event or a log. Unset: the assistant is off |
| `AOM_ASSISTANT` | `public` with a key, else `off` | Kill switch of the assistant (`off` or `public`) |
| `AOM_ASSISTANT_PUBLIC_DAILY_USD` / `AOM_ASSISTANT_MODEL_PUBLIC` | `2` / `claude-haiku-4-5` | Initial default of the daily spend ceiling in US dollars (the super admin overrides it, `platform_settings.assistant_daily_cap_usd`); model id |
| `AOM_MIGRATE_ON_BOOT` | `true` | |
| `AOM_FIRST_RUN_HIRE_CAP` | `true` | until M9 |
| `AOM_SERVE_WEB` | `false` (dev), `true` (prod) | serve `apps/web/dist` |
| `LOG_LEVEL` | `info` | |
| `AOM_REPORTER_SECONDS` | `60` | The signal sweep (`ceo/signals.ts`): expired holds, signal detectors, the CEO's daily review wake, research topics |
| `AOM_WEBHOOK_ALLOW_PRIVATE` | `false` | outgoing schedule webhooks may reach loopback and private-network addresses (local tests and the e2e stack; leave off in production) |
| `AOM_HYGIENE_SCHEDULE` | `true` | the scheduled repository hygiene job (each workstation's own cadence, default daily); `false` leaves only "Run hygiene now" (the e2e stack) |
| `AOM_TEST_CLOCK` | unset | test only: enables `POST /api/test/clock {offsetMs}`; all server time comes from `clock.now()` |

First admin: `pnpm --filter @aom/server admin:create --email ... --name ...` (prompts for password) → `UserBootstrapped`.

Production (`docker-compose.prod.yml`): services `postgres` (postgres:18, volume, not exposed), `server` (image from `Dockerfile`: stage 1 `pnpm install --frozen-lockfile && pnpm -r build`, stage 2 `node:22-slim` with `apps/server/dist/main.mjs` + `apps/web/dist`, runs migrations on boot, healthcheck `/api/health`), `caddy` (caddy:2, `reverse_proxy server:4600`, automatic TLS for `AOM_DOMAIN`; WS proxied transparently). Deviation from "app + Postgres": Caddy added because Secure cookies and `wss://` for runners require TLS; it is a config-only container. The runner is distributed separately (`pnpm --filter @aom/runner pack` → `aom-runner-<version>.tgz`; `npm i -g` it).

## 23. Testing strategy

| Layer | Tool | What |
| --- | --- | --- |
| shared | vitest | workflow validation (each rule has a failing fixture), `resolveOutcome`, `columnFor`, `requiredMissing`, prompt rendering snapshots, every zod protocol message round-trip |
| server integration | vitest + `aom_test` | `globalSetup` migrates; `beforeEach` truncates all tables (`TRUNCATE ... RESTART IDENTITY CASCADE`); Fastify `inject` for REST; real WS via `ws` client for runner + browser gateways; Mailpit API (`http://127.0.0.1:8025/api/v1/messages`) to read invitation emails, or a capturing transport in unit runs |
| key server tests | | concurrent claim (50 parallel → 1 winner); dispatcher ordering (scheduled > work > own rework > other rework > To do; dependencies; repo presence; home workstation; capacity; senior-only; excluded agents); lease expiry → requeue; reconnection reconciliation; projection rebuild equals live state (replay test); two-user isolation; decision-policy authorization |
| runner | vitest | temp git repos (`git init --bare` origin + clone) for worktree create/reuse/rebase-conflict/guard; claude stream parser fixtures; mock adapter end-to-end against an in-process fake server implementing the protocol; outbox persistence across restart |
| E2E | Playwright | starts server (port 4601, `aom_test`), Vite preview, and a runner with the mock adapter in a temp data dir against a temp git repo; flows per milestone |
| Claude smoke | vitest, opt-in `AOM_CLAUDE_SMOKE=1` | one real `claude -p` shift on a toy repo with a trivial card (manual, spends tokens) |

Root scripts: `pnpm test` (all vitest), `pnpm e2e`, `pnpm typecheck` (`tsc --noEmit -p` per package), `pnpm lint` (biome), `pnpm dev` (server + web via `concurrently`), `pnpm runner:dev` (runner with `--data-dir .dev/runner`).

## 24. Resolved ambiguities and defaults

1. **Organization = user.** One org per user; agent names unique per org forever (retired included).
2. **Card owner** = the user who created or imported the card.
3. **Rework and Blocked are not stages.** Rework = `build` stage with `rework_round > 0` (or bug card); Blocked = status overlay; columns derived (§6.5).
4. **Test failure before finalize** creates a bug child card on workflow `code-bugfix` that shares the parent's worktree and branch and is routed to the original builder first; the parent waits in Test until the child passes review, then re-enters the Test queue.
5. **Post-finalize failures and regression bugs** create standalone bug cards in Spec for the BA (M4) and never block merges.
6. **Dependencies** gate the first build claim until every dependency is done (finalized); dependent cards still branch from the working branch. Branching from a dependency's branch is out of scope for v1.
7. **Card pinning to a workstation**: after the first claim creates the worktree, all later stages run on that workstation (`home_workstation_id`). Cards do not move between workstations; the manager can re-home a card (restarting its current stage from the base branch). Card branches are never pushed except by the completion action.
8. **Offline timeout** is implemented as a 1-hour lease refreshed by 15 s heartbeats.
9. **Large-tier review** = two approvals from two distinct senior reviewers, sequentially.
10. **Instructions** are written to the agent's own `CLAUDE_CONFIG_DIR/CLAUDE.md`, not the worktree's `CLAUDE.md` (which belongs to the repo and must not be modified or committed).
11. **Agent reporting** via the `aom` CLI over a localhost IPC with a per-shift token; fenced `aom-report` JSON in the final message is a fallback.
12. **Provider credentials** stay in the runner's local config (`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`) or are linked from the user's default Claude config; never sent to the site.
13. **Vault sync, rebases, worktree management and completion actions** are deterministic runner code; LLM DevOps shifts handle only ad-hoc requests (setup, tools, environment).
14. **Decision files and taste rules** reach the vault through `vault.write` runner commands, since the site holds no vault content.
15. **Escalation chain** (M7 replaced the M2 default of going straight to the desk): a question goes to the card's previous holder or a senior agent of the asker's role (an online agent only), then to the BA, then to the manager's desk; an agent answers with `aom answer` (a note on the card thread, not a ledger entry) or passes it on with `aom escalate`. A question nobody takes within 10 minutes moves on by itself. Without a peer or BA the question goes straight to the desk, as before.
16. **DevOps engineer** is auto-hired per (user, workstation) at pairing.
17. **Project sharing** requires the invitee to accept (pending until then).
18. **Scheduled overflow** is limited to one extra shift per organization at a time.
19. **Research and feed roles** (researcher, checker, scout, curator) ship as built-in roles.
20. **Operational, non-event state**: auth sessions, heartbeats/lease refresh, connection flags, shift progress tails, runner inbox and command queue.
21. **Risk tier** computed by the runner at build handoff: ≥ 200 changed lines, any architectural glob, or refactor ⇒ large.
22. **Finalize before the BA exists** (M4–M6): the manager triggers finalize from the card; the runner executes the completion action. From M7 the BA claims the Finalize stage and reports `aom finalize --action ...` (revising the completion action if it should); the server then queues the same `finalize.execute` (large merges wait for desk approval). The manager's Finalize button remains as an override.

### 24.x Not built (accepted by the owner, 4 Oct 2026)

- Couchbase bucket or scope per worktree, and a one-at-a-time queue for heavy builds (e.g. MAUI) per workstation (spec, "Worktrees, testing, review and integration"). Deferred as a later enhancement; until then keep Couchbase-backed or MAUI projects to one tester and one builder per workstation.

---

## 25. Organizations, roles, platform and licensing (built; design: `docs/design/organizations.md`)

**Model.** `organizations(id, name, owner_user_id, plan, status, status_reason, limits, feature overrides, trial_ends_at, license_expires_at, grace_days, require_two_factor, billing refs)`; `org_members(org_id, user_id, role owner|admin|member)` with a partial unique index for exactly one Owner. `users.kind` is `user` or `super_admin` (no memberships possible). A **guest** is derived: an active `project_members` row in an organization the user is not a member of. Org Owners and Admins get projector-maintained `project_members` rows (`org_grant`), so every existing visibility join stays correct. Migrated organizations keep the old user id as their id, so no event or `org_id` column was rewritten.

**Events** (`events/org.ts`, `events/user.ts`): `OrganizationCreated`, `OrganizationRenamed`, `OrgMemberAdded`, `OrgMemberRoleChanged`, `OrgMemberRemoved`, `OrgOwnershipTransferred`, `OrgPlanChanged`, `OrgLimitsSet`, `OrgDatesSet`, `OrgFeaturesSet`, `OrgStatusChanged`, `OrgTwoFactorPolicySet`, `PlatformOrgViewed`; `SuperAdminCreated`, `SuperAdminSignedIn`, `TwoFactorEnabled`, `TwoFactorDisabled`, `TwoFactorRecoveryCodeUsed`, `TwoFactorRecoveryCodesRegenerated`. Audiences gain `user` (workstation and addressed-desk events). `platform_audit_log` is a projection of every super admin and system licensing event, rebuilt with the rest and **never pruned**.

**Request context** (`auth/org-context.ts`, `auth/guards.ts`, `orgs/guard.ts`). `requireOrg` resolves the active organization, checks membership and status, and returns the role; `requireSuperAdmin` guards `/api/platform/*` and keeps super admins off app routes; `requireFeature` checks the plan's switches; object routes derive the organization from the object. `POST /api/orgs/active` stores the remembered default. A write caused by a user in a suspended or cancelled organization is refused with `org_suspended` for everyone but its Owner (who keeps read access plus organization settings and members).

**Authorization** is the pure predicate set in `packages/shared/src/authz/` over ranks Owner 4, Admin 3, Member 2, Guest 1 (the interest edit rule compares the actor's rank with the creator's *current* rank, the stored rank when the creator left). Event visibility (`browser-gateway/visibility.ts`, `queries`/`EVENT_VISIBILITY_SQL`): Owners and Admins get `org` events in full, Members get them payload-stripped, guests get project events only.

**Two-factor login** (`auth/totp.ts`, `auth/two-factor.ts`, `routes/auth.ts`). RFC 6238 TOTP (SHA-1, 6 digits, 30 s, +-1 step, a step is accepted once); seeds are AES-256-GCM encrypted at rest with `AOM_SECRET_KEY` (`auth/secrets.ts`) and live in operational tables (`user_totp`, `user_recovery_codes`, `login_challenges`), the events only record enabling, disabling and code use; ten single-use recovery codes are stored hashed. Login returns `{twoFactorRequired, challenge}` until `POST /api/auth/login/2fa` answers it. `MeResponse.twoFactor = {enabled, required, setupRequired}`: required for super admins and for members of an organization with `require_two_factor`; while `setupRequired` the session can reach only the 2FA setup routes. Owner (`POST /api/org/members/:id/reset-two-factor`) and super admin (`/api/platform/users/:id/reset-two-factor`) reset it.

**Licensing** (`orgs/licensing.ts`, `orgs/limits.ts`, `packages/shared/src/orgs/plans.ts`). One plan, `founding`, with all features and `NO_LIMITS`; limits (`maxMembers`, `maxWorkstations`, `maxAgents`, `maxProjects`) are nullable per organization and enforced inside the creating transaction (invitations count as seats, guests and DevOps engineers never count). `licensingTick` (scheduler) ends trials, warns once per threshold and suspends after the grace days (system actor, audited). The dispatcher, scheduler, signal sweep and hygiene skip non-operational organizations; running shifts finish.

**DevOps engineer** (`commands/devops.ts`, `commands/agents.ts`): one per (organization, workstation) for each organization the workstation's user belongs to. Owner decision 15a: `PATCH` of extensions, a custom role under key `devops`, workflow-stage claims and standing orders for it are rejected (`devops_fixed`); model and effort remain editable.

**Routes.** `/api/orgs`, `/api/orgs/active`, `/api/org`, `/api/org/{members,invitations,guests,transfer-ownership}`, `/api/auth/2fa/*`, `/api/auth/login/2fa`, `/api/platform/{orgs,invitations,users,audit}`; `/api/admin/*` answers 410. Invitations carry a kind: `new_org` (super admin), `org_member`, or `legacy` (accepted for old links); guest sharing stays `POST /api/projects/:id/members`.

**CLI** (`apps/server/scripts`, bundled as `dist/*.mjs` in the image): `superadmin:create --email --name [--password]`, `superadmin:reset-password --email [--password] [--reset-two-factor]`, `admin:create --email --name [--password] [--org] [--plan]` (a user plus the organization they own), `orgs:migrate [--dry-run]`, `restructure:migrate [--dry-run]`, `ranking:migrate [--dry-run]`.

**Web.** The API client sends `X-AOM-Org` from `sessionStorage` (per tab); `OrgSwitcher` and `OrgBanner` in the shell; `/settings/org` (General, Members, Invitations, Guests, Plan & limits); `/settings` security panel and the forced `SecuritySetup` page; the Login 2FA step; `/invite/:token` for the three invitation kinds; `/platform/*` (`PlatformShell`: organizations, detail, invitations, accounts, audit log), which only super admins reach.

## 26. Cost tracking, budgets and the org chart (built; requirements: `docs/design/restructure.md`, roadmap)

**Usage capture.** Claude Code's stream is parsed in `apps/runner/src/adapters/claude-stream-parser.ts`: the `result` line is the authoritative session total (`usage`, `modelUsage` for the dominant model, `total_cost_usd`); until it arrives, the sum of the assistant messages' usage (by message id) is the running total, so a shift that was stopped, timed out or crashed still reports what it spent. `Usage` (`events/define.ts`) gained the optional `model` and `costUsd`; the supervisor and the chat code send `session.usage()` with `shift.ended` and `chat.done` as before. The mock runtime reports synthetic usage (1000 input and 200 output tokens per card shift; `fields.mockUsage` scripts it per card, mock UI only).

**Prices.** `packages/shared/src/costs/index.ts`: `DEFAULT_MODEL_PRICES` (Fable 10/50, Opus 5/25, Sonnet 2/10, Haiku 1/5 USD, September 2026 list prices to verify against anthropic.com/pricing; per million input/output tokens, cache read at 10% and cache write at 125% of the input price, any other model priced as Sonnet), plainly marked as defaults, matched by substring on the agent's free-form model string. `costUsdMicros` does integer arithmetic (hundredths of a micro-dollar) so the result is exact and equals the SQL (`1318_reprice_shift_costs.sql` reprices history; `shift_costs.cost_stamped` marks rows that carried their own `costMicros`, which it leaves alone). A `costMicros` stamped on `ShiftEnded` wins over the table, which is how a later platform-admin price setting will keep history at the price it was recorded at.

**Storage** (`1317_costs_budgets.sql`, projectors in `projections/costs.ts`, `shift_costs` in `PROJECTION_TABLES`). One `shift_costs` row per ended shift: org, agent, project (`COALESCE(shifts.project_id, cards.project_id, ba_tasks.project_id)`; `ShiftStarted.projectId` carries a chat's project; NULL is the org overhead bucket), card, BA-task phase, kind, model, the four token counts, `cost_usd_micros` and the runtime-reported cost. Cards resolve their phase through the card at read time. The migration backfills history with the same default prices in SQL (a test replays both and compares). `organizations.currency` and `usd_rate` (display currency; `OrgCostSettingsChanged`) and the project columns `budget_micros` (currency micro-units), `budget_override_month`, `budget_warned_month`, `budget_paused_month`, `budget_desk_item_id` (`ProjectBudgetSet`, `ProjectBudgetThresholdReached`, `ProjectBudgetOverridden`) are projections too. The organization's time zone is its Owner's reporting time zone (`reportingOf`), UTC when unset.

**The pause is stateless** (`budgetPausedSql`): a project is paused when it has a budget, is not overridden for the current month key (`to_char` of the clock in the Owner's zone) and the month's `shift_costs` (cut at local month boundaries, times `usd_rate`) reach `budget_micros`. The dispatcher's candidate query, the claim (`isCandidate`), the BA task pass, `fireDueInterests` (`budget_paused`, not counted as a failure) and manual interest runs all use it, so raising a budget, an override and the reset on the 1st take effect immediately with no event to wait for. The events only drive the notifications.

**Manual project pause** (`commands/project-pause.ts`, `dispatcher/project-hold.ts`, migration `2200_project_pause.sql`). `POST /api/projects/:id/pause` (`{reason?}`, max 500) and `/resume` append `ProjectPaused{projectId, by, reason?}` / `ProjectResumed{projectId, by}`; the projector sets and clears `projects.paused_at / paused_by / pause_reason`, so a rebuild restores the state from the events. Only an organization Owner or Admin of the project's organization may call them (403 otherwise); both routes take a signed-in session only, and no agent, runner, CEO action or CLI command can reach them. Both are idempotent (no event when nothing changes); resume triggers the dispatcher. `projectPausedSql(p)` is the one rule, `projectHeldSql(p, now)` combines it with the budget pause. Gated: the candidate query (so every stage, the preferred and overflow claims and `claim()` itself, which returns null before stop-loss or any counter is touched), `baTaskPass`, `devopsPass` (by card or `context.projectId`), `questionPass` (no stall escalation either), `fireDueSchedules` (`ScheduleSkipped{reason 'project_paused'}`, the cron moves on, no catch-up), `fireDueInterests` and manual interest runs, `provisionPass`/`testDeployPass`, the phase completion and follow-up sequence steps, the tester bottleneck alert, the CEO (wakes of the project's events and subjects are not raised or taken, `runAction` refuses its subjects, the snapshot skips its cards) and `ChatRelay.send` for project threads (`chat.error project_paused`). Cards made by e-mail, webhooks and event triggers are created and wait in the queue; running shifts are never touched. The DTO carries `paused: {at, byUserId, byName, reason} | null`.

**Thresholds** (`commands/budgets.ts`). `evaluateProjectBudget` (after every `ShiftEnded` through a store subscription, after a budget change, and for every budgeted project on the scheduler tick) locks the project row and fires each level once per month: at 80% an org-level `budget_warning` desk alert (Owner and Admins), at 100% a pinned `budget_paused` alert whose options are `Raise budget` and `Override for this month` (the web renders them as a link to the settings panel and a call to the override endpoint; `DeskItemDto.budgetProject` names the project). Raising the budget or overriding resolves the open alert; a pause of an earlier month closes on the first tick of the new one. `detectBudgets` (`reporter/detectors.ts`) is the reporter's detector: signal kind `budget`, normal at 80%, urgent when paused, fingerprint with the month; the daily floor digest gains a `spend` section (`spendDigest`, rendered by the template, the mock BA and the web `FloorReport`).

**Permissions.** Set or override a budget and the currency: Owner and Admin of the project's organization (the project's own organization decides, not the tab's); everything else 403, outsiders 404. Amounts are for organization members; a guest of a shared project sees `state` only (`monthlyMicros`, `spentMicros` and `percent` are null) and no spend on cards or phases. The Costs report and CSV need Owner or Admin (`requireOrg(..., {min: 'admin'})`).

**API.** `GET /api/costs?from&to&projectId` (breakdown by project, agent, model and day in the organization's zone, overhead, prices, settings), `GET /api/costs/export.csv` (day, project, agent, model, shifts, tokens, cost; fields that start with `= + - @` are prefixed with a quote), `GET|PUT /api/costs/settings`, `PUT /api/projects/:id/budget {monthly|null}`, `POST /api/projects/:id/budget/override`, the same two under `/api/interests/:id/` (the backing project), `GET /api/org-chart`. `ProjectDto.budget`, `InterestDto.budget|spend`, `PhaseSummaryDto.spend`, `CardDetailResponse.spend`, `HrAgent.spend` carry the numbers.

**Org chart** (`queries/org-chart.ts`, `routes/org-chart.ts`, web `pages/OrgChart.tsx`, `lib/orgChartLayout.ts`). The server returns every non-retired agent with role label and department, seniority, status (needs_rehome, offline, working, blocked, idle), workstation, hiring manager and org role, escalation (`peer`: the seniors of its role, for a junior who has one; `ba`: the BAs; `desk`: the BA and DevOps), allow-list and focus, active and blocked cards, the last five ended shifts and spend; plus projects, workstations with their DevOps engineer, and departments (built-ins first). The web lays the tree out as a pure function (manager, BAs, department boxes with a group per role, seniors above juniors, elbow edges to the parents; DevOps is not part of it), draws SVG lines under absolutely placed tiles in a horizontally scrolling container, and switches to a grouped list on narrow screens or on demand. Tiles are buttons whose accessible name carries role, status and escalation; the agent dialog is a Radix dialog.

## 27. Runner installer and Contact us (built; requirements: `docs/design/open-questions.md`, "Queued: ease of adoption")

**Installer sessions** (`migrations/1319_installer_sessions.sql`, `commands/installer.ts`, `routes/installer.ts`, `installer/`). Operational tables, not event-sourced (like `pairing_codes`). `POST /api/workstations/installers {os, name?}` creates a wizard session: a `pairing_codes` row (30 minute TTL; earlier unused installer codes of the user are retired first so the three-active-codes limit never bites) and an `installer_sessions` row holding the SHA-256 of a random token (24 bytes, base64url). The script links are `/install/<token>/{install.sh, install-mac.sh, install.ps1, install-linux-wsl.sh}` (unauthenticated; the token is the credential; 30 minutes). Only a hash of a pairing code is stored, so **each fetch of a script mints a new code** for the session (same expiry, previous copy stops working); a used code stays used and the script is still served (a re-run repairs a paired machine). `POST /install/<token>/progress {step, status, detail}` (accepted for 6 hours; 300 entries at most) appends to `installer_sessions.steps`; `step: "installer"` starts it, `"Paired"` or `"Pairing" info` marks pairing, `"doctor:<name>"` are `aom-runner doctor` lines and `"summary" done` ends it. `GET /api/workstations/installers/:id` (owner only) derives `waiting | running | paired | checking | done | expired` (pairing is also read from `pairing_codes.used_at` and `pairing_codes.workstation_id`, which `pairRunner` now sets). `commands/workstations.ts: createPairingCode` takes a TTL and the codes to retire.

**Scripts** (`installer/templates/{common.sh,linux.sh,macos.sh,windows.ps1}`, `installer/render.ts`). Real files so they can be linted; the rendered script is a generated header (`SERVER_URL=...`, `PAIRING_CODE=...`, release version and sha256, workstation name, all through `shq` for bash and `psq` for PowerShell, the only two quoting functions) followed by the fixed body, and always ends with `main "$@"` so `curl | bash` reads it whole before running. The PowerShell script is ASCII with CRLF. In the bundled server the templates are copied to `dist/installer-templates` (tsup `onSuccess`). Lint: `scripts/lint-installers.sh`; real runs in containers: `scripts/test-installer-docker.sh`; unit tests render and check quoting and shellcheck (`test/installer-render.test.ts`).

**Release serving** (`installer/release.ts`). `AOM_RUNNER_RELEASE_DIR` (the image builds `/app/release` with `scripts/package-runner.sh`), else `release/` near the working directory or repository. `GET /api/runner/release` (newest version, sha256, size), `GET /api/runner/release/aom-runner-<version>.tgz` and `.tgz.sha256`.

**Contact us** (`migrations/1320_support.sql`, `commands/support.ts`, `routes/support.ts`). Tables `support_tickets` (ref `SUP-<n>` from a sequence, kind, status open/answered/closed, user and org, contact name and email, `context` jsonb, `source_hash` of the sender's IP for the rate limit), `support_messages`, `support_attachments` (images as `bytea`, PNG/JPEG/WebP by magic bytes, 3 MB) and `platform_settings` (key/value; `support_email`). `POST /api/support/tickets` accepts a signed-in user (name, email and organization from the session; 10 an hour) or a visitor (name and email required; 5 an hour per address and 3 per email; a filled honeypot field stores nothing) and mails the support address (platform setting, else `AOM_SUPPORT_EMAIL`; Reply-To is the writer) and the writer (acknowledgement). The notification addresses are two platform settings (`support_email`: signed-in users' requests and follow-ups; `contact_email`: visitors' Contact us messages, falling back to `support_email`, then `AOM_SUPPORT_EMAIL`), each one address or a comma-separated list. The acknowledgement (`supportReceivedMail`) names the reference, what happens next and the response time; there is no inbound mail, so it is sent once per form submission and cannot loop. A mail failure is logged and never loses the request. Users: `GET /api/support/tickets[/:id]`, `POST /api/support/tickets/:id/messages` (reopens), attachments at `/api/support/attachments/:id` (owner or super admin, else 404). Super admin: `/api/platform/support/tickets` (filters status, kind, orgId, q; counts), `/:id`, `POST /:id/replies {body, close?}` (emails the writer; status answered or closed), `PATCH /:id {status}`, `GET|PATCH /api/platform/settings`. Web: `lib/client-errors.ts` (ten-entry ring buffer, secrets removed), `lib/screenshot.ts` (`html2canvas-pro`, loaded on demand; plain `html2canvas` cannot parse the `oklch`/`color-mix` that Tailwind v4 emits), `components/support/*`, `pages/{Help,ContactPublic}.tsx`, `pages/platform/PlatformSupport*.tsx`.

**Legal pages** (`apps/web/src/legal/{privacy,terms}.md`, `apps/web/legal.html`, `src/landing/{LegalPage,legal,legal-main,render-legal}.tsx`, `SiteChrome.tsx`). The Privacy policy (`/privacy`) and Terms and conditions (`/terms`) are markdown files with a small front matter (`title`, `summary`, `updated`), parsed by the help article reader. The web build prerenders each into `dist/privacy.html` and `dist/terms.html` (the landing header and footer, shared through `SiteChrome.tsx`, around the text; the vite prerender plugin fills the `legal.html` shell and then removes it), and the server sends them as static files to every visitor (`app.ts`, behind `AOM_SERVE_WEB`; without the build files the app shell is served). The operator named in the texts is "Example Company (Pty) Ltd trading as Guildwise HQ"; that name appears only inside these two documents (a web test enforces it). Unfilled facts are `[PLACEHOLDER: ...]` markers (registration number, address, Information Officer, retention periods) and the texts carry a draft notice until legally reviewed. The footer links them, and the sign-in and invitation pages say that continuing means accepting them. Tests: web `legal.test.tsx`, server `legal-pages.test.ts`.

## 28. Mail layout and password reset (built)

**Mail** (`mail/layout.ts`, `mail/templates.ts`, `mail/mailer.ts`). Every mail goes through `brandedMail({to, subject, preheader, heading, origin, body: MailBlock[], cta?, note?, replyTo?})`: table layout with inline CSS (plus a `<style>` block with `prefers-color-scheme: dark` overrides), the tokens of `apps/web/src/tokens.css`, the 2x PNG logo mark `${origin}/brand/logo-mark-mail@2x.png` (72 px shown at 36 px, rendered from `public/brand/logo-mark.svg`; SVG is not safe in mail clients), a hidden preheader, one button with a copy-paste link, a plain-text part generated from the same blocks, and a footer (product name, slogan, site, Privacy and Terms links on the public origin). Blocks are a paragraph, `{html,text}`, `{quote}`, `{facts}`, `{list}` and `{small}`; everything else is escaped. A new template is a function that returns `brandedMail(...)`; it takes `origin` (`ctx.config.publicOrigin`). Mail never carries a login name or a personal address: super admin invitations and ticket replies always say "The Guildwise HQ team" (`TEAM`), and an organization member invitation says the inviter's display name (`senderName({displayName, email})`, else the team) next to the organization name (a display name equal to the email local part is treated as a username). Templates: invitation, organization invitation, new-organization invitation, password reset, scheduled report, support (new request, follow-up, acknowledgement, reply). `AOM_MAIL_FROM` defaults to `Guildwise HQ <noreply@aom.local>`. `pnpm --filter @aom/server mails:render [dir]` writes every template to HTML and text files for review.

**Console notifications** (`commands/support.ts`, `commands/platform-notify.ts`, `platform_settings`). New support requests, Contact us messages and a user's follow-up (which also reopens the request) always mail `support_email` (Contact us: `contact_email`), once per event, after the append transaction, with failures only logged. Two switches, off by default, are platform settings `notify_new_orgs` and `notify_audit_events` (`GET/PATCH /api/platform/settings`: `notifyNewOrgs`, `notifyAuditEvents`): `notifySignup` mails once per accepted invitation (new organization or joined member); `auditMailTick` (the scheduler pass) mails each new `platform_audit_log` row once, moving the cursor setting `notify_audit_cursor` before it sends, and switching the setting on starts the cursor at the current end. `migrations/1400_drop_desk_mail.sql` removed the earlier desk-mail feature (its table and settings).

**Owner password reset** (`migrations/1401_must_change_password.sql`, `commands/orgs.ts`, `auth/guards.ts`). `POST /api/org/members/:userId/reset-password` (Owner or Admin: an Admin may reset Members only, an Owner Members and Admins; never oneself, never an Owner, not a platform account) generates a 20-character random password, stores only its hash in `MemberPasswordReset {userId, orgId, by, passwordHash}` (the clear text is returned once with `Cache-Control: no-store`, never logged or stored), sets `users.must_change_password`, and deletes the member's sessions and pending two-factor challenges. While the flag is set, every route except `/api/auth/*` answers 403 `password_change_required` (as for `two_factor_setup_required`), `me.mustChangePassword` is true and the web shows `pages/ChangePasswordRequired.tsx`; `PasswordChanged` (own change or a reset link) clears the flag. Two-factor is unaffected.

**Password reset** (`migrations/1330_password_resets.sql`, `commands/password-reset.ts`, `routes/auth.ts`, `routes/platform.ts`). Table `password_resets` (user, SHA-256 of the token, `requested_by` null for self-service or the super admin, expiry one hour, `used_at`). `POST /api/auth/password-reset/request {email}` always answers `{ok:true}`; it is limited per IP (5 a minute, 10 an hour) and per address (3 an hour), sends nothing for unknown or deactivated accounts (platform accounts may use it; their TOTP is still asked at the next sign-in) or when a link was made in the last two minutes, and a new link spends the older ones. `GET /api/auth/password-reset/:token` says whether a link is usable. `POST /api/auth/password-reset/confirm {token, password}` (the usual password rules) appends `PasswordChanged`, spends the link, deletes every session and pending two-factor challenge of the user, and creates no session: the next sign-in is the normal one, so TOTP is still required. `POST /api/platform/users/:id/send-password-reset` (super admin) answers truthfully (404 unknown, 409 deactivated account, 502 mail failure), appends `PasswordResetLinkSent {userId, by, meta}` (shown in the platform audit log via `platform-audit.ts`) and `GET /api/platform/users` returns `passwordResetSentAt`. Web: `pages/ForgotPassword.tsx` (`/forgot-password`), `pages/ResetPassword.tsx` (`/reset-password/:token`), a "Send reset link" action on `pages/platform/PlatformUsers.tsx`.

## 29. What's new in Guildwise HQ (built)

**Entries** are markdown files with frontmatter (`title`, `date`, `audience` all|owner|admin|superadmin, optional `help` deep link) in `apps/web/src/whats-new/entries/` (format: that folder's README). Each feature track adds its own file; the file name without `.md` is the stable entry id. They are bundled at build time with `import.meta.glob(..., ?raw)` (`whats-new/entries.ts`, like the help articles) and bodies are rendered with the help centre's safe markdown renderer (no HTML, only `http(s)` and in-app links).

**Seen state** is server-side so it follows the user across devices: migration `1480_whats_new.sql` adds `users.whats_new_seen text[]`; the event `UserWhatsNewSeen {userId, entryIds}` (allowed while an organization is suspended, like the tour) is projected as a set union, so a projection rebuild restores it. `PUT /api/auth/whats-new-seen {entryIds}` answers with `me`, which carries `user.whatsNewSeen`. It uses `requireSession`, so platform administrators can mark entries too. `me.features.whatsNew` is `AOM_TOUR_AUTOSTART` (the e2e suite switches both off, so the popup never covers a test).

**Popup** (`components/whatsnew/WhatsNew.tsx`, mounted in `AppShell` and `PlatformShell` inside `TourProvider`). It opens when the user has entries that match their audience (role in the current organization; `superadmin` only for platform accounts), are not in `whatsNewSeen` and are not dated before the account's creation day (a new user gets the tour instead). It waits while the tour is on screen or about to start. "Got it" or closing marks every shown entry seen (optimistically in the cached `me`). Help page card "See what's new" reopens the full list for the user without marking anything.

**Password reset** (`migrations/1330_password_resets.sql`, `commands/password-reset.ts`, `routes/auth.ts`, `routes/platform.ts`). Table `password_resets` (user, SHA-256 of the token, `requested_by` null for self-service or the super admin, expiry one hour, `used_at`). `POST /api/auth/password-reset/request {email}` always answers `{ok:true}`; it is limited per IP (5 a minute, 10 an hour) and per address (3 an hour), sends nothing for unknown, deactivated or platform accounts or when a link was made in the last two minutes, and a new link spends the older ones. `GET /api/auth/password-reset/:token` says whether a link is usable. `POST /api/auth/password-reset/confirm {token, password}` (the usual password rules) appends `PasswordChanged`, spends the link, deletes every session and pending two-factor challenge of the user, and creates no session: the next sign-in is the normal one, so TOTP is still required. `POST /api/platform/users/:id/send-password-reset` (super admin) answers truthfully (404 unknown, 409 platform or deactivated account, 502 mail failure), appends `PasswordResetLinkSent {userId, by, meta}` (shown in the platform audit log via `platform-audit.ts`) and `GET /api/platform/users` returns `passwordResetSentAt`. Web: `pages/ForgotPassword.tsx` (`/forgot-password`), `pages/ResetPassword.tsx` (`/reset-password/:token`), a "Send reset link" action on `pages/platform/PlatformUsers.tsx`.

## 30. Setup checklist, card notices and the landing-page assistant (built)

**Get started checklist** (`migrations/1430_setup_checklist.sql`, `queries/setup-checklist.ts`, `routes/setup-checklist.ts`, `components/setup/SetupChecklist.tsx`). `GET /api/setup-checklist` computes five steps for the tab's organization from live state, nothing is stored: a non-interest active project; a repository on one; an active workstation paired by a member of the organization; the roles ba, builder, reviewer and tester each hired (DevOps does not count; it comes with the workstation); an intake, or a chat with a BA that has a user message. Each step carries `done`, `actionable` (project and repository: Owner and Admin; the others: every member) and a deep link (`/projects?new=1`, `/projects/:id/settings#repos`, `/workstations?add=1`, `/agents?hire=<first missing role>`, `/intake`); a step the viewer cannot do has no link. Hiding is per user: `PUT /api/setup-checklist {dismissed}` appends `UserSetupChecklistChanged` (projected to `users.setup_checklist_dismissed`, allowed while an organization is suspended). The web shows a sidebar button (progress `n/5`, hidden when dismissed or complete) that opens a dialog, and a card on the Help page that brings it back. The tour's last step points at it.

**Card notices on the board.** `getBoard` (`queries/cards.ts`, `boardNotices`) adds three optional fields to `BoardCardSchema`: `blockedReason` (the first open desk item in `card_blockers`, with a count of others), `hygiene` (open `hygiene_findings` of the card's repository) and `budget` (the project's state when `warning`, `paused` or `overridden`; a paused budget only on queued cards; amounts hidden from viewers who may not see them). Shown by `components/BoardCardNotices.tsx` as `CardNotice` banners with fix links (desk, repository settings, budget settings for managers).

**Landing-page assistant** (`apps/server/src/assistant/`, `routes/assistant.ts`; design `docs/design/ai-assistant.md` section 2.1, public part only). Public and anonymous, no tools, no access to any data. `POST /api/public/assistant/chat` takes the whole conversation (at most 12 visitor turns, 1,000 characters each) and answers as server-sent events (`delta`, `done`, `error`); the Anthropic SDK (`@anthropic-ai/sdk`) is called with `claude-haiku-4-5`, thinking off, `max_tokens` 600, and a cached system prompt: fixed rules (`prompt.ts`: English only, product questions only, redirects to Contact us for prices, legal, certifications, sales and support, no comparisons, injection-resistant) followed by the knowledge pack, with `cache_control` on the system block and on the newest turn. The pack (`assistant/pack/public-pack.md`, about 7.7K tokens) is built by `pack-builder.ts` (`pnpm --filter @aom/server assistant:pack`) from `docs/assistant/product-facts.md` and an outline of every help article; it is committed, deterministic and byte-stable, shipped beside the bundle (`dist/assistant-pack`), and `test/assistant-pack.test.ts` fails when it is stale. Limits (`limits.ts`, table `assistant_counters`, counters only, no text): 20 messages an hour and 40 a day per salted IP hash; from the sixth message in an hour or conversation a proof of work (`GET /api/public/assistant/challenge`; a signed, expiring, single-use challenge; sha256 with 16 leading zero bits); a daily spend ceiling (default $2: `AOM_ASSISTANT_PUBLIC_DAILY_USD` is only the initial default, the super admin overrides it in `platform_settings.assistant_daily_cap_usd` through `PUT /api/platform/assistant {dailyCapUsd}`, `null` clears it; `dailyCapUsd(ctx)` in `limits.ts`; costed from the reported usage at $1 / $5 per million tokens, cache write 1.25x, read 0.1x). Switches: `AOM_ASSISTANT` and the key (environment), and `platform_settings.assistant_public_enabled` (`GET|PUT /api/platform/assistant`, super admin; the panel is on the platform Support page). `GET /api/public/assistant/status` tells the landing page whether to show the widget. No conversation is logged or stored. The Anthropic client is injectable (`BuildOptions.assistantClient`); tests use a fake and never call the real API. Web: `landing/assistant/*`, mounted from `landing/main.tsx` after the page is idle and only when the status says available, as its own lazy chunk (the prerendered markup and the CSP, which already allows same-origin `connect-src`, are unchanged).

## 31. The platform blog (built; requirements: `docs/design/blog-prd.md`, owner decisions in `docs/design/open-questions-2026-10-09.md`)

**Model.** Posts are event-sourced: `BlogPostSubmitted`, `BlogPostRevised`, `BlogPostPublished{auto}`, `BlogPostRejected{reason}`, `BlogPostUnpublished` (events in `packages/shared/src/events/blog.ts`, stream `blog-<postId>`, audience `admin`) are projected into `blog_posts` (`projections/blog.ts`, listed in `PROJECTION_TABLES`, replay-equal) with the latest revision's `BlogContent` as jsonb. Statuses: `draft`, `in_review`, `published`, `rejected`, `unpublished`. The author is fixed ("The Guildwise HQ team"). `ApiKeyCreated/Revoked`, `BlogSettingsChanged`, `Social*` and `UserDigestPreferenceSet` are audit/consent events (`projections/platform-audit.ts`: every blog write appears in `platform_audit_log`, an API write with the system actor and the key id in the details). Operational tables (no foreign keys, untouched by a rebuild): `blog_api_keys` (SHA-256 of the key, scopes, IP list, last use), `blog_api_log` (one row per API request: audit and the counters of the limits), `blog_digest_prefs`, `blog_digests`, `blog_digest_deliveries`, `social_channels` (tokens encrypted with `auth/secrets.ts`), `social_shares`. Migrations 1450 to 1452. Settings are `platform_settings` keys `blog_enabled`, `blog_auto_publish_from`, `blog_hold_hours`, `blog_digest_enabled`.

**Markdown and rendering.** `packages/shared/src/blog/markdown.ts` is the one restricted parser (AST of headings H2-H4, paragraphs, lists, quotes, fenced code, tables, bold, italic, code, http(s) or same-site links; raw HTML never exists; unsafe link targets become text). The server pages (`blog/render.ts`, plain templates, one inline stylesheet, no script), the Help > Blog reader and the review preview (`components/blog/BlogBody.tsx`, React nodes) all use it. Public routes (`routes/blog-public.ts`): `/blog`, `/blog/:slug`, `/blog/tag/:tag`, `/blog/rss.xml`, `/sitemap.xml`, `/robots.txt`, with canonical, Open Graph, Twitter and JSON-LD (`<` escaped). Rendered per request through an in-memory cache keyed by a version (post count and latest change time, one cheap query per request), so a publish or unpublish shows at once; `ETag` and `Cache-Control: public, max-age=300`. Unknown slug 404, unpublished 410. Default covers are PNGs in `apps/web/public/blog/cover/` (`scripts/make-blog-covers.mjs`), served by the static plugin in production and by the server without the web build. JSON for Help: `GET /api/blog/posts[/:slug]` (any session). Digest preference: `GET/PUT /api/me/blog-digest`.

**Agent API** (`routes/blog-api.ts`, `commands/blog-keys.ts`): `/api/v1`, Bearer `gwk_` keys only (cookies ignored; the prefix is exempt from the Origin check in `auth/origin-check.ts`). Scopes `blog:read|write|publish`, `social:write`. Limits counted from `blog_api_log` (the row is inserted before the handler runs, its status is filled in `onSend`): 60 reads a minute, 10 writes an hour, 8 new posts per rolling 24 h per key, each answered `429` with `Retry-After`. `POST` is idempotent on slug and content hash. Super admin routes: `/api/platform/blog*`, `/api/platform/api-keys*`, `/api/platform/social/channels*` (`routes/blog-platform.ts`).

**Moderation and the kill switch** (`commands/blog.ts`). Every post enters `in_review`; content checks (`contentWarnings`) add warnings that block auto-publish. `autoPublishDue` (run by the scheduler tick) publishes clean posts that entered review on or after `autoPublishFrom` once `holdHours` passed; before that date, or with `autoPublishFrom = null`, nothing auto-publishes. `autoPublishFrom` defaults to the first post plus 14 days. With `blog_enabled = false` creating answers `503 blog_disabled`, publishing (manual, auto, API) is refused, and the digest and social ticks do nothing.

**Digest** (`commands/blog-digest.ts`). The scheduler tick calls `blogDigestTick`: due Monday 06:00 UTC (08:00 Johannesburg), digest id = ISO week (`blog-digest-2026-W42`), created once; it covers the posts published since the last sent digest's cutoff; no posts: a `skipped` row. Recipients: active users with an active membership in an organization that is not suspended or cancelled, who are opted in (`blog_digest_prefs`), or Owners with no row; one per address. Deliveries are claimed (`sent`) before the mail goes out and reverted only when sending threw, so a crash never mails twice; failed ones are retried on later ticks (3 attempts). The mail is `mail/blog-mail.ts` (`brandedMail`) with `List-Unsubscribe` and `List-Unsubscribe-Post` headers (`MailMessage.headers`); the unsubscribe link carries an HMAC-signed user id (`signValue` in `auth/secrets.ts`): `GET /blog/unsubscribe/:token` only shows a confirm page ("Unsubscribe from the weekly digest" button, "Keep me subscribed" link) and changes nothing, so mail scanners and link previews cannot unsubscribe anyone; `POST` unsubscribes: the button posts `confirm=1` and gets the "You are unsubscribed" page with "Subscribe again", and the RFC 8058 one-click POST (`List-Unsubscribe=One-Click`, form bodies are parsed for it) gets plain text; both rate limited. `AOM_BLOG_DIGEST` and the platform setting are both switches.

**Social** (`commands/social.ts`, `blog/social-client.ts`). `SocialClient` is the only code that talks to Facebook (Graph `POST /{page}/feed`) and LinkedIn (`POST /rest/posts` with an uploaded thumbnail); `Ctx.social` is a fake in every test. One `social_shares` row per post and network (primary key) is claimed `posting` before the call, so a post is never shared twice; a crash leaves it `posting`, which becomes `failed` for a human. Retries after 1 min, 5 min, 30 min, 2 h (network errors, 429, 5xx), other 4xx is final. An authentication error marks the channel `needs_reconnect`, pauses it and mails the super admins once; shares for posts under 48 h old resume after a reconnect. Tokens within 7 days of expiry are renewed (LinkedIn, with the refresh token) or alerted. Only posts published after the channel was connected are shared. Unpublishing never deletes a social post. Connecting takes pasted tokens (no OAuth dance until the apps are approved).

**The blog writer** (`blog/writer/*`; owner decision 2026-10-10: a platform job on the server, no workstation or org agent). `blogWriterTick` runs from the scheduler's blog pass but *outside the serialized chain* (`Scheduler.runWriter`, one run at a time), so a run of a minute or two never delays schedules. Slots: 1 or 2 per day at 06:00 and 13:00 UTC (08:00 and 15:00 Johannesburg); a slot is claimed by inserting `blog_writer_runs(slot unique)` BEFORE the API is called (restarts and concurrent ticks cannot double-run; a slot more than 4 h late is missed). Gates: writer on, blog kill switch, `Ctx.blogWriter` (the Anthropic client built from `ANTHROPIC_API_KEY` with a 300 s timeout; tests inject a fake and the default in tests is null, so the real API is never called), a known price for the model (built-in: Haiku 4.5 $1/$5 per million tokens; other models need a super-admin override in `blog_writer_prices`), no run in flight, the blog's 8-per-24-h cap, and `spend this month + estimate of one run <= cap` (default $10, UTC month; otherwise the slot is recorded `skipped` and the super admins get one mail per month, claimed through `blog_writer_cap_notice_month`). The call: `messages.create` with `web_search_20250305` (max 5 uses), `max_tokens` 8000, no thinking, the house rules as a cached system prompt; `pause_turn` is resumed up to 4 times; usage (tokens, cache tokens, `server_tool_use.web_search_requests`) is summed over every request and priced (search $0.01 default, editable) so failed runs keep their cost. The answer is one JSON object, checked by `blog/writer/article.ts` (zod, only sources seen in the search results, body links outside the sources become text, disclosure sentence, `BlogContentSchema` and `contentErrors`); an invalid answer is sent back once without tools, then the run is `failed`. The post is submitted with `submitPost(..., {system: 'blog-writer'}, 'in_review')` (event origin `system`, projected to `blog_posts.origin_system`, shown as "Blog writer"), so moderation, auto-publish, digest and social are the existing ones. `blog_writer_runs` has no foreign key to a projection, so a rebuild leaves it alone (it is not in `SAVED`; `rebuild-operational.test.ts` and `blog-writer.test.ts` check). Settings are `platform_settings` keys `blog_writer_enabled|per_day|topics|model|cap_usd|search_usd|prices` (changes append `BlogWriterSettingsChanged`, shown in the audit log). Routes (super admin): `GET|PATCH /api/platform/blog/writer`, `POST /api/platform/blog/writer/run` ("Write one now": waits for the run, 409 `cap_reached|daily_cap|blog_disabled|no_api_key|price_unknown|already_running`). Migration 1580.

**Research topics and the diagnostic-data consent** (`docs/design/ceo-blog-topics.md`, Phase 1; the CEO side is Phase 2). The writer takes **queued research questions** before its theme rotation. `blog_topics` (projection, migration 2240, in `PROJECTION_TABLES`) is fed by `BlogTopicQueued|Writing|Released|Declined|Rejected|Duplicate|Moved` on the stream `blog-topics`; it has **no organization, candidate or foreign key**, and `BlogTopicQueued` is a strict schema (`topicId, question, area, origin`) with nowhere to put source material. `queueBlogTopic` (`blog/topics.ts`) is the only appender and takes a `ScrubbedTopic`, the branded result of `scrubTopic` (`packages/shared/src/blog/topic-scrub.ts`, pure: shape, identifier patterns, org deny-list with fuzzy match, proper-noun gate against `public-terms.ts`, first-person gate; the super admin can confirm an unknown proper noun per question). A question already covered by a queued topic or a published title (word overlap 0.6, 180 days) is stored as `duplicate`. `pickTopic(ctx, settings, runId)` takes the oldest queued topic (`BlogTopicWriting`) while fewer than `blog_writer_queued_per_day` (default 1) queued topics were taken today (UTC), else the rotation; a run that fails technically releases the topic (queued again, `declined` after the second attempt), a writer `problem` declines it for good, a rejected article gives it one more attempt. `BlogPostSubmitted.topicId?` links the article, and `BlogPostPublished` projects the topic to `published`. The prompt frames the topic as a reader's question to be researched from public sources. `blog/**` never reads CEO data: `test/blog-writer-boundary.test.ts` fails on an import of `ceo/`, `platform-team/` or `chat/` and on a CEO, ledger, card, thread or vault table in its SQL. Super admin routes: `GET|POST /api/platform/blog/topics`, `POST .../:id/reject|move`; web: Platform > Blog > Topics (`?tab=topics`). The organization-level consent **"Share diagnostic data with Guildwise"** is `OrgDiagnosticsSharingSet {orgId, on, consentVersion, by}` (Owner only, off by default, projected to `organizations.diagnostics_sharing`, in the platform audit log; `PATCH /api/org {diagnosticsSharing, consentVersion}`). Until the consent text (`orgs/diagnostics-consent.ts`, a draft) has been reviewed under POPIA, only the platform organization has it: customer organizations get `diagnosticsSharingAvailable: false` and 403 unless `AOM_DIAGNOSTICS_CONSENT_CUSTOMERS=true`, and the Settings toggle is hidden.

**Research topics, the CEO side** (Phase 2 of the same design, migration 2241, owner decisions of section 11). `ceo_topic_candidates` (projection of `CeoTopic{Noted,Proposed,Merged,Reviewed,Expired,HandedOff,Outcome}` on `ceo-<orgId>`, events in `shared/events/ceo-topics.ts`, projector `projections/ceo-topics.ts`) holds problem notes (`status='note'`, evidence ids plus the signal's own title, org data that never leaves) and candidates. `ceo/topics.ts` `noteSignals` makes one note per signal (deterministic uuid from org, source and subject) from `ceo_offboard_jobs` (a non-routine kind or over 20 minutes), `ceo_repeats`, `ceo_corrections` (deploy, devops, agent classes), resolved `loop_parked` desk items, failed `devops_requests` and blocking desk items the owner took over 4 hours to answer; failed recipe deploys (`deploy_runs` with status `failed`, not a trial or dry run; source kind `deploy`, evidence kind `deploy_run`). Nothing is collected unless `sharingMode` allows it: the platform organization always, any other organization only while `organizations.diagnostics_sharing` is on. The CEO's review brief lists up to 10 open notes as quoted data; `aom ceo topic list|propose [--from <note id>] --area .. --question ".."` (rpc op `topic`; owner turns and wakes, never an order turn or an untrusted wake) runs `scrubTopic` with the org deny-list built by `ceo/topic-denylist.ts` (org, project, repo, vault, agent, member, workstation and deploy-target names; never stored or sent), refuses with reason codes (three tries per note), merges into an earlier candidate of the same area (overlap 0.6, 180 days) and otherwise `CeoTopicProposed`. Notes and proposals expire after 14 days. Owner review: `GET /api/ceo/topics`, `POST /api/ceo/topics/check|:id/accept|:id/reject` (accept may carry an edited question and `allowTerms`; the scrubber runs again). In a customer organization only the Owner decides (his consent); in the platform organization the Owner or an Admin. One coalesced non-blocking desk item (subkind `ceo_blog_topics`, subject `blog-topics:<orgId>`, addressed to the Owner in customer organizations) asks "These might make good blog articles for the community. May I send them to Guildwise as research topics?"; Approve accepts every proposal as written, Reject drops them all (`commands/desk.ts`), and it resolves itself when nothing is left to review. The daily report shows "Research topics from this week" (Accept / Edit / Reject, live from the API) and "Published from your topics"; the fallback report carries the same as text. The hand-off lives outside `blog/**` (`ceo/topics-handoff.ts`, run from the reporter sweep): for each accepted candidate it re-scrubs (third run), checks the consent and the monthly cap (4 for customer organizations), and calls `queueBlogTopic` with the `topicId` fixed at Accept (a retry finds the topic and does nothing), which appends `BlogTopicQueued` on its own with the system actor, no causation id and no organization. It then appends `CeoTopicHandedOff` on the org stream. The same sweep withdraws queued topics when the consent is off (`withdrawTopics`, also at once from `setDiagnosticsSharing`) and reads publication back as `CeoTopicOutcome` (status back; slug and title are public). Web: `/ceo` Topics tab, the two report sections.

**Web.** Platform: `/platform/blog` (Writer panel, queue, kill switch, moderation, digest, social), `/platform/blog/:id` (preview, edit, approve, reject, unpublish, share), `/platform/api-keys`; the shell shows a pending badge. Help > Blog at `/help/blog[/:slug]` (and under `/platform/help`), `blog` is a reserved help slug, the help search adds "From the blog". The landing header and footer link to `/blog`. Checkbox at invitation acceptance (`blogDigest` in the accept requests) and in Settings.

## 32. Billing (built; owner decisions in `docs/design/open-questions-2026-10-09.md`)

**Storage** (`migrations/1440_billing.sql`; operational tables, not event-sourced): billing state is operational and survives a projection rebuild (`rebuild.ts` saves and restores `billing_subscriptions`, `billing_invoices`, `billing_profiles` and `email_verifications`); `billing_plans` (editable catalogue, seeded in code by `ensurePlans` because tests truncate every table), `billing_subscriptions` (one per organization: status `incomplete|trialing|active|past_due|paused|cancelled`, the price it started at, `addons`/`pending_addons`/`addon_prices`, token, card brand/last4/expiry, period, `cancel_at_period_end`, credit), `billing_invoices` (unique per organization, kind and period start; numbers `GW-<year>-<seq>`; USD, VAT, rate, ZAR), `billing_fx_rates` (one rate per day), `billing_notices` (a mail is sent once per organization, kind and key), `email_verifications`, `users.email_verified_at`. What a subscription does to an *organization* is written as the usual events by the system actor (`OrgPlanChanged` with the plan's limits, `OrgLimitsSet`, `OrgStatusChanged` with reason `billing:<why>`), so the projections, the audit log and rebuilds stay correct. New events: `UserEmailVerified`, `UserRegistered.unverified`, `PlatformBillingChanged` (catalogue and settings edits, audited).

**Engine** (`apps/server/src/billing/`): `engine.ts` (start, trial, invoices, charging, renewal tick, plan change with proration, add-ons, cancel, resubscribe, admin pause/unpause/Unlimited), `catalogue.ts` (plans, settings in `platform_settings`, exchange rate), `provider.ts` (the `PaymentProvider` interface and the fake provider), `payfast.ts`, `card.ts` (card capture and the ITN handler), `signup.ts`, `runtime.ts` (`ctx.services.billing`: provider and rate source, replaceable in tests). Routes: `routes/billing.ts`.

**No double charge.** An invoice is claimed (`status='charging'`, `attempts+1`) by a conditional UPDATE before the provider is called; a second tick or process skips it. If the provider call throws (outcome unknown) the invoice stays `charging` with a reason and is never retried automatically. Invoices are unique per (organization, kind, period start), so a renewal is created once. Interactive charges (plan change, resubscribe) void their invoice on failure instead of starting the retry schedule.

**Schedule.** `Scheduler.runBilling()` (every 5 minutes and on boot; `AOM_BILLING_JOBS=false` switches the timer off; the test-clock route runs it): ends of cancelled terms, renewal invoices (pending plan and add-on changes are applied first), charging of due invoices (retries at the invoice date, +1 day, +3 days; the third failure pauses), trial reminders (2 days before), card-expiry notices (35 days before and after). All idempotent.

**Money (migration `1490_billing_vat_profile.sql`).** `usd_cents` on an invoice is the VAT-INCLUSIVE price; `vat_cents` is the VAT contained in it (USD), `vat_zar_cents` the VAT contained in the rand charged, `vat_percent` the rate applied, `snapshot` the supplier and customer as they were when it was paid (a tax invoice must not change later). `vat.ts` holds the maths: `vatContained(gross, p) = round(gross x p / (100 + p))`, half away from zero so a proration credit mirrors its charge; `invoiceAmounts(usd, rate, p)` converts the inclusive USD price at the day's rate (rounded to the cent) and takes the rand VAT out of the rand amount, so the rand figures add up. Settings in `platform_settings`: `billing.vat_percent` (default 15), `billing.supplier` (name, trading name, address, VAT number, registration number, email; placeholders until the super admin enters them), `billing.fx_override`. `billing_profiles` holds the Owner's profile (business customers only; sign-up requires the company name). `invoice-html.ts` renders the printable tax invoice (`GET /api/billing/invoices/:id/print`, and the same for the super admin under `/api/platform/orgs/:id/billing/invoices/:invoiceId/print`); no script, so the CSP stays strict.

**Provider interface.** Amounts are minor units plus a `currency` (billing passes `ZAR`: Paystack and PayFast settle South African merchants in rand only). `ChargeInput` carries `attempt` (1-based) and the customer `email`; `PaymentNotification` has a `kind` (`payment|refund|other`), the card when the gateway sends it and the currency. Capture results are `done` (fake), `redirect` (PayFast form) or `link` (Paystack checkout URL). `applyNotification` (`card.ts`) is the single place a validated notification becomes state: a `cc-` capture saves the token and card then refunds the check; an invoice reference (`GW-...-aN`) settles an invoice stuck in `charging` (reconcile by reference, `reconcileInvoice` in `engine.ts`); refund events are logged.

**Paystack** (`paystack.ts`, written from the public REST documentation without a merchant account; `UNVERIFIED` markers in the source and `docs/DEPLOY.md`). Capture: `POST /transaction/initialize` (card channel, small ZAR amount, our `cc-<uuid>` reference, `callback_url` back to the Billing tab); the customer pays on Paystack's checkout; the `charge.success` webhook, or `GET /transaction/verify/:reference` when the customer returns (`POST /api/billing/card/sync`), carries the `authorization`: `authorization_code` is the token (kept only when `reusable`), `brand`, `last4`, `exp_month`, `exp_year` are the card shown and used for expiry reminders. The check amount is refunded (`POST /refund`). Charge: `POST /transaction/charge_authorization` with the amount in ZAR cents and the reference `<invoice number>-a<attempt>`, unique per attempt, so Paystack itself refuses a repeat. `success` pays; `failed` is a decline; any other status, a 5xx or a duplicate-reference answer throws, which leaves the invoice in `charging` for the webhook or a human. Webhook: `POST /api/billing/paystack/webhook` (exempt from the Origin check; the JSON parser keeps the raw body for this route only) verifies `x-paystack-signature`, the HMAC-SHA512 of the raw body with the secret key, in constant time. Card update: the same capture again; `cardSaved` replaces the token and a past-due invoice is retried. Sandbox is derived from the key (`sk_test_`).

**Providers.** `AOM_PAYMENT_PROVIDER=paystack|payfast|fake`; unset, Paystack is used when `AOM_PAYSTACK_SECRET_KEY` is set, else PayFast when its keys are set, else `fake` (`AOM_BILLING_PROVIDER` is a deprecated alias). `fake` test cards decide the outcome (see `provider.ts`). `payfast` builds the hosted-page form with `subscription_type=2` (tokenization), charges with the ad hoc API (`POST /subscriptions/:token/adhoc`, signed), and validates the ITN (`POST /api/billing/payfast/itn`: signature in received order, source address, server confirmation, then the amount) before saving the token and refunding the card check. The ITN route is exempt from the Origin and JSON checks and parses form bodies as raw text. **Unverified without a merchant account:** see `docs/DEPLOY.md` "Billing".

**Sign-up and login.** `POST /api/signup` creates the user (`unverified`), the organization (`suspended`, `billing:setup`, created via `signup`) and an `incomplete` subscription; `verifyLogin` refuses an unverified email (403 `email_not_verified`); `POST /api/auth/verify-email` confirms and signs in. **Billing gate.** `activeOrgDto` (`orgs/summary.ts`, `billingGate`) adds `gate` to `me.activeOrg` for the Owner of an organization suspended with `billing:setup` (kind `setup`) or `billing:payment_failed` / `billing:cancelled` (kind `resubscribe`); not for Members, `billing:admin`, simulation or Unlimited. `RequireAuth` (web `components/Layout.tsx`) renders `pages/BillingGate.tsx` instead of `AppShell` while it is set, redirects every other path to `/billing-required` (query kept, so the Paystack return `?card=saved` reaches the screen, which calls `POST /api/billing/card/sync`) and stops the live socket. The tour, checklist and What's new live inside `AppShell`, so none starts (or is marked seen) while gated. The screen uses only `me`, `GET /api/billing`, the card/resubscribe endpoints, logout and the support-ticket endpoint. `removeAbandonedSignups` (`billing/abandoned.ts`) also removes verified sign-ups still on `billing:setup` after 14 days (`VERIFIED_NO_CARD_GRACE_MS`; `SignupAbandoned.verified`). Web: `/signup`, `/verify-email/:token`, `/billing-required`, Organization > Billing, `/platform/billing`, the Billing panel on `/platform/orgs/:id`, and the landing page's Pricing section (default plans built in, refreshed from `GET /api/public/plans`).

## 33. Simulation organizations (built; owner request of 2026-10-10)

A super admin can flag an organization `simulation` (`organizations.simulation`, `simulation_pace`; events `OrganizationCreated.simulation`, `OrgSimulationSet`; migration `1540_simulation.sql`). A new-organization invitation can create one directly. Effects:

- **Billing.** Treated as Unlimited and never billed: turning it on drops the subscription and card token and voids open invoices (`assignSimulationBilling`), subscribe, card capture, plan, add-on and resubscribe calls answer 409 `simulation`, `notifyOnce` sends no billing mail, the licensing tick skips it, the Billing overview says `mode: 'simulation'`.
- **Switching.** `setOrgSimulation` (`commands/simulation.ts`) turns simulation on only for an empty organization: 409 `simulation_not_empty` when it has any project (archived ones count) or a billing subscription that is not `cancelled`. Turning it off is refused with 409 `simulation_permanent` ("A simulation organization stays one until it is deleted"); only the pace can change afterwards. Existing simulation organizations and new ones created by invitation are unaffected. The platform page locks the switch and points to "Delete simulation organization".
- **Mail.** `mail/simulation.ts` wraps the mailer and the organization the mail is about decides: `MailMessage.orgId` (looked up in `organizations.simulation`) or `MailMessage.simulation` (an organization that does not exist yet, as in a new-organization invitation) puts `[Simulation] ` in front of the subject, whoever receives it. Org-specific senders pass it: organization invitations, new-organization invitations, billing mail (`notifyOnce`), cloud workstation problems, scheduled reports, support tickets (the ticket's organization), and the platform notices about a sign-up or an audit entry that names an organization. Mail not tied to an organization (password reset, e-mail verification, blog digest, social alerts) is never prefixed. The old recipient-membership heuristic is gone.
- **Simulated workstation.** `src/simulation/host.ts`. For each simulation organization the server pairs a workstation of the Owner itself (`createPairingCode` + `pairRunner` with `simulationOrgId`; `workstations.simulation_org_id`, migration `1541`), writes the runner's `config.json` (mock runtime only) under `AOM_SIMULATION_DIR/<org id>/runner`, and starts and supervises ONE runner child process (restart with back-off; stale processes of a crashed server are killed by pid file). The runner connects back over the normal gateway, so the dispatcher, cards, reviews, tests, desk and finalize are the real code. Pace sets `AOM_MOCK_STEP_MS` / `AOM_MOCK_CHAT_TOKEN_MS`; chats answer from `simulation/replies.ts` (written as `AOM_MOCK_REPLIES_FILE`; the runner's `scriptedReply` matches exact text, `/regex/` keys, then `*`). Repositories: `repoAddedEvent` replaces any typed URL with a local bare origin created by `simulation/repos.ts` under `AOM_SIMULATION_DIR/<org id>/origin` (needs `git` on the server image), so clone, worktree, merge and push work offline and nothing contacts a forge. **Repository requests** (`aom repo create` by the BA or DevOps, or the project convert dialog) keep their desk approval, but in a simulation organization the request needs no connected workstation and approving (`resolveRepoCreateIn` -> `completeSimulatedRepoIn` in `commands/repo-create.ts`) adds the repository through the same local-origin path and records `RepoCreateCompleted` at once, instead of queueing `repo.create` for a workstation; the simulated workstation then clones it. Chat replies are a data-only map of regex topics with several alternatives each (BA: requirements, scope, acceptance criteria, estimates, next steps, cards from a conversation, risks, status; builder/reviewer/tester/DevOps: progress, test results, deploy status), a fixed pick per message text. In production `docker-compose.prod.yml` mounts the named volume `simulation` at `AOM_SIMULATION_DIR=/data/simulation`.
- **Real workstations get no work.** `simulation/fit.ts` (`wsServesOrgSql`): a simulated workstation serves only its organization, a real one never serves a simulation organization. Applied in the dispatcher, claim, desk-question, BA-task and DevOps passes and the chat relay; DevOps engineers are hired accordingly.
- **Wipe (the one exception to append-only events).** `wipeSimulationOrg` (`commands/simulation.ts`): only for `simulation` organizations, name typed back. The trigger `events_append_only` (migration 1540) allows DELETE only inside a transaction that set `aom.simulation_wipe = 'on'` and `aom.wipe_org` to an existing simulation organization; UPDATE is never allowed. Deleted events: `org_id` = the organization, events of its projects, of the invitations that created it or were accepted by deleted accounts, per-user streams and events of deleted accounts, its simulated workstation's stream, and events whose payload names the organization. Rows are removed by `simulation/wipe.ts`, which discovers tables from the schema (`org_id`, `user_id`, `simulation_org_id` columns, then foreign keys recursively, child tables first), so nothing depends on a hand-kept list; the test scans every table for the organization's ids, before and after a projection rebuild. Accounts whose only membership is this organization (and without guest access elsewhere) are deleted so their email can sign up again; others only lose the membership. The permanent record is the `SimulationOrgWiped` event (no org scope) and its `platform_audit_log` row (names, member emails, counts). The server has no database backup of its own: the operator takes one first (DEPLOY.md). After the commit the host stops the runner and removes `AOM_SIMULATION_DIR/<org id>`.
- **Demo scenario.** `simulation/demo.ts` drives the normal API as the Owner to fill an EMPTY simulation organization (refuses with 409 otherwise).

## 34. Platform team (built; design: Lean Team v3 section 8, owner decisions of 17 Oct)

Guildwise fixes itself with a normal team in a normal project. The super admin only designates which one; every approval and report goes to that organisation's desk (a super admin has no desk).

- **Designation.** `platform_settings` key `platform.team` = `{ orgId, projectId }` (`platform-team/settings.ts`; `PUT /api/platform/team`, super admin; event `PlatformTeamDesignated`, shown in the platform audit log). Designating sets `decisions_project_only` on the project (`ProjectPolicySet`), so HR and the CEO cannot promote its decisions to the organisation. Without a designation intake still records bugs (`platform_bugs`) and raises nothing; the next platform pass files the cards when a team appears (`drainBugs`).
- **Bug intake** (`platform-team/intake.ts`, `detectors.ts`; migration `2160_platform_team.sql`). Every detector calls `reportBug` with a stable signature: one `platform_bugs` row per signature with an occurrence counter, one bug card per signature in the platform project (`createCardIn`, type `bug`, origin `trigger`, `designNeeded`, so it lands in the architect's stage), counter milestones as card notes, no duplicate cards. Evidence counts once (`platform_bug_hits`). At most 12 new cards per hour (`INTAKE_NEW_CARDS_PER_HOUR`); the rest waits recorded. A fixed bug that returns reopens with a new card. Sources: `runner_errors` (new signature or growing counter), server 5xx (the Fastify error handler calls `reportServerError`: route pattern plus error signature, aggregated for 2 s), loops (`reporter/detectors.ts` `detectLoops`: back-off episodes and `loop:questions:<card>`; question shifts the runner refused do not count), rejection storms (8+ rejections with one reason on one workstation in 30 min), role smoke failures (`workstation_role_blocks`). `platformPass` (dispatcher, at most every 15 s, never throws) runs the scan and the housekeeping.
- **Triage.** The architect runs `aom bug triage --invalid --reason ...` or `--severity critical|degraded|minor --size small|medium|large` (RPC `platform.triage`, architect of the platform organisation only; managers can use `POST /api/platform-team/bugs/:cardId/triage`). Invalid cancels the card and ends its pauses. Severity is by rules (a repeated, scoped failure is critical) until the architect sets it.
- **Scoped pauses.** Projection `platform_pauses` of `PlatformPauseStarted`/`PlatformPauseEnded`; a card is held when an open pause matches every field it names (project, workflow, stage, and the shift's workstation). `platformPausedSql` is one clause in the candidate query and never applies to the platform project. Critical bugs with a scope pause it automatically (loop: project+workflow+stage; storm: workstation (+project); runner crash loop: the workstation); a pause ends when the linked bug card is done (or cancelled/invalid), or by hand (`POST /api/platform-team/pauses[/:id/resume]`). Every pause and resume is a coalesced note on the platform desk. Web: banner on affected projects, badge on workstations, list on `/platform/team` and `/platform-team`.
- **Deploy policy** (`platform-team/deploy.ts`; models the policy only, nothing deploys). `POST /api/platform-team/deploy/check` answers "is this allowed?" (review, tests and UAT done; high risk and downtime need approval) and `.../deploy/record` writes the audit trail and a report on the platform desk. High risk is `classifyDeployRisk(changedFiles)` (path globs in `@aom/shared` `platform/index.ts`: auth/permissions/secrets, data/migrations, tenancy/billing; sandbox, policy and deploy code are excluded), computed on the server. Approvals are desk items (`platform_deploy_approval`, `platform_downtime_approval`) resolved through the desk's `closeItem`. A low-risk fix for a bug that pauses work needs nobody's consent; the desk is informed.
- **Fix stop-loss.** S1a's `commands/stop-loss.ts` does the parking, architect arbitration and desk escalation; `platform-team/stop-loss.ts` `platformFixBudget` is where platform cards ask for their budget, sized by `platform_bugs.fix_size` (set in triage).
- **Client diagnostics and grants** (`platform-team/grants.ts`). Bug cards carry only sanitised diagnostics (`@aom/shared` `platform/sanitize.ts`, the sanitiser the runner uses: masked message, function plus file basename, counts, versions). A card reference for a client bug is kept in `platform_bugs.extended`, readable only under an approved grant: the platform team requests it (`POST /api/platform-team/grants`), the client organisation's Owner/Admin approves on its desk (`platform_grant_request`), it lasts 24 h by default (at most 72 h), every read is logged (`platform_diag_access`), and the client can revoke.
- **Safe mode** (`platform-team/pins.ts`). `PUT /api/platform-team/runner-pin` pins a workstation (or all, `workstationId: null`) to a release the server has. `welcome.runnerPin` and the `runner.pin` command (capability `runner-pin:1`) tell the runner; its `Updater.setPin` fetches `GET /api/runner/release?version=` and switches, an older version too, with the usual probation and rollback, and ignores newer releases and the pause switch while pinned. Visible on the Workstations page.
- **Check for updates** (`commands/update-check.ts`). `POST /api/workstations/:id/update-check` (the workstation's owner; 409 `workstation_offline` / `update_check_unsupported`, 429 once a minute) queues the `runner.update.check` command (empty payload, expires after 5 minutes, only for runners with capability `update-check:1`). The runner's `Updater.checkNow()` runs the usual check and answers `{ outcome: up_to_date | update_found | paused | disabled | failed, version, detail }` as the command result. The request time and the answer are operational data in `workstations.runner_update_check` (saved across projection rebuilds, no event) and reach the web as `WorkstationDto.updateCheck`.

## 35. The lean team workflow, `code` version 6 (built; design: Lean Team v3, stream S3)

Built-in `code` **version 6** (`packages/shared/src/workflows/builtin/code-v6.ts`, `leanTeam: true`), rolled out exactly like v3 to v5. How those reached projects: built-ins are registered at boot (`catalogue/boot.ts`, a `WorkflowVersionRegistered` per missing `(key, version)`), the resolver (`resolveWorkflow`) returns the newest active version of a key, `resolveProjectCardWorkflow` uses it for every new card of a project on `code`, and a card is pinned to the `workflow_version_id` it was created with. So a new version needs no per-project step, no opt-in and no data migration: new cards take it, cards in flight keep their version. The only in-flight moves are the two classic ones (`reviewApprovedPlan`, `finalizeNext`: an old `code` card moves to the newest *classic* version; `resolveWorkflow(..., {classic: true})` skips lean team versions, so they never carry a v1-v5 card into the lean flow). New projects take `AOM_DEFAULT_WORKFLOW` (`code`); the test helper `createTestApp` supersedes `code` v6 unless `lean: true`, so the suites written for v5 keep running. `POST /api/projects/:id/upgrade-workflow` is gone (410). Features come from the definition, never from a key: `isLeanTeamWorkflow(def)` (`workflows/legacy.ts`: `def.leanTeam`, or the stored definition of the legacy key) and the stages (`owner_approval`, `test_deploy`, `planning` ...); `ProjectDto.leanTeam` tells the web whether new cards are lean team (the owner approval panel shows only then).

**The legacy key `code-v6` (folded into `code` on 18 Oct 2026).** The first rollout registered the same flow as a workflow of its own, `code-v6` v1, and moved P4, P5 and "Guildwise HQ Platform" (GWP) onto it. The owner reversed that. Nothing written before is changed; the single alias is `LEGACY_CODE_V6_KEY` / `canonicalWorkflowKey` in `workflows/legacy.ts`: `resolveWorkflow` and `getBuiltinWorkflow` map the key to `code`, the `ProjectCreated` projector keeps the old "automatic full suite off" rule for a project created on that key, and `isLeanTeamWorkflow` counts the stored definition of the old row. No built-in has the key any more, the catalogue, designer, project workflow and sub-workflow lists hide the row, and nothing can enable or select it. The fold is step 5 of `data-migrations/lean-rollout.ts` (`fold-code-v6.ts`, dry run by default, `--apply`): `ProjectPrimaryWorkflowChanged` (a project whose primary workflow was the key), `ProjectWorkflowsSet` (a project that enabled it next to `code`: `code` takes its default card types), `CardWorkflowVersionChanged` for every card pinned to the legacy row (any status; the stage ids are compared first and the step refuses on a difference, the stages are identical) and last `WorkflowVersionRetired` (deletes the row and its stages only when no card, variant or enabled entry refers to it; checked again when it runs). **Replay of pre-fold history:** the old events are never rewritten. A rebuild replays them in order (the legacy row registered, cards created on it, the key enabled) and then the fold events, which end in the same state as the live database (`test/fold-code-v6.test.ts` rebuilds and compares). On a database that has not run the step yet the alias keeps everything working (new cards of such a project already resolve to `code` v6).
- **Stages.** spec, `planning` (planner, fallback architect, `worktree: none`, read-only checkout; outside the dependency gate), `investigate` (every card: `defaults.designNeeded`), `build` (`requireBuildEvidence`), `pre_review` (pre_reviewer, fallback reviewer, `rebaseBefore`), `review` (reviewer, `rebaseBefore`, `approvals {1, 1}`), `merge_review`, `owner_approval` (human approval step, `when ownerApproval`), `test_deploy` (a new stage `kind: 'server'`, `server.action: 'test_deploy'`), `test` (`envStrict`, no rebase), docs, finalize (no rebase), `qa_steps`, `manual_qa`. New schema fields are all optional or defaulted: `Stage.kind 'server'`, `Stage.server`, `Stage.envStrict`, `Stage.requireBuildEvidence`, `WorkflowDefinition.defaults`, outcome data kind `buildHandoff`, derived flags `ownerApproval` and `mergeReview`. Migration `2140_code_v6.sql`: the card columns `group_id`, `card_brief`, `head_sha`, `build_evidence`, `high_risk(_paths)`, `owner_approval_required/_reason`, `owner_approved_sha`, `test_deploy_state`, `merge_review`; `card_groups` (projection of `GroupBuilderAssigned`), `card_diffs` (written with the handoff, not an event projection), `shifts.start_sha`, `workflow_stages.env_strict`, `projects.owner_approval_policy` and `e2e_areas`. New events (`events/code-v6.ts`, projectors in `projections/code-v6.ts`; the fold events `ProjectPrimaryWorkflowChanged`, `CardWorkflowVersionChanged`, `WorkflowVersionRetired` are in `events/project-workflows.ts`, projectors in `projections/project-workflows.ts`): `CardGroupSet`, `CardBriefSet`, `GroupBuilderAssigned/Cleared`, `CardHeadObserved`, `EvidenceLapsed`, `OwnerApprovalLapsed`, `TestDeployResolved`, `ProjectOwnerApprovalSet`, `ProjectE2eAreasSet`, `FinalizeConflictHeld`, `ConflictResolutionRecorded`; additive optional fields on `ReviewRequested` (head SHA, evidence, high risk), `ReviewApproved` (`excludeReviewer`, `ownerApproval`), `ChangesRequested.fromStage` (also `pre_review`, `merge_review`), `ApprovalRequested/Decided.sha`, `ShiftStarted.worktree.rebased`.

- **Roles.** `planner` (Haiku, read-only) and `pre_reviewer` (Sonnet, read-only) are new built-ins; the reviewer instructions and core rules (v6) are read-only (no build, no tests, no sub-agents), the builder, architect, tester, writer and BA gained the lean team stages (their `claimableStages` name `code`, not a separate key; role versions bumped for it) and, for the builder and architect, the evidence, group and Card Brief text.
- **Evidence and the commit.** The builder's `aom handoff --build-command/--build-result/--test-command/--test-result` (or `--no-evidence "<why>"`) becomes `data.buildEvidence`; the runner (`git/card-diff.ts`) attaches `headSha` (after the autocommit), `changedPaths` and the diff `<base>...HEAD` to `shift.report`. `leanHandoff` (commands/shifts.ts) refuses a handoff without a passing build and unit test run or without the runner's SHA, binds the evidence to that SHA, and computes `high_risk` from `HIGH_RISK_GLOBS` (`packages/shared/src/workflows/high-risk.ts`, also imported by the platform team): the flag is recomputed at each handoff and no agent field is read. `shift.started` carries the commit (`shifts.start_sha`, `rebased`); `leanHeadEvents` records a rebase (evidence and approvals follow), a documentation commit or a merge review's resolution (`CardHeadObserved`), and a review shift at another commit than the evidence releases the claim and sends the card to Build (`EvidenceLapsed`). A review verdict is refused when the evidence, the branch and the commit the reviewer read are not one commit (`reviewShaProblem`).
- **Review.** A pre-review approve is `StageCompleted`, a finding is `ChangesRequested{fromStage:'pre_review'}` with builder affinity (S1a) and only the build-pass stop-loss (`limitReached{preReview}`); the review-round cap stays S1a's (`commands/stop-loss.ts`, review rounds counted at stage `review`). `required = max(stage.approvals, high_risk ? 2 : 1)`; the second approval excludes the first reviewer unless no other senior reviewer is hired.
- **Owner approval.** At the last review approval `ownerApprovalDecision` (`cards/lean-v6.ts`) decides from the project policy (`large_or_high_risk` default, `always`), the risk tier, the path-computed high risk, the reviewer's own high rating and the older `merge_large_without_approval`; the decision and its reason are in `ReviewApproved.ownerApproval` and on the card thread, and `workflowView` exposes `ownerApproval` so the outcome skips or enters `owner_approval` (an existing approval step, `commands/approval.ts`). The request carries the card's head SHA; `decide` refuses an approval when the head moved (it re-asks for the new SHA, `409 approval_stale`); `mergeGate` returns `none` for a workflow with the step, `ownerApprovalLapse` stops a finalize whose approved SHA is not the head (`OwnerApprovalLapsed` back to the step) and the `finalize.execute` payload carries `expectedSha`, which the runner checks before its own rebase. `GET /api/cards/:id/diff` serves `card_diffs` (2 MB, cut on a line with a note); `CardApproval.review` carries the SHA, reason, evidence, verdicts and diff metadata; the web `DiffView` renders it without a dependency.
- **Test deploy.** `testDeployPass` (commands/test-environments.ts, in the dispatcher's `testEnvironmentPass` before `provisionPass`) handles cards queued at a `server` stage: it records a skip (`TestDeployResolved{skipped}`) when the project tests without an environment, runs a suite card, has integration tests off for the card or project, or tests a remote target; otherwise it starts the run through `startTestRunIn` without `rebaseCard`, waits for `run_environments.sources[].commit` to equal the card's head SHA (a healthy environment at another commit is stopped), and appends `StageCompleted test_deploy -> test`. Failures use `handleFailedEnvironments` (the DevOps request parks the card in Test deploy; the second failure is a desk item); a start the server cannot make raises one coalesced desk item. The candidate query's `envReady` has no escapes for an `env_strict` stage: only a healthy environment of the card, `test_deploy_state = 'skipped'` or S1b's `test_without_environment`.
- **Groups.** The planner, architect and BA call `card.group` and `card.brief` (`commands/card-group.ts`; CLI `aom group`, `aom brief`, `aom plan`). `claim()` renews `GroupBuilderAssigned` on every build claim of a grouped card; the candidate query holds the rest of the group to that builder (hard, expires after 24 h, ignored when the agent is gone or paused) and sorts its next group card first; `affinityResume` resumes the session of the builder's last build shift in the group with the next card as the first message (the runner applies the 120K/4 h ceiling and copies the transcript into the new worktree's folder).
- **Area E2E.** The tester brief carries the card's changed paths (`card_diffs.paths`) and the project's mapping; the runner (`testing/e2e-areas.ts`, shared `selectE2eSpecs`) maps them to spec files (repo `e2e/areas.json` over the project setting over names derived from the E2E folders) and adds the list to the tester prompt. `full_suite_after_finalize` is ignored for a lean team card (the `full_suite_after_finalize` flag is off for a project created on the legacy key); `POST /api/projects/:id/full-suite` starts the suite card by hand.
- **Merge conflicts.** `cardConflictBrief` tells DevOps to work in a scratch worktree and move the card branch with one `--ff-only` merge at the end. For a reviewed card at Finalize `applyFinalizeResult` holds it in Finalize (`FinalizeConflictHeld` plus the DevOps attempt) instead of `RebaseConflict` to Build; `unparkPass` then sends a resolved conflict to `merge_review` (approvals untouched; the reviewer reads `git diff <reviewed> HEAD` and either approves back to `test_deploy` or requests changes to Build, which re-reviews) and an unresolved one to Build. Whether the resolution touched reviewed lines beyond the merge is the merge reviewer's call, not a heuristic.
- **Not done.** Variants of the lean team flow (`NON_VARIANT_BASES` still only allows `code` as a variant base); a web editor for the E2E area mapping (API and file only).

## 36. Project graphs and the organization graph (built through phase 6; design: `docs/design/project-graphs.md`, backlog #82)

A project graph is a **derived index** of a repository's code and docs, built on the workstation that holds the clone and kept in
the project vault (`<folder>/graph/`). It is a brain for agents and the CEO, not a page: **nothing code-derived reaches the server**
(no names, no paths, no module names, no labels). The server holds status and the work it already owns.

- **Vaults.** A vault has a storage, `git` (synced) or `local` (a folder on one workstation, no remote, no sync; the owner backs it
  up). Every project has a vault: `ProjectVaultEnsureRequested` at creation and by the data migration `project-vaults-2026-10`, and the
  owner's primary workstation gets a local one (`ensureProjectVaultIn`, `ensureProjectVaultsForWorkstation`, `vaults.storage`,
  `vaults.local_workstation_id`, migration 2230). Switch: `projectGraphs.enabled` (`AOM_PROJECT_GRAPHS`, default on).
- **Indexing (runner, `apps/runner/src/graph/`).** `git ls-tree` and `git cat-file --batch` read a commit without touching the
  worktree; sensitive names and vendor, binary, generated and oversized files are skipped before anything is read; tree-sitter WASM
  (`@vscode/tree-sitter-wasm`, pinned, shipped in `dist/grammars` with `THIRD_PARTY_NOTICES`) gives symbols, imports and calls;
  `build.ts` resolves imports exactly (EXTRACTED), calls and inheritance by name within the import set (INFERRED, or AMBIGUOUS with the
  candidates listed, never more than five); `shards.ts` writes sorted, diff-friendly shards (`repos/<repoKey>/<module>.jsonl`,
  `_edges.jsonl`, `_work.jsonl`, `communities.json`, `modules.md`) and `manifest.json`, touching only files whose bytes changed. The
  per-file facts cache is keyed by blob id and parser fingerprint. Same commit, same indexer, same bytes.
- **Server status.** `graph.index` and `graph.update` are durable runner commands; their answers are parsed by a schema of numbers, a
  commit and fixed reason codes, and become `ProjectGraphIndexed|Updated|Failed` (table `project_graphs`, migration 2231). A merge
  (`CardFinalized` with a merge commit) queues `graph.update` from a gateway reaction, not a projector. `projections:rebuild` rebuilds
  status only; the graph is regenerated by the indexer at the recorded commit.
- **Reaching the agents.** `aom graph query|path|explain|impact` are answered by the runner from memory (token-budgeted, capped,
  every link tagged E, I or A); card shifts get a fenced "Graph context" section of at most 1.5 KB; chats get query and explain;
  the server tells a shift or chat where the graph is (`graph: {vaultId, folder, arm}`). No MCP server.
- **Measurement.** The runner counts discovery bytes and calls before the first edit, `aom graph` bytes and calls, and the section
  size, and sends numbers on `shift.ended`; the server stores `ShiftContextMeasured` with the billed input tokens
  (`shift_context_metrics`, migration 2232). During four weeks after a project's first index one card in five (hash of the card id)
  runs without the graph. `GET /api/value/graph` (Costs page) reports both arms with a stratified bootstrap interval and the quality
  guards, and offers the percentage only when the design's rule holds.
- **Organization graph.** Built on the workstation of the organization vault into `org/graph/` (`graph.org`); links derived from code
  are drafts and stay there. The server keeps only links the owner asserts (`OrgGraphLinkAsserted|Retracted`, `org_graph_links`,
  migration 2233; project ids and names the owner typed). `aom ceo route "<request>"` ranks projects and areas (read-only, answered by
  the runner; retired projects never appear); `aom ceo route --drafts` lets the CEO show the drafts in chat.
- **Vault sync.** A conflict in generated graph files (`<folder>/graph/manifest.json`, `modules.md`, `work.md`, `repos/**`) is resolved
  by the sync itself (the remote side wins) and the graph is rebuilt from the clones; it is never a desk item.


## 37. Delivery recipes, gates and the release queue (built; design: `docs/design/ceo-front-door.md` section 9, step 2, with the owner decisions of section 14)

A project delivers by **instructions** (the phase follow-up becomes a prose DevOps request, unchanged) or by a **recipe**
(`projects.delivery_mode`, event `DeliveryModeSet`). A recipe is **authorization**, not a convenience: the model never runs a deploy
command; it asks, the server checks deterministically, a durable command carries the approval to a workstation, and runner code
runs the script outside any model session.

- **Where.** `<folder>/delivery/` of the PROJECT vault (`vaults.project_id`; never the organization vault; a local vault, `storage:
  local`, is a folder on `local_workstation_id`). `recipe.yaml` (`packages/shared/src/delivery/recipe.ts`, zod; parsed with `yaml`)
  plus the scripts. Per environment: `target`/`targets` (deploy targets of the project), `script`, `args` (templates `${checkout}`
  `${commit}` `${branch}` `${env}` `${appUrl}` `${target}` `${host}`), `trigger` (`after_merge|phase_done|on_request`), `timeoutSec`,
  `health` (`RunHealthSchema`: http, tcp, log, none), `smoke`, `secrets` (names), `envFile` (a path on the workstation), `docker`,
  **`releasedBy: owner|ceo|auto`** (default `owner`) and `gate` (`none`, a preset name, or an inline gate).
- **Content hash and approval.** `bundleHash` is a sha256 over the sorted listing `path\0mode\0sha256(content)\n` of `delivery/**`
  (mode is the executable bit only). The runner reads a git vault AT A COMMIT (`git ls-tree` + `git cat-file`, `delivery/bundle.ts`),
  never the working tree; a local folder is read once and the copy is what runs. `recipe.inspect` (durable command) returns the
  hash, the parsed recipe, the file listing and the runner's lint; the server adds the checks it can make (targets, presets,
  repositories, automatic production without a gate) and records `DeliveryRecipeObserved` (and `DeliveryRecipeDrifted` when the hash
  differs from the approved one) into `delivery_recipes` (migration 2224). The Owner's button, `POST
  /api/projects/:id/delivery/approve {hash}`, must equal the observed hash; it records `DeliveryRecipeApproved {hash, vaultCommit,
  version, by}` and keeps the parsed approved recipe: **runs use the approved recipe at the approved commit**, so an edit nobody
  approved changes nothing that runs. Lint errors block approval. The vault sync (`vault.status` after a pull) re-inspects projects
  that have a recipe; "Check for changes" does too.
- **The one door: `requestDeployRun`** (`apps/server/src/delivery/runs.ts`). `aom deploy run`, the CEO verb `deploy` (`ceo/actions4.ts`,
  class `deploy.run`), the Deploy button, the release queue, `after_merge` triggers and phase follow-ups all call it. It checks, in
  order: recipe mode and an approved recipe at the observed hash (`recipe_not_approved`, `recipe_changed`), the environment and
  trigger, the targets, a workstation (`delivery:1` capability), then `evaluateEnvGate` (`gate.ts`). Gates are pure
  (`packages/shared/src/delivery/gate.ts`, `evaluateGate`) over facts the server holds: healthy `deploy_runs` of an earlier
  environment on the same commit, the latest passed `test_runs` (`regression`, `e2e`; a run that names no commit counts only if it
  finished after the newest merge), done phases, the organization time zone, and a freeze. A gate names no releaser. Org **presets** and
  **bindings** (`gate_presets`, `gate_bindings`, events `GatePresetSet|Removed`, `GateBindingSet`) are added on top of the recipe's
  gate (a binding cannot be loosened by a recipe). An unsatisfied gate writes a refused run with everything that is missing.
- **Who releases (`releaseDecision`).** The Owner or an Admin always (the Deploy button, the queue's Release). `auto`: a trigger,
  DevOps or the CEO. `ceo`: only the CEO verb releases, except on an untrusted wake (`ceo_wakes.untrusted`) for a production target,
  which waits for the Owner; a trigger or DevOps with `ceo` wakes the CEO (`deploy_ready`). Everything else (`owner`) is
  `DeployRunQueued`: the run waits in the **release queue** (`deploy_runs.status = waiting_release`) with a desk alert
  (`deploy_release`). The CEO is never the releaser unless the approved recipe says so, in every provenance (owner turn, order turn,
  wake). An accepted CEO recommendation counts as the Owner pressing the button. One run exists per (project, environment, target):
  a request for the same commit releases the waiting run, a newer one cancels it, a running one refuses `run_in_progress`.
- **The run.** `DeployRunRequested` then `DeployGateSatisfied {gate, evidence[] (ids of facts), releasedBy, recipeHash}` (the audit
  with `DeliveryRecipeApproved`), and a durable **`deploy.exec`** (in `runner_commands`, expiring after two hours; `sweepExpiredDeploys`
  ends an uncollected one as refused) carrying `{runId, vault, vaultCommit, hash, env, target, commit, repo, trial, dryRun}`. The runner
  (`delivery/exec.ts`, `DeployExecutor`) re-exports `delivery/` at the commit and **recomputes the hash (a mismatch refuses
  `hash_mismatch`)**, resolves the secrets by name (the runner's `secrets/deploy.json`, sealed by the browser to the runner key like
  `targets.json`, then the recipe's `envFile`; a missing one refuses `missing_secret:NAME`), prepares a clean checkout (`git worktree
  add --detach`), spawns the script in its own process group with a deadline (output redacted by `secrets/redact.ts`, an `AOM-DEPLOY
  {json}` line parsed), then the health check and the smoke script, and answers with `command.result`. `deploy.progress` (best effort)
  marks `DeployRunStarted`. A refusal or failure is an ANSWER (`ok:true`), the command is `done` and never retried; a command delivered
  twice runs once (a `result.json` per run id). The server records `DeployRunFinished` (or `DeployRunRefused`), wakes the CEO
  (`deploy_finished`) and names a missing secret on the desk. Projections: `deploy_runs` (unique open run per project, environment and
  target), replay-safe; operational tables `deploy_secret_status`, `deploy_trigger_queue` (migration 2225).
- **Triggers and phases.** `CardFinalized` with a merge commit queues `after_merge` for two minutes (the newest commit wins,
  `deploy_trigger_queue`, `deliveryPass` in the dispatcher). A recipe project's phase `deploy` follow-up starts without a DevOps
  request; the dispatcher's `deployStep` asks for the run of the environment whose target the follow-up names (outside the phase
  transaction) and `followupVerdict` finishes the follow-up with the run.
- **Conversation (section 10).** `aom ceo devops --project KEY --kind recipe` (owner turns only) files a DevOps request whose context
  is `{requestKind: 'recipe', ownerTurn: true, projectKey}` and whose text carries the script contract. DevOps may then
  `aom recipe save --dir <scratch> --project KEY` (the runner writes `delivery/` into the vault, one commit, pushed:
  `vaults/delivery.ts`, `VaultManager.saveDelivery`; a file holding a secret is refused) and `aom deploy trial --env NAME` (a real trial
  of a non-production environment of a recipe that is not approved yet; production and approved recipes get `AOM_DEPLOY_DRY_RUN=1`;
  trials are `deploy_runs.trial`, never count for a gate). All of this is `rpc` (`deploy.run|trial|status`, `recipe.save`, handled by
  `delivery/rpc.ts`; the CEO's `deploy.run` goes through `runAction`, so policy, audit and inline confirmations apply).
- **Allow rules.** `Bash(aom deploy run:*)` and `Bash(aom deploy status:*)` (`DEPLOY_ASK_ALLOW`) are named in the CEO's restricted
  profile, DevOps settings and the owner turn's `--allowedTools`; the model's call carries no credential and runs no deploy command.
  Whether `auto` mode honours a narrow allow rule is risk R3: the chat's release card and the Deploy button call the same server path
  from the Owner's session.
- **UI.** Project settings, Delivery (`DeliveryPanel`: mode, vault backup note, environments and releasers, lint, changes, Approve, Deploy
  buttons, secrets per workstation); the Deploys page (`ReleaseQueue` with the per-server choice, `DeployRuns` with the audit,
  `GatesPanel`); release cards in the CEO chat.
