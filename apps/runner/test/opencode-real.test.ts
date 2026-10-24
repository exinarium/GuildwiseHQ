import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { sealLarge } from '@aom/shared';
import { execa } from 'execa';
import { afterAll, describe, expect, it } from 'vitest';
import { probeHarnessSandbox, resetHarnessProbe } from '../src/adapters/harness-session.ts';
import { OpencodeAdapter } from '../src/adapters/opencode.ts';
import type { RuntimeEvent } from '../src/adapters/types.ts';
import { OpencodeRuntimeConfigSchema } from '../src/config.ts';
import { ProviderStore } from '../src/direct/store.ts';
import { runnerPaths } from '../src/paths.ts';
import { ensureSandbox } from '../src/sandbox/sandbox.ts';
import { RunnerKeys } from '../src/secrets/keys.ts';
import { sealOrg, sealWs } from './seal-helpers.ts';

/**
 * Opt-in: runs the REAL opencode binary (AOM_OPENCODE_REAL_BIN=/path/to/opencode, 1.19.4) through the adapter, inside the runner's
 * real bubblewrap sandbox, against fake provider APIs on localhost. No tokens, no login. Checks the permission rules, the
 * instructions and skills, the routes that carry the keys, the model list, and what the sandbox hides.
 */
const ORG = '11111111-1111-4111-8111-111111111111';
const BIN = process.env.AOM_OPENCODE_REAL_BIN;
const root = realpathSync(mkdtempSync(join(userInfo().homedir, '.aom-opencode-real-')));
const servers: Server[] = [];
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const s of servers) s.close();
});

type Step = { call: { name: string; args: Record<string, unknown> } } | { text: string };
interface Seen {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A fake of the chat-completions API (enough for every provider shape: the tests read what was asked, not what came back). */
function fakeApi(script: Step[]) {
  const seen: Seen[] = [];
  let n = 0;
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
    });
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: b });
      const title = b.includes('title generator');
      const step: Step = title ? { text: 'T' } : (script[n++] ?? { text: 'finished' });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: object, fin: string | null, usage?: object) =>
        res.write(
          `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm1', choices: [{ index: 0, delta, finish_reason: fin }], ...(usage ? { usage } : {}) })}\n\n`,
        );
      if ('call' in step) {
        chunk(
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                index: 0,
                id: `call_${n}`,
                type: 'function',
                function: { name: step.call.name, arguments: JSON.stringify(step.call.args) },
              },
            ],
          },
          null,
        );
        chunk({}, 'tool_calls', { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 });
      } else {
        chunk({ role: 'assistant', content: step.text }, null);
        chunk({}, 'stop', {
          prompt_tokens: 120,
          completion_tokens: 7,
          total_tokens: 127,
          prompt_tokens_details: { cached_tokens: 20 },
        });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  servers.push(server);
  return new Promise<{ url: string; seen: Seen[] }>((r) =>
    server.listen(0, '127.0.0.1', () =>
      r({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen }),
    ),
  );
}

const bwrapOk = probeHarnessSandbox().ok;
const BASE = {
  allowedTools: ['read', 'shell'],
  deniedShellPatterns: [],
  writableGlobs: null,
  mayCommit: false,
  browser: false,
  riskTiers: ['small', 'large'],
  readOrgRepos: false,
  repoIds: null,
};
const BUILDER = { ...BASE, allowedTools: ['read', 'edit', 'shell'], mayCommit: true };
const ANALYST = { ...BASE, allowedTools: ['read'] };

