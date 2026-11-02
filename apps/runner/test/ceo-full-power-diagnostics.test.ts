import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeOwnerTurnCommand, ownerBypasses } from '../src/adapters/claude-code.ts';
import type { OwnerTurnInput } from '../src/adapters/types.ts';
import { runnerDiagnostics, selectLines } from '../src/ceo/diagnostics.ts';
import { bashFloorMessage, GUARD_CONFIG_FILE, runGuardHook } from '../src/ceo/guard-hook.ts';
import { floorDenies, floorSpellings, PRIVATE_ENTRIES, writeTurnFiles } from '../src/ceo/turn-files.ts';
import { CeoConfigSchema, ClaudeRuntimeConfigSchema } from '../src/config.ts';
import { runnerPaths } from '../src/paths.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp } from './helpers.ts';
import { ceoChatStart, FakeChatAdapter } from './owner-helpers.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const ceo = BUILTIN_ROLES.find((r) => r.key === 'ceo');
if (!ceo) throw new Error('role');
const cfg = ClaudeRuntimeConfigSchema.parse({});
const input = (over: Partial<OwnerTurnInput> = {}): OwnerTurnInput => ({
  chatId: 'c1',
  mode: 'owner',
  message: 'hi',
  cwd: '/home/owner',
  agent: {
    agentId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
    name: 'Ada',
    roleKey: 'ceo',
    seniority: 'senior',
    runtime: 'claude-code',
    model: 'sonnet',
    skills: [],
    permissions: ceo.permissions,
    isDevops: false,
  },
  env: { AOM_SHIFT_TOKEN: 't' },
  turnDir: '/runner/ceo-turns/c1',
  ...over,
});
const modeOf = (c: { args: string[] }) => c.args[c.args.indexOf('--permission-mode') + 1];

