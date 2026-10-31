import { describe, expect, it } from 'vitest';
import { cardOutput } from '../src/commands/schedule-output.ts';
import type { Ctx } from '../src/context.ts';
import type { Queryable } from '../src/db/sql.ts';

const ctx = { config: { publicOrigin: 'https://aom.test' } } as unknown as Ctx;
const LEDGER = '0192f3a0-1111-7000-8000-000000000001';
const fake = (workflowKey: string | null): Queryable =>
  ({
    query: async (text: string) => {
      if (text.includes('FROM thread_messages'))
        return {
          rows: [{ body: 'Start with WEB-1. Rule 0192f3a0 says reply in a day. WEB-99 is made up.' }],
        };
      if (text.includes('workflow_versions')) return { rows: [{ org_id: 'org', key: workflowKey }] };
      if (text.includes('FROM ledger_entries')) return { rows: [{ id: LEDGER, title: 'Reply in a day' }] };
      if (text.includes('ref = ANY')) return { rows: [{ ref: 'WEB-1', title: 'Call Jo' }] };
      return {
        rows: [
          { id: 'c1', ref: 'WEB-9', title: 'Morning plan', investigation: null, investigation_only: false },
        ],
      };
    },
  }) as never;

describe('cardOutput of a Brief card', () => {
  it('adds links to the cards and rules it cites, and only to real ones', async () => {
    const o = await cardOutput(ctx, fake('business-brief-personal-assistant'), 'c1');
    expect(o?.links).toEqual([
      { label: 'WEB-1 Call Jo', url: 'https://aom.test/cards/WEB-1' },
      { label: 'Rule: Reply in a day', url: `https://aom.test/ledger?entry=${LEDGER}` },
    ]);
    expect(o?.text).toContain('Start with WEB-1');
  });
  it('leaves any other card exactly as it was', async () => {
    const o = await cardOutput(ctx, fake('code'), 'c1');
    expect(o?.links).toBeUndefined();
    expect(Object.keys(o ?? {}).sort()).toEqual(['link', 'ref', 'source', 'text', 'title']);
  });
});
