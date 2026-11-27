import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyCommand, defaultGuardConfig } from '../src/devops/guard.ts';
import { policyRecordSharedDocker, registerPolicyCommands } from '../src/policy/cli.ts';
import { HeldStore } from '../src/policy/held.ts';
import { POLICY_KEY_FILE, sealMarkerFor } from '../src/policy/integrity.ts';
import { PasskeyStore } from '../src/policy/passkey-store.ts';
import { DEFAULT_POLICY } from '../src/policy/schema.ts';
import { recordSharedDocker, type SharedDockerDeps, sharedDockerProbe } from '../src/policy/shared-docker.ts';
import type { DockerSocketFact, HostFacts } from '../src/policy/startup.ts';
import { PolicyStore } from '../src/policy/store.ts';
import { parseSetupOptions, type RawSetupFlags } from '../src/setup/options.ts';
import { runSetup } from '../src/setup/setup.ts';
import type { Executor } from '../src/toolchain/exec.ts';
import { admin, fakeSystem, RUNNER } from './admin/fake-system.ts';

/**
 * installer-policy-seal (Combined-QA blocker 3): an installer re-run over a sealed policy leaves a policy the runner
 * accepts at its next start. The real `guildwise-runner setup`, the real root tool on its pretend machine, the real store.
 */

const SOCK = '/run/docker-svc/docker.sock';

/** The root tool's machine: the runner user, a shared rootless daemon's socket (group docker-svc), a root-owned CLI. */
function machine() {
  const f = fakeSystem({
    users: [RUNNER],
    handle: (c) => {
      if (c.cmd === 'getent' && c.args[0] === 'group' && /^\d+$/.test(c.args[1] as string))
        return {
          code: 0,
          stdout: `${c.args[1] === '962' ? 'docker-svc' : 'g'}:x:${c.args[1]}:\n`,
          stderr: '',
        };
      if (c.cmd === '/usr/bin/docker')
        return { code: 0, stdout: '["name=seccomp","name=rootless"]\n', stderr: '' };
      return undefined;
    },
  });
  mkdirSync(join(f.root, '/run/docker-svc'), { recursive: true });
  writeFileSync(join(f.root, SOCK), '');
  (f.sys as unknown as { stat: (p: string) => unknown }).stat = (p: string) => {
    if (p !== join(f.root, SOCK)) throw new Error('ENOENT');
    return { uid: 1500, gid: 962 };
  };
  mkdirSync(join(f.root, 'usr/bin'), { recursive: true });
  writeFileSync(join(f.root, 'usr/bin/docker'), '#!/bin/sh\n');
  chmodSync(join(f.root, 'usr/bin/docker'), 0o755);
  const home = join(f.root, RUNNER.home);
  const dataRoot = join(home, '.aom-runner');
  mkdirSync(dataRoot, { recursive: true });
  const policyDir = join(home, '.config', 'aom-runner');
  const store = () => new PolicyStore(policyDir, { sealMarker: sealMarkerFor(dataRoot) });
  const exec: Executor = { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) };
  const out: string[] = [];
  /** `guildwise-runner setup` as the runner user, the installer's flags. */
  const setup = (raw: RawSetupFlags) =>
    runSetup(
      {
        home,
        uid: RUNNER.uid,
        username: RUNNER.name,
        platform: 'linux',
        dataRoot,
        policyFile: join(policyDir, 'policy.json'),
        prompter: null,
        out: (l) => out.push(l),
        exec,
        skipT12Check: true,
      },
      parseSetupOptions(
        { yes: true, docker: 'shared', dockerSocket: SOCK, acceptSharedDaemon: true, noYtdlp: true, ...raw },
        {},
      ),
    );
  /** The installer's root step: `guildwise-admin docker shared` (as root). */
  const adminShared = async () => {
    expect(
      await admin.main(['docker', 'shared', '--docker-socket', SOCK, '--accept-shared-daemon'], f.sys),
      f.err.join('\n'),
    ).toBe(0);
  };
  return { f, home, dataRoot, policyDir, store, setup, adminShared, out };
}

