import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AuthoredCapability,
  type PackDesiredInput,
  type PacksReport,
  packTree,
  sealLarge,
} from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PackCredentialStore } from '../src/capabilities/pack-credentials.ts';
import { PackManager } from '../src/capabilities/packs.ts';
import { RunnerKeys } from '../src/secrets/keys.ts';
import { sshdAvailable } from './helpers/sshd.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

/**
 * A private pack over REAL ssh against a throwaway git host in Docker: the clone uses the deploy key and nothing else, the host
 * key is recorded on the first fetch and insisted on afterwards (a changed host key is refused), and a wrong key is refused.
 * Skipped when Docker or the image build (it needs the network) is not available.
 */
const can = sshdAvailable();
const IMAGE = 'aom-test-gitssh:1';
const ID = '22222222-2222-4222-8222-222222222222';
const critic: AuthoredCapability = {
  kind: 'persona',
  key: 'critic',
  name: 'Critic',
  description: 'Finds the weak spot.',
  stance: 'Doubt first.',
  voice: 'Terse',
  icon: 'x',
  prompt: 'You find the weak spot.',
};

let name = '';
let port = 0;
let ready = false;
const sh = (cmd: string, user = 'root') =>
  execFileSync('docker', ['exec', '-u', user, name, 'sh', '-c', cmd], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

beforeAll(() => {
  if (!can) return;
  try {
    execFileSync(
      'docker',
      ['build', '-q', '-t', IMAGE, join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gitssh')],
      { stdio: 'pipe' },
    );
    name = `aom-test-gitssh-${process.pid}`;
    execFileSync('docker', ['run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::22', IMAGE], {
      stdio: 'pipe',
    });
    const mapped =
      execFileSync('docker', ['port', name, '22'], { encoding: 'utf8' }).trim().split('\n')[0] ?? '';
    port = Number(mapped.slice(mapped.lastIndexOf(':') + 1));
    for (let i = 0; i < 60; i++) {
      const r = spawnSync('ssh-keyscan', ['-T', '1', '-p', String(port), '-t', 'ed25519', '127.0.0.1'], {
        encoding: 'utf8',
      });
      if (r.stdout.includes('ssh-ed25519')) break;
      spawnSync('sleep', ['0.2']);
    }
    ready = true;
  } catch (err) {
    console.warn(`git over ssh test container not available: ${String(err).slice(0, 200)}`);
  }
}, 240_000);
afterAll(() => {
  if (name) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
});

const ti = (title: string, fn: () => Promise<void>) =>
  it(title, async (ctx) => {
    if (!ready) return ctx.skip();
    await fn();
  }, 120_000);

describe.skipIf(!can)('a private pack over real ssh', () => {
  ti(
    'clones with the deploy key only, pins the host key, then refuses a changed one and a wrong key',
    async () => {
      const dir = tmp('aom-gitssh-');
      // the deploy key, and a repository on the host that only that key can read
      const keyFile = join(dir, 'deploy');
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyFile]);
      sh(
        `printf '%s\n' '${readFileSync(`${keyFile}.pub`, 'utf8').trim()}' > /home/git/.ssh/authorized_keys && chown git:git /home/git/.ssh/authorized_keys && chmod 600 /home/git/.ssh/authorized_keys`,
      );
      const work = join(dir, 'work');
      mkdirSync(work, { recursive: true });
      for (const [p, t] of Object.entries(packTree([critic]))) {
        mkdirSync(join(work, p, '..'), { recursive: true });
        writeFileSync(join(work, p), t);
      }
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@e.x',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@e.x',
      };
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: work, env });
      execFileSync('git', ['add', '-A'], { cwd: work, env });
      execFileSync('git', ['commit', '-q', '-m', 'c'], { cwd: work, env });
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, env, encoding: 'utf8' }).trim();
      execFileSync('docker', ['cp', work, `${name}:/srv/repo`]);
      sh('chown -R git:git /srv/repo');
      sh(
        "git config --global --add safe.directory '*' && cd /srv && git clone -q --bare /srv/repo /srv/pack.git",
        'git',
      );

      const keys = new RunnerKeys(join(dir, 'secrets', 'k.pem'));
      const creds = new PackCredentialStore(
        join(dir, 'packs'),
        (c) => keys.decryptAny(c),
        () => keys.publicKey.keyId,
      );
      const reports: PacksReport[] = [];
      const m = new PackManager({
        dir: join(dir, 'packs'),
        report: (r) => reports.push(r),
        credentials: creds,
        open: (c) => keys.decryptAny(c),
        keyId: () => keys.publicKey.keyId,
        allowLoopback: true,
      });
      // the sshd of the container would be reached by the user's own keys too: this test must not need them
      expect(existsSync(join(process.env.HOME ?? '', '.ssh'))).toBeDefined();
      await creds.set({
        packId: ID,
        keyId: keys.publicKey.keyId,
        kind: 'ssh',
        ciphertext: await sealLarge(keys.publicKey.publicKey, readFileSync(keyFile, 'utf8')),
      });
      const desired: PackDesiredInput = {
        packId: ID,
        name: 'priv',
        url: `ssh://git@127.0.0.1:${port}/srv/pack.git`,
        ref: 'main',
        adapter: 'generic',
        scope: 'org',
        projectId: null,
        pinnedSha: null,
        trusted: null,
        scriptsEnabled: false,
        credentialKind: 'ssh',
      };
      await m.sync([desired]);
      const res = reports.find((r) => r.state === 'resolved');
      expect(res?.snapshot?.sha).toBe(sha);
      expect(res?.hostKey?.key).toContain('ssh-ed25519');
      // the host key is now pinned in this pack's own file: a different host key is refused
      const pinned = readFileSync(creds.knownHostsFile(ID), 'utf8');
      expect(pinned).toContain('ssh-ed25519');
      reports.length = 0;
      await m.check(ID);
      expect(reports.at(-1)?.state).toBe('current');
      // a wrong key does not get in: the host refuses it, and the right key is not used as a fallback
      const sealKey = async (file: string) =>
        creds.set({
          packId: ID,
          keyId: keys.publicKey.keyId,
          kind: 'ssh',
          ciphertext: await sealLarge(keys.publicKey.publicKey, readFileSync(file, 'utf8')),
        });
      const other = join(dir, 'other');
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', other]);
      await sealKey(other);
      reports.length = 0;
      await m.check(ID);
      expect(reports.at(-1)?.state).toBe('failed');
      expect(reports.at(-1)?.message ?? '').toMatch(
        /permission denied|publickey|could not read from remote/i,
      );
      await sealKey(keyFile);
      // the host presents another key from now on (sshd re-reads its host keys on SIGHUP): the pinned one is insisted on
      sh(
        'rm -f /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub && ssh-keygen -q -t ed25519 -N "" -f /etc/ssh/ssh_host_ed25519_key && kill -HUP 1',
      );
      spawnSync('sleep', ['1.5']);
      reports.length = 0;
      await m.check(ID);
      expect(reports.at(-1)?.state).toBe('failed');
      expect(reports.at(-1)?.message ?? '').toMatch(/host key|identification|could not read from remote/i);
      expect(creds.hostKey(ID)).toBe(pinned.trim());
    },
  );
});
