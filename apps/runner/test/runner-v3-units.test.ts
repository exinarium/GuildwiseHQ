import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
  buildClaudeChatCommand,
  buildClaudeCommand,
  CARD_BASH_DEFAULT_TIMEOUT_MS,
} from '../src/adapters/claude-code.ts';
import { buildDevopsChatSettings, buildShiftSettings } from '../src/adapters/claude-policy.ts';
import { ClaudeStreamParser } from '../src/adapters/claude-stream-parser.ts';
import type { ChatStartInput, ShiftStartInput } from '../src/adapters/types.ts';
import { ChatManager } from '../src/chat/chat.ts';
import { ClaudeRuntimeConfigSchema } from '../src/config.ts';
import { recordDevopsAudit } from '../src/devops/audit.ts';
import { redactCommand } from '../src/devops/guard.ts';
import { rulesProblem, runRoleSmoke, settingsProblem } from '../src/health/role-smoke.ts';
import { installErrorHandlers, sanitizeError } from '../src/health/runner-error.ts';
import { IpcServer } from '../src/ipc/server.ts';
import { runnerPaths } from '../src/paths.ts';
import {
  copySessionTranscript,
  projectDirName,
  RESUME_MAX_AGE_MS,
  RESUME_MAX_CONTEXT_TOKENS,
  SessionRegistry,
  transcriptFile,
} from '../src/sessions/registry.ts';
import { startHarness } from './harness.ts';
import { cleanupTmp, tmp } from './helpers.ts';
import { POLICY_PATHS, policyCtx } from './policy-fixtures.ts';

cleanupTmp();

const builder = BUILTIN_ROLES.find((r) => r.key === 'builder')!;
const reviewer = BUILTIN_ROLES.find((r) => r.key === 'reviewer')!;
const devopsRole = BUILTIN_ROLES.find((r) => r.key === 'devops')!;

const shiftInput = (over: Partial<ShiftStartInput> = {}): ShiftStartInput => ({
  shiftId: 's1',
  prompt: 'p',
  instructionsMarkdown: 'i',
  cwd: '/data/worktrees/TOY/TOY-1',
  sandbox: {
    home: '/data/agents/a1/home',
    configDir: '/data/agents/a1/claude',
    scratch: '/data/agents/a1/scratch',
    tmp: '/data/agents/a1/tmp',
  },
  agent: {
    agentId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
    name: 'Ada',
    roleKey: 'builder',
    seniority: 'junior',
    runtime: 'claude-code',
    model: 'sonnet',
    skills: [],
    permissions: builder.permissions,
    isDevops: false,
  },
  env: { AOM_IPC_URL: 'http://127.0.0.1:1', AOM_SHIFT_TOKEN: 't', AOM_SHIFT_ID: 's1', PATH: '/usr/bin' },
  addDirs: [],
  maxShiftMinutes: 30,
  ...over,
});
const cfg = ClaudeRuntimeConfigSchema.parse({});

describe('stream parser: context size and usage of crashed sessions', () => {
  const assistant = (id: string, usage: Record<string, number>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: 'assistant',
      message: { id, model: 'claude-sonnet', content: [{ type: 'text', text: 'x' }], usage },
      ...extra,
    });

  it('context size is the last call: input + cache read + cache write', () => {
    const p = new ClaudeStreamParser();
    expect(p.contextTokens()).toBe(0);
    p.parseLine(
      assistant('m1', {
        input_tokens: 5,
        cache_read_input_tokens: 10_000,
        cache_creation_input_tokens: 2_000,
        output_tokens: 50,
      }),
    );
    p.parseLine(
      assistant('m2', {
        input_tokens: 3,
        cache_read_input_tokens: 40_000,
        cache_creation_input_tokens: 500,
        output_tokens: 80,
      }),
    );
    expect(p.contextTokens()).toBe(40_503);
    // a sub-agent's call does not grow the session's own context
    p.parseLine(assistant('m3', { input_tokens: 99_000 }, { parent_tool_use_id: 'toolu_1' }));
    expect(p.contextTokens()).toBe(40_503);
  });

  it('a result line with zero usage (a crash on exit) does not wipe out what the messages reported', () => {
    const p = new ClaudeStreamParser();
    p.parseLine(assistant('m1', { input_tokens: 5, cache_read_input_tokens: 10_000, output_tokens: 50 }));
    p.parseLine(assistant('m2', { input_tokens: 3, cache_read_input_tokens: 12_000, output_tokens: 80 }));
    p.parseLine(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    );
    expect(p.usage()).toMatchObject({ inputTokens: 8, outputTokens: 130, cacheReadTokens: 22_000 });
  });

  it('a real result total still wins over the per-message sums', () => {
    const p = new ClaudeStreamParser();
    p.parseLine(assistant('m1', { input_tokens: 5, output_tokens: 50 }));
    p.parseLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'ok',
        usage: { input_tokens: 7, output_tokens: 60 },
        total_cost_usd: 0.1,
      }),
    );
    expect(p.usage()).toMatchObject({ inputTokens: 7, outputTokens: 60, costUsd: 0.1 });
  });
});

