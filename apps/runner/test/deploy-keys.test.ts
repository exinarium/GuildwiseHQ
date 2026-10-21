import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBundleFromDir } from '../src/delivery/bundle.ts';
import { DeployKeys } from '../src/delivery/deploy-keys.ts';
import { deliveryWorld, FOLDER } from './delivery-fixture.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

const T = '7f0e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const T2 = '11111111-2222-4333-8444-555555555555';
const REF = '99999999-aaaa-4bbb-8ccc-dddddddddddd';

const keysIn = (root = tmp('aom-keys-')) => ({
  root,
  keys: new DeployKeys({ dir: join(root, 'keys', 'deploy'), home: join(root, 'home') }),
});

describe('the dedicated deploy keys of this computer', () => {
  it('makes an ed25519 key in the runner folder: private 0600 in a 0700 folder, comment tells whose it is; an existing key is kept, never replaced', async () => {
    const { keys } = keysIn();
    const a = await keys.ensure({ targetId: T }, "Pieter's Laptop");
    expect(a.existed).toBe(false);
    expect(a.publicKey).toMatch(/^ssh-ed25519 \S+ guildwise-deploy:7f0e1a2b:Pieter-s-Laptop$/);
    expect(a.fingerprint).toMatch(/^SHA256:/);
    expect(statSync(join(a.dir, 'id_ed25519')).mode & 0o777).toBe(0o600);
    expect(statSync(a.dir).mode & 0o777).toBe(0o700);
    const before = readFileSync(join(a.dir, 'id_ed25519'), 'utf8');
    const b = await keys.ensure({ targetId: T }, 'Another name');
    expect(b).toMatchObject({ existed: true, publicKey: a.publicKey, fingerprint: a.fingerprint });
    expect(readFileSync(join(a.dir, 'id_ed25519'), 'utf8')).toBe(before);
    expect(JSON.stringify(a)).not.toContain('PRIVATE');
  });

  it('a key made before its target exists moves under the target; a key this computer already has for it wins', async () => {
    const { keys } = keysIn();
    const pending = await keys.ensure({ keyRef: REF }, 'PC');
    expect(keys.has(T)).toBe(false);
    keys.adopt(REF, T);
    expect(existsSync(join(keys.dir, 'pending', REF))).toBe(false);
    expect(readFileSync(join(keys.dir, T, 'id_ed25519.pub'), 'utf8').trim()).toBe(pending.publicKey);
    const second = await keys.ensure({ keyRef: '88888888-aaaa-4bbb-8ccc-dddddddddddd' }, 'PC');
    keys.adopt('88888888-aaaa-4bbb-8ccc-dddddddddddd', T);
    expect(readFileSync(join(keys.dir, T, 'id_ed25519.pub'), 'utf8').trim()).toBe(pending.publicKey);
    expect(second.publicKey).not.toBe(pending.publicKey);
  });

  it('AOM_DEPLOY_SSH only for the alias the key was made for, and not for a path the script could not split', async () => {
    const { keys, root } = keysIn();
    const k = await keys.ensure({ targetId: T }, 'PC');
    expect(keys.deploySsh(T, 'aom-shop')).toBeNull(); // not connected yet: no config
    keys.write(
      k.dir,
      {
        alias: 'aom-shop',
        mode: 'managed',
        address: '203.0.113.9',
        user: 'root',
        port: 22,
        fingerprint: k.fingerprint,
      },
      '203.0.113.9 ssh-ed25519 AAAA',
    );
    expect(keys.deploySsh(T, 'aom-shop')).toBe(`ssh -F ${join(k.dir, 'ssh_config')}`);
    expect(keys.deploySsh(T, 'other-alias')).toBeNull();
    expect(keys.deploySsh(T2, 'aom-shop')).toBeNull();
    expect(keys.deploySsh(null, 'aom-shop')).toBeNull();
    const cfg = readFileSync(join(k.dir, 'ssh_config'), 'utf8');
    expect(cfg).toContain('StrictHostKeyChecking yes');
    expect(cfg).toContain('IdentitiesOnly yes');
    expect(cfg).toContain('IdentityAgent none');
    expect(cfg).toContain('PasswordAuthentication no');
    expect(cfg).toContain(`UserKnownHostsFile ${join(k.dir, 'known_hosts')}`);
    expect(readFileSync(join(k.dir, 'known_hosts'), 'utf8')).toBe('203.0.113.9 ssh-ed25519 AAAA\n');
    // a data folder with a space cannot be split by `read -a`: plain ssh is used instead of a broken command
    const spaced = keysIn(join(root, 'with space'));
    const k2 = await spaced.keys.ensure({ targetId: T }, 'PC');
    spaced.keys.write(k2.dir, {
      alias: 'aom-shop',
      mode: 'managed',
      address: 'a.example.com',
      user: 'root',
      port: 22,
      fingerprint: k2.fingerprint,
    });
    expect(spaced.keys.deploySsh(T, 'aom-shop')).toBeNull();
  });

  it('an existing alias gets only an identity in front and an Include of the person file; the person file is not read for content here', async () => {
    const { keys, root } = keysIn();
    mkdirSync(join(root, 'home', '.ssh'), { recursive: true });
    writeFileSync(join(root, 'home', '.ssh', 'config'), 'Host prod-server\n  HostName 1.2.3.4\n');
    const k = await keys.ensure({ targetId: T }, 'PC');
    keys.write(k.dir, { alias: 'prod-server', mode: 'alias', fingerprint: k.fingerprint });
    const cfg = readFileSync(join(k.dir, 'ssh_config'), 'utf8');
    expect(cfg).toContain('Host prod-server');
    expect(cfg).toContain(`Include ${join(root, 'home', '.ssh', 'config')}`);
    expect(cfg).not.toContain('1.2.3.4');
    expect(readFileSync(join(root, 'home', '.ssh', 'config'), 'utf8')).toBe(
      'Host prod-server\n  HostName 1.2.3.4\n',
    );
  });

  it('forgets one target; drops a made-but-unused key after a week', async () => {
    const { keys } = keysIn();
    await keys.ensure({ targetId: T }, 'PC');
    await keys.ensure({ keyRef: REF }, 'PC');
    keys.forget(T);
    expect(keys.has(T)).toBe(false);
    const old = new Date(Date.now() - 8 * 86_400_000);
    utimesSync(join(keys.dir, 'pending', REF), old, old);
    keys.sweepPending();
    expect(existsSync(join(keys.dir, 'pending', REF))).toBe(false);
  });
});

