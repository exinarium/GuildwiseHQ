# Discovery Studio, Boardroom and Capability Registry

Status: **experimental branch `feat/discovery-boardroom`**. Not merged to main until the owner has tried it on UAT.

## Goal

A pipeline in front of the existing BA intake:

```
Idea -> Discovery Studio -> Boardroom -> PRD (owner + CEO) -> BA intake -> phases/cards
        (AI interviews you)  (personas debate)  (approved doc)    (exists today)
```

Every stage is optional and can loop.

## Decisions taken for this branch (owner may revisit)

1. Live drafts (briefs, PRDs, minutes) are held on the server during a session. They are published to the org vault as markdown when approved, using the same pattern as `research_publications`. If no vault or workstation is available, the doc stays approved on the server and publishing is retried.
2. Facilitation is a new built-in role, **`analyst`**, not a mode of the BA.
3. In joint sessions the CEO *proposes* answers and opinions. The owner confirms. The CEO never decides for the owner.
4. Runtime: phases A-C run on the existing **Claude Code** runtime adapter. Phase D adds the direct-model multi-provider runtime (Vercel AI SDK on the runner) and Phase E adds external pack import (git, trust review, BMAD mapping). Both are in scope for this branch.
5. Native capability format is the **Agent Skills open standard** (`SKILL.md` + `scripts/ references/ assets/`). Personas use Markdown + frontmatter compatible with Claude Code subagents. Playbooks are step-file workflows.

## Foundation

- **Participants**: `thread_participants` (participant kind `user | agent | persona`, ref id, seat label, stance). Messages get an optional `author_persona_key`. New thread kinds: `discovery`, `boardroom`.
- **Durable turns** (new session kinds only; existing chat untouched): a session turn is persisted as events (`SessionTurnQueued/Started/Completed/Failed`). If the workstation is offline the turn waits, and a server restart re-dispatches it. The turn is never lost.
- **Documents**: `documents` + `document_versions` (kind `brief | prd | minutes | session_log`; status `draft | in_review | approved | handed_off | archived`). Each document links to its source session(s). Cards gain `linkedDocIds` in `fields`.
- All of this is event-sourced, with projections, following ARCHITECTURE.md conventions.

## Capability Registry v0

- Kinds: `skill` (Agent Skills `SKILL.md` folder), `persona` (md + frontmatter: name, description, model?, tools?, skills?, stance, voice, icon), `playbook` (`workflow.md` + `steps/step-NN-*.md` + optional `assets/*.csv`).
- Sources, in precedence order (later overrides earlier): built-in, shipped in the repo (`packages/capabilities/` or similar) -> org vault `org/skills/`, `org/personas/`, `org/playbooks/`. Project-repo and git-pack sources are designed in but deferred.
- The runner indexes files and reports only metadata (key, kind, name, description, hash, source) to the server. The server never stores vault content (existing principle). Built-in metadata can be bundled into shared.
- Role `skills: string[]` now resolves to registry entries. A skill's `allowed-tools` is intersected with agent permissions and never widens them.
- Agents get a name+description index in their instructions and load a full capability with `aom skill show <key>` (provider-neutral). On Claude Code, granted skills may additionally be materialised into the agent's private config dir.

## Discovery Studio

- A session has stances `facilitator | partner | ideate_for_me` and phases `frame -> diverge -> converge -> stress_test -> capture`.
- One question at a time. Each question offers quick-pick options plus free text, and can be skipped or parked. A time-box and progress indicator are shown.
- Live side panel: Ideas, Assumptions, Open questions, Decisions, Parked items (structured, updated by the facilitator through `aom` commands).
- Advanced elicitation proposes changes with an **Apply / Reject / Redirect** gate. Nothing is applied without Apply.
- Technique and elicitation catalogues are data (CSV assets in built-in playbooks).
- CEO modes: `owner_only`, `joint` (the CEO is a participant and proposes answers and opinions), `ceo_prep` (the CEO pre-drafts answers asynchronously and the owner confirms or overrides).
- Output: a brief and/or PRD draft. The PRD template is a built-in asset. Validation checklist.
- **Approve PRD -> create BA intake** with the PRD linked. Cards drafted from it carry `linkedDocIds`.

