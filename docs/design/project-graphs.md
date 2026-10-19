# Project graphs and the organization graph

Status: **built through Phase 6** (2026-10-19, branch `lean-team-v3`, backlog #82). Phases 7 (withdrawn) and 8 (needs four weeks of
arm data) are not built. Section 16 lists where the build differs from the plan below; where the text above it disagrees with
section 16, section 16 is what exists.
Builds on `docs/design/ceo-front-door.md` (the CEO is the owner's front door; migrations 2220 to 2229 are reserved there,
2226 included), `docs/design/ceo-agent-v3.md` section 0 (trust promise), ARCHITECTURE sections 3 (event store), 13 (shift
contract), 15 (ledger), 16 (vaults) and the Trust copy in `apps/web/src/landing/Landing.tsx:482-488`.

## Owner decisions (binding)

1. **No Graphify dependency, no embedding, no wrapper.** Graphify's ideas, algorithms and formats are rebuilt inside Guildwise
   (Appendix A says exactly which). Code is not copied: the implementers work from this note and from Guildwise's own spec.
2. **Indexing runs on the workstation** that holds the clone (the runner). Customer code never reaches the server, and the
   server holds no platform key for graph work.
3. **The graph is stored in the project vault.** Every project always has a vault. A git vault is recommended. If a project
   has none, a local vault folder on the org Owner's workstation is created (it may sit in OneDrive or iCloud; backing it up
   is the Owner's responsibility, and the product says so).
4. **Server-side placement options are dropped.** No graph tables with code-derived content on the server.
5. **No visual graph view (2026-10-19).** The graph is a backend brain for agents, not a page. Showing it would mean pulling
   data derived from the customer's code into our web app, which breaks the trust policy. Section 9 is withdrawn, and so
   are open questions 3 (label relay) and 4 (module names): **nothing code-derived reaches the server, not even module
   names.** The server keeps only status (indexed commit, counts, indexer version, timings) and the work layer it already
   owns (cards, decisions, merges).
6. **The product is "a brain for your project".** Agents and the CEO get fast, cheap context: the indexed, grouped and
   linked nodes answer "where is X, what touches Y, what does this area do" without broad file reads. **No MCP server**
   (open question 11 closed): an MCP server's tool definitions sit in every session's context whether used or not. The
   graph reaches agents in two cheap ways only: the runner puts a small, relevant slice of it into the brief and chat
   context as work starts (section 7), and an agent that needs more calls the `aom graph` verbs on demand, which cost
   nothing until used.
7. **Parser: tree-sitter (MIT) is approved (open question 1 closed).** It is used for the code layer if it proves itself
   in Phase 0. No public mention or attribution in the product or marketing is needed; the MIT terms only require that
   its copyright and licence text ship with the runner (a `THIRD_PARTY_NOTICES` file in the runner package, alongside
   the grammars' own MIT notices).

Owner requests carried over: a graph for every project; an organization graph that is the CEO's navigation "brain"; agents
use it to spend fewer tokens (briefs and chats pull a relevant subgraph); the token claim must be measured per shift.
(The visual graph view was requested earlier and withdrawn: decision 5.)

---

## 0. Summary

- The graph is a **derived index**. Truth stays in git (code and docs), in events (work: cards, decisions, orders, merges)
  and in the vault (knowledge). A rebuild from those reproduces the graph; the server never rebuilds code-derived content.
- **Workstation:** the runner parses code and markdown with a deterministic pipeline, writes the graph into the project
  vault, and answers `aom graph ...` queries from a local in-memory copy loaded from the vault files.
- **Vault:** `projects/<name>/graph/` holds the project graph (sharded, sorted, diff-friendly files plus a manifest). The org
  graph lives in `org/graph/` in the organization vault.
- **Server:** stores only status (indexed commit, counts, indexer version, vault path, which workstation) and the work layer
  (cards, decisions, orders, merges as nodes, from events). Work-layer nodes carry titles and refs, never code.
- **Incremental:** on `CardFinalized` the server queues `graph.update` to a workstation that holds the repo; the runner diffs
  `last indexed commit..mergeCommit`, re-parses changed files, and rewrites only their shards.
- **Measurement:** every shift records billed input tokens, discovery bytes and graph bytes; a 20% holdout of cards runs
  without the graph section. The claim is published only from that data.

---

## 1. Fit with the event-sourced model

Three kinds of graph data, three homes:

| Data | Source of truth | Built by | Stored in | Rebuilt from |
|---|---|---|---|---|
| Code and markdown structure (symbols, imports, calls, doc headings, modules) | git at a commit | runner | project vault `graph/` shards; runner-local cache | the commit (re-run the indexer; deterministic for the same commit, indexer version and grammar versions) |
| Work (cards, decisions, ledger orders, merges, desk items, projects) | events | server projection, synchronous in the append transaction (ARCHITECTURE 3.3) | server projection tables | `projections:rebuild`, replaying events |
| Org links (which project uses which API, owner assertions) | owner's assertions are events; code-derived links are derived | runner (CEO workstation) | organization vault `org/graph/`; owner assertions as events | assertions from events, derived links from the project exports |

Rules this design adds:

- **Code-derived content is never an event payload.** Events would copy code facts into the append-only log, which the
  deleted-project rule (ARCHITECTURE 3.3) cannot scrub. Events carry only a commit id, counts, an indexer version and a
  vault path.
- **`projections:rebuild` does not rebuild code graphs.** It rebuilds the server status rows and the work layer. The code
  graph is regenerated by re-running the indexer at the recorded commit. The manifest records what it used, so a
  regeneration can be checked (same commit, same indexer, same bytes).
- **Owner assertions are events** (`OrgGraphLinkAsserted`, `OrgGraphLinkRetracted`): an owner says "checkout depends on
  billing-api". These are domain facts, so they are events with a projection (`org_graph_links`), never written by the
  indexer.
- Projectors remain deterministic: they use `e.createdAt`, never `now()`, and call no external service (ARCHITECTURE 3.3).

---

## 2. Placement: workstation builds, vault stores, server coordinates

| Step | Where | Why |
|---|---|---|
| Discover files (`git ls-files`), parse, resolve, rank, write shards | runner, on the workstation that holds the clone | the code is there; the trust promise (ceo-agent-v3 section 0) |
| Docs semantic pass (only if enabled) | runner, through the workstation's own Claude account, restricted profile (no network, no tools except a schema-validated output file) | the same rule as the CEO and the agents: model data goes only to the customer's account |
| Store the graph | project vault (customer's git, or the local folder on the Owner's workstation) | the vault is already the customer's knowledge store; the site "never stores vault content" (ARCHITECTURE 16.1) and keeps it that way |
| Coordinate: request an index, record status, record the work layer | server | event-sourced; no code |
| Work-layer nodes for the indexer | server answers a runner rpc `graph.work` with refs and titles of cards, decisions and orders of the project | the server already holds these; the runner needs them to link modules to work |
| Local query copy | runner memory, loaded from the vault's `graph/` shards at shift start (or from the clone's own index when the vault is not on this machine) | queries stay local and fast |
| Visual view | none (withdrawn, owner decision 5) | showing the graph would pull code-derived data into the web app |

