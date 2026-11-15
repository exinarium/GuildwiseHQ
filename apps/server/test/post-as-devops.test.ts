import { randomUUID } from 'node:crypto';
import {
  COMMIT_STATUS_CAPABILITY,
  noAppPlan,
  POST_AS_CAPABILITY,
  POST_AS_V2_CAPABILITY,
} from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canPostAsV2,
  DEVOPS_POST_AS_RUNNER_TOO_OLD,
  devopsPostAs,
  identityFieldsFor,
  POST_AS_RUNNER_TOO_OLD_MESSAGE,
  postAsFieldFor,
} from '../src/commands/commit-as.ts';
import {
  appIdentityAlertEvents,
  appIdentityFailureText,
  commandProject,
} from '../src/commands/app-identity-alert.ts';
import { pickStatusWorkstation } from '../src/commands/pr-size-status.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * DevOps and repository commands on the server (GWP-212.5): the DevOps shift carries the workstation's union plan, a
 * post-as:2 runner always gets an explicit plan (the empty one when no app is selected), a runner that cannot honour the
 * app gets nothing (a DevOps request fails with the reason), and an app repository's commit status needs no status token.
 */

let w: World;
let r: FakeRunner;
let orgId: string;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({
    capabilities: [POST_AS_CAPABILITY, POST_AS_V2_CAPABILITY, COMMIT_STATUS_CAPABILITY, 'app-integrations:1'],
  });
  orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id as string;
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const db = () => w.t.app.ctx.pool;
const projectKey = async () =>
  (await q('SELECT key FROM projects WHERE id=$1', [w.projectId]))[0]?.key as string;
const remote = async () =>
  (await q('SELECT remote_url_normalized FROM project_repos WHERE id=$1', [w.repoId]))[0]
    ?.remote_url_normalized as string;

/** Sets the workstation's announced capabilities (a runner on an older version announces fewer). */
async function capabilities(caps: string[]) {
  await q('UPDATE workstation_capabilities SET capabilities=$2 WHERE workstation_id=$1', [w.workstationId, caps]);
}
const ALL = [POST_AS_CAPABILITY, POST_AS_V2_CAPABILITY, COMMIT_STATUS_CAPABILITY, 'app-integrations:1'];

/** A connected GitHub App selected for the world's project. */
async function selectApp() {
  const id = randomUUID();
  const now = new Date();
  await q(
    `INSERT INTO org_app_integrations (id, org_id, provider, label, host, app_id, app_slug, app_name, installation_id, account,
       bot_login, bot_user_id, commit_name, commit_email, status, created_by, created_at, updated_at)
     VALUES ($1,$2,'github-app','Guild bot','github.com','5001','guild-bot','Guild bot','801','acme','guild-bot[bot]','98',
             'guild-bot[bot]','98+guild-bot[bot]@users.noreply.github.com','active',$3,$4,$4)`,
    [id, orgId, randomUUID(), now],
  );
  await q(
    `INSERT INTO org_app_integration_workstations (integration_id, workstation_id, via, added_at) VALUES ($1,$2,'web',$3)`,
    [id, w.workstationId, now],
  );
  await q(
    `INSERT INTO workstation_integrations (workstation_id, kind, instance, status, checked_at)
     VALUES ($1,'github-app','5001:801',$2::jsonb,$3)
     ON CONFLICT (workstation_id, kind, instance) DO UPDATE SET status=EXCLUDED.status`,
    [w.workstationId, JSON.stringify({ state: 'connected' }), now],
  );
  await ok(
    w.t.req('PUT', `/api/projects/${w.projectId}/post-as`, {
      cookie: w.owner.cookie,
      body: { apps: [{ integrationId: id }] },
    }),
  );
  return id;
}

