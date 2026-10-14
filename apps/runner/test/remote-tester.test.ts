import { webcrypto } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunnerKeys } from '../src/secrets/keys.ts';
import { redact, unregisterSecret } from '../src/secrets/redact.ts';
import { TargetSecrets } from '../src/secrets/targets.ts';
import { hostnameOf, probeTargetUrl, targetHosts } from '../src/testing/remote-target.ts';
import { makeShiftStart } from './fixtures.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, makeRepo, tmp } from './helpers.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';

cleanupTmp();

/** What the browser does: import the SPKI public key and encrypt with RSA-OAEP / SHA-256. */
async function seal(publicKeyB64: string, text: string): Promise<string> {
  const key = await webcrypto.subtle.importKey(
    'spki',
    Buffer.from(publicKeyB64, 'base64'),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
  return Buffer.from(
    await webcrypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(text)),
  ).toString('base64');
}

const TARGET = '0192f3a0-0000-7000-8000-000000000a01';

describe('test accounts of a target', () => {
  const store = () => {
    const dir = tmp();
    const keys = new RunnerKeys(join(dir, 'secrets', 'runner-key.pem'));
    return { dir, keys, secrets: new TargetSecrets({ file: join(dir, 'secrets', 'targets.json'), keys }) };
  };
  afterEach(() => {
    unregisterSecret('s3cret-pass-word');
    unregisterSecret('other-value-123');
  });

  it('stores only ciphertext, hands the plain values to a 0600 file and hides them from logs', async () => {
    const { dir, keys, secrets } = store();
    const r = secrets.set({
      targetId: TARGET,
      name: 'TEST_USER_PASSWORD',
      keyId: keys.publicKey.keyId,
      ciphertext: await seal(keys.publicKey.publicKey, 's3cret-pass-word'),
    });
    expect(r).toEqual({ stored: true });
    secrets.set({
      targetId: TARGET,
      name: 'API_KEY',
      keyId: keys.publicKey.keyId,
      ciphertext: await seal(keys.publicKey.publicKey, 'other-value-123'),
    });
    // nothing readable on disk
    const disk = readFileSync(join(dir, 'secrets', 'targets.json'), 'utf8');
    expect(disk).not.toContain('s3cret-pass-word');
    expect(disk).not.toContain('other-value-123');
    expect(statSync(join(dir, 'secrets', 'targets.json')).mode & 0o777).toBe(0o600);
    expect(secrets.names(TARGET)).toEqual(['API_KEY', 'TEST_USER_PASSWORD']);
    // anything the runner prints loses them
    expect(redact('logged in with s3cret-pass-word as bob')).toBe('logged in with *** as bob');

    const shiftTmp = join(dir, 'shift-tmp');
    const f = secrets.writeFile(shiftTmp, TARGET, ['TEST_USER_PASSWORD', 'API_KEY', 'NOT_SET']);
    expect(f.missing).toEqual(['NOT_SET']);
    expect(f.path).toBe(join(shiftTmp, 'env-secrets.env'));
    expect(statSync(f.path as string).mode & 0o777).toBe(0o600);
    expect(readFileSync(f.path as string, 'utf8')).toBe(
      'TEST_USER_PASSWORD="s3cret-pass-word"\nAPI_KEY="other-value-123"\n',
    );
    // a name the target did not declare is not handed over
    expect(secrets.writeFile(shiftTmp, TARGET, ['API_KEY']).missing).toEqual([]);
    expect(readFileSync(f.path as string, 'utf8')).toBe('API_KEY="other-value-123"\n');
  });

  it('survives a restart (and hides the values again), and clears one name or all of them', async () => {
    const { dir, keys, secrets } = store();
    secrets.set({
      targetId: TARGET,
      name: 'TEST_USER_PASSWORD',
      keyId: keys.publicKey.keyId,
      ciphertext: await seal(keys.publicKey.publicKey, 's3cret-pass-word'),
    });
    unregisterSecret('s3cret-pass-word');
    const again = new TargetSecrets({ file: join(dir, 'secrets', 'targets.json'), keys });
    expect(redact('s3cret-pass-word')).toBe('***');
    expect(again.values(TARGET, ['TEST_USER_PASSWORD']).values.TEST_USER_PASSWORD).toBe('s3cret-pass-word');
    again.clear(TARGET, 'TEST_USER_PASSWORD');
    expect(again.names(TARGET)).toEqual([]);
    expect(redact('s3cret-pass-word')).toBe('s3cret-pass-word');
  });

  it('refuses a stale key, a bad name, garbage and an empty value', async () => {
    const { keys, secrets } = store();
    const ct = await seal(keys.publicKey.publicKey, 's3cret-pass-word');
    const base = { targetId: TARGET, name: 'X', keyId: keys.publicKey.keyId, ciphertext: ct };
    expect(secrets.set({ ...base, keyId: 'other' }).stored).toBe(false);
    expect(secrets.set({ ...base, name: 'bad name' }).stored).toBe(false);
    expect(secrets.set({ ...base, ciphertext: 'bm90IHJlYWw=' }).error).toMatch(/could not be decrypted/);
    expect(secrets.names(TARGET)).toEqual([]);
  });
});

