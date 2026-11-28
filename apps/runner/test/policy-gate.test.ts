import type { DeployExecPayload } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { deployPinHashes, isStrippedDeployVar, stripDeployEnv } from '../src/policy/deploy-pin.ts';
import {
  gateCommand,
  gateDeploy,
  gateDevopsShift,
  gateEnvEnsure,
  gateReleaseSign,
  localEnvEnsure,
  narrowAccess,
  rememberVaultRemotes,
} from '../src/policy/gate.ts';
import { DEFAULT_POLICY, type Policy, PolicySchema } from '../src/policy/schema.ts';

const ORG = '0190a000-0000-7000-8000-000000000001';
const AGENT = '0190a000-0000-7000-8000-000000000002';
const set = (p: Partial<Policy>): Policy => PolicySchema.parse({ ...DEFAULT_POLICY, setupDone: true, ...p });

const deploy = (o: Partial<DeployExecPayload> = {}): DeployExecPayload => ({
  runId: '0190a000-0000-7000-8000-0000000000aa',
  orgId: ORG,
  projectId: '0190a000-0000-7000-8000-000000000003',
  projectKey: 'GWP',
  vault: { vaultId: 'v1', storage: 'local', folder: 'gwp' } as DeployExecPayload['vault'],
  vaultCommit: null,
  hash: 'a'.repeat(64),
  env: 'uat',
  target: {
    id: '0190a000-0000-7000-8000-000000000004',
    name: 'uat',
    kind: 'docker',
    host: 'devbox',
    appUrl: 'https://uat',
  },
  commit: 'c'.repeat(40),
  repo: {
    repoId: '0190a000-0000-7000-8000-000000000005',
    name: 'core',
    remoteUrlNormalized: 'github.com/x/core',
    workingBranch: 'development',
  },
  trial: false,
  dryRun: false,
  expiresAt: '2030-01-01T00:00:00.000Z',
  ...o,
});

describe('deploy pins cover the whole command [rv4-4]', () => {
  it('a redeploy of the same command (new run id, new expiry) has the same pin', () => {
    const a = deployPinHashes(deploy());
    const b = deployPinHashes(
      deploy({ runId: '0190a000-0000-7000-8000-0000000000bb', expiresAt: '2031-01-01T00:00:00.000Z' }),
    );
    expect(a).toEqual(b);
  });

  it('any change of script bundle, env, target, folder or kind changes the pin', () => {
    const base = deployPinHashes(deploy()).base;
    const changed = [
      deploy({ hash: 'b'.repeat(64) }), // script, env names and values, secret names: the recipe bundle
      deploy({ env: 'prod' }),
      deploy({ target: { ...deploy().target, host: 'other' } }),
      deploy({
        repo: {
          ...(deploy().repo as NonNullable<DeployExecPayload['repo']>),
          remoteUrlNormalized: 'github.com/evil/core',
        },
      }),
      deploy({
        repo: { ...(deploy().repo as NonNullable<DeployExecPayload['repo']>), workingBranch: 'evil' },
      }),
      deploy({ dryRun: true }),
      deploy({ trial: true }),
    ];
    for (const c of changed) expect(deployPinHashes(c).base).not.toBe(base);
  });

  it('the commit is in the bound hash only', () => {
    const a = deployPinHashes(deploy());
    const b = deployPinHashes(deploy({ commit: 'd'.repeat(40) }));
    expect(a.base).toBe(b.base);
    expect(a.bound).not.toBe(b.bound);
    expect(deployPinHashes(deploy({ commit: null })).bound).toBeNull();
  });
});

