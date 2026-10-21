import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { connectSealAad, sealLarge } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { INSTALL_KEY_SCRIPT, REVOKE_KEY_SCRIPT } from '../src/delivery/connect.ts';
import { killGraceSec } from '../src/delivery/exec.ts';
import { RunnerKeys } from '../src/secrets/keys.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

// v2 review fixes. The remote scripts run LOCALLY in a temp HOME (no ssh anywhere in this file).
const KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGuildwiseKeyGuildwiseKeyGuildwiseKeyGuildwiseK guildwise-deploy:abc:Laptop';
const OTHER = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPersonOwnKeyPersonOwnKeyPersonOwnKeyPers person@home';

function sh(script: string, home: string, ...args: string[]) {
  return spawnSync('sh', ['-c', script, 'aom-remote', ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: home },
  });
}
const mode = (f: string) => (statSync(f).mode & 0o777).toString(8);

describe('m3: the key install only tightens a folder or file that others can write to', () => {
  it('leaves modes that are already restrictive as they are', () => {
    const home = tmp('aom-m3-');
    mkdirSync(join(home, '.ssh'));
    chmodSync(join(home, '.ssh'), 0o750); // group may read: fine for sshd, not ours to change
    writeFileSync(join(home, '.ssh', 'authorized_keys'), `${OTHER}\n`);
    chmodSync(join(home, '.ssh', 'authorized_keys'), 0o640);
    const r = sh(INSTALL_KEY_SCRIPT, home, KEY);
    expect(r.stdout).toContain('AOM_RESULT added');
    expect(mode(join(home, '.ssh'))).toBe('750');
    expect(mode(join(home, '.ssh', 'authorized_keys'))).toBe('640');
    expect(readFileSync(join(home, '.ssh', 'authorized_keys'), 'utf8')).toContain(OTHER);
  });
  it('removes only the group/other WRITE bit of a folder or file that sshd would refuse', () => {
    const home = tmp('aom-m3-');
    mkdirSync(join(home, '.ssh'));
    chmodSync(join(home, '.ssh'), 0o775);
    writeFileSync(join(home, '.ssh', 'authorized_keys'), `${OTHER}\n`);
    chmodSync(join(home, '.ssh', 'authorized_keys'), 0o666);
    sh(INSTALL_KEY_SCRIPT, home, KEY);
    expect(mode(join(home, '.ssh'))).toBe('755');
    expect(mode(join(home, '.ssh', 'authorized_keys'))).toBe('644');
  });
  it('a new folder and file are private', () => {
    const home = tmp('aom-m3-');
    sh(INSTALL_KEY_SCRIPT, home, KEY);
    expect(mode(join(home, '.ssh'))).toBe('700');
    expect(mode(join(home, '.ssh', 'authorized_keys'))).toBe('600');
  });
});

describe('m2: removing a key replaces the file in one step and keeps its mode', () => {
  const setup = () => {
    const home = tmp('aom-m2-');
    mkdirSync(join(home, '.ssh'));
    const f = join(home, '.ssh', 'authorized_keys');
    writeFileSync(f, `${OTHER}\n${KEY}\n`);
    chmodSync(f, 0o640);
    return { home, f };
  };
  const leftovers = (home: string) => readdirSync(join(home, '.ssh')).filter((n) => n.includes('aom-tmp'));
  it('one key', () => {
    const { home, f } = setup();
    const r = sh(REVOKE_KEY_SCRIPT, home, KEY.split(' ').slice(0, 2).join(' '), 'guildwise-deploy:');
    expect(r.stdout).toMatch(/AOM_RESULT 1 /);
    expect(readFileSync(f, 'utf8')).toBe(`${OTHER}\n`);
    expect(mode(f)).toBe('640');
    expect(leftovers(home)).toEqual([]);
  });
});

describe('M3: a script with an http health check gets time to roll back after the timeout', () => {
  it('180 s, else 10 s', () => {
    expect(killGraceSec('http')).toBeGreaterThanOrEqual(180);
    expect(killGraceSec('none')).toBe(10);
  });
});

describe('m7: a sealed sign-in is bound to the server it was typed for', () => {
  const root = tmp('aom-m7-');
  mkdirSync(join(root, 'secrets'), { recursive: true });
  const keys = new RunnerKeys(join(root, 'secrets', 'k.pem'));
  const a = {
    projectId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    address: 'Shop.Example.com',
    port: 22,
    user: 'deploy',
  };
  it('opens with the same binding, not with another address, and not without one', async () => {
    const sealed = await sealLarge(keys.publicKey.publicKey, '{"password":"x"}', connectSealAad(a));
    expect(sealed.startsWith('h2.')).toBe(true);
    expect(keys.decryptAny(sealed, connectSealAad(a))).toBe('{"password":"x"}');
    expect(() => keys.decryptAny(sealed, connectSealAad({ ...a, address: 'evil.example.com' }))).toThrow();
    expect(() => keys.decryptAny(sealed, connectSealAad({ ...a, user: 'root' }))).toThrow();
    expect(() => keys.decryptAny(sealed)).toThrow();
  });
  it('an older page still seals the plain form, which still opens', async () => {
    const sealed = await sealLarge(keys.publicKey.publicKey, 'plain');
    expect(sealed.startsWith('h1.')).toBe(true);
    expect(keys.decryptAny(sealed, connectSealAad(a))).toBe('plain');
    expect(existsSync(join(root, 'secrets'))).toBe(true);
  });
});