/** What the runner user sees of the shared socket after root's join (probeHost in the product). */
const FACT: DockerSocketFact = {
  path: SOCK,
  real: SOCK,
  uid: 1500,
  gid: 962,
  writable: true,
  own: false,
  owner: 'docker-svc',
  group: 'docker-svc',
  rootless: true,
};
const deps = (
  over: Partial<DockerSocketFact> = {},
  more: Partial<SharedDockerDeps> = {},
): SharedDockerDeps => ({
  probe: async (real) => (real === SOCK ? { ...FACT, ...over } : undefined),
  realpath: (p) => p,
  uid: RUNNER.uid,
  ...more,
});

/** The installer's runner step after the root step: `guildwise-runner policy record-shared-docker`. */
async function record(m: ReturnType<typeof machine>) {
  return recordSharedDocker(m.store(), deps());
}

describe('AC1: install, first start (seals), installer re-run with changed choices, start', () => {
  it('the policy is valid, sealed, and holds the new choices and the shared-daemon acceptance', async () => {
    const m = machine();
    // first install: no key yet (the runner has never started)
    await m.setup({ devopsRequests: 'ask' });
    await m.adminShared();
    await record(m);
    // the runner's first start seals what is there
    expect(m.store().adopt()).toBe(true);
    expect(m.store().read()).toMatchObject({ error: null, policy: { docker: 'shared' } });
    expect(m.store().read().adoptable).toBeUndefined();
    // the re-run (upgrade or re-link) with a changed choice
    await m.setup({ devopsRequests: 'auto' });
    await m.adminShared();
    await record(m);
    // the next start
    const r = m.store().read();
    expect(r.error).toBeNull();
    expect(r.adoptable).toBeUndefined();
    expect(r.policy).toMatchObject({
      devopsRequests: 'auto',
      docker: 'shared',
      dockerHost: `unix://${SOCK}`,
      sharedDocker: { socket: SOCK, group: 'docker-svc' },
    });
    expect(JSON.parse(readFileSync(m.store().file, 'utf8')).integrity).toBeTruthy();
  });
});

/** A sealed install with the shared daemon recorded (install, record, first start). */
async function sealedInstall() {
  const m = machine();
  await m.setup({});
  await m.adminShared();
  expect((await record(m)).recorded).toBe(true);
  expect(m.store().adopt()).toBe(true);
  return m;
}

describe('the record step before the first start and on a re-run', () => {
  it('a keyless first install stays unsealed (the first start adopts it) and no key is created', async () => {
    const m = machine();
    await m.setup({});
    await m.adminShared();
    expect(await record(m)).toEqual({ recorded: true, socket: SOCK, group: 'docker-svc' });
    expect(existsSync(join(m.policyDir, POLICY_KEY_FILE))).toBe(false);
    const raw = JSON.parse(readFileSync(m.store().file, 'utf8'));
    expect(raw.integrity).toBeUndefined();
    expect(m.store().read()).toMatchObject({
      error: null,
      adoptable: true,
      policy: { sharedDocker: { socket: SOCK, group: 'docker-svc' } },
    });
  });

  it('already recorded for this socket: nothing is written and nothing is probed', async () => {
    const m = await sealedInstall();
    const before = readFileSync(m.store().file, 'utf8');
    let probed = 0;
    const r = await recordSharedDocker(m.store(), {
      ...deps(),
      probe: async () => {
        probed++;
        return FACT;
      },
    });
    expect(r.recorded).toBe(false);
    expect(probed).toBe(0);
    expect(readFileSync(m.store().file, 'utf8')).toBe(before);
  });

  it('a link given to setup is written as its canonical path (DOCKER_HOST never follows a link)', async () => {
    const m = machine();
    await m.setup({ dockerSocket: '/run/svc-link/docker.sock' });
    let asked = '';
    const r = await recordSharedDocker(m.store(), {
      ...deps(),
      realpath: (p) => (p === '/run/svc-link/docker.sock' ? SOCK : p),
      probe: async (real) => {
        asked = real;
        return FACT;
      },
    });
    expect(asked).toBe(SOCK);
    expect(r).toMatchObject({ recorded: true, socket: SOCK });
    expect(m.store().get()).toMatchObject({ dockerHost: `unix://${SOCK}`, sharedDocker: { socket: SOCK } });
  });
});

