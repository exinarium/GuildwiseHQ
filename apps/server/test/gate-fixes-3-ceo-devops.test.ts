import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appoint,
  blockingQuestion,
  ceo,
  graduate,
  keepOnline,
  startCeoShift,
  wakeNow,
} from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, until, type World } from './helpers/world.ts';

/**
 * gate-fixes-3 (S5, AC5): a DevOps approval on the owner's Desk no longer wakes the CEO, and a CEO notice naming it is a
 * duplicate (Ada's "Urgent: pending on your Desk ... I can't approve DevOps actions" on UAT deploy 6). An escalation still
 * sends; a DevOps question still wakes the CEO.
 */
let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner({ capabilities: ['ceo:1'] });
  await appoint(w);
  await graduate(w);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const wakes = () => q(`SELECT * FROM ceo_wakes ORDER BY created_at`);
async function clean() {
  await q(`TRUNCATE ceo_wakes, ceo_batches, ceo_flags`);
  await q(`DELETE FROM desk_items WHERE subkind='ceo_notice' OR (kind='approval' AND subkind='devops')`);
  await q(`UPDATE shifts SET status='ended', ended_at=now() WHERE kind='ceo' AND status <> 'ended'`);
  await keepOnline(w);
}

async function deskItem(kind: string, subkind: string, title: string) {
  const id = randomUUID();
  await seed(w, [
    {
      streamId: streamId.desk(id),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId: id,
          kind,
          subkind,
          title,
          body: title,
          pinned: true,
          blocking: true,
          askedBy: { kind: 'system' },
        },
      },
      actor: { kind: 'system', id: null },
      scope: { orgId: w.owner.id, projectId: null, audience: 'org' },
    },
  ]);
  return id;
}

const mails = () => q(`SELECT 1 FROM events WHERE type='EmailQueued' OR type='NotificationEmailed'`);

describe('gate-fixes-3 AC5: no duplicate "Urgent" CEO notice for a DevOps approval on the Desk', () => {
  it('a DevOps approval enqueues no CEO wake; a DevOps question still does', async () => {
    await clean();
    await deskItem(
      'approval',
      'devops',
      'DevOps wants to run mkdir -p ~/.local/share/guildwise/toolchains/bun',
    );
    await new Promise((x) => setTimeout(x, 300));
    expect(await wakes()).toEqual([]);
    // a DevOps question goes through QuestionRaised (devops-routing.ts), as here
    await blockingQuestion(w, { title: 'DevOps asks: which port should the app use?', subkind: 'devops' });
    await until(async () => (await wakes()).length === 1, 3000, 'the question wakes the CEO');
  });

  it('`notify --item` naming an open DevOps approval returns duplicate (no ceo_notice, no mail); an escalation still sends', async () => {
    await clean();
    await wakeNow(w, 'desk_item', 'urgent');
    const start = await startCeoShift(w, r, r.received.length);
    const approval = await deskItem('approval', 'devops', 'DevOps wants to install Bun');
    const mailsBefore = (await mails()).length;
    const dup = (await ceo(r, start.shiftId, {
      op: 'notify',
      kind: 'urgent',
      text: "Pending on your Desk: DevOps approval to install Bun. I can't approve DevOps actions.",
      item: approval,
    })) as any;
    expect(dup.result.status).toBe('duplicate');
    expect(dup.result.message).toContain('cannot approve DevOps actions');
    expect(await q(`SELECT 1 FROM desk_items WHERE subkind='ceo_notice'`)).toEqual([]);
    expect((await mails()).length).toBe(mailsBefore);

    const escalation = await deskItem('escalation', 'tester_bottleneck', 'Testing is stuck on P4');
    const sent = (await ceo(r, start.shiftId, {
      op: 'notify',
      kind: 'urgent',
      text: 'Testing is stuck on P4 and needs your call.',
      item: escalation,
    })) as any;
    expect(sent.result.status).toBe('executed');
    expect(await q(`SELECT 1 FROM desk_items WHERE subkind='ceo_notice'`)).toHaveLength(1);
  });
});
