import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
  buildClaudeChatCommand,
  buildClaudeCommand,
  buildClaudeOwnerTurnCommand,
} from '../src/adapters/claude-code.ts';
import {
  buildCeoSettings,
  buildChatSettings,
  buildShiftSettings,
  type ClaudePolicyContext,
  isReadOnlyWorktreeRole,
  ruleAbs,
  scanSandboxBlock,
} from '../src/adapters/claude-policy.ts';
import type { ChatStartInput, OwnerTurnInput, ShiftStartInput } from '../src/adapters/types.ts';
import { ClaudeRuntimeConfigSchema } from '../src/config.ts';
import { SHIFT_ENV_POINTER, sessionEnvDirOf, sessionEnvRoot } from '../src/session/shift-credential.ts';
import { POLICY_PATHS, policyCtx } from './policy-fixtures.ts';

const builder = BUILTIN_ROLES.find((r) => r.key === 'builder');
const ceo = BUILTIN_ROLES.find((r) => r.key === 'ceo');
const readOnlyRole = BUILTIN_ROLES.find((r) => r.key !== 'ceo' && isReadOnlyWorktreeRole(r.permissions));
if (!builder || !ceo || !readOnlyRole) throw new Error('roles');

type Fs = { allowRead: string[]; denyRead: string[] };
const within = (dir: string, p: string) =>
  p === dir || p.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
/** The OS sandbox's read decision for a path: an allowRead entry beats a denyRead entry. */
const shellCanRead = (fs: Fs, path: string): boolean => {
  if (fs.allowRead.some((a) => within(a, path))) return true;
  return !fs.denyRead.some((d) => within(d, path));
};

describe('session env dir in the sandbox read allow-list', () => {
  const root = '/data';
  const dirA = `${root}/session-env/shift-a.0a0a0a0a`;
  const dirB = `${root}/session-env/shift-b.0b0b0b0b`;

  it.each([
    [
      'shift',
      (c: ClaudePolicyContext) => buildShiftSettings(builder.permissions, c, POLICY_PATHS, 'builder'),
    ],
    ['chat', (c: ClaudePolicyContext) => buildChatSettings(false, [], c, POLICY_PATHS)],
    ['ceo', (c: ClaudePolicyContext) => buildCeoSettings(c, POLICY_PATHS)],
  ])('%s settings open only the session own dir and never let an agent write session-env', (_k, build) => {
    const s = build(policyCtx({ sessionEnvDir: dirA }));
    const fs = s.sandbox?.filesystem;
    expect(fs?.allowRead).toContain(dirA);
    expect(fs?.allowRead.filter((p) => p.startsWith(sessionEnvRoot(root)))).toEqual([dirA]);
    expect(fs?.denyWrite).toContain(sessionEnvRoot(root));
    expect(s.permissions.deny).toContain(`Read(${ruleAbs(sessionEnvRoot(root))}/**)`);
  });

  it('without a session env dir the settings are the same as before, apart from the private entry', () => {
    const a = buildShiftSettings(builder.permissions, policyCtx(), POLICY_PATHS, 'builder');
    const b = buildShiftSettings(
      builder.permissions,
      policyCtx({ sessionEnvDir: undefined }),
      POLICY_PATHS,
      'builder',
    );
    expect(b).toEqual(a);
    expect(a.sandbox?.filesystem.allowRead.some((p) => p.includes('session-env'))).toBe(false);
  });

  it("a second agent's shell cannot read the first session's file; the first can", () => {
    const fileA = `${dirA}/env.json`;
    const a = buildShiftSettings(
      builder.permissions,
      policyCtx({ sessionEnvDir: dirA }),
      POLICY_PATHS,
      'builder',
    );
    const b = buildShiftSettings(
      builder.permissions,
      policyCtx({
        sessionEnvDir: dirB,
        agentDir: '/data/agents/b2',
        cwd: '/data/worktrees/TOY-0192abcd/TOY-2',
      }),
      {
        ...POLICY_PATHS,
        home: '/data/agents/b2/home',
        scratch: '/data/agents/b2/scratch',
        tmp: '/data/agents/b2/tmp',
      },
      'builder',
    );
    expect(shellCanRead(a.sandbox?.filesystem as Fs, fileA)).toBe(true);
    expect(shellCanRead(b.sandbox?.filesystem as Fs, fileA)).toBe(false);
    expect(shellCanRead(b.sandbox?.filesystem as Fs, `${dirB}/env.json`)).toBe(true);
  });

  it("a read-only worktree role (denyAround) cannot read another session's file either", () => {
    const r = realpathSync(mkdtempSync(join(tmpdir(), 'aom-senv-pol-')));
    const cwd = join(r, 'worktrees', 'TOY-0192abcd', 'TOY-3');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(r, 'agents', 'c3'), { recursive: true });
    const own = join(sessionEnvRoot(r), 'shift-c.0c0c0c0c');
    const other = join(sessionEnvRoot(r), 'shift-a.0a0a0a0a');
    mkdirSync(own, { recursive: true });
    mkdirSync(other, { recursive: true });
    const paths = {
      home: join(r, 'agents/c3/home'),
      configDir: join(r, 'agents/c3/claude'),
      scratch: join(r, 'agents/c3/scratch'),
      tmp: join(r, 'agents/c3/tmp'),
    };
    const s = buildShiftSettings(
      readOnlyRole.permissions,
      policyCtx({
        runnerRoot: r,
        agentDir: join(r, 'agents/c3'),
        cwd,
        aomReadPaths: [join(r, 'bin')],
        sessionEnvDir: own,
      }),
      paths,
      readOnlyRole.key,
    );
    const fs = s.sandbox?.filesystem as Fs;
    expect(fs.denyRead).toContain(sessionEnvRoot(r));
    expect(shellCanRead(fs, join(other, 'env.json'))).toBe(false);
    expect(shellCanRead(fs, join(own, 'env.json'))).toBe(true);
  });

  it('the scan sandbox opens the own dir too', () => {
    const block = scanSandboxBlock(policyCtx({ sessionEnvDir: dirA }), POLICY_PATHS);
    expect(block.filesystem.allowRead).toContain(dirA);
    expect(shellCanRead(block.filesystem, `${dirB}/env.json`)).toBe(false);
  });

  it('only a strictly shaped pointer becomes an allow entry', () => {
    expect(sessionEnvDirOf(`${dirA}/env.json`, root)).toBe(dirA);
    expect(sessionEnvDirOf(`${root}/session-env/env.json`, root)).toBeUndefined();
    expect(sessionEnvDirOf(`${root}/config.json`, root)).toBeUndefined();
  });
});

