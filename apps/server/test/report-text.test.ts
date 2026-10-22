import { randomUUID } from 'node:crypto';
import { renderFloorReportFallback } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFloorDigest } from '../src/ceo/digest.ts';
import { plainText, REPORT_SUMMARY_MAX, summarize } from '../src/ceo/report-text.ts';
import { blockingQuestion } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, type World } from './helpers/world.ts';

describe('plain report text', () => {
  it('drops internal validation messages and unknown question ids', () => {
    expect(plainText("question 7d92c125… option o1 is not one of the item's options")).toBe('a question');
    expect(plainText("--option o1 is not one of the item's options")).toBe('');
    expect(plainText('Stuck on question 7d92c125-aaaa-bbbb. Please look.')).toBe(
      'Stuck on a question. Please look.',
    );
  });
  it('names a known question by its title', () => {
    const titles = new Map([['7d92c125', 'Which database?']]);
    expect(plainText('waiting on question 7d92c125…', titles)).toBe(
      'waiting on the question "Which database?"',
    );
  });
  it('cuts a long body to its first line', () => {
    const body = `Resolve the merge conflict on card TOY-4.\n${'Step. '.repeat(500)}`;
    expect(summarize(body)).toBe('Resolve the merge conflict on card TOY-4.');
    expect(summarize('x'.repeat(1000)).length).toBeLessThanOrEqual(REPORT_SUMMARY_MAX);
  });
});

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: ['runs:1'] });
  await w.hire('Bea', 'builder', 'junior', { model: 'sonnet' });
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

describe('the daily report facts', () => {
  it('show a question by its title, hide validation messages and shorten a DevOps conflict prompt', async () => {
    const ctx = w.t.app.ctx;
    const { id } = await blockingQuestion(w, { title: 'Which database should we use?' });
    const now = new Date();
    await q(
      `INSERT INTO ba_signals (id, org_id, kind, fingerprint, urgency, subject, status, first_seen_at, last_seen_at)
       VALUES ($1,$2,'rework','test:1','normal',$3,'open',$4,$4)`,
      [
        randomUUID(),
        w.owner.id,
        JSON.stringify({
          title: `question ${id.slice(0, 8)}…`,
          detail: "option o1 is not one of the item's options",
        }),
        now,
      ],
    );
    const ws = (await q('SELECT id FROM workstations LIMIT 1'))[0]?.id ?? null;
    const agent = (await q('SELECT id FROM agents LIMIT 1'))[0]?.id ?? null;
    const prompt = `Resolve the merge conflict on card TOY-4.\n${'Conflicting file: src/app.ts. '.repeat(200)}`;
    expect(ws && agent).toBeTruthy();
    await q(
      `INSERT INTO devops_requests (id, org_id, workstation_id, devops_agent_id, thread_id, requested_by_kind, summary, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'system',$6,'queued',$7,$7)`,
      [randomUUID(), w.owner.id, ws, agent, randomUUID(), prompt, now],
    );
    const digest = await buildFloorDigest(ctx.pool, w.owner.id, now, '2026-10-22');
    const sig = digest.signals.find((s) => s.fingerprint === 'test:1');
    expect(sig?.subject.title).toBe('the question "Which database should we use?"');
    expect(sig?.subject.detail).toBe('');
    const text = renderFloorReportFallback(digest);
    expect(text).not.toContain(id.slice(0, 8));
    expect(text).not.toContain('is not one of the item');
    expect(digest.devopsOpen[0]?.summary).toBe('Resolve the merge conflict on card TOY-4.');
    expect(text).not.toContain('Conflicting file');
  });
});