describe('claude command: shell timeout, cache TTL, resume, skills', () => {
  it('card shifts get an 11 minute default shell timeout (aom question --wait takes up to 10)', () => {
    const card = buildClaudeCommand(shiftInput({ kind: 'card' }), cfg);
    expect(card.env.BASH_DEFAULT_TIMEOUT_MS).toBe(String(CARD_BASH_DEFAULT_TIMEOUT_MS));
    expect(CARD_BASH_DEFAULT_TIMEOUT_MS).toBe(660_000);
    expect(Number(card.env.BASH_MAX_TIMEOUT_MS)).toBeGreaterThan(CARD_BASH_DEFAULT_TIMEOUT_MS);
    // other kinds keep the 5 minute default
    expect(buildClaudeCommand(shiftInput({ kind: 'question' }), cfg).env.BASH_DEFAULT_TIMEOUT_MS).toBe(
      '300000',
    );
    expect(buildClaudeCommand(shiftInput(), cfg).env.BASH_DEFAULT_TIMEOUT_MS).toBe('300000');
  });

  it('short shifts set the 5 minute prompt cache; others leave the default', () => {
    expect(
      buildClaudeCommand(shiftInput({ promptCacheTtl: '5m' }), cfg).env.CLAUDE_CODE_PROMPT_CACHE_TTL,
    ).toBe('5m');
    expect(buildClaudeCommand(shiftInput(), cfg).env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBeUndefined();
  });

  it('a card shift passes --resume, and every agent session runs with skills off', () => {
    const c = buildClaudeCommand(shiftInput({ resumeSessionId: 'sess-1' }), cfg);
    expect(c.args.slice(c.args.indexOf('--resume'), c.args.indexOf('--resume') + 2)).toEqual([
      '--resume',
      'sess-1',
    ]);
    expect(c.args).toContain('--disable-slash-commands');
    const chat: ChatStartInput = {
      chatId: 'c1',
      message: 'hi',
      cwd: '/x',
      sandbox: shiftInput().sandbox,
      agent: shiftInput().agent,
      env: {},
      readOnly: true,
    };
    expect(buildClaudeChatCommand(chat, cfg).args).toContain('--disable-slash-commands');
  });
});

describe('DevOps guard hook in the settings', () => {
  const hook = "'/usr/bin/node' '/runner/aom.mjs' 'devops-guard'";
  it('a DevOps shift and a DevOps chat run every Bash command through the hook', () => {
    const ctx = policyCtx({ guardHookCommand: hook });
    for (const s of [
      buildShiftSettings(devopsRole.permissions, ctx, POLICY_PATHS, 'devops', true),
      buildDevopsChatSettings(devopsRole.permissions, ctx, POLICY_PATHS),
    ]) {
      expect(s.hooks?.PreToolUse).toEqual([
        { matcher: 'Bash', hooks: [{ type: 'command', command: hook, timeout: 20 }] },
      ]);
    }
  });

  it('no other role has hooks', () => {
    const ctx = policyCtx({ guardHookCommand: hook });
    expect(buildShiftSettings(builder.permissions, ctx, POLICY_PATHS, 'builder').hooks).toBeUndefined();
    expect(buildShiftSettings(reviewer.permissions, ctx, POLICY_PATHS, 'reviewer').hooks).toBeUndefined();
  });
});

describe('session registry and resume rules', () => {
  const mk = (now: () => number = Date.now) => new SessionRegistry(join(tmp(), 'sessions.json'), now);

  it('names Claude Code project folders the way it does (spiked with claude 2.1.302)', () => {
    expect(projectDirName('/tmp/x/a.b_c')).toBe('-tmp-x-a-b-c');
    expect(projectDirName('/home/u/.aom-runner/worktrees/TOY-0192abcd/TOY-1')).toBe(
      '-home-u--aom-runner-worktrees-TOY-0192abcd-TOY-1',
    );
  });

  it('decides: resume, too large, too old, other agent, unknown, transcript gone', () => {
    let now = Date.parse('2026-10-17T10:00:00Z');
    const reg = mk(() => now);
    const configDir = tmp();
    const cwd = '/data/worktrees/TOY/TOY-1';
    reg.record({ sessionId: 's-ok', agentId: 'A', cwd, contextTokens: 50_000 });
    const f = transcriptFile(configDir, cwd, 's-ok');
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, '{}\n');
    expect(reg.decide('s-ok', 'A', configDir).state).toBe('resumed');
    expect(reg.decide('s-ok', 'B', configDir).state).toBe('fresh_other_agent');
    expect(reg.decide('nope', 'A', configDir).state).toBe('fresh_unknown_session');
    reg.updateContext('s-ok', RESUME_MAX_CONTEXT_TOKENS + 1);
    expect(reg.decide('s-ok', 'A', configDir).state).toBe('fresh_too_large');
    reg.updateContext('s-ok', RESUME_MAX_CONTEXT_TOKENS); // the limit itself is allowed
    expect(reg.decide('s-ok', 'A', configDir).state).toBe('resumed');
    now += RESUME_MAX_AGE_MS + 1;
    expect(reg.decide('s-ok', 'A', configDir).state).toBe('fresh_too_old');
    now = Date.parse('2026-10-17T10:30:00Z');
    reg.record({ sessionId: 's-lost', agentId: 'A', cwd, contextTokens: 1000 });
    expect(reg.decide('s-lost', 'A', tmp()).state).toBe('fresh_transcript_missing');
  });

  it('a resumed session keeps its first start (the 4 hours count from the first shift), also under a new id', () => {
    let now = Date.parse('2026-10-17T10:00:00Z');
    const reg = mk(() => now);
    reg.record({ sessionId: 's1', agentId: 'A', cwd: '/a' });
    now += 3 * 3_600_000;
    reg.record({ sessionId: 's1', agentId: 'A', cwd: '/b' });
    reg.record({ sessionId: 's2', agentId: 'A', cwd: '/b', inheritFrom: 's1' });
    expect(reg.get('s1')?.startedAt).toBe('2026-10-17T10:00:00.000Z');
    expect(reg.get('s2')?.startedAt).toBe('2026-10-17T10:00:00.000Z');
  });

  it('survives a restart (the file is read again) and a damaged file only means "unknown"', () => {
    const file = join(tmp(), 'sessions.json');
    new SessionRegistry(file).record({ sessionId: 's1', agentId: 'A', cwd: '/a', contextTokens: 5 });
    expect(new SessionRegistry(file).get('s1')?.contextTokens).toBe(5);
    writeFileSync(file, '{not json');
    expect(new SessionRegistry(file).get('s1')).toBeUndefined();
  });

  it('copies the transcript into the new worktree folder, never overwriting, and reports a missing one', () => {
    const configDir = tmp();
    const from = '/data/worktrees/TOY/TOY-1';
    const to = '/data/worktrees/TOY/TOY-2';
    const src = transcriptFile(configDir, from, 's1');
    mkdirSync(join(src, '..'), { recursive: true });
    writeFileSync(src, 'line 1\n');
    expect(copySessionTranscript(configDir, 's1', to, from)).toBe('copied');
    const dest = transcriptFile(configDir, to, 's1');
    expect(readFileSync(dest, 'utf8')).toBe('line 1\n');
    writeFileSync(dest, 'line 1\nline 2\n'); // the session went on in the new folder
    expect(copySessionTranscript(configDir, 's1', to, from)).toBe('present');
    expect(readFileSync(dest, 'utf8')).toBe('line 1\nline 2\n');
    // without the old cwd it is found in any project folder of the config dir
    expect(copySessionTranscript(configDir, 's1', '/data/worktrees/TOY/TOY-3')).toBe('copied');
    expect(copySessionTranscript(configDir, 'missing', to, from)).toBe('missing');
  });
});

