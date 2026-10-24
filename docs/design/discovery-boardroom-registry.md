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

- **BMAD, verified against the live repository** (network, 2026-10-23, github.com/bmad-code-org/BMAD-METHOD, MIT). The latest stable tag is **v6.12.4** (the preset): skills live in `src/core-skills/<skill>` and `src/bmm-skills/{agents,plan,ship,v6-shims}/<skill>` with `SKILL.md`, `customize.toml` and `src/bmm-skills/module.yaml` (agent roster). The default branch (v7 line) has a top-level `skills/<skill>/` with `SKILL.md`, `customize.toml`, `bmod.toml`, `assets/`, `references/`, `scripts/`; the `workflow.md` + `steps/` style is only inside some skills. Both index with 0 issues (25 to 33 capabilities); the importer finds `SKILL.md` folders anywhere, so it supports both without a layout switch. The tests use an original fixture in both layouts (`packages/shared/test/fixtures/bmad-fixture.ts`), no BMAD files are vendored and nothing depends on the network.
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