Consequences:

- An agent on workstation B can query the graph only if B has the project vault (or its own clone, which it indexes
  locally). Two workstations with the same commit produce identical shards, so the vault content does not churn.
- The Trust page line "knowledge vaults are kept with your own code, on your side, separate from company systems and from
  the model provider" stays true. Code-derived graph content is in the vault, so the sentence must also say "including the
  code graph" if the copy is changed. Owner decision, flagged in section 15.

---

## 3. Every project has a vault

Today a project may have a project vault; otherwise its shifts use the org vault (ARCHITECTURE 16.1). Under this design:

- **Storage.** A vault is stored either in a remote repository (`storage: 'git'`, every vault so far, with the sync loop of
  ARCHITECTURE 16.3) or as a **local folder** on one workstation (`storage: 'local'`: no remote, no sync, no commits). The vault
  `kind` (`org`, `project`) is unchanged; `VaultRegistered` and `VaultUpdated` carry the optional `storage` and, for a local
  vault, the `localWorkstationId` that holds the folder. Migration `2230_project_vault_kind.sql` adds the two columns.
- **Rule.** Every project always has a vault. Creating a project records `ProjectVaultEnsureRequested` and registers a local
  vault on the Org Owner's primary workstation (the owner's earliest paired, active workstation). If the owner has no workstation
  yet, nothing is registered and the request stays open: the owner's first workstation connecting answers it. The runner creates
  the folder when `vault.configure` reaches it (`<runner data dir>/vaults/<vaultId>`, with a `.aom-local-vault` marker file; the
  plan said `project-vaults/<name>`, one folder scheme for all vaults keeps every vault code path working). The UI shows "not
  synced; back it up yourself" until a git repository is registered, which turns the same vault into a synced one (the runner
  keeps the old folder aside as `<vaultId>.was-local-<time>` and clones the repository).
- **Which vault the work uses.** Knowledge (shift vault context, reports) uses a project's git vault, else the organization vault,
  else the project's local vault, so an organization vault that already holds the knowledge is not displaced. The graph uses the
  project's own vault (any storage), else the organization vault.
- **Warnings.** The runner logs a warning once per local vault ("not synced; back it up yourself") and names the sync tool when the
  folder sits under a known sync root (OneDrive, iCloud, Dropbox, Google Drive); it never runs `git init` itself.
- **Existing projects** get the vault through the data migration `project-vaults-2026-10`, which only records the intent
  (`ProjectVaultEnsureRequested`); the owner's workstation connecting creates the vault. Until then their graph goes to the org
  vault under `projects/<name>/graph/`, the old fallback.
- **Read access.** A `local` vault is readable only on its workstation. Agents on other workstations get no graph unless they hold
  the vault; this is a known limit, not a bug.
- **Setting.** `projectGraphs.enabled` is a server setting (`AOM_PROJECT_GRAPHS`, on by default). Off, no vault is created for new
  projects, nothing is indexed, and no graph is offered.

---

## 4. Storage format in the vault

```
projects/<name>/graph/
  manifest.json                    small: schemaVersion, indexerVersion, grammarVersions, repos[{repoKey, commit, files, nodes, edges, indexedAt, indexedBy}], docsPass {mode, model, files, cachedFiles}
  modules.md                       navigation summary, budgeted (the top modules, entry points, owners, card counts), human-readable
  repos/<repoKey>/<module>.jsonl   nodes and edges of one top-level module, one JSON object per line, sorted by id
  repos/<repoKey>/_edges.jsonl     cross-module edges, sorted
  work.md                          managed section (mode:'section', ARCHITECTURE 16.4) listing card and decision refs per module, no bodies
  communities.json                 module clusters with labels
```

- **repoKey** = first 12 hex of SHA-256 of the normalized remote URL (`normalizeRemoteUrl` already exists in shared). For a repo
  without a remote: a key generated once and stored in the project's `graph/manifest.json`. Never an absolute path.
- **Node ids** = `<repoKey>:<relPath>#<kind>:<qualifiedName>` (for example `k3…:src/billing/invoice.ts#class:Invoice`). Paths
  are relative to the repo root, so ids are identical across machines. This is the lesson of Graphify's id-portability fixes
  (its `cache.py` rewrites absolute ids), applied from day one.
- **Stable order and format** (sorted lines, fixed key order, LF endings) keep git diffs to the lines that changed. As built,
  ids are written without their `<repoKey>:` prefix (the folder name is the repo key), a module shard starts with a header line
  naming its module (so its nodes do not repeat `m`), and `contains` edges are not stored: the loader derives them. `modules.md` and
  `communities.json` are per repository (`repos/<repoKey>/`) and `graph/modules.md` is the repositories' summaries one after the
  other. A merge writes `repos/<repoKey>/_work.jsonl` and `graph/work.md` (section 6).
- **Size cap.** If the export would exceed `graph.maxExportNodes` (default 50,000), the vault keeps `modules.md`, the
  manifest and the module-level shards only. Symbol shards stay in the runner-local cache, rebuildable.
- **Merge conflicts.** Files under `graph/` are generated. A rebase conflict there is never a desk item (ARCHITECTURE
  16.3 would otherwise stop the vault). The sync loop regenerates the affected shards from the commit and continues.
  `_edges.jsonl` and `manifest.json` are regenerated in full, so they never need a three-way merge.

