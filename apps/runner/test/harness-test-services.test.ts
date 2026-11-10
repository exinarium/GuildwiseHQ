import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../src/adapters/codex.ts';
import { GeminiAdapter } from '../src/adapters/gemini.ts';
import {
  type HarnessLaunch,
  harnessTestServices,
  launchInHarnessSandbox,
} from '../src/adapters/harness-session.ts';
import { OpencodeAdapter } from '../src/adapters/opencode.ts';
import { GeminiRuntimeConfigSchema, OpencodeRuntimeConfigSchema } from '../src/config.ts';
import { ProviderStore } from '../src/direct/store.ts';
import { runnerPaths } from '../src/paths.ts';
import { ensureSandbox } from '../src/sandbox/sandbox.ts';
import { RunnerKeys } from '../src/secrets/keys.ts';
import { cleanupTmp, tmp } from './helpers.ts';
import { sealWs } from './seal-helpers.ts';

cleanupTmp();

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

const A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const PERMS = {
  allowedTools: ['read', 'edit', 'shell'],
  deniedShellPatterns: [],
  writableGlobs: null,
  mayCommit: true,
  browser: false,
  riskTiers: ['small', 'large'],
  readOrgRepos: false,
  repoIds: null,
};
const SERVICES = ['127.0.0.1:5433', '[::1]:6379'];
const ENDPOINTS = ['192.168.1.12:11434'];

/** Stops the adapter right after it built its launch: no CLI and no sandbox is started in these tests. */
class Captured extends Error {}

function fakeBin(name: string): string {
  const dir = tmp(`aom-${name}-bin-`);
  const bin = join(dir, name);
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  chmodSync(bin, 0o755);
  return bin;
}

const capture = (launches: HarnessLaunch[]) => async (l: HarnessLaunch) => {
  launches.push(l);
  throw new Captured('captured');
};

async function startCaptured(start: () => Promise<unknown>): Promise<void> {
  await expect(start()).rejects.toBeInstanceOf(Captured);
}

function shiftInput(
  o: { cwd: string; sandbox: object; runtime: string; model: string; roleKey?: string; orgId?: string },
  testServiceDomains?: string[],
) {
  return {
    shiftId: 's1',
    ...(o.orgId ? { orgId: o.orgId } : {}),
    prompt: 'do the card',
    instructionsMarkdown: '',
    cwd: o.cwd,
    sandbox: o.sandbox,
    addDirs: [],
    env: { PATH: '/runner/bin:/usr/bin', AOM_SHIFT_TOKEN: 'tok', AOM_IPC_SOCKET: '/run/ipc.sock' },
    maxShiftMinutes: 5,
    agent: {
      agentId: A,
      name: 'Ag',
      roleKey: o.roleKey ?? 'builder',
      seniority: 'senior',
      runtime: o.runtime,
      model: o.model,
      skills: [],
      permissions: PERMS,
      isDevops: false,
    },
    ...(testServiceDomains ? { testServiceDomains } : {}),
  } as never;
}

async function storeWith(paths: ReturnType<typeof runnerPaths>, provider?: 'openai') {
  const keys = new RunnerKeys(join(paths.secrets, 'runner-key.pem'));
  const store = new ProviderStore({ file: join(paths.secrets, 'providers.json'), keys });
  store.setEndpoints(ENDPOINTS);
  if (provider)
    store.set({
      provider,
      keyId: keys.publicKey.keyId,
      ciphertext: await sealWs(keys, provider, 'sk-test-key'),
      models: [],
    });
  return store;
}

