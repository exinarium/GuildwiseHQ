import { randomUUID } from 'node:crypto';
import { DESK_SUBKIND, REPORTER, streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const scope = () => ({ orgId: w.owner.id, projectId: w.projectId, audience: 'project' as const });
const SYSTEM = { kind: 'system' as const, id: null };
const reporter = () => w.t.app.ctx.services.reporter;
const dispatcher = () => w.t.app.ctx.services.dispatcher;
const signals = (kind?: string) =>
  q(`SELECT * FROM ba_signals WHERE ($1::text IS NULL OR kind=$1) ORDER BY first_seen_at`, [kind ?? null]);
const open = async (kind: string) => (await signals(kind)).filter((s) => s.status !== 'resolved');

async function clean() {
  await q(
    `TRUNCATE cards, card_dependencies, card_handoffs, card_transitions, shifts, thread_messages, desk_items,
       card_blockers, ledger_entries, ba_tasks, ba_signals, runner_commands, runner_inbox CASCADE`,
  );
}

async function approval(title: string, over: Record<string, unknown> = {}) {
  const id = randomUUID();
  await seed(w, [
    {
      streamId: streamId.desk(id),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId: id,
          kind: 'approval',
          subkind: 'devops',
          title,
          body: 'why',
          blocking: true,
          pinned: true,
          projectId: w.projectId,
          askedBy: { kind: 'system' },
          ...over,
        },
      },
      actor: SYSTEM,
      scope: scope(),
    },
  ]);
  return id;
}

describe('detectors: one fixture per threshold, plus a control', () => {
  it('shift loop: an open loop-breaker episode raises one urgent signal tied to its alert, and clears with it', async () => {
    await clean();
    const card = await w.card({ title: 'Looping' });
    // control: a card with no episode raises nothing
    await reporter().run();
    expect(await signals('loop')).toHaveLength(0);

    const alertId = randomUUID();
    const episodeId = randomUUID();
    await seed(w, [
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'CardRetryDeferred',
          payload: {
            cardId: card.id,
            until: new Date(w.t.clock.now().getTime() + 60_000).toISOString(),
            failures: REPORTER.loop.failures,
            episodeId,
            newEpisode: true,
          },
        },
        actor: SYSTEM,
        scope: scope(),
      },
      {
        streamId: streamId.desk(alertId),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId: alertId,
            kind: 'alert',
            subkind: DESK_SUBKIND.loopBackoff,
            title: `${card.ref} keeps failing`,
            cardId: card.id,
            projectId: w.projectId,
            affectedCardIds: [card.id],
            askedBy: { kind: 'system' },
          },
        },
        actor: SYSTEM,
        scope: scope(),
      },
    ]);
    const out = await reporter().run();
    expect(out.raised).toBe(1);
    const [s] = await open('loop');
    expect(s).toMatchObject({
      urgency: 'urgent',
      fingerprint: `loop:card:${card.id}`,
      count: 3,
      status: 'open',
    });
    expect(s!.subject).toMatchObject({ cardRef: card.ref, deskItemId: alertId });
    // dedup: a second sweep raises nothing new and queues no second alert task
    expect((await reporter().run()).raised).toBe(0);
    expect(await q(`SELECT 1 FROM ba_tasks WHERE kind='floor_alert'`)).toHaveLength(1);

    // the failures go on: the same signal is updated, not duplicated
    await seed(w, [
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'CardRetryDeferred',
          payload: {
            cardId: card.id,
            until: new Date(w.t.clock.now().getTime() + 120_000).toISOString(),
            failures: 4,
            episodeId,
            newEpisode: false,
          },
        },
        actor: SYSTEM,
        scope: scope(),
      },
    ]);
    await reporter().run();
    expect(await open('loop')).toHaveLength(1);
    expect((await open('loop'))[0]!.count).toBe(4);

    // the manager releases the back-off: the signal resolves
    await seed(w, [
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'CardRetryReleased',
          payload: { cardId: card.id, episodeId, releasedBy: w.owner.id, reason: 'released by hand' },
        },
        actor: SYSTEM,
        scope: scope(),
      },
    ]);
    const cleared = await reporter().run();
    expect(cleared.resolved).toBe(1);
    expect((await signals('loop'))[0]!.status).toBe('resolved');
  });

  it('repeated approval: the same action 3 times in 24 hours; fewer, or different actions, do not count', async () => {
    await clean();
    await approval('DevOps needs approval: docker compose up the stack');
    await approval('DevOps needs approval: docker compose up the stack again');
    await reporter().run();
    expect(await signals('repeated_approval')).toHaveLength(0);
    // a different action does not make a third
    await approval('DevOps needs approval: rotate the production database password');
    await reporter().run();
    expect(await signals('repeated_approval')).toHaveLength(0);

    await approval('DevOps needs approval: docker compose up the stack once more');
    await reporter().run();
    const [s] = await open('repeated_approval');
    expect(s).toMatchObject({ urgency: 'normal', count: 3 });
    expect(s!.subject.deskItemIds).toHaveLength(3);
    // normal urgency: no immediate alert task
    expect(await q(`SELECT 1 FROM ba_tasks WHERE kind='floor_alert'`)).toHaveLength(0);

    // asked again after the manager rejected it: urgent
    const asked = s!.subject.deskItemIds[0] as string;
    await q(`UPDATE desk_items SET status='answered', answer_option='rejected' WHERE id=$1`, [asked]);
    await reporter().run();
    expect((await open('repeated_approval'))[0]).toMatchObject({ urgency: 'urgent' });
    expect(await q(`SELECT 1 FROM ba_tasks WHERE kind='floor_alert'`)).toHaveLength(1);
  });

  it('repeated approval: asks older than 24 hours do not count', async () => {
    await clean();
    await approval('DevOps needs approval: restart the build agent');
    await approval('DevOps needs approval: restart the build agent');
    w.t.clock.advance(25 * 3600_000);
    await approval('DevOps needs approval: restart the build agent');
    await reporter().run();
    expect(await signals('repeated_approval')).toHaveLength(0);
  });

  it('blocked: more than 4 hours (3 hours is fine)', async () => {
    await clean();
    const card = await w.card({ title: 'Waiting for an answer' });
    await q(`UPDATE cards SET status='blocked', blocked_since=$2 WHERE id=$1`, [
      card.id,
      new Date(w.t.clock.now().getTime() - 3 * 3600_000),
    ]);
    await reporter().run();
    expect(await signals('blocked')).toHaveLength(0);
    w.t.clock.advance(1.5 * 3600_000);
    await reporter().run();
    const [s] = await open('blocked');
    expect(s).toMatchObject({ urgency: 'normal', fingerprint: `blocked:card:${card.id}` });
    expect(s!.subject.title).toContain('blocked for 4 hours');
    await q(`UPDATE cards SET status='queued', blocked_since=NULL WHERE id=$1`, [card.id]);
    expect((await reporter().run()).resolved).toBe(1);
  });

  it('unclaimed: queued more than 30 minutes with no agent able to take it', async () => {
    await clean();
    await q('DELETE FROM agents WHERE role_key = $1', ['builder']);
    const card = await w.card({ title: 'Nobody builds this' });
    w.t.clock.advance(29 * 60_000);
    await reporter().run();
    expect(await signals('unclaimed')).toHaveLength(0);
    w.t.clock.advance(2 * 60_000);
    await reporter().run();
    const [s] = await open('unclaimed');
    expect(s).toMatchObject({ urgency: 'normal', fingerprint: `unclaimed:card:${card.id}` });
    expect(s!.subject.detail).toContain('Not workable');
  });

  it('repeated failures: rework round 3 and two failed finalizes', async () => {
    await clean();
    const a = await w.card({ title: 'Reworked' });
    const b = await w.card({ title: 'Finalize keeps failing' });
    const c = await w.card({ title: 'Fine' });
    await q(`UPDATE cards SET rework_round = 2 WHERE id=$1`, [c.id]);
    await q(`UPDATE cards SET rework_round = $2 WHERE id=$1`, [a.id, REPORTER.reworkRounds]);
    for (let i = 0; i < REPORTER.finalizeFailures; i++)
      await approval(`Finalize failed ${i}`, {
        kind: 'escalation',
        subkind: 'finalize_failed',
        cardId: b.id,
      });
    await reporter().run();
    expect((await open('rework')).map((s) => s.fingerprint)).toEqual([`rework:card:${a.id}`]);
    expect((await open('finalize_failures')).map((s) => s.fingerprint)).toEqual([`finalize:card:${b.id}`]);
  });
});

