import { describe, expect, it } from 'vitest';
import {
  AUTHORED_LIMITS,
  type AuthoredCapability,
  authoredHasErrors,
  authoredTreeContentHash,
  capabilitiesOfTree,
  capabilityFiles,
  diffPackTrees,
  indexPack,
  PackDesiredSchema,
  packContentHash,
  packTree,
  permissionsForPersona,
  personaToolSet,
  provenanceLabel,
  RoleDefinitionSchema,
  roleFromPersona,
  roleKeyForPackPersona,
  unzipTree,
  validateAuthored,
  validateAuthoredPack,
  validateAuthoredTree,
  validateRoleDefinition,
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
  it('reads like ACME · analyst · v6.12.4', () => {
    expect(
      provenanceLabel({ packName: 'acme', capability: 'acme:analyst', ref: 'v6.12.4', sha: 'a'.repeat(40) }),
    ).toBe('ACME · analyst · v6.12.4');
    expect(
      provenanceLabel({ packName: 'acme-kit', capability: 'reviewer', ref: 'main', sha: 'abcdef0123' }),
    ).toBe('acme-kit · reviewer · abcdef0');
    expect(roleKeyForPackPersona('acme', 'acme:analyst')).toBe('acme-analyst');
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

describe('a role from a pack persona', () => {
  const text = capabilityFiles({
    kind: 'persona',
    key: 'analyst',
    name: 'Analyst',
    description: 'Turns ideas into briefs.',
    stance: 'Ask before assuming.',
    voice: 'Warm',
    icon: 'A',
    tools: ['read', 'web', 'shell'],
    skills: ['brief'],
    prompt: 'Interview the owner.',
  } as AuthoredCapability)['analyst.md'] as string;
  const base = {
    packId: '3f2b8c1e-6a43-4c1a-9d52-1a2b3c4d5e6f',
    packName: 'acme',
    capability: 'analyst',
    text,
    hash: 'a'.repeat(64),
    sha: 'b'.repeat(40),
    ref: 'v6.12.4',
    visibility: 'org' as const,
    version: 1,
  };
  it('makes instructions of the prompt and a role that claims nothing', () => {
    const r = roleFromPersona({ ...base, packSkills: ['acme:brief'] });
    expect(r.key).toBe('acme-analyst');
    expect(r.instructions).toContain('Interview the owner.');
    expect(r.instructions).toContain('Stance: Ask before assuming.');
    expect(r.claimableStages).toEqual([]);
    expect(r.skills).toEqual(['acme:brief']);
    expect(r.permissions.allowedTools).toEqual(['read', 'web', 'shell']);
    expect(r.permissions.mayCommit).toBe(false);
    expect(r.source && provenanceLabel(r.source)).toBe('ACME · analyst · v6.12.4');
    expect(RoleDefinitionSchema.safeParse(r).success).toBe(true);
    expect(
      validateRoleDefinition(r, { builtinRoleKeys: [], builtinWorkflowKeys: [], departments: [] }).filter(
        (i) => i.severity === 'error',
      ),
    ).toEqual([]);
  });
});

describe('a role from a PRIVATE pack persona (security review finding 3)', () => {
  const persona3: AuthoredCapability = {
    kind: 'persona',
    key: 'analyst',
    name: 'Analyst',
    description: 'Turns ideas into briefs.',
    stance: 'Ask before assuming.',
    voice: 'Warm',
    icon: 'A',
    tools: ['read', 'edit', 'shell', 'web'],
    prompt: 'Interview the owner.',
  };
  const text3 = capabilityFiles(persona3)['analyst.md'] as string;
  const PACK = '3f2b8c1e-6a43-4c1a-9d52-1a2b3c4d5e6f';
  const OWNER = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
  const input = {
    packId: PACK,
    packName: 'acme',
    capability: 'analyst',
    text: text3,
    hash: 'a'.repeat(64),
    sha: 'b'.repeat(40),
    ref: null,
    version: 1,
  };

  it('gets a key of its own: a private pack named like an organization pack never lands on the organization’s role', () => {
    expect(roleKeyForPackPersona('acme', 'analyst')).toBe('acme-analyst');
    const k = roleKeyForPackPersona('acme', 'analyst', { visibility: 'private', packId: PACK });
    expect(k).toBe('acme-analyst-p3f2b8c1e');
    expect(k).not.toBe('acme-analyst');
    expect(roleKeyForPackPersona('acme', 'analyst', { visibility: 'org', packId: PACK })).toBe(
      'acme-analyst',
    );
    // another pack of the same name gets another key; a long name keeps the tag and stays inside the key pattern
    expect(roleKeyForPackPersona('acme', 'analyst', { visibility: 'private', packId: OWNER })).not.toBe(k);
    const long = roleKeyForPackPersona('a'.repeat(40), 'b'.repeat(40), {
      visibility: 'private',
      packId: PACK,
    });
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith('-p3f2b8c1e')).toBe(true);
    expect(long).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('carries the owner and, for a Member, only the tools a Member may grant; for an Owner or Admin the persona’s own', () => {
    const member = roleFromPersona({ ...input, visibility: 'private', ownerUserId: OWNER, mayWiden: false });
    expect(member.key).toBe('acme-analyst-p3f2b8c1e');
    expect(member.permissions.allowedTools).toEqual(['read']);
    expect(member.permissions.mayCommit).toBe(false);
    expect(member.source).toMatchObject({ visibility: 'private', ownerUserId: OWNER, packId: PACK });
    const admin = roleFromPersona({ ...input, visibility: 'private', ownerUserId: OWNER, mayWiden: true });
    expect(admin.permissions.allowedTools).toEqual(['read', 'edit', 'shell', 'web']);
    // an organization pack's role is not clamped (its owner approved the pack) and has no owner
    const org = roleFromPersona({ ...input, visibility: 'org' });
    expect(org.permissions.allowedTools).toEqual(['read', 'edit', 'shell', 'web']);
    expect(org.source?.ownerUserId).toBeUndefined();
    expect(RoleDefinitionSchema.safeParse(member).success).toBe(true);
  });
});

describe('R3c: versions of an authored pack', () => {
  it('hashes a tree to the content hash a snapshot of it carries', () => {
    const tree = packTree([skill]);
    const index = indexPack({ name: 'mine', adapter: 'generic', tree });
    expect(authoredTreeContentHash('mine', tree)).toBe(packContentHash(index.entries));
    expect(authoredTreeContentHash('mine', { ...tree, 'README.md': 'x' })).not.toBe('');
    const edited = packTree([{ ...skill, body: '# Release notes\n\nGroup by author.' }]);
    expect(authoredTreeContentHash('mine', edited)).not.toBe(authoredTreeContentHash('mine', tree));
  });

  it('lists the files that were added, removed, changed or left alone, in path order', () => {
    const before = { 'a.md': '1', 'b.md': '2', 'c.md': '3' };
    const after = { 'a.md': '1', 'b.md': '22', 'd.md': '4' };
    expect(diffPackTrees(before, after).map((c) => [c.path, c.status])).toEqual([
      ['a.md', 'unchanged'],
      ['b.md', 'changed'],
      ['c.md', 'removed'],
      ['d.md', 'added'],
    ]);
    expect(diffPackTrees(null, after).every((c) => c.status === 'added')).toBe(true);
    expect(diffPackTrees(before, after).find((c) => c.path === 'b.md')).toMatchObject({
      before: '2',
      after: '22',
    });
  });
});