async function setup(
  name: string,
  providers: Array<{
    id: 'openai' | 'anthropic' | 'google' | 'openai-compatible';
    key?: string;
    org?: boolean;
    baseUrl?: string;
    models?: string[];
  }>,
) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const paths = runnerPaths(join(dir, 'data'));
  const A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
  const sb = await ensureSandbox(paths, A, 'Oc');
  const wt = join(dir, 'wt');
  mkdirSync(wt, { recursive: true });
  const keys = new RunnerKeys(join(paths.secrets, 'runner-key.pem'));
  const store = new ProviderStore({ file: join(paths.secrets, 'providers.json'), keys });
  for (const p of providers)
    store.set({
      provider: p.id,
      keyId: keys.publicKey.keyId,
      ...(p.org ? { source: 'org' as const, orgId: ORG, generation: 1 } : {}),
      ...(p.key
        ? {
            ciphertext: p.org
              ? await sealOrg(keys, ORG, p.id, p.key, 1, p.baseUrl)
              : await sealWs(keys, p.id, p.key, p.baseUrl),
          }
        : {}),
      ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
      models: p.models ?? [],
    });
  const aomBin = paths.bin;
  mkdirSync(aomBin, { recursive: true });
  writeFileSync(join(aomBin, 'aom'), `#!/bin/sh\necho "AOM-RAN $*"\n`);
  chmodSync(join(aomBin, 'aom'), 0o755);
  mkdirSync(join(dir, 'ipc'), { recursive: true });
  const sock = join(dir, 'ipc', 'ipc.sock');
  const ipc = createNetServer((c) => c.end('pong')).listen(sock);
  writeFileSync(join(dir, 'owner-secret.txt'), 'OWNER-SECRET-CONTENT');
  const nodeBin = dirname(process.execPath);
  const make = (host: object) =>
    new OpencodeAdapter(OpencodeRuntimeConfigSchema.parse({ bin: BIN }) as never, paths, store, {
      parent: { PATH: process.env.PATH ?? '' },
      home: join(dir, 'owner-home'),
      proxyTest: { allowPrivate: true },
      ...host,
    });
  const run = async (
    adapter: OpencodeAdapter,
    model: string,
    perms: object,
    opts: { roleKey?: string; chat?: boolean; skills?: boolean } = {},
  ) => {
    await adapter.writeInstructions(sb, '# Instructions\nINSTRUCTIONS-MARKER\n');
    const agent = {
      agentId: A,
      name: 'Oc',
      roleKey: opts.roleKey ?? 'builder',
      seniority: 'senior',
      runtime: 'opencode',
      model,
      skills: [],
      permissions: perms,
      isDevops: false,
    };
    const env = {
      PATH: `${aomBin}:${nodeBin}:/usr/bin:/bin`,
      HOME: sb.home,
      AOM_SHIFT_TOKEN: 'shift-token-xyz',
      AOM_IPC_SOCKET: sock,
    };
    const s = opts.chat
      ? await adapter.startChat({
          chatId: 'c1',
          message: 'hello there',
          cwd: wt,
          sandbox: sb,
          agent,
          env,
          readOnly: true,
        } as never)
      : await adapter.start({
          shiftId: 's1',
          prompt: 'do the work',
          instructionsMarkdown: '',
          cwd: wt,
          sandbox: sb,
          agent,
          env,
          addDirs: [],
          maxShiftMinutes: 3,
          ...(opts.skills
            ? {
                grantedSkills: [
                  {
                    name: 'demo-skill',
                    files: {
                      'SKILL.md':
                        '---\nname: demo-skill\ndescription: A demo skill that says hello.\n---\nSay hello.\n',
                    },
                  },
                ],
              }
            : {}),
        } as never);
    const ev: RuntimeEvent[] = [];
    for await (const e of s.events()) ev.push(e);
    return { ev, usage: s.usage() };
  };
  return { dir, wt, sb, store, keys, paths, make, run, ipc };
}

const bodies = (seen: Seen[]): string =>
  seen
    .filter((s) => !s.body.includes('title generator'))
    .map((s) => s.body)
    .join('\n');