describe('no BA: the server posts the notice itself', () => {
  it('an urgent signal becomes a template alert; the loop alert gets a note instead of a second item', async () => {
    await clean();
    const card = await w.card({ title: 'Looping without a BA' });
    const alertId = randomUUID();
    const episodeId = randomUUID();
    await seed(w, [
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'CardRetryDeferred',
          payload: {
            cardId: card.id,
            until: new Date(w.t.clock.now().getTime() + 60_000).toISOString(),
            failures: 3,
            episodeId,
            newEpisode: true,
          },
        },
        actor: SYSTEM,
        scope: scope(),
      },
      {
        streamId: streamId.desk(alertId),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId: alertId,
            kind: 'alert',
            subkind: DESK_SUBKIND.loopBackoff,
            title: 'keeps failing',
            cardId: card.id,
            projectId: w.projectId,
            askedBy: { kind: 'system' },
          },
        },
        actor: SYSTEM,
        scope: scope(),
      },
    ]);
    await reporter().run();
    await dispatcher().run(); // no BA is hired: the task is done by the server at once
    const task = (await q(`SELECT * FROM ba_tasks WHERE kind='floor_alert'`))[0]!;
    expect(task.status).toBe('fallback');
    const item = (await q('SELECT ba_note FROM desk_items WHERE id=$1', [alertId]))[0]!;
    expect(item.ba_note).toContain('No BA was available');
    expect((await signals('loop'))[0]!.status).toBe('reported');
    expect(await q(`SELECT 1 FROM desk_items WHERE subkind='ba_report'`)).toHaveLength(0);
  });

  it('a signal with no alert of its own gets an alert/ba_report item', async () => {
    await clean();
    const asked = [
      await approval('DevOps needs approval: wipe the docker volumes'),
      await approval('DevOps needs approval: wipe the docker volumes'),
      await approval('DevOps needs approval: wipe the docker volumes'),
    ];
    await q(`UPDATE desk_items SET status='answered', answer_option='rejected' WHERE id=$1`, [asked[0]]);
    await reporter().run();
    await dispatcher().run();
    const item = (await q(`SELECT * FROM desk_items WHERE subkind='ba_report'`))[0]!;
    expect(item).toMatchObject({ kind: 'alert', status: 'open', asked_by_kind: 'system', pinned: false });
    expect(item.title).toContain('Repeated approval');
    expect(item.body).toContain('No BA was available');
    // the signal clears: the report is acknowledged on its own
    await q(`UPDATE desk_items SET created_at = created_at - interval '2 days' WHERE subkind='devops'`);
    await reporter().run();
    expect((await q('SELECT status FROM desk_items WHERE id=$1', [item.id]))[0]?.status).toBe('answered');
  });
});