Node kinds: `repo`, `module` (a directory or a package manifest), `file`, `symbol` (class, function, method, type, route,
config key), `doc` (markdown heading), `test`, `package` (declared dependency), and work kinds `project`, `card`, `decision`,
`order`, `merge`. Edge kinds: `contains`, `imports`, `calls`, `extends`, `implements`, `references` (doc to code),
`documents` (doc to module), `tests`, `depends_on`, `touches` (card or merge to module), `decided` (decision to module),
`links` (owner assertion, org graph only).

Each edge carries `confidence` and `source`:

- `confidence`: `EXTRACTED` (the source states it: an import binding that resolves exactly), `INFERRED` (resolved by a rule:
  name-based call resolution), `AMBIGUOUS` (several targets; listed, never drawn as fact).
- `source`: `ast`, `regex`, `doc` (deterministic markdown), `llm` (docs pass), `git` (merge), `work` (events), `owner`.

Rule carried into the agents' instructions: **an INFERRED or AMBIGUOUS edge is a lead, not a fact; read the file before
you act on it.** The graph section of a brief prints the tag next to each edge.

---

## 5. Indexing pipeline (runner)

Module `apps/runner/src/graph/` (new). Steps per repo at a commit:

1. **Discover.** `git ls-files -z` at the commit (the clone's own index; no worktree is created). Skip: binaries, files over
   1 MB, vendored and build folders (`node_modules`, `vendor`, `dist`, `bin`, `obj`, `.venv`), generated files by marker,
   and sensitive names (secrets, credentials, `.env*` except templates). The sensitive list is rebuilt from the same idea as
   Graphify's `detect.py` (section 0 of Appendix A), with a test per pattern.
2. **Parse code.** tree-sitter (MIT) through its WASM binding, one grammar per language. Version 1 targets the languages of
   the org's projects: TypeScript and JavaScript, C#, Python and Go to start; other languages get file and module nodes only.
   Output per file: symbols with ranges, imports with their binding names, call sites with the callee's written name.
3. **Resolve.** Imports resolve exactly through the package manifest and the path rules (`EXTRACTED`). Calls resolve by name
   within the resolved import set (`INFERRED`); several candidates give `AMBIGUOUS`. **Prefer no edge to a wrong edge.**
4. **Docs.** Markdown headings and links (deterministic, `doc` source). The optional semantic pass for docs (a model reading
   documents through the workstation's own Claude account) **is not built**; `docsPass.mode` is `off` in the manifest.
   Docs text is wrapped as untrusted data in the prompt and its output is schema-validated; a label is stripped of control
   characters and capped at 256 characters.
5. **Work layer.** As built there is no `graph.work` rpc: a `graph.update` command carries the card ref and title of the merge
   (the server owns them), the runner computes the changed paths from git and attaches the card to the modules they belong to
   (`touches`, derived on load from `_work.jsonl`). Decisions and orders are not attached yet.
6. **Modules and communities.** Modules come from directories and package manifests. Communities are computed on the module
   graph (not on raw symbols, so labels stay readable) with a fixed-seed clustering (section 12, idea 6). Labels are the
   most-connected module names; no model call.
7. **Write.** Shards, `_edges.jsonl`, `modules.md`, `communities.json`, `manifest.json` written to the vault's `graph/` tree
   through the existing `writeVaultFile` path (ARCHITECTURE 16.4), then committed by the vault sync loop. Writes are skipped
   when the bytes are unchanged, so an unchanged commit makes no commit.

Trigger: a `graph.index` durable runner command (`runner_commands`, `commands-queue.ts`) is queued when a workstation that holds
a project's clone connects (and the project has no graph yet), at each `ProjectGraphRequested`, and by the owner's "Index again".
It reads the clone's object store (`git ls-tree`, `git cat-file --batch`), never its working tree, so it needs no repo lock, and it
uses no model, so a usage limit does not matter. The parser is synchronous WASM: the loop yields to the event loop every 25 files.

---

## 6. Incremental updates on merge

- Trigger: `CardFinalized` with `resultRef.mergeCommit` (`packages/shared/src/events/card.ts:392-405`). A **reaction of the
  runner gateway** (not a projector: projectors do no I/O) queues `graph.update {fromCommit: indexed commit, toCommit: mergeCommit,
  merge: {ref, title, at}}` to a workstation that holds the clone (durable command). Updates are never merged into one another.
- Runner: `git diff --name-status <manifest commit> <to>` says which files changed. Their blobs are parsed again (the per-file
  facts cache is keyed by blob id and parser fingerprint); every other file's facts come from the cache. The resolver then runs
  over all facts, which gives exactly what a full index of that commit gives, **including links between changed and unchanged
  files in both directions**, and only the shards whose bytes changed are written. (The plan stored unresolved references per file
  to re-resolve only the changed names; that optimization was not needed: resolving the whole of this repository takes well under
  a second.) The test `graph-update.test.ts` compares an update with a full index byte for byte.
- Module and community recomputation: communities are recomputed every 10th merge (`communityEvery`); in between,
  `communities.json` keeps the last result and records the commit it was computed at, new modules joining a group of their own.
- Force-push or rebase where `fromCommit` is not an ancestor of `toCommit`: full re-index.
- Event: `ProjectGraphUpdated {projectId, repoId, repoKey, fromCommit, toCommit, filesChanged, files, nodes, edges, modules,
  indexerVersion, durationMs, workstationId, vaultId, fullReindex?}`: ids, commits and counts only. The work layer's `touches`
  edges are in the vault (`_work.jsonl`), not in the event.
- The vault sync resolves conflicts in generated graph files itself (the remote side wins, the runner rebuilds the graph from the
  clones with the last request it kept) and never raises a desk item for them.
- A new project starts from an empty graph and grows through merges, decisions and cards, as the owner asked.

Failure: `ProjectGraphFailed {reason}` with a retry backoff (the CEO shift failure pattern, ARCHITECTURE 9.11). A parse error in one file
drops that file's symbols and records a count in the manifest. It never fails the whole graph.

---

## 7. How agents and the CEO query it

Surface: new `aom graph` verbs, served by the runner's shift supervisor through a local rpc method (like `transcript.fetch`
and `card.attachments` at `apps/runner/src/shifts/supervisor.ts:1379-1380`). The graph is answered on the workstation; no
server round trip.

| Verb | Use | Output cap |
|---|---|---|
| `aom graph query "<text>" [--project KEY] [--budget 1500]` | subgraph for a question: term-scored start nodes, bounded BFS | `--budget` tokens, default 1,500 |
| `aom graph path <a> <b>` | shortest path with edge tags | 20 hops |
| `aom graph explain <node>` | a node with its edges, tags and file:line | 40 edges |
| `aom graph impact <file or symbol> [--depth 2]` | callers and callees within depth 2: the blast radius of a change | 60 nodes |
| `aom ceo route "<request>"` (CEO only, org scope; `aom ceo route --drafts` lists what the code suggests) | candidate projects and areas for a request, with the reason for each | 800 bytes (drafts: 1.8 KB) |

Brief integration: the runner, not the server, composes a short "Graph context" section for the shift instructions (the
regenerated `CLAUDE.md` of ARCHITECTURE 13.2). It uses the card's title, affected areas and ledger one-liners as the query,
capped at 1.5 KB, and tells the agent to call `aom graph` before a broad grep. This replaces some broad reads; it does not
replace the card's own text. Chats get the same verbs (the chat allowlist, `apps/runner/src/chat/chat.ts:86-90`, gains
`graph.query` and `graph.explain`, read-only).

