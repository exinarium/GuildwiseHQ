import { describe, expect, it } from 'vitest';
import { BaTaskKind, baTaskBriefOutcomes } from '../src/phases/index.ts';
import { commandForOutcome } from '../src/prompt/commands.ts';
import {
  checkChangelogProposal,
  RELEASE_CHANGELOG_OUTCOME,
  type ReleaseChangelogTask,
  renderReleaseChangelogInstructions,
  renderReleaseChangelogPrompt,
} from '../src/release/changelog-task.ts';

// The server's publicText strips /help/ links, #refs and @handles; this stand-in does the same for the gate.
const publicText = (s: string) =>
  s
    .replace(/\(\/help\/[^)]*\)/g, '')
    .replace(/\s*\(?#\d+\)?/g, '')
    .replace(/@\w+/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();

const A = 'a1'.repeat(20);
const B = 'b2'.repeat(20);
const C = 'c3'.repeat(20);
const ctx = { uncovered: [A, B, C], existingCount: 2, publicText };
const good = {
  heading: 'added',
  text: 'Release prep on the Releases page. An owner can turn on a prep run that writes the changelog first.',
  sources: [A],
};

describe('checkChangelogProposal', () => {
  it('accepts a proposal that accounts for every change and normalises the heading', () => {
    const r = checkChangelogProposal(
      {
        entries: [good],
        covered: [{ source: B, existing: 2 }],
        skipped: [{ source: C, reason: 'internal' }],
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries).toEqual([{ heading: 'Added', text: good.text, sources: [A] }]);
    expect(r.proposal.covered).toEqual([{ source: B, existing: 2 }]);
  });

  it('refuses entries that would not pass publicText or leak internals, one line per finding', () => {
    const r = checkChangelogProposal(
      {
        entries: [
          { ...good, text: `${good.text} See #12.` },
          {
            heading: 'Fixed',
            text: 'The import no longer fails for GWP-74 on a slow disk at all.',
            sources: [B],
          },
          { heading: 'Highlights', text: 'A heading the release page does not read at all.', sources: [C] },
        ],
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toContain('entry 1:');
    expect(r.errors.join('\n')).toContain("entry 2: contains a ticket key 'GWP-74'");
    expect(r.errors.join('\n')).toContain('entry 3: has an unknown heading');
  });

  it('never repeats a deny-list term in the refusal', () => {
    const r = checkChangelogProposal(
      {
        entries: [
          { ...good, text: 'Faster exports. Katherine made the export of large boards much faster now.' },
        ],
        skipped: [
          { source: B, reason: 'internal' },
          { source: C, reason: 'internal' },
        ],
      },
      { ...ctx, denyList: ['Katherine'] },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toContain('names an internal person, agent or machine');
    expect(r.errors.join('\n')).not.toContain('Katherine');
  });

  it('refuses missing, unknown and conflicting changes, and a covered number that does not exist', () => {
    const r = checkChangelogProposal(
      {
        entries: [{ ...good, sources: [A, 'zzz'] }],
        covered: [{ source: A, existing: 5 }],
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const all = r.errors.join('\n');
    expect(all).toContain('unknown changes');
    expect(all).toContain('zzz');
    expect(all).toContain('more than once');
    expect(all).toContain('there is no existing entry 5');
    expect(all).toContain('not accounted for');
    expect(all).toContain(B);
  });

  it('allows several entries to share a change', () => {
    const r = checkChangelogProposal(
      {
        entries: [
          good,
          {
            heading: 'Fixed',
            text: 'Prep runs no longer stop when a step has nothing to do.',
            sources: [A, B, C],
          },
        ],
      },
      ctx,
    );
    expect(r.ok).toBe(true);
  });

  it('refuses a report that is not the expected shape', () => {
    const r = checkChangelogProposal({ entries: 'nope' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain('expected shape');
  });
});

describe('release_changelog task kind', () => {
  it('is a BA task kind with a done and a fail outcome and their aom commands', () => {
    expect(BaTaskKind.parse('release_changelog')).toBe('release_changelog');
    const outcomes = baTaskBriefOutcomes('release_changelog');
    expect(outcomes.map((o) => o.id)).toEqual([
      RELEASE_CHANGELOG_OUTCOME.done,
      RELEASE_CHANGELOG_OUTCOME.fail,
    ]);
    expect(commandForOutcome(outcomes[0] as never)).toContain('aom report release-changelog --file');
    expect(commandForOutcome(outcomes[1] as never)).toContain('aom report release-changelog-fail --note');
  });

  const task: ReleaseChangelogTask = {
    runId: '00000000-0000-4000-8000-000000000001',
    repoId: '00000000-0000-4000-8000-000000000002',
    projectName: 'Toy',
    repoName: 'toy-repo',
    releaseBranch: 'release/1.5.0',
    changes: [
      { source: A, subject: 'Add the export button', cards: [{ key: 'TOY-1', title: 'Export' }], areas: [] },
    ],
    existing: [{ heading: 'Added', text: 'Retire a workstation.' }],
  };

  it('the prompt numbers the existing entries and lists each change with its id', () => {
    const p = renderReleaseChangelogPrompt(task);
    expect(p).toContain(`id ${A}: Add the export button`);
    expect(p).toContain('1. [Added] Retire a workstation.');
  });

  it('the instructions name the headings, the playbook step and the report command', () => {
    const outcomes = baTaskBriefOutcomes('release_changelog');
    const text = renderReleaseChangelogInstructions(
      { agent: { name: 'Ada' }, role: { instructions: 'Be a BA.', coreRules: [] } },
      task,
      outcomes,
      (o) => commandForOutcome(o as never),
    );
    expect(text).toContain('Added, Changed, Deprecated, Removed, Fixed, Security');
    expect(text).toContain('step-05-changelog-unattended.md');
    expect(text).toContain('aom report release-changelog --file');
  });
});
