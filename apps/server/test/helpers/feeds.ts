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

export const feedSchedule = (w: World, projectId: string, over: Record<string, unknown> = {}) =>
  w.t.req('POST', '/api/schedules', {
    cookie: w.owner.cookie,
    body: {
      projectId,
      name: 'Daily news',
      cron: '0 7 * * *',
      timezone: 'UTC',
      cardTemplate: { title: 'News run', fields: { topic: 'reloading' } },
      ...over,
    },
  });

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
