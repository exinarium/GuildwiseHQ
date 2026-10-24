import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
  buildClaudeChatCommand,
  buildClaudeCommand,
  ClaudeCodeAdapter,
} from '../src/adapters/claude-code.ts';
import { ClaudeStreamParser } from '../src/adapters/claude-stream-parser.ts';
import { agentsDocument, readNativeSubagentUsage } from '../src/adapters/claude-subagents.ts';
import type { NativeSubagent, RuntimeEvent, RuntimeSession } from '../src/adapters/types.ts';
import { ClaudeRuntimeConfigSchema } from '../src/config.ts';
import {
  loadSubagentGuardConfig,
  runSubagentDeadline,
  runSubagentDone,
  runSubagentGuard,
  SUBAGENT_MARKER_GRACE_MS,
} from '../src/delegate/subagent-guard.ts';
import { runnerPaths } from '../src/paths.ts';
import { ensureSandbox } from '../src/sandbox/sandbox.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();
const reviewer = BUILTIN_ROLES.find((r) => r.key === 'reviewer');
if (!reviewer) throw new Error('role');
const reviewerPermissions = reviewer.permissions;
const A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const cfg = ClaudeRuntimeConfigSchema.parse({});

const sub = (name: string, over: Partial<NativeSubagent> = {}): NativeSubagent => ({
  name,
  handle: name.replace('-', ':'),
  description: 'A subagent',
  prompt: 'You are one.',
  tools: ['Read', 'Grep', 'Glob'],
  model: 'haiku',
  profile: 'read_only',
  ...over,
});

describe('the native subagent definitions', () => {
  it('give each type its description, prompt, tools and model', () => {
    expect(
      agentsDocument([sub('bmad-analyst'), sub('agent-rex', { model: 'opus', tools: ['Read'] })]),
    ).toEqual({
      'bmad-analyst': {
        description: 'A subagent',
        prompt: 'You are one.',
        tools: ['Read', 'Grep', 'Glob'],
        model: 'haiku',
      },
      'agent-rex': { description: 'A subagent', prompt: 'You are one.', tools: ['Read'], model: 'opus' },
    });
  });

  it('are passed to claude as a file, and only when there are some', () => {
    const base = {
      shiftId: 's1',
      prompt: 'hi',
      instructionsMarkdown: '',
      cwd: '/w',
      sandbox: { home: '/d/home', configDir: '/d/claude', scratch: '/d/scratch', tmp: '/d/tmp' },
      agent: { model: 'sonnet', roleKey: 'reviewer', permissions: reviewerPermissions, isDevops: false },
      env: {},
      addDirs: [],
      maxShiftMinutes: 5,
    };
    const none = buildClaudeCommand(base as never, cfg).args;
    expect(none).not.toContain('--agents');
    const some = buildClaudeCommand({ ...base, subagents: [sub('a')] } as never, cfg).args;
    expect(some[some.indexOf('--agents') + 1]).toBe('/d/claude/agents.json');
    const chat = buildClaudeChatCommand(
      { ...base, chatId: 'c', message: 'm', readOnly: true, subagents: [sub('a')] } as never,
      cfg,
    );
    expect(chat.args[chat.args.indexOf('--agents') + 1]).toBe('/d/claude/agents.json');
  });
});