describe('AC2: after a sealed install, a hand edit is still a broken seal', () => {
  it('an edit that keeps `integrity` gives the safe defaults and the error; setup and the record step refuse it', async () => {
    const m = await sealedInstall();
    // a sealed re-run first, so this is the state after the fixed reinstall
    await m.setup({ devopsRequests: 'auto' });
    await m.adminShared();
    await record(m);
    expect(m.store().read().error).toBeNull();
    const obj = JSON.parse(readFileSync(m.store().file, 'utf8'));
    expect(obj.integrity).toBeTruthy();
    obj.acceptRootEquivalent = true;
    writeFileSync(m.store().file, JSON.stringify(obj, null, 2));
    const r = m.store().read();
    expect(r.error).toMatch(/changed outside the runner/);
    expect(r.policy).toEqual(DEFAULT_POLICY);
    await expect(m.setup({})).rejects.toThrow(/changed outside the runner/);
    await expect(record(m)).rejects.toThrow(/changed outside the runner/);
    // nothing re-sealed it
    expect(m.store().read().error).toMatch(/changed outside the runner/);
  });

  it('a root write over the sealed file (what guildwise-admin did before) is detected the same way', async () => {
    const m = await sealedInstall();
    const obj = JSON.parse(readFileSync(m.store().file, 'utf8'));
    obj.sharedDocker = { ...obj.sharedDocker, acceptedAt: new Date(0).toISOString() };
    writeFileSync(m.store().file, JSON.stringify(obj, null, 2));
    expect(m.store().read().error).toMatch(/changed outside the runner/);
    await expect(record(m)).rejects.toThrow(/changed outside the runner/);
  });
});

