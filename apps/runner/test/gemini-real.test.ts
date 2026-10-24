import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { sealLarge } from '@aom/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { GeminiAdapter } from '../src/adapters/gemini.ts';
import { probeHarnessSandbox, resetHarnessProbe } from '../src/adapters/harness-session.ts';
import type { RuntimeEvent } from '../src/adapters/types.ts';
import { GeminiRuntimeConfigSchema } from '../src/config.ts';
import { ProviderStore } from '../src/direct/store.ts';
import { runnerPaths } from '../src/paths.ts';
import { ensureSandbox } from '../src/sandbox/sandbox.ts';
import { RunnerKeys } from '../src/secrets/keys.ts';
import { sealOrg, sealWs } from './seal-helpers.ts';

/**
 * Opt-in: runs the REAL gemini binary (AOM_GEMINI_REAL_BIN=/path/to/gemini, @google/gemini-cli 0.65.0) through the adapter,
 * inside the runner's real bubblewrap sandbox, against a fake Gemini API on localhost. It spends no tokens and needs no login.
 * It checks what the unit tests with a fake binary cannot: that the CLI really honours the flags, the policy file, the proxy and
 * the base URL, and that the sandbox keeps the guarantees of docs/RUNNER.md with the CLI's own tools.
 */
const ORG = '11111111-1111-4111-8111-111111111111';
const BIN = process.env.AOM_GEMINI_REAL_BIN;
const root = realpathSync(mkdtempSync(join(userInfo().homedir, '.aom-gemini-real-')));
const servers: Server[] = [];
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const s of servers) s.close();
});

type Step = { call: { name: string; args: Record<string, unknown> } } | { text: string };

function fakeGemini(script: Step[]) {
  const seen: Array<{ url: string; key: string | undefined; body: string }> = [];
  let n = 0;
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
    });
    req.on('end', () => {
      seen.push({ url: req.url ?? '', key: req.headers['x-goog-api-key'] as string | undefined, body: b });
      const stream = (req.url ?? '').includes('streamGenerateContent');
      const usage = {
        promptTokenCount: 200,
        candidatesTokenCount: 11,
        totalTokenCount: 211,
        cachedContentTokenCount: 50,
      };
      if (!stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: '{}' }] }, finishReason: 'STOP' }],
            usageMetadata: usage,
          }),
        );
        return;
      }
      const step = script[n++] ?? { text: 'finished' };
      const part = 'call' in step ? { functionCall: step.call } : { text: step.text };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP', index: 0 }], usageMetadata: usage, modelVersion: 'gemini-2.5-pro' })}\r\n\r\n`,
      );
      res.end();
    });
  });
  servers.push(server);
  return new Promise<{ url: string; seen: typeof seen }>((r) =>
    server.listen(0, '127.0.0.1', () =>
      r({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen }),
    ),
  );
}

const bwrapOk = probeHarnessSandbox().ok;

const READER = {
  allowedTools: ['read', 'shell'],
  deniedShellPatterns: [],
  writableGlobs: null,
  mayCommit: false,
  browser: false,
  riskTiers: ['small', 'large'],
  readOrgRepos: false,
  repoIds: null,
};
const BUILDER = { ...READER, allowedTools: ['read', 'edit', 'shell'], mayCommit: true };
const ANALYST = { ...READER, allowedTools: ['read'] };

