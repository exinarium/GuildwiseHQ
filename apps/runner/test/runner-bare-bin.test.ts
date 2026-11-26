import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findBinary } from '../src/adapters/codex.ts';
import { boxedClaudeEnv, boxSandbox, modelProxyPlan } from '../src/box/launch.ts';
import { inBoxAuditParams } from '../src/devops/audit.ts';
import { whichIn } from '../src/devops/dependency-install.ts';
import { wrapInHarnessSandbox } from '../src/sandbox/harness-sandbox.ts';
import { dotnetCandidates } from '../src/toolchain/dotnet.ts';
import { binHome } from './bin-home.ts';

/** runner-bare-bin: the pure parts (the box plan, the scrub switch, the other realpath(bin) callers, the in-box audit). */

const sandboxInput = (devopsBox: boolean) => ({
  cwd: '/r',
  readOnlyCwd: false,
  home: '/r/h',
  scratch: '/r',
  tmp: '/r/t',
  writable: [],
  readonly: [],
  readDirs: [],
  gitDirs: [],
  mayCommit: false,
  proxySocket: '/run/p.sock',
  bridgePort: 3128,
  hiddenFromShell: [],
  ...(devopsBox ? { devopsBox: true } : {}),
});

describe('runner-bare-bin: the box plan and the scrub', () => {
  it('boxSandbox refuses a bare or relative claude bin (it used to resolve against the cwd)', () => {
    const base = {
      level: 'inner' as const,
      requestDir: '/r',
      configDir: '/r/c',
      tmp: '/r/t',
      aomReadPaths: [],
      toolchainReadDirs: [],
      cloneDirs: [],
    };
    expect(() => boxSandbox({ ...base, claudeBin: 'claude' })).toThrow(/checked absolute path/);
    expect(() => boxSandbox({ ...base, claudeBin: './bin/claude' })).toThrow(/checked absolute path/);
    expect(boxSandbox({ ...base, claudeBin: '/usr/bin/true' }).readonly).toContain('/usr/bin');
  });

  it('wrapInHarnessSandbox switches the Claude Code env scrub off in a DevOps box (no nested bwrap), and only there', () => {
    const cmd = {
      bin: '/x/claude',
      args: [],
      env: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1', PATH: '/usr/bin' },
    };
    const boxed = wrapInHarnessSandbox(sandboxInput(true), cmd);
    expect(boxed.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('0');
    expect(boxed.args).toEqual(expect.arrayContaining(['--disable-userns', '--cap-drop', 'ALL']));
    const plain = wrapInHarnessSandbox(sandboxInput(false), cmd);
    expect(plain.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
  });

  it('the boxed Claude Code env switches off tool search and experimental betas (fits the fixed allowlist)', () => {
    const env = boxedClaudeEnv(modelProxyPlan({ kind: 'api_key', apiKey: 'k' }), 3128);
    expect(env.ENABLE_TOOL_SEARCH).toBe('false');
    expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('1');
    expect(JSON.stringify(env)).not.toContain('"k"');
  });
});

describe('runner-bare-bin: the other realpath(bin) callers', () => {
  const exe = (dir: string, name: string, mode = 0o755): string => {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const f = join(dir, name);
    writeFileSync(f, '#!/bin/sh\n');
    chmodSync(f, mode);
    return f;
  };

  it('findBinary (codex, gemini, opencode): PATH lookup; a relative path, a relative PATH entry and a non-executable first hit are refused', () => {
    const h = binHome();
    const a = exe(join(h, 'a'), 'codex', 0o644);
    const b = exe(join(h, 'b'), 'codex');
    expect(findBinary('codex', join(h, 'b'))).toBe(b);
    expect(findBinary('codex', `${join(h, 'a')}:${join(h, 'b')}`)).toBeUndefined();
    expect(findBinary(a, '')).toBeUndefined();
    expect(findBinary(b, '')).toBe(b);
    expect(findBinary('./b/codex', '', h)).toBeUndefined();
    expect(findBinary('b/codex', '')).toBeUndefined();
    expect(findBinary('codex', 'b:.')).toBeUndefined();
    // `~` still expands to the given home
    expect(findBinary('~/b/codex', '', h)).toBe(b);
    // R3: a group-writable install folder is refused
    chmodSync(join(h, 'b'), 0o775);
    expect(findBinary('codex', join(h, 'b'))).toBeUndefined();
    chmodSync(join(h, 'b'), 0o755);
  });

  it('findBinary R3: a world-writable parent (the system tmp) and a group-writable file are refused', () => {
    // a binary under the system tmp: /tmp is world-writable (sticky), so R3 refuses it on the codex, gemini and opencode path
    // (R2's runtime roots apply only to the box's Claude Code, DESIGN "Open questions")
    const t = mkdtempSync(join(tmpdir(), 'aom-fb-'));
    const inTmp = exe(t, 'codex');
    expect(findBinary(inTmp, '')).toBeUndefined();
    expect(findBinary('codex', t)).toBeUndefined();
    const h = binHome();
    const f = exe(join(h, 'c'), 'codex');
    expect(findBinary('codex', join(h, 'c'))).toBe(f);
    chmodSync(f, 0o775);
    expect(findBinary('codex', join(h, 'c'))).toBeUndefined();
    chmodSync(f, 0o755);
    expect(findBinary('codex', join(h, 'c'))).toBe(f);
  });

  it('whichIn (devops installers): a relative PATH entry and a non-executable file are no match', () => {
    const h = binHome();
    const f = exe(join(h, 'bin'), 'pnpm');
    exe(join(h, 'bin'), 'npm', 0o644);
    expect(whichIn('pnpm', join(h, 'bin'))).toBe(f);
    expect(whichIn('npm', join(h, 'bin'))).toBeNull();
    expect(whichIn('pnpm', 'bin')).toBeNull();
    expect(whichIn('pnpm', '')).toBeNull();
  });

  it('dotnetCandidates: a relative PATH entry is never resolved against the cwd', () => {
    const h = binHome();
    const root = join(h, 'dn');
    exe(root, 'dotnet');
    symlinkSync(join(root, 'dotnet'), join(h, 'dotnet'));
    const rel = dotnetCandidates({ env: { PATH: '.' }, home: '/nowhere', systemRoots: [] });
    expect(rel).not.toContain(root);
    const abs = dotnetCandidates({ env: { PATH: h }, home: '/nowhere', systemRoots: [] });
    expect(abs).toContain(root);
  });
});

describe('runner-bare-bin (S4): in-box audit entries are never trusted', () => {
  const entry = (o: Record<string, unknown>) => ({
    at: '2026-11-26T20:00:00.000Z',
    sessionRef: 'forged',
    kind: 'shift',
    decision: 'allowed',
    rule: 'ok',
    command: 'ls',
    ...o,
  });

  it('a forged sessionRef is rebound; from a box a refusal is dropped and each rule is stored as untrusted:', () => {
    const p = {
      entries: [entry({}), entry({ decision: 'refused', rule: 'docker_off', command: 'echo hi' })],
    };
    const boxed = inBoxAuditParams(p, 'shift-1', true).entries as Array<Record<string, unknown>>;
    expect(boxed).toEqual([
      expect.objectContaining({ sessionRef: 'shift-1', rule: 'untrusted:ok', decision: 'allowed' }),
    ]);
    const plain = inBoxAuditParams(p, 'shift-1', false).entries as Array<Record<string, unknown>>;
    expect(plain.map((e) => [e.sessionRef, e.rule, e.decision])).toEqual([
      ['shift-1', 'ok', 'allowed'],
      ['shift-1', 'docker_off', 'refused'],
    ]);
    const long = inBoxAuditParams({ entries: [entry({ rule: 'r'.repeat(80) })] }, 's', true)
      .entries as Array<{
      rule: string;
    }>;
    expect(long[0]?.rule.length).toBe(80);
  });
});
