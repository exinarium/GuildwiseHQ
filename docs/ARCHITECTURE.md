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

Migration number ranges are reserved per milestone so parallel builders never collide: M1 `0001–0099`, M2 `0200–0299`, M3 `0300–0399`, M4 `0400–0499`, M5 `0500–0599`, M6 `0600–0699`, M7 `0700–0799`, M8 `0800–0899`, M9 `0900–0999`, M10 `1000–1099`. Organizations added `1310_organizations.sql` (tables, `users.kind`, invitation kinds, `org_id` on the projections that lacked it), `1311_org_fks.sql` (the `org_id` foreign keys re-pointed from `users` to `organizations`, `DEFERRABLE INITIALLY DEFERRED` and validated by the data migration) and `1312_two_factor.sql` (`user_totp`, recovery codes, login challenges, `organizations.require_two_factor`). Data migrations (`apps/server/src/data-migrations/`, recorded in `data_migrations`) run on boot after the schema: `orgs-2026-10` appends `OrganizationCreated` + `OrgMemberAdded(owner)` for every user (org id = user id) and is idempotent; `pnpm --filter @aom/server orgs:migrate [--dry-run]` runs or previews it.

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
  domain             text NOT NULL CHECK (domain IN ('work','personal')),
  workflow_key       text NOT NULL DEFAULT 'code',     -- default workflow for new cards
  priority_tier      smallint NOT NULL DEFAULT 2 CHECK (priority_tier BETWEEN 1 AND 4), -- 1 = highest
  branch_prefix      text NOT NULL DEFAULT 'aom/',
  working_branch     text NOT NULL DEFAULT 'main',
  sub_categories     text[] NOT NULL DEFAULT '{}',
  vault_folder       text,                             -- projects/<name> inside the domain vault
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
  completion_action        text CHECK (completion_action IN ('pr','push_branch','merge')),
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
| `vaults` | M3 | `id, org_id, project_id NULL, kind ('work','personal','project'), name, remote_url, sync_interval_sec default 300, created_at` |
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
| `interests`, `taste_seeds` | interests (migration 1306) | The Interests page (`docs/design/interests.md`). `interests`: `id, org_id, name, description, feed_project_id NULL, research_project_id NULL (at least one), sub_category, preferred_sites text[], scan jsonb {cron, timezone, windowHours, maxItems, manual} (NULL without a feed project), status ('active','paused'), schedule_id (the feed schedule it owns; no FK), adopted_from, created_by, created_at, updated_at`; unique `(org_id, lower(name))`. `taste_seeds`: `project_id PK, version, rules jsonb [{text, interestId|null}], updated_by, updated_at` (explicit taste rules of a feed project). `schedules` gains `interest_id` (unique when set) and `cards` gains `interest_id` (set by scans of a linked schedule and by "Research this"). All are projections; a rebuild reproduces them |
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
| `ProjectCreated` | `{projectId, orgId, key, name, domain, workflowKey, priorityTier, branchPrefix, workingBranch, subCategories, vaultFolder}` | insert projects + project_members(owner, active) |
| `ProjectUpdated` | `{projectId, changes: Partial<...>}` | update columns |
| `ProjectRepoAdded` | `{projectId, repoId, name, remoteUrl, remoteUrlNormalized, workingBranch?}` | insert project_repos; runner gateway sends `repos.rescan` to owner/member runners |
| `ProjectRepoRemoved` | `{projectId, repoId}` | removed_at |
| **`ProjectShared`** | `{projectId, userId, invitedBy}` | project_members row status invited |
| `ProjectShareAccepted` | `{projectId, userId}` | status active, joined_at |
| `ProjectShareDeclined` | `{projectId, userId}` | status removed |
| `ProjectMemberRemoved` | `{projectId, userId, inheritedAgentIds[], transferredCardIds[]}` | status removed; agents → manager_user_id = owner, status needs_rehome, workstation_id NULL; cards owner_user_id → owner (claims released via separate ClaimReleased events in same append) |
| `ProjectMergePolicyChanged` | `{projectId, mergeLargeWithoutApproval, changedBy}` | `projects.merge_large_without_approval/_changed_by/_changed_at`; owner only (`PUT /api/projects/:id/merge-policy`); `mergeGate()` in `commands/finalize.ts` reads it for the manager's Finalize button and the BA's `aom finalize` |
| `ProjectArchived` | `{projectId, archivedBy?}` | status archived. Appended by `POST /api/projects/:id/archive` (any active member) together with, in one transaction: `ClaimReleased(manual)` + `CardCancelled{cause:'project_archived'}` + a system thread message for every open card (the runner gateway turns the release of a cancelled card into `shift.stop`), `ScheduleUpdated{enabled:false, nextFireAt:null}` for every enabled schedule, `DeskItemResolved{dismissed}` for every open desk item of the project, and a `worktree.remove` runner command (branch kept) per distinct worktree of those cards. Agents are not touched: the dispatcher, scheduler, intake mapping and hiring already skip a project whose status is not `active` |
| `ProjectRestored` | `{projectId, restoredBy?}` | status active (`POST /api/projects/:id/restore`, any active member). Cards closed by the archive stay closed, schedules stay disabled; the manager re-enables what they want |
| `ProjectDeleted` | `{projectId, key, name, deletedBy}` | `deleteProjectRows()` removes every row of the project (see "Permanent delete" below). Only for an archived project, only the owner, `POST /api/projects/:id/delete {confirmKey}` where `confirmKey` must equal the project key |

#### Cards (`events/card.ts`) — stream `card-<id>`, audience `project`

| Event | Payload | Projection effect |
| --- | --- | --- |
| `CardCreated` | `{cardId, projectId, number, ref, title, cardType, workflowVersionId, stage, status:'draft'|'queued', fields, ownerUserId, origin, parentCardId?, worktreeCardId?, scheduled, scheduleId?, repoId?, priority, docsNeeded, completionAction?, riskTier?, dependencies: uuid[], requiredCapabilities}` | insert cards (+card_dependencies), increment projects.next_card_number, create card thread (threads row), card_transitions |
| `CardUpdated` | `{cardId, changes: {title?, fields?, priority?, repoId?, docsNeeded?, completionAction?, riskTier?, riskTierOverridden?, dependencies?}}` | update columns |
| **`CardSpecified`** | `{cardId, fromStage, toStage}` | status queued, stage = toStage (`build` for code), queued_at; transition |
| `DecisionPolicyChanged` | `{cardId, policy}` | decision_policy |
| **`CardClaimed`** | `{cardId, claimId, agentId, workstationId, shiftId, stage, overflow, worktree: {repoId, baseBranch, branchName, worktreePath, homeWorkstationId, created: boolean}}` | claim columns, status claimed, lease = createdAt + 1h, last_agent_id; original_builder_agent_id set if stage claim role is builder and it is NULL; branch/worktree/home set on first; transition |
| `ClaimReleased` | `{cardId, claimId, agentId, reason:'handoff'|'question'|'agent_retired'|'lease_expired'|'runner_rejected'|'runner_lost_shift'|'shift_failed'|'manual'|'workstation_unlinked'|'member_removed', lastHandoffId?}` | clear claim columns; if status was claimed → queued (queued_at = createdAt); transition |
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
| `FinalizeRequested` | `{cardId, action, requestedBy, withoutApproval?}` (`withoutApproval`: a large merge that skipped the desk because the project setting allows it; adds a `merge_policy` row to the card timeline) | (M4) status `waiting`; runner command `finalize.execute` queued to the card's home workstation; its `command.result` produces `CardFinalized` (or a desk escalation on failure) |
| **`CardFinalized`** | `{cardId, action, resultRef: {mergeCommit?, prUrl?, pushedBranch?}, toStage:'done'}` | stage done, status done, finalized_at; queues `worktree.remove` runner command; dependents become claimable |
| `CardCancelled` | `{cardId, reason}` | status cancelled; claim released first |
| `ThreadMessagePosted` | `{threadId, messageId, cardId?, authorKind, authorUserId?, authorAgentId?, kind, body, data}` | thread_messages |

`ReworkReason = 'missed_requirement' | 'broke_convention' | 'weak_tests' | 'poor_structure' | 'spec_unclear' | 'out_of_scope_test_change'`.

