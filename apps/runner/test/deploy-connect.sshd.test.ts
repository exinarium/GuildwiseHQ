import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sealLarge } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeployConnector } from '../src/delivery/connect.ts';
import { DeployKeys } from '../src/delivery/deploy-keys.ts';
import { DeployPreparer } from '../src/delivery/prepare.ts';
import { runDeployProbe } from '../src/delivery/probe.ts';
import type { Logger } from '../src/log.ts';
import { RunnerKeys } from '../src/secrets/keys.ts';
import { DEPLOY_PASSWORD, ROOT_PASSWORD, type Sshd, sshdAvailable, startSshd } from './helpers/sshd.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

/**
 * Guided connect against a REAL sshd (a throwaway container acting as the VPS): host key fingerprints, a password used once to
 * append a dedicated key, a key file the host gave, a pasted key, an existing sign-in, revoking one key, the connection test,
 * and `AOM_DEPLOY_SSH`. Everything runs with a temporary HOME: the person's real ~/.ssh is never read or written (and the test
 * checks that nothing in it changed). Skipped when Docker is not usable.
 */
const can = sshdAvailable();
const T = '7f0e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const T2 = '11111111-2222-4333-8444-555555555555';
const P = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

let sshd: Sshd;
const realSsh = join(homedir(), '.ssh');
const snapshot = () =>
  existsSync(realSsh)
    ? readdirSync(realSsh)
        .sort()
        .map((f) => `${f}:${statSync(join(realSsh, f)).mtimeMs}:${statSync(join(realSsh, f)).size}`)
    : [];
let realBefore: string[] = [];

beforeAll(() => {
  if (!can) return;
  realBefore = snapshot();
  try {
    sshd = startSshd();
  } catch (err) {
    // no network for the image build, or Docker refused: the tests below skip themselves
    console.warn(`sshd test container not available: ${String(err).slice(0, 200)}`);
  }
}, 180_000);

const ti = (name: string, fn: () => Promise<void>, timeout?: number) =>
  it(
    name,
    async (ctx) => {
      if (!sshd) return ctx.skip();
      await fn();
    },
    timeout,
  );
afterAll(() => {
  sshd?.stop();
  // the person's real ssh folder was not touched by any of this
  if (can) expect(snapshot()).toEqual(realBefore);
});

class Spy implements Logger {
  lines: string[] = [];
  debug = (m: string) => void this.lines.push(m);
  info = (m: string) => void this.lines.push(m);
  warn = (m: string) => void this.lines.push(m);
  error = (m: string) => void this.lines.push(m);
}

function rig(name = 'Office PC') {
  const root = tmp('aom-conn-');
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  // Nothing here may reach a real server: no agent, and every ssh call that would read the person's config reads a file of ours.
  const env = { ...process.env, HOME: home, SSH_AUTH_SOCK: '' };
  const userConfig = join(home, '.ssh', 'config');
  const keys = new DeployKeys({ dir: join(root, 'keys', 'deploy'), home, userConfig, env });
  const runner = new RunnerKeys(join(root, 'secrets', 'runner-key.pem'));
  const log = new Spy();
  const c = new DeployConnector({
    keys,
    decrypt: (x) => runner.decryptAny(x),
    keyId: () => runner.publicKey.keyId,
    env,
    home,
    tmp: join(root, 'tmp'),
    userSshConfig: userConfig,
    connectSec: 5,
    commandMs: 20_000,
    log,
  });
  const seal = (obj: unknown) => sealLarge(runner.publicKey.publicKey, JSON.stringify(obj));
  return { root, home, env, keys, c, log, seal, runner, name };
}

const base = (extra: Record<string, unknown> = {}) => ({
  projectId: P,
  targetId: T,
  alias: 'aom-shop',
  address: '127.0.0.1',
  user: 'deploy',
  port: sshd?.port ?? 22,
  label: 'Office PC',
  ...extra,
});

