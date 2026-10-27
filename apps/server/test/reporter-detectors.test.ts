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
const reporter = () => w.t.app.ctx.services.signals;
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
    // dedup: a second sweep raises nothing new; the BA reporter is retired, so no BA task is queued either
    expect((await reporter().run()).raised).toBe(0);
    expect(await q(`SELECT 1 FROM ba_tasks`)).toHaveLength(0);

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

    // asked again after the manager rejected it: urgent
    const asked = s!.subject.deskItemIds[0] as string;
    await q(`UPDATE desk_items SET status='answered', answer_option='rejected' WHERE id=$1`, [asked]);
    await reporter().run();
    expect((await open('repeated_approval'))[0]).toMatchObject({ urgency: 'urgent' });
    expect(await q(`SELECT 1 FROM ba_tasks`)).toHaveLength(0);
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

describe('review risk (report only)', () => {
  const risk = (level: string) => JSON.stringify({ level, analysis: 'touches billing', qaFocus: '' });
  const wait = async (id: string, level: string | null, hoursAgo: number, extra = `stage='owner_approval'`) =>
    q(`UPDATE cards SET status='waiting', ${extra}, review_risk=$2::jsonb, updated_at=$3 WHERE id=$1`, [
      id,
      level === null ? null : risk(level),
      new Date(w.t.clock.now().getTime() - hoursAgo * 3600_000),
    ]);

  it('high_risk_waiting: only a high-risk card past the threshold, never low, medium, unknown or NULL, never twice', async () => {
    await clean();
    const hi = await w.card({ title: 'High risk, waiting' });
    const fresh = await w.card({ title: 'High risk, fresh' });
    const merge = await w.card({ title: 'High risk, merge waits' });
    const others = [];
    for (const lvl of ['low', 'medium', 'unknown', null])
      others.push([lvl, await w.card({ title: `risk ${lvl}` })] as const);
    const late = REPORTER.highRiskWaitHours + 1;
    await wait(hi.id, 'high', late);
    await wait(fresh.id, 'high', REPORTER.highRiskWaitHours - 1);
    await wait(merge.id, 'high', late, `stage='testing', finalize_state='awaiting_approval'`);
    for (const [lvl, c] of others) await wait(c.id, lvl, late);

    await reporter().run();
    const found = await open('high_risk_waiting');
    expect(found.map((s) => s.fingerprint).sort()).toEqual(
      [`high_risk_waiting:card:${hi.id}`, `high_risk_waiting:card:${merge.id}`].sort(),
    );
    expect(found[0]).toMatchObject({ urgency: 'normal', kind: 'high_risk_waiting' });

    // A second sweep raises nothing new; the signals stay at one row each.
    expect((await reporter().run()).raised).toBe(0);
    expect(await signals('high_risk_waiting')).toHaveLength(2);

    // Rework resets the risk to NULL: the signal clears.
    await q(`UPDATE cards SET review_risk=NULL WHERE id=$1`, [hi.id]);
    await reporter().run();
    expect((await open('high_risk_waiting')).map((s) => s.fingerprint)).toEqual([
      `high_risk_waiting:card:${merge.id}`,
    ]);
  });

  it('high_risk_waiting: finalize approval outside owner_approval fires, finalize running does not, and an edit while waiting does not restart the clock', async () => {
    await clean();
    const late = REPORTER.highRiskWaitHours + 1;
    const fin = await w.card({ title: 'Merge approval stale' });
    const running = await w.card({ title: 'Merge running' });
    const edited = await w.card({ title: 'Edited while waiting' });
    await wait(fin.id, 'high', late, `stage='testing', finalize_state='awaiting_approval'`);
    await wait(running.id, 'high', late, `stage='testing', finalize_state='running'`);
    await wait(edited.id, 'high', late);
    const enteredAt = new Date(w.t.clock.now().getTime() - late * 3600_000);
    await q(
      `INSERT INTO card_transitions (card_id, from_stage, to_stage, from_status, to_status, reason, event_seq, at)
       VALUES ($1,'review','owner_approval','working','waiting','test',0,$2)`,
      [edited.id, enteredAt],
    );
    // a title edit while it waits bumps updated_at only
    await q(`UPDATE cards SET title='Edited title', updated_at=$2 WHERE id=$1`, [edited.id, w.t.clock.now()]);
    await reporter().run();
    expect((await open('high_risk_waiting')).map((s) => s.fingerprint).sort()).toEqual(
      [`high_risk_waiting:card:${fin.id}`, `high_risk_waiting:card:${edited.id}`].sort(),
    );
  });

  it('the digest window: a finish before the last report is left out, one after it is in; the first report looks back 24 hours', async () => {
    await clean();
    const { buildFloorDigest } = await import('../src/ceo/digest.ts');
    const now = w.t.clock.now();
    const finish = async (title: string, at: Date) => {
      const c = await w.card({ title });
      await q(
        `UPDATE cards SET status='done', stage='done', finalized_at=$2, review_risk=$3::jsonb WHERE id=$1`,
        [c.id, at, risk('high')],
      );
      return c;
    };
    const old = await finish('Two days ago', new Date(now.getTime() - 48 * 3600_000));
    const recent = await finish('An hour ago', new Date(now.getTime() - 3600_000));
    let d = await buildFloorDigest(w.t.app.ctx.pool, w.owner.id, now, '2026-10-27');
    expect(d.highRiskMerges.map((m) => m.ref)).toEqual([recent.ref]); // no earlier report: 24 hours only
    const before = await finish('Before the report', new Date(now.getTime() - 2 * 3600_000));
    await q(
      `INSERT INTO desk_items (id, org_id, kind, subkind, title, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'alert', 'ceo_report', 'Daily report', 'open', $2, $2)`,
      [w.owner.id, new Date(now.getTime() - 5400_000)],
    );
    d = await buildFloorDigest(w.t.app.ctx.pool, w.owner.id, now, '2026-10-27');
    // the report 90 minutes ago bounds the window: the finish an hour ago is in, the ones before it are out
    expect(d.highRiskMerges.map((m) => m.ref)).toEqual([recent.ref]);
    expect([old.ref, before.ref]).not.toContain(d.highRiskMerges[0]?.ref);
  });

  it('the daily digest lists high-risk merges of the day, and omits the section when there are none', async () => {
    await clean();
    const { buildFloorDigest } = await import('../src/ceo/digest.ts');
    const { renderFloorReportFallback } = await import('@aom/shared');
    const now = w.t.clock.now();
    const done = async (title: string, level: string | null) => {
      const c = await w.card({ title });
      await q(
        `UPDATE cards SET status='done', stage='done', finalized_at=$2, review_risk=$3::jsonb WHERE id=$1`,
        [c.id, now, level === null ? null : risk(level)],
      );
      return c;
    };
    await done('Low one', 'low');
    await done('Unknown one', 'unknown');
    await done('No risk call', null);
    let d = await buildFloorDigest(w.t.app.ctx.pool, w.owner.id, now, '2026-10-27');
    expect(d.highRiskMerges).toEqual([]);
    expect(renderFloorReportFallback(d)).not.toContain('High-risk cards finished');

    const hi = await done('Rewrote the billing path', 'high');
    d = await buildFloorDigest(w.t.app.ctx.pool, w.owner.id, now, '2026-10-27');
    expect(d.highRiskMerges).toEqual([
      expect.objectContaining({
        ref: hi.ref,
        title: 'Rewrote the billing path',
        analysis: 'touches billing',
      }),
    ]);
    const text = renderFloorReportFallback(d);
    expect(text).toContain('## High-risk cards finished');
    expect(text).toContain(hi.ref);
  });
});

