import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { type Policy, parsePolicy } from '../src/policy/schema.ts';
import { ADMIN_TOOL, adminCommand } from '../src/setup/admin-command.ts';
import { registerSetupCommand } from '../src/setup/command.ts';
import { parseSetupOptions, type RawSetupFlags, SetupError } from '../src/setup/options.ts';
import { policyPath, writePolicy } from '../src/setup/policy-file.ts';
import type { Prompter } from '../src/setup/prompt.ts';
import {
  GITHUB_OPTIONAL,
  MAC_DOCKER_WARNING,
  ROOTFUL_WARNING,
  runSetup,
  type SetupDeps,
  SHARED_WARNING,
} from '../src/setup/setup.ts';
import type { ExecOptions, Executor } from '../src/toolchain/exec.ts';

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const ORG_C = randomUUID();
const AGENT_A = randomUUID();
const AGENT_B = randomUUID();

interface Machine {
  home: string;
  dataRoot: string;
  out: string[];
  questions: string[];
  execCalls: Array<{ cmd: string; args: string[]; input?: string }>;
  deps: (over?: Partial<SetupDeps>) => SetupDeps;
  policy: () => Policy;
}

/** A home with one pairing and the server's offers: org A (Owner, has a DevOps engineer), B (Member, has one), C (none). */
function machine(opts: { username?: string; git?: string; paired?: boolean } = {}): Machine {
  const home = mkdtempSync(join(tmpdir(), 'gw-setup-'));
  const dataRoot = join(home, '.aom-runner');
  mkdirSync(dataRoot, { recursive: true });
  if (opts.paired !== false) {
    writeFileSync(
      join(dataRoot, 'pairings.json'),
      JSON.stringify({
        version: 1,
        pairings: [
          {
            id: 'hq-12345678',
            label: 'devbox',
            dir: '.',
            serverUrl: 'https://hq.example.com',
            workstationId: randomUUID(),
            addedAt: new Date().toISOString(),
          },
        ],
      }),
    );
    writeFileSync(
      join(dataRoot, 'setup-offers.json'),
      JSON.stringify({
        orgs: [
          { orgId: ORG_A, orgName: 'Acme', role: 'Owner', devopsAgentId: AGENT_A },
          { orgId: ORG_B, orgName: 'Beta', role: 'Member', devopsAgentId: AGENT_B },
          { orgId: ORG_C, orgName: 'Gamma', role: 'Admin' },
        ],
      }),
    );
  }
  const out: string[] = [];
  const questions: string[] = [];
  const execCalls: Machine['execCalls'] = [];
  const exec: Executor = {
    async run(cmd: string, args: string[], o: ExecOptions = {}) {
      execCalls.push({ cmd, args, ...(o.input !== undefined ? { input: o.input } : {}) });
      if (cmd === 'git') return { exitCode: 0, stdout: `${opts.git ?? 'git version 2.53.0'}\n`, stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
  const deps = (over: Partial<SetupDeps> = {}): SetupDeps => ({
    home,
    uid: 990,
    username: opts.username ?? 'guildwise-runner',
    platform: 'linux',
    dataRoot,
    prompter: null,
    out: (l) => out.push(l),
    exec,
    ...over,
  });
  return {
    home,
    dataRoot,
    out,
    questions,
    execCalls,
    deps,
    policy: () => parsePolicy(readFileSync(policyPath(home), 'utf8')),
  };
}

/** Answers by question pattern; anything unmatched takes the question's own default (and is recorded). */
function scripted(m: Machine, answers: Array<[RegExp, boolean | string]>): Prompter {
  const find = (q: string) => {
    m.questions.push(q);
    return answers.find(([re]) => re.test(q))?.[1];
  };
  return {
    async confirm(q, def) {
      const a = find(q);
      return typeof a === 'boolean' ? a : def;
    },
    async choose(q, choices, def) {
      const a = find(q);
      return typeof a === 'string' && (choices as readonly string[]).includes(a) ? (a as typeof def) : def;
    },
    async text(q, def = '') {
      const a = find(q);
      return typeof a === 'string' ? a : def;
    },
    async secret(q) {
      const a = find(q);
      return typeof a === 'string' ? a : '';
    },
  };
}

const opts = (raw: RawSetupFlags = {}) => parseSetupOptions(raw, {});

/** Types these keys at the one screen's prompt, then Enter. */
function edits(p: Prompter, keys: string[]): Prompter {
  const typed = [...keys, ''];
  const base = p.text;
  p.text = async (q, def) => (/Press Enter to accept/.test(q) ? (typed.shift() ?? '') : base(q, def));
  return p;
}

describe('guildwise-runner setup [R20]', () => {
  it('refuses to run as root, and writes nothing', async () => {
    const m = machine();
    await expect(runSetup(m.deps({ uid: 0 }), opts({ yes: true }))).rejects.toThrow(/refuses to run as root/);
    expect(existsSync(policyPath(m.home))).toBe(false);
  });

  it('--yes gives the safest values: no DevOps orgs, own rootless Docker, deploy ask, start-up refusal on', async () => {
    const m = machine();
    const r = await runSetup(m.deps(), opts({ yes: true }));
    expect(r.exitCode).toBe(0);
    expect(r.adminCommands).toEqual([`sudo ${ADMIN_TOOL} docker rootless`]);
    const p = m.policy();
    expect(p.devops).toEqual({ agents: {} });
    expect(p).toMatchObject({
      runnerUser: { mode: 'dedicated', name: 'guildwise-runner' },
      docker: 'rootless',
      deploy: 'ask',
      deployPinCommit: false,
      acceptRootEquivalent: false,
      startupRefusal: true,
      setupDone: true,
      allowUnsignedUpdatesFrom: [],
    });
    expect(statSync(policyPath(m.home)).mode & 0o777).toBe(0o600);
    expect(statSync(join(m.home, '.config/aom-runner')).mode & 0o777).toBe(0o700);
    // own clones under the runner HOME
    expect(statSync(join(m.home, 'src')).mode & 0o7777).toBe(0o700);
  });

  it('as another user, --yes points at the dedicated user: prints the root steps and writes nothing', async () => {
    const m = machine({ username: 'alice' });
    const r = await runSetup(m.deps(), opts({ yes: true }));
    expect(r.exitCode).toBe(3);
    expect(r.wrote).toBe(false);
    expect(r.adminCommands).toEqual([
      `sudo ${ADMIN_TOOL} user create`,
      `sudo ${ADMIN_TOOL} service install`,
      `sudo ${ADMIN_TOOL} migrate-user --from alice`,
    ]);
    // sudo's secure_path never finds a bare guildwise-runner: the hint uses the absolute path
    expect(m.out.join('\n')).toContain(
      'sudo -u guildwise-runner -H /home/guildwise-runner/.local/bin/guildwise-runner setup',
    );
    expect(existsSync(policyPath(m.home))).toBe(false);
  });

  it('flags map one to one onto policy.json and the root commands', async () => {
    const m = machine();
    const r = await runSetup(
      m.deps(),
      opts({
        yes: true,
        runnerUser: 'dedicated',
        devopsOrgs: `${ORG_A},${ORG_B}`,
        docker: 'none',
        deploy: 'off',
        deployPinCommit: true,
        allowUnsignedFrom: ['https://hq.example.com'],
      }),
    );
    expect(r.exitCode).toBe(0);
    const p = m.policy();
    expect(p.devops).toEqual({ agents: { [ORG_A]: AGENT_A, [ORG_B]: AGENT_B } });
    expect(p.docker).toBe('none');
    expect(p.deploy).toBe('off');
    expect(p.deployPinCommit).toBe(true);
    expect(p.allowUnsignedUpdatesFrom).toEqual(['https://hq.example.com']);
    expect(p.devopsRequests).toBe('ask');
    expect(r.adminCommands).toEqual([]);
    expect(m.out.join('\n')).not.toMatch(/sudo +on|sealed/);
  });

  it('server-offered organizations are only suggestions: each defaults to no', async () => {
    const m = machine();
    await runSetup(m.deps({ prompter: scripted(m, []) }), opts());
    expect(m.policy().devops.agents).toEqual({});
    const out = m.out.join('\n');
    // the one screen shows names, never ids
    expect(out).toMatch(/1a {2}Acme \(you are Owner\) \.+ No/);
    expect(out).toMatch(/1b {2}Beta \(you are Member\) \.+ No/);
    expect(out).toMatch(/1c {2}Gamma \(you are Admin\) \.+ no helper yet/);
    expect(out).not.toContain(ORG_A);
  });

  it('a local yes per organization grants exactly that one', async () => {
    const m = machine();
    const typed = ['1a', ''];
    const p = scripted(m, [[/May Acme's DevOps helper/, true]]);
    const base = p.text;
    p.text = async (q, def) => (/Press Enter to accept/.test(q) ? (typed.shift() ?? '') : base(q, def));
    await runSetup(m.deps({ prompter: p }), opts());
    expect(m.policy().devops.agents).toEqual({ [ORG_A]: AGENT_A });
  });

  it('--devops-orgs refuses an organization the server does not offer, one without a DevOps engineer, and shortcuts', async () => {
    const m = machine();
    await expect(runSetup(m.deps(), opts({ yes: true, devopsOrgs: randomUUID() }))).rejects.toThrow(
      /not one the server offers/,
    );
    await expect(runSetup(m.deps(), opts({ yes: true, devopsOrgs: ORG_C }))).rejects.toThrow(
      /no DevOps engineer/,
    );
    expect(() => opts({ devopsOrgs: 'owned' })).toThrow(/no shortcuts/);
    expect(existsSync(policyPath(m.home))).toBe(false);
  });

  it('interactive: no sudo question exists any more; Docker defaults to rootless', async () => {
    const m = machine();
    await runSetup(m.deps({ prompter: scripted(m, []) }), opts());
    const p = m.policy();
    expect(p.devops).toEqual({ agents: {} });
    expect(p.docker).toBe('rootless');
    expect(p.deploy).toBe('ask');
    expect(m.questions.some((q) => /sudo/i.test(q))).toBe(false);
  });

  it('the fetch route prints guildwise-admin readers add, only with git >= 2.45.1', async () => {
    const m = machine();
    const r = await runSetup(
      m.deps({
        prompter: scripted(m, [
          [/fetch from the runner/, true],
          [/user name/, 'alice'],
        ]),
      }),
      opts(),
    );
    expect(r.adminCommands).toContain(`sudo ${ADMIN_TOOL} readers add alice`);
    const old = machine({ git: 'git version 2.43.0' });
    const r2 = await runSetup(
      old.deps({
        prompter: scripted(old, [
          [/fetch from the runner/, true],
          [/user name/, 'alice'],
        ]),
      }),
      opts(),
    );
    expect(r2.adminCommands.some((c) => c.includes('readers add'))).toBe(false);
    expect(old.out.join('\n')).toContain('only the remote route is offered');
  });

  it('a re-run keeps local grants only on a local yes, and keeps a legacy update origin unless declined', async () => {
    const m = machine();
    const file = policyPath(m.home);
    writePolicy(file, {
      ...parsePolicy('{}'),
      devops: { agents: { [ORG_A]: AGENT_A, [ORG_B]: AGENT_B } },
      legacyUpdateOrigin: 'https://hq.example.com',
    });
    // [S4] the screen starts from the policy: both stay Yes until edited, and --yes revokes nothing
    await runSetup(m.deps(), opts({ yes: true }));
    expect(m.policy().devops.agents).toEqual({ [ORG_A]: AGENT_A, [ORG_B]: AGENT_B });
    const typed = ['1b', ''];
    const p = scripted(m, [[/May Beta's DevOps helper/, false]]);
    const base = p.text;
    p.text = async (q, def) => (/Press Enter to accept/.test(q) ? (typed.shift() ?? '') : base(q, def));
    await runSetup(m.deps({ prompter: p }), opts());
    expect(m.policy().devops.agents).toEqual({ [ORG_A]: AGENT_A });
    expect(m.policy().legacyUpdateOrigin).toBe('https://hq.example.com');
    await runSetup(m.deps({ prompter: scripted(m, [[/old self-update/, false]]) }), opts());
    expect(m.policy().legacyUpdateOrigin).toBeUndefined();
  });

  it('macOS dedicated user: logins use claude setup-token; --yes gives no Docker on a Mac', async () => {
    const m = machine();
    await runSetup(m.deps({ platform: 'darwin' }), opts({ yes: true }));
    expect(m.out.join('\n')).toContain('claude setup-token');
    expect(m.policy().docker).toBe('none');
  });
});

describe('setup flags and environment', () => {
  it('reads GUILDWISE_* variables; a flag beats its variable', () => {
    const o = parseSetupOptions(
      { docker: 'none' },
      {
        GUILDWISE_YES: '1',
        GUILDWISE_RUNNER_USER: 'current',
        GUILDWISE_DOCKER: 'host',
        GUILDWISE_DOCKER_FOUND: 'rootful',
        GUILDWISE_DEVOPS_ORGS: 'none',
        GUILDWISE_DEPLOY: 'off',
        GUILDWISE_DEPLOY_PIN_COMMIT: '1',
        GUILDWISE_ALLOW_UNSIGNED_FROM: 'http://localhost:4000',
      },
    );
    expect(o).toMatchObject({
      yes: true,
      runnerUser: 'current',
      docker: 'none',
      dockerFound: 'rootful',
      devopsOrgs: 'none',
      deploy: 'off',
      deployPinCommit: true,
      allowUnsignedFrom: ['http://localhost:4000'],
    });
  });

  it('refuses bad values', () => {
    expect(() => opts({ runnerUser: 'root' })).toThrow(SetupError);
    expect(() => opts({ allowUnsignedFrom: ['https://hq.example.com/path'] })).toThrow(/exact origin/);
    expect(() => opts({ dockerFound: 'maybe' })).toThrow(/docker-found/);
  });

  it('quotes printed root commands for a POSIX shell', () => {
    expect(adminCommand(['readers', 'add', "it's"])).toBe(`sudo ${ADMIN_TOOL} readers add 'it'\\''s'`);
  });

  it('is registered as `guildwise-runner setup` with every installer flag', () => {
    const program = new Command('aom-runner');
    registerSetupCommand(program);
    const setup = program.commands.find((c) => c.name() === 'setup');
    const flags = setup?.options.map((o) => o.long) ?? [];
    for (const f of [
      '--yes',
      '--runner-user',
      '--wsl-distro',
      '--legacy',
      '--accept-root-equivalent',
      '--devops-orgs',
      '--docker',
      '--docker-found',
      '--docker-socket',
      '--accept-shared-daemon',
      '--deploy',
      '--deploy-pin-commit',
      '--allow-unsigned-from',
    ])
      expect(flags).toContain(f);
  });
});

describe('guildwise-runner setup for a named runner instance', () => {
  it('as guildwise-runner-uat: dedicated mode, every root command carries --instance uat', async () => {
    const m = machine({ username: 'guildwise-runner-uat' });
    const r = await runSetup(m.deps(), opts({ yes: true }));
    expect(r.exitCode).toBe(0);
    expect(m.policy().runnerUser).toEqual({ mode: 'dedicated', name: 'guildwise-runner-uat' });
    expect(r.adminCommands).toEqual([
      `sudo /usr/local/lib/guildwise/uat/guildwise-admin --instance uat docker rootless`,
    ]);
    expect(m.out.join('\n')).toContain('guildwise-runner-uat (dedicated, instance uat)');
  });

  it('refuses --instance prod when run as the uat runner user', async () => {
    const m = machine({ username: 'guildwise-runner-uat' });
    await expect(runSetup(m.deps(), opts({ yes: true, instance: 'prod' }))).rejects.toThrow(
      /not the runner user of instance prod/,
    );
    expect(existsSync(policyPath(m.home))).toBe(false);
  });

  it('as a person with --instance prod: prints the root steps of that instance; current mode is refused', async () => {
    const m = machine({ username: 'alice' });
    const r = await runSetup(m.deps(), opts({ yes: true, instance: 'prod' }));
    expect(r.exitCode).toBe(3);
    expect(r.adminCommands).toEqual([
      `sudo /usr/local/lib/guildwise/prod/guildwise-admin --instance prod user create`,
      `sudo /usr/local/lib/guildwise/prod/guildwise-admin --instance prod service install`,
      `sudo /usr/local/lib/guildwise/prod/guildwise-admin --instance prod migrate-user --from alice`,
    ]);
    expect(m.out.join('\n')).toContain(
      'sudo -u guildwise-runner-prod -H /home/guildwise-runner-prod/.local/bin/guildwise-runner setup --instance prod',
    );
    await expect(
      runSetup(m.deps(), opts({ yes: true, instance: 'prod', runnerUser: 'current' })),
    ).rejects.toThrow(/needs the dedicated runner user guildwise-runner-prod/);
  });
});

describe('setup step 4: Docker for the runner (deps-without-sudo §3)', () => {
  it('found none or own: rootless with no question', async () => {
    for (const found of ['none', 'own'] as const) {
      const m = machine();
      const r = await runSetup(m.deps({ prompter: scripted(m, []) }), opts({ dockerFound: found }));
      expect(m.policy().docker).toBe('rootless');
      expect(r.adminCommands).toContain(`sudo ${ADMIN_TOOL} docker rootless`);
      expect(m.questions.some((q) => /Docker/.test(q))).toBe(false);
    }
  });

  it("found rootful: the owner's warning, then item 3 offers 1) its own (default) or 3) the installed Docker with the typed phrase", async () => {
    const m = machine();
    await runSetup(m.deps({ prompter: scripted(m, []) }), opts({ dockerFound: 'rootful' }));
    expect(m.out.join('\n')).toContain('Docker detected, not running in rootless mode');
    expect(ROOTFUL_WARNING).toBe('Docker detected, not running in rootless mode');
    expect(m.policy().docker).toBe('rootless');
    const m2 = machine();
    await runSetup(
      m2.deps({
        prompter: edits(
          scripted(m2, [
            [/Its own private Docker \(safe\)/, '3'],
            [/Type "root-equivalent"/, 'yes'],
          ]),
          ['3'],
        ),
      }),
      opts({ dockerFound: 'rootful' }),
    );
    expect(m2.policy()).toMatchObject({ docker: 'none', acceptRootEquivalent: false });
    const m3 = machine();
    const r = await runSetup(
      m3.deps({
        prompter: edits(
          scripted(m3, [
            [/Its own private Docker \(safe\)/, '3'],
            [/Type "root-equivalent"/, 'root-equivalent'],
          ]),
          ['3'],
        ),
      }),
      opts({ dockerFound: 'rootful' }),
    );
    expect(m3.policy()).toMatchObject({ docker: 'host', acceptRootEquivalent: true });
    expect(r.adminCommands).toContain(`sudo ${ADMIN_TOOL} docker host --accept-root-equivalent`);
  });

  it('--docker host needs --accept-root-equivalent; --yes gives rootless on Linux', async () => {
    expect(() => opts({ docker: 'host' })).toThrow(/accept-root-equivalent/);
    const m = machine();
    const r = await runSetup(m.deps(), opts({ yes: true, docker: 'host', acceptRootEquivalent: true }));
    expect(m.policy()).toMatchObject({ docker: 'host', acceptRootEquivalent: true });
    expect(r.adminCommands).toEqual([`sudo ${ADMIN_TOOL} docker host --accept-root-equivalent`]);
    const y = machine();
    await runSetup(y.deps(), opts({ yes: true, dockerFound: 'rootful' }));
    expect(y.policy().docker).toBe('rootless');
  });

  it('macOS with Docker Desktop (owner: "we detect docker on mac then we use that docker setup"): item 3 defaults to it; Enter, the /Users warning and the typed phrase give host with the socket; declined gives none; --yes gives none', async () => {
    const sock = '/Users/alice/.docker/run/docker.sock';
    const m = machine();
    const r = await runSetup(
      m.deps({
        platform: 'darwin',
        prompter: scripted(m, [[/Type "root-equivalent"/, 'root-equivalent']]),
      }),
      opts({ dockerFound: 'desktop', dockerSocket: sock }),
    );
    expect(m.out.join('\n')).toMatch(
      /3 {2}Docker, for apps your agents build and test \.+ The Docker already on this computer/,
    );
    expect(m.out.join('\n')).toContain(MAC_DOCKER_WARNING);
    expect(MAC_DOCKER_WARNING).toContain('by default all of /Users');
    expect(m.policy()).toMatchObject({
      docker: 'host',
      dockerHost: `unix://${sock}`,
      acceptRootEquivalent: true,
    });
    expect(r.adminCommands).toContain(
      `sudo ${ADMIN_TOOL} docker host --accept-root-equivalent --desktop-socket ${sock}`,
    );
    const d = machine();
    await runSetup(
      d.deps({ platform: 'darwin', prompter: scripted(d, [[/Type "root-equivalent"/, 'no']]) }),
      opts({ dockerFound: 'desktop', dockerSocket: sock }),
    );
    expect(d.policy().docker).toBe('none');
    const y = machine();
    await runSetup(
      y.deps({ platform: 'darwin' }),
      opts({ yes: true, dockerFound: 'desktop', dockerSocket: sock }),
    );
    expect(y.policy().docker).toBe('none');
    // no Docker Desktop found: nothing to use, no question
    const n = machine();
    await runSetup(n.deps({ platform: 'darwin', prompter: scripted(n, []) }), opts({ dockerFound: 'none' }));
    expect(n.policy().docker).toBe('none');
    expect(() => opts({ dockerSocket: '/tmp/docker.sock' })).toThrow(/--docker-socket/);
  });

  it('shared rootless daemon (owner 2026-11-21): typed acceptance, policy names the socket, root records the acceptance', async () => {
    expect(() => opts({ docker: 'shared', dockerSocket: '/run/docker-svc/docker.sock' })).toThrow(
      /accept-shared-daemon/,
    );
    const sock = '/run/docker-svc/docker.sock';
    const m = machine({ username: 'guildwise-runner-uat' });
    const r = await runSetup(
      m.deps({
        prompter: edits(
          scripted(m, [
            [/Its own private Docker/, '4'],
            [/Type "shared-daemon"/, 'shared-daemon'],
          ]),
          ['3'],
        ),
      }),
      opts({ dockerFound: 'shared', dockerSocket: sock }),
    );
    expect(m.out.join('\n')).toContain(SHARED_WARNING);
    expect(SHARED_WARNING).toContain("can each control the other's containers");
    expect(m.policy()).toMatchObject({ docker: 'shared', dockerHost: `unix://${sock}` });
    expect(r.adminCommands).toContain(
      `sudo /usr/local/lib/guildwise/uat/guildwise-admin --instance uat docker shared --docker-socket ${sock} --accept-shared-daemon`,
    );
    // prod may join the same daemon with the same acceptance ("Prod and UAT can use the same rootless docker")
    const prod = machine({ username: 'guildwise-runner-prod' });
    const rp = await runSetup(
      prod.deps(),
      opts({ yes: true, docker: 'shared', dockerSocket: sock, acceptSharedDaemon: true }),
    );
    expect(prod.policy().docker).toBe('shared');
    expect(rp.adminCommands[0]).toContain('--instance prod docker shared');
    // declined: its own rootless daemon
    const d = machine();
    await runSetup(
      d.deps({ prompter: edits(scripted(d, [[/Its own private Docker/, '4']]), ['3']) }),
      opts({ dockerFound: 'shared', dockerSocket: sock }),
    );
    expect(d.policy().docker).toBe('rootless');
  });

  it('F1: current user in a group that reaches a Docker daemon: no group change, the refusal text, --yes writes nothing', async () => {
    const groups = (m: Machine): SetupDeps['exec'] => ({
      async run(cmd, args) {
        m.execCalls.push({ cmd, args });
        if (cmd === 'id') return { exitCode: 0, stdout: 'alice docker\n', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const m = machine({ username: 'alice' });
    await expect(
      runSetup(m.deps({ exec: groups(m) }), opts({ yes: true, runnerUser: 'current' })),
    ).rejects.toThrow(/would refuse to start.*dedicated runner user/s);
    expect(existsSync(policyPath(m.home))).toBe(false);
    const i = machine({ username: 'alice' });
    const r = await runSetup(
      i.deps({ exec: groups(i), prompter: scripted(i, []) }),
      opts({ runnerUser: 'current' }),
    );
    expect(r.exitCode).toBe(3);
    expect(r.adminCommands).toEqual([`sudo ${ADMIN_TOOL} user create`, `sudo ${ADMIN_TOOL} service install`]);
    expect([...m.execCalls, ...i.execCalls].some((c) => ['gpasswd', 'usermod'].includes(c.cmd))).toBe(false);
  });

  it('the removed flags are rejected: --sudo, --sudo-password-stdin, --approve-app, --docker narrow|group', () => {
    expect(() => opts({ docker: 'narrow' })).toThrow(SetupError);
    expect(() => opts({ docker: 'group', acceptRootEquivalent: true })).toThrow(SetupError);
    for (const argv of [['--sudo', 'on'], ['--sudo-password-stdin'], ['--approve-app', 'shop=/x']]) {
      const program = new Command('aom-runner').exitOverride();
      program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
      registerSetupCommand(program);
      program.commands.forEach((c) => {
        c.exitOverride();
        c.configureOutput({ writeErr: () => {}, writeOut: () => {} });
      });
      expect(() => program.parse(['node', 'aom-runner', 'setup', ...argv])).toThrow(/unknown option/);
    }
  });
});

describe('GitHub is never required (owner 2026-11-21: "UAT will not use github and it should be able to setup through the UI")', () => {
  it('setup asks nothing about GitHub, runs no gh, and only mentions gh as optional', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const m = machine({ username: 'guildwise-runner-uat' });
      const r = await runSetup(m.deps({ platform, prompter: scripted(m, []) }), opts());
      expect(r.exitCode).toBe(0);
      expect(m.questions.some((q) => /github|gh /i.test(q))).toBe(false);
      expect(m.execCalls.some((c) => c.cmd === 'gh')).toBe(false);
      const ghLines = m.out.filter((l) => /\bgh\b/.test(l));
      expect(ghLines).toEqual([GITHUB_OPTIONAL]);
      expect(GITHUB_OPTIONAL).toContain('(optional)');
    }
  });
});