describe('runner.error: sanitised before it leaves the machine', () => {
  const home = '/home/user';
  it('keeps the error kind, function names and file basenames; masks paths, ids and secrets', () => {
    const err = new TypeError(
      'cannot read /home/user/.aom-runner/worktrees/TOY-0192abcd/TOY-1/x.ts for 0192a3f6-7b1c-7a2d-8c3e-0123456789a1 with token=abc123def456 at https://u:p4ss@host/x',
    );
    err.stack = `TypeError: cannot read\n    at doThing (/home/user/.aom-runner/dist/aom-runner.mjs:120:15)\n    at async Runner.start (file:///home/user/src/runner.ts:9:3)`;
    const p = sanitizeError(err, { version: '0.1.24', context: 'shift.card', home });
    expect(p.message).not.toMatch(/pieter|abc123def456|p4ss|0192a3f6/);
    expect(p.stack).toBe('at doThing (aom-runner.mjs:120:15)\nat async Runner.start (runner.ts:9:3)');
    expect(p).toMatchObject({ version: '0.1.24', context: 'shift.card' });
    expect(p.signature).toMatch(/^TypeError:doThing \(aom-runner\.mjs\):[0-9a-f]{10}$/);
  });

  it('groups the same fault by signature whatever the numbers and quoted values in the message', () => {
    const a = sanitizeError(new Error("ENOENT: no such file 'a.txt' after 12 tries"), { version: '1' });
    const b = sanitizeError(new Error("ENOENT: no such file 'b.txt' after 99 tries"), { version: '1' });
    const c = sanitizeError(new Error('a different failure'), { version: '1' });
    expect(a.signature).toBe(b.signature);
    expect(a.signature).not.toBe(c.signature);
  });

  it('takes only the first line of the message (a failed command prints its arguments below)', () => {
    const p = sanitizeError(new Error('git failed\nfatal: could not read Password for https://x'), {
      version: '1',
    });
    expect(p.message).toBe('git failed');
  });

  it('handles non-Error values', () => {
    expect(sanitizeError('plain string', { version: '1' }).message).toBe('plain string');
    expect(sanitizeError({ a: 1 }, { version: '1' }).message).toBe('{"a":1}');
  });

  it('handlers report an unhandled rejection and keep running; an uncaught exception reports then exits; capped per hour', async () => {
    const handlers = new Map<string, (arg: never) => void>();
    const proc = {
      on: (ev: string, fn: (arg: never) => void) => handlers.set(ev, fn),
      off: (ev: string) => handlers.delete(ev),
    } as unknown as Pick<NodeJS.Process, 'on' | 'off'>;
    const reports: string[] = [];
    const exits: number[] = [];
    const logged: string[] = [];
    let t = 0;
    const off = installErrorHandlers({
      report: (e) => reports.push(`${e.context}:${e.message}`),
      version: '0.1.24',
      log: { error: (m) => logged.push(m) },
      exit: (c) => exits.push(c),
      maxPerHour: 2,
      proc,
      now: () => t,
    });
    handlers.get('unhandledRejection')?.(new Error('lost promise') as never);
    expect(reports).toEqual(['unhandledRejection:lost promise']);
    expect(exits).toEqual([]);
    handlers.get('uncaughtException')?.(new Error('sync boom') as never);
    handlers.get('unhandledRejection')?.(new Error('third') as never); // over the cap of 2 per hour
    expect(reports).toEqual(['unhandledRejection:lost promise', 'uncaughtException:sync boom']);
    expect(logged).toHaveLength(3);
    await new Promise((r) => setTimeout(r, 1100));
    expect(exits).toEqual([1]);
    t += 3_700_000; // an hour later the cap has room again
    handlers.get('unhandledRejection')?.(new Error('later') as never);
    expect(reports.at(-1)).toBe('unhandledRejection:later');
    off();
    expect(handlers.size).toBe(0);
  });
});