## Boardroom

- Cast: real agents (with their role and memory), library personas (built-in: devils-advocate, user-advocate, creative-strategist, cost-hawk, security, ops, customer-smb), or personas cast on the fly from a one-line brief. Saved casts are "rooms".
- **Chair** (orchestrator, not a speaker): picks 2-3 speakers per round, never the same speaker twice in a row, honours @mentions, caps turn length, pauses at decision points.
- **Independent-first**: in round 1 each persona answers without seeing the others, then all answers are revealed. The chair detects early convergence and forces a steel-man or dissent round. Disagreements are recorded, never reconciled. The session ends on the owner's signal or a round cap.
- Formats: open, pre-mortem, red/blue team, six hats, option scoring.
- Whiteboard: sticky notes grouped Ideas / Risks / Questions / Decisions / Parked. Personas add notes through `aom board add`. The owner can move, merge and vote.
- Minutes doc: positions, agreements, unresolved disagreements, board snapshot, open questions. **Pull into PRD** seeds a Discovery session (capture phase) with owner and CEO.
- Per-session budget and a live cost meter. Cheap model for personas and chair, stronger model for the synthesis.

## Phases D and E (now IN SCOPE for this branch, built after A-C)

- Direct-model runtime on the runner (Vercel AI SDK, keys on the runner), plus a second provider. Boardroom personas move onto mixed models.
- External packs: git import pinned to a commit, trust review with hash pinning and script approval, BMAD pack mapping (`bmad-agent-*` -> personas, brainstorming/elicitation -> playbooks, product-brief/prd templates -> templates; party-mode replaced by Boardroom), `aom delegate`, Codex adapter.

## Phase A as built: notes and deviations

Built in the foundation phase (details in `docs/ARCHITECTURE.md` section 38).

- **Capability content is compiled into shared**, not read from disk: `packages/capabilities/` holds the files, `generate.mjs` writes `packages/shared/src/capabilities/builtin-data.ts`. The server and runner bundles then need no file path, and the web app can list the built-ins.
- **Runner protocol**: session turns reuse `chat.start` (additive `session` block) and the `chat.*` frames instead of a new message pair, so streaming, cancel, the outbox and reconnect all work as for chat. Capability gating: `session-turns:1` (runner) and `capability-registry:1` (server).
- **Extra events** beyond the four turn events: `SessionTurnRequeued` (recovery), `SessionThreadUpdated`, `ThreadParticipantUpdated`, `DocumentPublishQueued`, `CapabilityIndexReported`.
- **Personas speak as `authorKind 'agent'`** with `authorPersonaKey` and no agent id, so no existing agent-message query changes.
- **Turns are not shifts**: no `ShiftStarted/Ended`, so session token usage is stored on the turn but not yet in the cost ledger or budgets. To do before the Boardroom has a live cost meter.
- **Publishing**: `vault.write` mode `replace` to `<project folder>/docs/<slug>.md` or `org/docs/<slug>.md`; `publish_state 'queued'` means the durable command exists, not that the runner committed it.
- **Not yet built (later phases)**: the facilitator logic and its `aom` verbs for the side panel (ideas, assumptions, decisions, parked items) and `aom board add`, the chair's speaker selection, CEO modes, the Apply/Reject/Redirect gate, the web UIs, per-session budgets, materialising granted skills into the agent's Claude config dir, project-repo and git-pack sources.

## Phase B as built: notes and deviations

Details in `docs/ARCHITECTURE.md` section 38.1.