describe('the deploy gate', () => {
  it('holds an unpinned deploy, dry runs and trials too', () => {
    for (const p of [deploy(), deploy({ dryRun: true }), deploy({ trial: true })])
      expect(gateDeploy(set({}), p)).toMatchObject({ action: 'hold', kind: 'deploy.exec' });
  });

  it('a pinned redeploy runs only when the whole command is unchanged', () => {
    const pin = deployPinHashes(deploy()).base;
    const policy = set({ deployPins: [pin] });
    expect(gateDeploy(policy, deploy({ runId: '0190a000-0000-7000-8000-0000000000cc' }))).toEqual({
      action: 'run',
    });
    expect(gateDeploy(policy, deploy({ hash: 'e'.repeat(64) })).action).toBe('hold');
    expect(
      gateDeploy(policy, deploy({ target: { ...deploy().target, appUrl: 'https://evil' } })).action,
    ).toBe('hold');
  });

  it('with deployPinCommit a new commit is held as the passkey kind "deploy.commit_redeploy"', () => {
    const h = deployPinHashes(deploy());
    const policy = set({ deployPinCommit: true, deployPins: [h.base, h.bound as string] });
    expect(gateDeploy(policy, deploy())).toEqual({ action: 'run' });
    expect(gateDeploy(policy, deploy({ commit: 'f'.repeat(40) }))).toMatchObject({
      action: 'hold',
      kind: 'deploy.commit_redeploy',
    });
    // a deploy that is not pinned at all is a plain deploy.exec, never the passkey kind
    expect(gateDeploy(policy, deploy({ env: 'prod' }))).toMatchObject({ kind: 'deploy.exec' });
  });

  it('setup pending holds even a pinned deploy; deploy "off" refuses', () => {
    const pin = deployPinHashes(deploy()).base;
    expect(gateDeploy(set({ deployPins: [pin], setupDone: false }), deploy())).toMatchObject({
      action: 'hold',
      note: expect.stringMatching(/setup pending/),
    });
    expect(gateDeploy(set({ deploy: 'off' }), deploy())).toMatchObject({ action: 'refuse' });
  });

  it('shows the command as received: target, commit, recipe hash and pin hash', () => {
    const d = gateDeploy(set({}), deploy());
    expect(d.action === 'hold' && d.detail).toMatch(
      /devbox[\s\S]*cccccccccccc[\s\S]*recipe hash\s+a{64}[\s\S]*pin hash/,
    );
  });
});

describe('other held commands', () => {
  it('recipe writes, vault configuration with a new online location and reseals wait', () => {
    expect(
      gateCommand(set({}), 'vault.configure', {
        vaults: [{ vaultId: 'v', name: 'V', remoteUrl: 'https://git.example/v.git', syncIntervalSec: 60 }],
      }),
    ).toMatchObject({ action: 'hold', kind: 'vault.configure' });
    for (const [cmd, kind] of [
      ['recipe.write', 'recipe.write'],
      ['env.secret.set', 'env.secret'],
      ['deploy.secret.set', 'env.secret'],
      ['provider.key.reseal', 'provider.reseal'],
    ] as const)
      expect(gateCommand(set({}), cmd, { projectId: 'p', files: [], value: 'SECRET-VALUE' })).toMatchObject({
        action: 'hold',
        kind,
      });
  });

  it('every held summary names its target (vault.configure carries a vault list, not one id: UAT 1.10.0 bug 4)', () => {
    const sum = (cmd: string, payload: Record<string, unknown>) => {
      const d = gateCommand(set({}), cmd, payload);
      return d.action === 'hold' ? d.summary : '';
    };
    const vaults = [
      {
        vaultId: 'v1',
        kind: 'org_knowledge',
        name: 'Knowledge',
        remoteUrl: 'https://git.example/k.git',
        syncIntervalSec: 60,
      },
      { vaultId: 'v2', kind: 'project_design', name: 'Designs', remoteUrl: '', syncIntervalSec: 60 },
    ];
    expect(sum('vault.configure', { vaults, identity: { name: 'd', email: 'd@x' }, resume: [] })).toBe(
      'vault.configure for 2 vaults (Knowledge, Designs): new online location git.example/k',
    );
    const many = Array.from({ length: 7 }, (_, i) => ({ ...vaults[0], vaultId: `v${i}`, name: `N${i}` }));
    expect(sum('vault.configure', { vaults: many })).toMatch(
      /^vault\.configure for 7 vaults \(N0, N1, N2, N3, N4 and 2 more\): new online location /,
    );
    expect(sum('provider.key.reseal', { provider: 'anthropic', orgId: 'o-1', targetKeyId: 'k9' })).toBe(
      'provider.key.reseal for the anthropic key of organization o-1 to runner key k9',
    );
    expect(sum('provider.endpoints.set', { endpoints: ['http://10.0.0.5:11434'] })).toBe(
      'provider.endpoints.set for 1 private endpoint',
    );
    expect(
      sum('env.secret.set', { targetId: 't-1', name: 'DB_PASSWORD', keyId: 'k', ciphertext: 'CIPH' }),
    ).toBe('env.secret.set for secret DB_PASSWORD of environment target t-1');
    expect(sum('deploy.secret.set', { projectId: 'p-1', name: 'API', keyId: 'k', ciphertext: 'CIPH' })).toBe(
      'deploy.secret.set for secret API of project p-1',
    );
    for (const cmd of ['provider.key.reseal', 'provider.endpoints.set', 'env.secret.set'])
      expect(sum(cmd, {}), cmd).not.toMatch(/ for $| for {2}/);
  });

  it('never prints a secret value in the detail', () => {
    const d = gateCommand(set({}), 'env.secret.set', {
      name: 'DB_PASSWORD',
      sealed: 'CIPHERTEXT-XYZ',
      value: 'p4ss',
    });
    expect(d.action === 'hold' && d.detail).not.toMatch(/CIPHERTEXT-XYZ|p4ss/);
  });

  it('other commands run; a malformed deploy is refused, never run', () => {
    expect(gateCommand(set({}), 'repo.release_facts', {})).toEqual({ action: 'run' });
    expect(gateCommand(set({}), 'deploy.exec', { runId: 'x' })).toMatchObject({ action: 'refuse' });
  });

  it('env.ensure: Docker is narrowed to the local grant, sudo is always off; installs or extra paths wait', () => {
    const access = { allowInstall: false, allowDocker: true, allowedPaths: [], sudo: true };
    expect(narrowAccess(set({}), access)).toMatchObject({ sudo: false, allowDocker: false });
    // an old policy.json with devops.sudo still parses, and grants no sudo (removed in 1.10.0)
    expect(
      narrowAccess(PolicySchema.parse({ devops: { agents: {}, sudo: true }, allowDocker: true }), access),
    ).toMatchObject({
      sudo: false,
      allowDocker: true,
    });
    const payload = (a: object) => ({
      requestId: '0190a000-0000-7000-8000-000000000010',
      projectId: '0190a000-0000-7000-8000-000000000011',
      repos: [{ repoId: '0190a000-0000-7000-8000-000000000012', name: 'r', remoteUrlNormalized: 'x/r' }],
      access: { ...access, ...a },
    });
    expect(gateEnvEnsure(set({}), payload({}))).toEqual({ action: 'run' });
    expect(gateEnvEnsure(set({}), payload({ allowInstall: true }))).toMatchObject({ action: 'hold' });
    expect(gateEnvEnsure(set({}), payload({ allowedPaths: ['/etc'] }))).toMatchObject({ action: 'hold' });
    // what runs: the server's sudo is always dropped, and the prompt no longer mentions it
    expect(localEnvEnsure(set({}), payload({ allowInstall: true })).access).toMatchObject({
      sudo: false,
      allowDocker: false,
    });
    const held = gateEnvEnsure(set({}), payload({ allowInstall: true }));
    expect(held.action === 'hold' && held.detail).not.toMatch(/sudo/);
  });
});

