import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runnerPaths } from '../src/paths.ts';
import { agentTmpDir, ensureSandbox, sandboxEnv, wipeAgent } from '../src/sandbox/sandbox.ts';
import { cleanupTmp, sh, tmp } from './helpers.ts';

cleanupTmp();
const AGENT = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';

describe('sandbox', () => {
  it('creates home/claude/scratch with the agent git identity', async () => {
    const paths = runnerPaths(tmp());
    const sb = await ensureSandbox(paths, AGENT, 'Ada');
    expect(sb.home).toBe(join(paths.root, 'agents', AGENT, 'home'));
    for (const d of [sb.home, sb.configDir, sb.scratch, sb.tmp]) expect(existsSync(d)).toBe(true);
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

  // Real use: Chromium failed with "Socket path too long" because TMPDIR lived deep under the data dir; Unix socket
  // paths are limited to 108 bytes and Claude Code nests `claude-<uid>` under TMPDIR.
  it.skipIf(process.platform === 'win32')(
    'TMPDIR is a short private dir under /tmp, removed when the agent is wiped',
    async () => {
      const paths = runnerPaths(tmp());
      const id = '019e3f6a-7b1c-7a2d-8c3e-0123456789ab';
      const sb = await ensureSandbox(paths, id, 'Kat');
      expect(sb.tmp).toMatch(/^\/tmp\/aom-[0-9a-f]{10}$/);
      expect(sandboxEnv(sb).TMPDIR).toBe(sb.tmp);
      expect(statSync(sb.tmp).mode & 0o777).toBe(0o700);
      const chromiumSocket = `${sb.tmp}/claude-1000/org.chromium.Chromium.AbC123/SingletonSocket`;
      expect(Buffer.byteLength(chromiumSocket)).toBeLessThan(108);
      // another runner data dir gets a different dir for the same agent id
      expect(agentTmpDir(runnerPaths(tmp()), id)).not.toBe(sb.tmp);
      await wipeAgent(paths, id);
      expect(existsSync(sb.tmp)).toBe(false);
    },
  );
});
