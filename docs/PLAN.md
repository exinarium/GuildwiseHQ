# Guildwise HQ — v1 Build Plan

**Status: All 10 milestones (M1–M10) implemented and green.**

Companion to `docs/ARCHITECTURE.md` (design, referenced as §n) and `docs/SPEC.md` (product). Milestones follow the spec's build plan (phases 1–9). Each milestone lists scope, files, acceptance criteria (AC) and tests. A milestone is done when all AC pass in CI (`pnpm typecheck && pnpm lint && pnpm test && pnpm e2e`).

| Milestone | Spec phase | Theme | Depends on |
| --- | --- | --- | --- |
| M1 | 1 | Core loop: scaffold, event store, auth, pairing, projects, cards, dispatcher, runner (mock + Claude Code), builder → reviewer, bare board, deploy | — |
| M2 | 2 | Decision desk, questions, ledger, standing orders, chat | M1 |
| M3 | 2 | Vaults + sync, DevOps engineer, shared projects and multi-manager rules | M1 (M2 for desk items) |
| M4 | 3 | Tester and bug loop, rebase, finalize, full suite, regression, bottleneck alert | M1, M2 |
| M5 | 4 | Scheduler and feeds (scout, curator, digests, ratings, taste.md) | M2, M3 |
| M6 | 5 | Research projects (researcher, checker, publish to vault) | M3 |
| M7 | 6 | BA intake, escalation chain, spec validation, BA finalize | M2, M4 |
| M8 | 7 | Outbox and adapters (gated Jira updates, GitHub issues) | M7 |
| M9 | 8 | HR board, track records, metrics, recommendations | M1 data; M4 for bug stats |
| M10 | 9 | Organization designer: custom roles, workflows, departments | M2, M3, M9 |

From M2 onward the team's own work should be fed through the deployed tool (spec: "from phase 2 onward, new work is fed through the tool itself"), which is why deployment is part of M1.

---

## Parallelisation rules (apply to every milestone)

