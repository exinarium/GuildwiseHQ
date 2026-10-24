import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_ROLES, type IpcRpcRequest } from '@aom/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.ts';
import type { NativeSubagent, RuntimeEvent } from '../src/adapters/types.ts';
import { ClaudeRuntimeConfigSchema } from '../src/config.ts';
import { IpcServer } from '../src/ipc/server.ts';
import { runnerPaths } from '../src/paths.ts';
import { ensureSandbox, sandboxEnv } from '../src/sandbox/sandbox.ts';
import { cleanupTmp } from './helpers.ts';

cleanupTmp();

/**
 * The REAL Claude Code binary and the adapter's real settings, hook and `--agents` file, against a local fake Anthropic API:
 * no tokens are spent and nothing leaves the machine. The model (the fake) first asks for a subagent type that is not granted,
 * then for the granted one. Checks, against the real tool: the `Agent` tool name and the hook input, that the guard refuses the
 * other type and asks the runner (over the real `aom subagent-guard` and IPC) before the granted one, that the subagent runs
 * with the granted definition and in the foreground, and that its usage is read from the transcript. Skipped without `claude`.
 */
const CLAUDE = [process.env.AOM_CLAUDE_BIN, join(userInfo().homedir, '.local', 'bin', 'claude')].find(
  (p): p is string => !!p && existsSync(p),
);
const enabled = CLAUDE !== undefined && spawnSync(CLAUDE as string, ['--version']).status === 0;

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

interface Seen {
  parentCalls: number;
  subagentCalls: Array<{ system: string; tools: string[] }>;
  toolResults: string[];
}

/** A fake /v1/messages that plays a parent asking for two subagent types, and the granted subagent answering. */
async function fakeAgentApi(first: string, second: string): Promise<{ url: string; seen: Seen }> {
  const seen: Seen = { parentCalls: 0, subagentCalls: [], toolResults: [] };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body: any = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {}
      const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      if (!req.url?.startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      const toolNames: string[] = (body.tools ?? []).map((t: any) => t.name);
      const base = {
        id: `msg_fake_${Math.random().toString(36).slice(2)}`,
        type: 'message',
        role: 'assistant',
        model: body.model ?? 'x',
      };
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ...base,
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
        return;
      }
      const isParent = toolNames.includes('Agent') || toolNames.includes('Task');
      const results = (body.messages ?? [])
        .flatMap((m: any) => (Array.isArray(m?.content) ? m.content : []))
        .filter((b: any) => b.type === 'tool_result');
      let out: string;
      const usage = isParent
        ? { input_tokens: 3, output_tokens: 4 }
        : { input_tokens: 11, output_tokens: 22 };
      out = sse('message_start', {
        type: 'message_start',
        message: { ...base, content: [], stop_reason: null, stop_sequence: null, usage },
      });
      let tool: { id: string; type: string } | undefined;
      if (isParent) {
        seen.parentCalls++;
        seen.toolResults = results.map((r: any) =>
          typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
        );
        if (results.length === 0) tool = { id: 'toolu_first', type: first };
        else if (results.length === 1) tool = { id: 'toolu_second', type: second };
      } else {
        seen.subagentCalls.push({ system: JSON.stringify(body.system ?? ''), tools: toolNames });
      }
      if (tool) {
        out += sse('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: tool.id, name: 'Agent', input: {} },
        });
        out += sse('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({
              description: 'sub',
              prompt: 'SUBTASK please',
              subagent_type: tool.type,
            }),
          },
        });
        out += sse('content_block_stop', { type: 'content_block_stop', index: 0 });
        out += sse('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: usage.output_tokens },
        });
      } else {
        out += sse('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        });
        out += sse('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: isParent ? 'all done' : 'SUB-REPLY' },
        });
        out += sse('content_block_stop', { type: 'content_block_stop', index: 0 });
        out += sse('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: usage.output_tokens },
        });
      }
      out += sse('message_stop', { type: 'message_stop' });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(out);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

const HOME_BASE = join(userInfo().homedir, '.aom-real-subagent-test');
afterAll(() => rmSync(HOME_BASE, { recursive: true, force: true }));

