import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GUARD_CONFIG_FILE,
  guardDecision,
  markJobStarted,
  readGuardState,
  runGuardHook,
} from '../src/ceo/guard-hook.ts';

const clones = [{ path: '/src/p4', name: 'p4' }];

describe('the use-the-system hook', () => {
  it('blocks the first edit inside a project clone once, then lets edits pass', () => {
    const s0 = { jobStarted: false, nudged: false };
    const a = guardDecision({ path: '/src/p4/app/x.ts' }, { clones }, s0);
    expect(a.block).toContain('aom ceo intake');
    expect(a.block).toContain('aom ceo job start');
    const b = guardDecision({ path: '/src/p4/app/x.ts' }, { clones }, a.state);
    expect(b.block).toBeNull();
  });

  it('ignores paths outside the clones (also a sibling with the same prefix)', () => {
    const s0 = { jobStarted: false, nudged: false };
    expect(guardDecision({ path: '/src/p4-other/x.ts' }, { clones }, s0).block).toBeNull();
    expect(guardDecision({ path: '/home/owner/notes.md' }, { clones }, s0).block).toBeNull();
    expect(guardDecision({ path: undefined }, { clones }, s0).block).toBeNull();
  });

  it('passes everything after `aom ceo job start`', () => {
    expect(
      guardDecision({ path: '/src/p4/a.ts' }, { clones }, { jobStarted: true, nudged: false }).block,
    ).toBeNull();
  });

  it('the hook process: exit 2 with the reason on stderr once, state kept in the turn dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aom-guard-'));
    writeFileSync(join(dir, GUARD_CONFIG_FILE), JSON.stringify({ clones }));
    const hook = (p: string) =>
      runGuardHook(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: p } }), dir);
    const first = hook('/src/p4/a.ts');
    expect(first.exitCode).toBe(2);
    expect(first.stderr).toContain('p4');
    expect(hook('/src/p4/a.ts').exitCode).toBe(0);
    const dir2 = mkdtempSync(join(tmpdir(), 'aom-guard-'));
    writeFileSync(join(dir2, GUARD_CONFIG_FILE), JSON.stringify({ clones }));
    markJobStarted(dir2);
    expect(readGuardState(dir2).jobStarted).toBe(true);
    expect(runGuardHook(JSON.stringify({ tool_input: { file_path: '/src/p4/a.ts' } }), dir2).exitCode).toBe(
      0,
    );
  });

  it('never throws: garbage input or a missing config passes', () => {
    expect(runGuardHook('not json', '/nonexistent').exitCode).toBe(0);
    const dir = mkdtempSync(join(tmpdir(), 'aom-guard-'));
    writeFileSync(join(dir, GUARD_CONFIG_FILE), JSON.stringify({ clones }));
    expect(runGuardHook('not json', dir).exitCode).toBe(0);
  });
});
