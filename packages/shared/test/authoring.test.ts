import { describe, expect, it } from 'vitest';
import {
  AUTHORED_LIMITS,
  type AuthoredCapability,
  authoredHasErrors,
  capabilitiesOfTree,
  capabilityFiles,
  indexPack,
  PackDesiredSchema,
  packContentHash,
  packTree,
  permissionsForPersona,
  personaToolSet,
  provenanceLabel,
  roleKeyForPackPersona,
  unzipTree,
  validateAuthored,
  validateAuthoredPack,
  validateAuthoredTree,
  zipTree,
} from '../src/index.ts';

const skill: AuthoredCapability = {
  kind: 'skill',
  key: 'release-notes',
  description: 'Write release notes from a list of merged cards.',
  body: '# Release notes\n\nGroup by theme.',
  files: { 'references/style.md': 'Short sentences.', 'scripts/check.sh': 'echo ok' },
};
const persona: AuthoredCapability = {
  kind: 'persona',
  key: 'reviewer',
  name: 'Reviewer',
  description: 'Reads a change like a sceptical maintainer.',
  stance: 'Assume the change is wrong until shown otherwise.',
  voice: 'Dry and brief',
  icon: 'magnifier',
  tools: ['read', 'web'],
  skills: ['release-notes'],
  prompt: 'You review changes. Name the riskiest file first.',
};
const playbook: AuthoredCapability = {
  kind: 'playbook',
  key: 'triage',
  description: 'Triage incoming bug reports.',
  workflow: 'Work through the steps in order.',
  steps: [
    { slug: 'collect', text: 'Collect the report.' },
    { slug: 'rank', text: 'Rank by impact.' },
  ],
  files: { 'assets/labels.csv': 'a,b\n1,2' },
};
const caps = [skill, persona, playbook];

describe('capability editor: layout and round trip', () => {
  it('writes the standard pack layout', () => {
    const tree = packTree(caps, { name: 'Mine' });
    expect(Object.keys(tree).sort()).toEqual([
      'README.md',
      'personas/reviewer.md',
      'playbooks/triage/assets/labels.csv',
      'playbooks/triage/steps/step-01-collect.md',
      'playbooks/triage/steps/step-02-rank.md',
      'playbooks/triage/workflow.md',
      'skills/release-notes/SKILL.md',
      'skills/release-notes/references/style.md',
      'skills/release-notes/scripts/check.sh',
    ]);
  });
  it('indexes as a git pack would, with no issue and the same capabilities', () => {
    const idx = indexPack({ name: 'mine', adapter: 'auto', tree: packTree(caps) });
    expect(idx.issues).toEqual([]);
    expect(idx.entries.map((e) => `${e.kind}:${e.key}`)).toEqual([
      'persona:mine:reviewer',
      'playbook:mine:triage',
      'skill:mine:release-notes',
    ]);
    expect(idx.hasScripts).toBe(true);
  });
  it('loads back into the editor unchanged (export, import, export gives the same files)', () => {
    const tree = packTree(caps, { name: 'Mine' });
    const back = capabilitiesOfTree(tree);
    expect(back.issues).toEqual([]);
    expect(packTree(back.caps, { name: 'Mine' })).toEqual(tree);
    // and the content hash of the pack does not change on the round trip
    const h = (t: Record<string, string>) =>
      packContentHash(indexPack({ name: 'mine', adapter: 'auto', tree: t }).entries);
    expect(h(packTree(back.caps))).toBe(h(packTree(caps)));
  });
  it('exports a zip that unzips to exactly the pack layout inside a folder', () => {
    const tree = packTree(caps, { name: 'Mine' });
    const zip = zipTree(tree, 'mine');
    expect(zip[0]).toBe(0x50);
    const out = unzipTree(zip, 'mine');
    expect(out).toEqual(tree);
    expect(zipTree(tree, 'mine')).toEqual(zip);
  });
});

