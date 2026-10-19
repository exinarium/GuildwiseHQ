import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptTopic, proposeTopic, rejectTopic } from '../src/ceo/topics.ts';
import { sweepTopics } from '../src/ceo/topics-handoff.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { appoint } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, type World } from './helpers/world.ts';

/** The candidates are a projection of the CeoTopic* events: a rebuild gives the same rows (replay-safe). */
let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('replay', () => {
  it('rebuilding the projections reproduces ceo_topic_candidates', async () => {
    const ctx = w.t.app.ctx;
    const ceoId = await appoint(w);
    const orgId = w.owner.id;
    await q(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ('platform.team', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
      [JSON.stringify({ orgId, projectId: w.projectId })],
    );
    const ask = (text: string, area: string) =>
      proposeTopic(ctx, orgId, ceoId, { question: text, area, from: [] }, randomUUID());
    const a = await ask('How can teams verify rollbacks before every release goes out?', 'deploy');
    // the same question again: merged into the first
    await ask('How could teams verify rollbacks before every release goes out?', 'deploy');
    const b = await ask(
      'Why do long running agents lose their context during large refactors?',
      'context-limits',
    );
    const c = await ask('What makes agent loops stop making progress after several retries?', 'agent-loops');
    await acceptTopic(ctx, w.owner.id, orgId, a.candidateId as string);
    await rejectTopic(ctx, w.owner.id, orgId, b.candidateId as string, 'no');
    await sweepTopics(ctx);
    void c;

    const norm = async () =>
      (
        await q(
          `SELECT id, status, source_kind, question, area, occurrences, merged_into, topic_id, handed_off_at, decided_by,
                  evidence, note FROM ceo_topic_candidates ORDER BY id`,
        )
      ).map((r) => JSON.parse(JSON.stringify(r)));
    const before = await norm();
    expect(before.map((r) => r.status).sort()).toEqual(['merged', 'proposed', 'queued', 'rejected']);
    await rebuildProjections(ctx.pool, ctx.store);
    expect(await norm()).toEqual(before);
  });
});
