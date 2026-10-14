import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeRemoteUrl, type RepoClonePayload } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { forgePrCreator, gitAuthFor, gitConnections, MemoryTokenStore } from '../src/forge/index.ts';
import {
  checkSsh,
  classifySshOutput,
  defaultMethodFor,
  runSshAction,
  type SshEnv,
  SshSettingsStore,
  sshGitAuth,
  sshInfo,
} from '../src/forge/ssh.ts';
import type { ForgeEnv } from '../src/forge/types.ts';
import { executeCompletion } from '../src/git/completion.ts';
import { scanRepos } from '../src/git/repo-scan.ts';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { RepoAccessUpdater } from '../src/repo/access.ts';
import { RepoCloner } from '../src/repo/clone.ts';
import { type ExecOptions, type ExecResult, type Executor, realExecutor } from '../src/toolchain/exec.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

/** Scripted commands; unmatched ones fail like a missing binary. */
class FakeExec implements Executor {
  calls: Array<{ line: string; env?: Record<string, string> | undefined }> = [];
  constructor(private readonly rules: Array<[RegExp, Partial<ExecResult>]> = []) {}
  async run(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
    const line = [cmd, ...args].join(' ');
    this.calls.push({ line, env: opts?.env });
    for (const [re, r] of this.rules) if (re.test(line)) return { exitCode: 0, stdout: '', stderr: '', ...r };
    return { exitCode: 127, stdout: '', stderr: 'not found' };
  }
}

function sshEnv(over: Partial<SshEnv> = {}): SshEnv & { dir: string } {
  const dir = tmp('aom-ssh-');
  return {
    dir,
    settings: new SshSettingsStore(join(dir, 'secrets', 'git-ssh.json')),
    knownHosts: join(dir, 'secrets', 'known_hosts'),
    home: join(dir, 'home'),
    ...over,
  };
}

const forgeEnv = (ssh: SshEnv | undefined, exec: Executor = realExecutor): ForgeEnv => ({
  exec,
  fetch: globalThis.fetch,
  tokens: new MemoryTokenStore(),
  ...(ssh ? { ssh } : {}),
});

describe('the env git gets for an ssh remote', () => {
  it('pins the key, IdentitiesOnly and the runner known_hosts', () => {
    const ssh = sshEnv();
    const key = join(ssh.dir, 'mykey');
    writeFileSync(key, 'PRIVATE');
    ssh.settings.set('github.com', { provider: 'github', default: 'ssh', key: 'path', keyPath: key });
    const a = sshGitAuth(ssh, 'git@github.com:acme/web.git');
    const cmd = a?.env.GIT_SSH_COMMAND ?? '';
    expect(cmd).toContain(`-i '${key}'`);
    expect(cmd).toContain('-o IdentitiesOnly=yes');
    expect(cmd).toContain('-o StrictHostKeyChecking=accept-new');
    expect(cmd).toContain(`-o UserKnownHostsFile='${ssh.knownHosts}'`);
    expect(a?.args).toEqual([]);
    // The private key content is never part of it.
    expect(cmd).not.toContain('PRIVATE');
  });

  it('is nothing for https remotes and for a runner without ssh settings', () => {
    const ssh = sshEnv();
    expect(sshGitAuth(ssh, 'https://github.com/acme/web.git')).toBeNull();
    expect(sshGitAuth(undefined, 'git@github.com:acme/web.git')).toBeNull();
  });

  it('uses the ssh-agent (no -i) when asked to, and the generated key when it exists', () => {
    const ssh = sshEnv();
    ssh.settings.set('gitlab.com', { provider: 'gitlab', default: 'ssh', key: 'agent' });
    expect(sshGitAuth(ssh, 'git@gitlab.com:g/r.git')?.env.GIT_SSH_COMMAND).not.toContain(' -i ');

    // Nothing configured for bitbucket: the generated key is used once it exists.
    expect(sshGitAuth(ssh, 'git@bitbucket.org:ws/r.git')?.env.GIT_SSH_COMMAND).not.toContain(' -i ');
    mkdirSync(join(ssh.home as string, '.ssh'), { recursive: true });
    const gen = join(ssh.home as string, '.ssh', 'aom_bitbucket_cloud');
    writeFileSync(gen, 'x');
    expect(sshGitAuth(ssh, 'git@bitbucket.org:ws/r.git')?.env.GIT_SSH_COMMAND).toContain(`-i '${gen}'`);
  });

  it('gitAuthFor gives ssh remotes the key and never a token helper', async () => {
    const ssh = sshEnv();
    const a = await gitAuthFor(forgeEnv(ssh), 'git@github.com:acme/web.git');
    expect(a.env.GIT_SSH_COMMAND).toContain('ssh');
    expect(a.args).toEqual([]);
  });

  it('the Azure DevOps ssh url maps to the dev.azure.com settings', () => {
    const ssh = sshEnv();
    const key = join(ssh.dir, 'az');
    writeFileSync(key, 'k');
    ssh.settings.set('dev.azure.com', {
      provider: 'azure-devops',
      default: 'ssh',
      key: 'path',
      keyPath: key,
    });
    expect(sshGitAuth(ssh, 'git@ssh.dev.azure.com:v3/org/proj/repo')?.env.GIT_SSH_COMMAND).toContain(
      `-i '${key}'`,
    );
  });
});