describe('permission mode of the CEO turns', () => {
  it('the default is auto with the relay, whatever the install had before', () => {
    const c = buildClaudeOwnerTurnCommand(input(), cfg, {});
    expect(modeOf(c)).toBe('auto');
    expect(c.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBeUndefined();
    expect(CeoConfigSchema.parse({ fullPower: true }).ownerPermissions).toBe('auto');
    expect(CeoConfigSchema.parse({}).ownerPermissions).toBe('auto');
  });

  it('--bypass runs the Owner chat without prompts and keeps the provider credential from its shell', () => {
    const c = buildClaudeOwnerTurnCommand(input({ permissionMode: 'bypass' }), cfg, {});
    expect(modeOf(c)).toBe('bypassPermissions');
    expect(c.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
    // the deny floor and the hook still ride on the session
    expect(c.args[c.args.indexOf('--settings') + 1]).toBe('/runner/ceo-turns/c1/floor.json');
  });

  it.each(['bypass', 'auto'] as const)(
    '%s turn command passes the full AOM_* shift environment through',
    (permissionMode) => {
      const shift = {
        AOM_IPC_URL: 'http://127.0.0.1:1',
        AOM_IPC_SOCKET: '/s/ipc.sock',
        AOM_SHIFT_TOKEN: 't',
        AOM_SHIFT_ID: 'c1',
        AOM_CEO_TURN_DIR: '/runner/ceo-turns/c1',
      };
      const c = buildClaudeOwnerTurnCommand(input({ permissionMode, env: shift }), cfg, {});
      for (const [k, v] of Object.entries(shift)) expect(c.env[k], k).toBe(v);
    },
  );

  it('an explicit auto (--strict) keeps the classifier and the relay', () => {
    const c = buildClaudeOwnerTurnCommand(input({ permissionMode: 'auto' }), cfg, {});
    expect(modeOf(c)).toBe('auto');
    expect(c.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBeUndefined();
    expect(c.args).toContain('mcp__aom_permission__ask');
  });

  it('a standing-order turn is never promoted: auto whatever the setting says', () => {
    for (const permissionMode of ['bypass', 'auto', undefined] as const) {
      const c = buildClaudeOwnerTurnCommand(
        input({ mode: 'order', ...(permissionMode ? { permissionMode } : {}) }),
        cfg,
        {},
      );
      expect(modeOf(c)).toBe('auto');
      expect(c.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBeUndefined();
    }
    expect(ownerBypasses({ mode: 'order', permissionMode: 'bypass' })).toBe(false);
  });
});

describe('the deny floor', () => {
  const d = floorDenies({ runnerRoots: ['/data/runner'], pid: 77, home: '/home/o' });

  it('stops the runner service being stopped or edited but no longer blocks looking at it', () => {
    expect(d).toContain('Bash(systemctl *stop *aom-runner*)');
    expect(d).toContain('Bash(systemctl *restart *aom-runner*)');
    expect(d).not.toContain('Bash(systemctl * aom-runner*)');
    expect(
      d.some((r) => /status|show|cat|is-active|list-units/.test(r) && r.startsWith('Bash(systemctl')),
    ).toBe(false);
    expect(d).toContain('Bash(pkill *aom*)');
    expect(d).toContain('Bash(kill * 77)');
  });

  it('keeps keys, config, queued payloads and raw logs out of a shell; status.json is readable', () => {
    for (const e of ['secrets', 'config.json', 'keys', 'outbox', 'logs'])
      expect(d).toContain(`Bash(*/data/runner/${e}*)`);
    expect(PRIVATE_ENTRIES).not.toContain('status.json');
    expect(d.some((r) => r.includes('status.json'))).toBe(false);
  });

  it('the hook explains each refusal and names what to use instead', () => {
    const floor = {
      spellings: floorSpellings({ runnerRoots: ['/h/.aom-runner-x'], home: '/h' }),
      entries: PRIVATE_ENTRIES,
    };
    const logs = bashFloorMessage('tail -n 50 ~/.aom-runner-x/logs/runner.log', floor);
    expect(logs).toContain('aom runner logs');
    expect(logs).toContain('aom ceo diag workstation');
    expect(bashFloorMessage('cat $HOME/.aom-runner-x/config.json', floor)).toContain('aom runner status');
    expect(bashFloorMessage('cat /h/.aom-runner-x/secrets/claude.json', floor)).toContain('keys, tokens');
    expect(bashFloorMessage('systemctl --user restart aom-runner-guildwise', floor)).toContain(
      'aom runner restart',
    );
    expect(bashFloorMessage('pkill -f aom-runner', floor)).toContain('aom runner restart');
    // reading is not blocked
    for (const ok of [
      'systemctl --user status aom-runner-guildwise',
      'journalctl --user -u aom-runner-guildwise --since "-3 hours" --no-pager | tail -50',
      'aom runner logs --kind service --lines 100',
      'cat /h/.aom-runner-x/status.json',
      'ls /h/src',
    ])
      expect(bashFloorMessage(ok, floor), ok).toBeNull();
  });

  it('the hook process answers a Bash call with exit 2 and the reason; an edit still follows the clone rule', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aom-guard-'));
    writeTurnFiles({
      turnDir: join(dir, 't'),
      brief: 'b',
      mode: 'owner',
      shiftEnv: {},
      runnerRoots: ['/h/.aom-runner-x'],
      pid: 1,
      clones: [{ path: '/src/p4', name: 'p4' }],
      home: '/h',
    });
    const t = join(dir, 't');
    const bash = (command: string) =>
      runGuardHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), t);
    const blocked = bash('cat ~/.aom-runner-x/logs/runner.log');
    expect(blocked.exitCode).toBe(2);
    expect(blocked.stderr).toContain('aom runner logs');
    expect(bash('aom runner logs').exitCode).toBe(0);
    expect(
      runGuardHook(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: '/src/p4/a.ts' } }), t)
        .exitCode,
    ).toBe(2);
    expect(GUARD_CONFIG_FILE).toBe('guard.json');
  });
});

function folder() {
  const root = mkdtempSync(join(tmpdir(), 'aom-diag-'));
  const paths = runnerPaths(root);
  mkdirSync(paths.shiftLogs, { recursive: true });
  mkdirSync(paths.envLogs, { recursive: true });
  return { root, paths };
}
const noSystemd = async () => ({ ok: false, stdout: '' });