#### Shifts and agents (`events/shift.ts`, `events/agent.ts`) — audience `project` when the shift has a card, else `org`

| Event | Payload | Projection effect |
| --- | --- | --- |
| `ShiftStarted` | `{shiftId, agentId, workstationId, cardId?, kind, stage?, runtime, model, overflow, runtimeSessionId?}` | shifts status running |
| **`ShiftEnded`** | `{shiftId, agentId, cardId?, outcome, reportOutcome?, durationMs, usage, exitCode?, guardViolations[]}` | shifts ended, tokens, duration; agents.last_shift_ended_at |
| **`AgentHired`** | `{agentId, orgId, projectId?, hiredByUserId, workstationId, name, roleKey, roleVersion, seniority, runtime, model, effort?, skills, permissions, capacity, isDevops}` | insert agents |
| `AgentChanged` | `{agentId, changes:{model?, effort?, runtime?, roleKey?, roleVersion?, seniority?, skills?, permissions?, capacity?}}` | update |
| **`AgentRetired`** | `{agentId, by, releasedCardIds[]}` | status retired, retired_at; ClaimReleased events in the same append; `agent.wipe` runner command queued |
| `AgentReset` | `{agentId}` (DevOps only) | no column change; `agent.wipe` queued |
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
| `ScheduleLinked` | `{scheduleId, interestId: Id \| null}` | sets `schedules.interest_id` (adopt, or null to unlink); linking back-fills `cards.interest_id` of the schedule's earlier cards (`WHERE schedule_id=$1 AND interest_id IS NULL`) |
| `InterestCreated` / `InterestUpdated` | `InterestBody` = `{interestId, orgId, name, description, feedProjectId\|null, researchProjectId\|null, subCategory, preferredSites, scan: {cron, timezone, windowHours, maxItems, manual}\|null, status, scheduleId\|null, adoptedFrom?}` (full snapshot, stream `interest-<id>`, scope = the feed project, else the research project) | upsert `interests`. Appended in the same transaction as the `Schedule*` events that keep the owned schedule in step (`scheduleSyncPlan`, `commands/interests.ts syncSchedule`) |
| `InterestDeleted` | `{interestId, keepSchedule}` | delete the row (cards keep their `interest_id`); with `keepSchedule` a `ScheduleLinked{null}` follows, else a `ScheduleDeleted` |
| `TasteSeedSet` | `{projectId, version, rules: [{text, interestId\|null}]}` (stream `project-<id>`) | upsert `taste_seeds`; the taste hook mirrors it to `taste.md` as a managed section (16.4) |
| **`ScheduleFired`** | `{scheduleId, cardId?, runId?, firedFor: ISO time, nextFireAt}` | last_fired_at, next_fire_at, last_card_id; appended with the action's events and `ScheduleRunRecorded` (for a card action `CardCreated{scheduled:true, origin:'schedule', status:'queued'}`) |
| `ScheduleRunRecorded` | `{runId, scheduleId, trigger: cron\|manual\|event\|issue\|test, sourceKey?, label?, status: ok\|failed\|pending, summary, result?, error?, delivery?, nextAttemptAt?}` | `schedule_runs` row (unique `(schedule_id, source_key)`), `schedules.last_status/last_summary`, seen issues |
| `ScheduleDeliveryAttempted` | `{runId, scheduleId, attempt, ok, httpStatus?, error?, durationMs?, status, nextAttemptAt?}` | `schedule_attempts` row (the delivery log), the run's attempts, status and next try |
| `ScheduleRunCompleted` | `{runId, scheduleId, status, summary, result?, error?}` | the run's outcome learned later (an issue poll answered); `schedule_issues` |
| `FeedRunRequested` | `{projectId, scheduleId?, cardId, requestedBy}` | manual "run now" → same as ScheduleFired path |
| `ScheduleFireFailed` | `{scheduleId, error, attempts, nextFireAt, deskItemId?}` | M9: a due schedule could not emit its card; `next_fire_at` moves to the retry time (1 min doubling to 6 h), `fail_count`/`last_error` set; the first failure of a streak also raises one desk alert (`schedule_failed`), resolved by the next `ScheduleFired` |
| `RecommendationApplied` | `{orgId, recommendationId, kind, agentId?, appliedBy, effect, deskItemId?}` | M9: one-click HR recommendation applied (the change is its own event in the same append: `AgentChanged`, `AgentHired`, `AgentRetired` or a `DeskItemCreated` approval `standing_order`); `hr_applied` hides it for the window |
| **`DigestPosted`** | `{cardId, projectId, items:[{itemId, kind, url, urlNormalized, title, source, publishedAt, summary}], nothingQualified: boolean}` | digest_items, feed_seen; desk items kind rating (one grouped desk item per digest) |
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
| `VaultRegistered` / `VaultUpdated` | `{vaultId, orgId, projectId?, kind, name, remoteUrl, syncIntervalSec}` | vaults; `vault.configure` command to the org's runners |
| `VaultSyncConflict` | `{vaultId, workstationId, files[], deskItemId}` | desk escalation |

#### Catalogue (`events/catalogue.ts`) — M1 built-ins, M10 custom

| Event | Payload | Projection effect |
| --- | --- | --- |
| `WorkflowVersionRegistered` | `{workflowVersionId, orgId|null, key, version, name, department?, definition, status}` | workflow_versions + workflow_stages (built-ins registered at boot if missing) |
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

#### BA reporter (`events/reporter.ts`, plus `UserTimezoneChanged` in `events/user.ts`) — Part B of `docs/design/phases.md`

Streams `user-<id>`, `desk-<id>`, `ba-signal-<id>`, `ba-task-<id>`; audience `org` (preferences, floor report) or `project`. The routing decision is always recorded in the event (`DeskItemCreated.triage`), never recomputed from settings on replay.

| Event | Payload | Projection effect |
| --- | --- | --- |
| `UserTimezoneChanged` | `{userId, timezone}` (IANA, validated) | `users.timezone` |
| `ReportingPrefsChanged` | `{userId, routeViaBa?, dailyAt?}` | merged into `users.reporting` (absent keys = defaults: routing on, `08:00`) |
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

Warnings (shown, not blocking): stage with no `doneCriteria` text; more than 12 stages.

---

### 6.7 Organization designer (M10)

