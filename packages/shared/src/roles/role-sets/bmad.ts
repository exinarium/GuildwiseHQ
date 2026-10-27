import { BUILTIN_ROLES } from '../builtin.ts';
import { type RoleDefinition, RoleDefinitionSchema } from '../schema.ts';
import { BMAD_METHODS, BMAD_PERSONAS, BMAD_SOURCE } from './bmad.generated.ts';

/**
 * The BMAD role set (docs/bmad-roles.md): the built-in roles take the personas, working method and skills of the BMAD Method
 * (https://github.com/bmad-code-org/BMAD-METHOD, MIT). Everything Guildwise-specific about it is in this file: which role gets
 * which persona and skills, and the rules that adapt BMAD's interactive skills to Guildwise. The persona and method text is
 * generated from a BMAD checkout into `bmad.generated.ts`.
 *
 * A role of the set is its built-in role plus a `persona` (and its BMAD skills): the key, instructions, core rules,
 * permissions, stages, seniority and model stay exactly the built-in's (`roleSetIssues` checks that), so BMAD never
 * loosens a gate. Roles with no BMAD equivalent (CEO, DevOps engineer, curator, scout, fact checker) are not in the set.
 */

export const BMAD_ROLE_SET = 'bmad';
/** The pack name a BMAD checkout gets when it is imported (`<pack>:<skill>` keys). The server uses the organization's own. */
export const BMAD_DEFAULT_PACK = 'bmad-method';
/** The BMAD agent skill whose presence identifies a BMAD pack in an organization's registry. */
export const BMAD_MARKER_SKILL = 'bmad-agent-analyst';

export interface BmadRoleMapping {
  /** The BMAD agent (skill name) whose persona the role takes. Absent: the role keeps its own and gets BMAD skills only. */
  persona?: string;
  /** Sections of a BMAD agent's method (`BMAD_METHODS`) added to the persona: `[agent, section id]`. */
  methods?: Array<[string, string]>;
  /** BMAD skills granted (names inside the pack). */
  skills: string[];
}

/** Built-in role key -> what it takes from BMAD. */
export const BMAD_ROLE_MAPPING: Record<string, BmadRoleMapping> = {
  analyst: {
    persona: 'bmad-agent-analyst',
    skills: [
      'bmad-deep-recon',
      'bmad-brainstorming',
      'bmad-product-brief',
      'bmad-prfaq',
      'bmad-forge-idea',
      'bmad-advanced-elicitation',
    ],
  },
  // The BA specifies, takes intake and finalizes: the product owner's requirements discipline.
  ba: {
    persona: 'bmad-agent-po',
    methods: [
      ['bmad-agent-po', 'spec-law'],
      ['bmad-agent-po', 'load-bearing'],
      ['bmad-agent-po', 'self-validate'],
    ],
    skills: ['bmad-prd', 'bmad-advanced-elicitation'],
  },
  // The planner splits and orders the work: the product manager, with the product owner's slicing rules.
  planner: {
    persona: 'bmad-agent-pm',
    methods: [
      ['bmad-agent-po', 'good-story'],
      ['bmad-agent-po', 'set-checks'],
    ],
    skills: ['bmad-prd'],
  },
  architect: { persona: 'bmad-agent-architect', skills: ['bmad-architecture', 'bmad-project-context'] },
  builder: { persona: 'bmad-agent-dev', skills: ['bmad-project-context'] },
  pre_reviewer: { skills: ['bmad-review'] },
  reviewer: { skills: ['bmad-review'] },
  researcher: { skills: ['bmad-deep-recon'] },
  writer: { skills: ['bmad-project-context'] },
};

/**
 * BMAD skills that are never granted, with the reason (docs/bmad-roles.md). The template-based ones only say "run
 * `render_skill.py` and follow its output", which an agent cannot do with scripts off and no `_bmad/` folder; their method is
 * in the personas above instead.
 */
export const BMAD_NOT_GRANTED: Record<string, string> = {
  'bmad-agent-po': 'template-based (render_skill.py); its method is in the BA and planner personas',
  'bmad-build': "template-based; it would also replace the builder's own flow (worktree, evidence, handoff)",
  'bmad-code-review': 'template-based',
  'bmad-walkthrough': 'template-based',
  'bmad-qa-generate-e2e-tests': 'template-based',
  'bmad-build-auto': 'an unattended loop of its own',
  'bmad-retrospective': 'template-based',
  'bmad-party-mode': 'interactive group chat',
  'bmad-customize': 'edits a BMAD install',
  'bmad-toolsmith': 'edits a BMAD install',
  'bmad-eval': 'edits a BMAD install',
  bmad: 'sets up a BMAD install',
  'bmod-core-tools': 'module metadata, not a skill',
  'bmod-method': 'module metadata, not a skill',
  'bmod-toolsmith': 'module metadata, not a skill',
};

