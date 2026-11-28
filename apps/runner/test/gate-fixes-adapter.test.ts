import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeCommand, ClaudeCodeAdapter, writeLaunchSettings } from '../src/adapters/claude-code.ts';
import { inside } from '../src/adapters/claude-policy.ts';
import type { DevopsGuardInput, RuntimeEvent } from '../src/adapters/types.ts';
import { ClaudeRuntimeConfigSchema } from '../src/config.ts';
import { classifyCommand, type GuardConfig } from '../src/devops/guard.ts';
import { scratchCloneNote } from '../src/git/scratch-clone.ts';
import { runnerPaths } from '../src/paths.ts';
import { ensureSandbox } from '../src/sandbox/sandbox.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

/**
 * gate-fixes-1, the claude-code adapter's part: F1 (the inner box's launch-only settings file), F3 (the outer guard's Docker
 * bit only lowers the access; only the switch opens Docker there) and F4 (a working @mention can commit: its card's git dir
 * is never a read-only folder as well).
 */
const A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const role = (key: string) => {
  const r = BUILTIN_ROLES.find((x) => x.key === key);
  if (!r) throw new Error(key);
  return r;
};
afterEach(() => {
  delete process.env.AOM_CLAUDE_SMOKE;
});

describe('F1: the launch-only settings of a runner-built inner box', () => {
  it('written beside the config dir and passed with --settings after the user settings', () => {
    const t = tmp();
    const configDir = join(t, 'config', 'inner', 'req-1');
    const file = writeLaunchSettings(`${configDir}.launch`, {
      permissions: { blockFileToolReadsOutsideWorkingDirectories: true },
    });
    expect(file).toBe(join(`${configDir}.launch`, 'settings.json'));
    expect(JSON.parse(readFileSync(file as string, 'utf8'))).toEqual({
      permissions: { blockFileToolReadsOutsideWorkingDirectories: true },
    });
    expect(writeLaunchSettings(join(t, 'none'), undefined)).toBeUndefined();
    expect(existsSync(join(t, 'none'))).toBe(false);
    const input = {
      prompt: 'go',
      sandbox: { configDir, home: join(t, 'h'), scratch: t, tmp: t },
      agent: { model: 'sonnet', isDevops: true, permissions: role('devops').permissions },
      env: {},
      addDirs: [],
    } as never;
    const cfg = { bin: 'claude', authMode: 'default', sandbox: 'off' } as never;
    const args = buildClaudeCommand(input, cfg, { launchSettings: file as string }).args;
    const i = args.indexOf('--settings');
    expect(args[i + 1]).toBe(file);
    expect(args.indexOf('--setting-sources')).toBeLessThan(i);
    expect(buildClaudeCommand(input, cfg).args).not.toContain('--settings');
  });
});

describe('F3: the outer box guard', () => {
  const guardFor = (
    access: DevopsGuardInput['access'],
    route: unknown,
    extra: Partial<DevopsGuardInput> = {},
  ) => {
    const t = tmp();
    const paths = runnerPaths(join(t, 'data'));
    const adapter = new ClaudeCodeAdapter(ClaudeRuntimeConfigSchema.parse({ sandbox: 'off' }), paths);
    const g = (
      adapter as unknown as {
        devopsGuard: (
          d: string,
          g: DevopsGuardInput,
          k: 'shift',
          s: undefined,
          r: unknown,
        ) => { cfg: GuardConfig } | undefined;
      }
    ).devopsGuard(
      join(t, 'g'),
      { sessionRef: 's1', approvedCommands: ['docker ps'], access, ...extra },
      'shift',
      undefined,
      route,
    );
    if (!g) throw new Error('no guard');
    return g.cfg;
  };
  const on = { allowInstall: false, allowDocker: true, allowedPaths: [] };
  const off = { ...on, allowDocker: false };

  it('the Docker bit is the access AND the gatekeeper; only the switch opens it (an approved command does not)', () => {
    expect(guardFor(on, { kind: 'outer', docker: true }).access?.allowDocker).toBe(true);
    expect(guardFor(on, { kind: 'outer', docker: false }).access?.allowDocker).toBe(false);
    expect(guardFor(off, { kind: 'outer', docker: true }).access?.allowDocker).toBe(false);
    const g = guardFor(off, { kind: 'outer', docker: false });
    expect(g.dockerSwitchOnly).toBe(true);
    expect(classifyCommand('docker ps', g, '/tmp', {})).toMatchObject({
      decision: 'refused',
      rule: 'docker_off',
    });
    // the unboxed fallback of a request session never gets Docker
    const bk = guardFor(on, { kind: 'none' });
    expect(bk.access?.allowDocker).toBe(false);
    // chats and release prep: as before
    expect(guardFor(on, undefined).access?.allowDocker).toBe(true);
    expect(guardFor(on, undefined).dockerSwitchOnly).toBeUndefined();
  });

  it('an unavailable Docker is carried into the guard with its reason', () => {
    const g = guardFor(
      on,
      { kind: 'outer', docker: false },
      { dockerUnavailable: 'no Docker daemon was found on this computer' },
    );
    expect(g.dockerUnavailable).toBe('no Docker daemon was found on this computer');
    expect(classifyCommand('docker ps', g, '/tmp', {}).rule).toBe('docker_unavailable');
  });
});