describe('the Agent tool in the settings the adapter writes', () => {
  async function settingsFor(subagents: NativeSubagent[] | undefined, agent: Record<string, unknown> = {}) {
    const t = tmp();
    const bin = join(t, 'fakeclaude');
    writeFileSync(
      bin,
      `#!/bin/sh\nenv > ${join(t, 'env.txt')}\necho "$@" > ${join(t, 'argv.txt')}\necho '{"type":"system"}'\nexit 0\n`,
    );
    chmodSync(bin, 0o755);
    const cwd = join(t, 'data', 'worktrees', 'P4-98eeafb0', 'P4-3');
    mkdirSync(cwd, { recursive: true });
    const paths = runnerPaths(join(t, 'data'));
    const sandbox = await ensureSandbox(paths, A, 'Rev');
    const adapter = new ClaudeCodeAdapter(ClaudeRuntimeConfigSchema.parse({ bin, sandbox: 'off' }), paths);
    process.env.AOM_CLAUDE_SMOKE = '1';
    try {
      const s: RuntimeSession = await adapter.start({
        shiftId: 'zz',
        prompt: 'go',
        instructionsMarkdown: '',
        cwd,
        sandbox,
        addDirs: [],
        env: {},
        maxShiftMinutes: 5,
        ...(subagents ? { subagents } : {}),
        agent: {
          agentId: A,
          name: 'Rev',
          roleKey: 'reviewer',
          seniority: 'senior',
          runtime: 'claude-code',
          model: 'sonnet',
          skills: [],
          permissions: reviewerPermissions,
          isDevops: false,
          ...agent,
        },
      } as never);
      const ev: RuntimeEvent[] = [];
      for await (const e of s.events()) ev.push(e);
      return {
        settings: JSON.parse(readFileSync(join(sandbox.configDir, 'settings.json'), 'utf8')),
        argv: readFileSync(join(t, 'argv.txt'), 'utf8'),
        env: readFileSync(join(t, 'env.txt'), 'utf8'),
        dir: sandbox.configDir,
      };
    } finally {
      delete process.env.AOM_CLAUDE_SMOKE;
    }
  }

  it('is removed for an agent that has no delegation target: Claude Code’s own subagent types never run', async () => {
    for (const subs of [undefined, []]) {
      const r = await settingsFor(subs);
      expect(r.settings.permissions.deny).toEqual(expect.arrayContaining(['Agent', 'Task']));
      expect(r.argv).not.toContain('--agents');
      expect(
        r.settings.hooks?.PreToolUse?.some((h: { matcher: string }) => h.matcher.includes('Agent')) ?? false,
      ).toBe(false);
      expect(r.env).not.toContain('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS');
    }
  });

  it('keeps the CEO’s and the DevOps engineer’s own behaviour', async () => {
    for (const a of [{ roleKey: 'ceo' }, { isDevops: true }]) {
      const r = await settingsFor(undefined, a);
      expect(r.settings.permissions.deny).not.toContain('Agent');
    }
  });

  it('defines exactly the granted targets, guards the tool with a hook that fails closed, and keeps subagents in the foreground', async () => {
    const r = await settingsFor([sub('bmad-analyst'), sub('agent-rex')]);
    expect(r.argv).toContain(`--agents ${join(r.dir, 'agents.json')}`);
    expect(Object.keys(JSON.parse(readFileSync(join(r.dir, 'agents.json'), 'utf8')))).toEqual([
      'bmad-analyst',
      'agent-rex',
    ]);
    expect(JSON.parse(readFileSync(join(r.dir, 'subagent-guard.json'), 'utf8'))).toEqual({
      allowed: { 'bmad-analyst': 'bmad:analyst', 'agent-rex': 'agent:rex' },
    });
    const hook = r.settings.hooks.PreToolUse.find((h: { matcher: string }) => h.matcher === 'Agent|Task');
    expect(hook.hooks[0].command).toMatch(/subagent-guard.* \|\| exit 2$/);
    expect(hook.hooks[0].command).toContain('AOM_SUBAGENT_GUARD=');
    expect(r.settings.permissions.allow).toEqual(
      expect.arrayContaining(['Agent(bmad-analyst)', 'Agent(agent-rex)']),
    );
    // Claude Code’s own types are denied by name too, the hook being the allow-list for the rest
    expect(r.settings.permissions.deny).toEqual(
      expect.arrayContaining(['Agent(general-purpose)', 'Agent(Explore)']),
    );
    expect(r.settings.permissions.deny).not.toContain('Agent');
    expect(r.settings.permissions.deny).not.toContain('Task');
    // the parent waits for each subagent
    expect(r.env).toContain('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1');
    expect(r.env).toContain('AOM_SUBAGENT_GUARD=');
  });

  it('keeps the grant’s limit in the guard file and the settings, and the end of a call removes its marker', async () => {
    const r = await settingsFor([sub('rev', { timeoutSec: 45 }), sub('other')]);
    const guard = JSON.parse(readFileSync(join(r.dir, 'subagent-guard.json'), 'utf8'));
    expect(guard.limits).toEqual({ rev: 45 });
    expect(guard.stateDir).toBe(join(r.dir, 'subagent-live'));
    expect(existsSync(guard.stateDir)).toBe(true);
    const pre = r.settings.hooks.PreToolUse.find((h: { matcher: string }) => h.matcher === '*');
    // the check costs a shell test when nothing is running, and a failing hook lets the call through
    expect(pre.hooks[0].command).toContain('[ -n "$(ls -A ');
    expect(pre.hooks[0].command).toContain('|| exit 0; AOM_SUBAGENT_GUARD=');
    expect(pre.hooks[0].command).toMatch(/subagent-deadline.* \|\| exit 0$/);
    const post = r.settings.hooks.PostToolUse.find((h: { matcher: string }) => h.matcher === 'Agent|Task');
    expect(post.hooks[0].command).toMatch(/subagent-done.* \|\| exit 0$/);
  });

  it('adds no hook and no limit for a grant without a time limit', async () => {
    const r = await settingsFor([sub('rev')]);
    expect(r.settings.hooks.PreToolUse.some((h: { matcher: string }) => h.matcher === '*')).toBe(false);
    expect(r.settings.hooks.PostToolUse).toBeUndefined();
    expect(JSON.parse(readFileSync(join(r.dir, 'subagent-guard.json'), 'utf8')).limits).toBeUndefined();
  });
});