describe('devops.audit rpc', () => {
  const entry = {
    at: '2026-10-17T10:00:00.000Z',
    sessionRef: 'shift-1',
    kind: 'shift' as const,
    decision: 'refused' as const,
    rule: 'off_workstation',
    command: 'ssh uat --password=hunter2 ls',
  };

  it('writes the workstation audit log and sends the entries (redacted again) to the server', () => {
    const dir = tmp();
    const logFile = join(dir, 'logs', 'devops-audit.jsonl');
    const sent: unknown[][] = [];
    const r = recordDevopsAudit(
      { entries: [entry] },
      { isDevops: true, logFile, send: (e) => sent.push(e), redact: redactCommand },
    );
    expect(r).toEqual({ ok: true, result: { recorded: 1 } });
    expect(readFileSync(logFile, 'utf8')).not.toContain('hunter2');
    expect(JSON.stringify(sent)).not.toContain('hunter2');
    expect(sent[0]).toHaveLength(1);
  });

  it('is for the DevOps engineer only and refuses bad input', () => {
    const base = { logFile: join(tmp(), 'a.jsonl'), send: () => {}, redact: redactCommand };
    expect(recordDevopsAudit({ entries: [entry] }, { ...base, isDevops: false }).ok).toBe(false);
    expect(recordDevopsAudit({ entries: [{ nope: 1 }] }, { ...base, isDevops: true }).ok).toBe(false);
    expect(recordDevopsAudit({}, { ...base, isDevops: true }).ok).toBe(false);
  });
});

