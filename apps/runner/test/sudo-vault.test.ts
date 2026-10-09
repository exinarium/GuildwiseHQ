import { webcrypto } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../src/log.ts';
import { RunnerKeys } from '../src/secrets/keys.ts';
import { redact, unregisterSecret } from '../src/secrets/redact.ts';
import { SudoVault } from '../src/secrets/sudo.ts';
import type { ExecOptions, ExecResult, Executor } from '../src/toolchain/exec.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

/** What the browser does: import the SPKI public key and encrypt with RSA-OAEP / SHA-256. */
async function encryptLikeTheBrowser(publicKeyB64: string, text: string): Promise<string> {
  const key = await webcrypto.subtle.importKey(
    'spki',
    Buffer.from(publicKeyB64, 'base64'),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
  const ct = await webcrypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(text));
  return Buffer.from(ct).toString('base64');
}

interface Call {
  cmd: string;
  args: string[];
  input?: string;
}
/** A pretend `sudo`: accepts `PASSWORD` on stdin; `-n` works only when `passwordless`. */
function fakeSudo(opts: { password?: string; passwordless?: boolean } = {}) {
  const calls: Call[] = [];
  const exec: Executor = {
    async run(cmd: string, args: string[], o: ExecOptions = {}): Promise<ExecResult> {
      calls.push({ cmd, args, ...(o.input !== undefined ? { input: o.input } : {}) });
      if (cmd !== 'sudo') return { exitCode: 0, stdout: `ran ${cmd}`, stderr: '' };
      if (args.includes('-n')) {
        return opts.passwordless
          ? { exitCode: 0, stdout: 'ok', stderr: '' }
          : { exitCode: 1, stdout: '', stderr: 'sudo: a password is required' };
      }
      if (args.includes('-S')) {
        if (o.input?.trim() === opts.password)
          return { exitCode: 0, stdout: `output mentions ${opts.password}`, stderr: '' };
        return { exitCode: 1, stdout: '', stderr: 'Sorry, try again.' };
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected' };
    },
  };
  return { exec, calls };
}

function setup(
  sudoOpts: Parameters<typeof fakeSudo>[0] = {},
  platform: NodeJS.Platform = 'linux',
  uid = 1000,
) {
  const dir = tmp('aom-secrets-');
  const keys = new RunnerKeys(join(dir, 'secrets', 'runner-key.pem'));
  const { exec, calls } = fakeSudo(sudoOpts);
  const file = join(dir, 'secrets', 'sudo.enc');
  const vault = new SudoVault({ file, keys, exec, platform, uid: () => uid });
  return {
    dir,
    keys,
    vault,
    calls,
    file,
    make: () => new SudoVault({ file, keys, exec, platform, uid: () => uid }),
  };
}

const PASSWORD = 'correct horse battery staple';
afterEach(() => unregisterSecret(PASSWORD));

describe('runner keys', () => {
  it('are created once, kept in a 0600 file in a 0700 folder, and stable across restarts', () => {
    const { dir, keys } = setup();
    const file = join(dir, 'secrets', 'runner-key.pem');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'secrets')).mode & 0o777).toBe(0o700);
    const again = new RunnerKeys(file);
    expect(again.publicKey).toEqual(keys.publicKey);
    expect(keys.publicKey.keyId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('decrypt what a browser encrypted, and nothing else', async () => {
    const { keys } = setup();
    const ct = await encryptLikeTheBrowser(keys.publicKey.publicKey, 'pässword 🔑');
    expect(keys.decrypt(ct)).toBe('pässword 🔑');
    const other = setup().keys;
    expect(() => other.decrypt(ct)).toThrow();
  });
});

describe('sudo password', () => {
  it('is stored only as ciphertext in a 0600 file, accepted by sudo -S, and never appears in plain text on disk', async () => {
    const { vault, keys, calls, file, dir } = setup({ password: PASSWORD });
    const ct = await encryptLikeTheBrowser(keys.publicKey.publicKey, PASSWORD);
    const r = await vault.set({ ciphertext: ct, keyId: keys.publicKey.keyId });
    expect(r).toEqual({ stored: true, works: true });
    expect(JSON.stringify(r)).not.toContain(PASSWORD);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // nothing under the data dir contains the password
    const all = readdirSync(join(dir, 'secrets')).map((f) => readFileSync(join(dir, 'secrets', f), 'utf8'));
    expect(all.join('\n')).not.toContain(PASSWORD);
    // the check used stdin, never the arguments
    const check = calls.find((c) => c.args.includes('-S'));
    expect(check?.input).toBe(`${PASSWORD}\n`);
    expect(calls.every((c) => !c.args.join(' ').includes(PASSWORD))).toBe(true);
    expect(vault.has()).toBe(true);
  });

  it('a password sudo refuses is stored but reported as not working', async () => {
    const { vault, keys } = setup({ password: 'something else' });
    const ct = await encryptLikeTheBrowser(keys.publicKey.publicKey, PASSWORD);
    const r = await vault.set({ ciphertext: ct, keyId: keys.publicKey.keyId });
    expect(r).toMatchObject({ stored: true, works: false });
    expect(r.error).toContain('did not accept');
  });

  it('refuses ciphertext made for another key or damaged, and stores nothing', async () => {
    const { vault, keys, file } = setup();
    const foreign = setup().keys;
    const ct = await encryptLikeTheBrowser(foreign.publicKey.publicKey, PASSWORD);
    expect(await vault.set({ ciphertext: ct, keyId: foreign.publicKey.keyId })).toMatchObject({
      stored: false,
    });
    expect(await vault.set({ ciphertext: ct, keyId: keys.publicKey.keyId })).toMatchObject({
      stored: false,
      error: expect.stringContaining('could not be decrypted'),
    });
    expect(await vault.set({ ciphertext: 'AAAA', keyId: keys.publicKey.keyId })).toMatchObject({
      stored: false,
    });
    expect(existsSync(file)).toBe(false);
  });

  it('is used through `sudo -S` on stdin for privileged commands, and output is redacted', async () => {
    const { vault, keys, calls } = setup({ password: PASSWORD });
    await vault.set({
      ciphertext: await encryptLikeTheBrowser(keys.publicKey.publicKey, PASSWORD),
      keyId: keys.publicKey.keyId,
    });
    calls.length = 0;
    const r = await vault.run('apt-get', ['install', '-y', 'jq']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('output mentions ***');
    const run = calls.find((c) => c.args.includes('--') && c.args.includes('apt-get'));
    expect(run).toMatchObject({
      cmd: 'sudo',
      args: ['-S', '-p', '', '--', 'apt-get', 'install', '-y', 'jq'],
    });
    expect(run?.input).toBe(`${PASSWORD}\n`);
    expect(calls.every((c) => !c.args.join(' ').includes(PASSWORD))).toBe(true);
  });

  it('survives a restart (redaction knows it before the first log line) and can be cleared', async () => {
    const t = setup({ password: PASSWORD });
    await t.vault.set({
      ciphertext: await encryptLikeTheBrowser(t.keys.publicKey.publicKey, PASSWORD),
      keyId: t.keys.publicKey.keyId,
    });
    unregisterSecret(PASSWORD);
    expect(redact(`pw=${PASSWORD}`)).toBe(`pw=${PASSWORD}`);
    const restarted = t.make();
    expect(redact(`pw=${PASSWORD}`)).toBe('pw=***');
    expect((await restarted.mode()).mode).toBe('password');
    restarted.clear();
    expect(restarted.has()).toBe(false);
    expect(redact(`pw=${PASSWORD}`)).toBe(`pw=${PASSWORD}`);
    expect((await restarted.mode()).mode).toBe('none');
  });

  it('the runner log redacts it', async () => {
    const t = setup({ password: PASSWORD });
    await t.vault.set({
      ciphertext: await encryptLikeTheBrowser(t.keys.publicKey.publicKey, PASSWORD),
      keyId: t.keys.publicKey.keyId,
    });
    const file = join(t.dir, 'logs', 'runner.log');
    const log = createLogger(file, true);
    log.info(`about to run with ${PASSWORD}`, { env: { X: PASSWORD } });
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(PASSWORD);
    expect(text).toContain('about to run with ***');
  });
});

describe('sudo modes', () => {
  it('root needs no sudo; passwordless sudo is used with -n; no password stored is an error, not a prompt', async () => {
    const root = setup({}, 'linux', 0);
    expect((await root.vault.mode()).mode).toBe('root');
    await root.vault.run('systemctl', ['start', 'docker']);
    expect(root.calls.at(-1)).toMatchObject({ cmd: 'systemctl' });

    const pl = setup({ passwordless: true });
    expect((await pl.vault.mode()).mode).toBe('passwordless');
    await pl.vault.run('apt-get', ['update']);
    expect(pl.calls.at(-1)).toMatchObject({ cmd: 'sudo', args: ['-n', '--', 'apt-get', 'update'] });

    const none = setup({});
    expect((await none.vault.mode()).mode).toBe('none');
    expect((await none.vault.mode()).detail).toContain('needs a password');
    const r = await none.vault.run('apt-get', ['update']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('none is stored');
  });

  it('Windows has no sudo: elevation is what counts', async () => {
    const win = setup({}, 'win32');
    // the fake answers `net session` with success (any non-sudo command does)
    expect((await win.vault.mode()).mode).toBe('root');
  });
});