Reviewers: `aom graph impact` feeds the adversarial pass of backlog #70 (callers and callees of every changed symbol). This
replaces broad reads with a bounded list; the reviewer still reads the code.

CEO: `aom ceo route` is a read-only CEO verb. The server knows the verb (`CeoRpc` op `route`) but the **runner answers it** from
`org/graph/` of the organization vault on its workstation, in the CEO's shift and in the owner's CEO chat, so nothing code-derived
is read by the server. The CEO judges; the graph only ranks. Chats get `graph.query` and `graph.explain` only; the other verbs
are refused there.

MCP server: not in v1. Agents already talk through `aom` with a per-shift token scoped by verb allowlists (ARCHITECTURE
13.4). An MCP server would be a second, separately scoped surface. Revisit when a full-power CEO session needs it
(ceo-front-door F4).

---

## 8. The organization graph

- **Where it lives.** `org/graph/` in the organization vault (git, or a local folder on the Owner's primary workstation, which the
  server registers when the organization has no vault). It is built on the workstation that holds that vault, from the project
  graphs it can read, when a project is indexed or updated, a link is asserted or retracted, or a project is archived or
  restored (`graph.org` command; one build runs at a time, requests that arrive meanwhile mark it dirty and it runs again).
- **Files.** `projects.jsonl` (projects, and each project's areas with their package names: names only, never a symbol, a file or
  a line), `links.jsonl` (derived links with their status, and the Owner's assertions), `drafts.md`, `manifest.json`.
- **Derived links are code-derived, so they never leave the workstation.** `depends_on` (EXTRACTED): a module of project A
  declares a package that a module of project B is. `touches` (INFERRED): two to four projects have an area of the same specific
  name. They are **drafts**: the CEO shows them in chat (`aom ceo route --drafts`), the owner confirms a link by adding it, and only
  then does it count for routing. There is **no web page for derived drafts** and no server table for them.
- **What the owner asserts is an event** (`OrgGraphLinkAsserted`, `OrgGraphLinkRetracted`, table `org_graph_links`, migration
  2233) and uses only project ids and names the owner typed. The owner adds and removes links under Settings > Organization >
  Project links. The server sends the assertions to the workstation inside `graph.org`; it never receives a derived link.
- **Routing.** `aom ceo route` ranks projects by name, by area, by what the owner linked, and by links the owner confirmed; a
  retired project is never a candidate.
- **Not built:** `org_graph_nodes` (the projects table already is the node list), person and agent nodes, board nodes.

---

## 9. Visual graph view (web)

**Withdrawn (owner decision 5, 2026-10-19).** There is no graph page and no `graph.view` relay: showing the graph would make the
browser the place where code-derived data is shown. What the web app shows about graphs is status (section 1): the indexed commit,
counts, the indexer version and timings, the measured token saving (numbers), and the links the owner asserted.

---

## 10. Cost of indexing per project

Estimates are labelled as estimates; Phase 0 measures them on this repo and one larger one.

| Layer | Model tokens | CPU and time | Storage |
|---|---|---|---|
| Code (tree-sitter, resolve, communities) | **0** | estimate: a few minutes cold for ~100k lines on a laptop; incremental per merge in seconds (target, unmeasured) | shards in vault: roughly 100 bytes per node uncompressed; git compresses; cap in section 4 |
| Markdown, deterministic | 0 | negligible | in shards |
| Markdown, semantic pass (opt-in above 50k words; default off for code-only projects) | estimate: about 1.3 tokens per word of input, plus about 30% output, once per changed file. A 100k-word docs set is roughly 170k tokens for the first pass, then only changed files | runs in the background | the result is cached per file hash and prompt fingerprint |
| Work layer | 0 | negligible (projectors) | server rows |
| Org graph | 0 (deterministic); CEO judgement only per request | seconds per rebuild | org vault |

**Phase 0 spike results (2026-10-19, measured).** Parser: `@vscode/tree-sitter-wasm` 0.3.1 (MIT; one package that holds the
tree-sitter runtime as WASM plus the TypeScript, TSX, JavaScript, C#, Python and Go grammars, built by the VS Code team; no
native module, no install script). Machine: WSL2 on a laptop, Node 22.23. Corpus: this repository at the base commit,
`git ls-files` filtered to `.ts .tsx .js .cs .py .go`: 1,929 files, 16.1 MB of source (roughly 400k lines).

| Measure | Result |
|---|---|
| Runtime and six grammars loaded | 28 ms |
| Parse of all 1,929 files | 3.5 s (about 4.6 MB/s), 2.70 million syntax nodes, about 50,500 declaration-like nodes |
| Extra resident memory while parsing (tree deleted after each file) | about 36 MB |
| Grammar assets shipped | about 9.6 MB for the five needed grammars plus 0.4 MB runtime |

The "a few minutes cold for 100k lines" estimate above was therefore pessimistic for the parse step: parsing takes seconds, and
the resolve and write steps decide the cold time. The 20-card offline benchmark was
**skipped**: it needs a fixture repository, a grader and paid model runs, far beyond the 30 minutes the Phase 0 budget allows.
Section 11 keeps it as the only place the claim may be stated before live data exists, and the live holdout of Phase 5 is
the measurement that ships.

**Measured with the built indexer (2026-10-19, same laptop, this repository, 2,176 files):** a cold index takes 5.5 to 6.1 s
(through the packaged runner as well: `aom-runner graph-check <repo>` runs it from the release tarball) and gives 12,300 nodes and
27,300 edges in 8 modules; a warm cache with nothing changed takes 0.8 s and writes nothing; an update after a one-file merge
takes 0.9 s (one file parsed) and changes 2 lines of one module shard, 6 lines of the manifest and 2 lines of each summary. The
vault holds 7.3 MB uncompressed for that repository (about 190 bytes per line, about 600 bytes per node with its edges; the plan's
"100 bytes per node" was too low) and 513 KB gzipped, which is what git stores. The 50,000-node export cap therefore means about
30 MB of shards in the vault before git compresses them. The packaged grammars add about 3.4 MB to the runner tarball.

Token cost is charged to the workstation's own Claude account and shows in `shift_costs` like any other shift (the docs pass
is recorded as a `graph` kind shift, so the owner sees it). The owner sets a monthly cap for the docs pass in project settings.