describe('role smoke test', () => {
  it('settingsProblem: a bare Edit/Write deny (the old reviewer rule) fails, the scoped one passes', () => {
    const paths = runnerPaths('/data');
    const agentDir = '/data/agents/a1';
    const ok = settingsProblem(reviewer, paths, `${agentDir}/scratch`, '/data/worktrees/TOY/TOY-1', agentDir);
    expect(ok).toBeNull();
    // the rule check itself: the old bare deny, a missing scratch allow and a bare Bash deny are each caught
    const tools = new Set(['read', 'shell']);
    const scratch = `${agentDir}/scratch`;
    const good = ['Bash', 'Edit(//data/agents/a1/scratch/**)'];
    expect(rulesProblem({ allow: good, deny: ['Edit', 'Write'] }, 'reviewer', tools, scratch)).toMatch(
      /bare Edit\/Write deny/,
    );
    expect(rulesProblem({ allow: ['Bash'], deny: [] }, 'reviewer', tools, scratch)).toMatch(
      /scratch folder is not writable/,
    );
    expect(rulesProblem({ allow: good, deny: ['Bash'] }, 'reviewer', tools, scratch)).toMatch(/bare Bash/);
    expect(rulesProblem({ allow: good, deny: [] }, 'reviewer', tools, scratch)).toBeNull();
    // every built-in role: the settings keep the scratch folder writable where the role has no edit tool
    for (const role of BUILTIN_ROLES)
      expect(
        settingsProblem(role, paths, `${agentDir}/scratch`, '/data/worktrees/TOY/TOY-1', agentDir),
      ).toBeNull();
  });

  it('every built-in role goes down its handoff path (the real aom shim, its sandbox env, the runner IPC)', async () => {
    const h = await startHarness();
    try {
      const results = await runRoleSmoke({ paths: runnerPaths(h.dataDir), ipc: h.runner.ipc });
      expect(results.filter((r) => !r.ok)).toEqual([]);
      expect(results.map((r) => r.roleKey)).toEqual(
        expect.arrayContaining(['builder', 'reviewer', 'tester', 'ba', 'devops', 'ceo']),
      );
      // nothing reached the server, and the smoke agents' folders are gone
      expect(h.server.of('shift.report')).toHaveLength(0);
      expect(existsSync(join(h.dataDir, 'agents', 'smoke-reviewer'))).toBe(false);
    } finally {
      await h.stop();
    }
  }, 120_000);

  it('a role whose aom path is broken fails with a reason', async () => {
    const h = await startHarness();
    try {
      const results = await runRoleSmoke({
        paths: runnerPaths(h.dataDir),
        ipc: h.runner.ipc,
        roles: [reviewer],
        aom: [
          process.execPath,
          '-e',
          'process.stderr.write("cannot reach the runner"); process.exit(1)',
          '--',
        ],
      });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ roleKey: 'reviewer', ok: false });
      expect(results[0]?.detail).toMatch(/cannot reach the runner/);
    } finally {
      await h.stop();
    }
  }, 60_000);

  it('the runner sends role.smoke after the first welcome (once per process)', async () => {
    const h = await startHarness({}, { roleSmoke: true, roleSmokeRoles: [reviewer, builder] });
    try {
      const msg = await h.server.waitFor('role.smoke', () => true, 60_000);
      expect(msg.results.map((r) => [r.roleKey, r.ok])).toEqual([
        ['reviewer', true],
        ['builder', true],
      ]);
      expect(msg.runnerVersion).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      await h.stop();
    }
  }, 120_000);
});

