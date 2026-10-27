import { describe, expect, it } from 'vitest';
import {
  commandToPlaybookFiles,
  indexPack,
  MAX_PACK_ITEMS,
  PACK_SNAPSHOT_MAX_BYTES,
  PackSnapshotSchema,
  packContentHash,
  packSnapshotLegacyHash,
  packSnapshotOf,
  parsePlaybook,
  slugKey,
} from '../src/index.ts';
import { bigMarketplace, smallMarketplace } from './fixtures/plugin-marketplace-fixture.ts';

const keys = (r: ReturnType<typeof indexPack>, kind: string) =>
  r.entries
    .filter((e) => e.kind === kind)
    .map((e) => e.key)
    .sort();

describe('Claude Code plugin layout', () => {
  const r = indexPack({ name: 'market', adapter: 'auto', tree: smallMarketplace() });

  it('reads agents/*.md at any depth as personas, with colliding names kept apart by plugin', () => {
    expect(keys(r, 'persona')).toEqual([
      'market:backend-architect',
      'market:claude-one',
      'market:plugins-backend-reviewer',
      'market:plugins-frontend-reviewer',
      'market:root-helper',
    ]);
    const helper = r.entries.find((e) => e.key === 'market:root-helper');
    expect(helper?.kind === 'persona' && helper.meta.tools).toEqual(['Read', 'Grep']);
    expect(helper?.kind === 'persona' && helper.meta.model).toBe('sonnet');
    expect(r.entries.find((e) => e.key === 'market:plugins-backend-reviewer')?.description).toBe(
      'Reviews backend code.',
    );
  });

  it('reads commands/*.md at any depth as one-step playbooks', () => {
    expect(keys(r, 'playbook')).toEqual([
      'market:hello',
      'market:lint',
      'market:plugins-backend-deploy',
      'market:plugins-frontend-deploy',
    ]);
    const pb = r.entries.find((e) => e.key === 'market:plugins-backend-deploy');
    expect(pb?.kind === 'playbook' && pb.steps).toEqual(['steps/step-01-plugins-backend-deploy.md']);
    expect(pb?.description).toBe('Deploy the service');
    const step = pb?.files['steps/step-01-plugins-backend-deploy.md'] ?? '';
    expect(step).toContain('Run the thing on $ARGUMENTS.');
    // the command's own frontmatter (allowed-tools) is dropped, never copied
    expect(step).not.toContain('allowed-tools');
    // no frontmatter: description comes from the text
    expect(r.entries.find((e) => e.key === 'market:plugins-frontend-deploy')?.description).toBe(
      'Run the thing on $ARGUMENTS.',
    );
  });

  it('leaves skill folders, non-subagents and excluded folders alone', () => {
    expect(keys(r, 'skill')).toEqual(['market:api-design']);
    expect(keys(r, 'persona')).not.toContain('market:helper');
    expect(r.entries.some((e) => /fake|vendored|doc$/.test(e.key))).toBe(false);
    expect(r.issues).toEqual([]);
    expect(r.notes.join(' ')).toContain('1 file(s) under agents/ without a name and description');
  });

  it('is deterministic whatever order the files are listed in', () => {
    const t = smallMarketplace();
    const rev = Object.fromEntries(Object.entries(t).reverse());
    const a = indexPack({ name: 'market', tree: t });
    const b = indexPack({ name: 'market', tree: rev });
    expect(b.entries.map((e) => `${e.key}:${e.hash}`)).toEqual(a.entries.map((e) => `${e.key}:${e.hash}`));
  });

  it('a changed command changes the hash, so the pack needs review again', () => {
    const t = smallMarketplace();
    const before = r.entries.find((e) => e.key === 'market:lint')?.hash;
    t['plugins/frontend/commands/lint.md'] += '\nAlso run the formatter.\n';
    expect(
      indexPack({ name: 'market', tree: t }).entries.find((e) => e.key === 'market:lint')?.hash,
    ).not.toBe(before);
  });

  it('a pack without these folders reads exactly as before', () => {
    const plain = indexPack({
      name: 'p',
      tree: { 'skills/a/SKILL.md': '---\nname: a\ndescription: A.\n---\nx\n', 'README.md': 'x' },
    });
    expect(plain.entries.map((e) => e.key)).toEqual(['p:a']);
    expect(plain.notes).toEqual([]);
  });

  it('turns a command into a valid playbook', () => {
    const files = commandToPlaybookFiles('x', '---\ndescription: Do x\n---\nBody\n');
    expect(parsePlaybook('x', files).description).toBe('Do x');
    expect(slugKey('My_Command v2')).toBe('my-command-v2');
  });
});