describe('the subagent guard', () => {
  const cfgOf = { allowed: { 'bmad-analyst': 'bmad:analyst' } };
  const hookInput = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      tool_name: 'Agent',
      tool_use_id: 'toolu_1',
      tool_input: { subagent_type: 'bmad-analyst', prompt: 'x' },
      ...over,
    });
  const denied = (r: { stdout: string }) =>
    JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === 'deny';

  it('lets a granted subagent through only after the runner allowed it, with the handle and the tool call id', async () => {
    const asked: unknown[] = [];
    const r = await runSubagentGuard({
      stdin: hookInput(),
      cfg: cfgOf,
      ask: async (...a) => {
        asked.push(a);
        return { ok: true };
      },
    });
    expect(r).toEqual({ stdout: '', code: 0 });
    expect(asked).toEqual([['bmad-analyst', 'bmad:analyst', 'toolu_1']]);
  });

  it('refuses every other subagent type, a call without a type or an id, and the old tool name of one', async () => {
    const ask = async () => ({ ok: true });
    for (const input of [
      hookInput({ tool_input: { subagent_type: 'general-purpose' } }),
      hookInput({ tool_input: { subagent_type: 'Explore' } }),
      hookInput({ tool_input: {} }),
      hookInput({ tool_use_id: undefined }),
      hookInput({ tool_name: 'Task', tool_input: { subagent_type: 'general-purpose' } }),
    ]) {
      const r = await runSubagentGuard({ stdin: input, cfg: cfgOf, ask });
      expect(denied(r), input).toBe(true);
    }
  });

  it('refuses when the runner or the server says no, and when the input is garbage (fail closed)', async () => {
    const no = await runSubagentGuard({
      stdin: hookInput(),
      cfg: cfgOf,
      ask: async () => ({ ok: false, error: 'project_budget_paused: the project has used its budget' }),
    });
    expect(denied(no)).toBe(true);
    expect(JSON.parse(no.stdout).hookSpecificOutput.permissionDecisionReason).toContain(
      'project_budget_paused',
    );
    expect(
      denied(await runSubagentGuard({ stdin: 'not json', cfg: cfgOf, ask: async () => ({ ok: true }) })),
    ).toBe(true);
    // a configuration that cannot be read allows nothing
    expect(loadSubagentGuardConfig('/no/such/file').allowed).toEqual({});
    expect(
      denied(
        await runSubagentGuard({ stdin: hookInput(), cfg: { allowed: {} }, ask: async () => ({ ok: true }) }),
      ),
    ).toBe(true);
  });

  it('does not touch other tools', async () => {
    const r = await runSubagentGuard({
      stdin: hookInput({ tool_name: 'Bash' }),
      cfg: cfgOf,
      ask: async () => ({ ok: false }),
    });
    expect(r).toEqual({ stdout: '', code: 0 });
  });
});

