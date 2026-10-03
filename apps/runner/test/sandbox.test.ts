import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runnerPaths } from '../src/paths.ts';
import { ensureSandbox, sandboxEnv, wipeAgent } from '../src/sandbox/sandbox.ts';
import { cleanupTmp, sh, tmp } from './helpers.ts';

cleanupTmp();
const AGENT = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';

describe('sandbox', () => {
  it('creates home/claude/scratch with the agent git identity', async () => {
    const paths = runnerPaths(tmp());
    const sb = await ensureSandbox(paths, AGENT, 'Ada');
    expect(sb.home).toBe(join(paths.root, 'agents', AGENT, 'home'));
    for (const d of [sb.home, sb.configDir, sb.scratch]) expect(existsSync(d)).toBe(true);
    const gitconfig = readFileSync(join(sb.home, '.gitconfig'), 'utf8');
    expect(gitconfig).toContain('name = Ada (aom)');
    expect(gitconfig).toContain(`email = ${AGENT}@agents.aom.invalid`);

    const env = sandboxEnv(sb);
    expect(env).toMatchObject({ HOME: sb.home, USERPROFILE: sb.home, CLAUDE_CONFIG_DIR: sb.configDir });
    // git picks the identity up from the sandbox environment
    const repo = tmp();
    sh(repo, 'git', ['init', '-b', 'main']);
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('git', ['config', 'user.name'], {
      cwd: repo,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('Ada (aom)');
  });

  it('is idempotent and agent.wipe removes the directory idempotently', async () => {
    const paths = runnerPaths(tmp());
    await ensureSandbox(paths, AGENT, 'Ada');
    await ensureSandbox(paths, AGENT, 'Ada Renamed');
    expect(readFileSync(join(paths.agentDir(AGENT), 'home', '.gitconfig'), 'utf8')).toContain(
      'Ada Renamed (aom)',
    );
    expect(await wipeAgent(paths, AGENT)).toEqual({ removed: true });
    expect(existsSync(paths.agentDir(AGENT))).toBe(false);
    expect(await wipeAgent(paths, AGENT)).toEqual({ removed: false });
  });
});
