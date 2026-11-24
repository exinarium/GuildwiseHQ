import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requestDeployRun } from '../src/delivery/runs.ts';
import { keptForRollback, signingGate } from '../src/delivery/signing-gate.ts';
import { PREPARE_TTL_MS } from '../src/release/signing.ts';
import { keepOnline } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import {
  type DeliveryWorld,
  deliveryWorld,
  mergeLanded,
  parseFixture,
  setWeekday,
} from './helpers/delivery.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { resealSessions } from './helpers/sessions.ts';
import { ok, until } from './helpers/world.ts';

/**
 * Release signing per deploy target (R30): a target with `signing.required` deploys only a shipped release whose runner,
 * packaged for that target with its public key, carries a signature by that target's key. Signatures come from the
 * workstation that holds the key (a held `release.sign`) or are uploaded after an offline signing, and the server verifies
 * each one against the target's public key and the packaged bytes before it counts. Only the public halves of the W0 test
 * key fixtures are read here, with signatures W0 made beforehand.
 */
const FIX = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'runner',
  'test',
  'fixtures',
  'minisign',
);
const fixture = (name: string) => readFileSync(join(FIX, name), 'utf8');
const TEST_PUB = fixture('test.pub'); // key id 8399E5B65A3876B0
const OTHER_PUB = fixture('other.pub'); // key id F0D6288B1CBE00A7
const MANIFEST = fixture('manifest.json');
const SIG = fixture('manifest.json.minisig'); // by test.key over MANIFEST
const OTHER_SIG = fixture('manifest.json.other.minisig'); // by other.key over MANIFEST
const TAMPERED = `${MANIFEST}\n`; // another file, so another sha256
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const TEST_KEY_ID = '8399E5B65A3876B0';

const COMMIT = 'abc1234def5678abc1234def5678abc1234def56';
const COMMIT2 = 'fed9876cba5432fed9876cba5432fed9876cba54';
const COMMIT3 = '0123456789abcdef0123456789abcdef01234567';
let d: DeliveryWorld;
let r: FakeRunner;
let release1: string;
let REPO_URL: string;
let release2: string;

beforeAll(async () => {
  d = await deliveryWorld();
  r = await d.w.connectRunner({ capabilities: ['ceo:1', 'delivery:1'] });
  await keepOnline(d.w);
  await setWeekday(d);
  await mergeLanded(d, COMMIT); // the commit the tests deploy was really merged
  REPO_URL = (await q('SELECT remote_url_normalized FROM project_repos WHERE id=$1', [d.w.repoId]))[0]!
    .remote_url_normalized;
  expect(REPO_URL).toBeTruthy();
  const o = await d.observe(parseFixture(), { commit: '9999999aaaaaaa' });
  await ok(d.approve(o.hash));
  await ok(
    d.w.t.req('PUT', `/api/projects/${d.w.projectId}/delivery/mode`, {
      cookie: d.w.owner.cookie,
      body: { mode: 'recipe' },
    }),
  );
});
afterAll(async () => {
  r.close();
  await d.w.t.close();
  await closeAdminPool();
});

const call = (method: string, url: string, body?: unknown, cookie = d.w.owner.cookie) =>
  d.w.t.req(method, url, {
    cookie,
    headers: { 'x-aom-org': d.orgId },
    ...(body === undefined ? {} : { body }),
  });
/** The owner's session proved its password just now (as after "Confirm it's you"). */
const freshStepUp = async () => {
  await q('UPDATE auth_sessions SET second_factor_at=$2 WHERE user_id=$1', [d.w.owner.id, d.w.t.clock.now()]);
  await resealSessions(d.w.t.app.ctx, d.w.owner.id);
};
const base = () => `/api/projects/${d.w.projectId}/release-signing`;
const target = () => d.targets.local; // p5-local, the target of the `local` environment
const status = async (commit: string) =>
  (await ok(call('GET', `${base()}?env=local&commit=${commit}`))).targets[0];