describe('runnerDiagnostics', () => {
  it('shows the tail of the runner log with tokens masked, honouring --lines and --grep', async () => {
    const { paths } = folder();
    const lines = Array.from({ length: 300 }, (_v, i) => `line ${i} ok`);
    lines.push('connect failed Authorization: Bearer abcdefghijklmnop1234 retrying');
    lines.push('config token=sk-abcdefghijklmnopqrstuv password=hunter2xx');
    writeFileSync(paths.runnerLog, `${lines.join('\n')}\n`);
    const all = await runnerDiagnostics(
      { kind: 'runner', lines: 5 },
      { paths, version: '0.1.65', exec: noSystemd },
    );
    expect(all.text.split('\n')).toHaveLength(5);
    expect(all.text).not.toMatch(/abcdefghijklmnop1234|sk-abcdef|hunter2/);
    expect(all.text).toContain('***');
    expect(all.runnerVersion).toBe('0.1.65');
    const g = await runnerDiagnostics(
      { kind: 'runner', grep: 'CONNECT FAILED' },
      { paths, version: 'v', exec: noSystemd },
    );
    expect(g.text).toContain('connect failed');
    expect(g.text).not.toContain('line 1 ok');
  });

  it('lists and reads shift logs by bare name only; a path out of the folder is refused', async () => {
    const { paths, root } = folder();
    writeFileSync(
      join(paths.shiftLogs, 'chat-1.jsonl'),
      '{"a":1}\n{"secret":"x","token":"tok-123456789012"}\n',
    );
    writeFileSync(join(root, 'config.json'), '{"runnerToken":"aomr_supersecretvalue1"}');
    const deps = { paths, version: 'v', exec: noSystemd };
    expect((await runnerDiagnostics({ kind: 'shifts' }, deps)).text).toContain('chat-1.jsonl');
    const one = await runnerDiagnostics({ kind: 'shifts', name: 'chat-1.jsonl' }, deps);
    expect(one.text).toContain('{"a":1}');
    expect(one.text).not.toContain('tok-123456789012');
    // the request schema refuses a slash; a dotted name is refused by the reader
    expect((await runnerDiagnostics({ kind: 'shifts', name: '../config.json' }, deps)).text).toContain(
      'Not a valid request',
    );
    expect((await runnerDiagnostics({ kind: 'shifts', name: '..' }, deps)).text).toContain(
      'Not a log file name',
    );
    expect((await runnerDiagnostics({ kind: 'shifts', name: 'missing.log' }, deps)).text).toContain(
      'No file',
    );
  });

  it('service: reads the journal of the runner unit; without systemd it falls back to service.log', async () => {
    const { paths } = folder();
    const calls: string[][] = [];
    const exec = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (args.includes('list-units'))
        return { ok: true, stdout: 'aom-runner-guildwise.service loaded active running Guildwise\n' };
      return { ok: true, stdout: 'Oct 31 runner started\nOct 31 api_key=abcdefghijkl1234 used\n' };
    };
    const r = await runnerDiagnostics(
      { kind: 'service', since: '-3 hours', lines: 50 },
      { paths, version: 'v', exec, platform: 'linux' },
    );
    expect(r.text).toContain('runner started');
    expect(r.text).not.toContain('abcdefghijkl1234');
    const j = calls.find((c) => c[0] === 'journalctl') as string[];
    expect(j).toEqual(
      expect.arrayContaining(['--user', '-u', 'aom-runner-guildwise.service', '--since', '-3 hours']),
    );
    writeFileSync(join(paths.logs, 'service.log'), 'plain service log\n');
    const f = await runnerDiagnostics(
      { kind: 'service' },
      { paths, version: 'v', exec: noSystemd, platform: 'linux' },
    );
    expect(f.text).toBe('plain service log');
  });

  it('status gives the version, the status file and the service state, never the config', async () => {
    const { paths } = folder();
    writeFileSync(paths.status, JSON.stringify({ pid: 4, connected: true }));
    const exec = async (_c: string, args: string[]) =>
      args.includes('list-units')
        ? { ok: true, stdout: 'aom-runner.service loaded active running x\n' }
        : { ok: true, stdout: 'ActiveState=active\nSubState=running\nNRestarts=0\n' };
    const r = await runnerDiagnostics(
      { kind: 'status' },
      { paths, version: '0.1.65', exec, platform: 'linux', status: () => ({ idle: true }) },
    );
    const j = JSON.parse(r.text);
    expect(j).toMatchObject({ runnerVersion: '0.1.65', statusFile: { connected: true }, idle: true });
    expect(j.services['aom-runner.service']).toContain('ActiveState=active');
  });

  it('cuts a long answer to its tail and says so', async () => {
    const { paths } = folder();
    writeFileSync(paths.runnerLog, `${'x'.repeat(1500)}\n`.repeat(100));
    const r = await runnerDiagnostics(
      { kind: 'runner', lines: 2000 },
      { paths, version: 'v', exec: noSystemd },
    );
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThan(61_000);
    expect(selectLines('a\nb\nc\n', 2)).toBe('b\nc');
  });
});

