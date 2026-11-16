import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectReleaseFormatter,
  formatNotice,
  formatReleaseFiles,
  type ReleaseExec,
  resolveFormatterBinary,
} from '../src/git/release-format.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

function put(dir: string, path: string, text: string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

/** A worktree with `files`, plus a clone whose node_modules/.bin holds an (empty) `tool` program. */
function fixture(files: Record<string, string>, tool: string | null = 'biome') {
  const wt = tmp('aom-fmt-wt-');
  const clone = tmp('aom-fmt-clone-');
  for (const [p, t] of Object.entries(files)) put(wt, p, t);
  if (tool) {
    put(clone, `node_modules/.bin/${tool}`, '#!/bin/sh\nexit 0\n');
    chmodSync(join(clone, 'node_modules/.bin', tool), 0o755);
  }
  return { wt, clone };
}

interface Call {
  cmd: string;
  args: string[];
  cwd: string;
}

/** A scripted exec: records every call; `onRun` may edit files and answers the exit code and output. */
function recorder(
  onRun: (c: Call) => { exitCode: number; stdout?: string; stderr?: string; timedOut?: boolean } = () => ({
    exitCode: 0,
  }),
) {
  const calls: Call[] = [];
  const exec: ReleaseExec = async (cmd, args, o) => {
    const c = { cmd, args, cwd: o.cwd };
    calls.push(c);
    const r = onRun(c);
    return {
      exitCode: r.exitCode,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      timedOut: r.timedOut ?? false,
    };
  };
  return { calls, exec };
}

const linux = 'linux' as const;

describe('detectReleaseFormatter', () => {
  it('finds biome by biome.json or biome.jsonc, before prettier', () => {
    expect(detectReleaseFormatter(fixture({ 'biome.json': '{}' }).wt)?.tool).toBe('biome');
    expect(detectReleaseFormatter(fixture({ 'biome.jsonc': '{}' }).wt)?.tool).toBe('biome');
    expect(detectReleaseFormatter(fixture({ 'biome.json': '{}', '.prettierrc': '{}' }).wt)?.tool).toBe(
      'biome',
    );
  });

  it('finds prettier by its config files or a "prettier" key in package.json', () => {
    expect(detectReleaseFormatter(fixture({ '.prettierrc': '{}' }).wt)?.tool).toBe('prettier');
    expect(detectReleaseFormatter(fixture({ 'prettier.config.mjs': '' }).wt)?.tool).toBe('prettier');
    const pkg = detectReleaseFormatter(fixture({ 'package.json': '{"prettier":{}}' }).wt);
    expect(pkg).toMatchObject({ tool: 'prettier', config: 'package.json' });
  });

  it('answers null when the repository configures neither', () => {
    expect(detectReleaseFormatter(fixture({ 'package.json': '{"name":"x"}' }).wt)).toBeNull();
  });
});

describe('resolveFormatterBinary', () => {
  it("prefers the clone's node_modules/.bin, then the PATH folders, never anything else", () => {
    const { clone } = fixture({}, 'biome');
    const other = tmp('aom-fmt-path-');
    put(other, 'biome', '');
    put(other, 'prettier', '');
    expect(resolveFormatterBinary('biome', clone, [other])).toBe(join(clone, 'node_modules/.bin/biome'));
    expect(resolveFormatterBinary('prettier', clone, ['', other])).toBe(join(other, 'prettier'));
    expect(resolveFormatterBinary('dprint', clone, [other])).toBeNull();
  });
});

describe('formatReleaseFiles', () => {
  const files = ['apps/runner/src/version.ts', 'CHANGELOG.md'];

  it('runs fix then verify on exactly the written files (./ prefixed), in the worktree, with the biome flags', async () => {
    const { wt, clone } = fixture({ 'biome.json': '{}' });
    const { calls, exec } = recorder();
    const r = await formatReleaseFiles({
      worktree: wt,
      files,
      repoPath: clone,
      pathDirs: [],
      exec,
      platform: linux,
    });
    expect(r).toMatchObject({ state: 'passed', tool: 'biome', files, fixed: [] });
    expect(calls).toHaveLength(2);
    const bin = join(clone, 'node_modules/.bin/biome');
    for (const c of calls) {
      expect(c.cmd).toBe(bin);
      expect(c.cwd).toBe(wt);
      expect(c.args.slice(-2)).toEqual(['./apps/runner/src/version.ts', './CHANGELOG.md']);
      expect(c.args.filter((a) => a.startsWith('./'))).toHaveLength(2);
      expect(c.args).toContain('--no-errors-on-unmatched');
    }
    expect(calls[0]?.args.slice(0, 2)).toEqual(['check', '--write']);
    expect(calls[1]?.args).not.toContain('--write');
    const notice = formatNotice(r as Exclude<typeof r, { state: 'failed' }>);
    expect(notice).toContain('Format check: biome ran on apps/runner/src/version.ts, CHANGELOG.md');
    expect(notice).toContain('biome check --write');
    expect(notice).toContain('passed');
  });

  it('uses the prettier flags for a prettier repository', async () => {
    const { wt, clone } = fixture({ '.prettierrc': '{}' }, 'prettier');
    const { calls, exec } = recorder();
    const r = await formatReleaseFiles({
      worktree: wt,
      files: ['package.json'],
      repoPath: clone,
      pathDirs: [],
      exec,
      platform: linux,
    });
    expect(r.state).toBe('passed');
    expect(calls.map((c) => c.args)).toEqual([
      ['--write', '--ignore-unknown', '--no-color', './package.json'],
      ['--check', '--ignore-unknown', '--no-color', './package.json'],
    ]);
  });

  it('reports the files the fix pass changed', async () => {
    const { wt, clone } = fixture({
      'biome.json': '{}',
      'v.ts': "export const V = '1';",
      'CHANGELOG.md': 'x\n',
    });
    const { exec } = recorder((c) => {
      if (c.args.includes('--write')) writeFileSync(join(wt, 'v.ts'), "export const V = '1';\n");
      return { exitCode: 0 };
    });
    const r = await formatReleaseFiles({
      worktree: wt,
      files: ['v.ts', 'CHANGELOG.md'],
      repoPath: clone,
      pathDirs: [],
      exec,
      platform: linux,
    });
    expect(r).toMatchObject({ state: 'passed', fixed: ['v.ts'] });
    expect(formatNotice(r as Exclude<typeof r, { state: 'failed' }>)).toContain('it fixed v.ts');
  });

  it('fails when verify fails, naming the files in its output and quoting it', async () => {
    const { wt, clone } = fixture({ 'biome.json': '{}' });
    const { exec } = recorder((c) =>
      c.args.includes('--write')
        ? { exitCode: 1 }
        : { exitCode: 1, stdout: '\u001b[31mapps/runner/src/version.ts:1:1 lint/x  boom\u001b[0m' },
    );
    const r = await formatReleaseFiles({
      worktree: wt,
      files,
      repoPath: clone,
      pathDirs: [],
      exec,
      platform: linux,
    });
    expect(r).toMatchObject({ state: 'failed', tool: 'biome', failing: ['apps/runner/src/version.ts'] });
    if (r.state !== 'failed') throw new Error('unreachable');
    expect(r.output).toBe('apps/runner/src/version.ts:1:1 lint/x  boom');
    expect(r.commands[1]).toContain('biome check');
  });

  it('names every written file when the output names none, and fails on a timeout or a thrown exec', async () => {
    const { wt, clone } = fixture({ 'biome.json': '{}' });
    const timedOut = await formatReleaseFiles({
      worktree: wt,
      files,
      repoPath: clone,
      pathDirs: [],
      exec: recorder(() => ({ exitCode: 0, timedOut: true })).exec,
      platform: linux,
    });
    expect(timedOut).toMatchObject({ state: 'failed', failing: files });
    const thrown = await formatReleaseFiles({
      worktree: wt,
      files,
      repoPath: clone,
      pathDirs: [],
      exec: async () => {
        throw new Error('spawn failed');
      },
      platform: linux,
    });
    expect(thrown).toMatchObject({ state: 'failed', output: 'spawn failed' });
  });

  it('skips with a reason: no config, no binary, no exec, Windows, no files', async () => {
    const { calls, exec } = recorder();
    const none = fixture({});
    const base = { files, pathDirs: [], exec, platform: linux };
    const noConfig = await formatReleaseFiles({ ...base, worktree: none.wt, repoPath: none.clone });
    expect(noConfig).toEqual({
      state: 'skipped',
      reason: 'the repository has no biome or prettier configuration',
    });
    expect(formatNotice(noConfig as { state: 'skipped'; reason: string })).toBe(
      'Format check skipped: the repository has no biome or prettier configuration.',
    );
    const noBin = fixture({ 'biome.json': '{}' }, null);
    const missing = await formatReleaseFiles({ ...base, worktree: noBin.wt, repoPath: noBin.clone });
    expect(missing.state).toBe('skipped');
    expect(missing.state === 'skipped' && missing.reason).toContain(
      `no biome program was found in ${join(noBin.clone, 'node_modules', '.bin')} or on the toolchain PATH`,
    );
    const f = fixture({ 'biome.json': '{}' });
    const { exec: _e, ...noExec } = base;
    expect(await formatReleaseFiles({ ...noExec, worktree: f.wt, repoPath: f.clone })).toMatchObject({
      state: 'skipped',
      reason: 'this runner cannot run programs for the release commit',
    });
    expect(
      (await formatReleaseFiles({ ...base, platform: 'win32', worktree: f.wt, repoPath: f.clone })).state,
    ).toBe('skipped');
    expect((await formatReleaseFiles({ ...base, files: [], worktree: f.wt, repoPath: f.clone })).state).toBe(
      'skipped',
    );
    expect(calls).toHaveLength(0);
  });

  it('keeps a long notice within 500 characters', () => {
    const many = Array.from(
      { length: 40 },
      (_, i) => `packages/component-${i}/a-rather-long/version-file.json`,
    );
    const n = formatNotice({
      state: 'passed',
      tool: 'biome',
      commands: ['biome check'],
      files: many,
      fixed: many,
    });
    expect(n.length).toBeLessThanOrEqual(500);
    expect(n).toContain('and 35 more');
  });
});

// The repository's own biome and biome.json: what the release commit of this repository runs.
const repoRoot = resolve(__dirname, '../../..');
const realBiome = join(repoRoot, 'node_modules/.bin/biome');

describe.skipIf(!existsSync(realBiome))('formatReleaseFiles with the real biome', () => {
  it("adds the version file's missing final newline and passes; CHANGELOG.md is skipped by the config", async () => {
    const wt = tmp('aom-fmt-real-');
    copyFileSync(join(repoRoot, 'biome.json'), join(wt, 'biome.json'));
    put(wt, 'apps/runner/src/version.ts', "export const RUNNER_VERSION = '0.1.77';");
    put(wt, 'CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n');
    const exec: ReleaseExec = async (cmd, args, o) => {
      try {
        const stdout = execFileSync(cmd, args, { cwd: o.cwd, encoding: 'utf8', stdio: 'pipe' });
        return { exitCode: 0, stdout, stderr: '', timedOut: false };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { exitCode: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '', timedOut: false };
      }
    };
    const r = await formatReleaseFiles({
      worktree: wt,
      files: ['apps/runner/src/version.ts', 'CHANGELOG.md'],
      repoPath: repoRoot,
      pathDirs: [],
      exec,
      platform: linux,
    });
    expect(r).toMatchObject({ state: 'passed', tool: 'biome', fixed: ['apps/runner/src/version.ts'] });
    expect(readFileSync(join(wt, 'apps/runner/src/version.ts'), 'utf8')).toBe(
      "export const RUNNER_VERSION = '0.1.77';\n",
    );
    expect(readFileSync(join(wt, 'CHANGELOG.md'), 'utf8')).toBe('# Changelog\n\n## [Unreleased]\n');
  }, 60_000);

  it('fails on a lint error it cannot fix, naming the file', async () => {
    const wt = tmp('aom-fmt-real-');
    copyFileSync(join(repoRoot, 'biome.json'), join(wt, 'biome.json'));
    put(wt, 'v.ts', 'export const V = 1 == 2;\n');
    const exec: ReleaseExec = async (cmd, args, o) => {
      try {
        const stdout = execFileSync(cmd, args, { cwd: o.cwd, encoding: 'utf8', stdio: 'pipe' });
        return { exitCode: 0, stdout, stderr: '', timedOut: false };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { exitCode: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '', timedOut: false };
      }
    };
    const r = await formatReleaseFiles({
      worktree: wt,
      files: ['v.ts'],
      repoPath: repoRoot,
      pathDirs: [],
      exec,
      platform: linux,
    });
    expect(r).toMatchObject({ state: 'failed', failing: ['v.ts'] });
  }, 60_000);
});