---

## 11. Measuring the token saving (before and after, per shift)

The claim is "fewer tokens for the same work". It is measured, not assumed.

**Per shift (recorded at shift end):**

| Metric | Source |
|---|---|
| `billedInputTokens` = `tokens_input + tokens_cache_read + tokens_cache_write` | `shift_costs` (migration 1317) and the runner's usage report |
| `costUsd` (cost-weighted, same as the cost table) | `packages/shared/src/costs` |
| `discoveryBytes`: bytes returned by Read, Grep, Glob and search-in-Bash results before the first Write or Edit | runner, from the transcript stream (`apps/runner/src/transcript`) |
| `discoveryCalls`: number of those calls | same |
| `graphBytes`, `graphCalls`: bytes and calls of `aom graph` verbs | runner IPC |
| `briefBytes`: prompt bytes of the shift (brief, graph section, ledger) | runner, from the instructions it wrote |
| `graphArm`: `on` or `off` | assigned at shift start |

**Arms.** For each project, a card is assigned to the holdout (`graphArm: off`) by `hash(cardId) mod 5 == 0` during the
evaluation window (default 4 weeks after enabling). Shifts on `off` cards have no graph section and no `aom graph`
verbs in the chat allowlist, but the same instructions otherwise.

**Quality guards** (a saving that costs quality is not a saving): rework rounds per card, changes requested by reviewers,
tester failures, reopened cards, time to Finalize, and cost per accepted card (the unit the owner pays for).

**Report** (the value report per organisation, backlog #37): median and interquartile range of
`billedInputTokens` per **accepted card** for each arm, stratified by card type and size bucket; the ratio with a bootstrap
interval; the quality guards side by side. The public claim ("X% fewer tokens") is allowed only when the interval excludes 1
and no guard is worse.

**Offline benchmark** (Phase 0, reproducible): 20 real past cards replayed on a fixed fixture repository with both arms,
same model, same budgets, a grader for acceptance criteria. This is the only place the claim may be stated before live data
exists, and the methodology goes on the Trust or value page. Graphify's own numbers are not a baseline (Appendix A, section
A.6): its "71.5x" compares against reading every raw file, which no agent does.

**Events.** `ShiftContextMeasured {shiftId, cardId, projectId, graphArm, ...metrics}` written by the runner's shift report
(an additive field on the report, not a new RPC). Projection table `shift_context_metrics` (migration 2232).

---

## 12. Graphify: decision

