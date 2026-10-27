import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBundleFromDir } from '../src/delivery/bundle.ts';
import { DEPLOY_LINE, parseEnvFile } from '../src/delivery/exec.ts';
import { deliveryWorld, FOLDER, P5_FIXTURE } from './delivery-fixture.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

const FIXTURE_HASH = readBundleFromDir(P5_FIXTURE).hash;
const PASSWORD = 'hunter2-very-secret';

/** A world with the P5 fixture committed and the admin password set. */
async function ready(over: Parameters<typeof deliveryWorld>[0] = {}) {
  const w = await deliveryWorld(over);
  const commit = w.commitRecipe();
  await w.vaults.syncNow('v1');
  w.secrets.P5_ADMIN_PASSWORD = PASSWORD;
  return { w, commit, payload: (o = {}) => w.payload({ vaultCommit: commit, hash: FIXTURE_HASH, ...o }) };
}

describe('deploy.exec (docs/design/ceo-front-door.md 9.5)', () => {
  it('runs a P5-shaped recipe: secret injected, redacted in the log, log health check, smoke, the AOM-DEPLOY line', async () => {
    const { w, payload } = await ready();
    const r = await w.exec.run(payload());
    expect(r).toMatchObject({
      outcome: 'succeeded',
      exitCode: 0,
      hash: FIXTURE_HASH,
      health: { ok: true },
      smoke: { ok: true },
      deployed: { commit: 'abc1234', url: 'http://localhost:5500' },
    });
    // the script printed the password; neither the answer nor the log holds it
    expect(r.logTail).toContain('P5 DEPLOY READY abc1234');
    expect(r.logTail).not.toContain(PASSWORD);
    expect(r.logTail).toContain('***');
    const log = readFileSync(
      join(w.paths.logs, 'deploys', '019da000-0000-7000-8000-0000000000aa.log'),
      'utf8',
    );
    expect(log).not.toContain(PASSWORD);
    expect(w.sent.map((m) => (m.payload as { phase: string }).phase)).toEqual(['started', 'health', 'smoke']);
  });

  it('refuses when the hash of what it exports is not the approved hash, and runs nothing', async () => {
    const { w, payload } = await ready();
    const r = await w.exec.run(payload({ hash: 'b'.repeat(64) }));
    expect(r).toMatchObject({ outcome: 'refused', refused: 'hash_mismatch', hash: FIXTURE_HASH });
    expect(w.sent).toEqual([]);
    expect(existsSync(join(w.paths.logs, 'deploys'))).toBe(false);
  });

  it('is pinned to the approved vault commit: a recipe edited afterwards is not what runs, and its new hash is refused at the old commit', async () => {
    const { w, commit, payload } = await ready();
    const edited = w.commitRecipe((d) =>
      writeFileSync(join(d, 'scripts', 'local.sh'), '#!/usr/bin/env bash\necho "P5 DEPLOY READY evil"\n', {
        mode: 0o755,
      }),
    );
    await w.vaults.syncNow('v1');
    const ok = await w.exec.run(payload({ runId: '019da000-0000-7000-8000-0000000000b1' }));
    expect(ok.outcome).toBe('succeeded');
    expect(ok.logTail).not.toContain('evil');
    // the edited files were never approved: asking for the OLD commit with the NEW hash refuses
    const newHash = readBundleFromDir(join(w.vaults.dir('v1'), FOLDER, 'delivery')).hash;
    expect(newHash).not.toBe(FIXTURE_HASH);
    const bad = await w.exec.run(payload({ runId: '019da000-0000-7000-8000-0000000000b2', hash: newHash }));
    expect(bad).toMatchObject({ outcome: 'refused', refused: 'hash_mismatch' });
    expect(edited).not.toBe(commit);
  });

  it('refuses a commit the vault does not have, and an expired command', async () => {
    const { w, payload } = await ready();
    expect(
      await w.exec.run(
        payload({ runId: '019da000-0000-7000-8000-0000000000c1', vaultCommit: 'f'.repeat(40) }),
      ),
    ).toMatchObject({
      outcome: 'refused',
      refused: 'commit_unavailable',
    });
    expect(
      await w.exec.run(
        payload({
          runId: '019da000-0000-7000-8000-0000000000c2',
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
      ),
    ).toMatchObject({ outcome: 'refused', refused: 'expired' });
  });

  it('refuses an unknown environment and a target the recipe does not name', async () => {
    const { w, payload } = await ready();
    expect(
      await w.exec.run(payload({ runId: '019da000-0000-7000-8000-0000000000d1', env: 'staging' })),
    ).toMatchObject({ refused: 'unknown_env' });
    expect(
      await w.exec.run(
        payload({
          runId: '019da000-0000-7000-8000-0000000000d2',
          target: { id: null, name: 'someone-elses', kind: 'local_docker', host: null, appUrl: null },
        }),
      ),
    ).toMatchObject({ refused: 'target_not_in_recipe' });
  });

  it('a missing secret refuses the run and names it; the env file fills what the store lacks', async () => {
    const { w, payload } = await ready();
    delete w.secrets.P5_ADMIN_PASSWORD;
    expect(await w.exec.run(payload({ runId: '019da000-0000-7000-8000-0000000000e1' }))).toMatchObject({
      outcome: 'refused',
      refused: 'missing_secret:P5_ADMIN_PASSWORD',
    });
    // the recipe's envFile is a path on the workstation
    const envFile = join(tmp('aom-envfile-'), 'local.env');
    writeFileSync(envFile, `# stack settings\nexport P5_ADMIN_PASSWORD="from-file-secret"\nOTHER=1\n`);
    const { w: w2, commit } = await ready();
    delete w2.secrets.P5_ADMIN_PASSWORD;
    const c2 = w2.commitRecipe((d) => {
      const f = join(d, 'recipe.yaml');
      writeFileSync(f, readFileSync(f, 'utf8').replace('~/.config/guildwise/p5/local.env', envFile));
    });
    await w2.vaults.syncNow('v1');
    const hash = readBundleFromDir(join(w2.vaults.dir('v1'), FOLDER, 'delivery')).hash;
    const r = await w2.exec.run(
      w2.payload({ vaultCommit: c2, hash, runId: '019da000-0000-7000-8000-0000000000e2' }),
    );
    expect(r.outcome).toBe('succeeded');
    expect(r.logTail).not.toContain('from-file-secret');
    expect(commit).toBeTruthy();
    expect(parseEnvFile('A=1\n# B=2\nexport C="x y"\n')).toEqual({ A: '1', C: 'x y' });
  });

  it('a script that exits non-zero, or runs past its deadline, fails with the tail of its log', async () => {
    const { w, payload } = await ready();
    delete w.secrets.P5_ADMIN_PASSWORD; // local.sh then exits 1: "P5_ADMIN_PASSWORD is not set" (via an env file that holds an empty one)
    const c = w.commitRecipe((d) => {
      writeFileSync(
        join(d, 'scripts', 'local.sh'),
        '#!/usr/bin/env bash\necho "step 1 ok"\necho "boom: the registry refused us" >&2\nexit 3\n',
        { mode: 0o755 },
      );
    });
    await w.vaults.syncNow('v1');
    const hash = readBundleFromDir(join(w.vaults.dir('v1'), FOLDER, 'delivery')).hash;
    w.secrets.P5_ADMIN_PASSWORD = PASSWORD;
    const failed = await w.exec.run(
      payload({ vaultCommit: c, hash, runId: '019da000-0000-7000-8000-0000000000f1' }),
    );
    expect(failed).toMatchObject({ outcome: 'failed', exitCode: 3, summary: 'the script exited with 3' });
    expect(failed.logTail).toContain('boom: the registry refused us');
    // a deadline: the whole process group is killed
    const slow = w.commitRecipe((d) => {
      writeFileSync(join(d, 'scripts', 'local.sh'), '#!/usr/bin/env bash\nsleep 30 &\nwait\n', {
        mode: 0o755,
      });
    });
    await w.vaults.syncNow('v1');
    const slowHash = readBundleFromDir(join(w.vaults.dir('v1'), FOLDER, 'delivery')).hash;
    const t0 = Date.now();
    const timedOut = await (async () => {
      const { DeployExecutor } = await import('../src/delivery/exec.ts');
      const quick = new DeployExecutor({
        paths: w.paths,
        vaults: w.vaults,
        secrets: { valuesFor: () => ({ values: { P5_ADMIN_PASSWORD: PASSWORD }, missing: [] }) },
        findRepo: async () => undefined,
        send: () => undefined,
        baseEnv: { PATH: process.env.PATH ?? '' },
        timing: { timeoutMs: 300, killGraceMs: 50, graceMs: 0, healthPollMs: 10, healthTimeoutSec: 1 },
      });
      return quick.run(
        payload({ vaultCommit: slow, hash: slowHash, runId: '019da000-0000-7000-8000-0000000000f2' }),
      );
    })();
    expect(timedOut.outcome).toBe('failed');
    expect(timedOut.summary).toContain('did not finish');
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('health: a log pattern that never appears fails; an http check polls until it is 2xx; a failing smoke script fails', async () => {
    const { w, payload } = await ready();
    const noReady = w.commitRecipe((d) => {
      writeFileSync(join(d, 'scripts', 'local.sh'), '#!/usr/bin/env bash\necho "deploying"\n', {
        mode: 0o755,
      });
    });
    await w.vaults.syncNow('v1');
    const h1 = readBundleFromDir(join(w.vaults.dir('v1'), FOLDER, 'delivery')).hash;
    const r1 = await w.exec.run(
      payload({ vaultCommit: noReady, hash: h1, runId: '019da000-0000-7000-8000-000000000101' }),
    );
    expect(r1).toMatchObject({ outcome: 'failed', health: { ok: false } });
    expect(r1.summary).toContain('health check failed');

    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(null, { status: calls < 3 ? 503 : 200 });
    }) as unknown as typeof fetch;
    const w2 = await deliveryWorld({ fetchImpl });
    w2.secrets.P5_PROD_DEPLOY_KEY = 'prod-key-1234';
    const c2 = w2.commitRecipe();
    await w2.vaults.syncNow('v1');
    const prod = await w2.exec.run(
      w2.payload({
        env: 'production',
        vaultCommit: c2,
        hash: FIXTURE_HASH,
        target: {
          id: null,
          name: 'p5-prod',
          kind: 'remote_ssh',
          host: 'prod',
          appUrl: 'https://p5.example.com',
        },
        runId: '019da000-0000-7000-8000-000000000102',
      }),
    );
    expect(prod).toMatchObject({ outcome: 'succeeded', health: { ok: true } });
    expect(calls).toBe(3);
    expect(prod.logTail).not.toContain('prod-key-1234');

    const badSmoke = w.commitRecipe((d) => {
      writeFileSync(
        join(d, 'scripts', 'smoke-local.sh'),
        '#!/usr/bin/env bash\necho "login page is blank"\nexit 1\n',
        { mode: 0o755 },
      );
    });
    await w.vaults.syncNow('v1');
    const h3 = readBundleFromDir(join(w.vaults.dir('v1'), FOLDER, 'delivery')).hash;
    const r3 = await w.exec.run(
      payload({ vaultCommit: badSmoke, hash: h3, runId: '019da000-0000-7000-8000-000000000103' }),
    );
    expect(r3).toMatchObject({ outcome: 'failed', health: { ok: true }, smoke: { ok: false } });
    expect(r3.logTail).toContain('login page is blank');
  });

  it('a dry run sets AOM_DEPLOY_DRY_RUN=1 and skips health and smoke', async () => {
    const { w, payload } = await ready();
    const r = await w.exec.run(payload({ dryRun: true, runId: '019da000-0000-7000-8000-000000000111' }));
    expect(r).toMatchObject({ outcome: 'succeeded', health: null, smoke: null });
    expect(r.logTail).toContain('dry run: would deploy');
    expect(r.logTail).not.toContain('P5 DEPLOY READY');
    expect(w.sent.map((m) => (m.payload as { phase: string }).phase)).toEqual(['started']);
  });

  it('a command delivered twice runs once: the second answer is the first', async () => {
    const { w, payload } = await ready();
    const [a, b] = await Promise.all([w.exec.run(payload()), w.exec.run(payload())]);
    expect(b).toEqual(a);
    expect(w.sent.filter((m) => (m.payload as { phase: string }).phase === 'started')).toHaveLength(1);
    // after it finished (a reconnect, a restart) the stored result is returned, nothing runs again
    const again = await w.exec.run(payload());
    expect(again).toEqual(a);
    expect(w.sent.filter((m) => (m.payload as { phase: string }).phase === 'started')).toHaveLength(1);
  });

  it('a local vault: the folder is read, copied and hashed; the copy is what runs', async () => {
    const w = await deliveryWorld({ storage: 'local' });
    const dest = join(w.vaults.localDir('v1'), FOLDER, 'delivery');
    mkdirSync(dest, { recursive: true });
    const { cpSync } = await import('node:fs');
    cpSync(P5_FIXTURE, dest, { recursive: true });
    w.secrets.P5_ADMIN_PASSWORD = PASSWORD;
    const ok = await w.exec.run(
      w.payload({ hash: FIXTURE_HASH, runId: '019da000-0000-7000-8000-000000000121' }),
    );
    expect(ok.outcome).toBe('succeeded');
    // the owner edits the folder: the approved hash no longer matches
    writeFileSync(join(dest, 'scripts', 'smoke-local.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    expect(
      await w.exec.run(w.payload({ hash: FIXTURE_HASH, runId: '019da000-0000-7000-8000-000000000122' })),
    ).toMatchObject({
      refused: 'hash_mismatch',
    });
  });
});

describe('deploy marker line', () => {
  it('accepts the current AOM-DEPLOY marker and the new GUILDWISE-DEPLOY marker', () => {
    const json = '{"commit":"abc1234","url":"http://localhost:5500","version":"v1"}';
    for (const name of ['AOM-DEPLOY', 'GUILDWISE-DEPLOY']) {
      const m = DEPLOY_LINE.exec(`${name} ${json}`);
      expect(m?.[1], name).toBe(json);
    }
    expect(DEPLOY_LINE.exec(`OTHER-DEPLOY ${json}`)).toBeNull();
  });
});