const shiftInput = (env: Record<string, string>): ShiftStartInput => ({
  shiftId: 's1',
  prompt: '# TOY-1',
  instructionsMarkdown: '# Who you are',
  cwd: '/data/worktrees/TOY/TOY-1',
  sandbox: POLICY_PATHS,
  agent: {
    agentId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
    name: 'Ada',
    roleKey: 'builder',
    seniority: 'junior',
    runtime: 'claude-code',
    model: 'sonnet',
    effort: 'medium',
    skills: [],
    permissions: builder.permissions,
    isDevops: false,
  },
  env,
  addDirs: [],
  maxShiftMinutes: 30,
});

describe('the pointer in the session env', () => {
  const file = '/data/session-env/s1.0a0a0a0a/env.json';
  const env = {
    AOM_IPC_URL: 'http://127.0.0.1:1',
    AOM_SHIFT_TOKEN: 'tok-xyz',
    [SHIFT_ENV_POINTER]: file,
    PATH: '/bin',
  };

  it.each([true, false])('buildClaudeCommand keeps AOM_SHIFT_ENV_FILE (scrub %s)', (scrub) => {
    const cmd = buildClaudeCommand(
      shiftInput(env),
      ClaudeRuntimeConfigSchema.parse({ scrubSubprocessEnv: scrub }),
    );
    expect(cmd.env[SHIFT_ENV_POINTER]).toBe(file);
    expect(cmd.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe(scrub ? '1' : undefined);
    expect(cmd.args.join(' ')).not.toContain('tok-xyz');
  });

  it('a DevOps shift never scrubs and still carries the pointer', () => {
    const base = shiftInput(env);
    const cmd = buildClaudeCommand(
      { ...base, agent: { ...base.agent, isDevops: true } },
      ClaudeRuntimeConfigSchema.parse({ scrubSubprocessEnv: true }),
    );
    expect(cmd.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBeUndefined();
    expect(cmd.env[SHIFT_ENV_POINTER]).toBe(file);
  });

  it.each([true, false])('buildClaudeChatCommand keeps AOM_SHIFT_ENV_FILE (scrub %s)', (scrub) => {
    const s = shiftInput(env);
    const chat: ChatStartInput = {
      chatId: 'c1',
      message: 'hi',
      cwd: POLICY_PATHS.scratch,
      sandbox: POLICY_PATHS,
      agent: s.agent,
      env,
      readOnly: true,
    };
    const cmd = buildClaudeChatCommand(chat, ClaudeRuntimeConfigSchema.parse({ scrubSubprocessEnv: scrub }));
    expect(cmd.env[SHIFT_ENV_POINTER]).toBe(file);
    expect(cmd.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe(scrub ? '1' : undefined);
    expect(cmd.args.join(' ')).not.toContain('tok-xyz');
  });

  it('the owner turn env carries the pointer', () => {
    const s = shiftInput(env);
    const owner: OwnerTurnInput = {
      chatId: 'chat-1',
      mode: 'owner',
      message: 'hello',
      cwd: '/home/owner',
      agent: { ...s.agent, roleKey: 'ceo', permissions: ceo.permissions },
      env: { ...env, AOM_CEO_TURN_DIR: '/data/ceo-turns/chat-1' },
      turnDir: '/data/ceo-turns/chat-1',
    };
    const cmd = buildClaudeOwnerTurnCommand(owner, ClaudeRuntimeConfigSchema.parse({}), {
      HOME: '/home/owner',
    });
    expect(cmd.env[SHIFT_ENV_POINTER]).toBe(file);
    expect(cmd.args.join(' ')).not.toContain('tok-xyz');
  });
});
