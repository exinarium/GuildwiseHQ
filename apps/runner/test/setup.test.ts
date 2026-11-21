import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { type Policy, parsePolicy } from '../src/policy/schema.ts';
import { RunnerKeys } from '../src/secrets/keys.ts';
import { ADMIN_TOOL, adminCommand } from '../src/setup/admin-command.ts';
import { registerSetupCommand } from '../src/setup/command.ts';
import { parseSetupOptions, type RawSetupFlags, SetupError } from '../src/setup/options.ts';
import { policyPath, writePolicy } from '../src/setup/policy-file.ts';
import type { Prompter } from '../src/setup/prompt.ts';
import { runSetup, type SetupDeps, SUDO_WARNING } from '../src/setup/setup.ts';
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
function machine(
  opts: { username?: string; sudoPassword?: string; git?: string; paired?: boolean } = {},
): Machine {
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
      if (cmd === 'sudo' && args.includes('-S'))
        return { exitCode: o.input === `${opts.sudoPassword ?? 'right'}\n` ? 0 : 1, stdout: '', stderr: '' };
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
    readStdin: async () => '',
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

describe('guildwise-runner setup [R20]', () => {
  it('refuses to run as root, and writes nothing', async () => {
    const m = machine();
    await expect(runSetup(m.deps({ uid: 0 }), opts({ yes: true }))).rejects.toThrow(/refuses to run as root/);
    expect(existsSync(policyPath(m.home))).toBe(false);
  });

  it('--yes gives the safest values: no DevOps orgs, sudo off, no Docker, deploy ask, start-up refusal on', async () => {
    const m = machine();
    const r = await runSetup(m.deps(), opts({ yes: true }));
    expect(r.exitCode).toBe(0);
    expect(r.adminCommands).toEqual([]);
    const p = m.policy();
    expect(p).toMatchObject({
      runnerUser: { mode: 'dedicated', name: 'guildwise-runner' },
      devops: { agents: {}, sudo: false },
      docker: 'none',
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
    expect(m.out.join('\n')).toContain('sudo -u guildwise-runner -H guildwise-runner setup');
    expect(existsSync(policyPath(m.home))).toBe(false);
  });

  it('flags map one to one onto policy.json and the root commands', async () => {
    const m = machine();
    const app = join(m.home, 'src', 'shop');
    const r = await runSetup(
      m.deps(),
      opts({
        yes: true,
        runnerUser: 'dedicated',
        devopsOrgs: `${ORG_A},${ORG_B}`,
        sudo: 'on',
        docker: 'narrow',
        approveApp: [`shop=${app}`],
        deploy: 'off',
        deployPinCommit: true,
        allowUnsignedFrom: ['https://hq.example.com'],
      }),
    );
    expect(r.exitCode).toBe(0);
    const p = m.policy();
    expect(p.devops).toEqual({ agents: { [ORG_A]: AGENT_A, [ORG_B]: AGENT_B }, sudo: true });
    expect(p.docker).toBe('narrow');
    expect(p.deploy).toBe('off');
    expect(p.deployPinCommit).toBe(true);
    expect(p.allowUnsignedUpdatesFrom).toEqual(['https://hq.example.com']);
    expect(p.devopsRequests).toBe('ask');
    expect(r.adminCommands).toEqual([
      `sudo ${ADMIN_TOOL} sudo on`,
      `sudo ${ADMIN_TOOL} docker narrow`,
      `sudo ${ADMIN_TOOL} approve-app shop --source ${app}`,
    ]);
    // the key the root tool seals the sudo password with exists before the command is printed
    expect(existsSync(join(m.dataRoot, 'secrets', 'runner-key.pem'))).toBe(true);
    expect(m.out.join('\n')).toContain(SUDO_WARNING);
  });

  it('--docker group with --accept-root-equivalent sets the acceptance; without it the flags are refused', async () => {
    expect(() => opts({ docker: 'group' })).toThrow(SetupError);
    const m = machine();
    const r = await runSetup(m.deps(), opts({ yes: true, docker: 'group', acceptRootEquivalent: true }));
    expect(m.policy()).toMatchObject({ docker: 'group', acceptRootEquivalent: true });
    expect(r.adminCommands).toEqual([`sudo ${ADMIN_TOOL} docker group --accept-root-equivalent`]);
  });

  it('server-offered organizations are only suggestions: each defaults to no', async () => {
    const m = machine();
    await runSetup(m.deps({ prompter: scripted(m, []) }), opts());
    expect(m.policy().devops.agents).toEqual({});
    const out = m.out.join('\n');
    expect(out).toContain(`Acme (${ORG_A}): the server says you are Owner.`);
    expect(out).toContain(`Beta (${ORG_B}): the server says you are Member.`);
    expect(out).toContain(`guildwise-runner devops grant ${ORG_C}`);
  });

  it('a local yes per organization grants exactly that one', async () => {
    const m = machine();
    let n = 0;
    const p = scripted(m, []);
    const base = p.confirm;
    p.confirm = async (q, def) => (/outside the sandbox/.test(q) && n++ === 0 ? true : base(q, def));
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

  it('interactive: sudo and Docker default to off/none; the sudo prompt says it plainly', async () => {
    const m = machine();
    await runSetup(m.deps({ prompter: scripted(m, []) }), opts());
    const p = m.policy();
    expect(p.devops.sudo).toBe(false);
    expect(p.docker).toBe('none');
    expect(p.deploy).toBe('ask');
    expect(m.out.join('\n')).toContain(SUDO_WARNING);
  });

  it('interactive docker group needs the typed phrase; anything else keeps none', async () => {
    const m = machine();
    await runSetup(
      m.deps({
        prompter: scripted(m, [
          [/Docker access/, 'group'],
          [/Type "root-equivalent"/, 'yes'],
        ]),
      }),
      opts(),
    );
    expect(m.policy()).toMatchObject({ docker: 'none', acceptRootEquivalent: false });
    const m2 = machine();
    const r = await runSetup(
      m2.deps({
        prompter: scripted(m2, [
          [/Docker access/, 'group'],
          [/Type "root-equivalent"/, 'root-equivalent'],
        ]),
      }),
      opts(),
    );
    expect(m2.policy()).toMatchObject({ docker: 'group', acceptRootEquivalent: true });
    expect(r.adminCommands).toContain(`sudo ${ADMIN_TOOL} docker group --accept-root-equivalent`);
  });

  it("current user: sudo on seals the user's own password locally (checked with sudo -S), never on a command line", async () => {
    const m = machine({ username: 'alice', sudoPassword: 'hunter2' });
    const r = await runSetup(
      m.deps({ readStdin: async () => 'hunter2\n' }),
      opts({ yes: true, runnerUser: 'current', sudo: 'on', sudoPasswordStdin: true }),
    );
    expect(r.adminCommands).toEqual([]);
    const keys = new RunnerKeys(join(m.dataRoot, 'secrets', 'runner-key.pem'));
    expect(keys.decrypt(readFileSync(join(m.dataRoot, 'secrets', 'sudo.enc'), 'utf8').trim())).toBe(
      'hunter2',
    );
    expect(m.policy()).toMatchObject({
      runnerUser: { mode: 'current', name: 'alice' },
      devops: { sudo: true },
    });
    expect(m.execCalls.some((c) => c.args.join(' ').includes('hunter2'))).toBe(false);
    expect(m.out.join('\n')).not.toContain('hunter2');
    expect(statSync(join(m.home, 'guildwise-runner', 'src')).isDirectory()).toBe(true);
  });

  it('current user: a password sudo refuses is not kept and nothing is written', async () => {
    const m = machine({ username: 'alice', sudoPassword: 'right' });
    await expect(
      runSetup(
        m.deps({ readStdin: async () => 'wrong\n' }),
        opts({ yes: true, runnerUser: 'current', sudo: 'on', sudoPasswordStdin: true }),
      ),
    ).rejects.toThrow(/did not accept/);
    expect(existsSync(join(m.dataRoot, 'secrets', 'sudo.enc'))).toBe(false);
    expect(existsSync(policyPath(m.home))).toBe(false);
  });

  it('sudo on needs a pairing (the key it is sealed with)', async () => {
    const m = machine({ paired: false });
    await expect(runSetup(m.deps(), opts({ yes: true, sudo: 'on' }))).rejects.toThrow(
      /pair this machine first/,
    );
  });

  it('turning sudo off after it was on prints guildwise-admin sudo off', async () => {
    const m = machine();
    await runSetup(m.deps(), opts({ yes: true, sudo: 'on' }));
    const r = await runSetup(m.deps(), opts({ yes: true }));
    expect(r.adminCommands).toEqual([`sudo ${ADMIN_TOOL} sudo off`]);
    expect(m.policy().devops.sudo).toBe(false);
  });

  it("refuses an app folder outside the runner's own HOME", async () => {
    const m = machine();
    await expect(
      runSetup(m.deps(), opts({ yes: true, docker: 'narrow', approveApp: ['shop=/home/alice/shop'] })),
    ).rejects.toThrow(/own clones/);
    expect(() => opts({ docker: 'none', approveApp: ['shop=/x'] })).toThrow(/needs --docker narrow/);
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
    expect(r2.adminCommands).toEqual([]);
    expect(old.out.join('\n')).toContain('only the remote route is offered');
  });

  it('a re-run keeps local grants only on a local yes, and keeps a legacy update origin unless declined', async () => {
    const m = machine();
    const file = policyPath(m.home);
    writePolicy(file, {
      ...parsePolicy('{}'),
      devops: { agents: { [ORG_A]: AGENT_A, [ORG_B]: AGENT_B }, sudo: false },
      legacyUpdateOrigin: 'https://hq.example.com',
    });
    await runSetup(
      m.deps({ prompter: scripted(m, [[/Keep the local DevOps grant for Beta/, false]]) }),
      opts(),
    );
    expect(m.policy().devops.agents).toEqual({ [ORG_A]: AGENT_A });
    expect(m.policy().legacyUpdateOrigin).toBe('https://hq.example.com');
    await runSetup(m.deps({ prompter: scripted(m, [[/old self-update/, false]]) }), opts());
    expect(m.policy().legacyUpdateOrigin).toBeUndefined();
  });

  it('macOS dedicated user: logins use claude setup-token and gh --insecure-storage', async () => {
    const m = machine();
    await runSetup(m.deps({ platform: 'darwin' }), opts({ yes: true }));
    const out = m.out.join('\n');
    expect(out).toContain('claude setup-token');
    expect(out).toContain('gh auth login --insecure-storage');
  });
});

describe('setup flags and environment', () => {
  it('reads GUILDWISE_* variables; a flag beats its variable', () => {
    const o = parseSetupOptions(
      { docker: 'none' },
      {
        GUILDWISE_YES: '1',
        GUILDWISE_RUNNER_USER: 'current',
        GUILDWISE_DOCKER: 'narrow',
        GUILDWISE_SUDO: 'off',
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
      sudo: 'off',
      devopsOrgs: 'none',
      deploy: 'off',
      deployPinCommit: true,
      allowUnsignedFrom: ['http://localhost:4000'],
    });
  });

  it('refuses bad values', () => {
    expect(() => opts({ runnerUser: 'root' })).toThrow(SetupError);
    expect(() => opts({ allowUnsignedFrom: ['https://hq.example.com/path'] })).toThrow(/exact origin/);
    expect(() => opts({ approveApp: ['Shop=relative'] })).toThrow(/approve-app/);
    expect(() => opts({ sudoPasswordStdin: true })).toThrow(/goes with --sudo on/);
  });

  it('quotes printed root commands for a POSIX shell', () => {
    expect(adminCommand(['approve-app', 'x', '--source', "/h/it's here"])).toBe(
      `sudo ${ADMIN_TOOL} approve-app x --source '/h/it'\\''s here'`,
    );
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
      '--sudo',
      '--sudo-password-stdin',
      '--docker',
      '--approve-app',
      '--deploy',
      '--deploy-pin-commit',
      '--allow-unsigned-from',
    ])
      expect(flags).toContain(f);
  });
});