const deploy = (commit = COMMIT) =>
  call('POST', `/api/projects/${d.w.projectId}/delivery/deploy`, { env: 'local', commit });
const cmds = (name: string) => r.of('command').filter((c) => c.command === name);
const ship = async (commit: string, version: string) => {
  const id = randomUUID();
  await q(
    `INSERT INTO release_ships (id, org_id, project_id, repo_id, version, tag, release_date, payload, status, commit_sha, created_at, updated_at)
     SELECT $1, org_id, id, $3, $4, 'v' || $4, current_date, '{}'::jsonb, 'committed', $5, now(), now() FROM projects WHERE id=$2`,
    [id, d.w.projectId, d.w.repoId, version, commit],
  );
  return id;
};
const artefact = (releaseId: string) =>
  q('SELECT * FROM release_artefacts WHERE release_id=$1 AND target_id=$2', [releaseId, target()]);
/** Asks for a packaging and waits until that command reached the runner; returns its id. */
const packageFor = async (commit: string) => {
  const before = cmds('release.prepare').length;
  await ok(call('POST', `${base()}/prepare`, { targetId: target(), commit }), 202);
  await until(
    async () => cmds('release.prepare').length === before + 1,
    4000,
    'release.prepare reached the runner',
  );
  return cmds('release.prepare')[before]!.commandId as string;
};
const cmdRow = async (id: string) => (await q('SELECT * FROM runner_commands WHERE id=$1', [id]))[0]!;
const prepared = (releaseId: string, manifest: string, over: Record<string, unknown> = {}) =>
  r.send('release.artefact.prepared', {
    releaseId,
    targetId: target(),
    artefactSha256: sha(manifest),
    version: '1.10.0',
    manifest,
    ...over,
  });

describe('the key a target trusts', () => {
  it('only the project Owner sets it, from the public key; a key that is not a minisign public key is refused', async () => {
    await freshStepUp();
    // org Owners and Admins are project owners (decision D6); a Member is not, and never sees the target's project
    const member = await d.member();
    const denied = await call(
      'PUT',
      `/api/deploy-targets/${target()}/signing`,
      { signing: { required: true, publicKey: TEST_PUB } },
      member.cookie,
    );
    expect(denied.status).toBe(404);
    const bad = await call('PUT', `/api/deploy-targets/${target()}/signing`, {
      signing: { required: true, publicKey: 'untrusted comment: minisign encrypted secret key\nRWRTY0Iy' },
    });
    expect(bad.status).toBe(422);
    const wrongId = await call('PUT', `/api/deploy-targets/${target()}/signing`, {
      signing: { required: true, publicKey: TEST_PUB, keyId: 'F0D6288B1CBE00A7' },
    });
    expect(wrongId.body.error.code).toBe('key_id_mismatch');
    const set = await ok(
      call('PUT', `/api/deploy-targets/${target()}/signing`, {
        signing: { required: true, publicKey: TEST_PUB },
      }),
    );
    expect(set.signing).toEqual({
      required: true,
      keyId: TEST_KEY_ID,
      publicKey: TEST_PUB.trim().split('\n')[1],
      artefact: 'release/manifest.json',
    });
    const [row] = await q('SELECT signing FROM deploy_targets WHERE id=$1', [target()]);
    expect(row!.signing).toMatchObject({ required: true, keyId: TEST_KEY_ID });
    expect(await q(`SELECT 1 FROM events WHERE type='DeployTargetSigningSet'`)).toHaveLength(1);
  });
});