describe('the ssh check', () => {
  it.each([
    [1, "Hi octo! You've successfully authenticated, but GitHub does not provide shell access.", 'ok'],
    [0, 'Welcome to GitLab, @octo!', 'ok'],
    [255, 'git@github.com: Permission denied (publickey).', 'not_authorized'],
    [255, 'ssh: Could not resolve hostname github.com: Name or service not known', 'unreachable'],
    [255, 'ssh: connect to host github.com port 22: Connection timed out', 'unreachable'],
    [255, 'Host key verification failed.', 'host_key'],
    [255, '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@', 'host_key'],
    [127, 'not found', 'tool_missing'],
    [255, 'something odd', 'unknown'],
  ])('exit %s %s -> %s', (code, text, state) => {
    expect(classifySshOutput(code, text, 'github.com').state).toBe(state);
  });

  it('reports a missing key file before touching the network', async () => {
    const ssh = sshEnv();
    ssh.settings.set('github.com', {
      provider: 'github',
      default: 'ssh',
      key: 'path',
      keyPath: join(ssh.dir, 'nope'),
    });
    const x = new FakeExec();
    const r = await checkSsh(x, ssh, { provider: 'github', host: 'github.com' });
    expect(r.state).toBe('no_key');
    expect(x.calls).toHaveLength(0);
  });

  it('runs ssh -T with the pinned options, and git ls-remote with GIT_SSH_COMMAND for a repository', async () => {
    const ssh = sshEnv();
    const key = join(ssh.dir, 'k');
    writeFileSync(key, 'k');
    ssh.settings.set('dev.azure.com', {
      provider: 'azure-devops',
      default: 'ssh',
      key: 'path',
      keyPath: key,
    });
    const x = new FakeExec([
      [/^ssh -T/, { exitCode: 255, stderr: 'git@ssh.dev.azure.com: Permission denied (publickey).' }],
      [/^git ls-remote/, { exitCode: 0 }],
    ]);
    const t = await checkSsh(x, ssh, { provider: 'azure-devops', host: 'dev.azure.com' });
    expect(t.state).toBe('not_authorized');
    expect(x.calls[0]?.line).toContain(`-T -i ${key} -o IdentitiesOnly=yes`);
    expect(x.calls[0]?.line).toContain('git@ssh.dev.azure.com');

    const r = await checkSsh(x, ssh, {
      provider: 'azure-devops',
      host: 'dev.azure.com',
      repoUrl: 'https://dev.azure.com/org/proj/_git/repo',
    });
    expect(r.state).toBe('ok');
    const last = x.calls[x.calls.length - 1];
    expect(last?.line).toContain('git@ssh.dev.azure.com:v3/org/proj/repo');
    expect(last?.env?.GIT_SSH_COMMAND).toContain('IdentitiesOnly=yes');
  });
});

