import { describe, expect, it } from 'vitest';
import { checkBriefNote } from '../src/commands/brief-check.ts';
import type { Queryable } from '../src/db/sql.ts';

// No database: a fake Queryable answers by the text of the query.
const CARDS = ['WEB-1', 'WEB-2'];
const RULES = ['0192f3a0'];
const db = {
  query: async (text: string, params: unknown[]) => {
    if (text.includes('FROM cards'))
      return { rows: (params[1] as string[]).filter((r) => CARDS.includes(r)).map((ref) => ({ ref })) };
    if (text.includes('FROM ledger_entries'))
      return { rows: (params[1] as string[]).filter((r) => RULES.includes(r)).map((short) => ({ short })) };
    return { rows: [] };
  },
} as unknown as Queryable;

const card = (context = '- WEB-1 Call Jo (follow_up)', maxWords: unknown = 20) => ({
  ref: 'WEB-9',
  org_id: 'org',
  fields: { maxWords, context },
});

describe('checkBriefNote', () => {
  it('accepts a short brief that cites real cards and rules', async () => {
    expect(await checkBriefNote(db, card(), 'Call Jo today (WEB-1). Rule 0192f3a0 applies.')).toBeNull();
  });
  it('refuses an empty note', async () => {
    expect(await checkBriefNote(db, card(), '   ')).toMatch(/empty/);
  });
  it('refuses a note over the cap, saying how long it is', async () => {
    const long = `WEB-1 ${'word '.repeat(30)}`;
    expect(await checkBriefNote(db, card(), long)).toMatch(/31 words; the cap is 20/);
  });
  it('refuses refs that are not cards of the organization', async () => {
    expect(await checkBriefNote(db, card(), 'See WEB-1 and WEB-77.')).toMatch(
      /not cards of this organization: WEB-77/,
    );
  });
  it('refuses unknown rule ids', async () => {
    expect(await checkBriefNote(db, card(), 'WEB-1 and rule deadbeef.')).toMatch(/rule ids .*deadbeef/);
  });
  it('asks for refs when the Context lists cards and the note cites none', async () => {
    expect(await checkBriefNote(db, card(), 'Nothing special today.')).toMatch(/ref/);
  });
  it('does not ask for refs when the Context lists none', async () => {
    expect(await checkBriefNote(db, card('Due today\nnone'), 'Nothing special today.')).toBeNull();
  });
  it('does not count the brief card itself as unknown', async () => {
    expect(await checkBriefNote(db, card(), 'WEB-1 first. This is WEB-9.')).toBeNull();
  });
});
