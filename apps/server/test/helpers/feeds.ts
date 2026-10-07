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

/**
 * An interest (docs/design/restructure.md Part D) as the owner of the world creates it: personal domain, run by hand (no
 * cadence), delivered at once. Returns its id and the id of its hidden backing project, whose key derives from the name
 * (`News` -> `NEWS`). Users never see that project; tests that need cards, items or members use its id.
 */
export async function createFeedInterest(
  w: World,
  over: Record<string, unknown> = {},
): Promise<{ id: string; projectId: string; key: string }> {
  const r = await ok<{ id: string }>(
    w.t.req('POST', '/api/interests', {
      cookie: w.owner.cookie,
      body: { name: 'News', domain: 'personal', scan: { manual: true }, ...over },
    }),
    201,
  );
  const row = (
    await q(
      'SELECT i.project_id, p.key FROM interests i JOIN projects p ON p.id = i.project_id WHERE i.id=$1',
      [r.id],
    )
  )[0];
  return { id: r.id, projectId: row?.project_id as string, key: row?.key as string };
}

/** The backing project of a new interest (for tests that only need a place for feed cards). */
export async function createFeedProject(w: World, over: Record<string, unknown> = {}): Promise<string> {
  return (await createFeedInterest(w, over)).projectId;
}

/**
 * A manual run of the interest ("Run now"). `patch` first changes the interest (`description`, `scan: {maxItems}`, ...),
 * so a test can say what the run's card should carry.
 */
export async function runNow(
  w: World,
  interestId: string,
  patch: Record<string, unknown> = {},
  cookie: string = w.owner.cookie,
): Promise<{ runId: string; cardId: string; ref: string }> {
  if (Object.keys(patch).length)
    await ok(w.t.req('PATCH', `/api/interests/${interestId}`, { cookie, body: patch }));
  return ok<{ runId: string; cardId: string; ref: string }>(
    w.t.req('POST', `/api/interests/${interestId}/run`, { cookie, body: {} }),
    201,
  );
}

/** The interest's running list (delivered items), oldest first. */
export async function feedItems(w: World, interestId: string, cookie: string = w.owner.cookie) {
  return (await ok<{ items: any[] }>(w.t.req('GET', `/api/interests/${interestId}/digest`, { cookie })))
    .items;
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
