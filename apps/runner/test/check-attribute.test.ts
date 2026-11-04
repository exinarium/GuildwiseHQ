import { describe, expect, it } from 'vitest';
import { attribute } from '../src/checks/attribute.ts';

const files = new Set([
  'apps/server/src/x.ts',
  'apps/server/src/other.ts',
  'src/a.ts',
  'src/b.ts',
  'Foo/Bar.cs',
  'pkg',
  'apps/server',
]);
const exists = (rel: string) => files.has(rel);
const base = { cwd: '.', exists, argv: ['pnpm', 'lint'] };
const changed = (...p: string[]) => new Set(p);

describe('attribute', () => {
  it('Biome: a line naming a changed file is introduced, another existing file is elsewhere', () => {
    const out = [
      'apps/server/src/x.ts:12:3 lint/style/useConst  FIXABLE ━━━━━━━━',
      '  ! Use const',
      'apps/server/src/other.ts:1:1 lint/correctness/noUnusedImports ━━━━',
      'Checked 10 files. Found 2 errors.',
    ].join('\n');
    const r = attribute(out, { ...base, changed: changed('apps/server/src/x.ts') });
    expect(r.introduced).toEqual(['apps/server/src/x.ts:12:3 lint/style/useConst  FIXABLE ━━━━━━━━']);
    expect(r.elsewhere).toHaveLength(1);
    expect(r.introducedCount).toBe(1);
    expect(r.elsewhereCount).toBe(1);
    expect(r.incomplete).toBeUndefined();
  });

  it('Biome output cut by the tool is incomplete, with the hint', () => {
    const r = attribute(
      'src/a.ts:1:1 lint\nThe number of diagnostics exceeds the number allowed by Biome.\nDiagnostics not shown: 120.',
      {
        ...base,
        changed: changed(),
      },
    );
    expect(r.incomplete).toContain('--max-diagnostics=none');
  });

  it('a recursive run without --no-bail is incomplete; with it, not', () => {
    const o = { ...base, changed: changed() };
    expect(attribute('', { ...o, argv: ['pnpm', '-r', 'typecheck'] }).incomplete).toContain('--no-bail');
    expect(
      attribute('', { ...o, argv: ['pnpm', '-r', '--no-bail', 'typecheck'] }).incomplete,
    ).toBeUndefined();
  });

  it('a capture that hit the cap is incomplete', () => {
    expect(attribute('', { ...base, changed: changed(), capped: true }).incomplete).toContain('2 MiB');
  });

  it('tsc: file(line,col) form', () => {
    const r = attribute("src/a.ts(3,5): error TS2322: Type 'x' is not assignable.", {
      ...base,
      changed: changed('src/a.ts'),
    });
    expect(r.introducedCount).toBe(1);
  });

  it('pnpm recursive prefix: the package folder is prepended', () => {
    const r = attribute('apps/server typecheck: src/x.ts(1,1): error TS1', {
      ...base,
      changed: changed('apps/server/src/x.ts'),
    });
    expect(r.introduced).toHaveLength(1);
    const e = attribute('apps/server typecheck: src/other.ts(1,1): error TS1', {
      ...base,
      changed: changed('apps/server/src/x.ts'),
    });
    expect(e.elsewhere).toHaveLength(1);
    expect(e.introduced).toHaveLength(0);
  });

  it('the suite folder is prepended', () => {
    const r = attribute('src/x.ts:1:1 bad', {
      ...base,
      cwd: 'apps/server',
      changed: changed('apps/server/src/x.ts'),
    });
    expect(r.introducedCount).toBe(1);
  });

  it('ESLint stylish: the absolute header names the file', () => {
    const out =
      '/work/wt/src/a.ts\n  12:3  error  Unexpected any  no-explicit-any\n\n/work/wt/src/b.ts\n  1:1  error  x  y';
    const r = attribute(out, { ...base, worktree: '/work/wt', changed: changed('src/a.ts') });
    expect(r.introduced).toEqual(['/work/wt/src/a.ts']);
    expect(r.elsewhere).toEqual(['/work/wt/src/b.ts']);
  });

  it('Prettier [warn] lines', () => {
    const r = attribute('[warn] src/a.ts\n[warn] Code style issues found in 2 files.', {
      ...base,
      changed: changed('src/a.ts'),
    });
    expect(r.introduced).toEqual(['[warn] src/a.ts']);
  });

  it('ruff', () => {
    const r = attribute('src/a.ts:1:1: F401 `os` imported but unused', {
      ...base,
      changed: changed('src/a.ts'),
    });
    expect(r.introducedCount).toBe(1);
  });

  it('dotnet format: absolute paths with (line,col)', () => {
    const r = attribute('/work/wt/Foo/Bar.cs(10,5): error WHITESPACE: Fix whitespace formatting.', {
      ...base,
      worktree: '/work/wt',
      changed: changed('Foo/Bar.cs'),
    });
    expect(r.introducedCount).toBe(1);
  });

  it('ANSI colours are stripped', () => {
    const r = attribute('\u001b[31msrc/a.ts\u001b[0m:1:1 bad', { ...base, changed: changed('src/a.ts') });
    expect(r.introduced).toEqual(['src/a.ts:1:1 bad']);
  });

  it('a token that is not a file is ignored', () => {
    const r = attribute('See https://biomejs.dev/linter for rules\nversion 1.2.3', {
      ...base,
      changed: changed('src/a.ts'),
    });
    expect(r.introducedCount + r.elsewhereCount).toBe(0);
  });

  it('keeps 20 lines per list and the full count; de-duplicates lines', () => {
    const many = Array.from({ length: 30 }, (_, i) => `src/a.ts:${i}:1 bad`).join('\n');
    const r = attribute(`${many}\n${many}`, { ...base, changed: changed('src/a.ts') });
    expect(r.introduced).toHaveLength(20);
    expect(r.introducedCount).toBe(30);
  });
});