describe('a large plugin marketplace', () => {
  it('indexes within the limits and fits a snapshot', () => {
    const tree = bigMarketplace();
    const r = indexPack({ name: 'wsh', tree });
    expect(r.issues).toEqual([]);
    expect(keys(r, 'persona')).toHaveLength(60 * 3 + 20);
    expect(keys(r, 'skill')).toHaveLength(100);
    // 60 shared `status.md` plus 2 per plugin up to 80
    expect(keys(r, 'playbook')).toHaveLength(60 + 80);
    expect(keys(r, 'playbook')).toContain('wsh:plugins-plugin-7-status');
    expect(r.entries.length).toBeLessThanOrEqual(MAX_PACK_ITEMS);
    const snap = packSnapshotOf({ name: 'wsh', ref: 'main', sha: 'a'.repeat(40), index: r });
    expect(PackSnapshotSchema.safeParse(snap).success).toBe(true);
    expect(snap.items).toHaveLength(r.entries.length);
    expect(JSON.stringify(snap).length).toBeLessThan(2 * 1024 * 1024);
  });
});

describe('only real Claude Code plugins are read', () => {
  const agent = '---\nname: x\ndescription: d\n---\nBody\n';
  const cmd = '# Do\n\nIt.\n';
  it('leaves the commands/ and agents/ folders of an ordinary repository alone', () => {
    const r = indexPack({
      name: 'cli',
      tree: { 'src/commands/build.md': cmd, 'agents/x.md': agent, 'commands/y.md': cmd, 'README.md': 'x' },
    });
    expect(r.entries).toEqual([]);
  });
  it('reads a plugin folder with its plugin.json, not its neighbour without one', () => {
    const r = indexPack({
      name: 'p',
      tree: {
        'plugins/a/.claude-plugin/plugin.json': '{}',
        'plugins/a/commands/one.md': cmd,
        'plugins/a/agents/x.md': agent,
        'plugins/b/commands/two.md': cmd,
      },
    });
    expect(r.entries.map((e) => e.key).sort()).toEqual(['p:one', 'p:x']);
  });
  it('reads root-level folders next to a root .claude-plugin/ and plugin.json in an ancestor', () => {
    const root = indexPack({
      name: 'p',
      tree: { '.claude-plugin/plugin.json': '{}', 'commands/c.md': cmd, 'agents/a.md': agent },
    });
    expect(root.entries.map((e) => e.key).sort()).toEqual(['p:a', 'p:c']);
    const deep = indexPack({
      name: 'p',
      tree: { 'plugins/a/.claude-plugin/plugin.json': '{}', 'plugins/a/src/commands/z.md': cmd },
    });
    expect(deep.entries.map((e) => e.key)).toEqual(['p:z']);
  });
});

describe('the pack hashes: a pack approved before the layout was read keeps its hash', () => {
  const t = smallMarketplace();
  const full = indexPack({ name: 'market', tree: t });
  const snap = packSnapshotOf({ name: 'market', ref: 'v1', sha: 'a'.repeat(40), index: full });
  it('marks plugin-layout items and adds the legacy hash', () => {
    const plugin = snap.items.filter((i) => i.layout === 'plugin').map((i) => i.key);
    expect(plugin.length).toBeGreaterThan(5);
    expect(snap.items.find((i) => i.key === 'market:api-design')?.layout).toBeUndefined();
    expect(snap.legacyContentHash).toBeDefined();
    expect(snap.legacyContentHash).not.toBe(snap.contentHash);
    expect(packSnapshotLegacyHash(snap)).toBe(snap.legacyContentHash);
  });
  it('the legacy hash is what a reader without the plugin layout computed', () => {
    // the old reader found the skill and the .claude/agents persona only
    const old = indexPack({
      name: 'market',
      tree: Object.fromEntries(
        Object.entries(t).filter(
          ([p]) => p.includes('skills/') || p.startsWith('.claude/') || p === 'LICENSE',
        ),
      ),
    });
    expect(snap.legacyContentHash).toBe(packContentHash(old.entries));
  });
  it('a pack without plugin items has none', () => {
    const plain = packSnapshotOf({
      name: 'p',
      ref: 'v1',
      sha: 'a'.repeat(40),
      index: indexPack({
        name: 'p',
        tree: { 'skills/a/SKILL.md': '---\nname: a\ndescription: d\n---\nx\n' },
      }),
    });
    expect(plain.legacyContentHash).toBeUndefined();
  });
  it('items carry their plugin folder as group', () => {
    const g = (k: string) => snap.items.find((i) => i.key === k)?.group;
    expect(g('market:plugins-backend-reviewer')).toBe('backend');
    expect(g('market:api-design')).toBe('backend');
    expect(g('market:root-helper')).toBeUndefined();
  });
});

