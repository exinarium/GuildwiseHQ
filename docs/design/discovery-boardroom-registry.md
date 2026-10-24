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
- **Open product questions (decided by default):** the round cap is optional and off by default (1 to 50 when set; changed in the fix pass, see the end of this document) and the cast 2 to 8; the session runs on its own until the cap, a decision point, a budget stop or the owner pauses (it does not wait for the owner after every round); a mention takes effect in the next round, not inside the current one; the budget is in USD like Discovery; only Owners and Admins create boardrooms and rooms, and rooms are shared by the organization; one minutes document per session (versions, not copies); real agents in the cast run on their own runtime and model unless a seat model is chosen; Suggest a cast leaves an unstarted session in the list marked "Setting up"; the Boardroom video is registered but unrecorded; `option_scoring` records scores as sticky notes, there is no tally yet; the Chair's chatter is not shown (its picks are).

## Phase D as built: notes and deviations

Details in `docs/ARCHITECTURE.md` section 38.3.

- **One adapter, four providers.** `direct-model` on the Vercel AI SDK (pinned): Anthropic API, OpenAI, Google Gemini and one OpenAI-compatible endpoint (OpenRouter, Ollama, LiteLLM, LM Studio) with a base URL. Models are `provider:model`. It runs session turns and plain chats; it has no shell, edit or file tools and cannot work cards.
- **Tool calls, not a shell.** Each `aom session|board|skill|ledger` verb is a typed tool (zod schemas are the verbs' own), offered by the turn's purpose from one shared table (`SESSION_PURPOSE_VERBS`) that the server also enforces. Calls go over the runner's IPC with the turn's token, so enforcement is the Claude Code path's. 12 steps per turn, 5 minutes per turn.
- **Keys stay on the runner.** Sealed in the browser (the sudo-password key), 0600 `secrets/providers.json`, redacted everywhere; the server relays ciphertext and stores no provider state. The runner reports provider names and models in its runtime report; the choice lists are merged per workstation from that.
- **Costs.** Provider price table in shared (`DIRECT_PROVIDERS`), Claude prices from the existing table; a model with no price is costed 0 and flagged ("Cost unknown for N turns", `shift_costs.cost_unknown`), never the Sonnet fallback.
- **Validation.** `runtime_unavailable` at queue time (explicit model) and at dispatch (every turn). Mixed providers in one boardroom work; the Boardroom blocks with the reason when a seat's provider has no key.
- **Phase C gap fixed.** `GET /api/threads/:id/messages` no longer returns a boardroom's sealed round 1 before the reveal.
- **Deviations from the brief.** The CEO chat chip offers direct models marked "Conversation only" (a restricted conversation: no repositories, no `aom ceo`, never full power); plain chats on a direct model keep their memory on the runner. Discovery got an optional facilitator model (it had no model setting). The Boardroom dialog got a per-seat model picker (the server already took `castModels`; the page had none). Reasoning/"effort" settings are not offered on direct models.
- **Open product questions (decided by default):**
  1. Direct models are not offered for card work or for any agent default, even read-only roles; a reviewer on a direct model would need file reading.
  2. One OpenAI-compatible endpoint per workstation (a second needs a second workstation or a proxy such as LiteLLM in front).
  3. Model lists are static per provider plus the owner's extra ids; only the compatible endpoint's list is fetched. Prices cover the models listed; everything else is "cost unknown" until added to the table. Local models (Ollama) are therefore always "cost unknown", not free.
  4. The key size limit of the sealing (190 bytes, RSA-OAEP) covers today's API keys; a longer credential (a service-account JSON) is not supported.
  5. The Boardroom and Discovery dialogs have no workstation chooser, so the pickers show the union of the owner's workstations; `runtime_unavailable` is the safety net if the session's workstation lacks the provider.
  6. Provider keys are per workstation, set by the workstation's owner only; there is no organization-wide key and no spend cap per provider (the session budget applies).
  7. Direct-model chats keep their text on the workstation (`direct-chats/`); there is no retention setting.
  8. Prompt caching is not set up for any provider (Anthropic needs explicit cache control); cached tokens are priced only when the provider reports them.
  9. The release-age policy of the package manager was relaxed for the pinned AI SDK versions (`minimumReleaseAgeExclude` in `pnpm-workspace.yaml`); drop the entries once they are old enough.

## Phase E as built: notes and deviations

Details in `docs/ARCHITECTURE.md` section 38.4 (packs, trust, BMAD, materialisation, delegation) and `docs/RUNNER.md` (packs, Codex).

- **BMAD, verified against the live repository** (network, 2026-10-23, github.com/bmad-code-org/BMAD-METHOD, MIT). The latest stable tag is **v6.12.4** (formerly a one-click preset, removed in the fix pass): skills live in `src/core-skills/<skill>` and `src/bmm-skills/{agents,plan,ship,v6-shims}/<skill>` with `SKILL.md`, `customize.toml` and `src/bmm-skills/module.yaml` (agent roster). The default branch (v7 line) has a top-level `skills/<skill>/` with `SKILL.md`, `customize.toml`, `bmod.toml`, `assets/`, `references/`, `scripts/`; the `workflow.md` + `steps/` style is only inside some skills. Both index with 0 issues (25 to 33 capabilities); the importer finds `SKILL.md` folders anywhere, so it supports both without a layout switch. The tests use an original fixture in both layouts (`packages/shared/test/fixtures/bmad-fixture.ts`), no BMAD files are vendored and nothing depends on the network.
- **Native skills on Claude Code are not free**: dropping `--disable-slash-commands` also exposes the account's synced skills and plugins, and the permission mode does not gate the `Skill` tool. Hence the allow-list hook, the bundled-skills switch and a deny rule (details in 38.4). The alternative that was rejected: keep the flag and inline granted skills into the instructions (that is what `aom skill show` already does for every runtime).
- **Decided by default (open product questions):**
  1. Packs are public git over https only: the runner clones with an isolated git environment (private HOME, no global config, no credential helper, no ssh agent or keys, no prompts), after resolving the host and refusing loopback, link-local, metadata, private and shared addresses (git is pinned to the checked addresses, redirects are off). ssh and private https are not supported (open question: a per-pack deploy key or token stored on the adding admin's workstation only). A pack is held only by the workstations the adding admin chose (default: their own); only the admin's own workstation pins the commit or reports updates, and the server recomputes the content hash from the snapshot items before it accepts any report; an integrity finding is kept per workstation. 2. A pack that was approved stays approved at an accepted update (the diff is the review), scripts switch off again if the update touched script files. 3. No automatic update check; the owner clicks. 4. Pack scope `project` filters shifts and chats of that project; session turns (Discovery, Boardroom) have no project and see org packs only. 5. Packs carry their organization id and a workstation serves a pack only to the organization it belongs to (`aom skill`, materialisation, delegates, session turns). 6. One approval for a pack as a whole, not per capability. 7. Project-repository skills are read only from real folders inside the checkout (links are not followed) and their text is fenced as untrusted like pack text; they are not reviewed but are only used where a role names them; they are indexed on the first card shift, not on a schedule. 8. Persona `tools`/`model` from `.claude/agents` or a pack are advisory. 9. Granted skills cost Claude Code's skill-listing tokens per shift; roles with no grants pay nothing. 10. Hash pinning covers the indexed text files (binaries in a pack are not served). 11. Discovery pack playbooks are loaded by the facilitator through `aom skill show`, not embedded in the prompt. 12. Codex is limited to roles its sandbox can confine (RUNNER.md); shift resume of a Codex agent starts fresh.

- **Delegation and Codex, open questions (defaults chosen):** delegate targets are persona keys, not hired agents; a persona's own model wins over the cheap default; Claude Code has no max-turns flag so only the 110 s timeout caps a Claude delegate; delegates are not offered to board speakers (sealed rounds) or plain direct chats; Codex runs only roles its sandbox can confine, has no network allow-list, and a Codex agent's shift resume starts fresh; Codex prices are unknown (cost shown as unknown).


## Revision R1 as built: other runtimes and provider keys

Details in `docs/ARCHITECTURE.md` section 38.5 and `docs/RUNNER.md` ("Claude Code on Bedrock, Vertex AI or a gateway", "Gemini CLI runtime", "opencode runtime", "Sandbox parity of the other runtimes", "Provider keys"). Runner 0.1.49, migration 2430.

- **Built:** Claude Code backends (`bedrock:`, `vertex:`, `gateway:` models, data-driven `BACKENDS`); a runtime-agnostic role check (`RUNTIME_GUARANTEES`, `runtimeRoleProblem`) used by hire, move, CEO raise-model, the server command and the runner; the Gemini CLI and opencode adapters inside a runner-owned bubblewrap box with an egress proxy that injects API keys; organization-wide provider keys sealed per workstation with a monthly cap per provider (key source recorded on `shift_costs`), reseal by a holding runner, revocation, and an org Model providers page.
- **Verified against real binaries:** gemini 0.65.0 and opencode 1.19.4 (argv, event streams, policy and permission behaviour, sandbox isolation, resume) against fake local model APIs; claude against a fake Anthropic-compatible gateway. **Only faked:** Bedrock and Vertex (environment contract only), real Google and provider accounts, the Google login flow, real quota messages, and the reseal approval across two real runners.
- **Decisions taken by default:** the harness sandbox wraps the whole CLI rather than using each CLI's own sandbox (none holds on Linux); Gemini and opencode may take no-shell roles because their shell can be restricted to `aom`; tester, writer, architect, DevOps and CEO are refused on all harness runtimes; DevOps and the CEO are also refused on Bedrock/Vertex/gateway; an organization cap counts only keys of source `org`; unknown-cost turns are shown as unknown, not blocked; the cap is checked at queue and dispatch, so a run already started finishes; the org key is stored per organization id on the runner.
- **Open questions:** (1) Google login traffic cannot go through a key route, so it reaches Google's hosts directly (allow-listed); is that acceptable, or should Gemini be API-key only? (2) A local Ollama is reachable only through a configured route; a general "private endpoint" allow-list is not provided. (3) Should a cap also pause already-running sessions at 100%? (4) Native Windows/macOS have no harness sandbox, so Gemini and opencode are Linux/WSL2 only. (5) Cost tables for opencode providers beyond the common ones are unknown until priced.

## Owner decisions (2026-10-24), to build in the revision pass

### Owner's own decisions
- **Hand to BA:** when no BA is online, queue the hand-off and start the intake once a BA's workstation is online. If the org has no BA hired at all, recommend hiring one, with a one-click "Hire a BA".
- **Who creates sessions:** any member can create Discovery and Boardroom sessions.
- **Session ownership:**
  - A session (Discovery or Boardroom/whiteboard) belongs to the member who created it.
  - The creator manages it in full: whiteboard edit/merge/delete, controls, decisions, End.
  - Owners and Admins can override.
  - Other participants can talk, add notes and vote.
- **Session limits:**
  - **Cost:** no limit by default. A limit is optional. If a session with a limit runs out when the minutes are due, ask the owner: write the minutes without the Chair's summary, or raise the budget.
  - **Time:** also optional, set per session (e.g. 30 min), like a meeting.
    - Show the remaining time.
    - Warn as time runs short (e.g. at 5 minutes left), and have the Chair or facilitator steer to wrap up.
    - When time is up, prompt the creator: extend, or wrap up and write minutes/capture now. Don't let it silently overrun.
- **Boardroom cast:** every Boardroom always includes one **Optimist** (argues for the idea and its upside) and one **Devil's Advocate** (attacks edge cases and failure modes), plus 3 to 4 other opinion-giving seats (personas or agents). Total 5 to 6. The two fixed seats can't be removed. A built-in `optimist` persona is needed.
- **Pacing:** Boardroom auto-runs, as built.
- **Card work on other providers is a priority.** Some users only have, for example, a Gemini subscription.
  - First: Claude Code against Bedrock, Vertex or an Anthropic-compatible gateway.
  - Then CLI harness adapters (Gemini CLI first, then opencode), each with a sandbox-parity check like Codex.
- **Provider keys:**
  - Org-wide keys with a monthly spend cap per provider.
  - A workstation's own key overrides the org key and isn't subject to the org cap.
  - The server still never holds plaintext: org keys are sealed separately to each workstation's public key.
- **Packs:**
  - Private packs are allowed, through a deploy key or token sealed to the chosen workstations only.
  - A member must opt in (via a desk item) before a pack is cloned on their workstation.
- **Videos:** later, not in this pass.

### Recommendations accepted by default
- **Discovery:**
  - Budget stays in USD.
  - The facilitator's phase change applies and the owner overrides it.
  - The prep-mode turn cap becomes a setting.
  - "Hand to BA" checks for an existing intake before retrying.
  - Non-managers see no manager-only controls.
- **Boardroom:**
  - The round cap stays at 4 (max 12). (Superseded by the fix pass: optional, off by default, 1 to 50.)
  - Option scoring gets a tally.
  - @mentions jump the current round.
  - Sessions can be deleted or archived.
- **Packs:**
  - Approval stays for the whole pack.
  - Project packs apply in sessions that have a project.
  - Project-repo skills get a review list.
  - An "update check" button is added.
- **Hardening and small items:**
  - The skill guard blocks when it times out.
  - Claude delegates get a turn cap and a shorter stuck-slot time.
  - The Codex login is shared without conflicts.
  - Session document events are hidden from non-participant Owners and Admins.
  - Workstation pickers are added to the dialogs.
  - Large keys are supported.
  - Prompt caching is turned on.
  - Prices can be set for local models.
  - Chat history retention is 90 days.
  - The `http://` endpoint warning is shown and the legal link is fixed.
- **Kept as built:** items 11-13, 17, 21, 25, 33, 38, 42, 44.
- **Later:** remove the package-age exemption.

### Owner decisions (2026-10-24, continued)

**Custom and private capabilities**
- Settings > Capabilities gets an editor for skills, personas (agents) and playbooks.
- Anything authored there is stored as a real pack, in the same format as imported packs, so the owner's own work can later be published or shared unchanged.
- Each pack has a visibility setting:
  - **Organisation:** listed for everyone, and goes through trust review.
  - **Private to my workstation:**
    - Files live only on that workstation. Metadata is visible only to its owner.
    - The workstation's providers and agents can use it, but it isn't shown to anyone else.
    - No trust review is needed.

**Delegation is off by default and an explicit choice**
- No agent, facilitator or Chair may delegate unless the user turns it on. This replaces the current default, where delegation was allowed for the facilitator and Chair purposes and for card, question and BA shifts.
- It's enabled per agent, and the user lists exactly which personas or agents that agent may delegate to.
- Each target runs on the model the user configured for it. The caller can't override the target's model, because a model is chosen deliberately.
- Every grant and every delegation is visible on the agent, and on the card or session.
- Delegation becomes a real child shift:
  - Its tool profile is read-only, edit or shell, and never wider than the parent's.
  - It uses the same sandbox.
  - Its cost is booked to the parent.
  - It shows as a sub-step.
- Native Claude Code subagents are allowed only for granted targets, with their usage read from the transcript.

**Pack agents on the HR board**
- "Hire from pack" turns a persona into a role (persona text as instructions, permissions from its tool profile) and an agent with a source tag (e.g. `BMAD · analyst · v6.12.4`).
- Import can optionally "add all agents from this pack".
- When a pack updates, a new role version is offered and never forced.

**Chat**
- Hired pack agents use the normal chat.
- Personas that aren't hired get "Chat with persona", a one-to-one session on the persona's model.

**Playbooks (`/` commands; not project workflows)**
- A `/` menu in chat and session composers lists the playbooks and skills the user may use.
- A playbook runs step by step, with question cards and Apply/Reject, in the chat or as a new session.
- `aom playbook run <key>` lets an agent start a playbook itself, where granted.

**Build order:** card work on other providers, then the capability editor and private packs, then hire-from-pack and persona chat, then `/` playbooks, then explicit delegation.

**Help videos move out of the app image**
- **Current state:** about 100 files (184 MB) in `media/videos`. They are committed to git (49 commits touch them), copied into `dist` and baked into every app image, and served same-origin at `/videos/<slug>.*` (`apps/web/src/lib/videos.ts`).
- **Proposal:**
  1. **Same repo, own folder.** Videos move from `media/videos` to a top-level `media/videos/` (recordings from `e2e/video` are written there). The app's `.dockerignore` excludes `media/`, so app builds and images never carry the videos.
  2. **Own Dockerfile.** `media/Dockerfile` builds a small static-server image (Caddy or nginx with byte-range support, for seeking) that copies `media/videos/`. It's added to the UAT and production compose files as a `media` service. The app server forwards `/videos/*` to the media service (`AOM_MEDIA_URL`, e.g. `http://media:80`) in every environment, UAT and production alike. Playback therefore stays same-origin and needs no CORS or CSP changes, and the proxy passes `Range` headers through so seeking works. If the media service is down, the proxy answers 404 or 503 quickly and the web app hides the video. Production Caddy needs no extra route.
  3. **Only rebuilt when videos change.** The media image is built from its own context. The deploy builds and restarts `media` only when `media/` changed (detected by a content hash or Docker's layer cache), so app releases never re-upload videos.
  4. **Manifest and graceful absence.** The media image serves `/videos/manifest.json` (slug, files, hash, captions, poster). The web app reads it. If the media service or manifest is unreachable, or a slug is missing, the video UI is hidden: no broken players, and no service-worker caching of failures.
  5. **Tests.** The section-video, tour and service-worker consistency tests switch to checking manifest entries and the hidden-when-unavailable behaviour.
  6. **Docs.** DEPLOY.md documents the media service and how to publish new videos.

**Video voice-over: switch to Kokoro (owner decision, 2026-10-24)**
- Replace Piper with **Kokoro** (offline TTS) for the video narration, using the **Heart** voice (`af_heart`).
- Update `e2e/video/voice.ts` and `e2e/video/setup-voice.sh` (install Kokoro and the voice into `~/.cache/aom-video`, no network after setup), and the VIDEO-PLAN.md voice notes. The narration pacing (words per second) must be re-measured.
- To be built after the media-container change lands (videos then live in `media/videos/`). Re-recording the videos stays for later.

## Revision R2 as built: ownership, limits, the cast, hand-off, packs and skills review

Details in `docs/ARCHITECTURE.md` section 38.7. Migrations 2440 and 2441; runner 0.1.51 (additive).

- **Built, per owner decision.** (1) Any member creates Discovery and Boardroom sessions, on their own workstation. (2) A session belongs to its creator who manages it in full; Owners/Admins in it override; others talk, add notes and vote; `canManage` in both state DTOs and the pages hide the controls. (3) Cost limit optional (unset means unlimited; at minutes time a used-up limit asks the creator: write the minutes without the Chair's summary, or raise the limit) and a time limit for both kinds with a countdown, a warning about 5 minutes before the end that steers the Chair to a final round and the facilitator to capture, a time-up choice (extend +10/+15/+30 or wrap up) with nothing new started until it is made, paused time not counted, durable and sweep-driven. (4) The Boardroom cast: fixed Optimist and Devil's Advocate plus 3 to 4 others, a built-in `optimist` persona, validated on the server. (5) Hand to BA queues when no BA is online, with a Hire a BA action and a desk notice when none is hired, and checks for an existing intake before any start. (6) The prep-mode cap is a setting. (7) Option-scoring tally, @mention jump, archive and delete. (8) Project-scoped packs apply in sessions with that project; one-click Check for updates. (9) Document events stripped for non-participant Owners/Admins; workstation picker in both dialogs. (10) Review list of project-repository skills with block.
- **Decided by default.**
  1. The warning comes at a third of the limit, at most 5 minutes (a 10-minute limit warns at 3, a 5-minute one at 1).
  2. The Boardroom clock runs while a round or the Chair is working, not while it waits for a decision, the minutes, a pause or the creator's time-up choice; the Discovery clock runs whenever the session is not paused (it includes waiting for your answer, like a meeting).
  3. The clock is booked at most one minute per sweep tick, so a server that was down does not eat the meeting (at most a minute is lost per restart).
  4. A time limit set on a running session starts its clock then; removing it forgets the count.
  5. The independent first round queues all its speakers at once; those already queued at time-up still run (they belong to the round that started), the next round does not start.
  6. After the warning, the next planned Boardroom round is the last one and the session then goes to the minutes by itself (a server rule, not only an instruction to the Chair).
  7. Wrap-up in Discovery ends the enforcement of the limit; extending starts it again.
  8. "Hand to BA" marks the document `handed_off` when it queues, not when the intake starts.
  9. An unreviewed project-repository skill stays usable: the review list records decisions and enforces blocks, it does not gate. A block reaches runners with the next `packs.sync`.
  10. Archiving is allowed in any stage on the server (the web offers it for finished and unstarted boardrooms); a deleted session keeps its events and rows, hidden by `deleted_at`.
  11. Owners and Admins who are not in a session still cannot open it (sessions are private to their participants); "override" applies once they are in it.
  12. "Hire a BA" is a plain hire with defaults (junior, the user's first online workstation), not the full hire dialog.
- **Provider cap stop (Q48).** Built as `run.usage` live reports from the runner (0.1.52) counted in memory with the booked spend; at the cap running org-key shifts, chats and session turns are cancelled with a notice, workstation keys and unpriced models are not counted. Delegates are not stopped separately (they have a tool-call cap and are counted when booked).
- **Not built (R3).** Capability editor, private/custom packs, private git packs and deploy keys, member opt-in for packs, hire-from-pack, persona chat, `/` playbooks, explicit delegation grants.
- **Open questions.** (a) Should the Boardroom clock also stop while it waits for the creator at a decision? It does now; the Discovery one does not. (b) Should an unreviewed project skill need review before first use? (c) Should "Archive" of a running Boardroom end it first? (d) Should the time-up choice also notify the creator outside the page (push)?

## Revision R2 hardening as built (workstation and cost side)

Details in `docs/ARCHITECTURE.md` section 38.6 and `docs/RUNNER.md` ("R2 hardening on the runner"). Runner 0.1.50, migrations 2450 and 2460. The session, limits, cast and hand-off items of R2 are in "Revision R2 as built".

- **Built:** the skill guard denies at its own 7 s deadline; a tool-call cap (10) for CLI-runtime delegates; delegate heartbeat (15 s), stale slot after 45 s, slots freed on disconnect; Codex login copy and hand-back under a lock directory; hybrid sealing for every provider key, and a Google service-account JSON as the Gemini credential; prompt caching for Anthropic, OpenAI and Gemini with cache tokens in usage and cost; owner-set model prices; 90-day (configurable) retention of direct chat history; the `http://` warning in the provider form; a neutral terms line for custom OpenAI-compatible endpoints.
- **Decided by default:** Claude Code has no max-turns flag in print mode, so the delegate cap counts stream tool events and kills the process; the owner price table fills gaps only (a model with a list price keeps it) and applies to later turns, never repricing stamped ones; only the Owner sets prices; the service-account exchange is limited to Google's token host; retention is counted from the last write; Gemini caching is implicit (no explicit cache objects).
- **Private endpoints (Q47):** per-workstation allow-list of exact private `host:port` entries (owner only, empty by default, `provider.endpoints.set`, runner 0.1.52), enforced in the harness egress proxy and in the direct runtime's base-URL check; loopback keeps working without an entry and link-local/metadata addresses can never be listed or reached. Not tested against a real LAN server (the proxy tests use local fake upstreams and a resolver stub).
- **Not verified against real services:** the service-account to bearer exchange against Google, Anthropic cache hits and OpenAI cached-token reporting (tested with the SDK's mock model and a fake token endpoint; the first real turn on each provider will show whether the cache counters move).
- **Open questions:** (1) Should owner-priced turns be marked in the session cost meter too (today the mark is in `shift_costs.owner_priced` and the price list)? (2) Should Admins be allowed to set prices? (3) A 1-hour cache TTL for Anthropic would cut cost for long Boardroom sessions but writes cost more: keep the 5 minute default?


**Owner decisions on the R1 questions (2026-10-24)**
- Q46 Gemini Google login inside the sandbox: **allowed** (subscription users), as built.
- Q47 Private endpoints: **per-workstation allow-list.** The workstation owner can add specific private host:port entries (e.g. LAN Ollama or LM Studio) that its agents' sandboxes may reach. Off by default. Shown in the workstation's provider section.
- Q48 Cap reached: **stop immediately.** Running shifts, session turns, delegates and chats that use the org key for that provider are stopped as soon as the cap is hit, with a clear notice. Enforcement is based on live usage reports, not only at queue or dispatch.
- Q49 Gemini and opencode: **Linux/WSL2 only**, as built.
- Q50 Unpriced models: **stay "cost unknown"** and aren't counted against the cap, with a warning, as built.

## Revision R3a as built: custom and private capabilities, private git packs, opt-in, hire from pack, persona chat

Details in `docs/ARCHITECTURE.md` section 38.8. Migration 2470; runner 0.1.53 (`pack-authoring:1`, additive).

- **Built.** (1) The editor in Settings > Capabilities > My capabilities (any member): skills (SKILL.md plus references, assets and script files), personas (name, description, stance, voice, icon, model, tools profile, skills, prompt) and playbooks (workflow.md plus ordered steps and assets), validated live by the shared parsers, stored as a pack in the standard layout, exported as a git-ready zip. (2) Pack visibility: private to my workstation (files only there, metadata and events visible to the owner alone, usable by that workstation's sessions and by the agents the owner grants) and organization (reviewed, then listed for everyone). (3) Private git packs with a deploy key or token sealed in the browser to the chosen workstations only, stored 0600 on the runner, used only for that pack's fetch, host key recorded on first use and pinned, redacted. (4) Member opt-in through a desk item. (5) Hire from pack (single and "add all agents" with a review list), provenance tag, update offers, flags on revocation. (6) Persona chat.
- **Privacy model for org-authored packs (the question the brief left open).** The text of an authored pack never reaches the server. It is a git-less pack that lives on its author's workstation; the server holds only the snapshot (names, descriptions, file hashes) that the Owner or Admin reviews, exactly as for a git pack. Trust is the normal approval of that sha and content hash. **Anyone may author; a Member's organization pack is approved by an Owner or Admin; an Owner or Admin approves their own pack when they tick "approve this version" at saving** (otherwise their save waits for review like anyone's, so an unattended edit never becomes trusted). The other holders get the pinned files from the author's workstation, sealed to each runner key, only after approval and only when the files hash to the approved content. Chosen over storing the text on the server because it keeps the standing rule (the server stores no capability text beyond review snapshots) and makes publishing to git a plain export.
- **Decided by default (open product questions).**
  1. A pack's holders are the workstations the Owner or Admin chooses; an authored organization pack starts on its author's workstation only and is listed for everyone once approved, but is usable only where its files are (so "listed for everyone" does not mean "available on every workstation": the admin adds holders, and members opt in).
  2. Hiring from a private pack copies the persona text into an organization role (visible to Owners and Admins). The dialog says so. The role carries the persona's declared tools; the agent gets them only as far as the hirer may grant.
  3. Role creation by hire-from-pack does not need the "custom roles" plan feature or an approval item: the hire is the approval, and the pack was already reviewed. A role made from a persona claims no workflow stage (chats and sessions only).
  4. Accepting a role-update offer moves every agent of the role to the new version (agents follow their role, as for any role); there is no per-agent opt-out.
  5. A private pack is usable in the owner's sessions on that workstation and by granted agents of that workstation (shifts and chats). It is not offered to a session whose creator is not the workstation's user.
  6. Persona chat runs only on the caller's own workstation and on the persona's model unless one is chosen at the start; no budget limit, the cost is in the ledger. Messages and the persona's replies are private to the chat's participant (other Owners and Admins get stripped events).
  7. Private pack names are unique per owner; organization names unique per organization. A private pack never blocks an organization name, and an organization pack of the same name wins in the registry on the owner's workstation.
  8. A deploy key must have no passphrase; the host key is trusted on first use and pinned per pack and workstation. Rotating a key re-seals it to every holder.
  9. An authored pack is limited to 60 capabilities, 400 files and 1 MiB (it travels sealed inside a durable command); text files only.
- **Not built / next.** The `/` playbooks menu, `aom playbook run` and explicit delegation grants (R3b). No persona-chat budget or retention setting. The editor has no diff view against the pinned revision for the author and no multi-user editing. Hiring is for Owners and Admins in the HR dialog (a Member can use the API for their own project-scoped hire). The visual check of the new screens was done through component tests only: no browser tool was available in the session.
- **Verified against real components.** A private pack over real ssh (a throwaway git host in Docker: key-only access, host key pinned then a changed host key and a wrong key refused: `apps/runner/test/packs-ssh.sshd.test.ts`). Faked: https token against a real host (a wrapper around git records the askpass and environment; the askpass script is run directly), the relay between two runners (two runner-key objects, no network).
- **Open questions.** (a) Should an Owner or Admin be able to preview the text of an authored organization pack while reviewing it (today they review names, descriptions and file hashes, as for an imported pack, and can read the files only by hiring or asking the author)? (b) Should the author's save for review also be possible from a phone-sized screen? (c) Should hiring from a private pack keep the role private to its owner (a per-owner role catalogue)?

## Revision R3b as built: playbooks (`/` commands)

Details in `docs/ARCHITECTURE.md` section 38.10. Migration 2481; no new runner capability (additive optional protocol fields). The delegation half of R3b is in "Revision R3b as built: delegation".

- **Built.** (1) A `/` menu (and a `/` button for touch) in every chat composer (agent, CEO, persona) and session composer (Discovery, Boardroom), listing the playbooks and skills the person may use, with search and descriptions, by the registry visibility rules incl. private and authored packs, trusted only. (2) A skill inserts an instruction; a playbook runs in the chat (an editable instruction to the agent: load it, one step and one question at a time, nothing applied without a go-ahead) or as a new guided Discovery session with question cards, panel, proposals with Apply/Reject/Redirect and drafts to documents, plus a steps strip and the facilitator's `aom session step`. (3) `aom playbook run <key> [--input]` and a direct-model `playbook_run` tool, only for a playbook the agent was granted (off by default; Owners, Admins and the agent's manager grant on the agent's card); the session belongs to the agent's manager, whose desk gets a notice. (4) BMAD planning workflows (create-epics-and-stories for the BA, architecture, UX design, readiness check) are playbooks through the same path.
- **Decided by default.** "In this chat" is a visible instruction, not a hidden injection; the agent loads the playbook itself with `aom skill show playbook:<key>` so imported and private text never passes through the server. A private pack's entries are listed in a chat with an agent only when granted to that agent. An agent starts at most 3 playbook sessions a day. Agent-started sessions are owned by the agent's manager (the shift row does not record the chat's user). Playbook runs save drafts as the existing brief or PRD kinds. BMAD step workflows stopped being skills, so they are not materialised as native skills.
- **Not built / next.** `--input` is free text (no per-playbook typed inputs). No separate "document kind" for epics. The `/` menu does not take text after the command (the playbook asks what the person wants). No per-user (rather than per-manager) owner for a session an agent starts from a chat. A playbook whose steps use scripts runs as the registry allows (scripts stay off unless the pack owner enabled them).
- **Verified against real components.** Server flows against a real database with a fake runner (the facilitator's verbs and the agent's rpc are sent as the runner would); the web menu in jsdom. Not run against a real Claude Code turn: the playbook text is loaded by `aom skill show` as before, which R3a already verified; a real run of a BMAD step workflow is untested. No browser tool was available for a visual check.
- **Open questions.** (a) Should a playbook started from a chat by a granted agent be owned by the chat's user rather than the manager? (b) Should the `/` menu accept text after the command as the playbook's `input`? (c) Should an Owner be able to grant a playbook to every agent of a role at once?

**Owner decisions on the R2/R3a questions (2026-10-24), to build after R3b (as R3c)**
- Q51 Session clock: **keeps running** while waiting on the creator, in both Discovery and Boardroom. Change the Boardroom so it doesn't pause at decisions.
- Q52 Project-repo skills: **review before first use.** Unreviewed or changed skills are unusable until an Owner or Admin marks them reviewed.
- Q53 Archiving a running Boardroom: **confirm, end it (minutes written), then archive.** Enforced on the server.
- Q54 Push notification to the creator at the **5-minute warning and at time-up**.
- Q55 Model prices: **as built** (Owners only, no marker in the session meter).
- Q56 Prompt cache: stays at 5 minutes, as built.
- Q57 Authored org pack review: **reviewers read the text.** It is sealed to the reviewer's own workstation or browser for review only, so nobody approves unread content.
- Q58 Hire from a private pack: an **org role with a warning**, as built.
- Q59 Role update offer: all agents of the role move together, as built.
- Q60 **Members can hire from packs** in the HR page, within their existing hiring permissions.

**Owner decisions on the open gaps (2026-10-24), to build in R3c along with the decisions above**
- **Codex:** run it inside the runner's own harness sandbox and egress proxy, like Gemini and opencode, to get the same allow-list. Add shift resume and token-based cost where Codex reports usage.
- **Assistant help:** split the help pack by topic and load sections on demand, instead of one 16k-token pack.
- **Spending-cap accuracy:** live spend counts owner-set prices and running delegates. The private-endpoint check resolves hostnames for direct-runtime base URLs.
- **Late replies:** each dispatch gets an attempt id, so a late reply from a turn that was sent back to the queue is matched to its attempt instead of being dropped.
- **Polish:**
  - "Hire a BA" opens the full hire dialog, prefilled.
  - Persona chat gets an optional budget and time limit, plus 90-day retention.
  - Authored packs show a diff against the approved version.
- **Project packs follow sessions:** a project's packs are synced (with member opt-in) to the session creator's workstation, so they work in that project's sessions.
- **UAT deploy:** the coordinator updates the owner's WSL2 workstation runner to the branch runner and keeps the old version for rollback.

## Revision R3b as built: explicit delegation, child runs and native subagents

Details in `docs/ARCHITECTURE.md` section 38.9 and `docs/RUNNER.md` ("Delegation and child runs", "Native subagents"). Migration 2480; runner 0.1.54 (additive, server feature `delegate-grants:1`). Playbooks are in "Revision R3b as built: playbooks" above.

- **Built, per owner decision.** (1) Delegation is off by default and an explicit choice: `delegate` is in no default purpose table, an agent or a session's facilitator and Chair delegates only to the personas or hired agents someone granted, and every existing agent and session starts with no grants. (2) Each target runs on its own model (a hired agent's, a persona's); the caller cannot choose one (`--model` is refused, `model_locked` on the server). (3) Owners, Admins and the agent's manager grant for an agent (the HR rule), the session's creator for a session; each change is an event; the lists show on the agent card and in the session, and every delegation shows as a sub-step on the card's timeline and in the session with target, model, tool profile, duration, cost and a result summary. (4) A delegation is a real child run with a tool profile (`read_only|edit|shell`) from the persona's `tools` or the agent's permissions, intersected with the caller's; in the caller's worktree and sandbox context when it works, one writing child at a time; cost booked to the caller (`shift_costs` kind `delegate`), project and session budgets, provider caps with a live stop of a running child, a depth cap of 1, per-target and per-caller counts and a time limit that the grant sets. (5) Native Claude Code subagents only for granted targets, with usage read from the transcript, a fail-closed guard on the `Agent` tool and Claude Code's own subagent types denied for every agent.
- **Found while building (real Claude Code 2.1.309).** Claude Code could start its own subagent types (`general-purpose`, `Explore`) in every Guildwise Claude Code session whatever the permission mode: nothing in the allow list gated the `Agent` tool. They are now denied for every agent without a target. An `Agent(name)` allow rule does not restrict the tool; only a deny rule or the PreToolUse hook does. A subagent runs in the background unless `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, and `total_cost_usd` and `modelUsage` of the final result include subagents while `usage` does not.
- **Decided by default (open product questions).**
  1. A built-in persona whose model the workstation does not offer runs on a small model of the caller's runtime (a Gemini-only workstation could not use any built-in persona otherwise); an authored or imported persona and a hired agent run on their model or fail with a clear message.
  2. A persona has no per-call model in its grant; its model is its frontmatter's. A persona without one uses a small model of the caller's runtime.
  3. Grants are per agent, not per role; there is no "all agents of a role" grant yet. A session's grant covers its facilitator and its Chair together, not a speaker.
  4. A chat or a session turn only reads, so its children only read; an agent on a card shift that may edit and run commands gets children that do. Children never commit, push, use the web, MCP tools or a browser.
  5. A target that is a hired agent runs with its role's instructions and permissions as a child (not its project knowledge, vault or memory); it runs on the caller's workstation, so its model must be available there.
  6. A native subagent is offered only when it can honour the target's profile exactly; otherwise the target stays `aom delegate`. Native subagents have no per-call time limit.
  7. Counts: 4 calls per target per turn by default (1 to 8), 8 per caller in all, 110 s per call by default (10 to 540).
  8. The grants editor is a disclosure on the agent's card and on the session page (HR shows the same cards).
- **Not built / next.** No grant for a whole role. No budget per grant (the caller's session or project budget applies). Native subagents are not time-limited and their tool calls are not counted. The child's transcript stays on the workstation (`delegate-<id>.jsonl` in the shift logs); the server keeps a 280 character summary only. The parent could still write in the same tool-call batch as a delegate (the lock cannot see its own tools); the instructions tell it to call `aom delegate` alone. Delegation from the CEO and the DevOps engineer stays impossible.
- **Verified against real components.** Real Claude Code 2.1.309 against a fake Anthropic API (no tokens): the adapter's settings, `--agents` file, the real `aom subagent-guard` hook and IPC (`claude-subagents-real.test.ts`): the ungranted type is refused, the granted one runs on its definition with only its tools, and its usage is read from the transcript. By hand with real haiku calls: the `Agent` tool name, the hook payload, foreground mode and the usage split. Faked: the child runs of `aom delegate` (scripted adapters; the sandbox of a working child is the adapter's existing one around the same worktree and was not run for a child), the server against a fake runner.
- **Open questions.** (a) Should an Owner be able to grant a target to every agent of a role at once? (b) Should the persona's model be editable per grant (so one persona can run cheap for one agent and strong for another)? (c) Should native subagents get a time limit through the parent's shift limit only, as now? (d) Should a delegation that needs a wider profile than the parent's ask the owner (a desk item) instead of running narrower?

**Owner decisions on the R3b questions (2026-10-24), added to R3c**
- Q61: **role-level delegation grants.** They cover every agent of the role, including future hires. Per-agent grants can add targets but never remove the role's.
- Q62: **a grant may set the model** the target runs on for that caller. The caller still can't choose.
- Q63: a delegation that needs wider permissions **runs narrower**, as built, and the card notes the narrowing.
- Q64: a playbook started by an agent **belongs to the chat's user**, not the agent's manager.
- Q65: **text after a `/command`** is used as the playbook's input.

## Revision R3c as built

Details in `docs/ARCHITECTURE.md` section 38.11, `docs/RUNNER.md` ("Codex in the runner's harness sandbox (0.1.55)", "R3c on the runner (0.1.55)"). Migrations 2490 to 2493; runner 0.1.55 (additive; an older runner ignores the new fields and the server falls back). The owner decisions of the R3b questions (above) are built as Q61 to Q65.

- **Built, per owner decision.** Q51 clock runs while waiting for the creator (stage `decision`). Q52 project-repository skills and personas are unusable until reviewed (and again after a change), in the registry, materialisation, sessions and delegate targets, on the server and in the runner; pending ones are on the Project skills tab and as a desk notice. Q53 archiving a running Boardroom ends it (minutes) and then archives, enforced on the server (`409 boardroom_running` otherwise). Q54 push to the creator at the time-limit warning and at time-up. Q57 reviewers read the sealed text of an authored organization pack with a diff against the approved version. Q60 Members hire from packs within their hiring permissions. Q61 role-level delegation grants (including future hires; per-agent grants only add). Q62 a grant may set the model. Q63 runs narrower, noted on the card. Q64 a playbook an agent starts from a chat belongs to the chat's user (shifts without a chat user keep the manager). Q65 the text after `/command` is the playbook input.
- **Also built.** Codex in the harness sandbox with the egress proxy, shift resume with a rollout reader, token prices; assistant help split by topic and chosen per question within a 2200 token budget; spending-cap accuracy (Owner prices for every runtime, running delegates, DNS-resolving check of direct-model base URLs); attempt ids for late replies; "Hire a BA" opens the hire dialog prefilled; persona chat budget, time limit and 90-day retention; project packs follow sessions to the creator's workstation with the member's opt-in; a per-call time limit for native Claude subagents; the failing `model-providers` web test fixed (the signed-in user is guarded in the persona chat and hire dialogs).
- **Decided by default (small choices, revisit if wrong).**
  1. Codex roles are unchanged in harness mode. The harness adds the network (proxy) and `aom` over IPC but not a guard, a shell limit, browser sockets or path-scoped writes, so the same roles stay on Claude Code.
  2. In the harness the Codex login is hidden from the agent's commands by the runner's shell shim; the CLI itself still reads it. An API key is held by the proxy and never enters the box.
  3. A native subagent's time limit is checked at its next tool call; a single long tool call is not interrupted.
  4. Q64: the chat's user owns the session only when they are in the organization, may run the playbook and have an active workstation; the session runs on their own workstation (the agent's, if it is theirs). Otherwise the agent's manager owns it, as before.
  5. Q65: the text after the key is used only when the key is exactly one of the person's commands; a longer slash text is an ordinary message. Enter puts the instruction in the box in a chat (it does not send).
  6. A role's delegation grant is shown as inherited on each agent and cannot be removed from the agent's own list.
  7. The native Codex profile (macOS) keeps "no network"; harness and native are chosen by `runtimes.codex.sandbox` (`auto`).
  8. Attempt ids: a reply without one (an older runner) is accepted as before; a reply with an older attempt id is adopted only while that attempt could still be the live one.
- **Not built / next.** The reviewer cannot read a pack whose author's workstation is offline (the read waits for the workstation; there is no server copy by design). No harness sandbox for Codex on macOS or native Windows. Role grants have no per-role budget. Native subagent tool calls are limited in time but not counted. The assistant's topic selection is keyword-based (no embeddings), so an unusual phrasing can miss a topic; the index in the always-on prompt lets the model name the topic to ask about.
- **Verified against real components.** Real Codex 0.164.0 (opt-in `codex-harness-real.test.ts`) in the real bubblewrap box with the real egress proxy against a fake Responses API: the key is added by the proxy and is not in the box, the commands cannot read `auth.json`, a host off the allow-list is refused, resume continues the thread and the rollout reader finds the file. Real Claude Code 2.1.309 against a fake Anthropic API: the per-call time limit refuses the subagent's next tool call and lets the parent go on. Not run against real model APIs (no tokens spent): Codex pricing is a table checked against OpenAI's list on 2026-10-24, not against a bill.
- **Tests that were made deterministic.** The runner `aom-board` multi-turn test has a 180 s timeout (eleven process starts in a row); the real-subagent time-limit test gives the first read the whole limit; temp-dir cleanup retries (`maxRetries`) so a shift still wrapping up cannot fail a file; the server "drops an agent that was retired" test waits for the room and the notice to settle instead of reading one snapshot. The rebuild/isolation flake did not reproduce in isolation (`rebuild.test.ts`, `isolation.test.ts` pass alone) and nothing was changed for it.
- **Open questions.** (a) Should a role grant be able to deny a target for one agent? (b) Should the reviewer see a pack's text from a server copy when the author's workstation is offline (the server would then hold the text)? (c) Should Codex on Linux be offered for roles without a shell once the `aom`-only shell can be enforced in the box? (d) Should a Q64 playbook session fall back to the chat user's other workstations when the agent's is not theirs, or ask them?

**Owner decisions on the R3c questions (2026-10-24), to build with the final review fixes**
- Q66: **per-agent exclusion** from specific targets inherited from a role grant. Shown clearly on the agent.
- Q67: **no server copy** of pack text. The review waits for the author's workstation, and the reviewer is notified when it comes online.
- Q68: **Codex may take shell-less roles** once an `aom`-only shell is enforced in the box and proven by a test.
- Q69: when an agent-started playbook would run on a workstation that isn't the chat user's, **ask the chat user** to pick one of their workstations or decline.

## Security review fixes as built (runner 0.1.56)

Details in `docs/ARCHITECTURE.md` section 38.11 ("Security review fixes"), `docs/RUNNER.md` ("Security review fixes on the runner (0.1.56)"). Migrations 2494, 2495.

- **Built.** Findings 1, 2, 3, 5, 8, 11, 12, 13, 20 and 21 of the security review (reshare needs an approval made in the admin's browser; provider keys and pack credentials are bound to their purpose; a pack adds role versions only to its own role; Gemini and Codex logins are checked on the way back and kept out of reach of file tools where the CLI allows; stale reshare answers and replayed keys are refused by key generation; the Vertex key file is removed on every path; consent and cleanup for private-pack hires; the answer to a command is claimed atomically; an organization key is never picked for a run without an organization).
- **Compatibility.** Organization provider keys and the deploy keys or tokens of private git packs must be entered again (the old forms are refused: they carry no binding). A workstation's own provider keys keep working. A runner older than 0.1.56 is told to update for the new key and credential paths.
- **Decided by default.** (a) The reshare approval is a sealed statement of what the admin saw, not a signature: a server able to seal to a public key can still make one (an admin signing key would need a trust anchor the product does not have). (b) A Member hiring from their own private pack gets a role of its own that only they can list or hire, with the tools they may grant (read), not the persona's declared tools. (c) A private pack may not take the name of an organization pack; the reverse (an organization pack added later with the name of someone's private pack) is allowed, because refusing it would tell an admin that a private pack of that name exists. (d) The Codex file-edit tool has no per-path deny; its login is kept out of the shell and checked on the way back. (e) The Gemini policy rule (`argsPattern`) was written from the CLI's policy documentation and not run against the real binary.
- **Not built / next.** A role hijacked before this fix is not repaired by a migration (nothing says which version was foreign): an Owner can look at `role_definitions` for versions whose `source.packId` changed. The Gemini rule needs a run of the opt-in `gemini-real.test.ts` on a machine with the binary.

## Security review fixes, part two, and the R3c owner decisions as built (runner 0.1.56)

Details in `docs/ARCHITECTURE.md` section 38.11 ("Security review fixes, part two", "Owner decisions Q66 to Q69") and `docs/RUNNER.md` ("Security review fixes on the runner, part two", "Codex without a shell"). Migrations 2497 to 2500; no new runner capability (compatible).

- **Built.** Findings 4, 6, 7, 9, 10, 14, 15, 16, 17, 18 and 19; Q66 (per-agent exclusion), Q67 (the review waits for the author's workstation and the reviewer is told), Q68 (Codex takes shell-less roles in the harness sandbox, proved in the real box), Q69 (the chat person picks a workstation or declines).
- **Decided by default.** (a) A live usage report may claim at most the generous per-second token ceilings of `LIVE_TOKEN_CEILING` for the run's age; tokens above it are not counted live (the booked cost at the end is the runner's real report). (b) An organization key whose runner reports no organizations is no organization key (an older runner stops being counted for the cap; the organization key then is not used for that run). (c) `aom-only` on Codex is enforced for roles without a shell AND every chat; the server lets such a role onto Codex because it cannot see whether the workstation runs Codex in the harness (Linux, WSL2) or in its own macOS profile; the runner decides at session start (`runtimeRoleProblem(..., { harness })`). (d) A declined or unanswered Q69 request is not retried by itself; the agent may ask again (counted). (e) Multi-line `aom` arguments are refused in the Codex aom-only shell (use `--note-file`).
- **Not built / next.** The agent's `aom playbook run` after a decline gets no later message; the chat is told. The Codex native profile (macOS) still refuses shell-less roles. The reviewer's wait note is a desk item only (no push).
- **Open questions.** (a) Should a declined Q69 request make the agent stop asking for that playbook in that chat? (b) Should the Q67 desk note also be pushed to the reviewer's phone?

**Owner decisions on the security-fix questions (2026-10-24)**
- Q70: no admin signing key is needed. The current approval protection is accepted.
- Q71: an org pack may use the same name as a private pack. Private keys stay namespaced by pack id, as built.
- Q72: a one-off data migration **flags suspicious roles**: any role whose versions came from different packs, or from a private pack. Each gets a desk notice for an Owner to review, and nothing is changed automatically.
- Q73: a workstation's own provider key gets a **generation and revocation floor**, like org keys.

**Owner decisions Q72 and Q73 as built**
- Q72: data migration `suspicious-roles-2026-10` flags every role with versions from more than one pack, or from a private pack, with one desk notice (`suspicious_role`) per role for an Owner; it changes nothing else and is idempotent (`apps/server/src/data-migrations/suspicious-roles.ts`).
- Q73: a workstation's own provider key has a generation (the browser sends seconds since the epoch; it is bound into the `h2` associated data and relayed as `generation`) and a revocation floor on the runner (`providers-org-floor.json`, slot `~workstation`): removing or replacing a key raises the floor, and a replay of an older or removed generation is refused, across restarts. A key with no generation (sealed by an older web app, or the older `h1` form) is still accepted, with the existing warning for `h1`, until a versioned key is stored (no downgrade).

## Small follow-ups as built

- **Q69, a declined playbook is not asked again in that chat.** After the chat person declines an agent's `aom playbook run <key>` request (`PlaybookRunDecided` declined), further requests for the same key from the same agent in the same chat thread are refused with a clear message (`startForAgent`, `apps/server/src/sessions/playbooks.ts`). It reads the `playbook_run_requests` row (status `declined`, same agent, key and `chat_thread_id`), a projection of the events, so it is replay-safe. Another playbook or a new chat can ask again.
- **Q67, the reviewer's phone hears of "the author's workstation is online" too.** `notifyReviewersOfWorkstation` (`apps/server/src/commands/pack-review-wait.ts`) sends a push through `notifyUsers` (the channel of the Q54 time-up pushes) after the desk item, in the `desk_blocking` category, normal priority, linking to the desk item; the body holds no pack text. A failed push is logged and does not undo the desk item.
- **Codex native macOS profile keeps the git paths read-only.** `codexFilesystem` (`apps/runner/src/adapters/codex.ts`) marks `protectedGitPaths(cwd)` as `read` (the worktree's `.git` file and the admin dir's `commondir`, `gitdir`, `config`, `config.worktree`, `hooks`), the same set as the harness box and `claude-policy.ts`, even though the admin dir itself stays writable for committing. A deny is never downgraded.

## Fix pass as built (2026-10-24)

Five owner-driven fixes on `feat/discovery-boardroom`, found while testing the UAT stack over plain http on a LAN address.

**1. No raw `crypto.randomUUID` in the browser.** Every browser call now uses `newId()` (`apps/web/src/lib/secure.ts`), including the mock handlers that run in the demo build. `apps/web/src/test/no-raw-randomuuid.test.ts` reads every non-test source file of `apps/web/src` and `packages/shared/src` and fails on a raw `crypto.randomUUID`, so it cannot come back.

**2. `AOM_EXTRA_ORIGINS`.** Optional comma-separated exact origins (`scheme://host[:port]`, normalised through `URL.origin`; a `*`, a path, credentials or another scheme stops the boot with a message naming the variable). `originAllowed` (`apps/server/src/auth/origin-check.ts`) is the one comparison used by the CSRF check and the WebSocket upgrade check. Cookie `Secure`, invitation links and the CSP stay tied to `AOM_PUBLIC_ORIGIN`. Documented in `docs/DEPLOY.md` with the UAT/LAN note.

**3. Sealing needs a secure context.** `packages/shared/src/secure-context.ts` has `SECURE_CONTEXT_MESSAGE` ("Encrypting secrets needs HTTPS or localhost — open this page over https"), `SecureContextError` and `requireSubtle()`; `sealLarge`, `makeReplyKey`, `sealForRunner` (integrations), `spkiSha256`/`sealResealApproval` (provider keys, reseal approval), `encryptForRunner` and, through `sealLarge`, the pack credential, delivery connect and authored-pack save all throw it instead of "Cannot read properties of undefined". In the UI `SecureContextNotice` shows it inline and the submit is disabled when `window.isSecureContext === false` in: workstation provider keys, organization key set/share-again/re-share, private pack credentials (add and holders), sudo password, environment and test-target secrets, integrations connect and sign-in session, delivery server connect (password and key file; the panel method seals nothing), editing/exporting/saving an authored pack, and the pack-review read (the reviewer sees the same message and the pack stays unreadable, so it cannot be approved unread). The landing assistant's proof of work does not need WebCrypto: without `crypto.subtle` it hashes with a plain JavaScript SHA-256 (`sha256Js`, checked against WebCrypto in a test). The server still demands the proof after five messages, unchanged, so the protection is kept.

**4. The round cap is optional and off by default.** `roundCap` is `null` unless given (1 to 50). A session made with a cap keeps it (its config stores the number); `PATCH` can set a cap or remove it with `null`; saved rooms carry `null` (migration 2501 drops `NOT NULL` on `board_rooms.round_cap`; `BoardRoomSaved.roundCap` is nullable, old events replay). Without a cap a session ends on the owner's End, the time limit (warning, final round, minutes) or the budget stop. The Chair is told there is no cap and, when the last two rounds added no whiteboard note and no recorded disagreement (`quietRounds`, computed by the server), is told to propose ending with `aom board pause --question "End here?" --option "End and write the minutes" --option "Keep going"`. Picking the first option goes straight to the minutes (`endReason: owner`); the second resumes the Chair. The new dialog has a "Round cap" number field, empty meaning no cap.

**5. Packs are read generically; no product is special.** The `bmad` adapter, its text shim, its tag mappings and the "Add BMAD Method" preset are removed (`PACK_PRESETS` is gone). A pack is read by convention: `SKILL.md` folders are skills; `personas/*.md`, `.claude/agents/*.md`, the files an optional `pack.yaml`/`pack.json` lists under `agents:` and a skill whose frontmatter says `metadata.kind: agent` (or `type: agent`) are personas; `playbooks/<key>/workflow.md` folders and the ones the manifest lists under `playbooks:` are playbooks. Manifest `tags` (`discovery`, `template:brief`, `template:prd`) are labels the pickers read and are part of the capability hash. Anything that does not fit is a plain skill, so a repository laid out for another tool (the BMad layout is kept as a test fixture) imports without errors. Attribution is generic: the snapshot carries the LICENSE copyright line and the pack card shows it with the licence. Compatibility: `adapter: bmad` and `preset: bmad` still parse in stored events, `packs.sync` and runner reports and mean `auto`; nothing produces them. Packs that were indexed by the old adapter are re-read generically on their next fetch; their capabilities and hashes change (a `bmad:analyst` persona becomes the skill `bmad:bmad-agent-analyst`), so they show as changed and must be approved again; their events replay unchanged. Tests use a neutral sample pack (`packages/shared/test/fixtures/sample-pack-fixture.ts`).

## Next streams (owner go-ahead 2026-10-24; open questions use defaults and are recorded here)

### S-A: AI runtime setup and multiple accounts per provider
- Integrations > **AI runtime** gets a tile per runtime: Claude Code (incl. Bedrock, Vertex and gateway), Codex, Gemini CLI, opencode, and the direct API providers (Anthropic, OpenAI, Gemini, OpenAI-compatible).
- Each tile shows:
  - whether the program is installed, with install hints;
  - the login state, with "Sign in", which runs the CLI's own login on the workstation;
  - API-key entry;
  - "runner too old" where it applies;
  - which key is in effect (workstation or org), with a link to Settings > Model providers.
- Settings > **Model providers** (org keys and caps) stays.
- **Accounts work like Claude accounts:**
  - Per workstation and provider, a **main account** plus **named accounts**.
  - A project chooses an account per provider, with **fall back to main**.
  - Usage-limit and login-expired notices are per (workstation, account).
  - Org-level work (CEO, DevOps, chats) uses main.
  - An org key counts as one more account a project may choose, and its cap still applies.

### S-A as built (runner 0.1.58, migration 2510)

Details in `docs/ARCHITECTURE.md` section 38.12, `docs/RUNNER.md` ("Accounts for Codex, the Gemini CLI and provider keys"), `docs/USER-GUIDE.md` 4.24b and the help article "AI runtimes and accounts". The Claude accounts (`docs/design/claude-accounts.md`) are the pattern and keep their events, columns and runner machinery unchanged.

- **Built.**
  1. *Generic accounts.* A main account plus named accounts per workstation for the login scopes `codex` and `gemini` (each account a folder of its own, copied per agent and handed back after the Claude-style checks, locked, with login and usage state per account, persisted) and for the key scopes `anthropic`, `openai`, `google`, `openai-compatible`, `bedrock`, `vertex`, `gateway` (named slots in the sealed provider-key store; the account name is part of the `h2` associated data). Runner capability `provider-accounts:1`. `provider.account.promote` ("Make main") swaps a named account and main.
  2. *Project choice.* `ProjectProviderAccountSet` (one choice per project and scope; migration 2510 `project_provider_accounts`, a projection table in the rebuild list); Claude Code keeps `ProjectClaudeAccountSet`. The dispatcher, the question and BA passes and the cloud wake resolve the account per shift from the agent's runtime and model; usage limit, expired or missing login and a missing key pause the ticket or fall back to main as the project says; org-level work, DevOps, the CEO and chats use main. The organization's key is an account (`org`) and its monthly cap still applies. Notices per (workstation, account): `provider_account_login` and `provider_account_usage`.
  3. *Integrations > AI runtime.* A tile per runtime and provider (installed or not with the install command, sign-in state, key and whose key, runner too old), account rows with Sign in (the CLI's own login run on the workstation through the integrations flow: new kinds `codex` and `gemini`), Set key (sealed in the browser, secure-context guarded), Add a named account, Remove, Make main, and a link to Settings > Model providers (which stays).
  4. *Project settings.* "Accounts for other providers" next to the Claude account panel; the banner and the desk link know the other runtimes.
- **Verified.** Fake CLIs and fake runners throughout (runner: account homes, login copy and hand-back per account, auth failure and usage limit per account, key slots with account names and their associated data, Make main, sign-in flows with scripted terminals; server: setting, events, rebuild, gating, fallback, notices, the organization key and its cap, keys and Make main commands, tiles; web: tiles, dialogs, secure-context guard, project panel). **Not verified against the real programs:** the screens of `codex login --device-auth` and of the Gemini CLI's `NO_BROWSER` login (the parsers follow their documented behaviour and judge success by the login files); Codex and Gemini accounts on a real machine; opencode with a named account beyond the key store.
- **Decided by default** (the owner was asleep; each is the safest sensible choice and can be revisited):
  1. *One scope per shift.* The scope comes from the agent's runtime and model. Chats, session turns and delegates on the direct-model runtime use main; there is no per-project key for them.
  2. *Which runtimes have accounts.* Codex and the Gemini CLI have login accounts; opencode has none of its own (its project choice is the key account of the provider its model names); the Gemini CLI on a key uses the `google` key accounts, and Codex with `authMode: api_key` has no accounts.
  3. *Names.* `main` and `org` are reserved; at most 20 named key accounts per workstation. A name is the same on every workstation (as for Claude).
  4. *No automatic provisioning.* Unlike Claude's `claude.account.ensure`, nothing is queued when a project names an account: accounts are made on the Integrations page (a sign-in creates the folder; Set key creates the slot). No shell aliases and no `aom-runner accounts` commands for the other scopes; the terminal command is shown instead. A project that names an account a workstation lacks pauses (or falls back) and the desk notice says to add it.
  5. *Folders.* The runner creates `~/.codex-gw-<key>` and `~/.gemini-gw-<key>` itself, with the marker, and never adopts a folder it did not create. Removing a named account deletes the stored login only in a folder with the marker; the main login is never removed from the web.
  6. *Usage limits clear by time.* A limited Codex or Gemini account is tried again when its reset time has passed; there is no probe request (it would cost tokens). A limit that is still there is hit again and extends the pause.
  7. *Named key accounts are the workstation's own key:* never capped, not shared. Only `org` counts against the organization's cap. When the cap is reached, `org` (and `main` where main is the organization's key) is unusable; a named account and the workstation's own key go on; fallback to main does not help when main is the organization's key too.
  8. *`org` needs a runner that reports accounts.* A runner older than 0.1.58 would spend its own key instead, so the server never sends it `org` or a named account.
  9. *Make main is a swap* (undoable), re-sealing both keys under their new names with a new generation, or swapping the login folders in `config.json` (Gemini: converting between the `.gemini` folder form of the main login and the home form of an account). It is not offered for Claude Code, whose main account is the machine login or token.
  10. *Same authority as the Claude setting:* the project's Owner and organization Owners and Admins; Make main, keys and sign-ins: the workstation's owner.
  11. *Notices.* The main account of Codex or the Gemini CLI raises a sign-in notice only where the workstation has agents on that runtime; usage-limit notices are information and, like the sign-in ones, are not relayed to the CEO. The banner names the runtime (`ProjectDto.usageLimit.scope`).
  12. *The program must exist at the runner's start* (as before): a tile for a program that is not installed shows the install command and "restart the runner afterwards".
  13. *Rejections reuse `shift.rejected.accountKey`;* `shift.start.account` carries the account of any scope. No new protocol field.
  14. *The demo build* has no mock for the new routes (the tiles show their error line there).
- **Not built / next.** An `aom-runner accounts` CLI for Codex, Gemini and keys; an event log of account changes beyond the project setting; per-agent account overrides; sharing a named key account across workstations (the organization key is the way); a probe to clear a limit early; a run of the sign-in flows against the real binaries.
- **Open questions.** (a) Should a named key account be sharable to other workstations the way the organization key is? (b) Should Claude's main account be swappable too? (c) Should a project's account choice also apply to chats about that project's cards?

### S-B1: Governance (Zenzap ideas 1, 2, 7)
1. **Approve and answer from the notification.**
   - Desk push notifications carry actions (Approve, Reject, quick options) and a signed one-tap link that opens a minimal mobile confirm page.
   - Tokens are short-lived and single-use, and they are bound to the user, the item and the option.
2. **Per-agent "What it may do" screen.**
   - One view per agent: tools, repos, data, provider and account, delegation grants, playbook and skill grants, spend.
   - Approval gates per side-effecting action (merge or push, deploy, outbound mail, pack scripts, delegation). A gated action routes to the Desk.
   - Packs declare the scopes they need.
7. **Audit export and offboarding.**
   - Org admins export the org audit log as CSV or JSON.
   - Removing a member runs an offboarding checklist: revoke sessions, API tokens, pack credentials and assignments, workstation pairings and provider keys owned by them. It reports what was done.

### S-B2: Agent UX (Zenzap ideas 3–6)
3. **@agent in card comments.** Mentioning a hired agent in a card thread hands it a small task as a delegated child run, with cost booked to the card. It needs a delegation grant from the commenter's authority; Owners and Admins may mention any agent.
4. **Describe-an-agent quick hire.** One sentence produces a drafted role (instructions, permissions, model) for review before hiring.
5. **Starter gallery.** Curated built-in personas and playbooks with one-line outcomes, shown on first run and under Capabilities.
6. **Follow-up and chase.** Desk and digest items still open after N days (default 3) nudge the owner, or are re-queued to the agent.

### S-B2 as built (agent UX, 2026-10-25)

Branch `feat/agent-ux`; migration 2530; **no runner change** and `RUNNER_VERSION` is untouched. The architecture is in `docs/ARCHITECTURE.md` section 38.13; this is what was built against the four items above.

- **3. @agent in card comments.** Type **@** in a card's comment box: an autocomplete lists the agents you may mention (`GET /api/cards/:id/mentionable`). The mention runs the agent as a small **read-only chat turn about the card** on its own workstation; the answer is posted as a reply comment in the thread. Cost is a `chat` shift on the card, so the card spend, the project budget and the provider cap include it; a paused project, an exhausted budget, a capped provider, an offline workstation and an agent already answering on the card each refuse the mention (with a `system` comment saying why). Who may: Owners and Admins any agent allowed on the project; project members only agents whose manager enabled **Project members may mention this agent** (per-agent policy, off by default). Limits per hour: 5 per user and card, 20 per user, 12 per card, 3 agents per comment.
- **4. Describe-an-agent quick hire.** **Agents > Describe the agent you need**: one sentence goes to the built-in **Analyst** as a persona-chat turn (durable session turn, budget USD 1), which returns a JSON draft: name, purpose, instructions, tools, model (haiku, sonnet or opus), skills and playbooks from the hirer's registry. The server parses and **clamps** it to the hirer's authority (Owner and Admin: read, edit, shell, web; others: read only, with a note of what was withheld); the review step lets the person edit everything and re-clamps after each change of the tools; **Continue to hire** opens the normal hire dialog with the draft as a new `chatOnly` role. `POST /api/agents/hire-from-draft` registers the role and calls the unchanged `hireAgent`. Never auto-hires.
- **5. Starter gallery.** `STARTER_GALLERY`: playbooks *Product brief*, *Brainstorm*, *Release notes*, *Weekly status*, *Pull request triage*, *Incident follow-up*; personas *Analyst*, *Devil's advocate*, *Security reviewer*, *Operations*, *Cost hawk*. Four playbooks are new (original text, `packages/capabilities/playbooks/`, `builtin-data.ts` regenerated). Shown at the top of Agents while the organization is on a first run (no hired agent apart from the built-ins and no session yet) and as **Settings > Capabilities > Starter gallery**. **Run it** starts a guided session; **Hire it** goes through the same review and hire dialogs as item 4.
- **6. Follow-up and chase.** An open question, approval, escalation or digest rating older than the organization's window (**Settings > General > Reminders for open items**, default 3 days, 0 = off) nudges its owner once per window (push category **Reminders for open items**, plus a "Reminded" mark on the item); an agent-owned item is handed back to the agent once. Per-item **Snooze** (1 day to 2 weeks). Sweep-driven (scheduler pass), the state is projected from `DeskItemNudged` / `DeskItemSnoozed`, so a repeated sweep or a rebuild never nudges twice.

#### Decided by default (S-B2)

The owner was away; these are the safest sensible choices and are easy to change.

1. **A mention is read-only, always.** The spec allowed edit or shell "if the mentioning user may grant it and the agent's role allows". A mention runs as a chat turn (the parent profile of a chat is read only), with no delegation grant, so it never edits, runs commands or commits, whatever the agent's role allows. Reason: the commenter's authority over a card's worktree is not a grant of write access, and a write path would need the delegate lock, the parent-worktree sharing and a per-mention approval. Gap: "mention an agent to do the work" is a card or a Desk decision, not a comment.
2. **Who may mention.** Owners and Admins: any active agent allowed on the project (not DevOps, not the CEO). Everyone else on the project (the card's owner included): only agents with **Project members may mention this agent** switched on by the agent's manager, an Owner or an Admin. The "grant" of the spec is this per-agent switch rather than a per-person grant, because it is one setting to audit and it follows the agent's own manager.
3. **Mentions are a chat shift, not a `delegate` child run.** Delegation needs a running parent shift; a comment has none. The chat path already gives card-level cost booking, budgets, caps and the card's read context, and needs no new runner message.
4. **Limits.** 5 mentions per user and card and 20 per user per hour, 12 per card per hour, 3 agents per comment, one answer at a time per card. Counted from accepted mentions (a refused mention costs nothing and is not counted).
5. **Handles.** `@` plus the slug of the agent's name (`Una` is `@una`; `Max Power` is `@max-power`). A handle that matches no agent is ignored (it may be a person). An agent's own reply is never scanned, so agents cannot trigger each other.
6. **Describe-an-agent runs on the hirer's own workstation** with the Analyst's model (a persona chat), so it needs a paired workstation with a runner that announces `session-turns:1`; the cost is booked to the organization like a persona chat. If the reply holds no usable draft the dialog says so and offers another try. The drafted role is a **new** `draft-<name>-<4>` role per hire (a second hire of a similar agent makes a second role); roles of an abandoned hire are not cleaned up.
7. **Drafted and starter roles are `chatOnly`.** They claim no workflow stage and take no card from the board; they work in chats, sessions and mentions. Making a board-working role stays the Org designer's job.
8. **Starter personas are hired as agents of the organization** (a role made from the persona text, tools and model), not as pack personas. A suggested playbook is granted to the new agent only if the hirer can run it themselves.
9. **First run** means: no active agent apart from the built-ins (DevOps, the CEO) and no Discovery, Boardroom or persona-chat session in the organization. The gallery stops being shown at the top of Agents as soon as either happens; it stays under Capabilities.
10. **Chase scope.** Questions, approvals, escalations and digest ratings (`rating`/`digest`). Alerts and reports (floor report, BA report, CEO notice and decision) are not chased. The window is measured from the item's last update (`updated_at`). Recipients of a nudge: the addressee, else the card's owner, else the project's owners, else the Owners and Admins. A paused project's agent-owned items are not re-queued until it resumes. Anyone who may act on an item may snooze it (1 to 14 days); a snooze holds nudges back and does not move the window.
11. **Quiet hours** apply to reminders (they are not `blocking`), and the person can switch the category off; the nudge is still recorded and shows in the app.
12. **Demo build.** The mock handlers of the demo build do not cover the new endpoints (the new panels show their empty or error state there).

### Coordination
- Migration number ranges: S-A 2510–2519, S-B1 2520–2529, S-B2 2530–2539.
- Only S-A bumps `RUNNER_VERSION` (0.1.58). If B1 or B2 need runner changes, they say so and the coordinator bumps it at merge.

## S-B1 as built (2026-10-25, branch `feat/governance`)

Technical detail is in `docs/ARCHITECTURE.md` section 39. Migrations 2520 (gates, gated actions, notification links) and 2521 (offboarding purges). **No runner change; `RUNNER_VERSION` is untouched.**

**1. Approve and answer from the notification.**
- A desk push carries up to two buttons: Approve and Reject for an approval; the recommended option, then the next, for a question with options. The notification's own tap still opens the Desk, which is the way to the other options.
- Each button is its own link `/m/desk/<token>`: an HMAC-signed id whose row binds it to one user, one item, one action, 15 minutes and one use. The service worker opens it; the page asks the person to sign in (`/login?next=`), shows the item and waits. `GET` previews, `POST /apply` applies through the normal `resolveDeskItem`/`answerDeskItem`.
- Wrong person: 403 and the token stays unspent. Reused: 409. Expired: 410. Each outcome, applied or refused, is the audit event `DeskNotificationActionTaken`.
- No buttons for items that need input of their own (manual QA, the code approval step, the playbook workstation choice, CEO decisions, approvals with options).

**2. What it may do.**
- `GET /api/agents/:id/may-do` and **What it may do** on the agent card show tools, repositories, data scopes, provider and the key that pays, delegation grants (role-inherited and excluded marked), playbook, skill and pack grants with their scopes, spend and budgets, and the gates.
- Gates are opt-in per agent and class: `merge_push` (the existing merge approval desk item, for a merge, a pull request or a pushed branch of a card the agent built), `deploy` (the DevOps engineer's `aom deploy run`), `delegation`, `playbook_run`. The gated RPC answers `approval_required`, raises one desk item and, after the approval, lets the agent's next identical call through once. `outbound_mail` is shown as always on (every outbound draft already needs the manager); `pack_scripts` is shown as not available.
- Scopes: manifest `scopes:`, `metadata.scopes`, persona and playbook frontmatter `scopes:`; shown in the `/` menu, the pack item and the may-do screen; a grant that needs a scope the agent lacks is refused with 409 `scopes_missing` until the request says `confirmScopes: true` (UI: "Grant anyway").

**3. Audit export and offboarding.**
- `GET /api/org/audit/export` streams CSV or JSON (range up to 366 days, actor and type filters, secrets redacted) for Owners and Admins, and is itself audited.
- Removing a member runs the checklist and returns a report (steps in the removal dialog before, report after). Details in the architecture section.

**Tests.** Server: `desk-notification-actions` (14), `agent-gates` (15), `audit-export` (10), `org-offboarding` (6). Shared: `governance` (7). Web: `desk-action-confirm` (9), `may-do` (4), `offboarding-audit` (3), `service-worker` (+3).

### Decided by default (the owner was asleep; change any of these)
- **Buttons.** Two at most (what push services show). The rest is one tap away on the Desk.
- **Link lifetime and use.** 15 minutes, once, signed in as the person it was made for. No separate re-authentication: a signed-in session (which already needs the password and two-factor login) is the proof. Code approvals never get buttons, because the rule there is that you approve the diff you are shown.
- **Who may gate.** Whoever manages the agent switches a gate on; only an Owner or Admin switches it off. The CEO is excluded (it keeps its policy). No agent has a gate until someone sets one.
- **A gate pauses by refusing and raising a desk item.** The agent is told to retry the same command; an approval is single-use and valid for two hours; a rejection is reported for an hour without a new item. A running shift is not woken after the approval.
- **Gated landing is the existing merge approval.** It applies to cards whose original builder or last agent is gated, to merge, pull request and push-branch alike, and ignores the project's "merge large without approval" waiver. The lean-team owner approval step, which comes first, already covers it.
- **Who approves a gate.** Org-level items (delegation, playbook, deploy) go to the Owner and Admins; with a card, the card's owner.
- **What counts as audit.** Actions with a user actor in the organization plus a few governance events the system writes. Message bodies, drafts, read marks and similar content are left out. Payloads are redacted by key name and by secret patterns, keeping ids and e-mail addresses.
- **Export size.** At most 366 days per export, streamed in batches.
- **Offboarding scope.** Sign-out, pairing codes, notification devices and workstation unlinking happen only when it was the person's last organization (their other organizations stay untouched, the existing rule). Everything of this organization is always removed or moved.
- **Offboarding ownership.** Sessions and organization packs they owned go to the person who removed them (the Owner if they left or were deactivated). Private chats and private packs are deleted after **30 days** (cancelled if the person rejoins first). Packs authored on their workstation stay held there and are flagged.
- **Key copies.** The organization's key is cleared from their workstations; when a copy was stored, the report advises rotating the key (a machine that is unlinked never gets the command).
- **Scopes.** A small known vocabulary; an unknown scope is displayed and never blocks. A scope added by the manifest changes the item hash (review again); one in the files already does.
- **API tokens.** The product has no per-user API tokens; runner tokens end with the workstation.

### Gaps
- **Pack scripts gate** is listed but not enforced: scripts run on the workstation and the server has no choke point (it would need the runner to ask before running a script). Scripts stay off until an Owner enables them per pack.
- **Pack scopes from released runners.** A runner built before this reports no scopes, so no warning appears for packs it indexed until it is rebuilt with this shared code (no protocol change; the coordinator decides whether to bump `RUNNER_VERSION`).
- **The agent is not woken** when a gate is approved; it retries when it next acts. A chat or card shift that has ended picks the work up on its next turn.
- **Deactivation by the platform** does not deliver the queued key-clear commands at once (they go out when the workstation next connects).
