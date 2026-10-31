import { describe, expect, it } from 'vitest';
import {
  bumpVersion,
  type ComponentRule,
  compareSemver,
  componentRuleApplies,
  componentRuleProblems,
  normalizeComponentRules,
  patternCaptureGroups,
  readComponentVersion,
  replaceComponentVersion,
} from '../src/repo/component-rules.ts';

const runner: ComponentRule = {
  name: 'runner',
  paths: ['apps/runner/**'],
  versionFile: 'apps/runner/src/version.ts',
  pattern: "RUNNER_VERSION = '(.*)'",
};
const file = "export const RUNNER_VERSION = '0.1.63';\n";

describe('componentRuleApplies', () => {
  it('matches a changed file under a glob', () => {
    const r = componentRuleApplies(runner, ['README.md', 'apps/runner/src/a/b/c.ts']);
    expect(r).toEqual({ applies: true, matched: ['apps/runner/src/a/b/c.ts'] });
  });
  it('does not apply without a match or without files', () => {
    expect(componentRuleApplies(runner, ['apps/server/x.ts']).applies).toBe(false);
    expect(componentRuleApplies(runner, []).applies).toBe(false);
  });
  it('supports several globs and backslash paths', () => {
    const r = { ...runner, paths: ['docs/*.md', 'apps/runner/**'] };
    expect(componentRuleApplies(r, ['docs/a.md']).applies).toBe(true);
    expect(componentRuleApplies(r, ['docs\\sub\\a.md']).applies).toBe(false);
    expect(componentRuleApplies(r, ['apps\\runner\\x.ts']).applies).toBe(true);
  });
});

describe('readComponentVersion', () => {
  it('reads through the pattern', () => {
    expect(readComponentVersion(runner, file)).toMatchObject({ ok: true, version: '0.1.63' });
  });
  it('reports no match, empty and bad pattern', () => {
    expect(readComponentVersion(runner, 'nothing')).toMatchObject({ ok: false, reason: 'no_match' });
    expect(readComponentVersion(runner, "RUNNER_VERSION = ''")).toMatchObject({ ok: false, reason: 'empty' });
    expect(readComponentVersion({ ...runner, pattern: '(' }, file)).toMatchObject({
      ok: false,
      reason: 'bad_pattern',
    });
  });
});

describe('replaceComponentVersion', () => {
  it('patch bumps by default and keeps the rest byte-identical', () => {
    const text = `﻿export const RUNNER_VERSION = '0.1.63';\r\nother = '0.1.63'\r\n`;
    const r = replaceComponentVersion(runner, text);
    expect(r).toMatchObject({ ok: true, from: '0.1.63', to: '0.1.64' });
    if (r.ok) expect(r.text).toBe(text.replace("RUNNER_VERSION = '0.1.63'", "RUNNER_VERSION = '0.1.64'"));
  });
  it('takes an explicit version', () => {
    const r = replaceComponentVersion(runner, file, { version: '0.2.0' });
    expect(r.ok && r.text).toBe("export const RUNNER_VERSION = '0.2.0';\n");
  });
  it('refuses an equal or lower explicit version', () => {
    expect(replaceComponentVersion(runner, file, { version: '0.1.63' })).toMatchObject({
      reason: 'not_higher',
    });
    expect(replaceComponentVersion(runner, file, { version: '0.1.2' })).toMatchObject({
      reason: 'not_higher',
    });
    expect(replaceComponentVersion(runner, file, { version: 'x' })).toMatchObject({
      reason: 'invalid_version',
    });
  });
  it('refuses a current value that is not semver', () => {
    expect(replaceComponentVersion(runner, "RUNNER_VERSION = 'abc'")).toMatchObject({ reason: 'not_semver' });
  });
  it('only changes the first match', () => {
    const r = replaceComponentVersion(runner, "RUNNER_VERSION = '1.0.0'\nRUNNER_VERSION = '1.0.0'\n");
    expect(r.ok && r.text).toBe("RUNNER_VERSION = '1.0.1'\nRUNNER_VERSION = '1.0.0'\n");
  });
});

