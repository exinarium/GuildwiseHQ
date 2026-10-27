import { describe, expect, it } from 'vitest';
// @ts-expect-error the generator is a plain ES module without types
import { renderTemplate, section, withoutMachinery } from '../../../scripts/bmad-roles/generate.mjs';
import {
  BMAD_NOT_GRANTED,
  BMAD_PERSONAS,
  BMAD_ROLE_MAPPING,
  BMAD_SOURCE,
  BUILTIN_ROLES,
  BUILTIN_WORKFLOWS,
  bmadRoleFor,
  bmadRoleSet,
  type ChatContext,
  materialiseVariant,
  renderChatInstructions,
  renderChatRoleSection,
  roleSetIssues,
  UX_DESIGNER_KEY,
  uxDesignerRole,
  uxDesignInsertion,
  validateVariant,
  WorkflowVariantSpecSchema,
} from '../src/index.ts';

const builtin = (key: string) => BUILTIN_ROLES.find((r) => r.key === key)!;
const PLATFORM_JOBS = ['ceo', 'devops', 'curator', 'scout', 'checker'];

describe('the BMAD role set', () => {
  const set = bmadRoleSet('bmad-method');

  it('changes only the mapped built-in roles, plus the UX designer', () => {
    expect(set.map((r) => r.key).sort()).toEqual([...Object.keys(BMAD_ROLE_MAPPING), UX_DESIGNER_KEY].sort());
    for (const k of PLATFORM_JOBS) expect(set.some((r) => r.key === k)).toBe(false);
    for (const k of Object.keys(BMAD_ROLE_MAPPING)) expect(builtin(k)).toBeDefined();
  });

  it('never loosens a role: instructions, core rules, permissions, stages, seniority and model stay the built-in ones', () => {
    for (const r of set.filter((x) => x.key !== UX_DESIGNER_KEY)) {
      const b = builtin(r.key);
      expect(roleSetIssues(r, b)).toEqual([]);
      expect(r.instructions).toBe(b.instructions);
      expect(r.coreRules).toEqual(b.coreRules);
      expect(r.permissions).toEqual(b.permissions);
      expect(r.claimableStages).toEqual(b.claimableStages);
      expect(r.roleSet).toEqual({
        key: 'bmad',
        builtinVersion: b.version,
        source: `${BMAD_SOURCE.repo}@${BMAD_SOURCE.commit}`,
      });
    }
  });

  it('refuses a version that would widen or change a role', () => {
    const r = bmadRoleFor(builtin('reviewer'))!;
    const wider = { ...r, permissions: { ...r.permissions, mayCommit: true } };
    expect(roleSetIssues(wider, builtin('reviewer'))).toEqual([
      expect.stringMatching(/^permissions differs/),
    ]);
    expect(roleSetIssues({ ...r, coreRules: [] }, builtin('reviewer'))).toEqual([
      expect.stringMatching(/^coreRules differs/),
    ]);
    expect(roleSetIssues({ ...r, roleSet: undefined }, builtin('reviewer'))).toContain(
      'not a role-set version',
    );
    const ux = uxDesignerRole();
    expect(roleSetIssues(ux, undefined)).toEqual([]);
    expect(
      roleSetIssues({ ...ux, permissions: { ...ux.permissions, writableGlobs: null } }, undefined),
    ).not.toEqual([]);
  });

  it('grants skills under the pack key, never the template-based or install skills', () => {
    for (const r of set) {
      for (const s of r.skills) {
        expect(s.startsWith('bmad-method:')).toBe(true);
        expect(BMAD_NOT_GRANTED[s.slice('bmad-method:'.length)]).toBeUndefined();
      }
    }
    expect(bmadRoleFor(builtin('analyst'), 'acme')?.skills).toContain('acme:bmad-deep-recon');
  });

  it('a persona carries the BMAD agent and the Guildwise adapter, with no BMAD machinery to run', () => {
    const analyst = set.find((r) => r.key === 'analyst')!;
    expect(analyst.persona).toContain(
      `## How you work (BMAD Method: ${BMAD_PERSONAS['bmad-agent-analyst']?.title})`,
    );
    for (const p of BMAD_PERSONAS['bmad-agent-analyst']?.principles ?? [])
      expect(analyst.persona).toContain(p);
    expect(set.find((r) => r.key === 'ba')?.persona).toContain('### Spec Law');
    expect(set.find((r) => r.key === 'planner')?.persona).toContain('### What makes a good story');
    for (const r of set) {
      expect(r.persona).toContain('## BMAD skills in Guildwise');
      expect(r.persona).not.toMatch(
        /\{skill-root\}|\{project-root\}|resolve_customization|memlog\.py|tickets\.py/,
      );
      // BMAD's agent names are not the agents' names
      for (const p of Object.values(BMAD_PERSONAS)) expect(r.persona).not.toContain(`${p.name},`);
    }
  });
});

