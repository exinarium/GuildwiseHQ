import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/** A scheduled card takes the project's only repository, like a card made by hand (single-repo default). */
let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });

async function fire(): Promise<string | null> {
  const s = await ok<any>(
    owner('POST', '/api/schedules', {
      name: 'By hand',
      trigger: { kind: 'manual' },
      action: { kind: 'create_card', projectId: w.projectId, template: { title: 'Nightly', fields: {} } },
    }),
    201,
  );
  await ok<any>(owner('POST', `/api/schedules/${s.id}/run`), 201);
  const c = (await q('SELECT repo_id FROM cards WHERE schedule_id=$1', [s.id]))[0];
  expect(c).toBeDefined();
  return c?.repo_id as string | null;
}

describe('scheduled cards and the repository', () => {
  it('a one-repo code project: the card gets the repo', async () => {
    expect(await fire()).toBe(w.repoId);
  });

  it('a two-repo project leaves the repo empty', async () => {
    await ok(
      owner('POST', `/api/projects/${w.projectId}/repos`, {
        name: 'second',
        remoteUrl: 'git@example.com:acme/second.git',
      }),
      201,
    );
    expect(await fire()).toBeNull();
  });
});