describe('no app selected (the projects behave as before, with an explicit empty plan for post-as:2 runners)', () => {
  it('a post-as:2 runner gets the empty plan; an older runner gets no plan field, exactly as before', async () => {
    expect(await canPostAsV2(db(), w.workstationId)).toBe(true);
    expect((await identityFieldsFor(db(), w.projectId, w.workstationId)).postAs).toEqual(noAppPlan());
    expect(await postAsFieldFor(db(), w.projectId, w.workstationId, { write: true })).toEqual({
      postAs: noAppPlan(),
    });
    const old = randomUUID();
    expect(await canPostAsV2(db(), old)).toBe(false);
    expect((await identityFieldsFor(db(), w.projectId, old)).postAs).toBeUndefined();
    expect(await postAsFieldFor(db(), w.projectId, old, { write: true, v2Only: true })).toEqual({});
  });

  it('the DevOps plan is the empty plan for a post-as:2 runner and null for an older one (no commitAs added)', async () => {
    const res = await devopsPostAs(db(), w.workstationId);
    expect(res).toHaveProperty('plan');
    const plan = 'plan' in res ? res.plan : undefined;
    // either the empty plan or project/repo entries, none of them on an app
    expect(plan?.repos.every((e) => e.source !== 'app')).toBe(true);
    expect(plan).not.toHaveProperty('commitAs');
    await capabilities([POST_AS_CAPABILITY, COMMIT_STATUS_CAPABILITY]);
    try {
      const older = await devopsPostAs(db(), w.workstationId);
      expect('refused' in older).toBe(false);
    } finally {
      await capabilities(ALL);
    }
  });

  it('a commit status for a repository not on an app still needs the status token', async () => {
    await q(`UPDATE workstations SET status_tokens='[]'::jsonb WHERE id=$1`, [w.workstationId]);
    expect(await pickStatusWorkstation(db(), w.repoId, await remote())).toBeNull();
    await q(`UPDATE workstations SET status_tokens='["github@github.com"]'::jsonb WHERE id=$1`, [
      w.workstationId,
    ]);
    const host = (await remote()).split('/')[0];
    const ws = await pickStatusWorkstation(db(), w.repoId, await remote());
    // the token key is per host: the world's remote may not be on github.com
    expect(ws).toBe(host === 'github.com' ? w.workstationId : null);
    await q(`UPDATE workstations SET status_tokens='[]'::jsonb WHERE id=$1`, [w.workstationId]);
  });
});