describe('the UX design step', () => {
  const code = BUILTIN_WORKFLOWS.filter((w) => w.key === 'code').sort((a, b) => b.version - a.version)[0]!;
  const roles = [...BUILTIN_ROLES, uxDesignerRole()];
  const spec = WorkflowVariantSpecSchema.parse({
    key: 'code-ux',
    name: 'Code with UX design',
    projectId: '00000000-0000-4000-8000-000000000001',
    base: { key: code.key, version: code.version },
    insertions: [uxDesignInsertion()],
  });

  it('is a valid variant step the UX designer claims, run only when the card needs design', () => {
    const v = validateVariant(spec, code, roles, { builtinWorkflowKeys: ['code'] });
    expect(v.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const def = materialiseVariant(code, spec);
    const ids = def.stages.map((s) => s.id);
    const ux = def.stages.find((s) => s.id === 'ux_design')!;
    expect(ux).toMatchObject({ claimRole: 'ux_designer', when: { field: 'designNeeded', equals: true } });
    expect(ids.indexOf('planning')).toBeLessThan(ids.indexOf('ux_design'));
    expect(ids.indexOf('ux_design')).toBeLessThan(ids.indexOf('build'));
  });

  it('an approval step cannot be conditional', () => {
    const bad = WorkflowVariantSpecSchema.parse({
      ...spec,
      insertions: [
        {
          after: 'planning',
          stage: {
            id: 'ok',
            label: 'OK',
            kind: 'approval',
            doneCriteria: 'x',
            when: { field: 'designNeeded', equals: true },
          },
        },
      ],
    });
    expect(() => materialiseVariant(code, bad)).toThrow(/cannot be conditional/);
  });
});

describe('the role section of a chat', () => {
  const ctx = { orgId: '00000000-0000-4000-8000-000000000002' } as ChatContext;
  const agent = { name: 'Mary', roleKey: 'analyst', seniority: 'senior' as const };

  it('is the persona and the owner extensions; a stock role without extensions gets none', () => {
    expect(renderChatRoleSection(undefined)).toBe('');
    expect(renderChatRoleSection({ name: 'Analyst' })).toBe('');
    const text = renderChatInstructions(agent, ctx, {
      role: { name: 'Analyst', persona: '## How you work\nCarefully.', extensions: 'Always cite sources.' },
    });
    expect(text).toContain('# Your role: Analyst\n## How you work\nCarefully.');
    expect(text).toContain('## Owner extensions');
    expect(text).toContain('Always cite sources.');
    expect(text.indexOf('# Your role')).toBeLessThan(text.indexOf('# This conversation'));
    expect(renderChatInstructions(agent, ctx)).not.toContain('# Your role');
  });
});

describe('scripts/bmad-roles/generate.mjs', () => {
  const cfg = { workflow: { rule: 'One rule.\n', flag: true, empty: [], tpl: '{skill-root}/assets/x.toml' } };

  it('renders the Jinja the BMAD templates use from the customize.toml defaults', () => {
    expect(renderTemplate('- {{ workflow.rule }}', cfg)).toBe('- One rule.');
    expect(renderTemplate('{% if workflow.flag %}A{% else %}B{% endif %}', cfg)).toBe('A');
    expect(renderTemplate('{% if workflow.empty %}A{% else %}B{% endif %}', cfg)).toBe('B');
    // a file path or a call is BMAD's own: the line goes
    expect(renderTemplate('keep\nfrom `{{ workflow.tpl }}`\n{{ halt() }}', cfg)).toBe('keep');
  });

  it('cuts a section at the next heading of its level', () => {
    expect(section('# T\n## A\none\n### A1\ntwo\n## B\nthree', 'A')).toBe('one\n### A1\ntwo');
    expect(() => section('# T', 'Nope')).toThrow(/no section/);
  });

  it('leaves out the sentences that name BMAD machinery and keeps the rest', () => {
    const r = withoutMachinery('- Keep this. Run `uv run x.py` now.\n- Write to `.memlog.md`.\nPlain.');
    expect(r).toEqual({ text: '- Keep this.\nPlain.', dropped: 2 });
  });
});