describe('capability editor: live validation', () => {
  it('accepts good drafts and warns about a script file and an unknown tool', () => {
    expect(validateAuthored(playbook)).toEqual([]);
    const s = validateAuthored(skill);
    expect(authoredHasErrors(s)).toBe(false);
    expect(s.some((i) => i.severity === 'warning' && i.path.endsWith('check.sh'))).toBe(true);
    const p = validateAuthored({ ...persona, tools: ['read', 'teleport'] } as AuthoredCapability);
    expect(p.some((i) => i.severity === 'warning' && i.message.includes('teleport'))).toBe(true);
  });
  it('reports what the shared parsers reject', () => {
    expect(authoredHasErrors(validateAuthored({ ...skill, description: '' } as AuthoredCapability))).toBe(
      true,
    );
    expect(authoredHasErrors(validateAuthored({ ...persona, prompt: '   ' } as AuthoredCapability))).toBe(
      true,
    );
    expect(authoredHasErrors(validateAuthored({ ...skill, key: 'Bad Key' } as AuthoredCapability))).toBe(
      true,
    );
    expect(
      authoredHasErrors(validateAuthored({ ...skill, files: { '../escape.md': 'x' } } as AuthoredCapability)),
    ).toBe(true);
    expect(
      authoredHasErrors(validateAuthored({ ...skill, files: { 'other/x.md': 'x' } } as AuthoredCapability)),
    ).toBe(true);
    const dup = {
      ...playbook,
      steps: [
        { slug: 'a', text: 'x' },
        { slug: 'a', text: 'y' },
      ],
    } as AuthoredCapability;
    expect(authoredHasErrors(validateAuthored(dup))).toBe(true);
  });
  it('checks the pack as a whole: duplicate keys and size', () => {
    expect(authoredHasErrors(validateAuthoredPack([skill, skill]))).toBe(true);
    const big = {
      ...skill,
      key: 'big',
      files: {} as Record<string, string>,
      body: 'x'.repeat(100),
    } as AuthoredCapability;
    const many = Array.from({ length: 5 }, (_, i) => ({
      ...big,
      key: `big-${i}`,
      body: 'x'.repeat(300 * 1024),
    })) as AuthoredCapability[];
    expect(AUTHORED_LIMITS.totalBytes).toBeLessThan(5 * 300 * 1024);
    expect(authoredHasErrors(validateAuthoredPack(many))).toBe(true);
    expect(authoredHasErrors(validateAuthoredPack(caps))).toBe(false);
  });
  it('checks a tree the runner is about to store', () => {
    expect(validateAuthoredTree(packTree(caps))).toEqual([]);
    expect(validateAuthoredTree({ 'skills/x/SKILL.md': 'no frontmatter' }).length).toBeGreaterThan(0);
    expect(validateAuthoredTree({ '../x.md': 'x' }).length).toBeGreaterThan(0);
  });
  it('writes a persona file the registry reads back', () => {
    const f = capabilityFiles(persona);
    expect(f['reviewer.md']).toMatch(/^---\nname: Reviewer/);
  });
});

describe('persona tool profile to permissions', () => {
  it('is read only when nothing is declared', () => {
    const r = permissionsForPersona(undefined, { mayWiden: true });
    expect(r.permissions.allowedTools).toEqual(['read']);
    expect(r.permissions.mayCommit).toBe(false);
    expect(r.permissions.writableGlobs).toEqual([]);
  });
  it('maps Claude Code style names and drops unknown ones', () => {
    expect(personaToolSet(['Read', 'Grep', 'Bash', 'WebSearch', 'Nope'])).toEqual(['read', 'shell', 'web']);
  });
  it('an Owner or Admin gets what the persona declares, never commit, browser or org repos', () => {
    const r = permissionsForPersona(['read', 'edit', 'shell'], { mayWiden: true });
    expect(r.permissions.allowedTools).toEqual(['read', 'edit', 'shell']);
    expect(r.permissions.deniedShellPatterns.length).toBeGreaterThan(0);
    expect(r.permissions.mayCommit).toBe(false);
    expect(r.permissions.browser).toBe(false);
    expect(r.permissions.readOrgRepos).toBe(false);
    expect(r.withheld).toEqual([]);
  });
  it('anyone else gets read only and is told what was withheld', () => {
    const r = permissionsForPersona(['read', 'edit', 'shell', 'web'], { mayWiden: false });
    expect(r.permissions.allowedTools).toEqual(['read']);
    expect(r.withheld).toEqual(['the edit tool', 'the shell tool', 'the web tool']);
  });
});

describe('provenance', () => {
  it('reads like BMAD · analyst · v6.12.4', () => {
    expect(
      provenanceLabel({ packName: 'bmad', capability: 'bmad:analyst', ref: 'v6.12.4', sha: 'a'.repeat(40) }),
    ).toBe('BMAD · analyst · v6.12.4');
    expect(
      provenanceLabel({ packName: 'acme-kit', capability: 'reviewer', ref: 'main', sha: 'abcdef0123' }),
    ).toBe('acme-kit · reviewer · abcdef0');
    expect(roleKeyForPackPersona('bmad', 'bmad:analyst')).toBe('bmad-analyst');
  });
});

describe('pack wire stays readable by the new fields', () => {
  it('defaults the R3a fields', () => {
    const d = PackDesiredSchema.parse({
      packId: '3f2b8c1e-6a43-4c1a-9d52-1a2b3c4d5e6f',
      name: 'x',
      url: 'https://github.com/a/b.git',
      ref: 'main',
      adapter: 'auto',
      scope: 'org',
      projectId: null,
      pinnedSha: null,
      trusted: null,
      scriptsEnabled: false,
    });
    expect(d.source).toBe('git');
    expect(d.visibility).toBe('org');
    expect(d.accepted).toBe(true);
    expect(d.grantedAgentIds).toEqual([]);
  });
});