describe('remote target helpers', () => {
  it('reduces URLs and host entries to plain hostnames and refuses wildcards', () => {
    expect(hostnameOf('https://Staging.Example.test:8443/app?x=1')).toBe('staging.example.test');
    expect(hostnameOf('api.example.test:9000')).toBe('api.example.test');
    expect(hostnameOf('192.168.1.14')).toBe('192.168.1.14');
    expect(hostnameOf('*.example.test')).toBeNull();
    expect(hostnameOf('not a host')).toBeNull();
    expect(
      targetHosts({ url: 'https://a.test/x', hosts: ['b.test', 'A.test', '*.c.test', 'https://d.test:1'] }),
    ).toEqual(['a.test', 'b.test', 'd.test']);
  });

  it('counts any answer below 500 (and 4xx) as reachable, a refused connection and a gateway error as not', async () => {
    const codes = [200, 401, 404, 502];
    let i = 0;
    const server = http.createServer((_q, s) => {
      s.statusCode = codes[i++ % codes.length] as number;
      s.end('x');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    expect(await probeTargetUrl(url)).toBeNull();
    expect(await probeTargetUrl(url)).toBeNull();
    expect(await probeTargetUrl(url)).toBeNull();
    expect(await probeTargetUrl(url)).toMatch(/answered 502/);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probeTargetUrl(url)).toMatch(/ECONNREFUSED/);
  });
});

describe('a tester shift against a deployed target', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });
  const target = {
    id: TARGET,
    name: 'staging',
    url: 'https://staging.example.test/app',
    hosts: ['api.staging.example.test'],
    destructiveOk: false,
    secretNames: ['TEST_USER_PASSWORD', 'MISSING_ONE'],
  };
  const env = (over: Record<string, unknown> = {}) => ({
    mode: 'remote' as const,
    flakyRetry: 1,
    suites: [],
    target,
    ...over,
  });

  it('gives the tester the target address, its test accounts as a private file and exactly its hosts', async () => {
    const repo = makeRepo();
    let secretsFile = '';
    let fileMode = 0;
    let fileBody = '';
    const adapter = new ScriptedAdapter(async (input, ctl) => {
      secretsFile = input.env.AOM_ENV_SECRETS_FILE ?? '';
      fileBody = secretsFile ? readFileSync(secretsFile, 'utf8') : '';
      fileMode = secretsFile ? statSync(secretsFile).mode & 0o777 : 0;
      await ctl.post('/v1/report', {
        report: {
          kind: 'outcome',
          outcomeId: 'pass',
          note: 'ok',
          data: { summary: 'ok', commands: [], outputExcerpt: '' },
        },
      });
    });
    h = await startHarness(
      {},
      { adapters: new Map([['mock', adapter]]), probeTarget: async () => null },
      repo,
    );
    const runner = h.runner as unknown as { targetSecrets: TargetSecrets; keys: RunnerKeys };
    runner.targetSecrets.set({
      targetId: TARGET,
      name: 'TEST_USER_PASSWORD',
      keyId: runner.keys.publicKey.keyId,
      ciphertext: await seal(runner.keys.publicKey.publicKey, 's3cret-pass-word'),
    });
    const res = await h.runShift({ stage: 'test', mode: 'create', briefExtra: { environment: env() } });
    expect(res.ended.outcome).toBe('reported');
    const input = adapter.inputs[0];
    expect(input?.env.AOM_TARGET_URL).toBe('https://staging.example.test/app');
    expect(input?.env.AOM_TARGET_NAME).toBe('staging');
    expect(secretsFile).toMatch(/env\/env-secrets\.env$/);
    expect(fileMode).toBe(0o600);
    expect(fileBody).toBe('TEST_USER_PASSWORD="s3cret-pass-word"\n');
    // exactly the target's hosts, hostname level, on top of the runner's own list
    expect(input?.extraAllowedDomains).toEqual(['staging.example.test', 'api.staging.example.test']);
    // the instructions tell the tester how things work here, without a value in them
    const note = input?.instructionsMarkdown ?? '';
    expect(note).toContain('deployed target "staging"');
    expect(note).toContain('AOM_ENV_SECRETS_FILE');
    expect(note).toContain('TEST_USER_PASSWORD, MISSING_ONE');
    expect(note).toContain('NODE_USE_ENV_PROXY=1');
    expect(note).not.toContain('s3cret-pass-word');
    // a name with no value on this workstation is said once, as a status line
    expect(JSON.stringify(res.ended)).not.toContain('s3cret-pass-word');
  });

  it('turns the shift away when the target does not answer', async () => {
    const repo = makeRepo();
    h = await startHarness(
      {},
      {
        adapters: new Map([['mock', new ScriptedAdapter(async () => undefined)]]),
        probeTarget: async (url: string) => `${url}: ECONNREFUSED`,
      },
      repo,
    );
    const msg = makeShiftStart({
      stage: 'test',
      mode: 'create',
      remoteNormalized: repo.remoteNormalized,
      briefExtra: { environment: env() },
    });
    h.server.send('shift.start', msg);
    const rej = await h.server.waitFor('shift.rejected', (m) => m.shiftId === msg.shiftId, 30_000);
    expect(rej).toMatchObject({
      reason: 'environment_not_ready',
      environment: { problem: 'target_unreachable' },
    });
  });

  it('stores a test account that arrives as the env.secret.set command, and never answers with the value', async () => {
    const repo = makeRepo();
    h = await startHarness(
      {},
      { adapters: new Map([['mock', new ScriptedAdapter(async () => undefined)]]) },
      repo,
    );
    const runner = h.runner as unknown as { targetSecrets: TargetSecrets; keys: RunnerKeys };
    h.server.send('command', {
      commandId: 'c-secret',
      command: 'env.secret.set',
      payload: {
        targetId: TARGET,
        name: 'TEST_USER_PASSWORD',
        keyId: runner.keys.publicKey.keyId,
        ciphertext: await seal(runner.keys.publicKey.publicKey, 'other-value-123'),
      },
    });
    const done = await h.server.waitFor('command.result', (m) => m.commandId === 'c-secret');
    expect(done).toMatchObject({ ok: true, result: { stored: true } });
    expect(JSON.stringify(done)).not.toContain('other-value-123');
    expect(runner.targetSecrets.names(TARGET)).toEqual(['TEST_USER_PASSWORD']);
    unregisterSecret('other-value-123');
  });
});
