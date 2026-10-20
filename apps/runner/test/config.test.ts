import { statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyOverrides,
  ClaudeRuntimeConfigSchema,
  loadConfig,
  RunnerConfigSchema,
  saveConfig,
} from '../src/config.ts';
import { resolveDataDir, runnerPaths } from '../src/paths.ts';
import { cleanupTmp, makeConfig, tmp } from './helpers.ts';

cleanupTmp();

describe('config', () => {
  it('saves config.json with mode 0600 and round-trips', () => {
    const dir = tmp();
    const path = join(dir, 'sub', 'config.json');
    const cfg = makeConfig('http://x.test');
    saveConfig(path, cfg);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadConfig(path)).toEqual(cfg);
    saveConfig(path, { ...cfg, repoRoots: ['/a'] }); // overwrite keeps 0600
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadConfig(path).repoRoots).toEqual(['/a']);
  });

  it('accounts default to none; a key is validated and never `main`', () => {
    const base = { serverUrl: 'http://x', workstationId: 'w', runnerToken: 'aomr_t' };
    expect(RunnerConfigSchema.parse(base).runtimes['claude-code'].accounts).toEqual([]);
    const ok = ClaudeRuntimeConfigSchema.parse({ accounts: [{ key: 'work' }] });
    expect(ok.accounts).toEqual([{ key: 'work', source: 'config_dir' }]);
    expect(() => ClaudeRuntimeConfigSchema.parse({ accounts: [{ key: 'main' }] })).toThrow();
    expect(() => ClaudeRuntimeConfigSchema.parse({ accounts: [{ key: 'Bad Key' }] })).toThrow();
  });

  it('applies defaults', () => {
    const c = RunnerConfigSchema.parse({ serverUrl: 'http://x', workstationId: 'w', runnerToken: 'aomr_t' });
    expect(c.maxConcurrentShifts).toBe(4);
    expect(c.repoRoots).toEqual([]);
    expect(c.runtimes['claude-code'].bin).toBe('claude');
    expect(c.runtimes.mock).toBeUndefined();
  });

  it('missing config explains how to pair', () => {
    expect(() => loadConfig(join(tmp(), 'nope.json'))).toThrow(/aom-runner pair/);
  });

  it('mock override enables the mock runtime without touching other settings', () => {
    const c = makeConfig('http://x', {
      runtimes: { 'claude-code': ClaudeRuntimeConfigSchema.parse({ bin: 'c' }) },
    });
    expect(applyOverrides(c, { mock: true }).runtimes.mock?.enabled).toBe(true);
    expect(applyOverrides(c, {})).toBe(c);
  });

  it('data dir: flag, then AOM_RUNNER_HOME, then home', () => {
    expect(resolveDataDir('/flag', { AOM_RUNNER_HOME: '/env' })).toBe('/flag');
    expect(resolveDataDir(undefined, { AOM_RUNNER_HOME: '/env' })).toBe('/env');
    expect(resolveDataDir(undefined, {})).toMatch(/aom-runner$/);
    const p = runnerPaths('/d');
    expect(p.worktreePath('TOY', 'TOY-1')).toBe('/d/worktrees/TOY/TOY-1');
    expect(p.agentDir('a')).toBe('/d/agents/a');
  });
});
