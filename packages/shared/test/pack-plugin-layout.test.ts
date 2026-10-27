import { describe, expect, it } from 'vitest';
import {
  commandToPlaybookFiles,
  indexPack,
  MAX_PACK_ITEMS,
  PackSnapshotSchema,
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
      'market:backend-reviewer',
      'market:claude-one',
      'market:frontend-reviewer',
      'market:root-helper',
    ]);
    const helper = r.entries.find((e) => e.key === 'market:root-helper');
    expect(helper?.kind === 'persona' && helper.meta.tools).toEqual(['Read', 'Grep']);
    expect(helper?.kind === 'persona' && helper.meta.model).toBe('sonnet');
    expect(r.entries.find((e) => e.key === 'market:backend-reviewer')?.description).toBe(
      'Reviews backend code.',
    );
  });

  it('reads commands/*.md at any depth as one-step playbooks', () => {
    expect(keys(r, 'playbook')).toEqual([
      'market:backend-deploy',
      'market:frontend-deploy',
      'market:hello',
      'market:lint',
    ]);
    const pb = r.entries.find((e) => e.key === 'market:backend-deploy');
    expect(pb?.kind === 'playbook' && pb.steps).toEqual(['steps/step-01-backend-deploy.md']);
    expect(pb?.description).toBe('Deploy the service');
    const step = pb?.files['steps/step-01-backend-deploy.md'] ?? '';
    expect(step).toContain('Run the thing on $ARGUMENTS.');
    // the command's own frontmatter (allowed-tools) is dropped, never copied
    expect(step).not.toContain('allowed-tools');
    // no frontmatter: description comes from the text
    expect(r.entries.find((e) => e.key === 'market:frontend-deploy')?.description).toBe(
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
    expect(keys(r, 'playbook')).toContain('wsh:plugin-7-status');
    expect(r.entries.length).toBeLessThanOrEqual(MAX_PACK_ITEMS);
    const snap = packSnapshotOf({ name: 'wsh', ref: 'main', sha: 'a'.repeat(40), index: r });
    expect(PackSnapshotSchema.safeParse(snap).success).toBe(true);
    expect(snap.items).toHaveLength(r.entries.length);
    expect(JSON.stringify(snap).length).toBeLessThan(2 * 1024 * 1024);
  });
});