async function geminiRig() {
  const t = tmp();
  const paths = runnerPaths(join(t, 'data'));
  const sandbox = await ensureSandbox(paths, A, 'Gem');
  const cwd = join(t, 'wt');
  mkdirSync(cwd, { recursive: true });
  const ownerHome = join(t, 'owner');
  mkdirSync(join(ownerHome, '.gemini'), { recursive: true });
  writeFileSync(
    join(ownerHome, '.gemini', 'oauth_creds.json'),
    JSON.stringify({ access_token: 'ya29.a', refresh_token: 'r', expiry_date: 1_900_000_000_000 }),
  );
  const launches: HarnessLaunch[] = [];
  const adapter = new GeminiAdapter(
    GeminiRuntimeConfigSchema.parse({ bin: fakeBin('gemini'), authMode: 'auto' }) as never,
    paths,
    await storeWith(paths),
    {
      home: ownerHome,
      parent: { PATH: process.env.PATH ?? '' },
      warn: () => undefined,
      sandboxProbe: () => ({ ok: true, reason: 'test' }),
      launch: capture(launches),
    },
  );
  const start = (domains?: string[], roleKey?: string) =>
    startCaptured(() =>
      adapter.start(
        shiftInput(
          { cwd, sandbox, runtime: 'gemini', model: 'gemini-2.5-pro', ...(roleKey ? { roleKey } : {}) },
          domains,
        ),
      ),
    );
  return { adapter, launches, start };
}

async function opencodeRig() {
  const t = tmp();
  const paths = runnerPaths(join(t, 'data'));
  const sandbox = await ensureSandbox(paths, A, 'Oc');
  const cwd = join(t, 'wt');
  mkdirSync(cwd, { recursive: true });
  const launches: HarnessLaunch[] = [];
  const adapter = new OpencodeAdapter(
    OpencodeRuntimeConfigSchema.parse({ bin: fakeBin('opencode') }) as never,
    paths,
    await storeWith(paths, 'openai'),
    {
      sandboxProbe: () => ({ ok: true, reason: 'test' }),
      listModels: async (ps) => ps.flatMap((p) => [`${p.id}/model-a`]),
      launch: capture(launches),
    },
  );
  const start = (domains?: string[], roleKey?: string) =>
    startCaptured(() =>
      adapter.start(
        shiftInput(
          {
            cwd,
            sandbox,
            runtime: 'opencode',
            model: 'openai/model-a',
            orgId: '11111111-1111-4111-8111-111111111111',
            ...(roleKey ? { roleKey } : {}),
          },
          domains,
        ),
      ),
    );
  return { adapter, launches, start };
}

async function codexRig(sandboxMode: 'harness' | 'native' = 'harness') {
  const root = tmp('aom-codex-root-');
  const home = tmp('aom-codex-home-');
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(
    join(home, '.codex', 'auth.json'),
    JSON.stringify({ tokens: { access_token: 'user-token' }, last_refresh: '2026-01-01T00:00:00Z' }),
  );
  const agentDir = join(root, 'agents', 'ag1');
  const sandbox = {
    home: join(agentDir, 'home'),
    configDir: join(agentDir, 'claude'),
    scratch: join(agentDir, 'scratch'),
    tmp: join(agentDir, 'tmp'),
  };
  for (const d of Object.values(sandbox)) mkdirSync(d, { recursive: true });
  const cwd = join(root, 'wt');
  mkdirSync(cwd, { recursive: true });
  const launches: HarnessLaunch[] = [];
  const adapter = new CodexAdapter(
    {
      enabled: true,
      bin: fakeBin('codex'),
      authMode: 'login',
      toolchainPaths: [],
      sandbox: sandboxMode,
    },
    runnerPaths(root),
    {
      store: await storeWith(runnerPaths(root)),
      home,
      parent: { PATH: '/usr/bin:/bin' },
      platform: 'linux',
      harnessProbe: () => ({ ok: true, reason: 'runner-managed bubblewrap with an egress proxy' }),
      launch: capture(launches),
    },
  );
  const start = (domains?: string[], roleKey?: string) =>
    startCaptured(() =>
      adapter.start(
        shiftInput(
          { cwd, sandbox, runtime: 'codex', model: 'gpt-6-sol', ...(roleKey ? { roleKey } : {}) },
          domains,
        ),
      ),
    );
  return { adapter, launches, start };
}