1. **Contract first.** Each milestone starts with a small *contract* work package in `packages/shared` (event schemas, API schemas, protocol messages, workflow/role data). It is merged before the app work packages start. After that, server, runner and web work packages run in parallel against the contract.
2. **File ownership.** Server packages own `apps/server/**`, runner packages own `apps/runner/**`, web packages own `apps/web/**`, E2E owns `e2e/**`. Nobody edits another lane's directory; contract changes go back through the contract owner.
3. **Registries are append-only one-liners.** Shared hot spots — `packages/shared/src/events/index.ts`, `packages/shared/src/api/index.ts`, `apps/server/src/projections/index.ts`, `apps/server/src/app.ts` (route registration), `apps/web/src/router.tsx`, `apps/runner/src/aom/aom-cli.ts` verb table — only receive single-line additions; domain logic lives in per-domain files (`events/desk.ts`, `projections/desk.ts`, `routes/desk.ts`, …). Merge conflicts there are trivial.
4. **Migration number ranges** per milestone (§4): M1 0001–0099, M2 0200–0299, M3 0300–0399, M4 0400–0499, M5 0500–0599, M6 0600–0699, M7 0700–0799, M8 0800–0899, M9 0900–0999, M10 1000–1099.
5. **Fakes at the seams.** The runner lane tests against an in-process fake server (`apps/runner/test/fake-server.ts`) that speaks the shared protocol; the server lane tests the runner gateway with a fake runner client (`apps/server/test/helpers/fake-runner.ts`); the web lane may use MSW handlers (`apps/web/src/mocks/`, dev only) generated from shared API schemas until the server routes land.
6. **Independent milestones** that can run concurrently once their dependencies are met: M2 ∥ M3 (different domains; M3's decision-file hook into `QuestionAnswered` is a small follow-up owned by M3), M4 ∥ M3, M5 ∥ M6 (both after M3), M9 ∥ M7/M8.

---

## M1 — Core loop (spec phase 1)

Goal: a manager logs in, pairs a workstation, creates a project and a fully specified card; a builder agent claims it exclusively, works in a git worktree, hands off; a reviewer approves or bounces it; everything is visible on a bare board. Works end to end with the mock adapter (CI) and with Claude Code (manual smoke). First runs capped at two builders and one of each other role.

### M1.0 Scaffold and contract — 1 builder, blocks everything else

Scope:
- Root: `package.json` (workspace scripts `dev`, `test`, `e2e`, `typecheck`, `lint`, `db:migrate`), `pnpm-workspace.yaml`, `tsconfig.base.json` (strict, ESM, `moduleResolution: bundler`), `biome.json`, `.env.example`, `.nvmrc` (22.23), `packageManager` field for pnpm 12, `.gitignore` (`.dev/`, `dist/`, `node_modules/`, `test-results/`).
- `packages/shared` (`@aom/shared`):
  - `ids.ts`, `events/{define,user,workstation,project,card,shift,agent,catalogue,index}.ts` (M1 events of §5.2: accounts, workstations, projects except sharing, cards except testing/finalize, shifts, agents, catalogue).
  - `workflows/{schema,resolve,validate}.ts` + `builtin/{code,code-bugfix,research,feed}.ts` (all v1 definitions now, so cards pin to stable versions from day one).
  - `roles/{schema,builtin}.ts` (all built-in roles with instruction text for builder, reviewer; placeholders marked TODO-M4/M6/M7 for others are acceptable).
  - `cards/{fields,columns}.ts` incl. `MockScriptSchema`, `requiredMissing`.
  - `api/{auth,admin,invitations,workstations,projects,cards,agents,board,shifts,catalogue,index}.ts`.
  - `protocol/{runner,browser,ipc}.ts` (complete message set of §11.2/§13.4/§20 for M1; later milestones add messages).
  - `prompt/{instructions,shift-prompt}.ts` (`renderInstructions(brief)`, `renderShiftPrompt(brief)`).
  - `authz/` pure predicates.
- Empty app skeletons with `package.json`, `tsconfig.json`, entry files: `apps/server`, `apps/runner`, `apps/web`, `e2e`.

AC:
- `pnpm install && pnpm typecheck && pnpm lint && pnpm test` pass on a clean clone.
- `validateWorkflow` returns no issues for all four built-ins and the specific issue code for each of the nine rule fixtures in §6.6.
- `resolveOutcome(code v1, card{docsNeeded:false}, 'test', 'pass')` → `{event:'TestPassed', toStage:'finalize'}`; with `docsNeeded:true` → `docs`.
- Every runner/browser/ipc message has a zod round-trip test.

Tests: `packages/shared/test/{workflows,columns,fields,protocol,prompt}.test.ts` (prompt rendering via inline snapshots).

### M1.1 Server foundation — server lane

Scope: `apps/server/src/{main,app,config}.ts`, `db/{pool,tx,sql,migrate}.ts`, migrations `0001_events.sql` … `0009_runner_ops.sql` (§4.1), `eventstore/{types,pg-event-store,notifier}.ts`, `projections/{index,users}.ts`, `auth/{password,sessions,origin-check,guards}.ts`, `routes/{auth,invitations,admin}.ts`, `mail/{mailer,templates}.ts`, `commands/{auth,invitations}.ts`, `scripts/admin-create.ts`, `scripts/projections-rebuild.ts`, catalogue boot registration (`catalogue/boot.ts`), `test/helpers/{db,app,mailpit}.ts`, vitest config with `globalSetup` migrating `aom_test`.

AC:
- Migrations apply on an empty DB, are idempotent on re-run, and abort if an applied file's checksum changes.
- `EventStore.append` is atomic with projections: a projector throwing rolls back the events. `expectedVersion` conflicts raise `ConcurrencyError`. UPDATE/DELETE on `events` fail.
- `subscribe` delivers committed events in `seq` order exactly once per process under 20 concurrent appenders (test with 1000 events).
- Admin invites `x@example.test` → email visible in Mailpit with link `${AOM_PUBLIC_ORIGIN}/invite/<token>`; accepting sets password, logs in, invitation cannot be reused; expired (clock-shifted) and revoked tokens are rejected; resend invalidates the previous link.
- Login sets `HttpOnly; SameSite=Lax` cookie; mutating requests without matching `Origin` → 403; non-JSON bodies → 415; deactivated users get 401 and lose sessions.
- `admin:create` bootstraps the first admin. Built-in workflow/role versions are registered at boot exactly once.

Tests: `test/eventstore.test.ts`, `test/migrate.test.ts`, `test/auth.test.ts`, `test/invitations.test.ts`, `test/admin.test.ts`.

### M1.2 Server domain — server lane (starts when M1.1's event store and test helpers are merged)

Scope: `projections/{workstations,projects,cards,agents,shifts,threads}.ts`, `commands/{workstations,projects,cards,agents,shifts}.ts`, `routes/{workstations,runner-pair,projects,cards,board,agents,catalogue,shifts}.ts`, `runner-gateway/{gateway,registry,handlers,brief,commands-queue}.ts`, `browser-gateway/{gateway,visibility}.ts`, `dispatcher/{dispatcher,candidates,claim,reaper}.ts`, `authz/scope.ts`, `test/helpers/fake-runner.ts`.

AC:
- Pairing: code issued (10 min, single use, 5 attempts); `POST /api/runner/pair` returns a token; WS with that token gets `welcome`; bad/unlinked token closes 4401/4403; unlinking closes the socket and releases claims.
- `hello` repos are matched to project repos by normalized remote URL (`git@github.com:acme/web.git` ≡ `https://github.com/acme/web`).
- Card create validates fields per field set; `specify` returns 422 with the missing keys; specified card enters `build`/`queued`; card refs increment per project.
- Hire: name uniqueness per org including retired; first-run cap (2 builders, 1 per other role) enforced; name suggestions skip used and retired names.
- Exclusive claim: 50 concurrent `claim()` calls on one card produce exactly one `CardClaimed`; the dispatcher never assigns a card to an agent whose workstation lacks the repo, is offline, is at capacity, or belongs to another org; reviewer stage never goes to the card's builder or a junior.
- Dispatcher ordering test matrix: scheduled > work > personal; for builders own rework/bug > other rework/bug > To do; dependencies block To do until done; FIFO tie-break.
- Shift flow with fake runner: `shift.start` → `shift.accepted` → `shift.started` → `shift.report(handoff)` → `HandoffWritten + ReviewRequested + ClaimReleased`; reviewer `changes` → card back to build with `rework_round=1`, routed to the original builder first; `approve` → Test.
- Reports from a shift that does not hold the claim, or with an outcome not on the current stage, are rejected with an error the CLI can print.
- No `shift.accepted` within 30 s → `ClaimReleased(runner_rejected)`. Lease expiry (simulated clock) → `ClaimReleased(lease_expired)` and the card is queued again with a system thread note. Reconnect with missing active shift → `runner_lost_shift`; runner reporting a shift the server released → `shift.stop{claim_lost}`.
- `AgentRetired` releases claimed cards with the last handoff attached and queues `agent.wipe`; retired agents never get claims.
- Browser WS: a user receives only events for their own org/projects; `hello{lastSeq}` replays missed visible events.
- `projections:rebuild` on a DB produced by the test suite yields identical projection tables (excluding operational columns).

Tests: `test/{workstations,pairing,projects,cards,agents,claim-race,dispatcher-order,lease-reaper,runner-gateway,browser-gateway,rebuild,isolation}.test.ts`.

### M1.3 Runner — runner lane (parallel with M1.1/M1.2 after M1.0)

Scope: all of `apps/runner/src` listed in §1 except `vaults/`, `devops/`, `outbound/`: `cli.ts` (`pair`, `start`, `status`, `doctor`, `repos add|list`), `config.ts`, `paths.ts`, `connection/{client,outbox}.ts`, `ipc/server.ts`, `aom/aom-cli.ts` (M1 verbs: `card`, `comment`, `handoff`, `review approve|changes`, `outcome`, `question` stubbed to 501 until M2), `sandbox/sandbox.ts`, `git/{git,worktrees,repo-scan,diffstat}.ts`, `shifts/{supervisor,guard,autocommit}.ts`, `adapters/{types,registry,claude-code,claude-stream-parser,mock,mock-agent}.ts`, tsup build producing `dist/aom-runner.mjs` and `dist/aom.mjs` + shims, `test/fake-server.ts`, fixtures.

AC:
- `aom-runner pair` stores config with mode 0600; `start` connects, sends `hello` with repos/runtimes, heartbeats every 15 s, reconnects with jittered backoff (1 s → 30 s) and resends outbox entries after restart of the runner process.
- Worktree create on first claim (`aom/<ref>-<slug>` from the working branch), reuse on later stages, recreate from branch if the directory vanished; rejects with `worktree_failed` otherwise.
- Sandbox per agent: `CLAUDE_CONFIG_DIR`, `HOME` and `.gitconfig` identity under `agents/<id>`; `agent.wipe` removes it idempotently.
- Mock adapter: default script completes build → review → test transitions through the real `aom` CLI; `{"review":["changes","ok"]}` bounces once; `crash`, `hang` (stopped at `maxShiftMinutes`), `no_report` produce the right `shift.ended.outcome`; `edit_outside_scope` as reviewer triggers `reviewer_modified_code` and a rejected report.
- Claude adapter: builds the exact argv/env of §12.2 (unit test on the command builder); stream parser maps recorded fixtures (success, error, tool use, max turns) to `RuntimeEvent`s with correct usage totals.
- Build handoff carries `diffStats` and computed risk tier; leftovers auto-committed after exit.
- IPC rejects requests without the current shift token and after the shift ends.

Tests: `apps/runner/test/{config,outbox,reconnect,worktrees,sandbox,ipc,aom-cli,mock-adapter,claude-args,claude-stream-parser,supervisor,guard}.test.ts` with temp git repos (bare origin + clone).

Manual smoke (documented in `apps/runner/README.md`): with `CLAUDE_CODE_OAUTH_TOKEN` set and `AOM_CLAUDE_SMOKE=1`, `pnpm --filter @aom/runner test:smoke` runs one real builder shift on a toy repo and asserts a handoff is recorded.

### M1.4 Web — web lane (parallel after M1.0)

Scope: `apps/web` Vite + React + Tailwind setup, `api/client.ts`, `api/queries/*.ts`, `ws/{socket,invalidate}.ts`, pages `Login`, `AcceptInvite`, `Admin` (users, invitations: invite/resend/revoke, role change, deactivate; workstations: unlink), `Workstations` (pairing code dialog with copyable command line, connection dot, repos/runtimes), `Projects` + `ProjectSettings` (create, repos), `Board` (columns per §6.5 with card tiles showing ref, title, assignee, age, risk tier, rework round, blocked badge), `CardNew` (form driven by field-set schema; Save draft / Specify with missing-field errors), `CardDetail` (fields, timeline, handoffs, thread + comment box, live shift log via `shift.watch`, manager actions: move, release, cancel), `Agents` (list with status/current card; Hire form: role, seniority, runtime, model, effort, skills, workstation, name with suggestions; Fire with confirmation), shell layout + nav, `mocks/` (MSW, dev only).

AC:
- All pages work against the real server; the board updates live (no reload) when a card moves, via WS-driven query invalidation.
- Hire form disables roles at the first-run cap and shows why. Fire shows which cards will be released.
- Usable at 375 px width for Login, Board (horizontal scroll) and CardDetail.

Tests: component tests with vitest + Testing Library for `CardNew` validation and `columnFor` rendering; flows covered by M1.5 E2E.

### M1.5 End-to-end and packaging — E2E lane (starts when M1.2–M1.4 are feature complete; packaging part can start any time)

Scope: `e2e/playwright.config.ts`, `e2e/global-setup.ts` (migrate+truncate `aom_test`, `admin:create`, temp git origin with a toy project, start server on 4601 with `AOM_SERVE_WEB=true`, start runner with mock adapter enabled in a temp data dir), `e2e/tests/{auth,pairing,core-loop}.spec.ts`; `Dockerfile`, `docker-compose.prod.yml`, `deploy/Caddyfile`, `docs/DEPLOY.md`; runner packaging script.

AC (the M1 definition of done):
1. Admin invites a member; the member accepts via the Mailpit link and logs in.
2. Member generates a pairing code; `aom-runner pair` + `start` succeed; the workstation shows Connected with the toy repo listed.
3. Member creates project `TOY` with the repo, hires two builders and one reviewer (mock runtime) on the workstation; a third builder is refused.
4. Member creates card `TOY-1` with all required fields and `fields.mock = {"review":["changes","ok"]}` and specifies it.
5. Within 30 s the board shows `TOY-1` In progress with a builder; then Review; then Rework (bounced, same builder picks it up again); then Review; then Test. The card detail shows two build handoffs, one review bounce with reasons, one approval, and the branch `aom/toy-1-...` exists in the worktree with the mock commits.
6. Two cards specified at once are claimed by two different builders concurrently; no card is ever held by two agents (assert from `card_transitions`).
7. Killing the runner mid-shift and restarting it within the lease keeps the claim (shift reconciled); killing it and advancing the server clock 1 h (test hook `AOM_TEST_CLOCK`) requeues the card with the last handoff attached.
8. Firing a builder holding a card releases the card, which another builder claims.
9. A second user sees none of the first user's projects, cards or agents (UI and API).
10. `docker compose -f docker-compose.prod.yml up` on a clean machine serves the app over HTTPS (Caddy internal CA in local test), migrations run on boot, `/api/health` is green; a runner pairs against it.

---

## M2 — Decision desk, questions, ledger, chat (spec phase 2, part 1)

Contract (M2.0): `events/{desk,ledger}.ts`, `api/{desk,ledger,chats,threads}.ts`, protocol additions (`chat.*`, `rpc` methods `ledger.search`, `thread.read`), `aom question` and `aom ledger search` IPC schemas, `prompt/` standing-orders section.

Server (M2.1): migrations `0200_desk.sql` (`desk_items`, `card_blockers`), `0201_ledger.sql` (`ledger_entries` + GIN); `projections/{desk,ledger}.ts`; `commands/{questions,desk,ledger,chats}.ts`; `routes/{desk,ledger,chats,threads}.ts`; runner-gateway handlers for question reports, `ledger.search` RPC, chat relay; shift brief includes ledger standing orders + linked entries; `POST /api/auth/password`; runner token rotation.
Runner (M2.2): `aom question`, `aom ledger search`, chat runner (`chat.start` → `claude -p --resume ... --include-partial-messages`; mock chat echoes deterministically), standing orders in instructions.
Web (M2.3): `Desk` page (sorting/pinning per §15, answer with options + recommendation preselected, "add to ledger as" scope), `Ledger` page (search, add requirement/standing order), `Chat` drawer from the desk (agent picker, streaming, offline banner), Blocked column + blocker link on card detail.

AC:
- A mock builder with `{"build":["question","ok"]}` raises a blocking question: card goes to Blocked, claim released, builder takes its next card; the desk item shows agent name, role, card, what it was doing, options, recommended default, blocking and affected-card count.
- Answering writes `QuestionAnswered` + `LedgerEntryAdded`, unblocks the card (re-queued in build, picked up again), and the next shift's prompt contains the answer.
- Asking a question whose text matches an existing ledger entry returns the matches to the agent (dedup) and stores them on the desk item.
- Standing orders added on the desk appear in the instructions of the next shift of every agent in that org/project.
- Chat with an agent streams tokens to the browser; if the workstation is offline the chat says so and nothing is queued; the conversation is saved to a thread.
- Desk is sorted pinned → blocking → affected count → age; urgent items carry a badge. No email or push notifications exist.
- On a shared card with `owner_only`, only the owner can answer (others see it read-only) — full sharing arrives in M3, test with a fixture membership.

Tests: `apps/server/test/{questions,desk-order,ledger-search,chat-relay}.test.ts`, runner `test/{aom-question,chat}.test.ts`, E2E `e2e/tests/desk.spec.ts`, `chat.spec.ts`.

---

## M3 — Vaults, DevOps engineer, shared projects (spec phase 2, part 2)

Contract (M3.0): `events/{vault,devops}.ts`, project sharing events, `api/{vaults,devops,members}.ts`, protocol `vault.*`, `command` payloads `vault.configure`, `vault.write`, `aom devops*` IPC.

Server (M3.1): migrations `0300_vaults.sql` (`vaults`, `workstation_vaults`), `0301_devops.sql` (`devops_requests`, `environment_changes`, `workstations.devops_access`); auto-hire DevOps on pairing; DevOps request queue in the dispatcher (`kind:'devops'` shifts); `vault.write` for decision files on `QuestionAnswered` and for standing orders; sharing endpoints, membership projections, decision-policy endpoint, member removal + agent re-homing (`AgentRehomed`), card re-home endpoint; candidate query vault-presence clause for repo-less cards; agent HR authorization for owner vs additional managers.
Runner (M3.2): `vaults/{sync,write}.ts` (§16.3/§16.4), `devops/requests.ts`, `aom devops`, `aom devops-approval`, `aom devops-done`, DevOps instructions template with workstation access, `--add-dir` for the card's domain vault only, `PROJECT.md` + standing-orders files from the vault into instructions.
Web (M3.3): Settings › Vaults (work, personal, project vault URLs, interval), Workstation › DevOps access + "Ask DevOps" + request threads, project Members tab (invite by email, pending, remove with inheritance preview), invitations inbox for project shares, card decision-policy toggle, agent re-home dialog, project HR filter (owner sees all, members see own as editable).

AC:
- Pairing a workstation auto-hires exactly one DevOps engineer for that user and workstation; it cannot be fired, only reset (sandbox wiped).
- Vault sync on a temp vault: local edits are committed and pushed within one interval; remote edits are pulled; a conflicting edit produces a pinned desk escalation and pauses sync for that vault until resolved.
- Answering a question writes `projects/<name>/decisions/<date>-<slug>.md` into the domain vault via `vault.write`, committed and pushed.
- A work-domain card's shift sees only the work vault (assert `--add-dir` and instruction contents); a personal card only the personal vault.
- A builder that runs `aom devops "start the app"` opens a DevOps request thread; the DevOps shift runs; a request outside the granted access ends with `DevOpsApprovalNeeded` on the desk and resumes after approval.
- Sharing: owner invites an existing user by email; after accepting, the member sees the project's board and desk, can hire a project-scoped agent onto their own workstation from the owner's catalogue, can change/fire only their own hires; the owner can change/fire any; that agent can claim any card in the project; the member's own projects remain invisible to the owner.
- Removing the member: their agents become `needs_rehome` owned by the owner, their claimed cards are released with the last handoff, their cards and desk items transfer to the owner; re-homing onto the owner's workstation keeps name, history and track record.

Tests: `apps/server/test/{sharing,member-removal,devops-queue,vault-write-commands,hr-authz}.test.ts`; runner `test/{vault-sync,vault-write,devops}.test.ts`; E2E `e2e/tests/{sharing,devops}.spec.ts` (two browser contexts, two runners).

---

## M4 — Tester and bug loop (spec phase 3)

Contract (M4.0): `events/testing.ts`, `FinalizeRequested`/`CardFinalized`/`ChildCardResolved`/`RebaseConflict` payloads, `aom test pass|fail`, `command` payload `finalize.execute`, tester and writer role instructions (test ownership rules), `regression` card fields.

Server (M4.1): migration `0400_test_runs.sql`; outcome effects `spawn_bug_child` / `resume_parent`; large-tier double review; `RebaseConflict` handling from `shift.rejected`; finalize endpoint + `finalize.execute` command result → `CardFinalized` + `worktree.remove`; large-tier finalize requires a desk approval first; `FullSuiteStarted` after `CardFinalized` (suite card for testers); `FullSuiteFailed`/`BugReported` → bug card in Spec + desk notice; regression endpoint + `RegressionRequested`; `TesterBottleneck` check in the dispatcher.
Runner (M4.2): rebase step (§13.6); tester guard (E2E globs only); `git/completion.ts` implementing `merge` (integration worktree on working branch, `git merge --no-ff`, push working branch), `push_branch` (`git push -u origin <branch>`), `pr` (`gh pr create` when available, else push + desk notice); Docker presence check before tester shifts (missing → `aom devops` request; DevOps cannot install → hard-stop question to desk).
Web (M4.3): Test column with "waiting on bug" state and child link; Finalize button + completion action selector; evidence panel on card detail; Regression run dialog (web/mobile/both); bottleneck alert with "Hire tester" one-click (pre-filled Hire form).

AC:
- Tester mock `fail` creates a linked bug card (shares the parent's branch) routed first to the original builder; the parent shows "waiting"; after the bug card passes review the parent re-enters the Test queue; `pass` moves to Docs (if docs-needed) or Finalize with evidence attached.
- A tester that edits a file outside E2E globs gets its report rejected.
- A large-tier card needs two distinct senior reviewer approvals.
- Changing the working branch so the card conflicts → `RebaseConflict`, card in Rework with conflicted files listed; no agent resolves it.
- Finalize `merge` on a small card merges to the working branch without the manager; on a large card it waits for desk approval; the worktree is removed afterwards and a full-suite card is spawned for a tester; full-suite failure creates a bug card in Spec and a desk notice without blocking anything.
- When E2E work waits 5 min and all testers are busy, a single pinned desk alert appears with a hire recommendation that opens a pre-filled Hire form.

Tests: `apps/server/test/{bug-loop,double-review,rebase-conflict,finalize,full-suite,bottleneck}.test.ts`; runner `test/{rebase,tester-guard,completion}.test.ts`; E2E `e2e/tests/test-loop.spec.ts`.

---

## M5 — Scheduler and feeds (spec phase 4)

Contract: `events/{schedule,feed}.ts`, `api/{schedules,digest}.ts`, `aom digest`, feed field set finalized, scout/curator instructions (feed rules from spec: general search, preferred sites first, max per kind, append-only ordering, no duplicates, no fabrication).
Server: migrations `0500_schedules.sql`, `0501_feeds.sql`; `scheduler/scheduler.ts`; overflow pass (§9.4); `DigestPosted` → digest items + desk rating item; `ItemRated` → `vault.write` append to `taste.md` + seen-list; `TasteRuleProposed` approvals; regression schedules reuse the scheduler.
Runner: digest validation (every item URL must have been fetched during the shift — the runner records WebFetch URLs from the stream and rejects items not in that set, enforcing no-fabrication), project running list append in vault (`projects/<name>/feed.md`, oldest → newest, never rewritten).
Web: Schedules page (cron with presets "daily 07:00", timezone), "Run now" on feed projects, digest rating UI on the desk (useful / irrelevant / boring + reason), taste.md preview.

AC: schedule fires on time (clock-controlled test) and its card is claimed ahead of normal work; with all scouts busy, exactly one overflow shift starts and a second late schedule waits; feed run appends only new, non-duplicate items; "nothing qualified" logs nothing and says so on the card; ratings land in `taste.md` as explicit rules/examples; curators read `taste.md` at shift start.

Tests: `apps/server/test/{scheduler,overflow,digest,ratings}.test.ts`, runner `test/{digest-validation,feed-list}.test.ts`, E2E `e2e/tests/feeds.spec.ts`.

---

## M6 — Research projects (spec phase 5)

Contract: `events/research.ts`, research field set, `aom publish`, researcher/checker instructions.
Server: migration `0600_research.sql`; research workflow claim paths (researcher, checker; `unsupported` → research rework); `ResearchPublished` projection.
Runner: `aom publish` writes the note with citations into `projects/<name>/<sub-category>/` of the domain vault and commits; checker guard (cannot publish uncited claims: front-matter `citations` non-empty).
Web: research card form (question, scope, depth, sub-category, preferred sites), published note link/preview.

AC: a research card flows question → research → fact-check → published note in the vault with citations; a fact-check failure returns to the researcher as rework; open questions go to the desk like code cards.

Tests: server `test/research-flow.test.ts`, runner `test/publish.test.ts`, E2E `e2e/tests/research.spec.ts`.

---

## M7 — BA intake and finalize (spec phase 6)

Contract: `events/intake.ts`, `aom` BA verbs (`card create`, `card specify`, `answer`, `escalate`, `finalize`), BA instructions (intake, investigation, spec, dependency graph, question answering, finalize), Jira skill reference (provider-neutral skill file in the vault).
Server: migration `0700_intakes.sql`; `IntakeStarted` chat with BA; `TicketMapped` (unmapped → desk question); BA-created cards validated against the schema before `CardSpecified`; escalation chain steps 2–3 (question shifts to senior same-role/previous holder, then BA, then desk); BA claims the Finalize stage (manager button remains as override); completion action revision before finalize.
Runner: question shifts (no worktree), BA finalize executes the completion action through `git/completion.ts`.
Web: Intake button on the desk (chat with BA, linked to created cards), mapping question UI, escalation trail on desk items.

AC: manager pastes a Jira key in intake; BA (mock script) reads it via skill, maps it to a project, drafts a card with all required fields and a completion action; an unmapped ticket becomes a desk question; a builder question is answered by a senior builder or BA without reaching the desk when the ledger/BA can answer, and escalates to the desk otherwise; BA finalizes small cards automatically.

Tests: server `test/{intake,escalation,ba-finalize}.test.ts`, E2E `e2e/tests/intake.spec.ts` (mock BA).

---

## M8 — Outbox and adapters (spec phase 7)

Contract: `events/outbound.ts`, `command outbound.post`, adapter interface `{readSource(ref), postApproved(draft)}` in `packages/shared/src/external/`.
Server: migration `0800_outbound.sql`; `OutboundDrafted` → desk approval (approve/edit/reject); routing of `outbound.post` to the card owner's workstation; retries.
Runner: `outbound/{jira,github}.ts` (Jira via REST with the token in runner config; GitHub via `gh`), rules: manager's voice, no agent names/review internals (BA instructions + a runner-side scrub that rejects drafts containing agent names).
Web: outbound approval card with diff-edit, history per card.

AC: nothing is posted without approval; edits are posted as edited; rejected drafts never post; drafts with internal names are blocked; posting uses the card owner's workstation only; GitHub issues can be read at intake and commented on after approval.

Tests: server `test/outbox.test.ts`, runner `test/outbound-adapters.test.ts` (HTTP mocked with `undici` MockAgent), E2E `e2e/tests/outbox.spec.ts`.

---

## M9 — HR board and metrics (spec phase 8)

Contract: `api/{metrics,hr}.ts`, recommendation types with evidence payloads.
Server: migration `0900_agent_stats.sql` (`agent_stats_daily` + refresh job every 10 min); stats per §HR board (cards done, blocked rate, rework rate, bugs escaped, utilisation, tokens per card) vs role average over a rolling 30-day window; work-quality panel (review score average, rework by reason, rounds per card, criteria missed, test coverage of changes from diffStats); rule-based recommendations (blocked, rework, model up/down, split role, fire/reassign) with one-click apply (`AgentChanged`, hire, proposed standing order to desk); dashboard metrics (throughput, time blocked on manager, bounce rate, bugs escaped, durations, queue depth); built-in role default updates shown with "reset to default" diff; remove first-run hire cap.
Web: HR board (agent cards with generated avatar, status, current card, hiring manager, actions), stats with team average, quality panel, recommendations with evidence and Apply, metrics dashboard.

AC: stats match hand-computed values on a seeded event fixture; each recommendation rule fires on its fixture and not on a control fixture; Apply performs the change via events; additional managers see HR actions only for their own hires.

Tests: server `test/{stats,recommendations,metrics}.test.ts` with fixture event logs; E2E `e2e/tests/hr.spec.ts`.

---

## M10 — Organization designer (spec phase 9)

Contract: role/workflow draft APIs, departments, `validateWorkflow` UI error codes, vault definition file format (YAML, provider neutral).
Server: migration `1000_departments.sql`; draft → validate → desk approval → active; `RoleExtended` / `RoleResetToDefault` (owner only, core rules immutable); built-in roles/workflows cannot be removed; new workflow versions never affect in-flight cards (pinned version test); definitions written to the vault via `vault.write`.
Runner: BA designer instructions; `aom` verbs for drafting definitions in the BA chat.
Web: Org page: role catalogue, workflow editor (stage table + graph preview, validation issues inline), departments filter on HR board and board.

AC: a custom workflow with an unreachable stage, a failure path that never terminates, or an unclaimable stage cannot be submitted; an approved custom workflow routes cards by its stages with a custom role hired from the Hire form; editing the workflow creates v2 while v1 cards finish on v1; a member cannot edit the owner's catalogue.

Tests: shared validation already covered; server `test/{org-designer,workflow-pinning}.test.ts`; E2E `e2e/tests/org-designer.spec.ts`.

---

## Suggested staffing for M1 (maximum parallelism)

| Step | Lane | Work package | Can start when |
| --- | --- | --- | --- |
| 1 | contract | M1.0 | immediately |
| 2a | server | M1.1 | M1.0 merged |
| 2b | runner | M1.3 | M1.0 merged |
| 2c | web | M1.4 (MSW until routes exist) | M1.0 merged |
| 2d | e2e/ops | M1.5 packaging part (Dockerfile, compose, Caddy) | M1.0 merged |
| 3 | server | M1.2 | M1.1 event store + test helpers merged |
| 4 | e2e | M1.5 flows | M1.2, M1.3, M1.4 feature complete |

Contract changes discovered during step 2/3 go through one owner (the M1.0 builder) as small PRs to `packages/shared`, merged before dependent app changes.