Custom roles and workflows (org-owned rows, `org_id` = the owner) are drafted by the owner (`POST /api/roles|workflows`, `PUT …/:id`) or by the BA in a chat (`aom org role|workflow draft`, rpc `org.*`, only in the owner's own chat with a BA), validated on every save (`validateCustomWorkflow` = the nine rules of 6.6 plus: not a built-in key, field set `custom`, card types of `feature|bug|support|refactor|docs`, `StageCompleted`/`CardSpecified` outcomes only, no data and no effects, `manual` only as the first stage, department exists), and submitted with `…/:id/submit`, which raises one desk approval per definition. Approving re-validates against the catalogue as it is then (a workflow whose custom role is not approved yet is refused), emits `…VersionApproved` (the previous active version becomes `superseded`) and a hook writes the YAML file (`organization/<roles|workflows>/<key>/v<N>.yaml`, `shared/definitions`) to the owner's vault with `vault.write` (no vault: only the site copy). Roles and workflows of built-in keys cannot be drafted, replaced or removed; approved versions are never removed. The dispatcher needs nothing new: it routes by `workflow_stages.claim_role`, and every card is pinned to its `workflow_version_id`, so approving v2 changes only cards created afterwards. A custom role claims stages of custom workflows only (`claimableStages`, `*` for any stage). All writes take `?projectId=` to name the organization of a shared project and are refused for anyone but its owner; reads (`GET /api/roles|workflows|org/catalogue|departments?projectId=`) work for every member, so the Hire form of a shared project lists the owner's catalogue. Owner extensions of a built-in role (`PUT /api/roles/:key/extensions`, strict body: instructions, skills, standing orders) are added to the shift brief; core rules are never part of the request or the effective role.

## 7. Role catalogue

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
  AND NOT EXISTS (                                              -- dependencies: only gate the first build
        SELECT 1 FROM card_dependencies d JOIN cards dc ON dc.id = d.depends_on_card_id
         WHERE d.card_id = c.id AND c.stage = 'build' AND c.rework_round = 0
           AND dc.status NOT IN ('done','cancelled'))
ORDER BY
  c.scheduled DESC,                                             -- 1. scheduled tasks first
  (p.domain = 'work') DESC,                                     -- 2. work outranks personal
  CASE                                                          -- 3. builder claim priority
    WHEN c.is_rework_or_bug AND c.original_builder_agent_id = $1 THEN 0
    WHEN c.is_rework_or_bug THEN 1
    ELSE 2
  END,
  (c.project_id = ANY ($10)) DESC,                              -- 4. the agent's focus projects (soft preference)
  p.priority_tier ASC,                                          -- 5. project tier
  c.priority ASC,                                               -- 6. card priority
  c.queued_at ASC                                               -- 7. FIFO
LIMIT 5;
```

Allow-list, membership and cap are one place: `eligibility().scope` (shared with `queries/workability.ts`, so "could anyone ever take this card" cannot drift from "can this agent take it now") and the `max_concurrent_shifts` line in the candidate SQL. The cap is hard: it also binds the overflow path (`isCandidate`). The BA-task, tester-bottleneck, question-escalation and reporter paths use the same rule on the agent's allow-list and its workstation owner's membership.

Notes: the "builder priority" CASE is harmless for other roles (they rarely see rework flags; reviewers of rework cards simply sort them first, which is desired). "Idle agents pull personal cards" falls out of the ordering: personal cards are taken only when no work card is eligible. "A new work card waits for the current shift" falls out of claims never being preempted. M3 adds for cards without a repo (research/feed): `EXISTS (SELECT 1 FROM workstation_vaults wv JOIN vaults v ... WHERE v.kind = p.domain OR v.project_id = p.id)`.

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

### 9.8 Phases: `phasePass` and the BA task queue

`dispatcher/phases.ts phasePass` is state based and idempotent: each step locks the phase row (`FOR UPDATE`), re-checks its status and appends in one transaction, and a failure in one phase is logged without starving the others. Archived projects are skipped. Steps:

1. **Merge checks (owner decision A2).** For a finalized `pr` / `push_branch` card of an `open` phase whose branch is not merged yet, a `branch.check_merged` runner command goes to the card's home workstation (one at a time per card, repeated every `AOM_MERGE_CHECK_SECONDS`, default 180). The runner fetches and tests `git merge-base --is-ancestor <card branch> <working branch>`; a merged branch is deleted (locally; on the remote for `push_branch`) and `command.result` appends `CardMergeVerified`. A `merge` finalize counts at once. A member can confirm a merge the check cannot see (a squash merge, a deleted branch) with `POST /api/cards/:id/confirm-merged`. The working branch is `phases.working_branch`, else the card's base branch, else the repository's, else the project's.
2. **Completion.** An `open` phase with at least one confirmed member, no member that is only proposed, and every confirmed member resolved (`finalized` and merged, `closed_manually` = done without a completion action, or `cancelled`; `phaseCompletion` in `packages/shared/src/phases`) appends `PhaseCompleted` and queues the BA's `phase_report` task. Completion does not wait for post-merge full suites (they are listed as outstanding). A bug card filed after finalize joins the phase it came from (`bugJoinEvents`, owner decision A6) and reopens a phase that still awaits its report.
3. **Results.** A running DevOps follow-up succeeds when all its requests are `done` and fails as soon as one failed; a regression follow-up decides from the latest `test_runs` row of each of its cards (bug cards are named in the evidence).
4. **Sequencing.** Follow-ups run strictly in order, one at a time (`nextFollowup`). Any failed follow-up skips the ones after it (owner decision A7). The next `briefed` follow-up starts: a deploy creates DevOps requests through `createDevOpsRequestIn` (a remote target: its workstation; the local stack: one request per workstation of every active project member, owner decision A9), a regression follow-up creates regression cards through `regressionRunEvents` pinned (`home_workstation_id`) to a workstation that was just deployed and has a tester, with `targetUrl` and `deployTarget` in the card fields (testers also get `AOM_TARGET_URL`), a custom one for the BA queues a `followup_custom` task. When all are terminal, `PhaseFollowupsFinished` queues the `followups_report` task.

`dispatcher/ba-tasks.ts baTaskPass` is the structure of `questionPass`: queued tasks oldest first, one `ba_task` shift at a time per BA agent (outside card capacity), the intake's BA preferred. The shift has no card or worktree (`shift.start kind 'ba_task'`, a placeholder card, `baTask` with the phase, its cards and suites, the follow-ups and what is outstanding) and ends with exactly one terminal `aom phase` report, validated by `commands/ba-tasks.ts applyBaTaskReport`; questions are refused. A shift that is rejected, lost or stopped requeues the task unharmed; a crash, timeout or missing report counts an attempt. **No agent ever blocks:** a task with no BA hired, no BA online for 15 minutes or two failed attempts is done by the server from a template (`runBaTaskFallback`: a report starting "Your BA was not available; this summary was generated.", template briefs, "no BA was available" for a custom follow-up the BA was to do) and marked `fallback`. Archiving a project cancels its phases (`PhaseCancelled`), their pending follow-ups and queued tasks; a DevOps request already running is left to finish.

### 9.9 The BA as the manager's reporter (Part B)

**Routing (`reporter/routing.ts`).** `PgEventStore.intercept` registers a hook that runs inside every append transaction (so every emitter of `DeskItemCreated` and `QuestionRaised` is covered, and the decision lands in the stored event). For an organization with `users.reporting.routeViaBa` (default true) and a reachable BA (active, on a connected workstation with its runtime available, within the agent's project scope), an item is **urgent** when it is blocking, pinned, not an `alert` (approvals, escalations) or the loop breaker's alert; it is stored unchanged and joins a queued `urgent_note` task (one BA shift per burst: `enqueueReporterTask` adds to a task that is still queued). Any other item is **held**: the payload gets `triage:{deadline: now + 10 min}`, the projection sets `triage='pending'`, `DESK_VISIBLE` hides it from the manager (its `status` stays `open`, so the emitters' own dedup checks still see it), and it joins a queued `desk_triage` task. Exempt: ratings, phase items and the reporter's own items (`ROUTING_EXEMPT_SUBKINDS`), and the mapping question of an intake. Questions raised by agents keep the escalation chain (§15) but with routing on a blocking question goes straight to the desk (`nextRoute` `via:'desk'`; the interceptor queues the note) and a non-blocking one starts at the BA instead of a peer (`via:'ba'`; the BA's `QUESTION_STALL_MS` of 10 minutes is its window).

**The BA never blocks.** The deadline is enforced by the reporter sweep (below): `DeskItemTriaged{outcome:'released'}` ends the hold and the item reaches the desk exactly as raised. With no reachable BA nothing is held (the interceptor checks `baAvailable` first); a `desk_triage` task no BA takes is done by `runReporterFallback`, which releases every item still held. A BA decision on an item that was already released can only add a note. The BA can `dismiss` or `merge` only items that are `alert`, non-blocking and non-pinned.

**Reporter tasks** reuse `ba_tasks` and `baTaskPass` (`kind` `desk_triage`, `urgent_note`, `floor_alert`, `floor_report`, `scheduled_brief` (a schedule's BA task, section 10.2); no phase; filed under the item's project, or the organization's oldest active project; `floor_report` can be taken by any BA of the org). The `shift.start` carries `baTask.reporter` (items, signals, the floor digest, open items it may merge into) instead of a phase; the shift ends with one `aom report triage|notes|signals|floor` command, validated by `commands/reporter-tasks.ts applyReporterReport` (`triage_done`, `notes_done`, `signal_report`, `floor_report`). Fallbacks: held items pass through unchanged, urgent items need no note, signals and the floor report are posted from templates (`renderSignalFallback`, `renderFloorReportFallback`).

**The sweep (`reporter/reporter.ts`, `AOM_REPORTER_SECONDS`, default 60; `POST /api/test/clock` runs it too).** (1) Releases expired holds. (2) Runs the deterministic detectors (`reporter/detectors.ts`; thresholds are the single `REPORTER` object in `packages/shared/src/reporter`): `loop` (an open loop-breaker episode: `retry_failures >= 3` with `retry_after` set), `repeated_approval` (approval desk items clustered by subkind and `topicWords` overlap ≥ 0.6, ≥ 3 in 24 h; urgent if one was rejected), `blocked` (> 4 h), `unclaimed` (queued > 30 min and `cardWorkability` not ok), `rework` (round ≥ 3) and `finalize_failures` (≥ 2); and reconciles `ba_signals` by fingerprint (raise, update when count/urgency/subject changed, resolve when the condition clears, acknowledging the signal's open `ba_report` item). (3) Queues a `floor_alert` task for each urgent signal no task has covered; the BA's analysis becomes a `DeskItemAnnotated` note on the signal's own desk item (the loop alert) or a new `alert/ba_report`. (4) Queues the daily `floor_report` when the manager's local clock passes `dailyAt` (`floorReportDue`: local date from `users.timezone` via `Intl`, UTC while unset; once per local date, tracked in `users.floor_report_day`; an organization created after today's boundary waits for tomorrow's; skipped when the digest is empty). The digest (`reporter/digest.ts buildFloorDigest`) is deterministic SQL: open phases and the open bug cards that hold them (`origin 'test_failure'`, created after `completed_at`), signals, cards in back-off, open DevOps requests, items the BA resolved (`triage` dismissed/merged, or questions answered by a BA) and failed shifts since the previous report. The report item (`alert/floor_report`, `data` = the digest) and each `alert/ba_report` link to the standing chat thread (`ensureReportThread`: one `ChatThreadCreated` with the BA per organization owner, kept in `users.ba_chat_thread_id`).

### 9.6 Hire cap for first runs (removed in M9)

The first-run cap (2 builders, 1 of each other role) and `AOM_FIRST_RUN_HIRE_CAP` are gone; the HR board's recommendations (model, split, fire or reassign) replace the guard rail.

---

### 9.10 Repository hygiene and the working branch

Owner decisions of 2026-10-05 (docs/design/phases.md, addendum "DevOps repository hygiene and the working branch"). Migration `1305_repo_hygiene.sql`: `workstations.hygiene_interval_hours / hygiene_last_at`, `devops_requests.hygiene`, `project_repos.working_branch_set_by / working_branch_set_at / known_branches`, table `hygiene_findings`.

**The working branch is confirmed, never guessed.** `project_repos.working_branch` is NULL until the manager names a branch (`ProjectRepoWorkingBranchSet`). The branch hygiene uses is `effectiveWorkingBranch`: the latest non-final phase's `working_branch`, else the repository's, else none; the project-level `projects.working_branch` default (`main`) is deliberately not a fallback. With none, nothing is committed, pulled or pushed there.

**The scheduled job (`commands/hygiene.ts`, `Scheduler.runHygiene`).** Every 15 s the scheduler tick (when `AOM_HYGIENE_SCHEDULE`, default on) finds active workstations with a DevOps engineer whose `COALESCE(hygiene_last_at, paired_at) + hygiene_interval_hours` has passed (default 24 h; the cadence is per workstation, `PUT /api/workstations/:id/hygiene`) and calls `requestHygiene`. "Run hygiene now" calls the same function. `requestHygiene` builds a `HygieneSpec` (`hygieneSpecFor`: `workstation_repos` joined to `project_repos` and `projects`: local path, remote, effective branch and its source, the project's branch prefix, up to 200 branches of done or cancelled cards), creates one DevOps request carrying it, and queues the runner command `worktrees.sweep`. One hygiene request is open per workstation: a second click or tick returns the open one; a workstation with no clone of a project repository gets none.

**The DevOps shift (`aom hygiene run`, `apps/runner/src/devops/hygiene.ts`).** The agent (or the mock) runs one deterministic command that does the git work per repository and ends the request with `devops_done` whose data carries the structured `HygieneReport`. Rules, in order: fetch `origin` (failure: `auth_failed` or `error`); list the clone's branches (agent branches under the prefix left out); unset working branch: report the uncommitted files and the branches, `needs_branch`, and stop; a working branch that exists nowhere: `branch_missing`. Checkout on the working branch: `git add -A` and commit uncommitted changes (`chore: save work in progress`), `pull --ff-only`, else `pull --rebase` (a failure aborts the rebase: `conflict`), push if ahead (`push -u`). Checkout on another branch: its working tree is not touched (dirty: `dirty_other_branch`, reported); the working branch ref is moved forward from `origin` or pushed when it is only ahead (`conflict` when it diverged). Then local branches of finished cards under the prefix are deleted when they are merged into the working branch, not checked out in any worktree; `git worktree prune`. Every mutating git command is logged in `commands` of `devops_done`.

**Applying the report (`hygieneReportEvents`, inside `applyDevopsReport`).** One `HygieneRepoReported`, plus for each `needs_branch` repository a `QuestionRaised` (`subkind 'working_branch'`, asked by the DevOps agent, no card): options are the clone's branches (`branch:<name>`) and `other`; blocking and pinned only when uncommitted changes wait for the answer, otherwise non-urgent. At most one open question per repository (`desk_items.data->>'repoId'`). The routing interceptor treats the non-urgent one like other non-urgent items: held for the BA's triage until `REPORTER.triageWindowMinutes`, then shown unchanged; the blocking one goes straight to the manager with an `urgent_note` task. Answering (`answerDeskItem` hook `workingBranchAnsweredEvents`) maps the option (`branch:<name>`, `keep`, or `other` with the typed name, validated with `isSafeGitRef`) to a `ProjectRepoWorkingBranchSet`, in the same append as the standard `QuestionAnswered` + `LedgerEntryAdded` (the ledger entry is what keeps later shifts from asking again); a branch confirmed for a repository that had none starts a `branch_confirmed` hygiene run right after the commit. The project owner can also set it directly (`PUT /api/projects/:id/repos/:repoId/working-branch`), which settles an open question.

**Re-confirming on change (`commands/branch-confirm.ts`, called from the gateway's event reactions).** `TicketMapped` (an intake mapped to a project), `PhaseCreated{status:'open'}` without its own `workingBranch` and `PhaseConfirmed` raise the same question (`reason 'intake'` or `'phase'`, "Keep `<branch>` ... or use another branch?", recommendation `keep`) for each repository of the project that some workstation holds and that already has a confirmed branch. Skipped when a question is open or the branch was set in the last hour; an unconfirmed repository is left to the hygiene run. Keeping changes nothing; naming another sets it on the repository.

**Findings and signals.** `hygiene_findings` (see events above) feed `detectHygiene` (`reporter/detectors.ts`): signal kind `repo_hygiene`, normal urgency, fingerprint `hygiene:<workstation>:<subject>:<kind>`, resolved by the reporter when the finding closes. The daily floor report lists them under "Failures".

**The stale-worktree sweep (runner `git/sweep.ts`, server `commands/worktree-sweep.ts`).** At start-up (15 s after the first connection, once per process), and for each hygiene run (`worktrees.sweep`), the runner lists `worktrees/<KEY>-<id>/<REF>`, asks the server `worktrees.query`, and removes the worktrees the server does not call live, removes empty project folders and runs `git worktree prune` in the known clones. The server answers with the paths of cards of this workstation that are not done or cancelled, or are done with a finalize still pending (`finalize_state` set, `finalized_at` null), or whose worktree a live card shares. Conservative: no answer, or messages still in the outbox: nothing is removed; a running shift's worktree is never touched; a worktree with uncommitted changes is never deleted: for a dead card it is reported (`WorktreeSweepReported`, a `dirty_worktree` finding); branches are never deleted by the sweep.

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
| `ba_task` | `BaTaskQueued{kind:'scheduled_brief', instructions, deliver, scheduleId, scheduleName, orgLevel?}`. A reporter task kind (`ReporterTaskKind`): the BA gets `baTask.reporter.brief`, answers with `aom report brief --summary-file` (`scheduled_brief` outcome), `applyReporterReport` posts an `alert/ba_report` desk item (org-level unless the schedule is tied to a project; `deliver: 'chat'` links the standing BA chat). With no BA, `runReporterFallback` posts the instructions as a notice. An org-level task may be taken by any BA of the organization |
| `integration` `github`/`jira` `issues_poll` | enqueues the runner command `integration.run`; the run stays `pending` until the answer (below) |
| `integration` `webhook` | builds the JSON body (`webhookBody`: generic, `slack`, `teams`; all have a `text`) and stores it with the run as `delivery`; the request is made after commit |
| `integration` `email` | builds the digest text (`commands/schedule-digest.ts`: `floor_report`, `project_summary`; `registerDigest` is the hook where the interests digest registers in Part D) and stores `{to, subject, text}` as `delivery` |

### 10.3 Event triggers: a cursor sweep

Evaluated by the server, never by an agent. **A sweep, not a hook on the append path** (`commands/schedule-triggers.ts sweepEventTriggers`): `schedule_trigger_cursor` holds the last `events.seq` handled; each sweep reads the matching event types after it (`PhaseCompleted` = `phase_completed`, `CardFinalized` = `card_finalized`, `DigestPosted` of a card of an interest = `interest_run_done`, `ProjectConverted` = `project_converted` (Part C appends it), up to the head of the log, finds the enabled schedules of the event's organization whose trigger matches (project and interest filters), and runs the action. Why a sweep: the event log is the source of truth, so a restart, a crash or a slow action never loses an event (the cursor moves only after its events were handled); the action runs after the event's own transaction committed, so a failing schedule can never fail a phase or a card; and the dedupe key `schedule_runs (schedule_id, source_key = 'event:<seq>')` makes a replay run a schedule once. The sweep runs on the scheduler tick and, for latency, 750 ms after the notifier sees new events (`store.subscribe`). A schedule never runs for events older than itself, nor for an event of a project its owner is not on. The first sweep after a deployment starts at the end of the log.

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

## 11. Runner

### 11.1 Install, pairing, data directory

- Distributed as a tarball/npm package `@aom/runner` with bins `aom-runner` and `aom` (the in-session CLI). Requires Node 22, git ≥ 2.40.
- Data dir `AOM_RUNNER_HOME` (default `~/.aom-runner`; Windows `%LOCALAPPDATA%\aom-runner`):

```
config.json            # 0600: serverUrl, workstationId, runnerToken, repoRoots[], runtimes{claude-code:{bin, authMode, oauthToken?}}, maxConcurrentShifts, vaultSyncIntervalSec
outbox/                # pending acked messages, one JSON file per message id
bin/aom, bin/aom.cmd   # shims to the bundled aom.mjs (prepended to PATH in sessions)
agents/<agentId>/
  home/                # agent HOME/USERPROFILE (.gitconfig with agent identity, tool caches)
  claude/              # CLAUDE_CONFIG_DIR: CLAUDE.md (regenerated each shift), settings.json, transcripts, memory
  scratch/
worktrees/<PROJECTKEY>-<project id[:8]>/<CARD-REF>/   # git worktrees (legacy: <PROJECTKEY>/<CARD-REF>, still reused)
integration/<repoId>/                # worktree on the working branch used for merges (M4)
vaults/<vaultId>/                    # vault clones (M3)
logs/runner.log, logs/shifts/<shiftId>.jsonl   # raw runtime stream per shift (local only)
```

- Pairing: in the web UI the user clicks *Pair workstation* → `POST /api/workstations/pairing-codes` returns a code `XXXX-XXXX` (Crockford base32, 40 bits, 10 min TTL, shown once). On the machine: `aom-runner pair --server https://aom.example.com --code XXXX-XXXX --name "Desktop"` → `POST /api/runner/pair {code, name, platform, hostname, runnerVersion}` → `{workstationId, runnerToken}` (token 32 random bytes base64url, prefix `aomr_`). The runner writes `config.json` (0600). Then `aom-runner start` (foreground; users run it under systemd/launchd/Task Scheduler; `aom-runner doctor` checks git, node, claude, docker, connectivity).
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
| `hello` | `{runnerVersion, protocol:1, platform, hostname, runtimes:[{id, version, available, capabilities:string[]}], repos:[{remoteUrl, localPath, headBranch}], vaults:[{vaultId, localPath, clean}], activeShifts:[{shiftId, cardId?, agentId, startedAt}], outboxPending:number}` | reply `welcome` |
| `outbox.flushed` | `{}` | no — sent after resending all outbox entries post-reconnect |
| `heartbeat` | `{activeShifts: string[], load:{runningShifts:number}}` | no |
| `repos.report` | `{repos:[...]}` | no |
| `shift.accepted` | `{shiftId}` | yes |
| `shift.rejected` | `{shiftId, reason:'busy'|'runtime_unavailable'|'repo_missing'|'worktree_failed'|'rebase_conflict'|'internal', detail?, conflictedFiles?}` | yes |
| `shift.started` | `{shiftId, runtimeSessionId?, worktree?:{path, branchName, baseBranch, created:boolean, headSha}}` | yes |
| `shift.progress` | `{shiftId, items:[{at, kind:'text'|'tool'|'status', text}]}` (batched ≤ 1/s, text ≤ 500 chars each) | no |
| `shift.report` | `{shiftId, reportId, report: ShiftReport}` (§13.4) | yes; server replies `shift.report.result {reportId, accepted, error?}` |
| `shift.ended` | `{shiftId, outcome:'reported'|'no_report'|'stopped'|'crashed'|'timeout', exitCode?, durationMs, usage:Usage, finalText?:string(≤4000), guardViolations:[{rule, detail}]}` | yes |
| `rpc.request` | `{rpcId, shiftId, method:'card.get'|'ledger.search'|'thread.post'|'thread.read'|'devops.request', params}` | reply `rpc.response` |
| `chat.delta` | `{chatId, threadId, text}` | no |
| `chat.done` | `{chatId, threadId, messageText, usage}` | yes |
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
| `command` | `{commandId, command: 'agent.wipe'|'worktree.remove'|'repos.rescan'|'vault.configure'|'vault.write'|'finalize.execute'|'outbound.post'|'repo.create'|'branch.check_merged'|'worktrees.sweep'|'integration.run', payload}` | runner replies `command.result` |
| `ack` | `{ackOf}` | — |

```ts
type AgentRuntimeSpec = { agentId; name; roleKey; seniority; runtime; model; effort?; skills: string[]; permissions: AgentPermissions; isDevops: boolean };
type WorktreeSpec = { mode:'create'|'reuse'; repoId; remoteUrlNormalized; baseBranch; branchName; path?: string /* reuse */ };
type ShiftBrief = {
  shift: { id; kind; stage; stageLabel; doneCriteria; outcomes:[{id,label,kind,data}]; maxShiftMinutes };
  card: { id; ref; title; cardType; fields; riskTier; reworkRound; completionAction; docsNeeded; dependencies:[{ref,title,status}]; parent?:{ref,title} };
  project: { id; key; name; domain; workingBranch; e2eGlobs; architecturalGlobs; vaultFolder? };
  role: { key; name; instructions; coreRules: string[]; extensions?: string; skills: string[] };
  handoffs: [{stage, agentName, outcome, note, at}];           // all, oldest first
  reviewComments: [{reviewerName, reasons, criteriaMissed, comments, at}];  // latest rework round
  thread: [{authorName, kind, body, at}];                       // last 30 messages
  standingOrders: [{title, body}];                              // ledger standing orders (M2), org + project
  ledger: [{id, scope, title, body}];                           // entries linked to the card
};
```

Reconnection (runner): exponential backoff with full jitter, base 1 s, cap 30 s; reset after 60 s connected. On connect: send `hello`, wait for `welcome`, resend outbox entries in creation order, send `outbox.flushed`. Running agent sessions continue while disconnected; their `shift.report`/`shift.ended` are queued in the outbox. `shift.progress` and `chat.delta` produced while offline are dropped (chat is cancelled on disconnect: the runner kills the chat process and emits `chat.error` via outbox).

Reconciliation (server, on `outbox.flushed`): for every card with `claim_workstation_id = ws` and a `claim_shift_id` not in `hello.activeShifts` and whose shift is not ended → `ClaimReleased(runner_lost_shift)`. For every `activeShifts` entry whose claim the server no longer holds (e.g. released after 1 h offline) → `shift.stop {reason:'claim_lost'}`; the runner stops the session, discards any unsent terminal report for that shift and keeps the worktree. Then deliver pending `runner_commands` for the workstation in order.

Runner process restarts (decided in M1.5): the runner persists each accepted `shift.start` as `<dataDir>/active-shifts/<shiftId>.json` and deletes it when the shift ends. After a crash or restart it re-runs the persisted shifts under the **same shift id** in the same worktree before connecting, and lists them in `hello.activeShifts`, so the server keeps the claim ("restart within the lease keeps the claim"). A resumed shift does not re-send `shift.accepted`/`shift.started` (unless `shift.started` was never sent). The agent process itself is restarted, not re-attached: Claude sessions start a fresh run on the card branch, the mock agent counts it as the next attempt. If the server released the claim meanwhile (offline past the 1 h lease), `hello` is answered with `shift.stop {claim_lost}` and the runner stops the resumed session. A restart that loses the persisted file (data dir wiped) falls back to `runner_lost_shift` release as above.

Presence: server marks `connected=true` + `WorkstationConnected` on `welcome`, `connected=false` + `WorkstationDisconnected` on socket close or 45 s without heartbeat (WS ping/pong every 15 s too).

### 11.3 Runner command queue

`runner_commands` gives durable delivery to offline runners (`agent.wipe` after a firing, `worktree.remove` after finalize, `vault.write` after an answer, `finalize.execute`, `outbound.post`, `worktrees.sweep` with each repository hygiene run, `integration.run` for an issue poll of a schedule). Delivered on connect and immediately if connected; marked `done` on `command.result ok`; retried with backoff (max 10 attempts, then `failed` + desk escalation). Command handlers on the runner must be idempotent (wiping a missing dir is success; writing an identical vault file is success).

---

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
  addDirs: string[];                             // read access: vault folder for the card's domain
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
- Auth fallback: if no token is configured and `~/.claude/.credentials.json` exists, symlink (copy on Windows) it into each agent's `configDir` at shift start. Credentials never leave the workstation.

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

- **Instructions file** (`CLAUDE.md` in the agent's `CLAUDE_CONFIG_DIR`, regenerated each shift), sections in order: *Who you are* (name, role, seniority; "names are handles, not personas"), *Role instructions* (role definition + owner extensions), *Core rules* (immutable rules, e.g. builder: never modify unit tests outside the card's scope; no E2E; tester: change E2E tests only), *Standing orders* (vault `standing-orders.md` + project `standing-orders.md` + ledger standing orders; M2/M3), *Project* (`PROJECT.md` from the domain vault; M3), *How to report* (the `aom` contract below, with the exact allowed outcomes for this stage), *Boundaries* (work only in `cwd`; do not push, rebase, checkout or switch branches; do not touch other worktrees; search the ledger with `aom ledger search` before asking).
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
aom finalize --action pr|push_branch|merge         # M7 BA
aom answer --item <deskItemId> --text ...          # M7 BA/senior in a question shift
aom escalate --item <deskItemId> --note ...        # M7
aom phase list|propose|assign|submit ...           # BA intake chat: propose a phase and its cards (the manager confirms on the desk)
aom phase followup brief <n> --to devops|tester|ba --text ... ; aom phase ready      # BA task: delegate each follow-up, then say all are briefed (terminal)
aom phase report --summary-file <md> [--outstanding ...]... ; aom phase results --summary-file <md>   # BA task: report the finished phase / the follow-up results (terminal)
aom phase followup done|fail <n> --summary ... [--link <url>]...   # BA task: a custom follow-up the BA did itself (terminal)
aom report triage|notes|signals --file <json> ; aom report floor --summary-file <md>   # BA reporter task: held items, notes on urgent items, urgent signals, the daily floor report (terminal)
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

### 13.6 Rebase step (M4)

Before `test` and `finalize` shifts (`stage.rebaseBefore`), the runner (not the agent) runs in the worktree: `git fetch origin <base>`; `git rebase origin/<base>`; on non-zero exit `git rebase --abort`, collect `git diff --name-only --diff-filter=U` beforehand, and reject the shift with `rebase_conflict`. No agent ever resolves conflicts silently; the conflict becomes Rework for the builder with the conflicted files in the event.

### 13.7 Post-shift guard and auto-commit (`shifts/guard.ts`, `shifts/autocommit.ts`)

Before submitting a terminal report the runner checks the worktree against the role's permissions:

- reviewer / any role with `mayCommit:false`: HEAD unchanged and no working-tree changes, else violation `reviewer_modified_code`;
- tester: every changed path (committed since the shift's start SHA plus uncommitted) matches `project.e2e_globs`, else violation `tester_edited_non_e2e`;
- builder: no changes to test files outside the card's diff that were not created in this card (heuristic: modified files matching test globs that also exist on the base branch and are not in the card's `affectedAreas`) → flag `out_of_scope_test_change` in `diffStats` for the reviewer (not blocking).
- any role: no commits on any branch other than the card branch; no changes outside the worktree.

A violation rejects the report (the CLI prints why so the agent can fix it within the same shift) and is recorded on `shift.ended.guardViolations`. After the session exits, any uncommitted changes in the worktree from roles with `mayCommit:true` are committed by the runner as `aom: <REF> <stage> leftovers (shift <shortId>)` so the next holder sees them.

---

## 14. Chat (M2)

- `POST /api/chats {agentId, projectId?, cardId?}` creates a `chat` thread (`ThreadMessagePosted` history lives in it). Allowed agents: any non-retired agent the user may direct (§17).
- Browser sends `chat.send {threadId, body, clientMsgId}` over `/api/ws`. Server appends `ThreadMessagePosted(kind chat, author user)`, checks the agent's workstation is connected; if not, replies `chat.error {reason:'workstation_offline'}` immediately and nothing is queued.
- Server sends runner `chat.start {chatId, threadId, agent, message, resumeSessionId, context}`; the runner runs one headless call per user message in the agent's sandbox with `cwd` = agent scratch dir (or the card worktree read-only if `cardId`): `claude -p <message> --resume <sessionId> --output-format stream-json --verbose --include-partial-messages`. Deltas stream back `chat.delta` → forwarded to the browser; `chat.done` → server appends `ThreadMessagePosted(kind chat, author agent)` and a `ShiftEnded` for a `chat` shift (tokens count toward the agent). `threads.runtime_session_id` (stored in `data` of the last agent message) is reused for `--resume`.
- Chat sessions do not count against capacity and never claim cards. Within chat the agent has the same `aom` CLI with a chat-scoped token that allows `comment`, `ledger search`, `devops`, and, for the BA in M7, `card create/specify`.

## 15. Decision desk, questions and ledger (M2)

- **Raising**: an agent runs `aom question`. The server first runs a ledger full-text search (`websearch_to_tsquery` over `ledger_entries.search`, scoped to the card's org and project + standing orders, `ts_rank` ≥ 0.1, top 3). Hits are stored as `dedupLedgerIds`; the CLI response includes them and, if any hit exists and the question is non-blocking, asks the agent to confirm with `--force`. Then `QuestionRaised`.
- **Routing (escalation chain)**: M2 routes every question to the manager desk (`routed_to='manager'`). M7 adds steps 2–3: if a senior agent of the same role or the card's previous holder is in the org, a `question` shift is dispatched to that agent with the question; it may `aom answer` or `aom escalate`; escalation goes to the BA (another `question` shift), whose escalation lands on the desk. Question shifts have `kind:'question'`, no worktree, and are dispatched with the same candidate ordering but from a separate `desk_items` queue (`routed_to='agent'`).
- **Desk list**: `GET /api/desk` returns open items visible to the user (§17), ordered by `pinned DESC, blocking DESC, cardinality(affected_card_ids) DESC, created_at ASC`. Pinned: `blocking` questions, `tester_bottleneck`, `vault_conflict`, DevOps hard-stops.
- **Answering**: `POST /api/desk/:id/answer {answer, optionId?, ledger:{scope, title?}}` → one append: `QuestionAnswered` + `LedgerEntryAdded` (+ `ThreadMessagePosted` on the card thread). Every card in `card_blockers` for the item with no other open blocker goes back to `queued`. A `vault.write` command writes the decision file (§16.4). Already-answered items return `409`.
- **Direct entries**: `POST /api/ledger {scope, projectId?, cardId?, title, body, tags}` lets the manager add requirements and standing orders without a question.
- **Approvals** (`kind:'approval'`): outbound drafts, large-tier merges, DevOps destructive actions, taste rules, workflow/role definitions. `POST /api/desk/:id/resolve {resolution:'approved'|'rejected', editedBody?, note?}` → `DeskItemResolved` + the domain event (`OutboundApproved`, `WorkflowVersionApproved`, …).

## 16. Vaults, DevOps engineer and external systems

### 16.1 Vault model

- Vault = git repo registered on the site by URL only (`VaultRegistered`): each user has a `work` and a `personal` vault (registered in settings); a shared project may have a `project` vault visible to its members. The site never stores vault content.
- Layout (per spec): `standing-orders.md`, `projects/<name>/PROJECT.md`, `projects/<name>/decisions/`, `projects/<name>/standing-orders.md`, `projects/<name>/<sub-category>/`, `projects/<name>/taste.md`, plus `org/workflows/<key>/v<n>.yaml` and `org/roles/<key>/v<n>.yaml` for definitions (M10). `<name>` = `projects.vault_folder` (default lowercase project key).
- A card reads only the vault of its domain (or its project vault): the runner passes only that clone as `--add-dir` and only that vault's files into instructions.

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

External credentials (Jira, GitHub) live only on workstations. Inbound reads happen inside the BA's intake chat using the Jira skill / `gh` on the user's machine. Outbound posts run on the card owner's workstation via `outbound.post` command handled by a runner-side adapter (`apps/runner/src/outbound/{jira,github}.ts`) with two operations `readSource(ref)` and `postApproved(draft)`. If the owner has no connected workstation the draft stays `approved` and is retried on connect.

M8 as built: the BA drafts with `aom outbound draft` in its Finalize shift (`outbound.draft` rpc); the manager can also write one (`POST /api/cards/:id/outbound`). A server-side leak check (`packages/shared/src/external/leak-check.ts`: agent names of the org plus internal terms) blocks a draft (`OutboundBlocked`, never on the desk) and refuses an edit; the runner scrubs once more before posting. Approval is a desk item `approval/outbound` and only the card's owner resolves it (`DeskItemResolved.editedBody` is the edit; `OutboundApproved.finalBody` is posted exactly). The `outbound.post` command goes to the owner's own workstation (queued durably; approved drafts without a workstation are queued when one connects) and is terminal: the runner answers `{ok, externalRef | error}`, a failure becomes an `outbound_failed` alert plus `OutboundPostFailed`, and the owner retries with `POST /api/outbound/:id/retry`. The runner is idempotent per draft (`outbound/<draftId>.json`; an ambiguous failure first looks for the exact text on the ticket). GitHub: `gh issue comment`, or `gh issue close --comment` for a resolution. Jira: REST `POST /rest/api/2/issue/{key}/comment` with the owner's API token in the runner config (`jira: {baseUrl, email?, apiToken}`, bearer when no email); a resolution is a comment (transitions are workflow specific).

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
| Create, edit, pause/resume, delete and adopt interests; set the taste rules of a project or an interest; "Run now" and "Research this" | any active member of the interest's linked projects (owner decision, same as phases); an interest links one feed and/or one research project in the same organization, archived projects are refused (409 `project_archived`); a member of only one of the two sees it but cannot edit it (403). Others get 404. A schedule that belongs to an interest cannot be changed or deleted directly (409 `schedule_managed_by_interest`); run now stays allowed |
| Create and edit phases, assign cards, edit follow-ups, project default follow-ups, deploy targets, confirm a BA proposal, approve / reject the follow-ups, reopen a phase, confirm a merge | any active project member (owner decision A1); every route uses `loadVisibleProject` / `loadVisibleCard`, other users get 404. A remote deploy target's workstation must be an active workstation of a project member |
| Reporting preferences, time zone | the signed-in user for their own organization (each user owns their organization); the BA's `aom report` verbs: the BA of the reporter task only (`applyReporterReport`), which can annotate any item of the org, and dismiss or merge only held non-urgent alerts |
| The BA's `aom phase` verbs | the BA of the conversation (propose, assign, submit: its intake chat) or of the task (`ba_task` shift: only that phase) |
| Hire an agent with any allow-list (including "any project") | the org Owner and Admins, onto own workstation |
| Hire an agent as a Member or guest | onto own workstation, from the org's role catalogue, with an allow-list of projects they are on (never "any project"; 403 otherwise); an agent hired for a guest project belongs to the org that owns the project; refused on archived projects |
| Set an agent's allowed projects or focus (`PUT /api/agents/:id/allowed-projects`, `/focus-projects`) | whoever may change the agent (Owner/Admins, or the hiring manager); a Member or guest manager only names projects they are on; the focus must lie inside the allow-list (400 `focus_not_allowed`); every project must belong to the agent's org (400 `invalid_project`); the DevOps engineer is refused (400 `devops_fixed`) |
| Set a project's concurrency cap (`PUT /api/projects/:id/concurrency-cap`) | any active project member |
| Add a standing order (`POST /api/ledger`, or `ledger.scope=standing_order` when answering a desk item) | project owner for project-wide orders (also when a `cardId` is given: the order is still project-wide); the organization owner for organization-wide orders (a guest manager's answer may carry decisions and requirements, never standing orders) |
| Change an agent's `permissions` | anyone who may change the agent, but only to narrow the role definition; widening non-core limits (web/MCP tools, risk tiers, repos) needs the org owner; the role's hard limits (`edit`/`shell` tools it lacks, `mayCommit`, its denied shell patterns, its writable globs) are never widened (`checkPermissions`, `permissions_exceed_role`); changing the role resets permissions to the new role's |
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
- **Headers** (set in the app's `onSend` hook; the behaviour of `@fastify/helmet` without the dependency): `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' <ws(s) origin>; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` (+ `upgrade-insecure-requests` on https), `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`, `Permissions-Policy`, and `Strict-Transport-Security` when `AOM_PUBLIC_ORIGIN` is https (Caddy adds it for real domains too). `style-src 'unsafe-inline'` is needed for React's inline `style` attributes only; there are no inline scripts. All input validated with zod at the route boundary (`fastify-type-provider-zod`).
- **Secrets on the site**: only `DATABASE_URL` and SMTP credentials in env. Session, runner and invitation tokens are random values looked up by hash, so no signing secret exists to leak.

---

## 19. REST API (`/api`, JSON, zod schemas in `packages/shared/src/api/`)

Errors: `{error: {code, message, details?}}` with 400 validation, 401 unauthenticated, 403 forbidden, 404 not visible (also used for "exists but not yours"), 409 conflict/state, 429 rate limited.

| Method & path | Purpose | Milestone |
| --- | --- | --- |
| `GET /api/health` | liveness + DB check | M1 |
| `PUT /api/workstations/:id/hygiene` `{intervalHours: 0|1|6|12|24|168}` | the workstation's repository hygiene cadence (0 = off; owner of the workstation) → the workstation DTO with `hygiene` | hygiene |
| `POST /api/workstations/:id/hygiene/run` | "Run hygiene now": one hygiene DevOps request (201), or the one already queued/running (200, `alreadyRunning`); 409 `no_repositories` when the workstation holds no clone of a project repository | hygiene |
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
| `GET /api/interests?projectId=&status=` (interests with stats, the projects with explicit rules, the number of adoptable schedules) · `GET /api/interests/:id` (detail: last 5 scans, last 5 notes, its taste rules) · `POST /api/interests` (`feedProjectId` or `newFeedProject {key,name,domain}`, `researchProjectId`, `scan`...) · `PATCH /api/interests/:id` · `DELETE /api/interests/:id?keepSchedule=` · `POST /api/interests/:id/run` | the Interests page | interests |
| `GET /api/interests/adoptable` · `POST /api/interests/adopt {scheduleIds}` → `{results:[{scheduleId, interestId?, error?}]}` · `PUT /api/interests/:id/taste {rules:[string]}` · `GET/PUT /api/projects/:id/taste-seed` · `POST /api/projects/:id/taste-seed/resync` | adopt existing feed schedules; explicit taste rules | interests |
| `POST /api/cards` gains `interestId?`; `GET /api/digest-items` and `GET /api/research/publications` gain `interestId` | "Research this" and the per-interest views | interests |
| `GET /api/digest-items?projectId=` · `POST /api/digest-items/:id/rate` `{verdict, reason?}` | | M5 |
| `POST /api/intakes` `{externalSystem?, externalKey?, note}` | start BA intake chat | M7 |
| `GET /api/outbound` · (approval via desk resolve) | | M8 |
| `GET /api/metrics?projectId=&from=&to=` · `GET /api/agents/:id/stats` · `GET /api/hr/recommendations` · `POST /api/hr/recommendations/:id/apply` | | M9 |
| `GET/POST /api/projects/:id/phases` · `GET /api/phases/:id` · `GET /api/phases/by-number/:key/:number` · `PATCH /api/phases/:id` · `PUT /api/phases/:id/followups` (409 `followups_frozen` once approved) · `POST /api/phases/:id/reopen` `{reason}` (409 `cannot_reopen` after approval) | phases and their follow-ups | phases |
| `PUT /api/cards/:id/phase` `{phaseId\|null}` (409 `card_terminal`, `phase_not_open`, `wrong_project`, `not_a_member_card`) · `POST /api/cards/:id/confirm-merged` · `GET /api/board?projectId=&phaseId=\|none` (cards carry a `phase` chip) | assignment, merge confirmation, board filter | phases |
| `GET/PUT /api/projects/:id/followup-defaults` · `GET/POST /api/projects/:id/deploy-targets` · `PATCH/DELETE /api/deploy-targets/:id` (409 `target_in_use`) | defaults and deploy targets | phases |
| `GET/PUT /api/reporting` `{routeViaBa?, dailyAt?}` · `PUT /api/auth/timezone` `{timezone}` (400 `invalid_timezone`) | BA reporting preferences of the caller's organization; the manager's IANA time zone (`UserDto.timezone`, `DeskItemDto.baNote / triage / chatThreadId / floor`) | reporter |
| `POST /api/roles` · `POST /api/workflows` (draft) · `PUT /api/roles/:id` · `PUT /api/workflows/:id` · `POST /api/roles/:id\|workflows/:id/validate` · `…/submit` · `DELETE /api/roles/:id\|workflows/:id` (drafts only) · `PUT /api/roles/:key/extensions` · `POST /api/roles/:key/reset` · `GET/POST /api/departments` · `GET /api/org/catalogue` · `GET /api/org/definitions/:id/file`; all take `?projectId=` | org designer | M10 |

## 20. Browser WebSocket (`/api/ws`, `packages/shared/src/protocol/browser.ts`)

Authenticated by the session cookie at upgrade (+ Origin check). Messages `{type, ...}`:

- Client → server: `hello {lastSeq?}`; `chat.send {threadId, body, clientMsgId}`; `chat.cancel {threadId}`; `shift.watch {shiftId}` / `shift.unwatch {shiftId}`; `ping`.
- Server → client: `ready {seq}`; `event {event: VisibleEvent}` where `VisibleEvent = {seq, type, streamId, payload, actor, projectId, createdAt}` for events passing the visibility predicate; `resync {}` if `lastSeq` is more than 500 visible events behind (client then invalidates all queries); `shift.progress {shiftId, cardId, items}` (only to watchers who can see the card); `chat.delta {threadId, text}`, `chat.done {threadId, messageId}`, `chat.error {threadId, reason}`; `presence {workstationId, connected}`; `pong`.

The web client maps event types to TanStack Query keys in `apps/web/src/ws/invalidate.ts` (e.g. any card event → `['board', projectId]`, `['card', cardId]`; agent events → `['agents']`; desk events → `['desk']`). No client-side event projection in v1.

## 21. Web app

Routes: `/login`, `/invite/:token`, `/` (redirect to last board), `/p/:projectKey/board`, `/cards/:ref` (detail: fields, timeline from transitions + handoffs, thread with comment box, current shift live log, manager actions), `/cards/new`, `/projects` + `/projects/:id/settings` (repos, members, vault folder, globs), `/agents` (M1 list + hire/fire form; becomes HR board in M9), `/workstations` (pairing code, connection state, repos/runtimes reported, unlink), `/admin` (users, invitations, all workstations), `/desk` (M2), `/ledger` (M2), `/chat/:threadId` (M2, mobile friendly), `/schedules` (M5), `/interests` (the Interests page; `?open=<id>` opens an interest's panel; `/p/:key/feed?interest=<id>` filters the running list), `/hr` (M9), `/org` (M10). API client: `fetch` wrapper with `credentials:'include'` and JSON; zod-parses responses in dev only. Tailwind; no component library in v1 except Radix primitives for dialogs/menus (`@radix-ui/react-dialog`, `@radix-ui/react-dropdown-menu`).

## 22. Configuration, ports and deployment

Server env (`apps/server/src/config.ts`, zod-validated):

| Var | Dev default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://aom:aom@127.0.0.1:5433/aom` | tests: `.../aom_test` |
| `AOM_PORT` / `AOM_HOST` | `4600` / `127.0.0.1` | `0.0.0.0` in container |
| `AOM_PUBLIC_ORIGIN` | `http://localhost:5173` | used for links, Origin check, cookie Secure flag (https) |
| `AOM_SMTP_URL` | `smtp://127.0.0.1:1025` | Mailpit in dev |
| `AOM_MAIL_FROM` | `Guildwise <noreply@aom.local>` | |
| `AOM_MIGRATE_ON_BOOT` | `true` | |
| `AOM_FIRST_RUN_HIRE_CAP` | `true` | until M9 |
| `AOM_SERVE_WEB` | `false` (dev), `true` (prod) | serve `apps/web/dist` |
| `LOG_LEVEL` | `info` | |
| `AOM_REPORTER_SECONDS` | `60` | BA reporter sweep: signal detectors, expired triage holds, the daily floor report |
| `AOM_WEBHOOK_ALLOW_PRIVATE` | `false` | outgoing schedule webhooks may reach loopback and private-network addresses (local tests and the e2e stack; leave off in production) |
| `AOM_LEGACY_FEED_SCHEDULES` | `false` | still accept new feed schedules through `POST /api/schedules` (only the e2e stack: they stand for the ones an old installation holds until feeds are interests; otherwise a 400 `use_interests`) |
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

**Licensing** (`orgs/licensing.ts`, `orgs/limits.ts`, `packages/shared/src/orgs/plans.ts`). One plan, `founding`, with all features and `NO_LIMITS`; limits (`maxMembers`, `maxWorkstations`, `maxAgents`, `maxProjects`) are nullable per organization and enforced inside the creating transaction (invitations count as seats, guests and DevOps engineers never count). `licensingTick` (scheduler) ends trials, warns once per threshold and suspends after the grace days (system actor, audited). The dispatcher, scheduler, reporter and hygiene skip non-operational organizations; running shifts finish.

**DevOps engineer** (`commands/devops.ts`, `commands/agents.ts`): one per (organization, workstation) for each organization the workstation's user belongs to. Owner decision 15a: `PATCH` of extensions, a custom role under key `devops`, workflow-stage claims and standing orders for it are rejected (`devops_fixed`); model and effort remain editable.

**Routes.** `/api/orgs`, `/api/orgs/active`, `/api/org`, `/api/org/{members,invitations,guests,transfer-ownership}`, `/api/auth/2fa/*`, `/api/auth/login/2fa`, `/api/platform/{orgs,invitations,users,audit}`; `/api/admin/*` answers 410. Invitations carry a kind: `new_org` (super admin), `org_member`, or `legacy` (accepted for old links); guest sharing stays `POST /api/projects/:id/members`.

**CLI** (`apps/server/scripts`, bundled as `dist/*.mjs` in the image): `superadmin:create --email --name [--password]`, `superadmin:reset-password --email [--password] [--reset-two-factor]`, `admin:create --email --name [--password] [--org] [--plan]` (a user plus the organization they own), `orgs:migrate [--dry-run]`.

**Web.** The API client sends `X-AOM-Org` from `sessionStorage` (per tab); `OrgSwitcher` and `OrgBanner` in the shell; `/settings/org` (General, Members, Invitations, Guests, Plan & limits); `/settings` security panel and the forced `SecuritySetup` page; the Login 2FA step; `/invite/:token` for the three invitation kinds; `/platform/*` (`PlatformShell`: organizations, detail, invitations, accounts, audit log), which only super admins reach.