describe('bumpVersion', () => {
  it('bumps patch, minor, major', () => {
    expect(bumpVersion('1.2.3', 'patch')).toEqual({ ok: true, version: '1.2.4' });
    expect(bumpVersion('1.2.3', 'minor')).toEqual({ ok: true, version: '1.3.0' });
    expect(bumpVersion('1.2.3', 'major')).toEqual({ ok: true, version: '2.0.0' });
  });
  it('handles pre-releases and a v prefix', () => {
    expect(bumpVersion('1.2.3-rc.1', 'patch')).toEqual({ ok: true, version: '1.2.3' });
    expect(bumpVersion('1.2.3-rc.1', 'minor')).toEqual({ ok: true, version: '1.3.0' });
    expect(bumpVersion('v1.2.3', 'patch')).toEqual({ ok: true, version: 'v1.2.4' });
    expect(bumpVersion('v1.2.3', { version: '1.3.0' })).toEqual({ ok: true, version: 'v1.3.0' });
    expect(bumpVersion('1.2.3-rc.1', { version: '1.2.3' })).toEqual({ ok: true, version: '1.2.3' });
  });
});

describe('compareSemver', () => {
  it('orders versions', () => {
    expect(compareSemver('1.2.3', '1.2.4')).toBeLessThan(0);
    expect(compareSemver('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('1.0.0-alpha', '1.0.0')).toBeLessThan(0);
    expect(compareSemver('1.0.0-alpha.2', '1.0.0-alpha.10')).toBeLessThan(0);
    expect(compareSemver('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0);
    expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0);
    expect(compareSemver('nope', '1.0.0')).toBeNull();
  });
});

describe('patternCaptureGroups', () => {
  it('counts groups', () => {
    expect(patternCaptureGroups('abc')).toBe(0);
    expect(patternCaptureGroups("V = '(.*)'")).toBe(1);
    expect(patternCaptureGroups('(a)(?<n>b)')).toBe(2);
    expect(patternCaptureGroups('(?:a)\\(b[(]')).toBe(0);
    expect(patternCaptureGroups('(')).toBeNull();
  });
});

describe('componentRuleProblems', () => {
  const msgs = (r: Partial<ComponentRule>[]) =>
    componentRuleProblems(r.map((x) => ({ ...runner, ...x }))).map((p) => p.message);
  it('accepts the runner rule', () => {
    expect(msgs([{}])).toEqual([]);
  });
  it('names each problem', () => {
    expect(msgs([{ name: ' ' }])[0]).toContain('give the rule a name');
    expect(msgs([{}, { name: 'RUNNER' }])[0]).toContain('another rule already has this name');
    expect(msgs([{ paths: [] }])[0]).toContain('at least one path glob');
    expect(msgs([{ paths: [' '] }])[0]).toContain('at least one path glob');
    expect(msgs([{ paths: ['../x/**'] }])[0]).toContain('cannot contain ".."');
    expect(msgs([{ versionFile: '../v.ts' }])[0]).toContain('cannot contain ".."');
    expect(msgs([{ versionFile: '/etc/v' }])[0]).toContain('version file');
    expect(msgs([{ versionFile: '' }])[0]).toContain('version file');
    expect(msgs([{ pattern: '(' }])[0]).toContain('not a valid regular expression');
    expect(msgs([{ pattern: 'abc' }])[0]).toContain('exactly one capture group');
    expect(msgs([{ pattern: 'abc' }])[0]).toContain('it has 0');
    expect(msgs([{ pattern: '(a)(b)' }])[0]).toContain('it has 2');
  });
  it('reports index and field', () => {
    const p = componentRuleProblems([runner, { ...runner, name: 'b', pattern: 'x' }]);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ index: 1, field: 'pattern' });
  });
});

describe('normalizeComponentRules', () => {
  it('trims and tidies', () => {
    expect(
      normalizeComponentRules([
        { name: ' a ', paths: [' src/ ', ''], versionFile: './v.ts', pattern: '(x)' },
      ]),
    ).toEqual([{ name: 'a', paths: ['src/**'], versionFile: 'v.ts', pattern: '(x)' }]);
  });
});