**Decision: take the ideas, rebuild them inside Guildwise, adopt nothing.** Licence is not the blocker (Apache-2.0, see
Appendix A.1). The blockers are fit and footprint: a Python runtime on every workstation, install-time hooks in customer
repositories and Claude Code settings (contrary to backlog #45, "no Guildwise trace in repositories"), a whole-file in-memory
graph, and extraction bugs in an issue tracker that the project has not fully triaged. Per the owner, nothing is copied
from its code; implementers work from the ideas list below and from this note.

**Rebuild list (ideas, algorithms and formats; source in Appendix A.4):**

1. Two passes: a deterministic AST pass, then an optional LLM pass for docs only; the LLM never decides code edges.
2. Edge confidence tags `EXTRACTED`, `INFERRED`, `AMBIGUOUS`, and the rule "prefer no edge to a wrong one".
3. A second, cross-file call-resolution pass that marks its edges `INFERRED`.
4. Per-file cache keyed by content hash plus a grammar fingerprint, so changed grammars invalidate correctly; per-file
   semantic cache keyed by content hash plus a prompt fingerprint.
5. Node-link style graph with a schema version and the producing version stamped in the file.
6. Community detection with a fixed seed on the module graph, labels from the most-connected names, no model call.
   (Our choice: Louvain or Leiden implemented in TypeScript; open question 8.)
7. God nodes (highest degree) and cross-community "surprising" edges as the first view of a project.
8. Term-scored start nodes plus bounded BFS and DFS under a token budget as the query primitive; an explicit-start-node hook so
   a ranker can be added later without changing the output format.
9. `path` and `explain` as the two other verbs; `graph_diff` between two indexed commits for the merge report.
10. Human-readable outputs: a report (`modules.md`) and a per-community article set (markdown, as vault files), which suits a
    vault.
11. Portable ids: relative paths, no machine paths; relativize and absolutize on read (the `cache.py` lesson).
12. Untrusted-content handling: source and doc text fenced in the prompt with a content hash, labels sanitized (control
    characters, length cap), secret-looking files skipped.
13. Explicit edge direction (arc order is the direction, and the file says so).
14. Cross-repository calls whose target type lives in another repo are parked on the caller and resolved at merge time (idea
    of `cross_repo_calls.py`), feeding the org graph.
15. Benchmark method: same model, identical budgets, a judge validated against a second judge, a token ledger per run (the
    fairness rules of `BENCHMARKS.md`). Our baseline is grep and read, not "read every file".
16. Shortlist-first ranking under a budget: PageRank with personalization toward the card's affected modules, sized to a
    token budget (the idea of Aider's repo map, Appendix A.5).

**Do not rebuild:** video, audio, PDF and office ingestion in v1; more than the four launch languages; the `~/.graphify`
global store; git hooks; `PreToolUse` hooks and CLAUDE.md or AGENTS.md injection; the hosted connectors; query logging of
content (Graphify's own query log is off by default for privacy, and we keep that default).

**Known Graphify correctness issues to avoid by design (from its tracker):** a class field's type leaking to every same-named
receiver (#4294), missing inherited call edges (#4379), HTML label injection (#4124), unbounded edge allocation in
cross-file import resolution (#3868, so we cap resolution work per file), and merged-graph ambiguity across repositories
(#4512, so repoKey is in every id).

**Clean-room rule:** the implementer works from this note and from Guildwise's own spec. Anyone who reads Graphify's source
for the algorithms (for example community detection) writes down the method in our terms first and does not paste code.
Apache-2.0 would require notice for copied code; this rule avoids the question.

---

## 13. Phased plan

Each phase ships behind the setting `projectGraphs.enabled` (as built: on by default from the start of the build, a server
setting `AOM_PROJECT_GRAPHS`; the other test suites run with it off). Tests named below are new files. **Status: phases 0 to 6
built; 7 withdrawn; 8 open (needs four weeks of arm data).**

**Phase 0. Spikes (no product code).** Parse this repo and one larger customer-like repo with tree-sitter WASM in a
scratch directory: time, node counts, memory. Measure the shard size and the diff size of a one-file change. Collect 20 past
cards for the offline benchmark. Output: a short results note added to section 10.

**Phase 1. Every project has a vault.** Files: `packages/shared/src/events/vault.ts` (kind `local`; `ProjectVaultEnsureRequested`),
`apps/server/src/commands/vaults.ts`, `apps/server/src/data-migrations/project-vaults.ts` (registered in
`data-migrations/index.ts`), `apps/runner/src/vaults/manager.ts` (local folder), `apps/runner/src/vaults/sync.ts` (local
kind skips git). Migration `2230_project_vault_kind.sql` (vault kind column and check). Tests:
`apps/server/test/project-vault-ensure.test.ts`, `apps/runner/test/vaults-local.test.ts`. Web: setup step and warning
text.

**Phase 2. The indexer (runner).** Files: `apps/runner/src/graph/{discover,parse,resolve,docs,modules,communities,shards,cache,manifest}.ts`,
grammar assets under `apps/runner/assets/grammars/` (pinned), `apps/runner/src/commands/graph-index.ts` (the `graph.index`
handler). Server: `packages/shared/src/events/graph.ts` (`ProjectGraphRequested`, `ProjectGraphIndexed`, `ProjectGraphFailed`),
`apps/server/src/projections/graph.ts` (registered in `projections/index.ts`; table added to `PROJECTION_TABLES` at
`projections/index.ts:125`), migration `2231_project_graph.sql` (`project_graphs`: project, repo key, commit, indexer version,
counts, status, workstation, updated_at), data migration `graph-backfill` (queues an index for every project with a repo).
Tests: `apps/runner/test/graph-determinism.test.ts` (same commit gives identical bytes; no absolute path in any file),
`graph-secrets.test.ts` (sensitive names skipped), `graph-resolve.test.ts` (EXTRACTED versus INFERRED versus AMBIGUOUS),
`apps/server/test/project-graph-projection.test.ts` (projection replay, `projections:rebuild`).

**Phase 3. Query, brief section and verbs.** Files: `apps/runner/src/aom/aom-cli.ts` (`graph` verbs), local rpc in
`apps/runner/src/shifts/supervisor.ts` (near line 1379), chat allowlist `apps/runner/src/chat/chat.ts:86-90`, brief composition
in the instructions writer. Tests: `graph-query.test.ts` (budget caps, path and impact depth), `graph-brief.test.ts` (1.5 KB
cap, the section present only when `graphArm` is on).

**Phase 4. Incremental updates on merge.** Files: server projector on `CardFinalized` (the finalize command path) queues
`graph.update`; `apps/runner/src/graph/update.ts` (git diff, per-file refs, module recomputation every N merges);
`vaults/sync.ts` (regenerate `graph/**` conflicts instead of a desk item). Event `ProjectGraphUpdated`. Tests:
`graph-update.test.ts` (merge equals full re-index for the changed files; force-push triggers full re-index),
`vault-sync-graph-conflict.test.ts`.

**Phase 5. Measurement.** Files: runner transcript counters (`apps/runner/src/transcript`), shift report additive field,
event `ShiftContextMeasured`, migration `2232_shift_context.sql` (`shift_context_metrics`), holdout assignment at
`shift.start`, value-report section. Tests: `shift-context-metrics.test.ts`, `graph-holdout.test.ts` (assignment stable per
card; off-arm carries no graph verbs).

**Phase 6. Organization graph.** As built: `packages/shared/src/events/graph.ts` (`OrgGraphLinkAsserted`,
`OrgGraphLinkRetracted`), migration `2233_org_graph.sql` (`org_graph_links` only), `apps/runner/src/graph/org.ts` (builds
`org/graph/` from the project graphs), the read-only CEO verb `aom ceo route` (the server's CEO gateway knows the verb, the
runner answers it from the vault), `apps/server/src/commands/org-graph.ts`, Settings > Organization > Project links (links the owner
asserts; no page for derived drafts). Tests: `apps/runner/test/{org-graph,graph-route}.test.ts`,
`apps/server/test/org-graph-links.test.ts`.

**Phase 7. Visual view.** Files: `apps/web/src/pages/graph/*` (three layers, caps, overlays), server relay rpc `graph.view`
(no persistence), runner `graph.view` local handler. Tests: web component tests (`apps/web`, vitest), relay test (payload
not stored: asserts no row written).

**Phase 8. Claim.** Publish a percentage only after four weeks of arm data passes section 11.

Migration numbers: this design uses 2230 (`project_vault_kind`), 2231 (`project_graph`), 2232 (`shift_context`) and 2233
(`org_graph`), after the highest existing migration `2212_card_status_held.sql`; 2220 to 2229 stay with the front-door build. Numbers 2220 to 2229 remain the front-door design's. If that design lands other
migrations first, renumber these.

---

## 14. Risks

| Risk | Mitigation |
|---|---|
| A wrong edge is trusted and an agent acts on it | Confidence tags in every answer; rule "read the file"; prefer no edge; reviewers' impact check reads the code |
| The graph section costs more tokens than it saves on small tasks | Holdout arm; budget cap; section present only for cards above a size threshold (default: any card with affected areas) |
| Local folder vault lost (OneDrive conflicts, laptop loss) | Warning in UI; regenerable from clones and commits; graph is derived, nothing is lost that cannot be re-indexed |
| Git churn in the vault from large exports | Sharding, sorted lines, no-op writes, export cap, regeneration rather than merge |
| Secrets or customer strings enter the index (symbols, comments, docs) | Sensitive-name skip; redaction against the runner's secrets registry (`secrets/redact.ts`) before writing shards; a test seeded with a fake secret |
| Prompt injection through code comments or docs | Fenced as untrusted; no model reads the graph to decide policy; server-side policy still governs actions |
| Indexer nondeterminism breaks the "same commit, same bytes" claim | Fixed sort and seeds; determinism test in CI; grammar versions in the manifest |
| Multi-workstation writes to one vault | Output is identical for the same commit; generated files are regenerated, not merged |
| Org graph routes a request to the wrong project | Candidates with reasons, the CEO decides, owner sees the reason in the desk item |
| Parser grammar licence or maintenance | Pin versions; check each grammar's licence before adding it (tree-sitter core is MIT) |
| Visual view makes the browser the place code is shown | Withdrawn: there is no view (owner decision 5) |

---

## 15. Open questions for the owner (each with a recommended default)

1. **Parser dependency.** Writing parsers is not viable; the code layer needs tree-sitter (MIT) grammars through `web-tree-sitter`.
   "No third-party dependency" read strictly would rule this out. *Default: use pinned tree-sitter WASM and its grammars;
   Graphify stays out.* Confirm the reading.
2. **Local folder vault and sync tools.** *Default: allowed, with a warning; the runner refuses `git init` under a known sync
   root without confirmation; the graph is regenerable.*
3. **Relay of the visual view through the server.** The server does not store it, but it carries code-derived node labels in
   memory. *Default: relay only, capped, not persisted. If you reject this, the code view is available only in a local
   runner page, and the web app shows Work and Org layers.*
4. **Module paths and names to the server.** The work layer needs module names (directory names) to link cards to areas.
   *Default: module names yes, file paths no; file-level links live in the vault only.*
5. **Docs semantic pass.** *Default: off for code-only projects; on for docs up to 50k words; a monthly cap set by the
   Owner; cheapest model in the workstation's runtime.*
6. **Org graph derived edges.** *Default: drafts until the Owner accepts; accepted drafts become events.*
7. **Export cap.** *Default 50,000 nodes in the vault, module level above that.*
8. **Community algorithm.** Louvain (simpler) or Leiden (better connectivity guarantees). *Default: Louvain with a fixed seed
   in v1; Leiden if the module graph shows disconnected communities.*
9. **Language scope.** *Default: TypeScript, JavaScript, C#, Python, Go; others get file and module nodes.*
10. **Node version for the runner.** The WASM parser runs on Node 22. *Default: no native modules, no `node:sqlite` in v1
    (the graph fits in memory from its shards); confirm the runner's minimum Node version.*
11. **MCP later.** *Default: no MCP server in v1.*
12. **Trust page wording.** The Trust copy must say the code graph is kept in the vault, on the customer's side. *Default:
    add it in Phase 1 and say it plainly.*

---

## Appendix A. Graphify evaluation (for the record; the owner's decision is in section 12)

Method: web research and the repository (`https://github.com/Graphify-Labs/graphify`, cloned into the scratchpad at
`/tmp/claude-1000/-home-pieter-src/a5aa47a9-7656-46a5-80d8-4b110f8da949/scratchpad/graphify-src/repo`, read only, nothing
run, no install scripts). Metadata from the GitHub API on 2026-10-19.

**A.1 Licence.** Apache-2.0 (`LICENSE`), with `NOTICE` and `LICENSE-MIT` (MIT for contributions made before the relicensing,
`NOTICE`). The PyPI package is `graphifyy` (double y); the README warns other `graphify*` packages are unaffiliated
(`README.md`, Install section). Apache-2.0 would permit embedding, rewriting and commercial use with notice and without
trademark use (Apache-2.0 section 6). Not relevant to the decision, which is to copy ideas only.

**A.2 Architecture, language, runtime.** Python 3.10+ library plus a skill for 20+ coding assistants (`pyproject.toml`
`requires-python`, `description`). About 56,800 lines in `graphify/*.py` (plus extractors). Pipeline `detect → extract →
build → cluster → analyze → report → export` (`ARCHITECTURE.md`, Pipeline). Dependencies: networkx, numpy, rapidfuzz, tree-sitter
with about 30 language grammars (`pyproject.toml`). Optional extras: graspologic (Leiden), an MCP server (`graphify-mcp`),
Neo4j and FalkorDB exporters, Whisper for video.

**A.3 What it indexes.** Code in about 40 languages through tree-sitter (`pyproject.toml`); markdown, PDF, images, video and
audio through an LLM semantic pass. Both at once in one graph.

**A.4 How graphs are built.** Two passes. Code: tree-sitter AST, deterministic, no LLM (README, "Local-first"). Docs and
media: the host assistant's model, dispatched as subagents, or an API backend (`skill.md` Part B; `llm.py` backends for
Claude, Kimi, OpenAI, Gemini, DeepSeek, Ollama, Bedrock). Edges tagged `EXTRACTED`, `INFERRED` (call-graph second pass),
`AMBIGUOUS` (`ARCHITECTURE.md`, Confidence labels). Communities by Leiden (`cluster.py`), labels without an LLM (README).
No embeddings in the core: "Not a vector index" (README).

**A.5 Storage and query.** `graphify-out/graph.json` (node-link, `"directed": false` with arc order as direction,
`ARCHITECTURE.md`, Edge direction), `GRAPH_REPORT.md`, `graph.html`. The whole graph is loaded into NetworkX. A cross-repo store
at `~/.graphify/global-graph.json` (`global_graph.py`). Query: term scoring of node labels then bounded BFS or DFS under a
token budget (`serve.py` `_score_query`, `_query_graph_text`), with a hook for an external ranker. The MCP server exposes
`query_graph`, `get_node`, `get_neighbors`, `shortest_path`, `god_nodes` and PR tools (`serve.py` around line 2203).

**A.6 Token claims and evidence.**
- README tagline: "Cut agent token spend by 80%", and "80% fewer tokens" for the hosted Graphify Cloud. No method is published
  in the repository for the Cloud figure. (README lines 31, 126, 452.)
- `docs/how-it-works.md` (Token benchmark): "71.5x fewer tokens per query vs reading the raw files directly" on a 52-file mixed
  corpus (Karpathy repos, 5 papers, 4 images); 5.4x on 4 files; about 1x on 6 files. The baseline is reading every raw file,
  which no agent does.
- `graphify/benchmark.py:79`: the corpus token count is words × 4/3, an estimate, not measured tokens of an agent session.
- `BENCHMARKS.md`, code section: 6 questions on ERPNext (about 1M lines); key-fact coverage rises from 70.8% (grep and read)
  to 82.0%, "at about 140K tokens per query". No token baseline is reported for the grep arm, so the saving is not shown.
- The LOCOMO and LongMemEval numbers are conversational-memory results, not code results.
Verdict on evidence: the code saving is unmeasured against a realistic baseline; the headline figure belongs to a paid product
with no published method.

**A.7 Maturity (GitHub API, 2026-10-19).** Created 2026-04-03; 129,043 stars; 12,447 forks; 1,561 open issues; last push
2026-10-16; latest release v0.9.92 (2026-10-16), v0.9.88 on 2026-10-12, so five patch releases in five days. The top account has
1,180 contributions; the next has 148. Security intake is unhealthy: issue #2000 "Please read security advisories!", issue
#2011 "Private vulnerability reporting returns HTTP 500", open issue #3868 "Unbounded edge allocation". Correctness issues
include #4294 (a class field's type leaking to same-named receivers), #4379 (missing inherited call edges in Solidity), #4124
(HTML label injection), #4512 (merged-graph ambiguity). Install footprint: `graphify install` registers PreToolUse hooks in
`.claude/settings.json` for Bash, Grep, Read and Glob, with an optional strict mode that blocks the first raw read
(`graphify/install.py:445-470`, `2165-2187`); git post-commit and post-checkout hooks (`graphify/hooks.py`); CLAUDE.md and
AGENTS.md blocks (`graphify/always_on/`). These conflict with backlog #45.

**A.8 Alternatives (2 to 4, briefly).**

| Tool | Licence (verified) | What it does better | What it does worse |
|---|---|---|---|
| Aider repo map (`aider/repomap.py`), 49,642 stars | Apache-2.0 | Token-budgeted code map: tree-sitter tags, file graph ranked with PageRank and personalization (`repomap.py:374-383`), `--map-tokens` default 1k; cache of tags. Compact and cheap | Code only; no docs, no work layer, no query verbs, no incremental store |
| code-review-graph (`tirth8205/code-review-graph`), 32,264 stars, created 2026-02-26 | MIT | Closest to our design: tree-sitter into a local SQLite graph, exposed over MCP; blast-radius review use case. Its own claims: up to 6.8x for reviews and 49x for daily work; secondary articles report 82x; the authors' own skill notes small projects gain little | Claims are self-reported or from secondary write-ups; MCP surface; 178 open issues |
| Serena (`oraios/serena`), 30,397 stars | Application GPL-3.0-or-later; SolidLSP MIT (README lines 267-270) | Precise references through language servers (LSP), so fewer heuristic edges | GPL application cannot be embedded in our product; needs language servers on each workstation |
| Microsoft GraphRAG (`microsoft/graphrag`, MIT, 36,387 stars) and LightRAG (`HKUDS/LightRAG`, MIT, 40,212 stars) | MIT | Entity and relation graphs over text, good for docs and decision corpora | LLM-heavy indexing (GraphRAG README warns it is expensive); a poor fit for code, where AST is free and exact |

Also noted for later: SCIP (`scip-code/scip`, Apache-2.0, 832 stars) is a precise symbol-index format with per-language
indexers; it could sharpen the code layer after Phase 2, but its indexers need checking per language before adoption.

**A.9 Rebuild versus take-only-the-ideas.** Covered in section 12 (the list of 16 ideas and the do-not-rebuild list).

---

## 16. As built (phases 0 to 6): where the build differs from the plan

- **Parser.** `@vscode/tree-sitter-wasm` 0.3.1 (MIT), pinned exactly as a runner dev dependency; the build copies the runtime (as
  `tree-sitter.cjs`: the runner package is `type: module`) and the five grammars (TypeScript and TSX, JavaScript, Python, Go,
  C#) to `dist/grammars/`, with `THIRD_PARTY_NOTICES` (also in the tarball root). `aom-runner graph-check <repo>` runs the bundled
  indexer on a clone and checks the packaging.
- **Local vault.** A storage (`git` or `local`) rather than a kind; the folder is `<runner data dir>/vaults/<vaultId>` (section 3).
- **Indexer.** Facts per file are cached by blob id; resolution is one pass over all facts (the update is therefore exact);
  modules come from package manifests, else the first folder (one level deeper under `src`, `lib`, `app`, ...). Test files are one
  node each and give `tests` edges. Own package names are on module nodes (`pk`), which the organization graph needs.
- **Server.** Status only: `project_graphs` (2231), `shift_context_metrics` (2232), `org_graph_links` (2233). Every graph command
  answer is parsed by a schema that has numbers, a commit id and fixed reason codes only.
- **Measurement.** The runner counts from the runtime's tool stream (Claude's `tool_result` blocks give sizes only), sends
  `context` on `shift.ended`, and the server stores `ShiftContextMeasured` with the billed input tokens. The report
  (`GET /api/value/graph`, shown on the Costs page) uses a stratified bootstrap ratio of medians (strata: card type and size) and
  the guards (rework rounds, changes requested, tester failures, days to done, cost per accepted card). "Reopened cards" is not a
  guard yet. The claim is offered only with at least ten accepted cards per arm, an interval below one and no worse guard.
- **Holdout.** Server side at shift start: one card in five by a hash of its id, for four weeks after the project's first index.
- **Not built:** the docs semantic pass, decisions and orders in the work layer, `org_graph_nodes`, person and agent nodes, the
  20-card offline benchmark (Phase 0), the public claim (Phase 8), anything visual (Phase 7, withdrawn).
- **Open questions closed:** 1 (tree-sitter approved), 3 and 4 (withdrawn with the view), 11 (no MCP). Question 6 (derived edges):
  drafts stay on the workstation; accepting is the owner adding the link. Question 12 (Trust wording): the copy now says the code
  graph is kept in the vault, on the customer's side, and that none of it is sent to Guildwise HQ.

---

*End of design note.*