describe('preparing a key and the report', () => {
  it('generates the key once, reports only the public key, and records the default', async () => {
    const ssh = sshEnv();
    const a = await runSshAction(realExecutor, ssh, {
      provider: 'bitbucket-cloud',
      host: 'bitbucket.org',
      action: 'prepare',
      key: 'generated',
      defaultMethod: 'ssh',
    });
    expect(a.state).toBe('prepared');
    expect(a.keyPath).toBe(join(ssh.home as string, '.ssh', 'aom_bitbucket_cloud'));
    expect(a.publicKey).toMatch(/^ssh-ed25519 /);
    expect(existsSync(a.keyPath as string)).toBe(true);

    const again = await runSshAction(realExecutor, ssh, {
      provider: 'bitbucket-cloud',
      host: 'bitbucket.org',
      action: 'prepare',
    });
    expect(again.detail).toContain('Using the existing');
    expect(again.publicKey).toBe(a.publicKey);

    const info = sshInfo(ssh, 'bitbucket-cloud', 'bitbucket.org');
    expect(info).toMatchObject({ defaultMethod: 'ssh', key: 'generated', publicKey: a.publicKey });
    expect(JSON.stringify(info)).not.toContain('PRIVATE KEY');
    expect(defaultMethodFor(ssh, 'bitbucket.org')).toBe('ssh');
    expect(defaultMethodFor(ssh, 'github.com')).toBe('https');
  });

  it('refuses a key path that does not exist', async () => {
    const ssh = sshEnv();
    await expect(
      runSshAction(new FakeExec(), ssh, {
        provider: 'github',
        host: 'github.com',
        action: 'save',
        key: 'path',
        keyPath: join(ssh.dir, 'missing'),
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it('a check stores its state; the connection report carries it without any secret', async () => {
    const ssh = sshEnv();
    const key = join(ssh.dir, 'k');
    writeFileSync(key, 'PRIVATE');
    writeFileSync(`${key}.pub`, 'ssh-ed25519 AAAA test');
    const x = new FakeExec([
      [/^ssh -T/, { exitCode: 1, stderr: "Hi octo! You've successfully authenticated" }],
    ]);
    await runSshAction(x, ssh, {
      provider: 'github',
      host: 'github.com',
      action: 'save',
      key: 'path',
      keyPath: key,
      defaultMethod: 'ssh',
    });
    const r = await runSshAction(x, ssh, { provider: 'github', host: 'github.com', action: 'check' });
    expect(r.state).toBe('ok');
    const list = await gitConnections(forgeEnv(ssh, x));
    const gh = list.find((c) => c.provider === 'github');
    expect(gh?.ssh).toMatchObject({
      defaultMethod: 'ssh',
      key: 'path',
      keyPath: key,
      publicKey: 'ssh-ed25519 AAAA test',
      check: { state: 'ok' },
    });
    expect(JSON.stringify(list)).not.toContain('PRIVATE');
  });
});

/**
 * A fake `ssh` that serves bare repositories under a root, so git really talks "ssh" end to end without a network.
 * It logs its arguments. `git@example.test:acme/web.git` is `<root>/acme/web.git`.
 */
function fakeSsh(root: string, log: string): string {
  const bin = join(tmp('aom-fakessh-'), 'ssh');
  writeFileSync(
    bin,
    `#!/bin/sh\necho "$@" >> '${log}'\nfor last; do :; done\ncd '${root}' && exec sh -c "$last"\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe('git over ssh end to end (fake ssh program)', () => {
  const payload = (remoteUrl: string, over: Partial<RepoClonePayload> = {}): RepoClonePayload => ({
    requestId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
    repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a2',
    projectId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a3',
    projectKey: 'TOY',
    projectName: 'Toy',
    name: 'web',
    remoteUrl,
    ...over,
  });

  function world() {
    const origin = makeRepo();
    const serveRoot = tmp('aom-serve-');
    mkdirSync(join(serveRoot, 'acme'));
    symlinkSync(origin.origin, join(serveRoot, 'acme', 'web.git'));
    const log = join(tmp('aom-sshlog-'), 'log');
    writeFileSync(log, '');
    const key = join(tmp('aom-key-'), 'id');
    writeFileSync(key, 'PRIVATE');
    const ssh = sshEnv({ sshBin: fakeSsh(serveRoot, log) });
    ssh.settings.set('example.test', { default: 'https', key: 'path', keyPath: key });
    const root = tmp('aom-clone-root-');
    const env = forgeEnv(ssh);
    const cloner = new RepoCloner({
      repoRoots: () => [root],
      exec: realExecutor,
      findExisting: async (n) => (await scanRepos([root])).find((r) => normalizeRemoteUrl(r.remoteUrl) === n),
      creator: { run: async () => ({ ok: false, error: 'no' }) },
      forge: () => env,
    });
    return { origin, root, log, key, ssh, env, cloner };
  }

  it('clones an https repository over ssh when the repository says ssh, and pins the key in the clone', async () => {
    const w = world();
    const r = await w.cloner.run(payload('https://example.test/acme/web.git', { accessMethod: 'ssh' }));
    expect(r).toMatchObject({ ok: true, state: 'cloned' });
    const dir = r.localPath as string;
    expect(sh(dir, 'git', ['remote', 'get-url', 'origin'])).toBe('git@example.test:acme/web.git');
    expect(sh(dir, 'git', ['config', 'core.sshCommand'])).toContain(`-i '${w.key}'`);
    const log = readFileSync(w.log, 'utf8');
    expect(log).toContain(`-i ${w.key} -o IdentitiesOnly=yes`);
    expect(log).toContain('StrictHostKeyChecking=accept-new');
    expect(log).toContain(`UserKnownHostsFile=${w.ssh.knownHosts}`);
    expect(log).toContain('git@example.test');
  });

  it('follows the workstation default when the repository has no choice, and https stays https otherwise', async () => {
    const w = world();
    w.ssh.settings.set('example.test', { default: 'ssh', key: 'path', keyPath: w.key });
    const r = await w.cloner.run(payload('https://example.test/acme/web.git'));
    expect(r.ok).toBe(true);
    expect(sh(r.localPath as string, 'git', ['remote', 'get-url', 'origin'])).toBe(
      'git@example.test:acme/web.git',
    );
  });

  it('a repository that says https is cloned over https even when the workstation default is ssh', async () => {
    const w = world();
    w.ssh.settings.set('example.test', { default: 'ssh', key: 'path', keyPath: w.key });
    // https to a host that does not exist here: the clone fails, which proves ssh was not used.
    const r = await w.cloner.run(payload('https://example.test/acme/web.git', { accessMethod: 'https' }));
    expect(r.ok).toBe(false);
    expect(readFileSync(w.log, 'utf8')).toBe('');
  });

  it('explains when the ssh address cannot be derived (Bitbucket Data Center)', async () => {
    const w = world();
    const r = await w.cloner.run(
      payload('https://bitbucket.corp.example/scm/PROJ/repo.git', { accessMethod: 'ssh' }),
    );
    expect(r).toMatchObject({ ok: false, state: 'needs_manager' });
    expect(r.error).toContain('ssh address');
  });

  it('the completion pushes over ssh with the key, from a worktree of the clone', async () => {
    const w = world();
    const r = await w.cloner.run(payload('https://example.test/acme/web.git', { accessMethod: 'ssh' }));
    const repoPath = r.localPath as string;
    const wtPath = join(tmp(), 'wt');
    const branch = 'aom/toy-1-add-thing';
    await ensureWorktree({
      repoPath,
      roots: ['/'],
      spec: {
        mode: 'create',
        repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
        remoteUrlNormalized: normalizeRemoteUrl('git@example.test:acme/web.git'),
        baseBranch: 'main',
        branchName: branch,
      },
      defaultPath: wtPath,
    });
    writeFileSync(join(wtPath, 'thing.txt'), 'thing\n');
    sh(wtPath, 'git', ['add', '-A']);
    sh(wtPath, 'git', ['commit', '-m', 'add thing']);
    writeFileSync(w.log, '');
    const res = await executeCompletion({
      payload: {
        cardId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c1',
        ref: 'TOY-1',
        title: 'Add thing',
        projectKey: 'TOY',
        action: 'pr',
        repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
        remoteUrlNormalized: normalizeRemoteUrl('git@example.test:acme/web.git'),
        baseBranch: 'main',
        branchName: branch,
        worktreePath: wtPath,
        prTitle: 't',
        prBody: 'b',
      },
      repoPath,
      worktreePath: wtPath,
      worktreesDir: '/',
      integrationDir: join(tmp(), 'integration'),
      pr: { create: async () => ({ unavailable: 'unused' }) },
      auth: (url, forge) => gitAuthFor(w.env, url, forge),
    });
    expect(res).toMatchObject({ ok: true, action: 'pr', pushedBranch: branch });
    expect(sh(w.origin.origin, 'git', ['rev-parse', '--verify', `refs/heads/${branch}`])).toMatch(
      /^[0-9a-f]{40}$/,
    );
    const log = readFileSync(w.log, 'utf8');
    expect(log).toContain('git-receive-pack');
    expect(log).toContain(`-i ${w.key} -o IdentitiesOnly=yes`);
  });
});

describe('changing the access method of an existing clone', () => {
  function cloneWithHttpsOrigin() {
    const r = makeRepo();
    sh(r.clone, 'git', ['remote', 'set-url', 'origin', 'https://github.com/acme/web.git']);
    const ssh = sshEnv();
    const key = join(ssh.dir, 'k');
    writeFileSync(key, 'k');
    ssh.settings.set('github.com', { provider: 'github', default: 'https', key: 'path', keyPath: key });
    // git is real, only the network probe is scripted
    const exec: Executor = {
      run: (cmd, args, opts) =>
        args.includes('ls-remote')
          ? Promise.resolve({ exitCode: 128, stdout: '', stderr: 'fatal: could not read from remote' })
          : realExecutor.run(cmd, args, opts),
    };
    const updater = new RepoAccessUpdater({
      exec,
      forge: () => forgeEnv(ssh, exec),
      findExisting: async () => ({ localPath: r.clone }),
    });
    return { r, ssh, key, updater };
  }
  const base = {
    repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a2',
    remoteUrl: 'https://github.com/acme/web.git',
  };

  it('https to ssh updates origin and pins the key; the way back removes it again', async () => {
    const { r, key, updater } = cloneWithHttpsOrigin();
    const toSsh = await updater.run({ ...base, accessMethod: 'ssh' });
    expect(toSsh).toMatchObject({ ok: true, state: 'updated', originUrl: 'git@github.com:acme/web.git' });
    expect(sh(r.clone, 'git', ['remote', 'get-url', 'origin'])).toBe('git@github.com:acme/web.git');
    expect(sh(r.clone, 'git', ['config', 'core.sshCommand'])).toContain(`-i '${key}'`);

    const again = await updater.run({ ...base, accessMethod: 'ssh' });
    expect(again).toMatchObject({ ok: true, state: 'unchanged' });

    const back = await updater.run({ ...base, accessMethod: 'https' });
    expect(back).toMatchObject({ ok: true, state: 'updated', originUrl: 'https://github.com/acme/web.git' });
    expect(sh(r.clone, 'git', ['remote', 'get-url', 'origin'])).toBe('https://github.com/acme/web.git');
    expect(() => sh(r.clone, 'git', ['config', 'core.sshCommand'])).toThrow();
  });

  it('without an owner choice the workstation default decides', async () => {
    const { r, ssh, key, updater } = cloneWithHttpsOrigin();
    ssh.settings.set('github.com', { provider: 'github', default: 'ssh', key: 'path', keyPath: key });
    const res = await updater.run(base);
    expect(res.state).toBe('updated');
    expect(sh(r.clone, 'git', ['remote', 'get-url', 'origin'])).toBe('git@github.com:acme/web.git');
  });

  it('reports a failed reachability check without undoing the change', async () => {
    const { updater } = cloneWithHttpsOrigin();
    const res = await updater.run({ ...base, accessMethod: 'ssh' });
    expect(res.reachable).toBe(false);
    expect(res.detail).toContain('the check failed');
  });

  it('a workstation without the clone answers no_clone', async () => {
    const updater = new RepoAccessUpdater({
      exec: realExecutor,
      forge: () => forgeEnv(undefined),
      findExisting: async () => undefined,
    });
    expect(await updater.run({ ...base, accessMethod: 'ssh' })).toMatchObject({
      ok: true,
      state: 'no_clone',
    });
  });
});

describe('SSH only: no token, no CLI', () => {
  it('the pull request is not opened and the notice says why; the branch is still pushed by the completion', async () => {
    const r = makeRepo();
    sh(r.clone, 'git', ['remote', 'set-url', 'origin', 'git@github.com:acme/web.git']);
    // no gh on this machine, no token: the REST features are unavailable
    const res = await forgePrCreator(forgeEnv(sshEnv(), new FakeExec())).create({
      cwd: r.clone,
      base: 'main',
      branch: 'b',
      title: 't',
      body: 'b',
    });
    expect(res).toHaveProperty('unavailable');
    expect((res as { unavailable: string }).unavailable).toContain('uses SSH');
  });
});