/** The custom role the set adds. Its stage is a project variant's `ux*` step (see `uxDesignInsertion`). */
export const UX_DESIGNER_KEY = 'ux_designer';
const UX_PERSONA = 'bmad-agent-ux-designer';
const UX_SKILLS = ['bmad-ux'];

/**
 * How BMAD's skills are used in Guildwise. They were written for an interactive BMAD install; this replaces the parts that
 * cannot work here (activation scripts, `_bmad/` config and output folders, menus, waiting for input).
 */
export const BMAD_ADAPTER = `## BMAD skills in Guildwise
Your BMAD skills are listed under Capabilities with their full key (\`<pack>:bmad-…\`). Load one with \`aom skill show <key>\` when the work fits it, and only then. They were written for an interactive BMAD install; here:
- Skip a skill's activation steps that run scripts: never run \`uv run\`, \`npx\` or anything under \`_bmad/\` (pack scripts are off). Where a skill reads settings from \`customize.toml\` or \`core.*\` config, read the skill's own defaults with \`aom skill show <key> --file customize.toml\` and use them.
- There is no \`_bmad/\` or \`_bmad-output/\` folder. Deliver what a skill would write there the Guildwise way: on a card, in the files your role may write and your outcome command; in a session, with the session's \`aom\` commands; in a chat, in your reply.
- Never stop at a menu or wait for a reply in the middle of a skill. Use its headless mode where it has one. On a card, decide what you can, write each guess as an \`Assumption:\` line and each gap as an \`Open question:\` line in your handoff, and ask with \`aom question\` only when the answer would change the work. In a chat, ask the manager plainly.
- A skill's memlog or decision log is the ledger: read it with \`aom ledger search "<query>"\`; record decisions the way your role records them (handoff notes, questions to the owner).
- BMAD's words: a ticket or story is a card, an epic is a card group or phase, an initiative is a project or phase, and "the user" is the manager or owner.
- No greeting, icon, numbered menu or character to play: keep your own name and answer plainly. Do not offer or run skills you were not given (party mode, customize, build-auto).
- Your role's core rules and permissions always win over a skill: a skill never widens what you may change, run or commit.`;

const bullet = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n');

/** The persona text of a mapped role: who BMAD's agent is, its method sections, and the adapter. */
export function bmadPersonaText(m: Pick<BmadRoleMapping, 'persona' | 'methods'>): string {
  const parts: string[] = [];
  if (m.persona) {
    const p = BMAD_PERSONAS[m.persona];
    if (!p) throw new Error(`the BMAD data has no persona ${m.persona}: regenerate bmad.generated.ts`);
    parts.push(
      `## How you work (BMAD Method: ${p.title})`,
      'This is how you work, not a character to play.',
      `- Your focus: ${p.role}`,
      `- Your approach: ${p.identity}`,
      `- How you communicate: ${p.communicationStyle}`,
      '',
      'Principles:',
      bullet(p.principles),
    );
  }
  for (const [agent, id] of m.methods ?? []) {
    const s = BMAD_METHODS[agent]?.find((x) => x.id === id);
    if (!s)
      throw new Error(`the BMAD data has no method section ${agent}/${id}: regenerate bmad.generated.ts`);
    parts.push('', `### ${s.title}`, s.text);
  }
  parts.push(
    '',
    BMAD_ADAPTER,
    '',
    `(Source: BMAD Method ${BMAD_SOURCE.repo} at ${BMAD_SOURCE.commit.slice(0, 7)}.)`,
  );
  return parts.join('\n').trim();
}

const packKey = (pack: string, skill: string) => `${pack}:${skill}`;

/** The role set's version of a built-in role, built on that built-in definition. `version` is set when it is registered. */
export function bmadRoleFor(
  builtin: RoleDefinition,
  pack: string = BMAD_DEFAULT_PACK,
): RoleDefinition | undefined {
  const m = BMAD_ROLE_MAPPING[builtin.key];
  if (!m) return undefined;
  return RoleDefinitionSchema.parse({
    ...structuredClone(builtin),
    skills: m.skills.map((s) => packKey(pack, s)),
    persona: bmadPersonaText(m),
    roleSet: {
      key: BMAD_ROLE_SET,
      builtinVersion: builtin.version,
      source: `${BMAD_SOURCE.repo}@${BMAD_SOURCE.commit}`,
    },
  });
}

