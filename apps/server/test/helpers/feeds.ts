import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { nextFireAfter } from '../../src/commands/schedules.ts';
import { q } from './db.ts';
import type { FakeRunner } from './fake-runner.ts';
import { shiftHelpers } from './shifts.ts';
import { ok, until, type World } from './world.ts';

const TITLES = [
  'Hornady unveils a 6mm ARC match load',
  'Berger releases a new hunting bullet line',
  'Ruger announces lightweight carry pistol',
  'Chronograph shootout compares ten budget models',
  'Federal recalls a batch of shotshells',
  'Lapua opens a second brass factory',
  'Sierra publishes updated reloading manual',
  'Vortex launches compact rifle scope range',
];

export const item = (n: number, over: Record<string, unknown> = {}) => ({
  kind: 'article',
  url: `https://news.example.test/story-${n}`,
  title: TITLES[(n - 1) % TITLES.length] as string,
  source: 'News Example',
  publishedAt: '2026-10-02',
  summary: `Summary of story ${n}`,
  ...over,
});

/** A feed project (`NEWS`, personal domain) next to the world's code project. */
export async function createFeedProject(w: World, over: Record<string, unknown> = {}): Promise<string> {
  const r = await ok<any>(
    w.t.req('POST', '/api/projects', {
      cookie: w.owner.cookie,
      body: { key: 'NEWS', name: 'News', workflowKey: 'feed', domain: 'personal', ...over },
    }),
    201,
  );
  return r.project.id as string;
}

/**
 * A feed schedule as it was created before feeds became interests: a legacy `ScheduleCreated` (no trigger, no action,
 * `kind: 'feed'`). The API refuses new feed schedules (they are interests now), so tests that need one inject the old
 * event, exactly what an existing installation holds. Returns what `POST /api/schedules` used to.
 */
export async function feedSchedule(
  w: World,
  projectId: string,
  over: Record<string, unknown> = {},
): Promise<{ status: number; body: any }> {
  const ctx = w.t.app.ctx;
  const b = {
    name: 'Daily news',
    cron: '0 7 * * *',
    timezone: 'UTC',
    cardTemplate: { title: 'News run', fields: { topic: 'reloading' } },
    enabled: true,
    ...over,
  } as { name: string; cron: string; timezone: string; cardTemplate: unknown; enabled: boolean };
  const proj = (await q('SELECT org_id FROM projects WHERE id=$1', [projectId]))[0];
  const id = randomUUID();
  await ctx.store.append([
    {
      streamId: streamId.schedule(id),
      event: {
        type: 'ScheduleCreated',
        payload: {
          scheduleId: id,
          projectId,
          name: b.name,
          kind: 'feed',
          cron: b.cron,
          timezone: b.timezone,
          cardTemplate: b.cardTemplate as never,
          enabled: b.enabled,
          nextFireAt: b.enabled
            ? (nextFireAfter(b.cron, b.timezone, ctx.clock.now())?.toISOString() ?? null)
            : null,
        },
      },
      actor: { kind: 'user', id: w.owner.id } as never,
      scope: { orgId: proj?.org_id, projectId, audience: 'project' } as never,
    },
  ]);
  await ctx.notifier.flush();
  const list = (await w.t.req('GET', `/api/schedules?projectId=${projectId}`, { cookie: w.owner.cookie }))
    .body.schedules as any[];
  return { status: 201, body: list.find((x) => x.id === id) };
}

/** Drives scout and curator shifts of one feed card through a fake runner. */
export function feedRunner(w: World, r: FakeRunner) {
  const h = shiftHelpers(w);
  let from = 0;
  async function shift(agent: string) {
    const start = await h.dispatchTo(r, agent, from);
    from = r.received.indexOf(start) + 1;
    await h.startShift(r, start);
    return start;
  }
  const ended = async (shiftId: string) => {
    r.ended(shiftId, 'reported');
    await until(
      async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [shiftId, 'ended']))[0],
      3000,
      'shift ended',
    );
  };
  return {
    h,
    shift,
    /** Scout hands off `items`; returns the curator's shift start. */
    async scan(items: unknown[], scout = 'Scout', curator = 'Cora') {
      const s = await shift(scout);
      const res = await h.report(
        r,
        s.shiftId,
        { kind: 'outcome', outcomeId: 'handoff', note: 'searched', data: { items } },
        {},
      );
      await ended(s.shiftId);
      const c = await shift(curator);
      return { scout: s, curator: c, scanResult: res };
    },
    async digest(curatorShiftId: string, data: Record<string, unknown>, note = 'picked the best') {
      const res = await h.report(r, curatorShiftId, { kind: 'outcome', outcomeId: 'digest', note, data });
      await ended(curatorShiftId);
      return res;
    },
    ended,
  };
}
