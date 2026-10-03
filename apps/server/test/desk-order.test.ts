import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool } from './helpers/db.ts';
import { seed } from './helpers/seed.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const scope = () => ({ orgId: w.owner.id, projectId: w.projectId, audience: 'project' as const });
const fakeCards = (n: number) => Array.from({ length: n }, () => randomUUID());

async function question(title: string, o: { blocking: boolean; affected: number }) {
  const deskItemId = randomUUID();
  await seed(w, [
    {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'QuestionRaised',
        payload: {
          deskItemId,
          projectId: w.projectId,
          askedBy: { kind: 'agent', role: 'builder' },
          question: title,
          blocking: o.blocking,
          pinned: o.blocking,
          affectedCardIds: fakeCards(o.affected),
        },
      },
      actor: { kind: 'system', id: null },
      scope: scope(),
    },
  ]);
  w.t.clock.advance(60_000);
  return deskItemId;
}

async function created(
  title: string,
  o: { kind: 'approval' | 'alert'; subkind: string; pinned: boolean; affected?: number },
) {
  const deskItemId = randomUUID();
  await seed(w, [
    {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: o.kind,
          subkind: o.subkind,
          title,
          projectId: w.projectId,
          pinned: o.pinned,
          affectedCardIds: fakeCards(o.affected ?? 0),
        },
      },
      actor: { kind: 'system', id: null },
      scope: scope(),
    },
  ]);
  w.t.clock.advance(60_000);
  return deskItemId;
}

const titles = async (cookie = w.owner.cookie, qs = '') =>
  (await ok<any>(w.t.req('GET', `/api/desk${qs}`, { cookie }))).items.map((i: any) => i.title);

describe('desk order (docs/ARCHITECTURE.md section 15)', () => {
  it('sorts pinned, then blocking, then affected-card count, then age; urgent items carry the badge', async () => {
    await freshState();
    // Alerts are in-app only: no email (or any other channel) goes out for urgent items.
    const mails: unknown[] = [];
    w.t.app.ctx.mailer.send = async (m) => {
      mails.push(m);
    };
    await question('A non-blocking, 1 card, oldest', { blocking: false, affected: 1 });
    await question('B blocking, 1 card', { blocking: true, affected: 1 });
    await question('C blocking, 3 cards, older', { blocking: true, affected: 3 });
    await created('D tester bottleneck', { kind: 'alert', subkind: 'tester_bottleneck', pinned: true });
    await question('E blocking, 3 cards, newer', { blocking: true, affected: 3 });
    await question('F non-blocking, 5 cards, newest', { blocking: false, affected: 5 });
    await created('G approval, no cards', { kind: 'approval', subkind: 'large_merge', pinned: false });

    const res = await ok<any>(w.t.req('GET', '/api/desk', { cookie: w.owner.cookie }));
    expect(res.items.map((i: any) => i.title.split(' ')[0])).toEqual(['C', 'E', 'B', 'D', 'F', 'A', 'G']);
    expect(res.items.map((i: any) => i.urgent)).toEqual([true, true, true, true, false, false, false]);
    expect(res.items[3]).toMatchObject({
      kind: 'alert',
      subkind: 'tester_bottleneck',
      blocking: false,
      urgent: true,
    });
    expect(res.counts).toEqual({ open: 7, blocking: 3, urgent: 4 });
    expect(mails).toEqual([]);
  });

  it('filters by project and status; closed items follow newest first', async () => {
    const [first] = (await ok<any>(w.t.req('GET', '/api/desk', { cookie: w.owner.cookie }))).items;
    await ok(
      w.t.req('POST', `/api/desk/${first.id}/answer`, { cookie: w.owner.cookie, body: { answer: 'go' } }),
    );
    expect((await titles()).length).toBe(6);
    expect(await titles(w.owner.cookie, '?status=closed')).toEqual([first.title]);
    expect((await titles(w.owner.cookie, '?status=all')).at(-1)).toBe(first.title);
    expect(await titles(w.owner.cookie, `?projectId=${randomUUID()}`)).toEqual([]);
    expect((await titles(w.owner.cookie, `?projectId=${w.projectId}`)).length).toBe(6);
  });

  it("never lists another user's items and does not list admin-only data", async () => {
    const other = await w.t.userSession(uniqueEmail('other'));
    expect(await titles(other.cookie)).toEqual([]);
    const admin = await w.t.userSession(uniqueEmail('admin'), 'admin');
    expect(await titles(admin.cookie)).toEqual([]);
  });
});
