import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

// A schedule that cannot fire (a regression schedule on a project without a repo) must not be retried on every 15 s
// tick: it backs off and raises one desk notice (M9 gap fix).
let w: World;
let projectId: string;
beforeAll(async () => {
  w = await createWorld();
  const p = await ok<any>(
    w.t.req('POST', '/api/projects', { cookie: w.owner.cookie, body: { key: 'NOR', name: 'No repo' } }),
    201,
  );
  projectId = p.project.id;
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const clock = () => w.t.app.ctx.clock;
const sched = (id: string) => q('SELECT * FROM schedules WHERE id=$1', [id]).then((r) => r[0]!);
const notices = () => q(`SELECT * FROM desk_items WHERE subkind='schedule_failed' ORDER BY created_at`);
const failures = () => q(`SELECT payload FROM events WHERE type='ScheduleFireFailed' ORDER BY seq`);

describe('a schedule that cannot fire', () => {
  it('backs off with growing pauses and raises a single desk notice, then recovers', async () => {
    const created = await ok<any>(
      w.t.req('POST', '/api/schedules', {
        cookie: w.owner.cookie,
        body: {
          projectId,
          name: 'Nightly regression',
          kind: 'regression',
          cron: '* * * * *',
          timezone: 'UTC',
          cardTemplate: { title: 'Nightly regression', fields: { platform: 'web' } },
        },
      }),
      201,
    );
    const id = created.id as string;
    const scheduler = w.t.app.ctx.services.scheduler;

    // First tick after the fire time: no card, one failure recorded, retry in about a minute.
    clock().setOffset(new Date(created.nextFireAt).getTime() - Date.now() + 1000);
    expect(await scheduler.run()).toEqual([]);
    let s = await sched(id);
    expect(s.fail_count).toBe(1);
    expect(s.last_error).toMatch(/no repository|repo/i);
    const retry1 = new Date(s.next_fire_at).getTime() - clock().now().getTime();
    expect(retry1).toBeGreaterThan(50_000);
    expect(retry1).toBeLessThanOrEqual(61_000);
    expect(await q(`SELECT 1 FROM cards WHERE project_id=$1`, [projectId])).toHaveLength(0);

    // The next 15 s ticks leave it alone: no retry, no further events.
    for (let i = 0; i < 3; i++) {
      clock().advance(15_000);
      expect(await scheduler.run()).toEqual([]);
    }
    expect(await failures()).toHaveLength(1);
    expect((await sched(id)).fail_count).toBe(1);

    // Past the retry time it tries once more and doubles the pause.
    clock().advance(61_000);
    await scheduler.run();
    s = await sched(id);
    expect(s.fail_count).toBe(2);
    const retry2 = new Date(s.next_fire_at).getTime() - clock().now().getTime();
    expect(retry2).toBeGreaterThan(110_000);
    expect(retry2).toBeLessThanOrEqual(121_000);
    expect(await failures()).toHaveLength(2);

    // Still exactly one open notice for the whole streak.
    const open = await notices();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: 'alert', status: 'open', project_id: projectId });
    expect(open[0]!.title).toContain('Nightly regression');
    expect(s.failure_desk_item_id).toBe(open[0]!.id);
    const dto = (await ok<any>(w.t.req('GET', '/api/schedules', { cookie: w.owner.cookie }))).schedules.find(
      (x: any) => x.id === id,
    );
    expect(dto).toMatchObject({ failCount: 2 });
    expect(dto.lastError).toBeTruthy();

    // Fix the cause (a repo) and the schedule fires again; the notice closes and the streak resets.
    await ok(
      w.t.req('POST', `/api/projects/${projectId}/repos`, {
        cookie: w.owner.cookie,
        body: { name: 'late', remoteUrl: 'https://github.com/acme/late.git' },
      }),
      201,
    );
    clock().advance(121_000);
    const fired = await scheduler.run();
    expect(fired).toHaveLength(1);
    s = await sched(id);
    expect(s.fail_count).toBe(0);
    expect(s.last_error).toBeNull();
    expect((await notices())[0]).toMatchObject({ status: 'answered' });
    expect(
      await q(`SELECT 1 FROM cards WHERE project_id=$1 AND origin='regression'`, [projectId]),
    ).toHaveLength(1);
  });

  it('a second streak raises a new notice after the first was dealt with', async () => {
    const id = (await q(`SELECT id FROM schedules WHERE project_id=$1`, [projectId]))[0]!.id as string;
    // The repo goes away: removing it makes the next regression run impossible again.
    await q(`UPDATE project_repos SET removed_at=now() WHERE project_id=$1`, [projectId]);
    clock().advance(3 * 3600_000);
    await w.t.app.ctx.services.scheduler.run();
    expect((await sched(id)).fail_count).toBe(1);
    const all = await notices();
    expect(all).toHaveLength(2);
    expect(all.filter((n) => n.status === 'open')).toHaveLength(1);
  });
});