async function setup(
  name: string,
  script: Step[],
  opts: { orgKey?: boolean; ownKey?: boolean; login?: boolean } = {},
) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const paths = runnerPaths(join(dir, 'data'));
  const A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
  const sb = await ensureSandbox(paths, A, 'Gem');
  const wt = join(dir, 'wt');
  mkdirSync(wt, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main', wt]);
  const api = await fakeGemini(script);
  const keys = new RunnerKeys(join(paths.secrets, 'runner-key.pem'));
  const store = new ProviderStore({ file: join(paths.secrets, 'providers.json'), keys });
  const put = async (source: 'org' | undefined, key: string) =>
    store.set({
      provider: 'google',
      keyId: keys.publicKey.keyId,
      ...(source ? { source, orgId: ORG, generation: 1 } : {}),
      ciphertext: source ? await sealOrg(keys, ORG, 'google', key) : await sealWs(keys, 'google', key),
      models: [],
    });
  if (opts.orgKey) await put('org', 'AIza-ORG-KEY-never-in-sandbox');
  if (opts.ownKey) await put(undefined, 'AIza-OWN-KEY-never-in-sandbox');
  const ownerHome = join(dir, 'owner-home');
  mkdirSync(join(ownerHome, '.gemini'), { recursive: true });
  const bin = BIN as string;
  const adapter = new GeminiAdapter(
    GeminiRuntimeConfigSchema.parse({ bin, authMode: opts.login ? 'login' : 'api_key' }) as never,
    paths,
    store,
    { home: ownerHome, parent: { PATH: process.env.PATH ?? '' }, upstream: { url: api.url } },
  );
  const outside = join(dir, 'owner-secret.txt');
  writeFileSync(outside, 'OWNER-SECRET-CONTENT');
  const aomBin = join(paths.bin);
  mkdirSync(aomBin, { recursive: true });
  writeFileSync(join(aomBin, 'aom'), `#!/bin/sh\necho "AOM-RAN $*"\n`);
  chmodSync(join(aomBin, 'aom'), 0o755);
  mkdirSync(join(dir, 'ipc'), { recursive: true });
  const sock = join(dir, 'ipc', 'ipc.sock');
  const ipc = createNetServer((c) => c.end('pong')).listen(sock);
  const nodeBin = dirname(process.execPath);
  const run = async (perms: object, roleKey = 'builder', chat = false) => {
    await adapter.writeInstructions(sb, '# Instructions\nBe brief. INSTRUCTIONS-MARKER\n');
    const agent = {
      agentId: A,
      name: 'Gem',
      roleKey,
      seniority: 'senior',
      runtime: 'gemini',
      model: 'gemini-2.5-pro',
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
    const s = chat
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
          grantedSkills: [
            {
              name: 'demo-skill',
              files: {
                'SKILL.md':
                  '---\nname: demo-skill\ndescription: A demo skill that says hello.\n---\nSay hello.\n',
              },
            },
          ],
        } as never);
    const ev: RuntimeEvent[] = [];
    for await (const e of s.events()) ev.push(e);
    return { ev, usage: s.usage() };
  };
  return { dir, wt, sb, api, adapter, store, keys, outside, run, ipc, ownerHome, paths };
}

const toolOut = (ev: RuntimeEvent[]) => ev.filter((e) => e.kind === 'toolresult');

