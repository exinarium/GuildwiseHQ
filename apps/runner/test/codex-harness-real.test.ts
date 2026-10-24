import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
import { CodexAdapter } from '../src/adapters/codex.ts';
import { probeHarnessSandbox } from '../src/adapters/harness-session.ts';
import type { RuntimeEvent } from '../src/adapters/types.ts';
import { ProviderStore } from '../src/direct/store.ts';
import { runnerPaths } from '../src/paths.ts';
import { ensureSandbox } from '../src/sandbox/sandbox.ts';
import { RunnerKeys } from '../src/secrets/keys.ts';
import { codexRolloutFile, readCodexRollout } from '../src/sessions/codex-rollout.ts';
import { sealOrg } from './seal-helpers.ts';

/**
 * Opt-in: runs the REAL codex binary (AOM_CODEX_REAL_BIN=/path/to/codex, codex-cli 0.164.0) through the adapter, inside the
 * runner's real bubblewrap sandbox and egress proxy (the harness sandbox, R3c), against a fake Responses API on localhost. It
 * spends no tokens and needs no login. It checks what a fake binary cannot: that Codex honours the flags, the proxy and the base
 * URL, and that the guarantees of docs/RUNNER.md hold with Codex's own tools.
 */
const BIN = process.env.AOM_CODEX_REAL_BIN;
const ORG = '11111111-1111-4111-8111-111111111111';
const root = realpathSync(mkdtempSync(join(userInfo().homedir, '.aom-codex-harness-')));
const servers: Server[] = [];
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const s of servers) s.close();
});

const AGENT = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const bwrapOk = probeHarnessSandbox().ok;

interface Seen {
  url: string;
  auth: string | undefined;
  body: string;
}

function fakeApi(script: string) {
  const seen: Seen[] = [];
  let calls = 0;
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
    });
    req.on('end', () => {
      if (req.method !== 'POST') {
        res.writeHead(404).end();
        return;
      }
      calls++;
      seen.push({ url: req.url ?? '', auth: req.headers.authorization, body: b });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (t: string, d: object) =>
        res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
      ev('response.created', { response: { id: `resp_${calls}` } });
      if (calls === 1)
        ev('response.output_item.done', {
          item: { type: 'custom_tool_call', call_id: 'call_1', name: 'exec', input: script },
        });
      else
        ev('response.output_item.done', {
          item: {
            type: 'message',
            role: 'assistant',
            id: 'm1',
            content: [{ type: 'output_text', text: 'done' }],
          },
        });
      ev('response.completed', {
        response: {
          id: `resp_${calls}`,
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 40 },
            output_tokens: 10,
            output_tokens_details: { reasoning_tokens: 2 },
            total_tokens: 110,
          },
        },
      });
      res.end();
    });
  });
  servers.push(server);
  return new Promise<{ url: string; port: number; seen: Seen[] }>((r) =>
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      r({ url: `http://fake.test:${port}`, port, seen });
    }),
  );
}

const PERMS = {
  allowedTools: ['read', 'edit', 'shell'],
  deniedShellPatterns: ['git push*'],
  writableGlobs: null,
  mayCommit: true,
  browser: false,
  riskTiers: ['small'],
  readOrgRepos: false,
  repoIds: null,
};

