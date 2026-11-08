import { describe, expect, it } from 'vitest';
import { finalizeNaming, internalRefEvents } from '../src/commands/finalize.ts';

describe('finalizeNaming: what a pull request or merge of the card is called', () => {
  it('a non-intake card keeps exactly today’s naming (no new keys)', () => {
    expect(finalizeNaming({ ref: 'GWP-123', title: 'Add thing', fields: {} }, null)).toEqual({
      ticket: 'GWP-123',
      prTitle: 'Add thing',
      prBody: 'Add thing',
    });
    expect(finalizeNaming({ ref: 'GWP-123', title: 'Fix GWP-123 again' })).toEqual({
      ticket: 'GWP-123',
      prTitle: 'Fix GWP-123 again',
      prBody: 'Fix GWP-123 again',
    });
  });

  it('an intake card (fields.externalRef) uses the client ticket and never the internal ref', () => {
    const n = finalizeNaming({ ref: 'GWP-123', title: 'Follow up gwp-123', fields: { externalRef: 'abc-1' } });
    expect(n).toEqual({
      ticket: 'ABC-1',
      workRef: 'ABC-1',
      isClientRef: true,
      prTitle: 'ABC-1: Follow up ABC-1',
      prBody: 'Follow up ABC-1',
    });
    expect(JSON.stringify(n)).not.toMatch(/GWP-123/i);
  });

  it('falls back to the intake external key when the fields carry no ticket', () => {
    expect(finalizeNaming({ ref: 'P4-3', title: 'T', fields: {} }, 'DCPL-4276')).toMatchObject({
      ticket: 'DCPL-4276',
      workRef: 'DCPL-4276',
      isClientRef: true,
      prTitle: 'DCPL-4276: T',
    });
  });

  it('the ticket in the fields wins over the intake key', () => {
    expect(finalizeNaming({ ref: 'P4-3', title: 'T', fields: { externalRef: 'ABC-7' } }, 'DCPL-1').workRef).toBe(
      'ABC-7',
    );
  });

  it('a GitHub ticket gets a branch-safe ticket part and keeps its reference in the title', () => {
    expect(finalizeNaming({ ref: 'P4-3', title: 'T', fields: { externalRef: 'acme/web#12' } })).toEqual({
      ticket: 'web-12',
      workRef: 'acme/web#12',
      isClientRef: true,
      prTitle: 'acme/web#12: T',
      prBody: 'T',
    });
  });

  it('a ticket equal to the card ref is treated as a non-intake card', () => {
    expect(finalizeNaming({ ref: 'GWP-5', title: 'T', fields: { externalRef: 'GWP-5' } })).toEqual({
      ticket: 'GWP-5',
      prTitle: 'T',
      prBody: 'T',
    });
  });
});

describe('internalRefEvents: finalize refused an intake card', () => {
  const card = {
    id: '019e3f6a-7b1c-7a2d-8c3e-0123456789c1',
    ref: 'GWP-123',
    stage: 'finalize',
    org_id: '019e3f6a-7b1c-7a2d-8c3e-0123456789d1',
    project_id: '019e3f6a-7b1c-7a2d-8c3e-0123456789e1',
    base_branch: 'main',
  };
  const found = {
    ref: 'GWP-123',
    workRef: 'ABC-1',
    commits: [{ sha: 'a'.repeat(40), subject: 'GWP-123: fix' }],
  };

  it('sends the card back to Build with the commits and posts how to reword them', () => {
    const [ev, msg] = internalRefEvents(card, found);
    expect(ev!.event).toEqual({
      type: 'InternalRefInHistory',
      payload: { cardId: card.id, stage: 'finalize', ref: 'GWP-123', workRef: 'ABC-1', commits: found.commits },
    });
    const body = (msg!.event.payload as { body: string }).body;
    expect(body).toContain('Nothing was merged or pushed');
    expect(body).toContain('aaaaaaaaaa GWP-123: fix');
    expect(body).toContain('must use ABC-1');
    expect(body).toContain('git reset --soft $(git merge-base HEAD origin/main)');
    expect(body).toContain('back in Build');
  });
});
