import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collectGateFacts, effectiveGates, latestMerge } from '../src/delivery/gate.ts';
import { automatedCommitAllowed, requestDeployRun } from '../src/delivery/runs.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import {
  type DeliveryWorld,
  deliveryWorld,
  healthyRun,
  mergeLanded,
  parseFixture,
  setWeekday,
} from './helpers/delivery.ts';
import { DEFAULT_TIP, type FakeRunner } from './helpers/fake-runner.ts';
import { ok, until } from './helpers/world.ts';

/**
 * Which commit a deploy builds when nobody names one (GWP-257): the newest shipped release for an environment that deploys
 * releases, what an earlier environment runs, else the TIP of the working branch, read on the deploying workstation. The
 * newest CardFinalized merge is no longer the default. A commit a person names is checked on the workstation. The preview
 * and the deploy use the same function.
 */
const A = 'a'.repeat(40); // the last CardFinalized merge
const B = 'b'.repeat(40); // a later commit that is not a card merge (a pointer bump, a prep commit, a manual commit)
const R = 'c'.repeat(40); // a shipped release commit, not a card merge either
const C = 'd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1';
const UNKNOWN = 'e'.repeat(40);
let d: DeliveryWorld;
let r: FakeRunner;

beforeAll(async () => {
  d = await deliveryWorld();
  r = await d.w.connectRunner({ capabilities: ['ceo:1', 'delivery:1'] });
  await setWeekday(d);
  await mergeLanded(d, A);
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
beforeEach(async () => {
  await q(`UPDATE deploy_runs SET status='cancelled' WHERE status IN ('queued','running','waiting_release')`);
  r.probe.tip = B;
  r.probe.strict = true;
  r.probe.known = {
    [A]: { subject: 'Merge card' },
    [B]: { subject: 'chore: bump the pointer' },
    [R]: {},
    [C]: {},
  };
  r.probe.ambiguous = [];
  r.probe.silent = false;
  r.probe.asked.length = 0;
});

const ctx = () => d.w.t.app.ctx;
const owner = (method: string, url: string, body?: unknown) =>
  d.w.t.req(method, url, {
    cookie: d.w.owner.cookie,
    headers: { 'x-aom-org': d.orgId },
    ...(body === undefined ? {} : { body }),
  });
const execs = () => r.of('command').filter((c) => c.command === 'deploy.exec');
const ownerReq = () => ({ kind: 'owner', id: d.w.owner.id, name: 'Owner', provenance: 'session' }) as const;
const ceo = { kind: 'ceo', id: 'ceo-1', name: 'Ada', provenance: 'order', untrusted: false } as const;
const ask = (env: string, commit?: string, extra: { expectCommit?: string } = {}) =>
  requestDeployRun(ctx(), {
    projectId: d.w.projectId,
    env,
    commit,
    ...extra,
    trigger: 'request',
    requester: ownerReq(),
  });
const runRow = async (id: string) => (await q('SELECT * FROM deploy_runs WHERE id=$1', [id]))[0]!;
const countRuns = async () => (await q('SELECT count(*)::int AS n FROM deploy_runs'))[0]!.n as number;
const countDeployEvents = async () =>
  (await q(`SELECT count(*)::int AS n FROM events WHERE type LIKE 'Deploy%'`))[0]!.n as number;
const preview = (env: string, extra = '') =>
  owner('GET', `/api/projects/${d.w.projectId}/delivery/deploy/preview?env=${env}${extra}`);
const ship = async (version: string, status: string, sha: string | null) =>
  q(
    `INSERT INTO release_ships (id, org_id, project_id, repo_id, version, tag, release_date, payload, status, commit_sha, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,current_date,'{}'::jsonb,$7,$8,now(),now())`,
    [randomUUID(), d.orgId, d.w.projectId, d.w.repoId, version, `v${version}`, status, sha],
  );

describe('no commit named: the tip of the working branch', () => {
  it('a non-card commit newer than the last card merge is what is built, and the run records it', async () => {
    const before = execs().length;
    const res = await ask('local');
    expect(res.runs[0]).toMatchObject({ status: 'queued' });
    const id = res.runs[0]!.runId;
    expect(await runRow(id)).toMatchObject({
      commit: B,
      commit_source: 'working-branch',
      commit_source_detail: 'tip of main',
    });
    await until(async () => execs().length > before, 4000, 'deploy.exec');
    expect(execs().at(-1)!.payload).toMatchObject({ commit: B, repo: { workingBranch: 'main' } });
    expect(r.probe.asked).toEqual([{ sha: null, branch: 'main' }]);
    // the newest card merge stays what the gate facts call the latest merge: those callers are unchanged
    expect((await latestMerge(ctx().pool, d.w.projectId, null))?.commit).toBe(A);
    expect(
      (await q(`SELECT payload FROM events WHERE type='DeployRunRequested' ORDER BY seq DESC LIMIT 1`))[0]!
        .payload,
    ).toMatchObject({ runId: id, commit: B, commitSource: 'working-branch' });
  });

  it('an unreadable branch is refused with the reason, never replaced by the card merge', async () => {
    r.probe.tip = null;
    const res = await ask('local');
    expect(res.runs[0]).toMatchObject({ status: 'refused', refusal: 'commit_unresolved' });
    expect(res.runs[0]!.detail).toContain('the tip of main could not be read');
    expect(execs().filter((c) => (c.payload as { commit: string }).commit === A)).toHaveLength(0);
  });
});

describe('an environment that deploys releases', () => {
  it('builds the newest shipped release commit, also when it is not a card merge; a failed ship is ignored', async () => {
    await ship('1.8.0', 'published', C);
    await ship('1.9.0', 'committed', R);
    await ship('1.9.1', 'failed', UNKNOWN);
    await ship('1.9.2', 'committing', null);
    const res = await ask('production');
    // the gate (the test environment must run it first) may refuse R: the refusal still names the commit and why
    expect(await runRow(res.runs[0]!.runId)).toMatchObject({
      commit: R,
      commit_source: 'release',
      commit_source_detail: 'release 1.9.0',
    });
    expect(r.probe.asked).toEqual([{ sha: R, branch: 'main' }]);
  });

  it('the test environment never takes the release commit: it builds the tip', async () => {
    const res = await ask('local');
    expect(await runRow(res.runs[0]!.runId)).toMatchObject({ commit: B, commit_source: 'working-branch' });
  });
});

describe('promote what the earlier environment runs', () => {
  it('a live environment without a shipped release builds what test runs (source promoted)', async () => {
    await q('DELETE FROM release_ships');
    r.probe.known[C] = { subject: 'what test runs' };
    await healthyRun(d, 'local', C, 45);
    const res = await ask('production');
    expect(await runRow(res.runs[0]!.runId)).toMatchObject({
      commit: C,
      commit_source: 'promoted',
      commit_source_detail: 'what local runs',
    });
    await q(`DELETE FROM deploy_runs WHERE commit_source='promoted' OR env='local'`);
  });
});

describe('a commit a person names', () => {
  it('wins over the default and is expanded to the full sha (abbreviated is fine)', async () => {
    const before = execs().length;
    const res = await ask('local', C.slice(0, 9));
    expect(res.runs[0]).toMatchObject({ status: 'queued' });
    expect(await runRow(res.runs[0]!.runId)).toMatchObject({ commit: C, commit_source: 'explicit' });
    await until(async () => execs().length > before, 4000, 'deploy.exec');
    expect(execs().at(-1)!.payload).toMatchObject({ commit: C });
  });

  it('that is not in the repository is refused with a 422 that says why; no run and no event', async () => {
    const runs = await countRuns();
    const events = await countDeployEvents();
    await expect(ask('local', UNKNOWN)).rejects.toMatchObject({ status: 422, code: 'commit_unknown' });
    expect(await countRuns()).toBe(runs);
    expect(await countDeployEvents()).toBe(events);
    const http = await owner('POST', `/api/projects/${d.w.projectId}/delivery/deploy`, {
      env: 'local',
      commit: UNKNOWN,
    });
    expect(http.status).toBe(422);
    expect(http.body.error.message).toContain('is not in');
    expect(await countRuns()).toBe(runs);
  });

  it('that matches several commits is refused with a 422', async () => {
    r.probe.ambiguous = ['abcdef0'];
    await expect(ask('local', 'abcdef0')).rejects.toMatchObject({ status: 422, code: 'commit_ambiguous' });
  });

  it('that is not a sha at all is a 400 before anything else', async () => {
    const runs = await countRuns();
    for (const commit of ['zzzzzzz', 'abc', 'main; rm -rf']) {
      const res = await owner('POST', `/api/projects/${d.w.projectId}/delivery/deploy`, {
        env: 'local',
        commit,
      });
      expect(res.status).toBe(400);
    }
    expect(await countRuns()).toBe(runs);
  });

  it('upper case is accepted (a sha pasted from a page)', async () => {
    const res = await owner('POST', `/api/projects/${d.w.projectId}/delivery/deploy`, {
      env: 'local',
      commit: C.toUpperCase(),
    });
    expect(res.status).toBe(200);
    expect(res.body.runs[0]).toMatchObject({ status: 'queued' });
  });

  it('an automated requester is checked by the allow-list as before, with no probe', async () => {
    const res = await requestDeployRun(ctx(), {
      projectId: d.w.projectId,
      env: 'local',
      commit: B,
      trigger: 'request',
      requester: ceo,
    });
    expect(res.runs[0]).toMatchObject({ status: 'refused', refusal: 'commit_not_allowed' });
    expect(r.probe.asked).toEqual([]);
    expect(await automatedCommitAllowed(ctx().pool, d.w.projectId, B, [], null)).toBe(false);
    expect(await automatedCommitAllowed(ctx().pool, d.w.projectId, A, [], null)).toBe(true);
  });
});

describe('the preview and the deploy agree', () => {
  it('returns the sha, short sha, subject, date and source; the next deploy builds exactly that commit', async () => {
    const p = await ok<any>(preview('local'));
    expect(p).toMatchObject({
      env: 'local',
      branch: 'main',
      sha: B,
      shortSha: B.slice(0, 7),
      subject: 'chore: bump the pointer',
      source: 'working-branch',
      sourceDetail: 'tip of main',
    });
    expect(p.committedAt).toBe('2026-11-14T10:00:00.000Z');
    const runs = await countRuns();
    const events = await countDeployEvents();
    expect(await countRuns()).toBe(runs);
    const res = await ask('local', undefined, { expectCommit: p.sha });
    expect(await runRow(res.runs[0]!.runId)).toMatchObject({
      commit: p.sha,
      commit_source: 'working-branch',
    });
    expect(await countDeployEvents()).toBeGreaterThan(events);
  });

  it('a preview creates no run, no event and no queued runner command', async () => {
    const runs = await countRuns();
    const events = await countDeployEvents();
    const cmds = (await q('SELECT count(*)::int AS n FROM runner_commands'))[0]!.n;
    await ok(preview('local'));
    await ok(preview('production'));
    expect(await countRuns()).toBe(runs);
    expect(await countDeployEvents()).toBe(events);
    expect((await q('SELECT count(*)::int AS n FROM runner_commands'))[0]!.n).toBe(cmds);
  });

  it('a preview of a commit a person names goes through the same check', async () => {
    expect((await ok<any>(preview('local', `&commit=${C.slice(0, 8)}`))).source).toBe('explicit');
    const bad = await preview('local', `&commit=${UNKNOWN}`);
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('commit_unknown');
  });

  it('a push between the preview and the press is refused as commit_moved: no run', async () => {
    const p = await ok<any>(preview('local'));
    r.probe.tip = C;
    const runs = await countRuns();
    await expect(ask('local', undefined, { expectCommit: p.sha })).rejects.toMatchObject({
      status: 409,
      code: 'commit_moved',
    });
    expect(await countRuns()).toBe(runs);
    const http = await owner('POST', `/api/projects/${d.w.projectId}/delivery/deploy`, {
      env: 'local',
      expectCommit: p.sha,
    });
    expect(http.status).toBe(409);
    expect(http.body.error.code).toBe('commit_moved');
  });

  it('only an Owner or an Admin may preview; a member may not', async () => {
    const m = await d.member();
    const res = await d.w.t.req('GET', `/api/projects/${d.w.projectId}/delivery/deploy/preview?env=local`, {
      cookie: m.cookie,
      headers: { 'x-aom-org': d.orgId },
    });
    expect([403, 404]).toContain(res.status);
  });

  it('an unknown environment is a 404', async () => {
    expect((await preview('nowhere')).status).toBe(404);
  });

  it('equal requests in flight share one question to the workstation', async () => {
    r.probe.silent = true; // nobody answers, so both stay in flight
    const hub = ctx().services.commitProbe;
    const req = { remoteUrlNormalized: 'x/y', branch: 'main' };
    const both = await Promise.all([
      hub.probe(d.w.workstationId, req, 300),
      hub.probe(d.w.workstationId, req, 300),
    ]);
    expect(both).toEqual([{ kind: 'timeout' }, { kind: 'timeout' }]);
    expect(r.probe.asked).toHaveLength(1);
  });
});

describe('the other callers of the newest merge are unchanged', () => {
  it('gate facts still call the newest card merge the latest merge, whatever the tip is', async () => {
    const facts = await collectGateFacts(ctx().pool, {
      orgId: d.orgId,
      projectId: d.w.projectId,
      commit: null,
      now: ctx().clock.now(),
    });
    expect(facts.latestMergeCommit).toBe(A);
    const env = parseFixture().environments[1]!;
    const gates = await effectiveGates(ctx().pool, {
      orgId: d.orgId,
      projectId: d.w.projectId,
      env,
      production: true,
      repoId: null,
    });
    expect(gates.gates.length).toBeGreaterThan(0);
  });
});

describe('the workstation cannot be asked', () => {
  it('an old runner: refused with "update it", for the preview and the deploy', async () => {
    await q(
      `UPDATE workstation_capabilities SET capabilities=ARRAY['ceo:1','delivery:1'] WHERE workstation_id=$1`,
      [d.w.workstationId],
    );
    const res = await ask('local');
    expect(res.runs[0]).toMatchObject({ status: 'refused', refusal: 'commit_unresolved' });
    expect(res.runs[0]!.detail).toContain('too old');
    const p = await preview('local');
    expect(p.status).toBe(409);
    expect(p.body.error.code).toBe('commit_unresolved');
    await q(
      `UPDATE workstation_capabilities SET capabilities=ARRAY['ceo:1','delivery:1','deploy-commit-probe:1'] WHERE workstation_id=$1`,
      [d.w.workstationId],
    );
  });

  it('a runner that does not answer in time is refused, with the reason', async () => {
    r.probe.silent = true;
    const hub = ctx().services.commitProbe;
    const ans = await hub.probe(d.w.workstationId, { remoteUrlNormalized: 'x/y', branch: 'main' }, 150);
    expect(ans).toEqual({ kind: 'timeout' });
  });

  it('a runner that is gone: refused as offline, never the card merge', async () => {
    r.close();
    await until(async () => !ctx().services.runners.get(d.w.workstationId), 4000, 'runner gone');
    const res = await ask('local');
    expect(res.runs[0]).toMatchObject({ status: 'refused', refusal: 'commit_unresolved' });
    expect(res.runs[0]!.detail).toContain('offline');
    expect(res.runs[0]!.detail).toContain('nothing was deployed');
    const p = await preview('local');
    expect(p.status).toBe(409);
    expect(p.body.error.message).toContain('offline');
    expect(await q(`SELECT 1 FROM deploy_runs WHERE commit=$1`, [A])).toEqual([]);
  });
});