describe('F1: the scratch clone note', () => {
  it('tells the model to run git with -C, not cd plus git', () => {
    const n = scratchCloneNote('/r/agents/a/devops/q/clone', 'main');
    expect(n).toContain('git -C /r/agents/a/devops/q/clone status');
    expect(n).toContain('not `cd /r/agents/a/devops/q/clone && git ...`');
  });
});

describe('F4: a working @mention commits in the card worktree', () => {
  it("the card's git dir is writable and under no denyWrite; the main clone is split off; --add-dir keeps it", async () => {
    const t = tmp();
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@x.test',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@x.test',
    };
    const repo = join(t, 'repos', 'toy');
    mkdirSync(repo, { recursive: true });
    spawnSync('git', ['init', '-q', '-b', 'main', repo], { env: gitEnv });
    spawnSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'i'], { env: gitEnv });
    const cwd = join(t, 'data', 'worktrees', 'P4-98eeafb0', 'P4-3');
    mkdirSync(join(t, 'data', 'worktrees', 'P4-98eeafb0'), { recursive: true });
    spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'P4-3', cwd], { env: gitEnv });
    const common = resolve(repo, '.git');
    const admin = join(common, 'worktrees', 'P4-3');
    const bin = join(t, 'fakeclaude');
    writeFileSync(bin, `#!/bin/sh\necho "$@" > "${join(t, 'args.txt')}"\necho '{"type":"system"}'\nexit 0\n`);
    chmodSync(bin, 0o755);
    const paths = runnerPaths(join(t, 'data'));
    const sandbox = await ensureSandbox(paths, A, 'Ada');
    const adapter = new ClaudeCodeAdapter(
      ClaudeRuntimeConfigSchema.parse({ bin, sandbox: 'best_effort' }),
      paths,
    );
    process.env.AOM_CLAUDE_SMOKE = '1';
    const s = await adapter.startChat({
      chatId: 'c1',
      message: 'append a line and commit',
      cwd,
      sandbox,
      // the project's own clone is one of the chat's read-only folders (as on a runner with an organization folder)
      readDirs: [repo],
      env: {},
      readOnly: false,
      work: true,
      agent: {
        agentId: A,
        name: 'Rex',
        roleKey: 'builder',
        seniority: 'senior',
        runtime: 'claude-code',
        model: 'sonnet',
        skills: [],
        permissions: role('builder').permissions,
        isDevops: false,
      },
    } as never);
    const ev: RuntimeEvent[] = [];
    for await (const e of s.events()) ev.push(e);
    const settings = JSON.parse(readFileSync(join(sandbox.configDir, 'settings.json'), 'utf8'));
    const fs = settings.sandbox.filesystem as { allowWrite: string[]; denyWrite: string[] };
    expect(fs.allowWrite).toContain(common);
    // nothing equal to or above the git dir or the card's admin dir is denied (only files and folders inside it)
    for (const d of fs.denyWrite) {
      const r = resolve(d);
      expect(r === common || inside(common, r), `denyWrite ${d} covers ${common}`).toBe(false);
      expect(r === admin || inside(admin, r), `denyWrite ${d} covers ${admin}`).toBe(false);
    }
    // the HEAD files are read-only: a mention never switches the card's or the owner's branch
    expect(fs.denyWrite).toEqual(expect.arrayContaining([join(common, 'HEAD'), join(admin, 'HEAD')]));
    expect(settings.permissions.additionalDirectories).not.toContain(repo);
    // the card's git metadata stays readable to the file tools
    const args = readFileSync(join(t, 'args.txt'), 'utf8');
    expect(args).toContain(`--add-dir ${common}`);
    // REVIEW B1: the own main clone is never an added directory (Claude Code opens one writable) and never writable
    const added = args
      .trim()
      .split(/\s+/)
      .flatMap((a, i, all) => (a === '--add-dir' ? [all[i + 1]] : []));
    expect(added).toContain(common);
    expect(added).not.toContain(repo);
    expect(fs.allowWrite).not.toContain(repo);
  });
});