describe('record-shared-docker refuses what root would refuse, and never seals more', () => {
  const saved = { token: process.env.AOM_SHIFT_TOKEN, id: process.env.AOM_SHIFT_ID };
  afterEach(() => {
    for (const [k, v] of [
      ['AOM_SHIFT_TOKEN', saved.token],
      ['AOM_SHIFT_ID', saved.id],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** A setup-written policy (shared, socket named, not yet recorded), sealed by a first start. */
  async function unrecorded() {
    const m = machine();
    await m.setup({});
    expect(m.store().adopt()).toBe(true);
    expect(m.store().get().sharedDocker).toBeUndefined();
    return m;
  }

  it.each<[string, Partial<DockerSocketFact>, RegExp]>([
    ['its own socket (owner is the runner user)', { uid: RUNNER.uid }, /own socket/],
    ['its own runtime socket', { own: true }, /own socket/],
    ['group root', { gid: 0 }, /group root/],
    ['not in the group yet', { group: undefined }, /not in the group/],
    ['the docker group', { group: 'docker' }, /docker group/],
    ['not writable', { writable: false }, /not writable/],
    ['not rootless', { rootless: false }, /does not report rootless/],
    ['rootless unknown', { rootless: undefined }, /does not report rootless/],
  ])('refuses %s, and writes nothing', async (_name, over, why) => {
    const m = await unrecorded();
    const before = readFileSync(m.store().file, 'utf8');
    await expect(recordSharedDocker(m.store(), deps(over))).rejects.toThrow(why);
    expect(readFileSync(m.store().file, 'utf8')).toBe(before);
  });

  it('refuses a link to a default socket, a missing socket, and a socket that changed during the check', async () => {
    const m = await unrecorded();
    for (const target of ['/run/docker.sock', '/var/run/docker.sock'])
      await expect(recordSharedDocker(m.store(), deps({}, { realpath: () => target }))).rejects.toThrow(
        /not a shared daemon's socket/,
      );
    await expect(
      recordSharedDocker(
        m.store(),
        deps(
          {},
          {
            realpath: () => {
              throw new Error('ENOENT');
            },
          },
        ),
      ),
    ).rejects.toThrow(/does not exist/);
    await expect(
      recordSharedDocker(
        m.store(),
        deps({}, { probe: async () => ({ ...FACT, real: '/run/other/docker.sock' }) }),
      ),
    ).rejects.toThrow(/not found/);
    expect(m.store().get().sharedDocker).toBeUndefined();
  });

  it('refuses a policy that does not choose shared (nothing new is recorded)', async () => {
    const m = machine();
    await m.setup({ docker: 'none', dockerSocket: undefined, acceptSharedDaemon: undefined });
    await expect(record(m)).rejects.toThrow(/does not choose a shared Docker daemon/);
    // no policy at all: the safe defaults say none
    const empty = machine();
    await expect(record(empty)).rejects.toThrow(/docker: none/);
    expect(existsSync(empty.store().file)).toBe(false);
  });

  it('refuses in an agent session (the no-op path too)', async () => {
    const m = await unrecorded();
    process.env.AOM_SHIFT_TOKEN = 'x';
    await expect(record(m)).rejects.toThrow(/never written from an agent session/);
    expect(m.store().get().sharedDocker).toBeUndefined();
    delete process.env.AOM_SHIFT_TOKEN;
    await record(m);
    process.env.AOM_SHIFT_ID = 'y';
    await expect(record(m)).rejects.toThrow(/agent session/);
  });

  it('never creates a key: a sealed policy whose key was deleted is refused', async () => {
    const m = await unrecorded();
    rmSync(join(m.policyDir, POLICY_KEY_FILE));
    await expect(record(m)).rejects.toThrow(/key is missing/);
    expect(existsSync(join(m.policyDir, POLICY_KEY_FILE))).toBe(false);
  });

  it('the guard refuses it for agents (the policy fence), with any CLI path or wrapper', () => {
    const cfg = {
      ...defaultGuardConfig('shift'),
      home: '/home/me',
      policyRoot: '/home/me/.config/aom-runner',
    };
    for (const c of [
      'guildwise-runner policy record-shared-docker',
      '/home/me/.local/bin/guildwise-runner policy record-shared-docker',
      '/home/me/.local/share/guildwise/runner/current/aom-runner policy record-shared-docker',
      'env FOO=1 guildwise-runner policy record-shared-docker',
      'timeout 5 aom-runner policy record-shared-docker',
    ]) {
      const v = classifyCommand(c, cfg, '/tmp');
      expect(v.decision, c).toBe('refused');
      expect(v.rule, c).toBe('policy_fence');
    }
  });
});

describe('the CLI wiring of the real probe (DESIGN-REVIEW should-fix 4)', () => {
  const emptyFacts = (sockets: DockerSocketFact[]): HostFacts => ({
    uid: RUNNER.uid,
    passwordlessSudo: false,
    groups: [],
    dockerSockets: sockets,
    writableByOthers: [],
  });

  it('asks probeHost for exactly the canonical socket, through the root-owned CLI of this runner (instance too)', async () => {
    const asked: unknown[] = [];
    const leaf = async (o: { paths: string[]; sharedSocket?: string; dockerCli?: readonly string[] }) => {
      asked.push(o);
      return emptyFacts([FACT]);
    };
    expect(await sharedDockerProbe(leaf, 'guildwise-runner')(SOCK)).toEqual(FACT);
    expect(await sharedDockerProbe(leaf, 'guildwise-runner-uat')(SOCK)).toEqual(FACT);
    expect(asked).toEqual([
      {
        paths: [],
        sharedSocket: SOCK,
        dockerCli: ['/usr/local/lib/guildwise/docker/docker', '/usr/bin/docker'],
      },
      {
        paths: [],
        sharedSocket: SOCK,
        dockerCli: ['/usr/local/lib/guildwise/uat/docker/docker', '/usr/bin/docker'],
      },
    ]);
    // a fact for another socket is not this one
    expect(
      await sharedDockerProbe(async () => emptyFacts([{ ...FACT, real: '/run/x/docker.sock' }]))(SOCK),
    ).toBe(undefined);
  });

  it('`policy record-shared-docker` resolves the link, probes the realpath through probeHost, and records it', async () => {
    const m = machine();
    await m.setup({ dockerSocket: '/run/svc-link/docker.sock' });
    expect(m.store().adopt()).toBe(true);
    const asked: string[] = [];
    const out: string[] = [];
    await policyRecordSharedDocker(
      {
        store: m.store(),
        held: new HeldStore(m.policyDir),
        passkeys: new PasskeyStore(m.policyDir),
        out: (l) => out.push(l),
      },
      {
        realpath: (p) => (p === '/run/svc-link/docker.sock' ? SOCK : p),
        user: 'guildwise-runner-uat',
        probeHost: async (o) => {
          asked.push(`${o.sharedSocket} ${o.dockerCli?.[0]}`);
          return emptyFacts([{ ...FACT, uid: 1500 }]);
        },
      },
    );
    expect(asked).toEqual([`${SOCK} /usr/local/lib/guildwise/uat/docker/docker`]);
    expect(out.join('\n')).toContain(`Recorded the accepted shared Docker daemon ${SOCK} (group docker-svc)`);
    expect(m.store().read()).toMatchObject({ error: null, policy: { sharedDocker: { socket: SOCK } } });
  });

  it('is registered as `policy record-shared-docker`; a refusal exits 1 with the reason', async () => {
    const m = machine();
    const errors: string[] = [];
    const orig = console.error;
    console.error = (l: string) => errors.push(l);
    const saved = process.exitCode;
    try {
      const program = new Command().exitOverride();
      registerPolicyCommands(program, () => ({
        store: m.store(),
        held: new HeldStore(m.policyDir),
        passkeys: new PasskeyStore(m.policyDir),
        out: () => {},
      }));
      await program.parseAsync(['node', 'x', 'policy', 'record-shared-docker']);
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('does not choose a shared Docker daemon');
    } finally {
      console.error = orig;
      process.exitCode = saved;
    }
  });
});

describe('the registered verb on a tampered file and in an agent session (REVIEW nit 2)', () => {
  /** Runs `policy record-shared-docker` through the registered command; the exit code and stderr. */
  async function viaCli(m: ReturnType<typeof machine>): Promise<{ code: unknown; err: string }> {
    const errors: string[] = [];
    const orig = console.error;
    console.error = (l: string) => errors.push(l);
    const saved = process.exitCode;
    process.exitCode = undefined;
    try {
      const program = new Command().exitOverride();
      registerPolicyCommands(program, () => ({
        store: m.store(),
        held: new HeldStore(m.policyDir),
        passkeys: new PasskeyStore(m.policyDir),
        out: () => {},
      }));
      await program.parseAsync(['node', 'x', 'policy', 'record-shared-docker']);
      return { code: process.exitCode, err: errors.join('\n') };
    } finally {
      console.error = orig;
      process.exitCode = saved;
    }
  }

  it('a hand-edited sealed policy: exit 1, the broken-seal reason, the file untouched and still broken', async () => {
    const m = machine();
    await m.setup({});
    expect(m.store().adopt()).toBe(true);
    const obj = JSON.parse(readFileSync(m.store().file, 'utf8'));
    obj.devopsRequests = 'auto';
    const tampered = JSON.stringify(obj, null, 2);
    writeFileSync(m.store().file, tampered);
    const r = await viaCli(m);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/changed outside the runner/);
    expect(readFileSync(m.store().file, 'utf8')).toBe(tampered);
    expect(m.store().read().error).toMatch(/changed outside the runner/);
  });

  it('in an agent session: exit 1, nothing written', async () => {
    const m = machine();
    await m.setup({});
    expect(m.store().adopt()).toBe(true);
    const before = readFileSync(m.store().file, 'utf8');
    const saved = process.env.AOM_SHIFT_TOKEN;
    process.env.AOM_SHIFT_TOKEN = 'x';
    try {
      const r = await viaCli(m);
      expect(r.code).toBe(1);
      expect(r.err).toContain('never written from an agent session');
    } finally {
      if (saved === undefined) delete process.env.AOM_SHIFT_TOKEN;
      else process.env.AOM_SHIFT_TOKEN = saved;
    }
    expect(readFileSync(m.store().file, 'utf8')).toBe(before);
  });
});

describe('setup prints the record step after the root step (manual flow)', () => {
  it('in the form of the runner user; nothing for other Docker modes', async () => {
    const m = machine();
    await m.setup({});
    const text = m.out.join('\n');
    const rootAt = text.indexOf('guildwise-admin docker shared');
    const recordAt = text.indexOf(
      `sudo -u guildwise-runner -H ${m.home}/.local/bin/guildwise-runner policy record-shared-docker`,
    );
    expect(rootAt).toBeGreaterThanOrEqual(0);
    expect(recordAt).toBeGreaterThan(rootAt);
    const none = machine();
    await none.setup({ docker: 'none', dockerSocket: undefined, acceptSharedDaemon: undefined });
    expect(none.out.join('\n')).not.toContain('record-shared-docker');
  });
});