describe.skipIf(!BIN || !bwrapOk)('the opencode adapter against the real opencode binary', () => {
  it('runs a builder through an OpenAI-compatible endpoint: the key is added by the proxy and never seen by the agent', async () => {
    resetHarnessProbe();
    const api = await fakeApi([{ text: 'unused' }]);
    const w = await setup('a', [
      {
        id: 'openai-compatible',
        key: 'sk-real-compat-key',
        org: true,
        baseUrl: `${api.url}/v1`,
        models: ['m1'],
      },
    ]);
    // fix the command's path after the world exists
    (api as unknown as { seen: Seen[] }).seen.length = 0;
    const api2 = await fakeApi([
      {
        call: {
          name: 'bash',
          args: {
            command: `echo HOME=$HOME; env | grep -c -E "sk-real" ; echo hi > built.txt && echo WROTE; aom report ok`,
            description: 'probe',
          },
        },
      },
      { text: 'all done' },
    ]);
    w.store.set({
      provider: 'openai-compatible',
      keyId: w.keys.publicKey.keyId,
      source: 'org',
      orgId: ORG,
      generation: 1,
      ciphertext: await sealOrg(w.keys, ORG, 'openai-compatible', 'sk-real-compat-key', 1, `${api2.url}/v1`),
      baseUrl: `${api2.url}/v1`,
      models: ['m1'],
    });
    const { ev, usage } = await w.run(w.make({}), 'openai-compatible/m1', BUILDER);
    expect(ev.at(-1)).toMatchObject({ kind: 'exit', code: 0 });
    expect(ev.some((e) => e.kind === 'session')).toBe(true);
    expect(ev.find((e) => e.kind === 'tool')).toMatchObject({ name: 'Bash' });
    if (process.env.AOM_DEBUG_BODIES)
      console.log(
        'TOOL',
        JSON.stringify(ev.filter((e) => e.kind === 'toolresult' || e.kind === 'tool')),
        JSON.stringify(
          [...bodies(api2.seen).matchAll(/"role":"tool","content":"[^"]*(?:\\.[^"]*)*"/g)].map((m) => m[0]),
        ).slice(0, 2000),
      );
    const calls = api2.seen.filter((s) => s.url.endsWith('/chat/completions'));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((c) => c.headers.authorization === 'Bearer sk-real-compat-key')).toBe(true);
    expect(calls[0]?.url).toBe('/v1/chat/completions');
    const b = bodies(api2.seen);
    expect(b).toContain('INSTRUCTIONS-MARKER');
    expect(b).toContain('AOM-RAN report ok');
    expect(b).toContain('WROTE');
    expect(b).not.toContain('OWNER-SECRET-CONTENT');
    expect(b).not.toContain('sk-real-compat-key');
    expect(existsSync(join(w.wt, 'built.txt'))).toBe(true);
    expect(usage).toMatchObject({
      model: 'opencode:openai-compatible/m1',
      keySource: 'org',
      keyProvider: 'openai-compatible',
    });
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.cacheReadTokens).toBeGreaterThan(0);
    w.ipc.close();
  }, 240_000);

  it('limits a role without a shell to aom, refuses the repository’s own opencode.json, and reads its AGENTS.md', async () => {
    resetHarnessProbe();
    const api = await fakeApi([
      { call: { name: 'bash', args: { command: 'ls /usr', description: 'x' } } },
      { call: { name: 'bash', args: { command: 'aom report fine', description: 'x' } } },
      { call: { name: 'bash', args: { command: 'aom report fine; ls /usr', description: 'x' } } },
      { call: { name: 'write', args: { filePath: 'sneaky.txt', content: 'x' } } },
      { text: 'done' },
    ]);
    const w = await setup('b', [
      { id: 'openai-compatible', key: 'k-b', baseUrl: `${api.url}/v1`, models: ['m1'] },
    ]);
    writeFileSync(
      join(w.wt, 'opencode.json'),
      JSON.stringify({ permission: { bash: 'allow', edit: 'allow' } }),
    );
    writeFileSync(join(w.wt, 'AGENTS.md'), '# Repo\nREPO-AGENTS-MARKER\n');
    const { ev } = await w.run(w.make({}), 'openai-compatible/m1', ANALYST, {
      roleKey: 'analyst',
      skills: true,
    });
    const b = bodies(api.seen);
    expect(b).toContain('REPO-AGENTS-MARKER');
    expect(b).toContain('demo-skill');
    expect(b).toContain('AOM-RAN report fine');
    if (process.env.AOM_DEBUG_BODIES)
      console.log(
        'EVS',
        JSON.stringify(ev.filter((e) => e.kind === 'toolresult' || e.kind === 'tool')),
        JSON.stringify(
          [...b.matchAll(/"role":"tool","content":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]?.slice(0, 200)),
        ),
      );
    const results = ev.filter((e) => e.kind === 'toolresult') as Array<{
      isError?: boolean;
      refused?: boolean;
    }>;
    // `ls /usr` refused, `aom report fine` ran, the compound command refused, the write refused
    // the write tool is not even offered to a role without edit: the model's call reads "unavailable tool"
    expect(results.map((r) => r.refused === true)).toEqual([true, false, true, false]);
    expect((ev.filter((e) => e.kind === 'tool') as Array<{ name: string }>).at(-1)?.name).toBe('invalid');
    expect(existsSync(join(w.wt, 'sneaky.txt'))).toBe(false);
    w.ipc.close();
  }, 240_000);

  it('sends each provider’s calls to its own API shape with the key in the right header', async () => {
    resetHarnessProbe();
    for (const [id, expectUrl, header] of [
      ['openai', /^\/v1\//, 'authorization'],
      ['anthropic', /^\/v1\/messages/, 'x-api-key'],
      ['google', /^\/v1beta\/models\//, 'x-goog-api-key'],
    ] as const) {
      const api = await fakeApi([{ text: 'hi' }]);
      const w = await setup(`p-${id}`, [{ id, key: `real-${id}-key`, org: true }]);
      const adapter = w.make({ routeUpstream: () => api.url });
      const model =
        id === 'openai'
          ? 'openai/gpt-5'
          : id === 'anthropic'
            ? 'anthropic/claude-sonnet-4-5'
            : 'google/gemini-2.5-pro';
      const agent = {
        agentId: 'a',
        name: 'Oc',
        roleKey: 'builder',
        seniority: 'senior',
        runtime: 'opencode',
        model,
        skills: [],
        permissions: BUILDER,
        isDevops: false,
      };
      const s = await adapter.startChat({
        chatId: 'c1',
        message: 'hello',
        cwd: w.wt,
        sandbox: w.sb,
        agent,
        env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: w.sb.home },
        readOnly: true,
      } as never);
      const done = (async () => {
        for await (const _ of s.events());
      })();
      // the shapes of the other providers' replies differ from the fake's: only the request matters, so stop at the first one
      for (let i = 0; i < 100 && !api.seen.some((x) => !x.body.includes('title generator')); i++)
        await new Promise((r) => setTimeout(r, 100));
      await s.stop('test');
      await done;
      const hit = api.seen.find((x) => !x.body.includes('title generator')) ?? api.seen[0];
      expect(hit, id).toBeDefined();
      expect(hit?.url, id).toMatch(expectUrl);
      expect(String(hit?.headers[header]), id).toContain(`real-${id}-key`);
      expect(JSON.stringify(hit?.headers), id).not.toContain('aom-key-is-added');
      w.ipc.close();
    }
  }, 300_000);

  it('lists the models of the providers held here and not the vendor’s hosted ones', async () => {
    resetHarnessProbe();
    const w = await setup('m', [
      { id: 'openai', key: 'k', org: true },
      { id: 'anthropic', key: 'k2' },
    ]);
    const adapter = w.make({});
    const caps = await adapter.capabilities();
    expect(caps).toMatchObject({ runtime: 'opencode', available: true, auth: 'ok', sandbox: 'enforced' });
    const ids = (caps.models ?? []).map((m) => m.id);
    expect(ids.some((i) => i.startsWith('openai/gpt-'))).toBe(true);
    expect(ids.some((i) => i.startsWith('anthropic/claude'))).toBe(true);
    expect(ids.some((i) => i.startsWith('opencode/'))).toBe(false);
    expect(ids.some((i) => i.startsWith('google/'))).toBe(false);
    w.ipc.close();
    void execa;
  }, 120_000);
});