- **Facilitation lives in `session_config`**, not a new table; questions, notes and proposals are projections. The facilitator is the `analyst` agent if one is hired, else the persona.
- **Session turns are in the cost ledger** (`shift_costs` kind `session`), priced at append time. Per-session `budgetUsd` stops queueing (409) and the UI says so; spend is in USD.
- **Facilitator phase changes apply at once** (the owner overrides in the stepper); the spec said "suggests".
- **`aom session draft` takes `--content`/`--content-file`** (and `--file`): session turns are read-only, so the agent cannot create a file to point at.
- **CEO gating** is: CEO enabled and not paused. The policy classes (`desk.answer_question` etc.) are not consulted: the CEO only proposes to the owner.
- **Open product questions (decided by default):** per-session budget in USD vs org currency; the CEO's `ceo_prep` cap is 12 and not configurable in the UI; a validation result is kept for the latest check only; Hand to BA needs a BA online (no queueing); only Owners/Admins create sessions; no hard stop at the end of the time box (the facilitator is told to wrap up); Discovery/Documents section videos are registered but unrecorded; phase 1 history of turns before this change has no cost rows until a projection rebuild.


## Phase C as built: notes and deviations

Details in `docs/ARCHITECTURE.md` section 38.2.

- **One step function.** `BoardService.advance` reads the stored state (stage `setup|round|chair|decision|minutes|ended`, round, plan, pause, mentions) and queues whatever turn is due. Every trigger (turn end, owner message, resume, budget raised, decision, the scheduler sweep) just calls it, so a restart continues where it stopped. Round 1 queues every seat at once with `context selected` (the topic and the brief only); later rounds run one speaker at a time so each hears the one before.
- **The Chair drives through verbs** (`aom board next|converge|pause|disagreement add|add|cast|minutes|show`, rpc `board.*`, capability `board-verbs:1`, runner 0.1.44). The server enforces the rules whatever the Chair says: mentions first, no duplicates, the last speaker cannot open the next round (a mention is exempt: it is the owner's wish), at most three plus the mentioned, and if the Chair twice gives no usable pick the server picks the least heard voices (`source fallback`).
- **Sealed round 1 is enforced on the server for state** (`sealedMessageIds`, hidden notes, `aom board show` is refused to a sealed speaker) and by the page for the messages: `GET /api/threads/:id/messages` still returns them to the session's own participants.
- **Length cap**: instructed (150 words) and enforced (1400 characters, cut at a sentence, `data.truncated`).
- **Minutes**: exact sections (cast, disagreements, decisions, whiteboard snapshot) are assembled by the server from the data; the Chair's synthesis (positions, agreements, open questions) is the stronger-model part. If the synthesis cannot run (budget) the minutes are still written without it. On demand minutes make a new version of the same document.
- **Pull into PRD**: `DiscoveryService.create(..., seed)` with `phase capture`, a seeded PRD draft (the PRD template, then the minutes' substance) and panel notes; CEO `joint` when a CEO exists.
- **Models**: `{runtime, model}` per role (`persona`, `chair`, `synthesis`) and per seat (`castModels`); unset roles use `DEFAULT_BOARD_MODELS` (haiku, sonnet, opus) or, when the workstation does not offer that runtime, the first runtime it offers (`defaultModelFor`).
- **Open product questions (decided by default):** the default round cap is 4 (max 12) and the cast 2 to 8; the session runs on its own until the cap, a decision point, a budget stop or the owner pauses (it does not wait for the owner after every round); a mention takes effect in the next round, not inside the current one; the budget is in USD like Discovery; only Owners and Admins create boardrooms and rooms, and rooms are shared by the organization; one minutes document per session (versions, not copies); real agents in the cast run on their own runtime and model unless a seat model is chosen; Suggest a cast leaves an unstarted session in the list marked "Setting up"; the Boardroom video is registered but unrecorded; `option_scoring` records scores as sticky notes, there is no tally yet; the Chair's chatter is not shown (its picks are).