describe('the time limit of one native subagent call (R3c)', () => {
  const dirOf = () => join(tmp('aom-sub-live-'), 'live');
  const guardIn = (dir: string, now: number) => ({
    cfg: { allowed: { rev: 'agent:rev' }, limits: { rev: 30 }, stateDir: dir },
    now: () => now,
  });
  const agentCall = JSON.stringify({
    tool_name: 'Agent',
    tool_use_id: 'toolu_9',
    tool_input: { subagent_type: 'rev' },
  });
  const read = JSON.stringify({ tool_name: 'Read', tool_use_id: 'toolu_r', tool_input: { file_path: '/x' } });
  const denies = (r: { stdout: string }) =>
    r.stdout && JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === 'deny';

  it('starts the clock when the runner allowed the call, and refuses the tool calls that come after the limit', async () => {
    const dir = dirOf();
    const t0 = 1_000_000;
    const g = guardIn(dir, t0);
    expect(
      await runSubagentGuard({ stdin: agentCall, cfg: g.cfg, now: g.now, ask: async () => ({ ok: true }) }),
    ).toEqual({ stdout: '', code: 0 });
    expect(readdirSync(dir)).toEqual(['toolu_9.json']);
    // inside the limit: allowed
    expect(runSubagentDeadline({ stdin: read, cfg: g.cfg, now: () => t0 + 29_000 })).toEqual({
      stdout: '',
      code: 0,
    });
    // past it: refused, with the reason, for any tool, and for another subagent
    const late = runSubagentDeadline({ stdin: read, cfg: g.cfg, now: () => t0 + 31_000 });
    expect(denies(late)).toBe(true);
    expect(JSON.parse(late.stdout).hookSpecificOutput.permissionDecisionReason).toMatch(
      /time limit of 30 seconds.*answer with what you have/,
    );
    expect(denies(runSubagentDeadline({ stdin: agentCall, cfg: g.cfg, now: () => t0 + 31_000 }))).toBe(true);
    // the call ended: nothing is refused any more
    expect(runSubagentDone({ stdin: agentCall, cfg: g.cfg })).toEqual({ stdout: '', code: 0 });
    expect(readdirSync(dir)).toEqual([]);
    expect(runSubagentDeadline({ stdin: read, cfg: g.cfg, now: () => t0 + 40_000 })).toEqual({
      stdout: '',
      code: 0,
    });
  });

  it('does not start a clock when the runner refused, and drops a marker whose end was never seen', async () => {
    const dir = dirOf();
    const g = guardIn(dir, 5_000);
    const no = await runSubagentGuard({
      stdin: agentCall,
      cfg: g.cfg,
      now: g.now,
      ask: async () => ({ ok: false, error: 'budget' }),
    });
    expect(denies(no)).toBe(true);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    await runSubagentGuard({ stdin: agentCall, cfg: g.cfg, now: g.now, ask: async () => ({ ok: true }) });
    // the end was lost (a crash): after the limit and the grace it counts no more, and the marker is cleaned up
    const much = 5_000 + 30_000 + SUBAGENT_MARKER_GRACE_MS + 1;
    expect(runSubagentDeadline({ stdin: read, cfg: g.cfg, now: () => much })).toEqual({
      stdout: '',
      code: 0,
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('allows everything only when no limit is configured; a broken marker or a missing state folder refuses (fails closed)', () => {
    // no limit configured: nothing to hold
    expect(runSubagentDeadline({ stdin: read, cfg: { allowed: {} } })).toEqual({ stdout: '', code: 0 });
    // an unreadable hook input with healthy markers is not this hook's business
    const healthy = dirOf();
    mkdirSync(healthy, { recursive: true });
    expect(runSubagentDeadline({ stdin: 'not json', cfg: { allowed: {}, stateDir: healthy } })).toEqual({
      stdout: '',
      code: 0,
    });
    // a clock nobody can read cannot hold the limit: the call is refused
    const broken = dirOf();
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'broken.json'), '{nope');
    expect(denies(runSubagentDeadline({ stdin: read, cfg: { allowed: {}, stateDir: broken } }))).toBe(true);
    writeFileSync(join(broken, 'broken.json'), '{"startedAt":"x"}');
    expect(denies(runSubagentDeadline({ stdin: read, cfg: { allowed: {}, stateDir: broken } }))).toBe(true);
    // the state folder is gone
    expect(
      denies(runSubagentDeadline({ stdin: read, cfg: { allowed: {}, stateDir: join(dirOf(), 'missing') } })),
    ).toBe(true);
  });

  it('refuses to start a call whose clock cannot be started (the marker cannot be written), and writes it whole', async () => {
    const dir = dirOf();
    const g = guardIn(dir, 5_000);
    // the state folder path is under a regular file: it cannot be created
    const blocker = join(tmp('aom-sub-blk-'), 'file');
    writeFileSync(blocker, 'x');
    const cfg = { ...g.cfg, stateDir: join(blocker, 'live') };
    const r = await runSubagentGuard({ stdin: agentCall, cfg, now: g.now, ask: async () => ({ ok: true }) });
    expect(denies(r)).toBe(true);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toMatch(
      /time limit.*could not be started/,
    );
    // and the working case leaves a whole marker and no temporary file
    await runSubagentGuard({ stdin: agentCall, cfg: g.cfg, now: g.now, ask: async () => ({ ok: true }) });
    expect(readdirSync(dir).every((f) => f.endsWith('.json'))).toBe(true);
  });

  it('reads the limits and the folder from the guard file', () => {
    const dir = tmp('aom-sub-cfg-');
    const file = join(dir, 'g.json');
    writeFileSync(
      file,
      JSON.stringify({ allowed: { a: 'x:a' }, limits: { a: 20, b: 'x', c: -1 }, stateDir: '/some/live' }),
    );
    expect(loadSubagentGuardConfig(file)).toEqual({
      allowed: { a: 'x:a' },
      limits: { a: 20 },
      stateDir: '/some/live',
    });
  });
});

describe('what the parent’s stream reports when it used native subagents', () => {
  const lines = (calls: boolean) =>
    [
      { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-4-5' },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          model: 'claude-sonnet-4-5',
          usage: {
            input_tokens: 2,
            output_tokens: 10,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 7,
          },
          content: calls
            ? [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { subagent_type: 'a' } }]
            : [{ type: 'text', text: 'hi' }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'done',
        // modelUsage and the cost include the subagents; usage is the parent's own
        usage: {
          input_tokens: 2,
          output_tokens: 10,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 7,
        },
        modelUsage: {
          'claude-haiku-4-5': { inputTokens: 900, outputTokens: 900 },
          'claude-sonnet-4-5': { inputTokens: 2, outputTokens: 10 },
        },
        total_cost_usd: 0.5,
      },
    ].map((x) => JSON.stringify(x));

  it('keeps the parent’s own tokens and model, and drops the cost that includes the subagents', () => {
    const p = new ClaudeStreamParser();
    for (const l of lines(true)) p.parseLine(l);
    const u = p.usage();
    expect(u).toMatchObject({ inputTokens: 2, outputTokens: 10, model: 'claude-sonnet-4-5' });
    expect(u.costUsd).toBeUndefined();
  });

  it('keeps the reported cost and the dominant model when there was no subagent', () => {
    const p = new ClaudeStreamParser();
    for (const l of lines(false)) p.parseLine(l);
    expect(p.usage().costUsd).toBe(0.5);
    expect(p.usage().model).toBe('claude-haiku-4-5');
  });

  it('does not take a subagent’s own messages as the parent’s', () => {
    const p = new ClaudeStreamParser();
    for (const l of lines(true).slice(0, 2)) p.parseLine(l);
    p.parseLine(
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: 'toolu_1',
        message: {
          id: 'sub1',
          model: 'claude-haiku-4-5',
          usage: { input_tokens: 1000, output_tokens: 1000 },
          content: [],
        },
      }),
    );
    expect(p.usage().inputTokens).toBe(2);
    expect(p.usage().model).toBe('claude-sonnet-4-5');
  });
});

