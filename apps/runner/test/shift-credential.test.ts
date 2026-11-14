import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeTurnFiles } from '../src/ceo/turn-files.ts';
import type { ShiftIpcHandler } from '../src/ipc/server.ts';
import {
  issueShiftCredential,
  LEGACY_SHIFT_ENV_FILE,
  missingTokenMessage,
  resolveShiftEnv,
  SESSION_ENV_FILE,
  SHIFT_ENV_KEYS,
  SHIFT_ENV_POINTER,
  sessionEnvDirOf,
  sessionEnvRoot,
  sweepSessionEnvFiles,
  writeSessionEnvFile,
} from '../src/session/shift-credential.ts';

const TOKEN = 'tok-secret-value-1234567890';
const handler: ShiftIpcHandler = {
  report: async () => ({ accepted: true, message: 'ok' }),
  rpc: async () => ({ ok: true, result: {} }),
};

function fakeIpc(socketPath = '/s/ipc.sock') {
  const live = new Set<string>();
  return {
    live,
    url: 'http://127.0.0.1:1',
    socketPath,
    registerShift: () => {
      live.add(TOKEN);
      return TOKEN;
    },
    revoke: (t: string) => {
      live.delete(t);
    },
  };
}

const root = () => mkdtempSync(join(tmpdir(), 'aom-senv-'));
const posix = process.platform !== 'win32';

/** What Claude Code's subprocess scrub does to a Bash child: credential-named variables are gone. */
const scrub = (env: Record<string, string>): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of Object.keys(out)) if (/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH/i.test(k)) delete out[k];
  return out;
};

describe('issueShiftCredential', () => {
  it('writes an owner-only env file in a private per-session dir and points at it', () => {
    const r = root();
    const ipc = fakeIpc();
    const cred = issueShiftCredential({ ipc, runnerRoot: r }, { sessionId: 'shift-1', handler });
    expect(cred.token).toBe(TOKEN);
    expect(cred.file).toBeDefined();
    const file = cred.file as string;
    expect(file).toMatch(new RegExp(`^${sessionEnvRoot(r)}/shift-1\\.[0-9a-f]{8}/${SESSION_ENV_FILE}$`));
    expect(cred.env[SHIFT_ENV_POINTER]).toBe(file);
    expect(cred.env).toMatchObject({
      AOM_IPC_URL: ipc.url,
      AOM_IPC_SOCKET: ipc.socketPath,
      AOM_SHIFT_TOKEN: TOKEN,
      AOM_SHIFT_ID: 'shift-1',
    });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      AOM_IPC_URL: ipc.url,
      AOM_IPC_SOCKET: ipc.socketPath,
      AOM_SHIFT_TOKEN: TOKEN,
      AOM_SHIFT_ID: 'shift-1',
    });
    if (posix) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(file, '..')).mode & 0o777).toBe(0o700);
      expect(statSync(sessionEnvRoot(r)).mode & 0o777).toBe(0o700);
      expect(statSync(file).uid).toBe(process.getuid?.());
    }
    // no temp file left behind
    expect(readdirSync(join(file, '..'))).toEqual([SESSION_ENV_FILE]);
  });

  it('puts the extra turn dir in the file and leaves the socket out when asked', () => {
    const r = root();
    const cred = issueShiftCredential(
      { ipc: fakeIpc(), runnerRoot: r },
      { sessionId: 'chat-1', handler, extra: { AOM_CEO_TURN_DIR: '/t/dir' }, socket: false },
    );
    expect(cred.env.AOM_IPC_SOCKET).toBeUndefined();
    expect(cred.env.AOM_CEO_TURN_DIR).toBe('/t/dir');
    const content = JSON.parse(readFileSync(cred.file as string, 'utf8'));
    expect(content.AOM_CEO_TURN_DIR).toBe('/t/dir');
    expect(content.AOM_IPC_SOCKET).toBeUndefined();
    expect(content[SHIFT_ENV_POINTER]).toBeUndefined();
  });

  it('keeps an odd session id to a short safe dir name', () => {
    const r = root();
    const cred = issueShiftCredential(
      { ipc: fakeIpc(''), runnerRoot: r },
      { sessionId: '../x/y z', handler },
    );
    expect(sessionEnvDirOf(cred.file, r)).toBeDefined();
    expect(cred.env.AOM_IPC_SOCKET).toBeUndefined();
  });

  it('revoke() revokes the token and removes the dir, once', () => {
    const r = root();
    const ipc = fakeIpc();
    const cred = issueShiftCredential({ ipc, runnerRoot: r }, { sessionId: 's', handler });
    const dir = join(cred.file as string, '..');
    expect(ipc.live.has(TOKEN)).toBe(true);
    cred.revoke();
    expect(ipc.live.has(TOKEN)).toBe(false);
    expect(existsSync(dir)).toBe(false);
    ipc.live.add(TOKEN);
    cred.revoke();
    expect(ipc.live.has(TOKEN)).toBe(true);
  });

  it('two registrations of one id get separate dirs', () => {
    const r = root();
    const a = issueShiftCredential({ ipc: fakeIpc(), runnerRoot: r }, { sessionId: 'c', handler });
    const b = issueShiftCredential({ ipc: fakeIpc(), runnerRoot: r }, { sessionId: 'c', handler });
    expect(a.file).not.toBe(b.file);
    a.revoke();
    expect(existsSync(b.file as string)).toBe(true);
  });

  it('a write failure warns with the path only, omits the pointer and still issues the token', () => {
    const r = root();
    writeFileSync(sessionEnvRoot(r), 'not a dir');
    const lines: string[] = [];
    const cred = issueShiftCredential(
      { ipc: fakeIpc(), runnerRoot: r, log: { warn: (m) => lines.push(m) } },
      { sessionId: 's', handler },
    );
    expect(cred.file).toBeUndefined();
    expect(cred.env[SHIFT_ENV_POINTER]).toBeUndefined();
    expect(cred.env.AOM_SHIFT_TOKEN).toBe(TOKEN);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(sessionEnvRoot(r));
    for (const l of lines) expect(l).not.toContain(TOKEN);
    expect(() => cred.revoke()).not.toThrow();
  });

  it('the pointer name holds no credential word', () => {
    expect(SHIFT_ENV_POINTER).not.toMatch(/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH/i);
  });
});

