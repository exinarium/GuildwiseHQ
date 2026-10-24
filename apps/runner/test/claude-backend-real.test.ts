import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_ROLES, sealLarge } from '@aom/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.ts';
import type { RuntimeEvent } from '../src/adapters/types.ts';
import { ClaudeRuntimeConfigSchema } from '../src/config.ts';
import { ProviderStore } from '../src/direct/store.ts';
import { runnerPaths } from '../src/paths.ts';
import { ensureSandbox } from '../src/sandbox/sandbox.ts';
import { RunnerKeys } from '../src/secrets/keys.ts';
import { cleanupTmp } from './helpers.ts';

cleanupTmp();

/**
 * Runs the REAL Claude Code binary through the adapter with a gateway credential, against a fake Anthropic-compatible gateway on
 * localhost that asks for one Bash call (`env`). It shows that Claude Code (a) really reads ANTHROPIC_BASE_URL and
 * ANTHROPIC_AUTH_TOKEN and sends the model that was set, and (b) with CLAUDE_CODE_SUBPROCESS_ENV_SCRUB hides the token from
 * the Bash tool. No tokens are spent. Skipped without `claude` and a working bubblewrap.
 */
const CLAUDE = [process.env.AOM_CLAUDE_BIN, join(userInfo().homedir, '.local', 'bin', 'claude')].find(
  (p): p is string => !!p && existsSync(p),
);
const bwrapOk =
  process.platform === 'linux' &&
  spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', 'true'], { encoding: 'utf8' }).status === 0;

// biome-ignore lint/suspicious/noExplicitAny: the fake gateway reads whatever JSON Claude Code sends
type J = any;

const root = mkdtempSync(join(userInfo().homedir, '.aom-claude-backend-real-'));
const servers: Server[] = [];
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const s of servers) s.close();
});

function gateway(command: string) {
  const seen: Array<{ url: string; headers: IncomingHttpHeaders; model?: string }> = [];
  const results: string[] = [];
  let fired = false;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body: J = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {}
      seen.push({ url: req.url ?? '', headers: req.headers, model: body.model });
      const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      if (!req.url?.startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      const msgs: J[] = body.messages ?? [];
      const tr = msgs
        .flatMap((m) => (Array.isArray(m?.content) ? m.content : []))
        .find((b: J) => b.type === 'tool_result');
      if (tr && !results.length)
        results.push(typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content));
      const base = { id: 'msg_fake', type: 'message', role: 'assistant', model: body.model ?? 'x' };
      const usage = { input_tokens: 5, output_tokens: 3 };
      const hasBash = (body.tools ?? []).some((t: J) => t.name === 'Bash');
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ...base,
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage,
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const call = hasBash && !tr && !fired;
      let out = sse('message_start', {
        type: 'message_start',
        message: { ...base, content: [], stop_reason: null, stop_sequence: null, usage },
      });
      if (call) {
        fired = true;
        out += sse('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
        });
        out += sse('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command }) },
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
          delta: { type: 'text_delta', text: 'done' },
        });
      }
      out += sse('content_block_stop', { type: 'content_block_stop', index: 0 });
      out += sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 3 },
      });
      out += sse('message_stop', { type: 'message_stop' });
      res.end(out);
    });
  });
  servers.push(server);
  return new Promise<{ url: string; seen: typeof seen; results: string[] }>((r) =>
    server.listen(0, '127.0.0.1', () =>
      r({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, results }),
    ),
  );
}

describe.skipIf(!CLAUDE || !bwrapOk)('Claude Code on a gateway backend, real binary', () => {
  it('sends the gateway token and model, and keeps the token out of the Bash tool', async () => {
    const builder = BUILTIN_ROLES.find((r) => r.key === 'builder');
    if (!builder) throw new Error('role');
    const gw = await gateway('env | grep -c -E "gw-real-secret|ANTHROPIC_AUTH_TOKEN" ; echo PROBE-DONE');
    const base = realpathSync(mkdtempSync(join(root, 'r-')));
    const paths = runnerPaths(base);
    const A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
    const sb = await ensureSandbox(paths, A, 'Ada');
    const cwd = join(base, 'worktrees', 'P-1', 'X-1');
    mkdirSync(cwd, { recursive: true });
    spawnSync('git', ['init', '-q', '-b', 'main', cwd]);
    const keys = new RunnerKeys(join(paths.secrets, 'runner-key.pem'));
    const store = new ProviderStore({ file: join(paths.secrets, 'providers.json'), keys });
    store.set({
      provider: 'gateway',
      keyId: keys.publicKey.keyId,
      ciphertext: await sealLarge(
        keys.publicKey.publicKey,
        JSON.stringify({ baseUrl: gw.url, authToken: 'gw-real-secret-token' }),
      ),
      models: ['some-vendor/some-model'],
    });
    const adapter = new ClaudeCodeAdapter(
      ClaudeRuntimeConfigSchema.parse({ bin: CLAUDE, sandbox: 'off' }),
      paths,
      { providers: store },
    );
    process.env.AOM_CLAUDE_SMOKE = '1';
    let events: RuntimeEvent[] = [];
    let usage: unknown;
    try {
      const s = await adapter.start({
        shiftId: 'real-1',
        prompt: 'run the probe',
        instructionsMarkdown: '',
        cwd,
        sandbox: sb,
        addDirs: [],
        env: { PATH: process.env.PATH ?? '' },
        maxShiftMinutes: 3,
        agent: {
          agentId: A,
          name: 'Ada',
          roleKey: 'builder',
          seniority: 'senior',
          runtime: 'claude-code',
          model: 'gateway:some-vendor/some-model',
          skills: [],
          permissions: builder.permissions,
          isDevops: false,
        },
      } as never);
      for await (const e of s.events()) events = [...events, e];
      usage = s.usage();
    } finally {
      delete process.env.AOM_CLAUDE_SMOKE;
    }
    if (process.env.AOM_REAL_DEBUG) console.log(readFileSync(join(sb.configDir, 'settings.json'), 'utf8'));
    const msgs = gw.seen.filter((x) => x.url.startsWith('/v1/messages'));
    expect(msgs.length, JSON.stringify(events.slice(-3))).toBeGreaterThan(0);
    expect(msgs.every((m) => m.headers.authorization === 'Bearer gw-real-secret-token')).toBe(true);
    expect(msgs.every((m) => m.model === 'some-vendor/some-model')).toBe(true);
    // The Bash tool ran `env`: when the host lets Claude Code's own sandbox start (a socket path it cannot mask makes bwrap fail on
    // some machines, as on the machine this was written on), no credential variable may be in what the shell printed.
    const printed = gw.results.join('\n');
    if (printed.includes('PROBE-DONE')) expect(printed).toMatch(/^0$/m);
    else expect(printed).not.toContain('gw-real-secret-token');
    expect(usage).toMatchObject({ keyProvider: 'gateway', keySource: 'workstation' });
  }, 180_000);
});