describe('a deploy to a required target waits for the signature', () => {
  it('a commit that is not a shipped release is refused with 409 runner_signature_required', async () => {
    const res = await deploy();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('runner_signature_required');
    expect(res.body.error.message).toContain('not a shipped release');
    // an automatic trigger gets the refusal as an outcome (recorded), never a thrown error
    const auto = await requestDeployRun(d.w.t.app.ctx, {
      projectId: d.w.projectId,
      env: 'local',
      commit: COMMIT,
      trigger: 'after_merge',
      requester: { kind: 'trigger', id: null, name: 'after_merge', provenance: 'trigger' },
    });
    expect(auto.runs[0]).toMatchObject({ status: 'refused', refusal: 'runner_signature_required' });
    expect(cmds('deploy.exec')).toHaveLength(0);
  });

  it('a shipped release that is not packaged and signed is refused too, and the sheet says what is missing', async () => {
    release1 = await ship(COMMIT, '1.10.0');
    expect(await status(COMMIT)).toMatchObject({
      targetName: 'p5-local',
      state: 'not_prepared',
      artefact: 'release/p5-local/manifest.json',
      signing: { required: true, keyId: TEST_KEY_ID },
    });
    const res = await deploy();
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain(`sign it (key ${TEST_KEY_ID})`);
    // a target without signing says so
    const plain = await ok(call('GET', `${base()}?env=production&commit=${COMMIT}`));
    expect(plain.targets[0]).toMatchObject({ targetName: 'p5-prod', state: 'not_required', signing: null });
  });
});

describe('packaging the runner for the target', () => {
  it('release.prepare goes to the deploying workstation with the public key, never a secret key', async () => {
    const res = await call('POST', `${base()}/prepare`, { targetId: target(), commit: COMMIT });
    expect(res.status).toBe(202);
    await until(async () => cmds('release.prepare').length === 1, 4000, 'release.prepare reached the runner');
    const p = cmds('release.prepare')[0]!.payload as Record<string, unknown>;
    expect(p).toEqual({
      releaseId: release1,
      targetId: target(),
      targetName: 'p5-local',
      projectName: expect.any(String),
      version: '1.10.0',
      repoId: d.w.repoId,
      remoteUrlNormalized: REPO_URL,
      commit: COMMIT,
      keyId: TEST_KEY_ID,
      publicKey: TEST_PUB.trim().split('\n')[1],
      artefact: 'release/p5-local/manifest.json',
    });
    expect(JSON.stringify(p)).not.toMatch(/secret key/i);
    expect((await status(COMMIT)).state).toBe('preparing');
  });

  it('a report is recorded only for a prepare this workstation was sent, with the manifest it hashes', async () => {
    const [first] = cmds('release.prepare');
    prepared(release1, MANIFEST, { targetId: d.targets.prod }); // never asked for that target: ignored
    // a report that does not hash ends that prepare with the reason (the sheet shows it, not "not prepared")
    prepared(release1, MANIFEST, { artefactSha256: sha('something else') });
    await until(
      async () => (await status(COMMIT)).state === 'prepare_failed',
      4000,
      'bad hash fails the prepare',
    );
    expect(await status(COMMIT)).toMatchObject({
      error: 'the manifest does not hash to the reported sha256',
    });
    expect((await cmdRow(first!.commandId)).status).toBe('failed');
    // so does one without the manifest text
    await packageFor(COMMIT);
    prepared(release1, MANIFEST, { manifest: undefined });
    await until(async () => (await status(COMMIT)).error?.includes('no manifest'), 4000, 'no manifest');
    // the tampered manifest is recorded (a valid report): the upload test below refuses a signature over another file
    const cmd = await packageFor(COMMIT);
    prepared(release1, TAMPERED);
    await until(async () => (await artefact(release1)).length === 1, 4000, 'artefact recorded');
    expect(
      await q(`SELECT payload->>'artefactSha256' AS s FROM events WHERE type='ReleaseArtefactPrepared'`),
    ).toEqual([{ s: sha(TAMPERED) }]);
    // the report answered the prepare; a second report for the same, answered prepare is not taken
    expect((await cmdRow(cmd)).status).toBe('done');
    prepared(release1, MANIFEST);
    r.send('command.result', { commandId: cmd, ok: true, result: {} });
    await until(async () => (await cmdRow(cmd)).status === 'done', 4000, 'prepare done');
    expect(await status(COMMIT)).toMatchObject({ state: 'waiting_signature', artefactSha256: sha(TAMPERED) });
    expect((await deploy()).status).toBe(409);
  });
});

