import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { followUpSweep } from '../src/commands/follow-up.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const snapshot = async () => ({
  policy: await q('SELECT agent_id, org_id, allow_members FROM agent_mention_policy ORDER BY agent_id'),
  mentions: await q(
    'SELECT id, org_id, project_id, card_id, agent_id, requested_by, comment_id, status, reason FROM card_mentions ORDER BY id',
  ),
  days: await q('SELECT org_id, days FROM org_follow_up ORDER BY org_id'),
  follow: await q(
    'SELECT desk_item_id, org_id, last_nudge_at, nudge_count, snoozed_until FROM desk_follow_ups ORDER BY desk_item_id',
  ),
  desk: await q('SELECT id, status, routed_to FROM desk_items ORDER BY id'),
});

describe('S-B2 projections rebuild to the same state', () => {
  it('mentions, policy, chase window, nudges, re-queues and snoozes replay', async () => {
    const agent = await w.hire('Una', 'builder', 'junior');
    await ok(
      w.t.req('PUT', `/api/agents/${agent.id}/mention-policy`, {
        cookie: w.owner.cookie,
        body: { allowMembers: true },
      }),
    );
    const card = await w.card();
    await w.t.req('POST', `/api/cards/${card.id}/comments`, {
      cookie: w.owner.cookie,
      body: { body: '@una hi' },
    });
    const start = await r.waitFor('chat.start', (f) => f.threadId === card.id);
    r.send('chat.done', {
      chatId: start.chatId,
      threadId: start.threadId,
      messageText: 'hello',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    await until(async () => (await q(`SELECT status FROM card_mentions`))[0]?.status === 'replied');
    await ok(w.t.req('PUT', '/api/org/follow-up', { cookie: w.owner.cookie, body: { days: 2 } }));
    const mk = async (over: Record<string, unknown>) => {
      const id = randomUUID();
      await seed(w, [
        {
          streamId: streamId.desk(id),
          event: {
            type: 'QuestionRaised',
            payload: {
              deskItemId: id,
              question: 'Which provider?',
              blocking: false,
              pinned: false,
              affectedCardIds: [],
              askedBy: { kind: 'system' },
              ...over,
            },
          } as never,
          actor: { kind: 'system', id: null },
          scope: { orgId: w.owner.id, projectId: null, audience: 'org' },
        },
      ]);
      return id;
    };
    const person = await mk({});
    const withAgent = await mk({ routedTo: 'agent', routedAgentId: agent.id });
    const snoozed = await mk({});
    await ok(w.t.req('POST', `/api/desk/${snoozed}/snooze`, { cookie: w.owner.cookie, body: { days: 4 } }));
    await q(
      `UPDATE desk_items SET updated_at = updated_at - interval '3 days', created_at = created_at - interval '3 days'`,
    );
    expect(await followUpSweep(w.t.app.ctx)).toEqual({ nudged: 1, requeued: 1 });
    const before = await snapshot();
    expect(before.follow.map((f: any) => f.desk_item_id).sort()).toEqual([person, withAgent, snoozed].sort());
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await snapshot()).toEqual(before);
  });
});