describe('writeSessionEnvFile', () => {
  it('replaces the file whole and keeps only the shift keys', () => {
    const r = root();
    const dir = join(sessionEnvRoot(r), 'x.00000000');
    const file = writeSessionEnvFile(dir, { AOM_SHIFT_TOKEN: 'a', OTHER: 'no' });
    writeSessionEnvFile(dir, { AOM_SHIFT_TOKEN: 'b' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ AOM_SHIFT_TOKEN: 'b' });
    expect(readdirSync(dir)).toEqual([SESSION_ENV_FILE]);
  });
});

describe('sweepSessionEnvFiles', () => {
  it('removes unknown dirs, keeps live ones and recreates a missing root with 0700', () => {
    const r = root();
    expect(sweepSessionEnvFiles(r)).toBe(0);
    expect(statSync(sessionEnvRoot(r)).isDirectory()).toBe(true);
    if (posix) expect(statSync(sessionEnvRoot(r)).mode & 0o777).toBe(0o700);
    mkdirSync(join(sessionEnvRoot(r), 'old.11111111'));
    writeFileSync(join(sessionEnvRoot(r), 'old.11111111', SESSION_ENV_FILE), '{}');
    mkdirSync(join(sessionEnvRoot(r), 'live.22222222'));
    expect(sweepSessionEnvFiles(r, (n) => n.startsWith('live'))).toBe(1);
    expect(readdirSync(sessionEnvRoot(r))).toEqual(['live.22222222']);
    expect(sweepSessionEnvFiles(r)).toBe(1);
    expect(readdirSync(sessionEnvRoot(r))).toEqual([]);
  });
});

describe('sessionEnvDirOf', () => {
  const r = '/h/.aom-runner';
  const ok = `${r}/session-env/shift-1.abcd1234/env.json`;
  it('accepts exactly <root>/session-env/<one segment>/env.json', () => {
    expect(sessionEnvDirOf(ok, r)).toBe(`${r}/session-env/shift-1.abcd1234`);
    expect(sessionEnvDirOf(ok, `${r}/`)).toBe(`${r}/session-env/shift-1.abcd1234`);
  });
  it.each([
    undefined,
    '',
    'session-env/x/env.json',
    `${r}/session-env/../x/env.json`,
    `${r}/session-env/a/b/env.json`,
    `${r}/session-env/a/other.json`,
    `${r}/session-env/env.json`,
    `/other/session-env/a/env.json`,
    `${r}/session-env//a/env.json`,
  ])('rejects %s', (file) => {
    expect(sessionEnvDirOf(file, r)).toBeUndefined();
  });
});

