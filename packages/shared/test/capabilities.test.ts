import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error the generator is a plain ES module without types
import { build } from '../../capabilities/generate.mjs';
import { BUILTIN_CAPABILITY_FILES } from '../src/capabilities/builtin-data.ts';
import {
  builtinCapabilities,
  builtinCapabilityMeta,
  capabilityMeta,
  hashCapabilityFiles,
  indexCapabilityTree,
  mergeRegistry,
  parsePersona,
  parsePlaybook,
  parseSkill,
  qualifySkillKey,
  qualifySkillKeys,
  renderCapabilityIndex,
  resolveCapabilityRef,
  splitFrontmatter,
} from '../src/index.ts';

const skill = (name: string, extra = '') =>
  `---\nname: ${name}\ndescription: Does a thing.\n${extra}---\n# Body\n`;

describe('frontmatter', () => {
  it('splits the block and the body', () => {
    const r = splitFrontmatter('---\nname: x\n---\nhello\n');
    expect(r.data).toEqual({ name: 'x' });
    expect(r.body).toBe('hello\n');
  });
  it('refuses a missing block and a non-mapping', () => {
    expect(() => splitFrontmatter('no block')).toThrow(/missing frontmatter/);
    expect(() => splitFrontmatter('---\n- a\n---\nx')).toThrow(/mapping/);
    expect(() => splitFrontmatter('---\n: : :\n  - [\n---\nx')).toThrow(/YAML/);
  });
});

describe('skills (Agent Skills spec)', () => {
  it('accepts the optional fields', () => {
    const e = parseSkill('my-skill', {
      'SKILL.md': skill(
        'my-skill',
        'license: MIT\ncompatibility: any\nmetadata:\n  version: 2\nallowed-tools: Read Grep\n',
      ),
      'references/a.md': 'x',
    });
    expect(e.kind).toBe('skill');
    expect(e.meta).toMatchObject({
      license: 'MIT',
      metadata: { version: '2' },
      'allowed-tools': 'Read Grep',
    });
  });
  it('requires the name to match the directory and be lowercase-hyphen', () => {
    expect(() => parseSkill('other', { 'SKILL.md': skill('my-skill') })).toThrow(/must match the directory/);
    expect(() => parseSkill('My_Skill', { 'SKILL.md': skill('My_Skill') })).toThrow();
    expect(() => parseSkill('a--b', { 'SKILL.md': skill('a--b') })).toThrow();
  });
  it('requires a description and a SKILL.md', () => {
    expect(() => parseSkill('x', { 'SKILL.md': '---\nname: x\n---\nbody' })).toThrow(/description/);
    expect(() => parseSkill('x', {})).toThrow(/SKILL.md/);
  });
});

describe('personas', () => {
  const ok = '---\nname: P\ndescription: d\nstance: s\nvoice: v\nicon: i\nskills: [a-b]\n---\nPrompt.\n';
  it('parses frontmatter and prompt', () => {
    const e = parsePersona('p', ok);
    expect(e.kind === 'persona' && e.meta.skills).toEqual(['a-b']);
    expect(e.body).toBe('Prompt.\n');
  });
  it('needs stance, voice, icon and a prompt', () => {
    expect(() => parsePersona('p', '---\nname: P\ndescription: d\n---\nPrompt')).toThrow(/stance/);
    expect(() => parsePersona('p', ok.replace('Prompt.\n', ''))).toThrow(/prompt/);
  });
});

describe('playbooks', () => {
  const wf = '---\nname: pb\ndescription: d\n---\nsteps\n';
  it('orders steps and checks their names', () => {
    const e = parsePlaybook('pb', {
      'workflow.md': wf,
      'steps/step-02-b.md': 'b',
      'steps/step-01-a.md': 'a',
      'assets/x.csv': 'a,b',
    });
    expect(e.kind === 'playbook' && e.steps).toEqual(['steps/step-01-a.md', 'steps/step-02-b.md']);
    expect(() => parsePlaybook('pb', { 'workflow.md': wf, 'steps/one.md': 'x' })).toThrow(/step-NN/);
    expect(() =>
      parsePlaybook('pb', { 'workflow.md': wf, 'steps/step-01-a.md': 'x', 'steps/step-01-b.md': 'y' }),
    ).toThrow(/share the number/);
  });
});