describe('reading what native subagents used from the transcripts', () => {
  function transcript(dir: string, agentId: string, meta: Record<string, unknown>, entries: unknown[]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
    writeFileSync(
      join(dir, `agent-${agentId}.jsonl`),
      `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`,
    );
  }
  const msg = (
    id: string,
    text: string,
    t: string,
    usage: Record<string, number>,
    model = 'claude-haiku-5-5',
  ) => ({
    type: 'assistant',
    timestamp: t,
    message: { id, model, usage, content: [{ type: 'text', text }] },
  });

  it('sums each subagent’s calls once, with its model, duration and last reply', () => {
    const config = tmp();
    const dir = join(config, 'projects', '-work-card', 'sess-1', 'subagents');
    transcript(dir, 'a1', { agentType: 'bmad-analyst', toolUseId: 'toolu_1' }, [
      { type: 'user', timestamp: '2026-10-24T10:00:00.000Z', message: { role: 'user', content: 'go' } },
      msg('m1', 'first', '2026-10-24T10:00:01.000Z', {
        input_tokens: 2,
        output_tokens: 30,
        cache_creation_input_tokens: 100,
      }),
      // written once per content block: counted once
      msg('m1', 'first', '2026-10-24T10:00:01.500Z', {
        input_tokens: 2,
        output_tokens: 30,
        cache_creation_input_tokens: 100,
      }),
      msg('m2', 'The answer is 4.', '2026-10-24T10:00:03.000Z', {
        input_tokens: 3,
        output_tokens: 20,
        cache_read_input_tokens: 100,
      }),
    ]);
    transcript(dir, 'a2', { agentType: 'agent-rex', toolUseId: 'toolu_2' }, [
      msg('m3', 'x', '2026-10-24T10:00:05.000Z', { input_tokens: 1, output_tokens: 1 }, 'claude-opus-5-5'),
    ]);
    const used = readNativeSubagentUsage(config, 'sess-1').sort((a, b) =>
      a.toolUseId.localeCompare(b.toolUseId),
    );
    expect(used).toHaveLength(2);
    expect(used[0]).toMatchObject({
      toolUseId: 'toolu_1',
      name: 'bmad-analyst',
      durationMs: 3000,
      summary: 'The answer is 4.',
      usage: {
        inputTokens: 5,
        outputTokens: 50,
        cacheReadTokens: 100,
        cacheWriteTokens: 100,
        model: 'claude-haiku-5-5',
      },
    });
    expect(used[1]?.usage.model).toBe('claude-opus-5-5');
  });

  it('can be read while the subagent runs: each read takes only the new lines, and a half-written line waits for its end', async () => {
    const { appendFileSync } = await import('node:fs');
    const config = tmp();
    const dir = join(config, 'projects', '-work-live', 'sess-live', 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'agent-a1.meta.json'),
      JSON.stringify({ agentType: 'analyst', toolUseId: 'toolu_live' }),
    );
    const file = join(dir, 'agent-a1.jsonl');
    const line = (id: string, input: number, output: number, t: string) =>
      `${JSON.stringify(msg(id, 'working', t, { input_tokens: input, output_tokens: output }))}`;
    writeFileSync(file, `${line('m1', 10, 100, '2026-10-24T10:00:01.000Z')}\n`);
    expect(readNativeSubagentUsage(config, 'sess-live')[0]?.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 100,
    });
    // a second call, then half of a third line: the half does not count yet
    const second = `${line('m2', 5, 50, '2026-10-24T10:00:02.000Z')}\n`;
    const third = line('m3', 7, 70, '2026-10-24T10:00:03.000Z');
    appendFileSync(file, second + third.slice(0, 30));
    expect(readNativeSubagentUsage(config, 'sess-live')[0]?.usage).toMatchObject({
      inputTokens: 15,
      outputTokens: 150,
    });
    // the rest of the line arrives
    appendFileSync(file, `${third.slice(30)}\n`);
    const u = readNativeSubagentUsage(config, 'sess-live')[0];
    expect(u?.usage).toMatchObject({ inputTokens: 22, outputTokens: 220 });
    expect(u?.durationMs).toBe(2000);
    // reading again changes nothing, and a complete last line without its newline is used
    expect(readNativeSubagentUsage(config, 'sess-live')[0]?.usage).toMatchObject({ inputTokens: 22 });
    appendFileSync(file, line('m4', 1, 1, '2026-10-24T10:00:04.000Z'));
    expect(readNativeSubagentUsage(config, 'sess-live')[0]?.usage).toMatchObject({
      inputTokens: 23,
      outputTokens: 221,
    });
    // a transcript that was replaced by a shorter one starts over
    writeFileSync(file, `${line('z1', 2, 3, '2026-10-24T10:01:00.000Z')}\n`);
    expect(readNativeSubagentUsage(config, 'sess-live')[0]?.usage).toMatchObject({
      inputTokens: 2,
      outputTokens: 3,
    });
  });

  it('finds nothing for another session, a missing folder, an unknown session id or a broken file', () => {
    const config = tmp();
    expect(readNativeSubagentUsage(config, 'nope')).toEqual([]);
    expect(readNativeSubagentUsage(config, undefined)).toEqual([]);
    const dir = join(config, 'projects', 'p', 'sess-2', 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-x.meta.json'), '{not json');
    writeFileSync(join(dir, 'agent-y.meta.json'), JSON.stringify({ agentType: 'a' }));
    expect(readNativeSubagentUsage(config, 'sess-2')).toEqual([]);
    expect(readNativeSubagentUsage(config, 'sess-1')).toEqual([]);
  });
});
