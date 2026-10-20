import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readBundleFromDir } from '../src/delivery/bundle.ts';
import { redactSecrets } from '../src/secrets/redact.ts';
import { deliveryWorld, FOLDER } from './delivery-fixture.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp } from './helpers.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});
const RUN = '019da000-0000-7000-8000-0000000000aa';

/** A recipe whose script waits for a file, so a test can look at the runner while the deploy is in flight. */
async function slowWorld() {
  const w = await deliveryWorld();
  const gate = join(w.root, 'release-the-script');
  const commit = w.commitRecipe((d) => {
    writeFileSync(
      join(d, 'scripts', 'local.sh'),
      `#!/usr/bin/env bash\nwhile [ ! -e "${gate}" ]; do sleep 0.05; done\necho "P5 DEPLOY READY abc1234"\n`,
      { mode: 0o755 },
    );
  });
  await w.vaults.syncNow('v1');
  const hash = readBundleFromDir(join(w.vaults.dir('v1'), FOLDER, 'delivery')).hash;
  w.secrets.P5_ADMIN_PASSWORD = 'pw-for-this-test';
  return { w, gate, payload: (o = {}) => w.payload({ vaultCommit: commit, hash, ...o }) };
}

describe('a running deploy and a runner restart (pre-production review S2)', () => {
  it('writes started.json before the script spawns, and counts the deploy as in flight until it ends', async () => {
    const { w, gate, payload } = await slowWorld();
    const p = w.exec.run(payload());
    const marker = join(w.paths.root, 'deploys', RUN, 'started.json');
    const t0 = Date.now();
    while (!existsSync(marker) && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(marker)).toBe(true);
    expect(w.exec.inFlight()).toBe(1);
    writeFileSync(gate, '');
    expect((await p).outcome).toBe('succeeded');
    expect(w.exec.inFlight()).toBe(0);
  });

  it('a redelivery after a restart (marker, no result) answers failed: interrupted and runs nothing', async () => {
    const { w, payload } = await slowWorld();
    const dir = join(w.paths.root, 'deploys', RUN);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'started.json'), JSON.stringify({ runId: RUN }));
    const r = await w.exec.run(payload());
    expect(r.outcome).toBe('failed');
    expect(r.summary).toContain('interrupted');
    expect(w.sent).toEqual([]); // no `started` progress: the script was not spawned
    // and it keeps answering the same
    expect(await w.exec.run(payload())).toEqual(r);
  });

  it('the runner is not idle while a deploy is in flight', async () => {
    h = await startHarness();
    expect(h.runner.isIdle()).toBe(true);
    const real = h.runner.deployExec.inFlight.bind(h.runner.deployExec);
    h.runner.deployExec.inFlight = () => 1;
    expect(h.runner.isIdle()).toBe(false);
    h.runner.deployExec.inFlight = real;
    expect(h.runner.isIdle()).toBe(true);
  });

  it('announces local-vault:1 (0.1.32 understands local vaults and the graph commands)', async () => {
    h = await startHarness();
    expect(h.server.of('hello')[0]?.capabilities).toContain('local-vault:1');
  });
});

describe('deploy log redaction (S3)', () => {
  it('masks common secret shapes nobody registered', () => {
    const text = [
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----',
      'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'aws AKIAABCDEFGHIJKLMNOP',
      'Authorization: Bearer abcdef0123456789abcdef',
      'DB_PASSWORD=correct-horse-battery',
      'clone https://user:hunter2@example.com/repo.git',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig',
      'plain line stays',
    ].join('\n');
    const out = redactSecrets(text);
    for (const leak of [
      'b3BlbnNz',
      'ghp_abc',
      'AKIAABCDEF',
      'abcdef0123456789abcdef',
      'correct-horse',
      'hunter2',
      'eyJzdWIi',
    ])
      expect(out).not.toContain(leak);
    expect(out).toContain('plain line stays');
  });
});