describe('release.sign (R30)', () => {
  const p = {
    releaseId: '0190a000-0000-7000-8000-000000000020',
    targetId: '0190a000-0000-7000-8000-000000000021',
    targetName: 'uat',
    projectName: 'Guildwise',
    version: '1.10.0',
    keyId: '8399E5B65A3876B0',
    artefact: 'release/uat/manifest.json',
    repoId: '0190a000-0000-7000-8000-000000000022',
    artefactSha256: 'a'.repeat(64),
  };
  it('is refused for a key this workstation does not hold', () => {
    expect(gateReleaseSign(set({}), p)).toMatchObject({ action: 'refuse' });
  });
  it('is held until approve unless the key has autoSign (and setup is done)', () => {
    const key = { keyId: p.keyId, keyFile: '/k/test.key', autoSign: false };
    expect(gateReleaseSign(set({ signingKeys: [key] }), p)).toMatchObject({
      action: 'hold',
      kind: 'release.sign',
    });
    expect(gateReleaseSign(set({ signingKeys: [{ ...key, autoSign: true }] }), p)).toEqual({ action: 'run' });
    expect(
      gateReleaseSign(set({ signingKeys: [{ ...key, autoSign: true }], setupDone: false }), p).action,
    ).toBe('hold');
  });
});

