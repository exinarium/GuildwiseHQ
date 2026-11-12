import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { addMember } from './helpers/members.ts';
import { eventsOfType } from './helpers/pipeline.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const clear = () =>
  q('UPDATE projects SET size_budget=NULL, size_unit=NULL, risk_map=NULL WHERE id=$1', [w.projectId]);
const put = (body: object, cookie = w.owner.cookie, status = 200) =>
  ok<any>(w.t.req('PUT', `/api/projects/${w.projectId}/review-settings`, { cookie, body }), status);
const project = async () =>
  (await ok<any>(w.t.req('GET', `/api/projects/${w.projectId}`, { cookie: w.owner.cookie }))).project;

const full = {
  sizeBudget: 400,
  sizeUnit: 'changed_lines',
  riskMap: [
    { pattern: 'apps/server/src/auth', risk: 'high' },
    { pattern: 'docs/**', risk: 'low' },
  ],
};

describe('project review settings', () => {
  it('AC2: a project starts with no budget, unit or map, and both checks report what is missing (AC3)', async () => {
    await clear();
    const p = await project();
    expect(p.reviewSettings).toMatchObject({ sizeBudget: null, sizeUnit: null, riskMap: null });
    expect(p.reviewSettings.status.size).toMatchObject({
      active: false,
      reason: 'inactive: no size budget set',
    });
    expect(p.reviewSettings.status.risk).toMatchObject({
      active: false,
      reason: 'inactive: no path-to-risk map set',
    });
  });

  it('AC1: the owner saves budget, unit and map; they are stored and come back on a fresh read', async () => {
    await clear();
    const before = (await eventsOfType('ProjectReviewSettingsSet')).length;
    const saved = await put(full);
    expect(saved.project.reviewSettings).toMatchObject(full);
    const p = await project();
    expect(p.reviewSettings).toMatchObject({
      ...full,
      status: { size: { active: true }, risk: { active: true } },
    });
    const events = await eventsOfType('ProjectReviewSettingsSet');
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toMatchObject({ projectId: w.projectId, ...full, by: w.owner.id });

    // the same value again records nothing
    await put(full);
    expect(await eventsOfType('ProjectReviewSettingsSet')).toHaveLength(before + 1);
  });

  it('AC3: with the budget cleared, size checks report "inactive: no size budget set"; an empty map is not set', async () => {
    await clear();
    const out = await put({ sizeBudget: null, sizeUnit: 'changed_files', riskMap: [] });
    expect(out.project.reviewSettings).toMatchObject({
      sizeBudget: null,
      sizeUnit: 'changed_files',
      riskMap: null,
    });
    expect(out.project.reviewSettings.status.size).toMatchObject({
      active: false,
      missing: ['sizeBudget'],
      reason: 'inactive: no size budget set',
    });
  });

  it('refuses a budget of 0, a pattern with .. and a missing field (400)', async () => {
    await clear();
    await put({ ...full, sizeBudget: 0 }, w.owner.cookie, 400);
    await put({ ...full, riskMap: [{ pattern: 'apps/../x', risk: 'high' }] }, w.owner.cookie, 400);
    await put({ sizeBudget: 10, sizeUnit: 'changed_lines' }, w.owner.cookie, 400);
    expect((await project()).reviewSettings).toMatchObject({
      sizeBudget: null,
      sizeUnit: null,
      riskMap: null,
    });
  });

  it('AC5: only the project owner may change them; a manager gets 403 and can still read them', async () => {
    await clear();
    const manager = await addMember(w, 'review-mgr');
    await put(full, manager.cookie, 403);
    expect((await project()).reviewSettings).toMatchObject({
      sizeBudget: null,
      sizeUnit: null,
      riskMap: null,
    });
    const seen = await ok<any>(w.t.req('GET', `/api/projects/${w.projectId}`, { cookie: manager.cookie }));
    expect(seen.project).toMatchObject({ myRole: 'manager', reviewSettings: { sizeBudget: null } });
  });
});
