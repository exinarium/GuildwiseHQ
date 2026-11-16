import { describe, expect, it } from 'vitest';
import { attribute } from '../src/checks/attribute.ts';

const files = new Set([
  'src/a.ts',
  'src/my file.ts',
  'apps/web',
  'apps/web/src/my file.ts',
  'e2e',
  'e2e/tests/x.spec.ts',
]);
const base = { cwd: '.', exists: (r: string) => files.has(r), argv: ['pnpm', 'lint'] };
const run = (out: string, changed: string[] = [], extra = {}) =>
  attribute(out, { ...base, changed: new Set(changed), ...extra });
const paths = (out: string, changed: string[] = [], extra = {}) =>
  run(out, changed, extra).findings.flatMap((f) => f.paths);
const esc = '\u001b[';

describe('attribute: paths with spaces', () => {
  it('a bare path line with spaces and no line number is attributed', () => {
    const r = run('src/my file.ts', ['src/my file.ts']);
    expect(r.introduced).toEqual(['src/my file.ts']);
    expect(r.unattributed).toBe(0);
  });

  it('a stylish header (relative and absolute) with spaces is attributed', () => {
    const out = 'src/my file.ts\n  12:3  error  no-var  no-var';
    expect(paths(out)).toEqual(['src/my file.ts']);
    const abs = '/work/wt/src/my file.ts\n  12:3  error  no-var  no-var';
    expect(paths(abs, [], { worktree: '/work/wt' })).toEqual(['src/my file.ts']);
  });

  it('a stylish header under pnpm -r is attributed through the package folder', () => {
    expect(paths('apps/web lint: /work/wt/apps/web/src/my file.ts', [], { worktree: '/work/wt' })).toEqual([
      'apps/web/src/my file.ts',
    ]);
  });

  it('with ANSI colours around the path', () => {
    expect(paths(`${esc}4m${esc}1msrc/my file.ts${esc}0m`)).toEqual(['src/my file.ts']);
  });

  it('a spaced path with a line number is attributed when the file exists, unattributed when it does not', () => {
    expect(paths('src/my file.ts:3:1 lint/y')).toEqual(['src/my file.ts']);
    const r = run('src/no such.ts:3:1 lint/y');
    expect(r.findings).toEqual([]);
    expect(r.unattributed).toBe(1);
  });

  it('regression: plain paths, :line, :line:col, mypy and gcc lines are unchanged', () => {
    expect(paths('src/a.ts')).toEqual(['src/a.ts']);
    expect(paths('src/a.ts:3 x')).toEqual(['src/a.ts']);
    expect(paths('src/a.ts:3:5 x')).toEqual(['src/a.ts']);
    expect(paths('src/a.ts:3: error: Incompatible types')).toEqual(['src/a.ts']);
    expect(paths('src/a.ts:3:5: error: x')).toEqual(['src/a.ts']);
  });
});

describe('attribute: code frames', () => {
  const frames = [
    '> 12 │ goto("https://example.com:443/x")',
    '12 | goto("http://127.0.0.1:3000/src/a.ts")',
    '│   ^^^^',
    '|     ^',
    '12 12 │ const u = "http://127.0.0.1:3000";',
    '^^^^',
    '~~~~',
  ];
  for (const prefix of ['', 'e2e lint: ', 'apps/web lint: ']) {
    it(`frame lines are skipped (prefix "${prefix}")`, () => {
      for (const f of frames) {
        const r = run(`${prefix}  ${f}`, ['src/a.ts']);
        expect(r.findings, f).toEqual([]);
        expect(r.unattributed, f).toBe(0);
      }
    });
  }

  it('a URL outside a frame is not a file or a location', () => {
    const r = run('see http://127.0.0.1:3000/src/a.ts for details');
    expect(r.findings).toEqual([]);
    expect(r.unattributed).toBe(0);
  });

  it('ANSI colours around the prefix and the gutter do not break the skip', () => {
    const r = run(
      `${esc}36me2e lint:${esc}0m ${esc}31m> 12 │${esc}0m goto("http://127.0.0.1:3000/src/a.ts")`,
    );
    expect(r.findings).toEqual([]);
    expect(r.unattributed).toBe(0);
  });

  it('a real finding next to a frame under the prefix is still attributed', () => {
    const out = 'e2e lint: src/a.ts:1:1 lint/x\ne2e lint:   > 1 | const a = "http://h:1/";';
    expect(paths(out, ['src/a.ts'])).toEqual(['src/a.ts']);
  });
});