describe.skipIf(!enabled)('real Claude Code with native subagents (fake API, skipped without claude)', () => {
  it('runs the granted subagent after the runner allowed it, refuses another type, and its usage is read from the transcript', async () => {
    mkdirSync(HOME_BASE, { recursive: true });
    const root = realpathSync(mkdtempSync(join(HOME_BASE, 'r-')));
    const paths = runnerPaths(root);
    const A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
    const sandbox = await ensureSandbox(paths, A, 'Ada');
    const cwd = join(root, 'worktrees', 'P-1', 'X-1');
    mkdirSync(cwd, { recursive: true });
    spawnSync('git', ['init', '-q', '-b', 'main', cwd]);
    // the runner side of the guard: the real IPC server, answering `delegate.guard`
    const asked: Array<Record<string, unknown>> = [];
    const ipc = new IpcServer();
    await ipc.start();
    const token = ipc.registerShift({
      report: async () => ({ accepted: false, message: 'no', error: 'no' }) as never,
      rpc: async (r: IpcRpcRequest) => {
        asked.push({ method: r.method, ...r.params });
        return r.method === 'delegate.guard' ? { ok: true, result: {} } : { ok: false, error: 'no' };
      },
    });
    const api = await fakeAgentApi('general-purpose', 'rev');
    const adapter = new ClaudeCodeAdapter(
      ClaudeRuntimeConfigSchema.parse({
        bin: CLAUDE,
        sandbox: 'off',
        authMode: 'api_key',
        apiKey: 'sk-ant-fake-fake-fake',
      }),
      paths,
    );
    process.env.AOM_CLAUDE_SMOKE = '1';
    const subagent: NativeSubagent = {
      name: 'rev',
      handle: 'agent:rev',
      description: 'Reviews things',
      prompt: 'You are REV-PROMPT, a reviewer.',
      tools: ['Read', 'Grep', 'Glob'],
      model: 'haiku',
      profile: 'read_only',
    };
    try {
      const reviewer = BUILTIN_ROLES.find((r) => r.key === 'reviewer');
      const session = await adapter.start({
        shiftId: 'zz',
        prompt: 'Review the thing with a subagent.',
        instructionsMarkdown: '',
        cwd,
        sandbox,
        addDirs: [],
        subagents: [subagent],
        env: {
          ...sandboxEnv(sandbox),
          AOM_IPC_URL: ipc.url,
          AOM_SHIFT_TOKEN: token,
          AOM_SHIFT_ID: 'zz',
          ANTHROPIC_BASE_URL: api.url,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
          // list the Agent tool itself instead of deferring it behind ToolSearch (a non-Anthropic base URL defers tools)
          ENABLE_TOOL_SEARCH: 'false',
        },
        maxShiftMinutes: 3,
        agent: {
          agentId: A,
          name: 'Ada',
          roleKey: 'reviewer',
          seniority: 'senior',
          runtime: 'claude-code',
          model: 'claude-sonnet-4-5',
          skills: [],
          permissions: reviewer?.permissions,
          isDevops: false,
        },
      } as never);
      const events: RuntimeEvent[] = [];
      for await (const e of session.events()) events.push(e);
      const exit = events.at(-1);
      expect(exit).toMatchObject({ kind: 'exit', code: 0 });
      // the ungranted type was refused by the guard, with its words, and never reached the runner
      const results = api.seen.toolResults;
      expect(results[0]).toContain('not one of your delegation targets');
      expect(asked.filter((a) => a.method === 'delegate.guard')).toEqual([
        expect.objectContaining({ name: 'rev', handle: 'agent:rev', toolUseId: 'toolu_second' }),
      ]);
      // the granted one ran, with its prompt and only its tools, and its reply came back to the parent
      expect(api.seen.subagentCalls).toHaveLength(1);
      expect(api.seen.subagentCalls[0]?.system).toContain('REV-PROMPT');
      expect(api.seen.subagentCalls[0]?.tools.sort()).toEqual(['Glob', 'Grep', 'Read']);
      expect(results[1]).toContain('SUB-REPLY');
      // its usage is in its transcript, not in the parent’s total; the cost that includes it is dropped
      const used = session.nativeSubagentUsage?.() ?? [];
      expect(used).toHaveLength(1);
      expect(used[0]).toMatchObject({
        toolUseId: 'toolu_second',
        name: 'rev',
        usage: { inputTokens: 11, outputTokens: 22 },
      });
      const parent = events.find((e) => e.kind === 'usage');
      expect(parent && 'usage' in parent ? parent.usage.costUsd : 0).toBeUndefined();
    } finally {
      delete process.env.AOM_CLAUDE_SMOKE;
      await ipc.stop();
    }
  }, 120_000);

  it('R3c: refuses the tool calls of a subagent that ran past the grant’s time limit for one call, and lets the parent go on', async () => {
    mkdirSync(HOME_BASE, { recursive: true });
    const root = realpathSync(mkdtempSync(join(HOME_BASE, 'l-')));
    const paths = runnerPaths(root);
    const A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
    const sandbox = await ensureSandbox(paths, A, 'Ada');
    const cwd = join(root, 'worktrees', 'P-1', 'X-1');
    mkdirSync(cwd, { recursive: true });
    spawnSync('git', ['init', '-q', '-b', 'main', cwd]);
    const ipc = new IpcServer();
    await ipc.start();
    const token = ipc.registerShift({
      report: async () => ({ accepted: false, message: 'no', error: 'no' }) as never,
      rpc: async (r: IpcRpcRequest) =>
        r.method === 'delegate.guard' ? { ok: true, result: {} } : { ok: false, error: 'no' },
    });
    // a subagent that reads one file at once, then waits past the limit before the next read, until a tool result tells it the time is over
    // (the first read has the whole limit to arrive in, so a loaded machine does not turn it into a refusal)
    const seen = { subResults: [] as string[], parentResults: [] as string[], subCalls: 0 };
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body: any = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {}
        const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        const toolNames: string[] = (body.tools ?? []).map((t: any) => t.name);
        if (!req.url?.startsWith('/v1/messages') || !body.stream) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'm',
              type: 'message',
              role: 'assistant',
              model: 'x',
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          );
          return;
        }
        const isParent = toolNames.includes('Agent');
        const results = (body.messages ?? [])
          .flatMap((m: any) => (Array.isArray(m?.content) ? m.content : []))
          .filter((b: any) => b.type === 'tool_result')
          .map((r: any) => (typeof r.content === 'string' ? r.content : JSON.stringify(r.content)));
        const reply = (blocks: string, stop: string) => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(
            sse('message_start', {
              type: 'message_start',
              message: {
                id: `msg_${Math.random().toString(36).slice(2)}`,
                type: 'message',
                role: 'assistant',
                model: body.model ?? 'x',
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 2, output_tokens: 2 },
              },
            }) +
              blocks +
              sse('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: stop, stop_sequence: null },
                usage: { output_tokens: 2 },
              }) +
              sse('message_stop', { type: 'message_stop' }),
          );
        };
        const toolUse = (id: string, name: string, input: unknown) =>
          sse('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id, name, input: {} },
          }) +
          sse('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
          }) +
          sse('content_block_stop', { type: 'content_block_stop', index: 0 });
        const text = (t: string) =>
          sse('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          }) +
          sse('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: t },
          }) +
          sse('content_block_stop', { type: 'content_block_stop', index: 0 });
        if (isParent) {
          seen.parentResults = results;
          if (results.length === 0)
            return reply(
              toolUse('toolu_loop', 'Agent', {
                description: 'sub',
                prompt: 'read things',
                subagent_type: 'rev',
              }),
              'tool_use',
            );
          return reply(text('all done'), 'end_turn');
        }
        seen.subResults = results;
        seen.subCalls++;
        if (results.some((r: string) => /time limit/.test(r))) return reply(text('SUB-STOPPED'), 'end_turn');
        setTimeout(
          () =>
            reply(
              toolUse(`toolu_read_${seen.subCalls}`, 'Read', { file_path: join(cwd, '.git', 'HEAD') }),
              'tool_use',
            ),
          seen.subCalls === 1 ? 0 : 7_000,
        );
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const adapter = new ClaudeCodeAdapter(
      ClaudeRuntimeConfigSchema.parse({
        bin: CLAUDE,
        sandbox: 'off',
        authMode: 'api_key',
        apiKey: 'sk-ant-fake-fake-fake',
      }),
      paths,
    );
    process.env.AOM_CLAUDE_SMOKE = '1';
    const subagent: NativeSubagent = {
      name: 'rev',
      handle: 'agent:rev',
      description: 'Reviews things',
      prompt: 'You are REV-PROMPT, a reviewer.',
      tools: ['Read', 'Grep', 'Glob'],
      model: 'haiku',
      profile: 'read_only',
      timeoutSec: 6,
    };
    try {
      const reviewer = BUILTIN_ROLES.find((r) => r.key === 'reviewer');
      const session = await adapter.start({
        shiftId: 'zz2',
        prompt: 'Review the thing with a subagent.',
        instructionsMarkdown: '',
        cwd,
        sandbox,
        addDirs: [],
        subagents: [subagent],
        env: {
          ...sandboxEnv(sandbox),
          AOM_IPC_URL: ipc.url,
          AOM_SHIFT_TOKEN: token,
          AOM_SHIFT_ID: 'zz2',
          ANTHROPIC_BASE_URL: url,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
          ENABLE_TOOL_SEARCH: 'false',
        },
        maxShiftMinutes: 3,
        agent: {
          agentId: A,
          name: 'Ada',
          roleKey: 'reviewer',
          seniority: 'senior',
          runtime: 'claude-code',
          model: 'claude-sonnet-4-5',
          skills: [],
          permissions: reviewer?.permissions,
          isDevops: false,
        },
      } as never);
      const events: RuntimeEvent[] = [];
      for await (const e of session.events()) events.push(e);
      expect(events.at(-1)).toMatchObject({ kind: 'exit', code: 0 });
      // the early reads went through; once the call was over its six seconds the next read was refused with the reason,
      // and the subagent answered with what it had
      expect(seen.subResults.some((r) => /time limit of 6 seconds/.test(r))).toBe(true);
      expect(seen.subResults.filter((r) => !/time limit/.test(r)).length).toBeGreaterThanOrEqual(1);
      // the parent got the subagent's answer and was not held up by a marker that stayed behind
      expect(seen.parentResults.join(' ')).toContain('SUB-STOPPED');
    } finally {
      delete process.env.AOM_CLAUDE_SMOKE;
      await ipc.stop();
    }
  }, 120_000);
});