describe('resolveShiftEnv', () => {
  it('(a) a token in the environment is used and nothing is read', () => {
    const env = { AOM_SHIFT_TOKEN: 'mine', [SHIFT_ENV_POINTER]: '/x/env.json' };
    let reads = 0;
    const r = resolveShiftEnv(env, () => {
      reads++;
      return '{}';
    });
    expect(r.env).toBe(env);
    expect(r.attempts).toEqual([]);
    expect(reads).toBe(0);
  });

  it('(b) after the scrub, aom fills the shift variables from the pointer file; env values win', () => {
    const cred = issueShiftCredential({ ipc: fakeIpc(), runnerRoot: root() }, { sessionId: 's-1', handler });
    const scrubbed = scrub({ ...cred.env, AOM_SHIFT_ID: 'from-env' });
    expect(scrubbed.AOM_SHIFT_TOKEN).toBeUndefined();
    expect(scrubbed[SHIFT_ENV_POINTER]).toBe(cred.file);
    const r = resolveShiftEnv(scrubbed);
    expect(r.env.AOM_SHIFT_TOKEN).toBe(TOKEN);
    expect(r.env.AOM_IPC_URL).toBe('http://127.0.0.1:1');
    expect(r.env.AOM_IPC_SOCKET).toBe('/s/ipc.sock');
    expect(r.env.AOM_SHIFT_ID).toBe('from-env');
    expect(r.attempts).toEqual([{ source: 'pointer', path: cred.file }]);
  });

  it('(c) falls back to the legacy turn-dir file when the pointer gives nothing', () => {
    const dir = root();
    writeFileSync(
      join(dir, LEGACY_SHIFT_ENV_FILE),
      JSON.stringify({ AOM_SHIFT_TOKEN: 'legacy', AOM_IPC_URL: 'u' }),
    );
    const r = resolveShiftEnv({ AOM_CEO_TURN_DIR: dir, [SHIFT_ENV_POINTER]: join(dir, 'gone', 'env.json') });
    expect(r.env.AOM_SHIFT_TOKEN).toBe('legacy');
    expect(r.attempts).toEqual([
      { source: 'pointer', path: join(dir, 'gone', 'env.json'), problem: 'missing' },
      { source: 'legacy', path: join(dir, LEGACY_SHIFT_ENV_FILE) },
    ]);
    const noPointer = resolveShiftEnv({ AOM_CEO_TURN_DIR: dir });
    expect(noPointer.env.AOM_SHIFT_TOKEN).toBe('legacy');
    expect(noPointer.attempts).toEqual([{ source: 'legacy', path: join(dir, LEGACY_SHIFT_ENV_FILE) }]);
  });

  it('(d) nothing found: env unchanged, the problems listed, never file content', () => {
    const p = '/x/env.json';
    const cases: Array<[string, string]> = [
      ['x'.repeat(9000), 'too_large'],
      ['not json', 'invalid'],
      ['[1]', 'invalid'],
      ['{"AOM_SHIFT_TOKEN":5}', 'no_token'],
    ];
    for (const [text, problem] of cases) {
      const env = { [SHIFT_ENV_POINTER]: p };
      const r = resolveShiftEnv(env, () => text);
      expect(r.env.AOM_SHIFT_TOKEN).toBeUndefined();
      expect(r.attempts).toEqual([{ source: 'pointer', path: p, problem }]);
    }
    const rel = resolveShiftEnv({ [SHIFT_ENV_POINTER]: 'rel/env.json' });
    expect(rel.attempts[0]?.problem).toBe('not_absolute');
    const unreadable = resolveShiftEnv({ [SHIFT_ENV_POINTER]: p }, () => {
      throw Object.assign(new Error('nope'), { code: 'EACCES' });
    });
    expect(unreadable.attempts[0]?.problem).toBe('unreadable');
    const none = { A: '1' };
    expect(resolveShiftEnv(none)).toEqual({ env: none, attempts: [] });
    expect(resolveShiftEnv({ AOM_CEO_TURN_DIR: 'rel' }).attempts).toEqual([]);
  });
});

describe('missingTokenMessage', () => {
  it('names the pointer variable, the path and the reason', () => {
    const msg = missingTokenMessage({ [SHIFT_ENV_POINTER]: '/r/session-env/a/env.json' }, [
      { source: 'pointer', path: '/r/session-env/a/env.json', problem: 'missing' },
      { source: 'legacy', path: '/t/shift-env.json', problem: 'missing' },
    ]);
    expect(msg).toContain(SHIFT_ENV_POINTER);
    expect(msg).toContain('/r/session-env/a/env.json');
    expect(msg).toContain('does not exist');
    expect(msg).toContain('also tried /t/shift-env.json');
  });
  it('without the pointer it names both variables', () => {
    const msg = missingTokenMessage({});
    expect(msg).toContain('AOM_SHIFT_TOKEN');
    expect(msg).toContain(SHIFT_ENV_POINTER);
    expect(msg).toContain('only works inside an agent shift');
  });
});

describe('CEO owner turn on the general path', () => {
  it.each(['owner', 'order'] as const)('writeTurnFiles no longer writes shift-env.json (%s)', (mode) => {
    const r = root();
    const turnDir = join(r, 'ceo-turns', 'chat-1');
    const cred = issueShiftCredential(
      { ipc: fakeIpc(), runnerRoot: r },
      { sessionId: 'chat-1', handler, extra: { AOM_CEO_TURN_DIR: turnDir } },
    );
    writeTurnFiles({
      turnDir,
      brief: 'b',
      mode,
      shiftEnv: cred.env,
      runnerRoots: [r],
      pid: 1,
      clones: [],
      home: '/h',
    });
    expect(existsSync(join(turnDir, LEGACY_SHIFT_ENV_FILE))).toBe(false);
    // the bypass turn's scrub: aom still resolves every shift variable through the pointer
    const resolved = resolveShiftEnv(scrub(cred.env)).env;
    for (const k of SHIFT_ENV_KEYS) expect(resolved[k], k).toBe(cred.env[k]);
  });
});