describe('indexCapabilityTree', () => {
  it('indexes a tree, reports bad capabilities and keeps the good ones', () => {
    const { entries, issues } = indexCapabilityTree({
      'skills/good/SKILL.md': skill('good'),
      'skills/bad/SKILL.md': skill('wrong'),
      'personas/pp.md': '---\nname: P\ndescription: d\nstance: s\nvoice: v\nicon: i\n---\nPrompt',
      'personas/Bad Name.md': 'x',
      'playbooks/pb/workflow.md': '---\nname: pb\ndescription: d\n---\nx',
      'skills/../evil/SKILL.md': 'x',
      'README.md': 'ignored',
    });
    expect(entries.map((e) => `${e.kind}:${e.key}`)).toEqual(['persona:pp', 'playbook:pb', 'skill:good']);
    expect(issues.map((i) => i.path).sort()).toEqual([
      'personas/Bad Name.md',
      'skills/../evil/SKILL.md',
      'skills/bad/SKILL.md',
    ]);
  });
  it('hashes content, not order', () => {
    expect(hashCapabilityFiles({ a: '1', b: '2' })).toBe(hashCapabilityFiles({ b: '2', a: '1' }));
    expect(hashCapabilityFiles({ a: '1' })).not.toBe(hashCapabilityFiles({ a: '2' }));
  });
});

describe('registry merge and refs', () => {
  const meta = builtinCapabilityMeta();
  it('lets the vault override a built-in by kind and key', () => {
    const over = {
      ...(meta.find((m) => m.key === 'brainstorm') as (typeof meta)[0]),
      source: 'org-vault' as const,
      hash: 'f'.repeat(64),
    };
    const merged = mergeRegistry(meta, [over]);
    expect(merged.filter((m) => m.key === 'brainstorm')).toEqual([over]);
    expect(merged.length).toBe(meta.length);
  });
  it('resolves bare keys and kind-qualified keys', () => {
    expect(resolveCapabilityRef('analyst', meta)?.kind).toBe('persona');
    expect(resolveCapabilityRef('playbook:prd', meta)?.key).toBe('prd');
    expect(resolveCapabilityRef('skill:prd', meta)).toBeUndefined();
    expect(resolveCapabilityRef('interview-techniques', meta)?.kind).toBe('skill');
  });
  it('renders an index with name and description and flags unknown names', () => {
    const text = renderCapabilityIndex(['interview-techniques', 'nope'], meta);
    expect(text).toContain('`skill:interview-techniques`');
    expect(text).toContain('aom skill show');
    expect(text).toContain('`nope`: not found');
    expect(renderCapabilityIndex([], meta)).toBe('');
  });
});

describe('qualifySkillKey: a hand-typed name to the key the registry knows', () => {
  const reg = [
    { kind: 'skill' as const, key: 'interview-techniques', source: 'builtin' as const },
    { kind: 'skill' as const, key: 'bmad-method:bmad-prd', source: 'pack' as const },
    { kind: 'skill' as const, key: 'bmad-method:bmad-review', source: 'pack' as const },
    { kind: 'skill' as const, key: 'other:bmad-review', source: 'pack' as const },
    { kind: 'skill' as const, key: 'acme:interview-techniques', source: 'pack' as const },
    { kind: 'playbook' as const, key: 'acme:retro', source: 'pack' as const },
  ];
  it('gives a bare name the one pack that has it', () => {
    expect(qualifySkillKey('bmad-prd', reg)).toBe('bmad-method:bmad-prd');
    expect(qualifySkillKey(' bmad-prd ', reg)).toBe('bmad-method:bmad-prd');
  });
  it('keeps full keys, built-in names, names two packs share and names nothing has', () => {
    expect(qualifySkillKey('bmad-method:bmad-prd', reg)).toBe('bmad-method:bmad-prd');
    expect(qualifySkillKey('interview-techniques', reg)).toBe('interview-techniques');
    expect(qualifySkillKey('bmad-review', reg)).toBe('bmad-review');
    expect(qualifySkillKey('retro', reg)).toBe('retro');
    expect(qualifySkillKey('nope', reg)).toBe('nope');
  });
  it('a list loses duplicates and empty entries', () => {
    expect(qualifySkillKeys(['bmad-prd', 'bmad-method:bmad-prd', '', 'nope'], reg)).toEqual([
      'bmad-method:bmad-prd',
      'nope',
    ]);
  });
});

