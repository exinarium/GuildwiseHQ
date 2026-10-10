import { webcrypto } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RightsReportSchema, uuidv7 } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { unregisterSecret } from '../src/secrets/redact.ts';
import type { ExecResult, Executor } from '../src/toolchain/exec.ts';
import { realExecutor } from '../src/toolchain/exec.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, makeRepo } from './helpers.ts';

cleanupTmp();

let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const PASSWORD = 'hunter2-but-longer';
afterEach(() => unregisterSecret(PASSWORD));

async function encrypt(publicKeyB64: string, text: string): Promise<string> {
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

/** Everything except git and sudo answers "not found"; sudo accepts PASSWORD on stdin. */
const machine = (calls: string[]): Executor => ({
  async run(cmd, args, o): Promise<ExecResult> {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'git') return realExecutor.run(cmd, args, o);
    if (cmd === 'sudo' && args.includes('-S'))
      return o?.input?.trim() === PASSWORD
        ? { exitCode: 0, stdout: '', stderr: '' }
        : { exitCode: 1, stdout: '', stderr: 'Sorry, try again.' };
    if (cmd === 'sudo') return { exitCode: 1, stdout: '', stderr: 'sudo: a password is required' };
    if (cmd === 'docker')
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'permission denied while trying to connect to the Docker daemon socket',
      };
    return { exitCode: 127, stdout: '', stderr: 'not found' };
  },
});

const send = (command: string, payload: Record<string, unknown>) => {
  const commandId = uuidv7();
  h?.server.send('command', { commandId, command, payload });
  return h?.server.waitFor('command.result', (m) => m.commandId === commandId, 30_000);
};

describe('DevOps workstation setup commands', () => {
  it('hello announces the key the sudo password is encrypted with', async () => {
    h = await startHarness();
    const hello = h.server.received.find((m) => m.type === 'hello') as {
      sudoKey?: { keyId: string; publicKey: string };
    };
    expect(hello.sudoKey?.keyId).toBe(h.runner.keys.publicKey.keyId);
    expect(hello.sudoKey?.publicKey).toBe(h.runner.keys.publicKey.publicKey);
  });

  it('sudo.set stores the password, verifies it, and the answer, the log and the frames never contain it', async () => {
    const calls: string[] = [];
    h = await startHarness({}, { executor: machine(calls), platform: 'linux' });
    const ciphertext = await encrypt(h.runner.keys.publicKey.publicKey, PASSWORD);
    const res = await send('sudo.set', { ciphertext, keyId: h.runner.keys.publicKey.keyId });
    expect(res).toMatchObject({ ok: true, result: { stored: true, works: true } });
    expect(existsSync(join(h.dataDir, 'secrets', 'sudo.enc'))).toBe(true);
    expect(JSON.stringify(h.server.received)).not.toContain(PASSWORD);
    expect(calls.join('\n')).not.toContain(PASSWORD);

    // rights.verify sees the stored password
    const rights = await send('rights.verify', {
      access: { allowInstall: false, allowDocker: true, allowedPaths: [], sudo: true },
    });
    const report = (
      rights as {
        result: {
          checks: Record<string, { status: string; reason: string; fix?: string }>;
          sudoPasswordStored: boolean;
        };
      }
    ).result;
    expect(report.sudoPasswordStored).toBe(true);
    expect(report.checks.sudo).toMatchObject({
      status: 'verified',
      reason: 'sudo works with the stored password',
    });
    expect(report.checks.docker?.status).toBe('failed');
    expect(report.checks.docker?.fix).toContain('usermod -aG docker');
    expect(report.checks.install).toBeUndefined(); // a right that is off is not checked
    expect(JSON.stringify(h.server.received)).not.toContain(PASSWORD);

    expect(await send('sudo.clear', {})).toMatchObject({ ok: true, result: { cleared: true } });
    expect(existsSync(join(h.dataDir, 'secrets', 'sudo.enc'))).toBe(false);
  });

  it('rights.verify answers a report the server accepts, and an error (never silence) for a bad payload', async () => {
    h = await startHarness({}, { executor: machine([]), platform: 'linux' });
    const res = (await send('rights.verify', {
      access: { allowInstall: false, allowDocker: true, allowedPaths: [], sudo: false },
    })) as { ok: boolean; result: unknown };
    expect(res.ok).toBe(true);
    expect(RightsReportSchema.safeParse(res.result).success).toBe(true);

    const bad = await send('rights.verify', { access: 'nope' });
    expect(bad).toMatchObject({ ok: false });
    expect((bad as { error?: string }).error).toBeTruthy();
  });

  it('sudo.set with ciphertext for another key is refused', async () => {
    h = await startHarness({}, { executor: machine([]) });
    const res = await send('sudo.set', { ciphertext: 'AAAA', keyId: 'ffffffffffffffff' });
    expect(res).toMatchObject({ ok: true, result: { stored: false } });
  });

  it('repo.clone clones a remote into the repository folder and the runner knows the clone at once', async () => {
    const mine = makeRepo();
    h = await startHarness({}, {}, mine);
    const other = makeRepo();
    const res = await send('repo.clone', {
      requestId: uuidv7(),
      repoId: uuidv7(),
      projectId: uuidv7(),
      projectKey: 'TOY',
      projectName: 'Toy',
      name: 'other',
      remoteUrl: other.origin,
    });
    expect(res).toMatchObject({ ok: true, result: { ok: true, state: 'cloned' } });
    expect(existsSync(join(mine.scanRoot, 'origin', 'README.md'))).toBe(true);
    // an `repos.report` follows so the server can match the new clone
    await h.server.waitFor(
      'repos.report',
      (m) => m.repos.some((r) => r.localPath.endsWith(join('work', 'origin'))),
      10_000,
    );
  });

  it('env.ensure reports the stacks of the clone and what is missing', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo.clone, 'go.mod'), 'module x\n\ngo 1.22\n');
    h = await startHarness({}, { executor: machine([]), platform: 'linux' }, repo);
    const res = (await send('env.ensure', {
      requestId: uuidv7(),
      projectId: uuidv7(),
      repos: [{ repoId: uuidv7(), name: 'toy', remoteUrlNormalized: repo.remoteNormalized }],
      access: { allowInstall: false, allowDocker: false, allowedPaths: [], sudo: false },
    })) as {
      result: {
        state: string;
        stacks: Array<{ id: string }>;
        tools: Array<{ tool: string; status: string }>;
      };
    };
    expect(res.result.state).toBe('needs_access');
    expect(res.result.stacks).toEqual([{ id: 'go', name: 'Go', repo: 'toy' }]);
    expect(res.result.tools).toMatchObject([{ tool: 'Go', status: 'needs_access' }]);
    expect(existsSync(join(h.dataDir, 'logs', 'env'))).toBe(true);
  });
});