describe('keys of colliding files', () => {
  const agent = (n: string) => `---\nname: ${n}\ndescription: d\n---\nBody\n`;
  it('come from the whole plugin path, and an unrelated new file renames nothing', () => {
    const base = {
      '.claude-plugin/marketplace.json': '{}',
      'plugins/a/agents/reviewer.md': agent('reviewer'),
      'plugins/b/agents/reviewer.md': agent('reviewer'),
      'plugins/c/agents/other.md': agent('other'),
    };
    const k1 = indexPack({ name: 'p', tree: base }).entries.map((e) => e.key);
    expect(k1).toEqual(expect.arrayContaining(['p:plugins-a-reviewer', 'p:plugins-b-reviewer', 'p:other']));
    const k2 = indexPack({
      name: 'p',
      tree: {
        ...base,
        'plugins/d/agents/third.md': agent('third'),
        'plugins/c/agents/zeta.md': agent('zeta'),
      },
    }).entries.map((e) => e.key);
    for (const k of k1) expect(k2).toContain(k);
  });
  it('never gives two files one key, even for very long paths', () => {
    const long = 'x'.repeat(40);
    const tree: Record<string, string> = { '.claude-plugin/marketplace.json': '{}' };
    for (const p of ['one', 'two'])
      tree[`plugins/${long}-${p}/nested/${long}/agents/${'r'.repeat(30)}.md`] = agent('r');
    // the same key in two deep plugins whose slugs get cut at 64 characters
    for (const p of ['aaa', 'bbb']) tree[`${long}/${long}/${p}/agents/${long}.md`] = agent('r');
    const keys = indexPack({ name: 'p', tree }).entries.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((k) => k.length <= 129)).toBe(true);
  });
});

describe('a huge snapshot stays below what the connection accepts', () => {
  it('shortens file lists when 1000 items with 150 files each would be too big', () => {
    // 1000 skills of 150 files each, built directly (reading that many files would only slow the test down)
    const one = indexPack({
      name: 'big',
      tree: { 'skills/s/SKILL.md': `---\nname: s\ndescription: ${'d'.repeat(1000)}\n---\nx\n` },
    });
    const proto = one.entries[0] as (typeof one.entries)[number];
    const entries = Array.from({ length: 1000 }, (_, i) => ({
      ...proto,
      key: `big:s${i}`,
      files: Object.fromEntries(
        Array.from({ length: 150 }, (_, f) => [`references/a-long-file-name-number-${f}.md`, `x${i}`]),
      ),
    })) as typeof one.entries;
    const index = { ...one, entries };
    expect(index.entries).toHaveLength(1000);
    const snap = packSnapshotOf({ name: 'big', ref: 'v1', sha: 'a'.repeat(40), index });
    expect(JSON.stringify(snap).length).toBeLessThan(PACK_SNAPSHOT_MAX_BYTES);
    expect(JSON.stringify(snap).length).toBeLessThan(8 * 1024 * 1024);
    expect(snap.items).toHaveLength(1000);
    // the hashes still cover everything
    expect(snap.contentHash).toBe(packContentHash(index.entries));
    expect(PackSnapshotSchema.safeParse(snap).success).toBe(true);
  });
});