/**
 * The UX designer: a custom role that works one `ux*` step of a project variant of `code` (inserted after planning and run
 * only for cards that need design). It writes a UX specification in the repository and never touches product code.
 */
export function uxDesignerRole(pack: string = BMAD_DEFAULT_PACK): RoleDefinition {
  const p = BMAD_PERSONAS[UX_PERSONA];
  return RoleDefinitionSchema.parse({
    key: UX_DESIGNER_KEY,
    version: 1,
    name: p?.title || 'UX designer',
    purpose:
      'Designs the user experience of a card that changes a user interface, before it is designed and built.',
    department: 'delivery',
    builtIn: false,
    instructions: `You are the UX designer. A card that changes what people see or do comes to you before the architect and the builder: you decide how it looks and behaves, and write that down for them. You never build it.

How to work:
1. Read the whole card, its handoffs, the project's PROJECT.md and the ledger (\`aom ledger search "<query>"\`). Read the existing user interface code and any design system in the repository to stay consistent with it.
2. Write the UX specification to docs/ux/<REF>-<slug>.md in your worktree: who uses this and for what; the screens or states and how people move between them; the components and their states (empty, loading, error, disabled); copy; accessibility (keyboard, focus, contrast, screen reader names); how each acceptance criterion shows in the interface. Load your UX skill with \`aom skill show <key>\` and follow its method for the content.
3. Commit the specification on the card branch, then report with the outcome command listed for this step, naming the file and what the architect and builder must keep.
4. Anything only the owner can decide goes to \`aom question\` with options and your recommendation.`,
    coreRules: [
      'Write only the UX specification and other documentation (docs/**, *.md); never create or edit source code or tests.',
      'Never push; commit only on the card branch you were given.',
      'Hand on only when the specification is committed and covers every acceptance criterion that touches the interface.',
    ],
    seniorityLevels: ['senior', 'junior'],
    defaultModel: { runtime: 'claude-code', model: 'sonnet', effort: 'medium' },
    permissions: {
      allowedTools: ['read', 'edit', 'shell', 'web'],
      deniedShellPatterns: [
        'git push*',
        'git rebase*',
        'git checkout*',
        'git switch*',
        'git reset --hard*',
        'rm -rf /*',
        'sudo *',
      ],
      writableGlobs: ['docs/**', '**/*.md'],
      mayCommit: true,
      browser: false,
      riskTiers: ['small', 'large'],
      readOrgRepos: false,
      repoIds: null,
    },
    skills: UX_SKILLS.map((s) => packKey(pack, s)),
    claimableStages: [{ workflowKey: 'code', stageId: 'ux*' }],
    persona: bmadPersonaText({ persona: UX_PERSONA }),
    roleSet: { key: BMAD_ROLE_SET, source: `${BMAD_SOURCE.repo}@${BMAD_SOURCE.commit}` },
  });
}

/** Every role of the set, for a pack name: the built-in roles it changes (current built-in versions) and the UX designer. */
export function bmadRoleSet(pack: string = BMAD_DEFAULT_PACK): RoleDefinition[] {
  const out: RoleDefinition[] = [];
  for (const b of BUILTIN_ROLES) {
    const r = bmadRoleFor(b, pack);
    if (r) out.push(r);
  }
  out.push(uxDesignerRole(pack));
  return out;
}

/**
 * What would make a role-set version wider or different from its built-in: anything but the persona, the skills, the
 * version and the role-set marker. The server refuses to register or approve a version with an issue.
 */
export function roleSetIssues(def: RoleDefinition, builtin: RoleDefinition | undefined): string[] {
  const issues: string[] = [];
  if (!def.roleSet) issues.push('not a role-set version');
  if (!builtin) {
    // the set's own custom role: it must be the one this code makes (only the skills' pack name may differ)
    if (def.key !== UX_DESIGNER_KEY) issues.push(`'${def.key}' is not a built-in role or a role of the set`);
    const want = uxDesignerRole();
    const same = (a: RoleDefinition) => ({ ...a, version: 1, skills: [], roleSet: undefined });
    if (JSON.stringify(same(def)) !== JSON.stringify(same(want)))
      issues.push(`'${def.key}' differs from the role set's definition`);
    return issues;
  }
  const fixed = [
    'key',
    'name',
    'purpose',
    'department',
    'builtIn',
    'instructions',
    'coreRules',
    'seniorityLevels',
    'defaultModel',
    'permissions',
    'claimableStages',
    'source',
    'chatOnly',
  ] as const;
  for (const f of fixed)
    if (JSON.stringify(def[f]) !== JSON.stringify(builtin[f]))
      issues.push(`${f} differs from built-in ${builtin.key} v${builtin.version}`);
  return issues;
}
