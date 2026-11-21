import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { BOOTSTRAP_VERIFY_JS } from '../src/cloud/bootstrap.ts';
import { createTestApp, type TestApp } from './helpers/app.ts';
import { closeAdminPool } from './helpers/db.ts';
import { FIXTURES, manifestText, minisign, OTHER_PUBKEY, TEST_PUBKEY } from './helpers/signed-release.ts';
import { until } from './helpers/world.ts';

/**
 * The Codespace bootstrap on the 1.10.0 release paths (R18-U, R21): it verifies `manifest.json` against the server's
 * trusted key, installs the tarball only when it matches the signed sha256, and keeps the manifest and signature beside
 * the unpacked version, where the runner reads the signed-release proof it sends when it enrolls and in every hello.
 */
let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
afterAll(closeAdminPool);

const VERSION = '1.10.0';

/** A release dir with a real tarball whose `aom-runner/aom-runner` records that it was started. */
function releaseDir(sigKey: 'test' | 'other' = 'test'): string {
  const dir = mkdtempSync(join(tmpdir(), 'aom-cs-release-'));
  const pkg = mkdtempSync(join(tmpdir(), 'aom-cs-pkg-'));
  mkdirSync(join(pkg, 'aom-runner'));
  const bin = join(pkg, 'aom-runner', 'aom-runner');
  writeFileSync(bin, '#!/usr/bin/env bash\necho "$@" > "$HOME/runner-started"\n');
  chmodSync(bin, 0o755);
  const tgz = join(dir, `aom-runner-${VERSION}.tgz`);
  execFileSync('tar', ['-czf', tgz, '-C', pkg, 'aom-runner']);
  const sha = createHash('sha256').update(readFileSync(tgz)).digest('hex');
  const manifest = manifestText(VERSION, sha);
  writeFileSync(join(dir, 'manifest.json'), manifest);
  writeFileSync(join(dir, 'manifest.json.minisig'), minisign(manifest, sigKey));
  return dir;
}

async function runBootstrap(dir: string) {
  t = await createTestApp({
    listen: true,
    env: { AOM_RUNNER_RELEASE_PUBKEY: TEST_PUBKEY, AOM_RUNNER_RELEASE_DIR: dir },
  });
  const base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  const script = (await t.req('GET', '/api/runner/codespaces-bootstrap.sh')).body as string;
  const home = mkdtempSync(join(tmpdir(), 'aom-cs-home-'));
  const file = join(home, 'bootstrap.sh');
  writeFileSync(file, script);
  // Async: the script talks to this process's server, which a synchronous spawn would block.
  const r = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
    const child = spawn('bash', [file], {
      env: { PATH: process.env.PATH, HOME: home, GUILDWISE_SERVER: base, CODESPACE_NAME: 'fiesta' },
    });
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stdout += d;
    });
    child.on('close', (status) => resolve({ status, stdout }));
  });
  return { r, home, target: join(home, '.aom-runner-install', VERSION) };
}

describe('the codespace bootstrap', () => {
  it('verifier: accepts the trusted key, refuses another key and a changed manifest', () => {
    const run = (pub: string, manifest: string, sig: string) =>
      spawnSync(process.execPath, ['-e', BOOTSTRAP_VERIFY_JS, pub, manifest, sig]).status;
    const m = join(FIXTURES, 'manifest.json');
    expect(run(TEST_PUBKEY, m, join(FIXTURES, 'manifest.json.minisig'))).toBe(0);
    expect(run(OTHER_PUBKEY, m, join(FIXTURES, 'manifest.json.minisig'))).not.toBe(0);
    expect(run(TEST_PUBKEY, m, join(FIXTURES, 'manifest.json.other.minisig'))).not.toBe(0);
    const changed = join(mkdtempSync(join(tmpdir(), 'aom-cs-')), 'manifest.json');
    writeFileSync(changed, readFileSync(m, 'utf8').replace('1.10.0', '1.10.1'));
    expect(run(TEST_PUBKEY, changed, join(FIXTURES, 'manifest.json.minisig'))).not.toBe(0);
  });

  it('installs the signed release from the new paths and keeps the proof beside it', async () => {
    const dir = releaseDir();
    const { r, home, target } = await runBootstrap(dir);
    expect(r.stdout).toContain('runner started');
    expect(r.status).toBe(0);
    expect(readFileSync(join(target, 'manifest.json'), 'utf8')).toBe(
      readFileSync(join(dir, 'manifest.json'), 'utf8'),
    );
    expect(readFileSync(join(target, 'manifest.json.minisig'), 'utf8')).toBe(
      readFileSync(join(dir, 'manifest.json.minisig'), 'utf8'),
    );
    await until(async () => existsSync(join(home, 'runner-started')), 10_000, 'the runner to start');
    expect(readFileSync(join(home, 'runner-started'), 'utf8')).toContain('up --server');
  });

  it('installs nothing when the signature is by another key', async () => {
    const { r, target } = await runBootstrap(releaseDir('other'));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('signature does not verify');
    expect(existsSync(target)).toBe(false);
  });
});