describe('aom runner status|logs in a turn', () => {
  async function turn(
    mode: 'owner' | 'order' | 'chat',
    script: (env: Record<string, string>) => Promise<void>,
  ) {
    h = await startHarness();
    const adapter = new FakeChatAdapter();
    const wrap = (orig: (i: never) => Promise<unknown>) => async (i: { env: Record<string, string> }) => {
      await script(i.env);
      return orig(i as never);
    };
    adapter.startOwnerTurn = wrap(adapter.startOwnerTurn.bind(adapter)) as never;
    adapter.startChat = wrap(adapter.startChat.bind(adapter)) as never;
    h.runner.chat.deps.adapters.set('mock', adapter);
    (h.runner as unknown as { opts: { config: { ceo: unknown } } }).opts.config.ceo = {
      fullPower: true,
      ownerPermissions: 'bypass',
    };
    void mode;
    return adapter;
  }
  const post = (env: Record<string, string>, method: string, params: Record<string, unknown>) =>
    fetch(`${env.AOM_IPC_URL}/v1/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.AOM_SHIFT_TOKEN}` },
      body: JSON.stringify({ method, params }),
    }).then(
      (r) =>
        r.json() as Promise<{
          ok: boolean;
          result?: { text: string; runnerVersion: string };
          error?: string;
        }>,
    );

  it('the Owner turn reads the runner log through the runner, masked; the turn reports its permission mode', async () => {
    const seen: Record<
      string,
      { ok: boolean; result?: { text: string; runnerVersion: string }; error?: string }
    > = {};
    const adapter = await turn('owner', async (env) => {
      writeFileSync(
        h!.runner.paths.runnerLog,
        'boot ok\nupload failed: Authorization: Bearer abcdefghijklmnop1234\n',
      );
      seen.logs = await post(env, 'runner.logs', { kind: 'runner', lines: 10 });
      seen.status = await post(env, 'runner.status', {});
    });
    const m = ceoChatStart('why did the upload fail?', { ceoMode: 'owner' });
    h!.server.send('chat.start', m);
    const done = await h!.server.waitFor('chat.done', (d) => d.chatId === m.chatId);
    expect(seen.logs?.ok).toBe(true);
    expect(seen.logs?.result?.text).toContain('upload failed');
    expect(seen.logs?.result?.text).not.toContain('abcdefghijklmnop1234');
    expect(seen.status?.ok).toBe(true);
    expect(JSON.parse(seen.status?.result?.text ?? '{}')).toHaveProperty('runnerVersion');
    expect(adapter.ownerTurns[0]?.permissionMode).toBe('bypass');
    expect(done.permissionMode).toBe('bypass');
    const audit = await import('node:fs').then((fs) =>
      fs.readFileSync(join(h!.dataDir, 'logs', 'ceo-turns', `${m.chatId}.commands.log`), 'utf8'),
    );
    expect(audit).toContain('permission mode: bypass');
  });

  it('strict mode is reported as auto and passed to the adapter', async () => {
    const adapter = await turn('owner', async () => {});
    (h!.runner as unknown as { opts: { config: { ceo: unknown } } }).opts.config.ceo = {
      fullPower: true,
      ownerPermissions: 'auto',
    };
    const m = ceoChatStart('hi', { ceoMode: 'owner' });
    h!.server.send('chat.start', m);
    const done = await h!.server.waitFor('chat.done', (d) => d.chatId === m.chatId);
    expect(adapter.ownerTurns[0]?.permissionMode).toBe('auto');
    expect(done.permissionMode).toBe('auto');
  });

  it('a standing-order turn, a plain chat and every other agent are refused with a clear message', async () => {
    const seen: Array<{ ok: boolean; error?: string }> = [];
    await turn('order', async (env) => {
      seen.push(await post(env, 'runner.logs', {}));
    });
    const title = 'Auto-fix flagged bugs';
    const body = 'Specify every flagged bug for P4.';
    const { createHash } = await import('node:crypto');
    const order = {
      entryId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d1',
      versionHash: createHash('sha256').update(`${title}\n${body}`).digest('hex'),
      title,
      body,
      ownerMarked: true,
      covers: [],
    };
    const o = ceoChatStart('o', { ceoMode: 'order', order });
    h!.server.send('chat.start', o);
    await h!.server.waitFor('chat.done', (d) => d.chatId === o.chatId);
    const plain = ceoChatStart('p', {});
    h!.server.send('chat.start', plain);
    await h!.server.waitFor('chat.done', (d) => d.chatId === plain.chatId);
    expect(seen).toHaveLength(2);
    for (const r of seen) {
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/CEO chat with the Owner/);
    }
  });
});