describe.skipIf(!can)('guided connect against a real sshd', () => {
  ti('shows the fingerprint the server really has; trusts nothing and writes nothing', async () => {
    const r = rig();
    const out = await r.c.hostKeyScan({ projectId: P, address: '127.0.0.1', port: sshd.port });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.keys.find((k) => k.type === 'ssh-ed25519')?.fingerprint).toBe(sshd.hostFingerprint());
    expect(readdirSync(r.root)).not.toContain('keys');
    expect(await r.c.hostKeyScan({ projectId: P, address: '127.0.0.1', port: 1 })).toMatchObject({
      ok: false,
      error: 'unreachable',
    });
  });

  ti(
    'a password is used once to append the dedicated key: existing keys stay, a dated copy is made, a second run adds nothing, the password is nowhere',
    async () => {
      const r = rig();
      // the server has a key of its own owner already (without a trailing newline) and the hosting company's key
      sshd.sh(
        `mkdir -p /home/deploy/.ssh && printf 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOwnerKeyOwnerKeyOwnerKeyOwnerKeyOwnerKey owner@laptop' > /home/deploy/.ssh/authorized_keys && chown -R deploy:deploy /home/deploy/.ssh && chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys`,
      );
      const fp = sshd.hostFingerprint();
      const sealed = await r.seal({ password: DEPLOY_PASSWORD });
      const out = await r.c.connect({
        ...base(),
        method: 'password',
        hostKeyFingerprint: fp,
        keyId: r.runner.publicKey.keyId,
        ciphertext: sealed,
      } as never);
      expect(out, JSON.stringify(out)).toMatchObject({ ok: true, installed: 'added' });
      if (!out.ok) return;
      expect(out.backup).toMatch(/authorized_keys\.guildwise-bak-/);
      const ak = sshd.sh('cat /home/deploy/.ssh/authorized_keys');
      expect(ak).toContain('owner@laptop');
      expect(ak).toContain(out.publicKey.split(' ').slice(0, 2).join(' '));
      expect(ak.split('\n').filter(Boolean)).toHaveLength(2);
      expect(ak).toContain('guildwise-deploy:');
      expect(sshd.sh('ls /home/deploy/.ssh')).toContain('authorized_keys.guildwise-bak-');
      expect(sshd.sh('stat -c %a /home/deploy/.ssh/authorized_keys').trim()).toBe('600');
      // the private key stays here (0600); the config is ours, not ~/.ssh/config
      const dir = join(r.root, 'keys', 'deploy', T);
      expect(statSync(join(dir, 'id_ed25519')).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(dir, 'ssh_config'), 'utf8')).toContain('IdentitiesOnly yes');
      expect(existsSync(join(r.home, '.ssh'))).toBe(false);
      // the deploy scripts get this through AOM_DEPLOY_SSH and it really signs in
      const dep = r.keys.deploySsh(T, 'aom-shop');
      expect(dep).toBe(`ssh -F ${join(dir, 'ssh_config')}`);
      const cfg = join(dir, 'ssh_config');
      expect(
        spawnSync('ssh', ['-F', cfg, '-o', 'BatchMode=yes', '--', 'aom-shop', 'echo', 'hello'], {
          encoding: 'utf8',
          env: r.env,
        }).stdout.trim(),
      ).toBe('hello');
      // again: nothing is appended
      const again = await r.c.connect({
        ...base(),
        method: 'password',
        hostKeyFingerprint: fp,
        keyId: r.runner.publicKey.keyId,
        ciphertext: await r.seal({ password: DEPLOY_PASSWORD }),
      } as never);
      expect(again).toMatchObject({ ok: true, installed: 'already' });
      expect(sshd.sh('cat /home/deploy/.ssh/authorized_keys').split('\n').filter(Boolean)).toHaveLength(2);
      // never stored, never logged, never in the answer
      const everything = [
        JSON.stringify(out),
        JSON.stringify(again),
        r.log.lines.join('\n'),
        ...walk(r.root).map((f) => readFileSync(f, 'utf8')),
      ].join('\n');
      expect(everything).not.toContain(DEPLOY_PASSWORD);
      expect(existsSync(join(r.root, 'tmp')) ? readdirSync(join(r.root, 'tmp')) : []).toEqual([]);
    },
    60_000,
  );

  ti(
    'refuses a wrong password, a fingerprint the person did not confirm, and an old sealed key',
    async () => {
      const r = rig();
      const fp = sshd.hostFingerprint();
      const wrong = await r.c.connect({
        ...base(),
        method: 'password',
        hostKeyFingerprint: fp,
        keyId: r.runner.publicKey.keyId,
        ciphertext: await r.seal({ password: 'not-the-password' }),
      } as never);
      expect(wrong).toMatchObject({ ok: false, error: 'bad_password' });
      expect(existsSync(join(r.root, 'keys', 'deploy', T))).toBe(false);
      const mismatch = await r.c.connect({
        ...base(),
        method: 'password',
        hostKeyFingerprint: `SHA256:${'B'.repeat(43)}`,
        keyId: r.runner.publicKey.keyId,
        ciphertext: await r.seal({ password: DEPLOY_PASSWORD }),
      } as never);
      expect(mismatch).toMatchObject({ ok: false, error: 'host_key_mismatch' });
      const stale = await r.c.connect({
        ...base(),
        method: 'password',
        hostKeyFingerprint: fp,
        keyId: 'another-key',
        ciphertext: await r.seal({ password: DEPLOY_PASSWORD }),
      } as never);
      expect(stale).toMatchObject({ ok: false, error: 'key_changed' });
      const garbage = await r.c.connect({
        ...base(),
        method: 'password',
        hostKeyFingerprint: fp,
        keyId: r.runner.publicKey.keyId,
        ciphertext: 'h1.xx.yy.zz',
      } as never);
      expect(garbage).toMatchObject({ ok: false, error: 'sealed_unreadable' });
    },
    60_000,
  );

  ti(
    'a key file the host gave is used once (and its passphrase), then dropped; the dedicated key is installed',
    async () => {
      const r = rig();
      const hostKey = join(tmp('aom-hostgiven-'), 'host_given');
      execFileSync('ssh-keygen', [
        '-q',
        '-t',
        'ed25519',
        '-N',
        'sekret-pass',
        '-C',
        'host-given',
        '-f',
        hostKey,
      ]);
      const hostPub = readFileSync(`${hostKey}.pub`, 'utf8').trim();
      sshd.sh(
        `mkdir -p /root/.ssh && printf '%s\\n' '${hostPub}' > /root/.ssh/authorized_keys && chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys`,
      );
      const priv = readFileSync(hostKey, 'utf8');
      const out = await r.c.connect({
        ...base({ user: 'root' }),
        method: 'keyfile',
        hostKeyFingerprint: sshd.hostFingerprint(),
        keyId: r.runner.publicKey.keyId,
        ciphertext: await r.seal({ privateKey: priv, passphrase: 'sekret-pass' }),
      } as never);
      expect(out, JSON.stringify(out)).toMatchObject({ ok: true, installed: 'added' });
      const all = [
        JSON.stringify(out),
        r.log.lines.join('\n'),
        ...walk(r.root).map((f) => readFileSync(f, 'utf8')),
      ].join('\n');
      expect(all).not.toContain('sekret-pass');
      expect(all).not.toContain(priv.split('\n')[2] ?? 'x'.repeat(40));
      expect(existsSync(join(r.root, 'tmp')) ? readdirSync(join(r.root, 'tmp')) : []).toEqual([]);
      const wrongPass = await rig().c.connect({
        ...base({ user: 'root' }),
        method: 'keyfile',
        hostKeyFingerprint: sshd.hostFingerprint(),
        keyId: 'x',
        ciphertext: 'x',
      } as never);
      expect(wrongPass.ok).toBe(false);
    },
    60_000,
  );

  ti(
    'copy and paste for a hosting panel: the key is shown first, the test fails until it is pasted, then it works',
    async () => {
      const r = rig();
      const ref = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
      const made = await r.c.createKey({ projectId: P, keyRef: ref, label: 'Office PC' });
      expect(made).toMatchObject({ ok: true, existed: false });
      if (!made.ok) return;
      expect(made.publicKey).toMatch(/^ssh-ed25519 \S+ guildwise-deploy:99999999:Office-PC$/);
      expect(JSON.stringify(made)).not.toContain('PRIVATE');
      const again = await r.c.createKey({ projectId: P, keyRef: ref, label: 'Office PC' });
      expect(again).toMatchObject({ ok: true, existed: true, fingerprint: made.fingerprint });
      const args = {
        ...base({ user: 'deploy' }),
        keyRef: ref,
        method: 'panel',
        hostKeyFingerprint: sshd.hostFingerprint(),
      };
      sshd.sh('rm -f /home/deploy/.ssh/authorized_keys');
      const early = await r.c.connect(args as never);
      expect(early).toMatchObject({ ok: false, error: 'key_not_accepted' });
      sshd.sh(
        `mkdir -p /home/deploy/.ssh && printf '%s\\n' '${made.publicKey}' > /home/deploy/.ssh/authorized_keys && chown -R deploy:deploy /home/deploy/.ssh && chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys`,
      );
      const done = await r.c.connect(args as never);
      expect(done, JSON.stringify(done)).toMatchObject({
        ok: true,
        installed: 'pasted',
        fingerprint: made.fingerprint,
      });
      // the key moved under the target
      expect(r.keys.has(T)).toBe(true);
      expect(existsSync(join(r.root, 'keys', 'deploy', 'pending', ref))).toBe(false);
    },
    60_000,
  );

  ti(
    'an existing sign-in adds a dedicated key without editing ~/.ssh/config (the alias keeps working; our file only adds the identity)',
    async () => {
      const r = rig();
      // safety: the alias used here must not exist in the REAL ssh config (it would reach a real server)
      const real = spawnSync('ssh', ['-G', 'aom-test-existing'], { encoding: 'utf8' }).stdout;
      expect(real).toContain('hostname aom-test-existing');
      // the person already signs in as root with a key and an alias in their own ssh config
      const own = join(r.home, '.ssh');
      mkdirSync(own, { recursive: true, mode: 0o700 });
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(own, 'id_old')]);
      const pub = readFileSync(join(own, 'id_old.pub'), 'utf8').trim();
      sshd.sh(
        `mkdir -p /root/.ssh && printf '%s\\n' '${pub}' > /root/.ssh/authorized_keys && chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys`,
      );
      const known = `[127.0.0.1]:${sshd.port} ${sshd.sh('cut -d" " -f1,2 /etc/ssh/ssh_host_ed25519_key.pub').trim()}`;
      writeFileSync(join(own, 'known_hosts'), `${known}\n`);
      const cfgText = `Host aom-test-existing\n  HostName 127.0.0.1\n  Port ${sshd.port}\n  User root\n  IdentityFile ${join(own, 'id_old')}\n  IdentitiesOnly yes\n  UserKnownHostsFile ${join(own, 'known_hosts')}\n  GlobalKnownHostsFile /dev/null\n`;
      writeFileSync(join(own, 'config'), cfgText);
      const before = readFileSync(join(own, 'config'), 'utf8');
      const out = await r.c.connect({
        projectId: P,
        targetId: T2,
        method: 'alias',
        alias: 'aom-test-existing',
        port: 22,
        label: 'Office PC',
      } as never);
      expect(out, JSON.stringify(out)).toMatchObject({ ok: true, installed: 'added' });
      // not one byte of the person's ssh files changed
      expect(readFileSync(join(own, 'config'), 'utf8')).toBe(before);
      expect(readFileSync(join(own, 'known_hosts'), 'utf8')).toBe(`${known}\n`);
      const cfg = readFileSync(join(r.root, 'keys', 'deploy', T2, 'ssh_config'), 'utf8');
      expect(cfg).toContain('Host aom-test-existing');
      expect(cfg).toContain(`Include ${join(own, 'config')}`);
      // with our file the alias signs in with the dedicated key; without it, as before
      const viaOurs = spawnSync(
        'ssh',
        [
          '-F',
          join(r.root, 'keys', 'deploy', T2, 'ssh_config'),
          '-o',
          'BatchMode=yes',
          '-v',
          'aom-test-existing',
          'true',
        ],
        { encoding: 'utf8', env: r.env },
      );
      expect(viaOurs.status).toBe(0);
      expect(viaOurs.stderr).toContain('Authenticated to');
      expect(sshd.sh('cat /root/.ssh/authorized_keys')).toContain('guildwise-deploy:');
    },
    60_000,
  );

  ti(
    'revokes exactly one Guildwise key from another computer, keeps every other line, and refuses what it did not add',
    async () => {
      // computer A connects with a password; computer B (a replacement) connects too
      const a = rig('Old laptop');
      const b = rig('New PC');
      sshd.sh('rm -f /home/deploy/.ssh/authorized_keys');
      sshd.sh(
        `mkdir -p /home/deploy/.ssh && printf 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPersonOwnKeyPersonOwnKeyPersonOwnKeyPers person@home\\n' > /home/deploy/.ssh/authorized_keys && chown -R deploy:deploy /home/deploy/.ssh && chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys`,
      );
      const fp = sshd.hostFingerprint();
      const conn = async (x: ReturnType<typeof rig>) =>
        x.c.connect({
          ...base(),
          label: x.name,
          method: 'password',
          hostKeyFingerprint: fp,
          keyId: x.runner.publicKey.keyId,
          ciphertext: await x.seal({ password: DEPLOY_PASSWORD }),
        } as never);
      const ra = await conn(a);
      const rb = await conn(b);
      expect(ra.ok && rb.ok).toBe(true);
      if (!ra.ok || !rb.ok) return;
      expect(sshd.sh('cat /home/deploy/.ssh/authorized_keys').split('\n').filter(Boolean)).toHaveLength(3);
      // B removes A's key
      const out = await b.c.revoke({
        projectId: P,
        targetId: T,
        alias: 'aom-shop',
        publicKey: ra.publicKey,
        fingerprint: ra.fingerprint,
      } as never);
      expect(out, JSON.stringify(out)).toMatchObject({ ok: true, removed: 1 });
      const left = sshd.sh('cat /home/deploy/.ssh/authorized_keys');
      expect(left).toContain('person@home');
      expect(left).toContain(rb.publicKey.split(' ').slice(0, 2).join(' '));
      expect(left).not.toContain(ra.publicKey.split(' ')[1]);
      // A can no longer sign in, B still can
      expect((await a.c.check(T, 'aom-shop')).code).not.toBe(0);
      expect((await b.c.check(T, 'aom-shop')).code).toBe(0);
      // again: nothing to remove, no error
      expect(
        await b.c.revoke({
          projectId: P,
          targetId: T,
          alias: 'aom-shop',
          publicKey: ra.publicKey,
          fingerprint: ra.fingerprint,
        } as never),
      ).toMatchObject({ ok: true, removed: 0 });
      // B cannot remove its own key, and never a key without our comment
      expect(
        await b.c.revoke({
          projectId: P,
          targetId: T,
          alias: 'aom-shop',
          publicKey: rb.publicKey,
          fingerprint: rb.fingerprint,
        } as never),
      ).toMatchObject({ ok: false, error: 'own_key' });
      expect(
        await b.c.revoke({
          projectId: P,
          targetId: T,
          alias: 'aom-shop',
          publicKey:
            'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPersonOwnKeyPersonOwnKeyPersonOwnKeyPers person@home',
          fingerprint: rb.fingerprint,
        } as never),
      ).toMatchObject({ ok: false, error: 'not_ours' });
      expect(sshd.sh('cat /home/deploy/.ssh/authorized_keys')).toContain('person@home');
    },
    120_000,
  );

  ti(
    'prepares a real server through the dedicated key: folders, a compose file from the project, nothing overwritten; Docker is not guessed at on an unsupported system',
    async () => {
      const r = rig();
      sshd.sh('rm -rf /home/deploy/.ssh /home/deploy/apps');
      const ok = await r.c.connect({
        ...base(),
        method: 'password',
        hostKeyFingerprint: sshd.hostFingerprint(),
        keyId: r.runner.publicKey.keyId,
        ciphertext: await r.seal({ password: DEPLOY_PASSWORD }),
      } as never);
      expect(ok.ok).toBe(true);
      const repo = join(r.root, 'repo');
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, 'docker-compose.yml'), 'services:\n  app:\n    image: shop\n');
      const prep = new DeployPreparer({
        keys: r.keys,
        repoPath: async () => repo,
        env: r.env,
        home: r.home,
        connectSec: 5,
        commandMs: 30_000,
      });
      const actions = [
        { kind: 'create_dir', path: '/home/deploy/apps/shop' },
        { kind: 'create_dir', path: '/home/deploy/apps/shop/backups' },
        {
          kind: 'write_compose',
          path: '/home/deploy/apps/shop/docker-compose.yml',
          repoPath: 'docker-compose.yml',
          remote: 'github.com/acme/shop',
        },
      ];
      const p = {
        projectId: P,
        targetId: T,
        hosting: 'ssh',
        alias: 'aom-shop',
        actions,
        dryRun: false,
      } as never;
      const first = await prep.run(p);
      expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
      expect(first.steps.map((x) => x.outcome)).toEqual(['done', 'done', 'done']);
      expect(sshd.sh('cat /home/deploy/apps/shop/docker-compose.yml')).toContain('image: shop');
      sshd.sh("printf 'MINE' > /home/deploy/apps/shop/docker-compose.yml");
      const second = await prep.run(p);
      expect(second.steps.map((x) => x.outcome)).toEqual(['skipped', 'skipped', 'skipped']);
      expect(sshd.sh('cat /home/deploy/apps/shop/docker-compose.yml')).toBe('MINE');
      const docker = await prep.run({ ...(p as object), actions: [{ kind: 'install_docker' }] } as never);
      expect(docker).toMatchObject({ ok: false, error: 'unsupported_os' });
      const dry = await prep.run({
        ...(p as object),
        actions: [{ kind: 'create_dir', path: '/home/deploy/apps/new' }],
        dryRun: true,
      } as never);
      expect(dry.steps[0]?.outcome).toBe('would');
      expect(sshd.sh('ls /home/deploy/apps')).not.toContain('new');
    },
    120_000,
  );

  ti(
    'the reachability probe uses the dedicated key and classifies a server that stops accepting it',
    async () => {
      const r = rig();
      sshd.sh('rm -f /home/deploy/.ssh/authorized_keys');
      const ok = await r.c.connect({
        ...base(),
        method: 'password',
        hostKeyFingerprint: sshd.hostFingerprint(),
        keyId: r.runner.publicKey.keyId,
        ciphertext: await r.seal({ password: DEPLOY_PASSWORD }),
      } as never);
      expect(ok.ok).toBe(true);
      const probe = (scope: 'ssh_check' | 'ssh_target') =>
        runDeployProbe(
          { projectId: P, targetId: T, scope, host: 'aom-shop' },
          { keys: r.keys, env: r.env, home: r.home, connectSec: 5 },
        );
      expect(await probe('ssh_check')).toMatchObject({
        ok: true,
        report: { scope: 'ssh_check', host: 'aom-shop' },
      });
      const full = await probe('ssh_target');
      expect(full.ok).toBe(true);
      sshd.sh('rm -f /home/deploy/.ssh/authorized_keys');
      expect(await probe('ssh_check')).toMatchObject({ ok: false, error: 'ssh_auth' });
      sshd.stop();
      expect(await probe('ssh_check')).toMatchObject({ ok: false });
      sshd = startSshd();
    },
    120_000,
  );
  ti(
    'a reconnect that fails leaves the working config and the pinned host key exactly as they were; one that works replaces them',
    async () => {
      const r = rig();
      const fp = sshd.hostFingerprint();
      sshd.sh('rm -rf /home/deploy/.ssh');
      const first = await r.c.connect({
        ...base(),
        method: 'password',
        hostKeyFingerprint: fp,
        keyId: r.runner.publicKey.keyId,
        ciphertext: await r.seal({ password: DEPLOY_PASSWORD }),
      } as never);
      expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
      const dir = join(r.root, 'keys', 'deploy', T);
      const before = {
        cfg: readFileSync(join(dir, 'ssh_config'), 'utf8'),
        kh: readFileSync(join(dir, 'known_hosts'), 'utf8'),
        meta: readFileSync(join(dir, 'meta.json'), 'utf8'),
      };
      // a wrong password for another user: fails after the new settings were written to the staging folder
      const bad = await r.c.connect({
        ...base({ user: 'nobody-here' }),
        method: 'password',
        hostKeyFingerprint: fp,
        keyId: r.runner.publicKey.keyId,
        ciphertext: await r.seal({ password: 'nope' }),
      } as never);
      expect(bad).toMatchObject({ ok: false });
      expect(readFileSync(join(dir, 'ssh_config'), 'utf8')).toBe(before.cfg);
      expect(readFileSync(join(dir, 'known_hosts'), 'utf8')).toBe(before.kh);
      expect(readFileSync(join(dir, 'meta.json'), 'utf8')).toBe(before.meta);
      expect(existsSync(join(dir, 'staging'))).toBe(false);
      // the old settings still sign in
      expect(
        spawnSync(
          'ssh',
          ['-F', join(dir, 'ssh_config'), '-o', 'BatchMode=yes', '--', 'aom-shop', 'echo', 'ok'],
          {
            encoding: 'utf8',
            env: r.env,
          },
        ).stdout.trim(),
      ).toBe('ok');
      // a reconnect that works (the key is installed already) promotes the staged settings
      const again = await r.c.connect({
        ...base({ port: sshd.port }),
        method: 'password',
        hostKeyFingerprint: fp,
        keyId: r.runner.publicKey.keyId,
        ciphertext: await r.seal({ password: DEPLOY_PASSWORD }),
      } as never);
      expect(again).toMatchObject({ ok: true, installed: 'already' });
      expect(existsSync(join(dir, 'staging'))).toBe(false);
      expect(readFileSync(join(dir, 'ssh_config'), 'utf8')).toContain(
        `UserKnownHostsFile ${join(dir, 'known_hosts')}`,
      );
    },
    90_000,
  );
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) out.push(...walk(f));
    else if (statSync(f).size < 200_000) out.push(f);
  }
  return out;
}
void ROOT_PASSWORD;
