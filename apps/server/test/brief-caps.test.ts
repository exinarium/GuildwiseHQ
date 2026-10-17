import { randomUUID } from 'node:crypto';
import { renderShiftPrompt, streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CARD_LEDGER_MAX_BYTES, CARD_LEDGER_MAX_ENTRIES, capLedgerEntries } from '../src/queries/ledger.ts';
import { buildBrief, capThread, THREAD_MAX_BYTES, THREAD_MAX_MESSAGES } from '../src/runner-gateway/brief.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { hireTeam } from './helpers/pipeline.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, type World } from './helpers/world.ts';

// Lean Team v3 (S1b), section 9 "Ledger and thread bloat": the brief stays under its cap with 211 entries and 30 long messages.

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  await hireTeam(w);
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('capping helpers', () => {
  it('keeps the newest entries as one-liners within the byte budget', () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      title: `Entry ${i}`,
      body: `${'x'.repeat(2000)}\n${i}`,
    }));
    const capped = capLedgerEntries(entries); // newest first in, oldest-to-newest out
    expect(capped.length).toBeLessThanOrEqual(CARD_LEDGER_MAX_ENTRIES);
    expect(capped.every((e) => !e.body.includes('\n'))).toBe(true);
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(CARD_LEDGER_MAX_BYTES);
    expect(capped[capped.length - 1]?.title).toBe('Entry 0');
  });

  it('keeps the last messages of a thread within the byte budget, oldest first', () => {
    const msgs = Array.from({ length: 30 }, (_, i) => ({ body: `${i}:${'y'.repeat(2000)}` }));
    const capped = capThread(msgs);
    expect(capped.length).toBeLessThanOrEqual(THREAD_MAX_MESSAGES);
    expect(capped.length).toBeGreaterThan(0);
    expect(capped.reduce((n, m) => n + Buffer.byteLength(m.body), 0)).toBeLessThanOrEqual(THREAD_MAX_BYTES);
    expect(capped[capped.length - 1]?.body.startsWith('29:')).toBe(true);
    expect(capThread(msgs, true)).toHaveLength(30);
  });
});

describe('the brief of a card with 211 ledger entries and 30 long messages', () => {
  it('stays under its cap, points at ledger search, and keeps Q&A out of Constraints', async () => {
    const card = await w.card({ title: 'Bloat card' });
    const builder = (await q(`SELECT id FROM agents WHERE name='Bea'`))[0]!;
    const orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]!.org_id as string;
    const events = [];
    for (let i = 0; i < 211; i++) {
      const entryId = randomUUID();
      events.push({
        streamId: streamId.ledger(entryId),
        event: {
          type: 'LedgerEntryAdded' as const,
          payload: {
            entryId,
            scope: 'decision' as const,
            projectId: w.projectId,
            cardId: card.id,
            title: `Decision ${i}`,
            body: `Question: what about ${i}?\n\nAnswer: ${'long answer '.repeat(80)}`,
            tags: [],
          },
        },
        actor: { kind: 'system' as const, id: null },
        scope: { orgId, projectId: w.projectId, audience: 'project' as const },
      });
    }
    await seed(w, events);
    for (let i = 0; i < 30; i++) {
      await q(
        `INSERT INTO thread_messages (id, thread_id, author_kind, kind, body, data, created_at, event_seq)
         VALUES ($1,$2,'system','comment',$3,'{}', now() + ($4 || ' seconds')::interval, $5)`,
        [randomUUID(), card.id, `${i}: ${'z'.repeat(1500)}`, String(i), 1000 + i],
      );
    }
    const shift = {
      id: randomUUID(),
      kind: 'card',
      card_id: card.id,
      agent_id: builder.id,
      stage: card.stage,
    };
    const brief = await buildBrief(w.t.app.ctx, shift);
    expect(brief).not.toBeNull();
    expect(brief!.ledger.length).toBeLessThanOrEqual(CARD_LEDGER_MAX_ENTRIES);
    expect(brief!.ledgerTotal).toBe(211);
    expect(JSON.stringify(brief!.ledger).length).toBeLessThanOrEqual(CARD_LEDGER_MAX_BYTES + 600);
    expect(brief!.thread.length).toBeGreaterThan(0);
    expect(brief!.thread.length).toBeLessThanOrEqual(THREAD_MAX_MESSAGES);
    expect(brief!.thread.reduce((n, m) => n + m.body.length, 0)).toBeLessThanOrEqual(THREAD_MAX_BYTES);

    const text = renderShiftPrompt(brief!);
    expect(text.length).toBeLessThan(40_000);
    expect(text).toContain('aom ledger search');
    expect(text).toContain('## Decisions on this card');
    // Card Q&A is not under Constraints
    const constraints = text.split('## Constraints')[1]?.split('\n## ')[0] ?? '';
    expect(constraints).not.toContain('Decision 2');
    // an explicit pull still reads the whole thread
    const full = await buildBrief(w.t.app.ctx, shift, { fullThread: true });
    expect(full!.thread.length).toBeGreaterThan(THREAD_MAX_MESSAGES);
  });
});