describe('built-in capabilities', () => {
  const all = builtinCapabilities();
  const ids = all.map((e) => `${e.kind}:${e.key}`);
  it('ships the required personas and playbooks and parses cleanly', () => {
    for (const k of [
      'devils-advocate',
      'user-advocate',
      'creative-strategist',
      'cost-hawk',
      'security',
      'ops',
      'customer-smb',
      'chair',
      'analyst',
    ])
      expect(ids).toContain(`persona:${k}`);
    for (const k of ['brainstorm', 'advanced-elicitation', 'product-brief', 'prd'])
      expect(ids).toContain(`playbook:${k}`);
  });
  it('has the catalogue assets', () => {
    const csv = (key: string, path: string) =>
      (BUILTIN_CAPABILITY_FILES[`playbooks/${key}/${path}`] ?? '').trim().split('\n');
    const t = csv('brainstorm', 'assets/techniques.csv');
    expect(t[0]).toBe('category,technique_name,description');
    expect(t.length - 1).toBeGreaterThanOrEqual(24);
    const m = csv('advanced-elicitation', 'assets/methods.csv');
    expect(m[0]).toBe('category,method_name,description,output_pattern');
    expect(m.length - 1).toBeGreaterThanOrEqual(19);
    const names = m.join('\n').toLowerCase();
    for (const w of [
      'pre-mortem',
      'assumptions audit',
      'first principles',
      'red team',
      'edge cases',
      'stakeholder mapping',
    ])
      expect(names).toContain(w);
    for (const row of [...t.slice(1)]) expect(row.split(',').length).toBe(3);
    for (const row of [...m.slice(1)]) expect(row.split(',').length).toBe(4);
    expect(BUILTIN_CAPABILITY_FILES['playbooks/prd/assets/prd-template.md']).toBeTruthy();
    expect(BUILTIN_CAPABILITY_FILES['playbooks/prd/assets/prd-checklist.md']).toBeTruthy();
  });
  it('every step a workflow names exists', () => {
    for (const e of all) {
      if (e.kind !== 'playbook') continue;
      for (const m of e.body.matchAll(/`(steps\/[^`]+)`/g)) expect(e.files[m[1] as string]).toBeDefined();
      expect(e.steps.length).toBeGreaterThan(0);
    }
  });
  it('personas only name skills that exist', () => {
    const skills = new Set(all.filter((e) => e.kind === 'skill').map((e) => e.key));
    for (const e of all)
      if (e.kind === 'persona') for (const s of e.meta.skills ?? []) expect(skills.has(s)).toBe(true);
  });
  it('reports metadata without content', () => {
    const m = capabilityMeta(all[0] as (typeof all)[0], 'builtin');
    expect(Object.keys(m).sort()).toEqual(['description', 'hash', 'key', 'kind', 'name', 'source']);
  });
  it('builtin-data.ts is current (run node packages/capabilities/generate.mjs)', () => {
    const file = new URL('../src/capabilities/builtin-data.ts', import.meta.url);
    expect(readFileSync(file, 'utf8')).toBe(build());
  });
});