describe('DevOps shifts [rv4-2]', () => {
  const s = { orgId: ORG, agentId: AGENT, shiftId: 's1' };
  it('an isDevops shift without a local grant is refused', () => {
    expect(gateDevopsShift(set({}), s)).toMatchObject({ action: 'refuse' });
    // a grant for another agent of the org is not a grant for this one
    expect(gateDevopsShift(set({ devops: { agents: { [ORG]: ORG } } }), s).action).toBe('refuse');
  });
  it('a granted agent is held until a local yes (ask, the default); auto runs, also for an old file with sudo', () => {
    const granted = { agents: { [ORG]: AGENT } };
    expect(gateDevopsShift(set({ devops: granted }), s)).toMatchObject({
      action: 'hold',
      kind: 'devops.task',
    });
    expect(gateDevopsShift(set({ devops: granted, devopsRequests: 'auto' }), s)).toEqual({ action: 'run' });
    expect(
      gateDevopsShift(
        PolicySchema.parse({ setupDone: true, devopsRequests: 'auto', devops: { ...granted, sudo: true } }),
        s,
      ).action,
    ).toBe('run');
  });
});

describe('deploy env stripping', () => {
  it('removes loader and interpreter variables and replaces PATH, whatever their source', () => {
    const env = stripDeployEnv(
      {
        NODE_OPTIONS: '--require /tmp/x.js',
        LD_PRELOAD: '/tmp/x.so',
        BASH_ENV: '/tmp/x.sh',
        DYLD_INSERT_LIBRARIES: 'x',
        GIT_CONFIG_COUNT: '1',
        GIT_SSH_COMMAND: 'evil',
        PYTHONPATH: '/x',
        PATH: '/evil/bin',
        DATABASE_URL: 'keep',
      },
      '/usr/bin:/bin',
    );
    expect(env).toEqual({ DATABASE_URL: 'keep', PATH: '/usr/bin:/bin' });
    expect(isStrippedDeployVar('_JAVA_OPTIONS')).toBe(true);
    expect(isStrippedDeployVar('APP_NAME')).toBe(false);
  });
});

describe('release.prepare prompt (R30, review round 2)', () => {
  const p = {
    releaseId: '0190a000-0000-7000-8000-000000000020',
    targetId: '0190a000-0000-7000-8000-000000000021',
    targetName: 'uat',
    projectName: 'Guildwise',
    version: '1.10.0',
    repoId: '0190a000-0000-7000-8000-000000000022',
    commit: 'c'.repeat(40),
    keyId: '8399E5B65A3876B0',
    publicKey: `RW${'A'.repeat(54)}`,
    artefact: 'release/uat/manifest.json',
  };
  it('always waits, names the repository, the commit and that its package script runs outside the sandbox', () => {
    const d = gateCommand(set({}), 'release.prepare', p, { remoteOf: () => 'github.com/acme/core' });
    expect(d).toMatchObject({ action: 'hold', kind: 'release.prepare' });
    if (d.action !== 'hold') return;
    expect(d.summary).toMatch(
      /package Guildwise 1\.10\.0 for uat: runs github\.com\/acme\/core scripts\/package-runner\.sh outside the sandbox/,
    );
    expect(d.detail).toMatch(/repository\s+github\.com\/acme\/core/);
    expect(d.detail).toMatch(/commit\s+c{40}/);
    expect(d.detail).toMatch(
      /scripts\/package-runner\.sh of commit c{40} of github\.com\/acme\/core on this workstation, outside the sandbox/,
    );
  });
  it('says when the repository is unknown here', () => {
    const d = gateCommand(set({}), 'release.prepare', p);
    expect(d.action === 'hold' && d.detail).toMatch(/no known clone on this workstation/);
  });
});

describe('DevOps task prompt shows the grant (round-1 should-fix 4)', () => {
  it('lists the shift kind and the access as it applies here', () => {
    const d = gateDevopsShift(set({ devops: { agents: { [ORG]: AGENT } } }), {
      orgId: ORG,
      agentId: AGENT,
      shiftId: 's1',
      kind: 'devops',
      access: { allowInstall: true, allowDocker: true, allowedPaths: ['/srv/app'], sudo: true },
    });
    expect(d.action === 'hold' && d.detail).toMatch(/kind\s+devops/);
    expect(d.action === 'hold' && d.detail).not.toMatch(/sudo/);
    expect(d.action === 'hold' && d.detail).toMatch(/docker\s+asked, NOT allowed here/);
    expect(d.action === 'hold' && d.detail).toMatch(/installs\s+yes/);
    expect(d.action === 'hold' && d.detail).toMatch(/paths\s+\/srv\/app/);
  });
});