describe('deploy.exec passes the dedicated key to the script', () => {
  it('AOM_DEPLOY_SSH is exported for a target this computer holds a key for (and the script runs with it), not otherwise', async () => {
    const { keys } = keysIn();
    const k = await keys.ensure({ targetId: T }, 'PC');
    keys.write(
      k.dir,
      {
        alias: 'aom-shop',
        mode: 'managed',
        address: '203.0.113.9',
        user: 'root',
        port: 22,
        fingerprint: k.fingerprint,
      },
      '203.0.113.9 ssh-ed25519 AAAA',
    );
    const w = await deliveryWorld({ keys });
    const body =
      '#!/usr/bin/env bash\necho "SSH=[${AOM_DEPLOY_SSH:-none}] HOST=[${AOM_DEPLOY_HOST:-}]"\necho "P5 DEPLOY READY ${AOM_DEPLOY_COMMIT:-?}"\n';
    w.secrets.P5_ADMIN_PASSWORD = 'x';
    const commit = w.commitRecipe((d) =>
      writeFileSync(join(d, 'scripts', 'local.sh'), body, { mode: 0o755 }),
    );
    await w.vaults.syncNow('v1');
    const hash = readBundleFromDir(join(w.vaults.dir('v1'), FOLDER, 'delivery')).hash;
    const target = (id: string | null, host: string | null) => ({
      id,
      name: 'p5-local',
      kind: 'remote_ssh',
      host,
      appUrl: null,
    });
    const on = await w.exec.run(w.payload({ vaultCommit: commit, hash, target: target(T, 'aom-shop') }));
    expect(on.logTail, JSON.stringify(on)).toContain(
      `SSH=[ssh -F ${join(k.dir, 'ssh_config')}] HOST=[aom-shop]`,
    );
    const off = await w.exec.run(
      w.payload({
        runId: '019da000-0000-7000-8000-0000000000ab',
        vaultCommit: commit,
        hash,
        target: target(T2, 'aom-shop'),
      }),
    );
    expect(off.logTail).toContain('SSH=[none]');
    const other = await w.exec.run(
      w.payload({
        runId: '019da000-0000-7000-8000-0000000000ac',
        vaultCommit: commit,
        hash,
        target: target(T, 'someone-else'),
      }),
    );
    expect(other.logTail).toContain('SSH=[none]');
  });
});
void chmodSync;