describe('harnessTestServices', () => {
  it('gives the list to a builder, reviewer or tester card shift', () => {
    for (const role of ['builder', 'reviewer', 'tester'])
      expect(harnessTestServices({ testServiceDomains: SERVICES }, role, false), role).toEqual(SERVICES);
  });

  it('gives nothing to a chat, another role, an empty list or an input without the field', () => {
    expect(harnessTestServices({ testServiceDomains: SERVICES }, 'builder', true)).toBeUndefined();
    for (const role of ['ceo', 'devops', 'planner', 'architect'])
      expect(harnessTestServices({ testServiceDomains: SERVICES }, role, false), role).toBeUndefined();
    expect(harnessTestServices({ testServiceDomains: [] }, 'builder', false)).toBeUndefined();
    expect(harnessTestServices({}, 'builder', false)).toBeUndefined();
  });
});

describe('launchInHarnessSandbox hands the test services to the egress proxy', () => {
  it('a CONNECT through the session proxy reaches the declared entry, and no other port', async () => {
    const svc = createServer((_req, res) => res.end('svc'));
    servers.push(svc);
    const port = await new Promise<number>((r) =>
      svc.listen(0, '127.0.0.1', () => r((svc.address() as { port: number }).port)),
    );
    const t = tmp();
    const launched = await launchInHarnessSandbox({
      cliHosts: [],
      sandbox: {
        cwd: t,
        readOnlyCwd: true,
        home: t,
        scratch: t,
        tmp: t,
        writable: [],
        readonly: [],
        readDirs: [],
        gitDirs: [],
        mayCommit: false,
      },
      cmd: { bin: '/bin/true', args: [], env: {} },
      privateEndpoints: ENDPOINTS,
      testServices: [`127.0.0.1:${port}`],
    });
    // the proxy socket is the one wrapped into the box (the bridge on 127.0.0.1:3128 forwards to it)
    const socketPath = launched.command.args
      .map((a) => /UNIX-CONNECT:'([^']*p\.sock)'/.exec(a)?.[1])
      .find(Boolean) as string;
    const status = (target: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request({ socketPath, path: target, method: 'CONNECT', headers: { host: target } });
        req.on('connect', (res, s) => {
          s.destroy();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
    try {
      expect(socketPath).toBeTruthy();
      expect(await status(`127.0.0.1:${port}`)).toBe(200);
      expect(await status(`127.0.0.1:${port + 1}`)).toBe(403);
      expect(launched.proxy.denied()).toEqual(['127.0.0.1']);
    } finally {
      await launched.cleanup();
    }
  });
});

describe('the harness adapters pass the shift test services to their launch', () => {
  const rigs = {
    gemini: geminiRig,
    opencode: opencodeRig,
    codex: () => codexRig('harness'),
  };

  for (const [name, mk] of Object.entries(rigs)) {
    it(`${name}: the launch gets testServiceDomains as testServices, apart from privateEndpoints`, async () => {
      const r = await mk();
      expect(r.adapter.usesEgressProxy()).toBe(true);
      await r.start(SERVICES);
      const l = r.launches[0] as HarnessLaunch;
      expect(l.testServices).toEqual(SERVICES);
      expect(l.privateEndpoints).toEqual(ENDPOINTS);
      for (const s of SERVICES) expect(l.privateEndpoints).not.toContain(s);
    });

    it(`${name}: no declared services, or a role without them, gives the launch no testServices`, async () => {
      const r = await mk();
      await r.start();
      await r.start([]);
      await r.start(SERVICES, 'planner');
      for (const l of r.launches) expect(l.testServices).toBeUndefined();
    });
  }

  it('codex with its native sandbox does not use the egress proxy', async () => {
    expect((await codexRig('native')).adapter.usesEgressProxy()).toBe(false);
    expect((await codexRig('harness')).adapter.usesEgressProxy()).toBe(true);
  });
});
