import { BRIEF_PLAYBOOKS } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { buildBriefContext } from '../src/commands/brief-context.ts';
import type { Queryable } from '../src/db/sql.ts';

const NOW = new Date('2026-11-02T05:00:00Z'); // Monday 07:00 in Johannesburg
const OPEN = [
  {
    ref: 'WEB-1',
    title: 'Call Jo',
    card_type: 'follow_up',
    status: 'queued',
    stage: 'prepare',
    priority: 1,
    fields: { dueDate: '2026-11-02' },
  },
  {
    ref: 'WEB-2',
    title: 'Renew licence',
    card_type: 'reminder',
    status: 'queued',
    stage: 'prepare',
    priority: 2,
    fields: { remindOn: '2026-10-30' },
  },
  {
    ref: 'WEB-3',
    title: 'Quote Acme',
    card_type: 'quote',
    status: 'queued',
    stage: 'prepare',
    priority: 2,
    fields: { validUntil: '2026-11-20' },
  },
];
const db = (over: Record<string, unknown[]> = {}): Queryable =>
  ({
    query: async (text: string) => {
      if (text.includes('FROM schedule_runs')) return { rows: over.runs ?? [] };
      if (text.includes("status='done'"))
        return {
          rows: over.done ?? [
            { ref: 'WEB-4', title: 'Sent invoice', card_type: 'report', status: 'done', stage: 'done' },
          ],
        };
      if (text.includes("status='blocked'"))
        return {
          rows: over.blocked ?? [
            {
              ref: 'WEB-5',
              title: 'Waiting on bank',
              card_type: 'document_request',
              status: 'blocked',
              stage: 'prepare',
              days: '3.2',
            },
          ],
        };
      if (text.includes('FROM ledger_entries'))
        return {
          rows: over.rules ?? [
            { id: '0192f3a0-1111-7000-8000-000000000001', title: 'Reply in a day', scope: 'standing_order' },
          ],
        };
      if (text.includes('created_at >=')) return { rows: over.created ?? [] };
      if (text.includes('FROM desk_items')) return { rows: over.desk ?? [{ title: 'Approve the quote' }] };
      return { rows: over.open ?? OPEN };
    },
  }) as never;
const args = {
  orgId: 'org',
  projectId: 'p',
  scheduleId: 's',
  playbook: BRIEF_PLAYBOOKS.morning_plan,
  now: NOW,
  timezone: 'Africa/Johannesburg',
  origin: 'https://aom.test/',
};

describe('buildBriefContext', () => {
  it('lists due, overdue, done, stuck, rules and owner items with links', async () => {
    const { context, period } = await buildBriefContext(db(), args);
    expect(context).toContain(
      '## Due today\n- WEB-1 Call Jo (follow_up, queued/prepare, due 2026-11-02): https://aom.test/cards/WEB-1',
    );
    expect(context).toMatch(/## Overdue\n- WEB-2 .*\[overdue 3 d\]/);
    expect(context).not.toMatch(/## Due today[^#]*WEB-3/);
    expect(context).toContain('## Done in the period\n- WEB-4 Sent invoice');
    expect(context).toContain('blocked 3 d): https://aom.test/cards/WEB-5');
    expect(context).toContain(
      '- [rule 0192f3a0] Reply in a day: https://aom.test/ledger?entry=0192f3a0-1111-7000-8000-000000000001',
    );
    expect(context).toContain('## Needs the owner\n- Approve the quote');
    expect(context).toContain('Knowledge notes: check your knowledge folder');
    expect(period).toMatch(/^since .*Africa\/Johannesburg/);
  });
  it('says none for an empty section', async () => {
    const { context } = await buildBriefContext(
      db({ open: [], done: [], blocked: [], rules: [], desk: [] }),
      args,
    );
    expect(context).toContain('## Due today\nnone');
    expect(context).toContain('## Needs the owner\nnone');
  });
  it('stays within the character cap', async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      ref: `WEB-${i + 10}`,
      title: 'x'.repeat(400),
      card_type: 'report',
      status: 'queued',
      stage: 'brief',
      priority: 2,
      fields: {},
    }));
    const { context } = await buildBriefContext(db({ open: many, done: many }), args);
    expect(context.length).toBeLessThanOrEqual(12_000);
  });
});