describe('route 2: an offline signature, uploaded', () => {
  it('an upload signed by another key or over another sha256 is refused; a valid upload unblocks the deploy', async () => {
    const url = `${base()}/signature`;
    // over another file: the signature is test.key's, but over MANIFEST, and TAMPERED is what was packaged
    const otherFile = await call('POST', url, { releaseId: release1, targetId: target(), minisig: SIG });
    expect(otherFile.status).toBe(422);
    expect(otherFile.body.error.code).toBe('signature_invalid');
    // the real artefact is packaged again
    await packageFor(COMMIT);
    prepared(release1, MANIFEST);
    await until(
      async () => (await artefact(release1))[0]?.artefact_sha256 === sha(MANIFEST),
      4000,
      'repacked',
    );
    const dl = await call('GET', `${base()}/manifest?releaseId=${release1}&targetId=${target()}`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toContain('manifest.json');
    expect(dl.headers['x-artefact-sha256']).toBe(sha(MANIFEST));
    expect(dl.body).toMatchObject({ version: '1.10.0', sha256: expect.any(String) });
    // by another key
    const otherKey = await call('POST', url, { releaseId: release1, targetId: target(), minisig: OTHER_SIG });
    expect(otherKey.status).toBe(422);
    expect(otherKey.body.error.code).toBe('signature_wrong_key');
    expect(otherKey.body.error.message).toContain('F0D6288B1CBE00A7');
    // signed over the manifest downloaded before it was packaged again
    const stale = await call('POST', url, {
      releaseId: release1,
      targetId: target(),
      minisig: SIG,
      artefactSha256: sha(TAMPERED),
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('artefact_changed');
    expect((await deploy()).status).toBe(409);
    expect(await q('SELECT 1 FROM release_signatures')).toHaveLength(0);
    // a valid one
    const good = await ok(
      call('POST', url, {
        releaseId: release1,
        targetId: target(),
        minisig: SIG,
        artefactSha256: sha(MANIFEST),
      }),
    );
    expect(good).toEqual({ state: 'signed', keyId: TEST_KEY_ID });
    const [row] = await q('SELECT * FROM release_signatures');
    expect(row).toMatchObject({
      release_id: release1,
      target_id: target(),
      key_id: TEST_KEY_ID,
      artefact_sha256: sha(MANIFEST),
      source: 'upload',
      by_user: d.w.owner.id,
    });
    expect(await status(COMMIT)).toMatchObject({
      state: 'signed',
      signature: { keyId: TEST_KEY_ID, source: 'upload' },
    });
    // the deploy goes out, and the runner gets what it verifies itself before the rest of the recipe
    const res = await ok(deploy());
    expect(res.runs[0]).toMatchObject({ status: 'queued', target: 'p5-local' });
    await until(async () => cmds('deploy.exec').length === 1, 4000, 'deploy.exec reached the runner');
    expect(cmds('deploy.exec')[0]!.payload).toMatchObject({
      commit: COMMIT,
      signing: {
        releaseId: release1,
        keyId: TEST_KEY_ID,
        publicKey: TEST_PUB.trim().split('\n')[1],
        artefact: 'release/p5-local/manifest.json',
        artefactSha256: sha(MANIFEST),
        minisig: SIG.replace(/\r\n/g, '\n'),
      },
    });
  });
});

describe('route 1: the workstation holding the key, under a local approval', () => {
  it('release.sign goes to the workstation that packaged it; its answer is verified before it counts', async () => {
    release2 = await ship(COMMIT2, '1.10.1');
    await packageFor(COMMIT2);
    prepared(release2, MANIFEST, { version: '1.10.1' });
    await until(async () => (await artefact(release2)).length === 1, 4000, 'artefact 2');
    const signUrl = `${base()}/sign`;
    // nothing to sign before it is packaged: another release id is refused
    expect((await call('POST', signUrl, { releaseId: randomUUID(), targetId: target() })).status).toBe(404);
    await ok(call('POST', signUrl, { releaseId: release2, targetId: target() }), 202);
    await until(async () => cmds('release.sign').length === 1, 4000, 'release.sign reached the runner');
    const [first] = cmds('release.sign');
    expect(first!.payload).toEqual({
      releaseId: release2,
      targetId: target(),
      targetName: 'p5-local',
      projectName: expect.any(String),
      version: '1.10.1',
      keyId: TEST_KEY_ID,
      artefact: 'release/p5-local/manifest.json',
      repoId: d.w.repoId,
      artefactSha256: sha(MANIFEST),
    });
    expect((await status(COMMIT2)).state).toBe('signing');
    // a signature by another key is not taken from the workstation either
    r.send('command.result', {
      commandId: first!.commandId,
      ok: true,
      result: { keyId: TEST_KEY_ID, artefactSha256: sha(MANIFEST), minisig: OTHER_SIG },
    });
    await until(async () => (await status(COMMIT2)).state === 'sign_failed', 4000, 'refused signature');
    expect((await status(COMMIT2)).error).toContain('F0D6288B1CBE00A7');
    // denied on the workstation
    await ok(call('POST', signUrl, { releaseId: release2, targetId: target() }), 202);
    await until(async () => cmds('release.sign').length === 2, 4000, 'second sign');
    r.send('command.result', { commandId: cmds('release.sign')[1]!.commandId, ok: false, error: 'denied' });
    await until(async () => (await status(COMMIT2)).error === 'denied', 4000, 'denied');
    // approved: the valid signature counts
    await ok(call('POST', signUrl, { releaseId: release2, targetId: target() }), 202);
    await until(async () => cmds('release.sign').length === 3, 4000, 'third sign');
    r.send('command.result', {
      commandId: cmds('release.sign')[2]!.commandId,
      ok: true,
      result: { keyId: TEST_KEY_ID, artefactSha256: sha(MANIFEST), minisig: SIG },
    });
    await until(async () => (await status(COMMIT2)).state === 'signed', 4000, 'signed on the workstation');
    expect(await status(COMMIT2)).toMatchObject({ signature: { keyId: TEST_KEY_ID, source: 'workstation' } });
    const [row] = await q('SELECT by_user FROM release_signatures WHERE release_id=$1', [release2]);
    expect(row!.by_user).toBeNull();
    expect((await call('POST', signUrl, { releaseId: release2, targetId: target() })).status).toBe(409);
  });
});

describe('rollback: the current and the previous good release stay signed (owner 2026-11-21)', () => {
  it('after N+1 deployed, N and N+1 keep their signatures; N deploys again at once and is not packaged again', async () => {
    // release1 (COMMIT) was signed and deployed above, and that deploy succeeded; release2 (COMMIT2, signed in route 1)
    // deployed successfully after it
    const [run1] = await q(
      `UPDATE deploy_runs SET status='succeeded', finished_at=$3, deployed_commit=$2 WHERE project_id=$1 AND commit=$2 RETURNING id`,
      [d.w.projectId, COMMIT, d.w.t.clock.now()],
    );
    await q(
      `INSERT INTO deploy_runs SELECT (jsonb_populate_record(NULL::deploy_runs, to_jsonb(r) ||
         jsonb_build_object('id', $2::text, 'commit', $3::text, 'deployed_commit', $3::text, 'finished_at', $4::text))).*
         FROM deploy_runs r WHERE id=$1`,
      [run1!.id, randomUUID(), COMMIT2, new Date(d.w.t.clock.now().getTime() + 60_000).toISOString()],
    );
    const pool = d.w.t.app.ctx.pool;
    expect((await keptForRollback(pool, d.w.projectId, target())).map((x) => x.id)).toEqual([
      release2,
      release1,
    ]);
    const before = (await artefact(release1))[0];
    const prepares = cmds('release.prepare').length;
    for (const commit of [COMMIT, COMMIT2]) {
      const again = await call('POST', `${base()}/prepare`, { targetId: target(), commit });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('artefact_kept_for_rollback');
      expect(again.body.error.message).toContain('needs a new signature');
    }
    expect(cmds('release.prepare')).toHaveLength(prepares);
    expect((await artefact(release1))[0]).toEqual(before);
    // the rollback to N: the gate hands out its kept signature at once
    const [row] = await q('SELECT * FROM deploy_targets WHERE id=$1', [target()]);
    expect(await signingGate(pool, d.w.projectId, row!, COMMIT)).toMatchObject({
      required: true,
      signing: { releaseId: release1, keyId: TEST_KEY_ID, artefactSha256: sha(MANIFEST) },
    });
  });

  it('when the workstation lost the files, N is packaged again on purpose and then waits for a new signature', async () => {
    const before = cmds('release.prepare').length;
    await ok(call('POST', `${base()}/prepare`, { targetId: target(), commit: COMMIT, repackage: true }), 202);
    await until(
      async () => cmds('release.prepare').length === before + 1,
      4000,
      'repackage reached the runner',
    );
    expect(cmds('release.prepare')[before]!.payload).toMatchObject({ releaseId: release1, repackage: true });
    prepared(release1, TAMPERED);
    await until(
      async () => (await artefact(release1))[0]?.artefact_sha256 === sha(TAMPERED),
      4000,
      'packaged again',
    );
    const [ev] = await q(
      `SELECT payload FROM events WHERE type='ReleaseArtefactPrepared' AND payload->>'releaseId'=$1 ORDER BY seq DESC LIMIT 1`,
      [release1],
    );
    expect(ev!.payload).toMatchObject({ repackaged: true, artefactSha256: sha(TAMPERED) });
    expect(await status(COMMIT)).toMatchObject({ state: 'waiting_signature' });
    const [row] = await q('SELECT * FROM deploy_targets WHERE id=$1', [target()]);
    expect(await signingGate(d.w.t.app.ctx.pool, d.w.projectId, row!, COMMIT)).toMatchObject({
      required: true,
      refusal: expect.stringContaining('waits for a signature'),
    });
    // back to the state the next tests expect: release2's deploy undone, release1 packaged as MANIFEST (signed) again
    await q(`DELETE FROM deploy_runs WHERE project_id=$1 AND commit=$2`, [d.w.projectId, COMMIT2]);
    const n = cmds('release.prepare').length;
    await ok(call('POST', `${base()}/prepare`, { targetId: target(), commit: COMMIT, repackage: true }), 202);
    await until(async () => cmds('release.prepare').length === n + 1, 4000, 'restore reached the runner');
    prepared(release1, MANIFEST);
    await until(async () => (await status(COMMIT)).state === 'signed', 4000, 'release1 signed again');
  });
});

describe('a workstation that never answers (expiry)', () => {
  it('an unanswered prepare or sign expires: the state says so, both ways to sign come back, and a retry queues anew', async () => {
    const release3 = await ship(COMMIT3, '1.10.2');
    const p1 = await packageFor(COMMIT3);
    expect((await cmdRow(p1)).expires_at).not.toBeNull();
    expect((await status(COMMIT3)).state).toBe('preparing');
    d.w.t.clock.advance(PREPARE_TTL_MS + 60_000);
    expect(await status(COMMIT3)).toMatchObject({
      state: 'prepare_failed',
      error: expect.stringContaining('expired'),
    });
    const p2 = await packageFor(COMMIT3);
    expect(p2).not.toBe(p1);
    expect((await cmdRow(p1)).status).toBe('failed');
    // a late report for the expired prepare is not taken; the live one is
    prepared(release3, MANIFEST, { version: '1.10.2' });
    await until(async () => (await artefact(release3)).length === 1, 4000, 'artefact 3');
    expect((await status(COMMIT3)).state).toBe('waiting_signature');
    await ok(call('POST', `${base()}/sign`, { releaseId: release3, targetId: target() }), 202);
    await until(async () => (await status(COMMIT3)).state === 'signing', 4000, 'signing');
    const s1 = (
      await q(`SELECT id FROM runner_commands WHERE type='release.sign' AND payload->>'releaseId'=$1`, [
        release3,
      ])
    )[0]!.id;
    d.w.t.clock.advance(24 * 60 * 60_000 + 60_000);
    // back to waiting for a signature, with the reason: both routes are offered again
    expect(await status(COMMIT3)).toMatchObject({
      state: 'sign_failed',
      error: expect.stringContaining('expired'),
    });
    const again = await ok(call('POST', `${base()}/sign`, { releaseId: release3, targetId: target() }), 202);
    expect(again.commandId).not.toBe(s1);
    expect((await cmdRow(s1)).status).toBe('failed');
    expect((await status(COMMIT3)).state).toBe('signing');
  });
});

describe('the gate reads only what it can trust', () => {
  it('matches the full commit only, and fails closed on signing settings it cannot read', async () => {
    const [t] = await q('SELECT * FROM deploy_targets WHERE id=$1', [target()]);
    // release 1 is signed: its full commit passes, a short prefix of it does not
    expect(await signingGate(d.w.t.app.ctx.pool, d.w.projectId, t!, COMMIT)).toMatchObject({
      signing: { releaseId: release1 },
    });
    expect(await signingGate(d.w.t.app.ctx.pool, d.w.projectId, t!, COMMIT.slice(0, 7))).toMatchObject({
      refusal: expect.stringContaining('not a shipped release'),
    });
    const garbled = { ...t!, signing: { required: 'yes' } };
    expect(await signingGate(d.w.t.app.ctx.pool, d.w.projectId, garbled, COMMIT)).toMatchObject({
      required: true,
      refusal: expect.stringContaining('cannot be read'),
    });
  });
});

describe('changing the key', () => {
  it('voids a prepare or sign in flight: a late report from it never counts under the new key', async () => {
    await freshStepUp();
    const inflight = await packageFor(COMMIT2);
    await ok(
      call('PUT', `/api/deploy-targets/${target()}/signing`, {
        signing: { required: true, publicKey: OTHER_PUB },
      }),
    );
    expect(await cmdRow(inflight)).toMatchObject({
      status: 'failed',
      last_error: expect.stringContaining('key changed'),
    });
    // even if that command were still open, a report packaged under the old key is refused
    await q(`UPDATE runner_commands SET status='sent', done_at=NULL WHERE id=$1`, [inflight]);
    prepared(release2, MANIFEST, { version: '1.10.1' });
    await until(async () => (await cmdRow(inflight)).status === 'failed', 4000, 'old-key report refused');
    expect((await cmdRow(inflight)).last_error).toContain('key changed');
    expect(await artefact(release2)).toHaveLength(0);
    // back to the test key for the next test
    await ok(
      call('PUT', `/api/deploy-targets/${target()}/signing`, {
        signing: { required: true, publicKey: TEST_PUB },
      }),
    );
  });

  it('a new key needs a new packaging and signature; a stale session must confirm it is you first', async () => {
    await freshStepUp();
    await ok(
      call('PUT', `/api/deploy-targets/${target()}/signing`, {
        signing: { required: true, publicKey: OTHER_PUB },
      }),
    );
    // nothing packaged under the new key; the newest prepare (voided in the test above) says why
    expect(await status(COMMIT2)).toMatchObject({
      state: 'prepare_failed',
      error: expect.stringContaining('key changed'),
      artefactSha256: null,
      signing: { keyId: 'F0D6288B1CBE00A7' },
    });
    expect(await artefact(release1)).toHaveLength(0);
    d.w.t.clock.advance(601_000);
    const stale = await call('PUT', `/api/deploy-targets/${target()}/signing`, { signing: null });
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe('step_up_required');
  });
});
