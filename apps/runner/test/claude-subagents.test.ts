import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { loadSubagentGuardConfig, runSubagentGuard } from '../src/delegate/subagent-guard.ts';
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
