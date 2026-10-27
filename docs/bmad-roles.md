# BMAD role set

An organization can run its built-in roles as **BMAD Method** agents: the analyst, BA, planner, architect and builder take
the persona and working method of the matching BMAD agent, and those roles and the reviewers, researcher and writer get the
BMAD skills that fit their job. It is a switch on **Roles & workflows > Role set**, approved on the desk, and it can be
switched back at any time.

BMAD is the [BMAD Method](https://github.com/bmad-code-org/BMAD-METHOD) (MIT, Copyright (c) 2025 BMad Code, LLC; licence in
`packages/shared/src/roles/role-sets/BMAD-LICENSE`). BMad, BMad Method and BMAD are trademarks of BMad Code, LLC; Guildwise HQ
is not affiliated with or endorsed by BMad Code, LLC.

## What changes and what does not

A role of the set is its built-in role plus two things:

- a **persona** (`RoleDefinition.persona`): the BMAD agent's focus, approach, communication style and principles, selected
  sections of its method, and the rules that adapt BMAD's skills to Guildwise (below). Agents get it after the role
  instructions in every shift, and as "# Your role" in chats (runner 0.1.61);
- its **skills**: BMAD skills under their pack key (`bmad-method:bmad-prd`), loaded with `aom skill show <key>`.

Everything else is the built-in role's: key, name, instructions, core rules, seniority, model, permissions and the stages it
claims. `roleSetIssues` (`packages/shared/src/roles/role-sets/bmad.ts`) compares each version of the set with the built-in
version it was made from, and the server refuses to register or approve one that differs in anything but the persona and the
skills. Test ownership, the review gates, read-only roles, sandboxing, the approval gates, the ledger and the desk work as
before; a BMAD skill never widens what an agent may change, run or commit.

## The mapping

One file decides it: `packages/shared/src/roles/role-sets/bmad.ts` (`BMAD_ROLE_MAPPING`).

| Role | BMAD agent (persona) | Method sections added | Skills granted |
|---|---|---|---|
| `analyst` | `bmad-agent-analyst` | | `bmad-deep-recon`, `bmad-brainstorming`, `bmad-product-brief`, `bmad-prfaq`, `bmad-forge-idea`, `bmad-advanced-elicitation` |
| `ba` | `bmad-agent-po` (product owner) | Spec Law, Load-bearing, Self-validate | `bmad-prd`, `bmad-advanced-elicitation` |
| `planner` | `bmad-agent-pm` | What makes a good story, Checks for a set of tickets (from `bmad-agent-po`) | `bmad-prd` |
| `architect` | `bmad-agent-architect` | | `bmad-architecture`, `bmad-project-context` |
| `builder` | `bmad-agent-dev` | | `bmad-project-context` |
| `pre_reviewer` | | | `bmad-review` |
| `reviewer` | | | `bmad-review` |
| `researcher` | | | `bmad-deep-recon` |
| `writer` | | | `bmad-project-context` |
| `ux_designer` (new, custom) | `bmad-agent-ux-designer` | | `bmad-ux` |
| `ceo`, `devops`, `curator`, `scout`, `checker`, boardroom `chair` | unchanged | | unchanged |
| `tester` | unchanged | | none (see below) |

**Not granted** (`BMAD_NOT_GRANTED`):
- The template-based skills: `bmad-agent-po`, `bmad-build`, `bmad-code-review`, `bmad-walkthrough`,
  `bmad-qa-generate-e2e-tests` and `bmad-retrospective`. Their `SKILL.md` only says "run `render_skill.py` and follow its
  output", and with pack scripts off and no `_bmad/` folder an agent cannot do that. Their method is in the personas instead.
  `bmad-build` would also replace the builder's own flow (worktree, build and test evidence, handoff), so the builder gets
  Amelia's principles instead. The tester has no plain BMAD skill, so it is unchanged.
- `bmad-build-auto` (an unattended loop of its own) and `bmad-party-mode` (an interactive group chat).
- `bmad`, `bmad-customize`, `bmad-toolsmith` and `bmad-eval`, which set up or edit a BMAD install.
- The `bmod-*` folders, which are module metadata, not skills.

## How BMAD's activation is adapted

BMAD's agents and most of its skills start by running `uv run {project-root}/_bmad/scripts/resolve_customization.py`, read
`customize.toml` and `core.*` config (`core.output_folder`, `core.active_initiative`), greet with an icon and show a numbered
menu, then wait for input. None of that works in Guildwise: pack scripts are off, the repositories have no `_bmad/` folder,
card work is not interactive, and chats are plain (no roleplay). `BMAD_ADAPTER` (in every persona) tells the agent:

| BMAD | In Guildwise |
|---|---|
| `uv run …`, `npx …`, anything under `_bmad/` | never run; skipped |
| `customize.toml` and `core.*` settings | the skill's own defaults, read with `aom skill show <key> --file customize.toml` |
| `_bmad-output/<initiative>/…` output folder | on a card: the files the role may write and its outcome command; in a session: the session's `aom` commands; in a chat: the reply |
| numbered menu, waiting for input mid-skill | never; the skill's headless mode where it has one; on a card guesses become `Assumption:` lines and gaps `Open question:` lines in the handoff, and `aom question` only when the answer changes the work |
| the memlog (`.memlog.md`, `memlog.py`) | the ledger (`aom ledger search`); decisions are recorded the way the role records them |
| icon prefix, greeting, persona name (Mary), "stay in character" | none: the agent keeps the name it was hired with and answers plainly |
| ticket, story, epic, initiative, "the user" | card, card, card group or phase, project or phase, the manager or owner |