describe.skipIf(!BIN || !bwrapOk)('the Gemini CLI adapter against the real gemini binary', () => {
  it('runs a builder in the sandbox with the key injected by the proxy, and parses the real events', async () => {
    resetHarnessProbe();
    const probe = `echo HOME=$HOME; env | grep -c -E 'AIza|GEMINI_API_KEY' | sed 's/^/KEYENV=/'; cat ${'${OUTSIDE}'} 2>&1 | head -1; ls /home 2>&1 | head -2; echo hi > built.txt && echo WROTE; curl -sS -m 3 --noproxy '*' http://127.0.0.1:1/ 2>&1 | head -1; aom report ok`;
    const w = await setup('a', [], { orgKey: true });
    const cmd = probe.replace('${OUTSIDE}', w.outside);
    w.api.seen.length = 0;
    // script is read at request time: rebuild the API with the right command
    const api = await fakeGemini([
      { call: { name: 'run_shell_command', args: { command: cmd, description: 'probe' } } },
      { call: { name: 'run_shell_command', args: { command: 'git push origin main', description: 'push' } } },
      { text: 'all done' },
    ]);
    (w.adapter as unknown as { host: { upstream: { url: string } } }).host.upstream.url = api.url;
    const { ev, usage } = await w.run(BUILDER);
    const kinds = ev.map((e) => e.kind);
    expect(kinds).toContain('session');
    expect(ev.find((e) => e.kind === 'tool')).toMatchObject({ kind: 'tool', name: 'Bash' });
    expect(ev.at(-1)).toMatchObject({ kind: 'exit', code: 0 });
    // the key reached the (fake) Google API through the proxy, and only there
    const streamCalls = api.seen.filter((s) => s.url.includes('streamGenerateContent'));
    expect(streamCalls.length).toBeGreaterThanOrEqual(2);
    expect(streamCalls.every((s) => s.key === 'AIza-ORG-KEY-never-in-sandbox')).toBe(true);
    expect(streamCalls[0]?.url).toContain('/v1beta/models/gemini-2.5-pro:streamGenerateContent');
    // instructions, skill and granted material reached the model's context
    expect(streamCalls[0]?.body).toContain('INSTRUCTIONS-MARKER');
    expect(streamCalls[0]?.body).toContain('demo-skill');
    // usage: non-cached input, cache read, output; attributed to the org key
    expect(usage).toMatchObject({
      inputTokens: expect.any(Number),
      model: 'gemini:gemini-2.5-pro',
      keySource: 'org',
      keyProvider: 'google',
    });
    expect(usage.outputTokens).toBeGreaterThan(0);
    expect(usage.cacheReadTokens).toBeGreaterThan(0);
    // what the agent's shell saw
    const toolRes = toolOut(ev);
    expect(toolRes.length).toBeGreaterThan(0);
    const outputs = streamCalls.map((s) => s.body).join('\n');
    if (process.env.AOM_DEBUG_BODIES)
      console.log(
        'FR',
        JSON.stringify([...outputs.matchAll(/"functionResponse":\{[\s\S]*?\}\}\}/g)].map((m) => m[0])).slice(
          0,
          3000,
        ),
      );
    expect(outputs).not.toContain('OWNER-SECRET-CONTENT');
    expect(outputs).not.toContain('AIza-ORG-KEY');
    expect(outputs).toContain('KEYENV=0');
    expect(outputs).toContain('AOM-RAN report ok');
    expect(outputs).toContain('WROTE');
    expect(existsSync(join(w.wt, 'built.txt'))).toBe(true);
    expect(outputs).toMatch(/No such file|cannot access/);
    // `git push` is refused by the policy before it runs
    expect(outputs).toMatch(/not allowed for this agent|denied/i);
    w.ipc.close();
  }, 180_000);

  it('limits a role without a shell to the aom command, and a role without edit to reading', async () => {
    resetHarnessProbe();
    const w = await setup('b', []);
    const api = await fakeGemini([
      { call: { name: 'run_shell_command', args: { command: 'ls /usr', description: 'x' } } },
      { call: { name: 'run_shell_command', args: { command: 'aom report fine', description: 'x' } } },
      { call: { name: 'write_file', args: { file_path: join(w.wt, 'sneaky.txt'), content: 'x' } } },
      { text: 'done' },
    ]);
    (w.adapter as unknown as { host: { upstream: { url: string } } }).host.upstream.url = api.url;
    await w.store.set({
      provider: 'google',
      keyId: w.keys.publicKey.keyId,
      ciphertext: await sealLarge(w.keys.publicKey.publicKey, 'AIza-K'),
      models: [],
    });
    const { ev } = await w.run(ANALYST, 'analyst');
    const bodies = api.seen
      .filter((s) => s.url.includes('streamGenerateContent'))
      .map((s) => s.body)
      .join('\n');
    expect(bodies).toContain('AOM-RAN report fine');
    expect(bodies).toMatch(/only the aom command|denied|not allowed/i);
    expect(existsSync(join(w.wt, 'sneaky.txt'))).toBe(false);
    expect(ev.at(-1)).toMatchObject({ kind: 'exit', code: 0 });
    w.ipc.close();
  }, 180_000);

  it('streams a chat reply as deltas and resumes by session id', async () => {
    resetHarnessProbe();
    const w = await setup('c', [{ text: 'Hello from the model.' }], { ownKey: true });
    const { ev, usage } = await w.run(READER, 'reviewer', true);
    expect(ev.some((e) => e.kind === 'textstart')).toBe(true);
    expect(
      ev
        .filter((e) => e.kind === 'delta')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toContain('Hello from the model.');
    expect(usage).toMatchObject({ keySource: 'workstation', keyProvider: 'google' });
    const sid = ev.find((e) => e.kind === 'session') as { runtimeSessionId: string };
    expect(sid.runtimeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    w.ipc.close();
  }, 180_000);

  it('uses the owner’s Google login from a private copy and goes out through the proxy only', async () => {
    resetHarnessProbe();
    const w = await setup('d', []);
    // a login in the owner's folder, in the plain form older versions kept it
    const owner = join(w.ownerHome, '.gemini', 'oauth_creds.json');
    const future = Date.now() + 3_600_000;
    writeFileSync(
      owner,
      JSON.stringify({
        access_token: 'ya29.fake-access',
        refresh_token: '1//fake-refresh',
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        token_type: 'Bearer',
        expiry_date: future,
      }),
    );
    const adapter = new GeminiAdapter(
      GeminiRuntimeConfigSchema.parse({ bin: BIN, authMode: 'login' }) as never,
      w.paths,
      w.store,
      { home: w.ownerHome, parent: { PATH: process.env.PATH ?? '' } },
    );
    expect(adapter.authSelection().via).toBe('login');
    const agentDir = dirname(w.sb.configDir);
    const ghome = join(agentDir, 'gemini');
    // the session itself cannot reach Google here (no real login): it must fail cleanly, with the login only in the private home
    const agent = {
      agentId: 'a',
      name: 'Gem',
      roleKey: 'builder',
      seniority: 'senior',
      runtime: 'gemini',
      model: 'gemini-2.5-pro',
      skills: [],
      permissions: BUILDER,
      isDevops: false,
    };
    const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
    const s = await adapter.start({
      shiftId: 's1',
      prompt: 'x',
      instructionsMarkdown: '',
      cwd: w.wt,
      sandbox: w.sb,
      agent,
      env,
      addDirs: [],
      maxShiftMinutes: 1,
    } as never);
    const ev: RuntimeEvent[] = [];
    for await (const e of s.events()) ev.push(e);
    expect(ev.at(-1)?.kind).toBe('exit');
    const files = readdirSync(join(ghome, '.gemini'));
    expect(files.some((f) => f === 'oauth_creds.json' || f === 'gemini-credentials.json')).toBe(true);
    // the owner's file is untouched when nothing refreshed
    expect(JSON.parse(readFileSync(owner, 'utf8')).access_token).toBe('ya29.fake-access');
    w.ipc.close();
  }, 240_000);
});