async function setup(name: string, mode: 'key' | 'login', script: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const paths = runnerPaths(join(dir, 'data'));
  const A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
  const sb = await ensureSandbox(paths, A, 'Cod');
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (cwd: string, ...a: string[]) =>
    spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'hi');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const wt = join(dir, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'card', wt);
  const api = await fakeApi(script);
  const keys = new RunnerKeys(join(paths.secrets, 'runner-key.pem'));
  const store = new ProviderStore({ file: join(paths.secrets, 'providers.json'), keys });
  if (mode === 'key')
    await store.set({
      provider: 'openai',
      keyId: keys.publicKey.keyId,
      source: 'org',
      orgId: ORG,
      generation: 1,
      ciphertext: await sealOrg(keys, ORG, 'openai', 'sk-ORG-KEY-never-in-sandbox'),
      models: [],
    });
  const loginDir = join(dir, 'owner-codex');
  mkdirSync(loginDir, { recursive: true });
  if (mode === 'login')
    writeFileSync(
      join(loginDir, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'sk-OWNER-LOGIN-hidden', last_refresh: '2026-01-01T00:00:00Z' }),
    );
  const adapter = new CodexAdapter(
    {
      enabled: true,
      bin: BIN as string,
      authMode: mode === 'key' ? 'api_key' : 'login',
      loginDir,
      toolchainPaths: [],
    },
    paths,
    {
      home: join(dir, 'owner-home'),
      parent: { PATH: process.env.PATH ?? '' },
      store,
      upstream: { url: api.url },
      // login mode: the fake API stands where Codex would call the OpenAI backend
      ...(mode === 'login' ? { extraArgs: ['-c', `openai_base_url="${api.url}/v1"`] } : {}),
    },
  );
  const secret = join(dir, 'owner-secret.txt');
  writeFileSync(secret, 'OWNER-SECRET-CONTENT');
  mkdirSync(paths.bin, { recursive: true });
  writeFileSync(join(paths.bin, 'aom'), `#!/bin/sh\necho "AOM-RAN $*"\n`);
  chmodSync(join(paths.bin, 'aom'), 0o755);
  mkdirSync(join(dir, 'ipc'), { recursive: true });
  const sock = join(dir, 'ipc', 'ipc.sock');
  const ipc = createNetServer((c) => c.end('pong')).listen(sock);
  servers.push(ipc as unknown as Server);
  const nodeBin = dirname(process.execPath);
  const run = async (perms: object = PERMS, resume?: string) => {
    await adapter.writeInstructions(sb, '# Instructions\nBe brief. INSTRUCTIONS-MARKER\n');
    const s = await adapter.start({
      shiftId: 's1',
      prompt: 'do the work',
      instructionsMarkdown: '',
      cwd: wt,
      sandbox: sb,
      orgId: ORG,
      agent: {
        agentId: A,
        name: 'Cod',
        roleKey: 'builder',
        seniority: 'senior',
        runtime: 'codex',
        model: 'gpt-6-sol',
        skills: [],
        permissions: perms,
        isDevops: false,
      },
      env: {
        PATH: `${paths.bin}:${nodeBin}:/usr/bin:/bin`,
        HOME: sb.home,
        AOM_SHIFT_TOKEN: 'shift-token-xyz',
        AOM_IPC_SOCKET: sock,
      },
      addDirs: [],
      maxShiftMinutes: 3,
      logFile: join(dir, 'shift.jsonl'),
      ...(resume ? { resumeSessionId: resume } : {}),
      grantedSkills: [
        {
          name: 'demo-skill',
          files: { 'SKILL.md': '---\nname: demo-skill\ndescription: say hello\n---\nHello.\n' },
        },
      ],
    } as never);
    const ev: RuntimeEvent[] = [];
    for await (const e of s.events()) ev.push(e);
    const raw = readFileSync(join(dir, 'shift.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; item?: { type: string; aggregated_output?: string } });
    const outputs = raw
      .filter((e) => e.type === 'item.completed' && e.item?.type === 'command_execution')
      .map((e) => e.item?.aggregated_output ?? '');
    return { ev, outputs, usage: s.usage(), wt, dir, secret, api, git, sock };
  };
  return { run, api, wt, dir, secret, git, sb, paths };
}

const field = (probe: string, name: string): string =>
  new RegExp(`^${name}=(.*)$`, 'm').exec(probe)?.[1] ?? '';

const script = (secret: string, authJson: string): string => {
  const lines = [
    'echo "ENV=$(env | sort | tr "\\n" " ")"',
    `echo "SECRET=$(cat ${secret} >/dev/null 2>&1 && echo readable || echo hidden)"`,
    `echo "AUTHJSON=$(cat ${authJson} >/dev/null 2>&1 && echo readable || echo hidden)"`,
    'echo "WRITE_WT=$(echo x > ./made 2>&1 && echo ok)"',
    `echo "WRITE_OUT=$(echo x > ${secret}.made 2>&1 && echo ok)"`,
    'echo "NET=$(curl -s -m 5 -o /dev/null -w %{http_code} https://example.com 2>&1 | head -c 20)"',
    'echo "DIRECT=$(curl -s -m 3 --noproxy "*" -o /dev/null https://example.com && echo yes || echo no)"',
    'echo "AOM=$(aom report)"',
    'echo "SOCK=$(node -e "require(\'net\').connect(process.env.AOM_IPC_SOCKET).on(\'data\',d=>console.log(String(d)))" 2>&1 | grep -o pong)"',
    'echo "SKILLS=$(ls $HOME/.agents/skills 2>&1 | head -c 60)"',
    'echo "COMMIT=$(git add made && git -c user.name=t -c user.email=t@t commit -qm card >/dev/null 2>&1 && echo ok)"',
    'echo "PUSH=$(git push 2>&1 | head -c 60)"',
    'echo "SHELLPATH=$(readlink /proc/$PPID/exe 2>/dev/null; echo $0)"',
    'echo "END"',
  ];
  return [
    `const r = await tools.exec_command({cmd: ${JSON.stringify(lines.join('\n'))}, login: false});`,
    "text(typeof r === 'string' ? r : JSON.stringify(r));",
  ].join('\n');
};

describe.skipIf(!BIN || !bwrapOk)('codex in the runner harness sandbox, real binary', () => {
  it('api key mode: the key is added by the proxy and never in the box; the shell is confined; usage names the key', async () => {
    const dir0 = join(root, 'k1');
    const s = await setup(
      'k1',
      'key',
      script(join(dir0, 'owner-secret.txt'), join(dir0, 'data', 'agents', AGENT, 'codex', 'auth.json')),
    );
    const r = await s.run();
    const probe = r.outputs[0] ?? '';
    expect(r.ev.at(-1)).toMatchObject({ kind: 'exit', code: 0 });
    // the model call reached the fake API through the proxy route, with the key added upstream
    const call = r.api.seen[0];
    expect(call?.url).toBe('/v1/responses');
    expect(call?.auth).toBe('Bearer sk-ORG-KEY-never-in-sandbox');
    // nothing of the key (or the runner's secrets) exists in the box or the shell
    expect(probe).not.toMatch(/sk-ORG|OWNER-SECRET|aom-key-is-added|CODEX_API_KEY|CODEX_HOME/);
    expect(field(probe, 'ENV')).toContain('AOM_SHIFT_TOKEN=shift-token-xyz');
    expect(field(probe, 'SECRET')).toBe('hidden');
    expect(field(probe, 'WRITE_WT')).toBe('ok');
    // a write beside the owner's file lands in the box's own throw-away filesystem, never on the host
    expect(existsSync(`${s.secret}.made`)).toBe(false);
    // the network: only through the proxy and its allow-list (example.com is not on it); no way around it
    expect(field(probe, 'NET')).not.toMatch(/^2\d\d$/);
    expect(field(probe, 'DIRECT')).toBe('no');
    // aom through the box's socket, no execpolicy exception needed
    expect(field(probe, 'AOM')).toContain('AOM-RAN');
    expect(field(probe, 'SOCK')).toContain('pong');
    expect(field(probe, 'SKILLS')).toBe('demo-skill');
    expect(field(probe, 'COMMIT')).toBe('ok');
    expect(r.git(s.wt, 'log', '--format=%s', '-1').stdout.trim()).toBe('card');
    expect(field(probe, 'PUSH')).not.toMatch(/^$/);
    expect(r.api.seen.map((x) => x.body).join('\n')).toContain('INSTRUCTIONS-MARKER');
    expect(r.ev.find((e) => e.kind === 'usage')).toMatchObject({
      usage: {
        // two calls of the fake API (the command, then the answer), 100 input tokens of which 40 cached, 10 output each
        inputTokens: 120,
        cacheReadTokens: 80,
        outputTokens: 20,
        model: 'codex:gpt-6-sol',
        keySource: 'org',
        keyProvider: 'openai',
      },
    });
    expect(r.ev.find((e) => e.kind === 'final')).toMatchObject({ text: 'done' });
  }, 180_000);

  it('login mode: the login file is in the CLI home but hidden from the shell; the key in it never leaves', async () => {
    const dir0 = join(root, 'l1');
    const s = await setup(
      'l1',
      'login',
      script(join(dir0, 'owner-secret.txt'), join(dir0, 'data', 'agents', AGENT, 'codex', 'auth.json')),
    );
    const r = await s.run();
    const probe = r.outputs[0] ?? '';
    expect(r.ev.at(-1)).toMatchObject({ kind: 'exit', code: 0 });
    expect(probe).not.toMatch(/sk-OWNER-LOGIN/);
    expect(field(probe, 'ENV')).not.toMatch(/CODEX_HOME|CODEX_API_KEY|OPENAI_API_KEY/);
    // the login file is where the CLI needs it, and the shell could not read it
    expect(field(probe, 'AUTHJSON')).toBe('hidden');
    expect(r.ev.find((e) => e.kind === 'usage')).toMatchObject({ usage: { model: 'codex:gpt-6-sol' } });
    expect(r.ev.find((e) => e.kind === 'usage')?.kind).toBe('usage');
    // no stored key paid: nothing to attribute to a provider cap
    expect(JSON.stringify(r.ev.find((e) => e.kind === 'usage'))).not.toContain('keySource');
  }, 180_000);

  it('resumes a thread by its id on a later shift, and the runner’s reader finds the rollout and its size', async () => {
    const dir0 = join(root, 'r1');
    const s = await setup('r1', 'key', script(join(dir0, 'owner-secret.txt'), join(dir0, 'none')));
    const first = await s.run();
    const sid = (first.ev.find((e) => e.kind === 'session') as { runtimeSessionId: string }).runtimeSessionId;
    const home = join(dir0, 'data', 'agents', AGENT, 'codex');
    const file = codexRolloutFile(home, sid);
    expect(file).toBeTruthy();
    expect(readCodexRollout(file as string)).toMatchObject({ id: sid, contextTokens: 100, calls: 2 });
    const second = await s.run(PERMS, sid);
    expect(second.ev.at(-1)).toMatchObject({ kind: 'exit', code: 0 });
    expect(
      (second.ev.find((e) => e.kind === 'session') as { runtimeSessionId: string }).runtimeSessionId,
    ).toBe(sid);
    // the earlier turn's shell output travelled with the resumed history
    expect(s.api.seen.at(-1)?.body).toContain('AOM-RAN');
    expect(readCodexRollout(codexRolloutFile(home, sid) as string)?.calls).toBe(3);
  }, 180_000);
});
