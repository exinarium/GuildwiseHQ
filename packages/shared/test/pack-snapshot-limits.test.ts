import { describe, expect, it } from 'vitest';
import {
  diffPackSnapshots,
  indexPack,
  PACK_SNAPSHOT_MAX_BYTES,
  packSnapshotOf,
  scriptsMayHaveChanged,
} from '../src/index.ts';

const skillMd = (n: string, d = 'd') => `---\nname: ${n}\ndescription: ${d}\n---\nx\n`;

/** n skills of `files` files each, built directly from one indexed skill (reading that many files would only slow the test). */
function many(n: number, files: number, description: string, scripts = false) {
  const one = indexPack({
    name: 'big',
    tree: { 'skills/s/SKILL.md': skillMd('s', description.slice(0, 1000)) },
  });
  const proto = one.entries[0] as (typeof one.entries)[number];
  const entries = Array.from({ length: n }, (_, i) => ({
    ...proto,
    key: `big:s${i}`,
    ...(scripts ? { hasScripts: true, hash: 'f'.repeat(64) } : {}),
    description,
    files: Object.fromEntries(
      Array.from({ length: files }, (_, f) => [`references/long-file-name-number-${f}.md`, `x${i}`]),
    ),
  })) as typeof one.entries;
  return { ...one, entries };
}

describe('snapshot size', () => {
  it('counts bytes, not characters: multibyte descriptions are cut to fit', () => {
    const index = many(1000, 100, '語'.repeat(1000));
    const snap = packSnapshotOf({ name: 'big', ref: 'v1', sha: 'a'.repeat(40), index });
    const bytes = Buffer.byteLength(JSON.stringify(snap), 'utf8');
    expect(bytes).toBeLessThan(PACK_SNAPSHOT_MAX_BYTES);
    expect(bytes).toBeLessThan(8 * 1024 * 1024);
    expect(snap.trimmed).toBe(true);
    expect(snap.items).toHaveLength(1000);
  }, 60_000);
  it('a pack that fits is not marked trimmed', () => {
    const snap = packSnapshotOf({
      name: 'big',
      ref: 'v1',
      sha: 'a'.repeat(40),
      index: many(5, 3, 'short'),
    });
    expect(snap.trimmed).toBeUndefined();
  });
});

describe('scripts in an update of a large pack', () => {
  it('a capability that has scripts and changed counts as a scripts change even with its file list cut', () => {
    const prev = packSnapshotOf({
      name: 'big',
      ref: 'v1',
      sha: 'a'.repeat(40),
      index: many(1000, 100, '語'.repeat(1000)),
    });
    const nextIndex = many(1000, 100, '語'.repeat(1000), true);
    const next = packSnapshotOf({ name: 'big', ref: 'v2', sha: 'b'.repeat(40), index: nextIndex });
    // no file of the kept lists is a script, yet the flag of the capabilities is
    expect(next.items.every((i) => i.files.every((f) => !f.script))).toBe(true);
    const diff = diffPackSnapshots(prev, next);
    expect(diff.scriptsChanged.length + diff.scriptsAdded.length).toBeGreaterThan(0);
    expect(scriptsMayHaveChanged(diff, prev, next)).toBe(true);
  }, 60_000);
  it('either side being trimmed re-asks about scripts, a plain diff does not', () => {
    const small = packSnapshotOf({ name: 'p', ref: 'v1', sha: 'a'.repeat(40), index: many(2, 2, 'd') });
    const diff = diffPackSnapshots(small, small);
    expect(scriptsMayHaveChanged(diff, small, small)).toBe(false);
    expect(scriptsMayHaveChanged(diff, { trimmed: true }, small)).toBe(true);
    expect(scriptsMayHaveChanged(diff, small, { trimmed: true })).toBe(true);
  });
});

describe('plugin keys and legacy items', () => {
  const agent = (n: string) => `---\nname: ${n}\ndescription: d\n---\nBody ${n}\n`;
  it('a root plugin agent with a key a legacy persona has is dropped; the legacy item is served', () => {
    const r = indexPack({
      name: 'p',
      tree: {
        'personas/guide.md': '---\nname: Guide\ndescription: d\nstance: s\nvoice: v\nicon: i\n---\nLegacy\n',
        '.claude-plugin/plugin.json': '{}',
        'agents/guide.md': agent('guide'),
      },
    });
    const g = r.entries.filter((e) => e.key === 'p:guide');
    expect(g).toHaveLength(1);
    expect(g[0]?.layout).toBeUndefined();
    expect(g[0]?.body).toContain('Legacy');
  });
  it('a plugin agent cannot take the key of a manifest agent', () => {
    const r = indexPack({
      name: 'p',
      tree: {
        'pack.yaml': 'agents:\n  - file: docs-src/x.md\n    key: helper\n',
        'docs-src/x.md': agent('manifest-one'),
        '.claude-plugin/marketplace.json': '{}',
        'plugins/a/agents/helper.md': agent('helper'),
      },
    });
    const keys = r.entries.map((e) => `${e.key}:${e.layout ?? ''}`).sort();
    expect(keys).toContain('p:helper:');
    expect(keys).toContain('p:plugins-a-helper:plugin');
  });
  it('a pack made in the editor never reads the plugin layout', () => {
    const tree = { '.claude-plugin/plugin.json': '{}', 'agents/guide.md': agent('guide') };
    expect(indexPack({ name: 'p', tree }).entries).toHaveLength(1);
    expect(indexPack({ name: 'p', tree, pluginLayout: false }).entries).toHaveLength(0);
  });
});