describe('DevOps chat: aom devops-approval, aom sudo and the audit rpc', () => {
  async function chatWith(devops: boolean) {
    const posted: Array<Record<string, unknown>> = [];
    const sudoCalls: string[][] = [];
    const sent: Array<[string, unknown]> = [];
    const root = tmp();
    const paths = runnerPaths(root);
    const ipc = new IpcServer();
    await ipc.start();
    const manager = new ChatManager({
      paths,
      adapters: new Map(),
      ipc,
      send: (type, payload) => void sent.push([type, payload]),
      rpc: async (_id, method, params) => {
        if (method === 'thread.post') posted.push(params);
        return { ok: true, result: {} };
      },
      sudoRun: async (cmd, args) => {
        sudoCalls.push([cmd, ...args]);
        return { exitCode: 0, stdout: 'done', stderr: '' };
      },
    });
    const chat = { msg: { chatId: 'c1', agent: { isDevops: devops, roleKey: devops ? 'devops' : 'ba' } } };
    const handler = (
      manager as unknown as { handlerFor(c: unknown): import('../src/ipc/server.ts').ShiftIpcHandler }
    ).handlerFor(chat);
    return { handler, posted, sudoCalls, sent, paths, close: () => ipc.stop() };
  }

  it('devops-approval is posted to the conversation for the owner, and tells the agent to wait', async () => {
    const t = await chatWith(true);
    const r = await t.handler.report({
      report: {
        kind: 'outcome',
        outcomeId: 'devops_approval',
        note: 'Needs approval: restart uat',
        data: {
          action: 'restart uat',
          reason: 'it hangs',
          commands: ['ssh uat systemctl restart app --password=x'],
        },
      },
    } as never);
    expect(r).toMatchObject({ accepted: true });
    expect((r as { message: string }).message).toMatch(/wait for the owner/);
    expect(String(t.posted[0]?.body)).toMatch(/Approval needed.*restart uat/s);
    expect(String(t.posted[0]?.body)).not.toContain('--password=x');
    await t.close();
  });

  it('other agents cannot use devops-approval or aom sudo in a chat', async () => {
    const t = await chatWith(false);
    const rep = await t.handler.report({
      report: { kind: 'outcome', outcomeId: 'devops_approval', note: 'x', data: {} },
    } as never);
    expect((rep as { accepted: boolean }).accepted).toBe(false);
    const sudo = await t.handler.rpc({ method: 'sudo.run', params: { argv: ['ls'] } });
    expect(sudo.ok).toBe(false);
    expect(t.sudoCalls).toEqual([]);
    await t.close();
  });

  it('aom sudo works in the DevOps chat and the guard hook can report its audit entries', async () => {
    const t = await chatWith(true);
    const sudo = await t.handler.rpc({ method: 'sudo.run', params: { argv: ['apt-get', 'install', 'jq'] } });
    expect(sudo).toMatchObject({ ok: true, result: { exitCode: 0, stdout: 'done' } });
    expect(t.sudoCalls).toEqual([['apt-get', 'install', 'jq']]);
    const audit = await t.handler.rpc({
      method: 'devops.audit',
      params: {
        entries: [
          {
            at: '2026-10-17T10:00:00.000Z',
            sessionRef: 'c1',
            kind: 'chat',
            decision: 'allowed',
            rule: 'ok',
            command: 'docker ps',
          },
        ],
      },
    });
    expect(audit).toMatchObject({ ok: true, result: { recorded: 1 } });
    expect(t.sent.map(([type]) => type)).toContain('devops.audit');
    expect(existsSync(join(t.paths.logs, 'devops-audit.jsonl'))).toBe(true);
    await t.close();
  });
});