describe('vault.configure narrowed (easy-runner-setup, Overnight decision 4)', () => {
  const vault = (id: string, remoteUrl: string, storage?: 'local') => ({
    vaultId: id,
    kind: 'org_knowledge',
    name: id,
    remoteUrl,
    syncIntervalSec: 60,
    ...(storage ? { storage } : {}),
  });
  it('runs for local vaults and for remotes approved before', () => {
    expect(gateCommand(set({}), 'vault.configure', { vaults: [vault('l', '', 'local')] }).action).toBe('run');
    expect(gateCommand(set({}), 'vault.configure', { vaults: [] }).action).toBe('run');
    const known = set({ vaultRemotes: [{ vaultId: 'g', remote: 'git.example/acme/vault' }] });
    expect(
      gateCommand(known, 'vault.configure', {
        vaults: [vault('g', 'git@git.example:acme/vault.git'), vault('l', '', 'local')],
      }).action,
    ).toBe('run');
  });

  it('holds for a new remote and for a changed remote of a known vault', () => {
    const known = set({ vaultRemotes: [{ vaultId: 'g', remote: 'git.example/acme/vault' }] });
    expect(
      gateCommand(known, 'vault.configure', { vaults: [vault('g', 'https://evil.example/x.git')] }).action,
    ).toBe('hold');
    expect(
      gateCommand(known, 'vault.configure', { vaults: [vault('h', 'https://git.example/acme/vault.git')] })
        .action,
    ).toBe('hold');
  });

  it('a remote with a password is shown with *** in the held detail, never the password', () => {
    const d = gateCommand(set({}), 'vault.configure', {
      vaults: [vault('g', 'https://bot:s3cret@git.example/v.git')],
    });
    expect(d.action === 'hold' && d.detail).not.toContain('s3cret');
    expect(d.action === 'hold' && d.summary).not.toContain('s3cret');
  });

  it('approving records the pairs shown, so the same set-up then runs', () => {
    const payload = { vaults: [vault('g', 'https://git.example/acme/vault.git')] };
    const p = rememberVaultRemotes(set({}), payload);
    expect(p.vaultRemotes).toEqual([{ vaultId: 'g', remote: 'git.example/acme/vault' }]);
    expect(rememberVaultRemotes(p, payload).vaultRemotes).toHaveLength(1);
    expect(gateCommand(p, 'vault.configure', payload).action).toBe('run');
  });
});

describe('gate-fixes-1 F3: narrowAccess per Docker route', () => {
  const access = (allowDocker: boolean) => ({
    allowInstall: false,
    allowDocker,
    allowedPaths: [],
    sudo: false,
  });
  it('proxy (a request shift): the server switch AND ceiling.docker; direct also needs the legacy local key', () => {
    for (const server of [false, true])
      for (const ceiling of [false, true])
        for (const legacy of [false, true]) {
          const p = set({
            allowDocker: legacy,
            ceiling: { docker: ceiling, mountRoots: [], containerEgress: false },
          });
          const name = `server=${server} ceiling=${ceiling} legacy=${legacy}`;
          expect(narrowAccess(p, access(server), undefined, 'proxy').allowDocker, name).toBe(
            server && ceiling,
          );
          expect(narrowAccess(p, access(server), undefined, 'direct').allowDocker, name).toBe(
            server && ceiling && legacy,
          );
          // the default stays direct (chat, release prep, the unboxed fallback)
          expect(narrowAccess(p, access(server)).allowDocker, name).toBe(server && ceiling && legacy);
        }
  });

  it('at the defaults (ceiling yes, legacy key unset) a request shift with the server switch on gets Docker', () => {
    const p = set({});
    expect(p.ceiling.docker).toBe(true);
    expect(p.allowDocker).toBe(false);
    expect(narrowAccess(p, access(true), undefined, 'proxy').allowDocker).toBe(true);
    // narrowing again can only lower it
    const once = narrowAccess(p, access(true), undefined, 'proxy');
    expect(narrowAccess(p, once, undefined, 'direct').allowDocker).toBe(false);
  });

  it("the held item of a request shift says Docker comes through the runner's gatekeeper", () => {
    const d = gateDevopsShift(set({ devops: { agents: { [ORG]: AGENT } } }), {
      orgId: ORG,
      agentId: AGENT,
      shiftId: 's1',
      kind: 'devops',
      docker: 'proxy',
      access: access(true),
    });
    expect(d.action === 'hold' && d.detail).toMatch(/docker\s+yes, through the runner's Docker gatekeeper/);
  });
});
