import { randomUUID } from 'node:crypto';
import { POST_AS_CAPABILITY, TRACKER_POST_AS_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canTrackerPostAs, trackerAppFor, trackerAppForPoll } from '../src/commands/post-as.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let orgId: string;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({
    capabilities: [POST_AS_CAPABILITY, TRACKER_POST_AS_CAPABILITY, 'app-integrations:1'],
  });
  orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id as string;
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const db = () => w.t.app.ctx.pool;

let n = 0;
async function addApp(opts: { host?: string; status?: string } = {}) {
  const id = randomUUID();
  n++;
  const now = new Date();
  await q(
    `INSERT INTO org_app_integrations (id, org_id, provider, label, host, app_id, app_slug, app_name, installation_id, account,
       bot_login, bot_user_id, commit_name, commit_email, status, created_by, created_at, updated_at)
     VALUES ($1,$2,'github-app','Acme bot',$3,$4,'acme-bot','Acme bot',$5,'acme','acme-bot[bot]','99',
             'acme-bot[bot]','99+acme-bot[bot]@users.noreply.github.com',$6,$7,$8,$8)`,
    [
      id,
      orgId,
      opts.host ?? 'github.com',
      String(5000 + n),
      String(800 + n),
      opts.status ?? 'active',
      randomUUID(),
      now,
    ],
  );
  return id;
}
const select = (integrationId: string | null) =>
  q('UPDATE projects SET post_as=$2::jsonb WHERE id=$1', [
    w.projectId,
    integrationId ? JSON.stringify([{ integrationId, provider: 'github-app' }]) : null,
  ]);

describe('GitHub issue traffic as the selected app (server side)', () => {
  it('no project or no app selected: null, and a poll payload gets no trackerApp', async () => {
    await select(null);
    expect(await trackerAppFor(db(), null)).toBeNull();
    expect(await trackerAppFor(db(), w.projectId)).toBeNull();
    expect(await trackerAppForPoll(db(), { project_id: w.projectId }, 'github', randomUUID())).toEqual({});
  });

  it('an active github.com app is returned with its public identity (no secrets)', async () => {
    const id = await addApp();
    await select(id);
    const app = await trackerAppFor(db(), w.projectId);
    expect(app).toMatchObject({
      integrationId: id,
      provider: 'github-app',
      label: 'Acme bot',
      botName: 'acme-bot[bot]',
      host: 'github.com',
      instance: `${5000 + n}:${800 + n}`,
    });
    expect(JSON.stringify(app)).not.toMatch(/token|key/i);
  });

  it('polls: GitHub gets trackerApp on a capable runner, Jira and org schedules never do, an old runner is refused', async () => {
    const id = await addApp();
    await select(id);
    expect(await canTrackerPostAs(db(), w.workstationId)).toBe(true);
    expect(
      (await trackerAppForPoll(db(), { project_id: w.projectId }, 'github', w.workstationId)).trackerApp,
    ).toMatchObject({ integrationId: id });
    expect(await trackerAppForPoll(db(), { project_id: w.projectId }, 'jira', w.workstationId)).toEqual({});
    expect(await trackerAppForPoll(db(), { project_id: null }, 'github', w.workstationId)).toEqual({});
    await expect(
      trackerAppForPoll(db(), { project_id: w.projectId }, 'github', randomUUID()),
    ).rejects.toMatchObject({ status: 409, code: 'runner_too_old' });
  });

  it('a removed app or one on another host falls back (null)', async () => {
    await select(await addApp({ status: 'removed' }));
    expect(await trackerAppFor(db(), w.projectId)).toBeNull();
    await select(await addApp({ host: 'ghe.acme.test' }));
    expect(await trackerAppFor(db(), w.projectId)).toBeNull();
    await select(null);
  });
});
