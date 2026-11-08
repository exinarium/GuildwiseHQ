import { describe, expect, it } from 'vitest';
import { scrubChangelogEntry } from '../src/release/changelog-entries.ts';

const publicText = (s: string) => s.replace(/(^|[\s(])@[A-Za-z0-9][A-Za-z0-9_-]*/g, '$1').trim();
const scrub = (text: string, opts: { denyList?: string[]; agentHandles?: string[] }) =>
  scrubChangelogEntry({ heading: 'Added', text }, { publicText, ...opts }).map((f) => f.code);
const mark = { agentHandles: ['Mark'] };

describe('agent handles that are ordinary words', () => {
  it.each([
    'Mark items as done from the board.',
    'You can mark items as done from the board.',
    'Saved views. Mark items as done from the board.',
  ])('passes "%s"', (t) => expect(scrub(t, mark)).toEqual([]));

  it.each([
    'Mark (BA) added a filter to the board view.',
    'The agent Mark now retries the export.',
    'Fixed a crash that Mark reported in the export.',
  ])('rejects "%s"', (t) => expect(scrub(t, mark)).toContain('deny_list'));

  it('rejects @Mark', () => expect(scrub('@Mark added a board filter today.', mark)).toEqual(['not_public', 'deny_list']));

  it('still rejects a handle that is not an ordinary word, anywhere', () => {
    expect(scrub('Katherine made the release flow faster.', { agentHandles: ['Katherine'] })).toContain('deny_list');
  });

  it('keeps the strict match for a member with the same name', () => {
    expect(scrub('Mark items as done from the board.', { denyList: ['Mark'] })).toContain('deny_list');
  });

  it('leaves other terms unchanged', () => {
    expect(scrub('Fixed GWP-74 in the board view today.', mark)).toContain('ticket_key');
    expect(scrub('Runs on build-box.internal now ok.', mark)).toContain('host_name');
  });
});