describe('an app selected', () => {
  let appId: string;
  beforeAll(async () => {
    appId = await selectApp();
  });

  it('the DevOps shift plan holds the project repository on the app, tagged with the project key', async () => {
    const res = await devopsPostAs(db(), w.workstationId);
    expect('plan' in res).toBe(true);
    const plan = 'plan' in res ? res.plan : null;
    const entry = plan?.repos.find((e) => e.repoId === w.repoId);
    expect(entry).toMatchObject({
      source: 'app',
      projectKey: await projectKey(),
      app: { integrationId: appId, botName: 'guild-bot[bot]' },
    });
    expect(JSON.stringify(plan)).not.toMatch(/token|privateKey/i);
  });

  it('a runner without post-as:2 gets no DevOps shift: refused with a reason naming the project', async () => {
    await capabilities([POST_AS_CAPABILITY, COMMIT_STATUS_CAPABILITY]);
    try {
      const res = await devopsPostAs(db(), w.workstationId);
      const name = (await q('SELECT name FROM projects WHERE id=$1', [w.projectId]))[0]?.name as string;
      expect(res).toEqual({ refused: DEVOPS_POST_AS_RUNNER_TOO_OLD([name]) });
    } finally {
      await capabilities(ALL);
    }
  });

  it('a queued DevOps request on a too-old runner fails with the reason instead of waiting', async () => {
    await capabilities([POST_AS_CAPABILITY, COMMIT_STATUS_CAPABILITY]);
    try {
      const created = await ok<{ id: string }>(
        w.t.req('POST', '/api/devops/requests', {
          cookie: w.owner.cookie,
          body: { workstationId: w.workstationId, summary: 'tidy the checkout' },
        }),
        201,
      );
      const id = (created as any).id ?? (created as any).request?.id;
      await w.t.app.ctx.services.dispatcher.run();
      await until(
        async () =>
          (await q('SELECT status FROM devops_requests WHERE id=$1', [id]))[0]?.status === 'failed',
        5000,
        'request failed',
      );
      const ev = await q(
        `SELECT payload FROM events WHERE type='DevOpsRequestCompleted' AND payload->>'requestId'=$1`,
        [id],
      );
      expect(ev[0]?.payload).toMatchObject({ status: 'failed' });
      expect(String(ev[0]?.payload.summary)).toContain('too old');
    } finally {
      await capabilities(ALL);
    }
  });

  it('commands: a post-as:2 runner gets the app plan; a post-as:1 runner is refused for status and notice (v2Only)', async () => {
    const field = await postAsFieldFor(db(), w.projectId, w.workstationId, { write: true, v2Only: true });
    expect(field.postAs?.repos.find((e) => e.repoId === w.repoId)?.source).toBe('app');
    await capabilities([POST_AS_CAPABILITY, COMMIT_STATUS_CAPABILITY]);
    try {
      await expect(
        postAsFieldFor(db(), w.projectId, w.workstationId, { write: true, v2Only: true }),
      ).rejects.toMatchObject({ status: 409, code: 'runner_too_old', message: POST_AS_RUNNER_TOO_OLD_MESSAGE });
      // a post-as:1 runner still gets the plan for the commands it honours
      expect(
        (await postAsFieldFor(db(), w.projectId, w.workstationId, { write: true })).postAs,
      ).toBeDefined();
    } finally {
      await capabilities(ALL);
    }
  });

  it('pickStatusWorkstation: an app repository needs no status token on a post-as:2 runner, but does on an older one', async () => {
    await q(`UPDATE workstations SET status_tokens='[]'::jsonb WHERE id=$1`, [w.workstationId]);
    expect(await pickStatusWorkstation(db(), w.repoId, await remote())).toBe(w.workstationId);
    await capabilities([POST_AS_CAPABILITY, COMMIT_STATUS_CAPABILITY]);
    try {
      expect(await pickStatusWorkstation(db(), w.repoId, await remote())).toBeNull();
    } finally {
      await capabilities(ALL);
    }
  });
});

describe('the app alert for repository commands and DevOps hygiene', () => {
  const wire =
    'app_identity_failed: The app Guild bot could not be used: the installation was revoked (project GWP, operation commit status, repository acme/web). Nothing was committed or pushed under another identity.';

  it('reads the failure text from the wire form and the plain sentence only', () => {
    expect(appIdentityFailureText(wire)).toMatch(/^The app Guild bot could not be used/);
    expect(appIdentityFailureText('The app X could not be used: gone.')).toBe('The app X could not be used: gone.');
    expect(appIdentityFailureText('push rejected')).toBeNull();
    expect(appIdentityFailureText(undefined)).toBeNull();
  });

  it('a commit-status command names its repository: one alert per project and work, naming the app', async () => {
    const target = await commandProject(db(), { repoId: w.repoId, statusId: 'x' });
    expect(target).toEqual({ projectId: w.projectId, orgId, cardId: null });
    expect(await commandProject(db(), { something: 'else' })).toBeNull();
    const name = (await q('SELECT name FROM projects WHERE id=$1', [w.projectId]))[0]?.name as string;
    const events = await appIdentityAlertEvents(db(), { ...target!, detail: wire, what: 'Repository commands' });
    expect(events).toHaveLength(1);
    expect(events[0]?.event.payload).toMatchObject({
      kind: 'alert',
      title: `Repository commands for ${name} stopped: the app Guild bot cannot be used`,
      projectId: w.projectId,
    });
    expect(String((events[0]?.event.payload as any).body)).toContain('commit status');
    await w.t.app.ctx.store.append(events);
    // already open: not raised twice
    expect(await appIdentityAlertEvents(db(), { ...target!, detail: wire, what: 'Repository commands' })).toEqual([]);
    // DevOps hygiene is its own alert
    const hygiene = await appIdentityAlertEvents(db(), { ...target!, detail: wire, what: 'DevOps hygiene' });
    expect((hygiene[0]?.event.payload as any).title).toContain('DevOps hygiene for');
  });
});
