import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCS_PREP_STEP_HANDLERS } from '../src/git/release-docs-prep-steps.ts';

/**
 * Release prep runs project commands only through `ctx.exec` (the sandboxed exec of release-docs-prep-exec.ts). No other
 * release-docs-prep module may start a process itself; the in-process `git()` helper (runner plumbing) stays allowed.
 */
const SRC = join(import.meta.dirname, '..', 'src', 'git');
const EXEC = 'release-docs-prep-exec.ts';
const FORBIDDEN: [string, RegExp][] = [
  ['node:child_process', /from\s+['"](node:)?child_process['"]/],
  ['execa', /from\s+['"]execa['"]/],
  ['the runner executor', /from\s+['"]\.\.\/toolchain\/exec(\.ts)?['"]/],
  ['process.execPath', /process\.execPath/],
  ['spawn(', /\bspawn(Sync)?\s*\(/],
  ['execFile(', /\bexecFile(Sync)?\s*\(/],
  ['fork(', /\bfork\s*\(/],
  ['require(', /\brequire\s*\(/],
];

const files = readdirSync(SRC).filter((f) => /^release-docs-prep.*\.ts$/.test(f) && f !== EXEC);

describe('release docs prep: no step spawns a process outside the sandboxed exec', () => {
  it('scans the framework and every step handler', () => {
    const stepFiles = files
      .map((f) => /^release-docs-prep-(.+)\.ts$/.exec(f)?.[1])
      .filter((s): s is string => !!s && s !== 'steps');
    expect(stepFiles.sort()).toEqual(Object.keys(DOCS_PREP_STEP_HANDLERS).sort());
    expect(files).toContain('release-docs-prep.ts');
    expect(files).toContain('release-docs-prep-steps.ts');
  });

  for (const f of files)
    it(`${f} starts no process of its own`, () => {
      const text = readFileSync(join(SRC, f), 'utf8');
      const found = FORBIDDEN.filter(([, re]) => re.test(text)).map(([name]) => name);
      expect(found).toEqual([]);
    });
});