describe("the BA reporter is retired: signals are the CEO's to hear about", () => {
  it('an urgent signal queues no BA task and no desk report; a signal that clears acknowledges the old BA report item', async () => {
    await clean();
    const asked = [
      await approval('DevOps needs approval: wipe the docker volumes'),
      await approval('DevOps needs approval: wipe the docker volumes'),
      await approval('DevOps needs approval: wipe the docker volumes'),
    ];
    await q(`UPDATE desk_items SET status='answered', answer_option='rejected' WHERE id=$1`, [asked[0]]);
    await reporter().run();
    await dispatcher().run();
    const [s] = await open('repeated_approval');
    expect(s).toMatchObject({ urgency: 'urgent', status: 'open' });
    expect(await q(`SELECT 1 FROM ba_tasks`)).toHaveLength(0);
    expect(await q(`SELECT 1 FROM desk_items WHERE subkind='ba_report'`)).toHaveLength(0);

    // an old BA report item that points at the signal (written before the reporter was retired) is acknowledged on clear
    const old = randomUUID();
    await seed(w, [
      {
        streamId: streamId.desk(old),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId: old,
            kind: 'alert',
            subkind: 'ba_report',
            title: 'Repeated approval: wipe the docker volumes',
            body: 'old BA analysis',
            projectId: w.projectId,
            askedBy: { kind: 'system' },
          },
        },
        actor: SYSTEM,
        scope: scope(),
      },
      {
        streamId: streamId.baSignal(s!.id),
        event: { type: 'BaSignalReported', payload: { signalId: s!.id, deskItemId: old } },
        actor: SYSTEM,
        scope: scope(),
      },
    ]);
    await q(`UPDATE desk_items SET created_at = created_at - interval '2 days' WHERE subkind='devops'`);
    await reporter().run();
    expect((await q('SELECT status FROM desk_items WHERE id=$1', [old]))[0]?.status).toBe('answered');
  });
});