The persona text itself is generated without BMAD's machinery: sentences that name its scripts, config, memlog or ticket
files are left out, and the Jinja of the templates (`{{ workflow.… }}`, `{% if %}`) is rendered from the skill's
`customize.toml` defaults (see the generator).

## Switching

1. Import the BMAD Method as an **organization** pack (Capabilities > Packs) and approve it. The server finds it by its
   `bmad-agent-analyst` skill, so any pack name works; the skills are granted under that name.
2. On **Roles & workflows**, under **Role set**, choose **BMAD Method** and **Switch**. One approval, "Approve the BMAD role
   set (n roles)", lands on the Owner's desk, listing each role's new version and skills. Nothing changes until it is approved.
3. When it is approved, every agent on those roles moves to the new version, as with any new version of a role. Its
   permissions and skills become the new version's plus the agent's own changes (an agent's own extra skill stays, a role
   skill it had removed stays removed), and the role's Extend additions still apply.

**Switching back**: choose **Guildwise** and **Switch back**. The set's versions of the built-in roles are superseded (kept
for history) and every agent moves back to the built-in version, with its permissions and skills re-derived the same way.
The `ux_designer` role stays: retire its agents first if you no longer want it. A rejected switch leaves the organization on
the stock roles.

`GET /api/org/role-set` shows the set, its pack, the waiting desk item and the set's live versions; `PUT /api/org/role-set`
with `{ "roleSet": "bmad" | "guildwise" }` switches it (Owner and Admins).

## The UX designer

`ux_designer` designs the user experience of a card that changes a user interface, before the architect designs it and the
builder builds it. It writes a UX specification in `docs/ux/<REF>-<slug>.md` on the card branch. It may write only
documentation, and never product code or tests. It claims the `ux*` steps of `code`.

To place it in a project's delivery workflow, open the project's workflow, **Insert step after Planning**, choose the
template **UX design (UX designer, cards that need design)**, and submit the variant for approval. The step
(`uxDesignInsertion`) runs only for cards marked as needing design (`designNeeded`), the same flag that switches the
architect's Investigate & design step on. Placement:

- **After planning**, so it works on a card whose scope and acceptance criteria are settled.
- **Before Investigate & design and Build**, so the architect designs to the UX specification, and the builder builds to both.
- Cards that need no design skip it.

Supporting it, inserted steps of a project variant can now carry a `when` (agent steps only).

## Updating to a new BMAD commit

The persona and method text is generated from a BMAD checkout into
`packages/shared/src/roles/role-sets/bmad.generated.ts`. It records the repository and commit it came from, and each persona
names its source file.

```sh
git clone https://github.com/<you>/BMAD-METHOD.git /tmp/bmad && git -C /tmp/bmad checkout <commit>
node scripts/bmad-roles/generate.mjs /tmp/bmad --repo https://github.com/<you>/BMAD-METHOD
node scripts/bmad-roles/generate.mjs /tmp/bmad --repo https://github.com/<you>/BMAD-METHOD --check   # verifies it is current
cd packages/shared && npx vitest run test/bmad-role-set.test.ts
```

Read the diff of `bmad.generated.ts`. The generator fails when a section it reads (`METHODS` in the script) is missing.
Its `dropped` counts show how many sentences were left out for naming BMAD machinery. When BMAD renames an agent or a
skill, update `BMAD_ROLE_MAPPING`.

After the new build is deployed, every organization on the BMAD set gets the roles that changed as a new desk approval at
the server's start (`syncRoleSets`). A new built-in role version shipped by Guildwise is offered the same way. A version the
Owner rejected is not offered again.

## Risks and limits

- **Upstream changes to built-in roles reach BMAD agents only through a new approval.** While the set is on, the
  organization's versions are current, and they are made from the built-in version of the build that made them.
- The skills need the pack to be approved. An unapproved or removed pack shows its skills as "not usable now", and agents do
  not get them.
- The BMAD skills that are granted still describe their interactive flow. The adapter tells the agent how to run them in
  Guildwise, but a skill can still ask for something that does not exist here; the agent then works without it.

## Files

| File | What it is |
|---|---|
| `packages/shared/src/roles/role-sets/bmad.ts` | the mapping, the adapter, the role builder (`bmadRoleSet`) and the check (`roleSetIssues`) |
| `packages/shared/src/roles/role-sets/bmad.generated.ts` | generated persona and method text, with its source commit |
| `scripts/bmad-roles/generate.mjs` | the generator |
| `apps/server/src/commands/role-sets.ts` | switching, the desk approval, switching back, the start-up sync |
| `apps/server/migrations/2570_org_role_set.sql` | `organizations.role_set`, `role_set_pack` |
| `apps/web/src/components/org/RoleSetPanel.tsx` | the switch on Roles & workflows |
