import { describe, expect, it } from 'vitest';
import {
  applyHelpEdits,
  checkHelpUpdate,
  enabledReleaseDocsPrepSteps,
  type HelpEdit,
  HelpEditSchema,
  HelpEditsTaskSchema,
  HelpProposalSchema,
  helpOutputSources,
  locateHelpSections,
  missingReleaseDocsPrepRequirement,
  PREP_PROPOSAL_FILE,
  PREP_TASK_KINDS,
  parseHelpArticle,
  ReleaseDocsPrepHelpInputSchema,
  releaseDocsPrepStep,
  releaseDocsPrepSteps,
  renderReleasePrepInstructions,
  renderReleasePrepPrompt,
  writableFilesFor,
} from '../src/index.ts';

const PHASES = `---
title: Phases and follow-ups
summary: Creating phases and releases.
keywords: [phase, release]
order: 12
---

A **phase** is a slice of work.

## Setting up {#setting-up}

Open the **Environments** page.

## Releases {#releases}

The **Releases** page lists the releases. Open it at \`/releases\`.

### Release prep {#release-prep}

Release prep runs the steps before a release ships.

## Notes

Plain heading without an anchor.

\`\`\`
## not a heading
\`\`\`
`;

const BOARD = `---
title: Board and cards
summary: The board.
keywords: [board]
order: 3
---

## Columns {#columns}

The board has columns.
`;

const files = () => ({ phases: PHASES, board: BOARD });
const edit = (e: Record<string, unknown>): HelpEdit => HelpEditSchema.parse(e);

describe('parseHelpArticle', () => {
  it('finds the headings with the app ids, skips fenced code and reads the header', () => {
    const d = parseHelpArticle(PHASES);
    expect(d.headings.map((h) => h.id)).toEqual(['setting-up', 'releases', 'release-prep', 'notes']);
    expect(d.meta).toMatchObject({ title: 'Phases and follow-ups', order: '12' });
    expect(d.frontmatter).toEqual({ start: 0, end: 5 });
  });

  it('gives a repeated heading -2, -3 like the app', () => {
    const d = parseHelpArticle('---\ntitle: x\norder: 1\n---\n## Tips\n\n## Tips\n\n## Tips {#tips}\n');
    expect(d.headings.map((h) => h.id)).toEqual(['tips', 'tips-2', 'tips-3']);
  });
});

describe('applyHelpEdits', () => {
  it('replace_text, append and add_section change only the named sections', () => {
    const r = applyHelpEdits(files(), [
      edit({
        op: 'replace_text',
        article: 'phases',
        section: 'releases',
        find: 'lists the releases',
        replace: 'lists every release with its state',
        sources: ['card:GWP-1'],
      }),
      edit({ op: 'append', article: 'phases', section: 'setting-up', text: 'Then save.' }),
      edit({
        op: 'add_section',
        article: 'phases',
        after: 'release-prep',
        title: 'Help articles',
        id: 'help-articles',
        body: 'Release prep also updates the Help articles.',
      }),
    ]);
    expect(r.kind).toBe('changed');
    if (r.kind !== 'changed') return;
    expect(Object.keys(r.files)).toEqual(['phases']);
    const out = r.files.phases as string;
    expect(out).toContain('lists every release with its state');
    expect(out).toContain('Open the **Environments** page.\n\nThen save.\n\n## Releases {#releases}');
    expect(out).toContain(
      '### Help articles {#help-articles}\n\nRelease prep also updates the Help articles.\n\n## Notes',
    );
    expect(r.changed).toEqual([
      { article: 'phases', section: 'releases' },
      { article: 'phases', section: 'setting-up' },
    ]);
    expect(r.added).toEqual([{ article: 'phases', section: 'help-articles', after: 'release-prep' }]);
    // the header and every other line outside the edited sections are untouched
    expect(out.split('\n').slice(0, 7)).toEqual(PHASES.split('\n').slice(0, 7));
    expect(out.endsWith('```\n')).toBe(true);
    expect(checkHelpUpdate(files(), { ...files(), ...r.files }, { changedRanges: r.written }).errors).toEqual(
      [],
    );
    // a second run of the same edits changes nothing
    const again = applyHelpEdits({ ...files(), ...r.files }, [
      edit({
        op: 'replace_text',
        article: 'phases',
        section: 'releases',
        find: 'lists the releases',
        replace: 'lists every release with its state',
      }),
      edit({ op: 'append', article: 'phases', section: 'setting-up', text: 'Then save.' }),
      edit({
        op: 'add_section',
        article: 'phases',
        after: 'release-prep',
        title: 'Help articles',
        id: 'help-articles',
        body: 'x',
      }),
    ]);
    expect(again.kind).toBe('unchanged');
    if (again.kind === 'unchanged') expect(again.duplicates).toHaveLength(3);
  });

  it('a new chapter goes after the last ### child, and a section at the end of the file keeps one final newline', () => {
    const r = applyHelpEdits(files(), [
      edit({
        op: 'add_section',
        article: 'phases',
        after: 'releases',
        level: 2,
        title: 'Shipping',
        id: 'shipping',
        body: 'Ship it.',
      }),
      edit({ op: 'add_section', article: 'board', after: 'columns', title: 'Lanes', id: 'lanes', body: 'Lanes.' }),
    ]);
    expect(r.kind).toBe('changed');
    if (r.kind !== 'changed') return;
    expect(r.files.phases).toContain('before a release ships.\n\n## Shipping {#shipping}\n\nShip it.\n\n## Notes');
    expect(r.files.board).toBe(`${BOARD}\n## Lanes {#lanes}\n\nLanes.\n`);
  });

  it('keeps \\r\\n line endings', () => {
    const crlf = BOARD.replace(/\n/g, '\r\n');
    const r = applyHelpEdits({ board: crlf }, [
      edit({ op: 'append', article: 'board', section: 'columns', text: 'More.' }),
    ]);
    expect(r.kind).toBe('changed');
    if (r.kind === 'changed') {
      expect(r.files.board).toContain('The board has columns.\r\n\r\nMore.\r\n');
      expect(r.files.board?.replace(/\r\n/g, '')).not.toContain('\n');
    }
  });

  it('refuses text with a heading, an anchor, a header line or a fence, and refuses the whole update', () => {
    for (const text of ['## New', 'see {#x}', '---', '```', '<!-- c -->']) {
      const r = applyHelpEdits(files(), [
        edit({ op: 'append', article: 'board', section: 'columns', text: 'fine' }),
        edit({ op: 'append', article: 'phases', section: 'releases', text }),
      ]);
      expect(r.kind, text).toBe('error');
    }
  });

  it('refuses an unknown article or section, a used id, a bad title and an ambiguous find', () => {
    const errs = (e: Record<string, unknown>) => {
      const r = applyHelpEdits(files(), [edit(e)]);
      return r.kind === 'error' ? r.errors.join('\n') : '';
    };
    expect(errs({ op: 'append', article: 'nope', section: 'x', text: 'a' })).toContain('unknown article "nope"');
    expect(errs({ op: 'append', article: 'board', section: 'x', text: 'a' })).toContain('unknown section "board#x"');
    expect(
      errs({ op: 'add_section', article: 'phases', after: 'releases', title: 'X', id: 'notes', body: 'a' }),
    ).toContain('the id "notes" is already used in phases');
    expect(
      errs({ op: 'add_section', article: 'phases', after: 'releases', title: 'X {#y}', id: 'y', body: 'a' }),
    ).toContain('the title must be one line of text');
    expect(
      errs({ op: 'replace_text', article: 'phases', section: 'releases', find: 'releases', replace: 'a' }),
    ).toMatch(/occurs \d+ times/);
  });
});

describe('checkHelpUpdate', () => {
  it('refuses a removed or renamed anchor', () => {
    const after = PHASES.replace('## Releases {#releases}', '## Releases {#release-list}');
    expect(checkHelpUpdate(files(), { ...files(), phases: after }).errors).toContain(
      'the anchor phases#releases would be removed or renamed',
    );
    const gone = PHASES.replace('## Notes\n', '');
    expect(checkHelpUpdate(files(), { ...files(), phases: gone }).errors).toContain(
      'the anchor phases#notes would be removed or renamed',
    );
  });

  it('refuses a new heading that shifts a derived id to -2', () => {
    const after = PHASES.replace('## Setting up {#setting-up}', '## Notes {#notes}\n\nx\n\n## Setting up {#setting-up}');
    expect(checkHelpUpdate(files(), { ...files(), phases: after }).errors).toContain(
      'the anchor phases#notes would be removed or renamed',
    );
  });

  it('refuses a duplicated explicit anchor and a new section without an anchor', () => {
    const dup = `${PHASES}\n## Again {#releases}\n`;
    const e = checkHelpUpdate(files(), { ...files(), phases: dup }).errors;
    expect(e).toContain('two headings in phases share the anchor #releases');
    const bare = `${BOARD}\n## Lanes\n`;
    expect(checkHelpUpdate(files(), { ...files(), board: bare }).errors).toContain(
      'the new section "Lanes" in board has no anchor',
    );
  });

  it('refuses a changed or broken header', () => {
    const changed = PHASES.replace('order: 12', 'order: 13');
    expect(checkHelpUpdate(files(), { ...files(), phases: changed }).errors).toContain(
      'the header of phases was changed',
    );
    const broken = PHASES.replace('title: Phases and follow-ups\n', '');
    expect(checkHelpUpdate(files(), { ...files(), phases: broken }).errors).toContain(
      'the header of phases is no longer valid',
    );
  });

  it('refuses a removed or a new article', () => {
    expect(checkHelpUpdate(files(), { phases: PHASES }).errors).toContain('the article board would be removed');
    expect(checkHelpUpdate(files(), { ...files(), x: BOARD }).errors).toContain(
      'the update would create the article x',
    );
  });

  it('checks links and scrubs only the written lines; a problem already there is a warning', () => {
    const after = PHASES.replace('Open the **Environments** page.', 'See [x](/help/board#nope) for GWP-12.');
    const line = after.split('\n').indexOf('See [x](/help/board#nope) for GWP-12.');
    const e = checkHelpUpdate(files(), { ...files(), phases: after }, { changedRanges: { phases: [[line, line + 1]] } })
      .errors;
    expect(e).toContain('the Help link /help/board#nope goes nowhere');
    expect(e.some((x) => x.includes('ticket key'))).toBe(true);
    const dupBefore = `${BOARD}\n## A {#columns}\n`;
    const r = checkHelpUpdate({ board: dupBefore }, { board: `${dupBefore}\nMore.\n` });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toContain('two headings in board share the anchor #columns');
  });

  it('with no before, checks the articles on their own', () => {
    expect(checkHelpUpdate(null, files()).errors).toEqual([]);
    expect(checkHelpUpdate(null, { x: '## No header\n' }).errors).toContain('the header of x is no longer valid');
  });
});

describe('schemas, hints and the step registry', () => {
  it('an article is a slug, never a path', () => {
    expect(HelpEditSchema.safeParse({ op: 'append', article: '../x', section: 'a', text: 'b' }).success).toBe(false);
    expect(
      HelpEditSchema.safeParse({ op: 'append', article: 'apps/web/x', section: 'a', text: 'b' }).success,
    ).toBe(false);
    expect(HelpProposalSchema.parse({})).toEqual({ edits: [], covered: [], skipped: [], notes: [] });
    expect(ReleaseDocsPrepHelpInputSchema.parse({}).helpDir).toBe('apps/web/src/help/articles');
  });

  it('locateHelpSections ranks the section whose title matches first', () => {
    const docs = { phases: parseHelpArticle(PHASES), board: parseHelpArticle(BOARD) };
    const hints = locateHelpSections(docs, {
      title: 'Release prep runs in steps',
      files: ['apps/web/src/pages/Releases.tsx'],
      routes: ['/releases'],
    });
    expect(hints[0]).toMatchObject({ article: 'phases' });
    expect(['releases', 'release-prep']).toContain(hints[0]?.section);
    expect(hints.some((h) => h.article === 'board')).toBe(false);
  });

  it('helpOutputSources returns every source', () => {
    expect(
      helpOutputSources({
        status: 'passed',
        changed: [{ article: 'a', title: 'A', section: 's', heading: 'S', sources: ['card:A-1'] }],
        added: [{ article: 'a', title: 'A', section: 't', heading: 'T', after: 's', sources: ['merge:abc'] }],
        covered: [{ source: 'card:B-2', article: 'a', section: 's' }],
        skippedChanges: [{ source: 'commit:def', reason: 'tests' }],
      }),
    ).toEqual(['card:A-1', 'merge:abc', 'card:B-2', 'commit:def']);
    expect(helpOutputSources({ nope: 1 })).toEqual([]);
  });

  it('help sits between guide and videos, follows the per-project switch and needs analyse', () => {
    const ids = releaseDocsPrepSteps().map((s) => s.id);
    expect(ids.indexOf('help')).toBe(ids.indexOf('guide') + 1);
    expect(ids.indexOf('videos')).toBe(ids.indexOf('help') + 1);
    expect(enabledReleaseDocsPrepSteps({ steps: {} }).some((s) => s.id === 'help')).toBe(true);
    expect(enabledReleaseDocsPrepSteps({ steps: { help: false } }).some((s) => s.id === 'help')).toBe(false);
    const help = releaseDocsPrepStep('help');
    expect(help?.label).toBe('Update Help articles');
    expect(missingReleaseDocsPrepRequirement([help!])?.message).toBe(
      'Update Help articles needs Analyse changes. Turn it on in the project settings.',
    );
  });

  it('help_edits is a proposal task with its playbook', () => {
    const task = HelpEditsTaskSchema.parse({
      kind: 'help_edits',
      helpDir: 'apps/web/src/help/articles',
      changes: [{ sources: ['card:A-1'], title: 'Releases page', hints: [{ article: 'phases', section: 'releases', score: 3, why: 'heading' }] }],
    });
    expect(writableFilesFor(task)).toEqual([PREP_PROPOSAL_FILE]);
    expect(PREP_TASK_KINDS.help_edits.result).toBe('proposal');
    expect(PREP_TASK_KINDS.help_edits.title(task, 'release/1.6.0')).toBe('Update the Help articles (release/1.6.0)');
    const rp = {
      taskId: '0192f3a0-0000-7000-8000-000000000001',
      runId: '0192f3a0-0000-7000-8000-000000000002',
      repoId: '0192f3a0-0000-7000-8000-000000000003',
      step: 'help',
      phase: 'write',
      remoteUrlNormalized: 'github.com/a/b',
      workRef: 'refs/x',
      startSha: 'a'.repeat(40),
      task,
      writable: [PREP_PROPOSAL_FILE],
    };
    const text = renderReleasePrepInstructions({ name: 'Ada' }, { key: 'GWP', name: 'G' }, rp);
    expect(text).toContain('# The Help article writer');
    expect(text).toContain('Never change, move or remove a heading');
    expect(text).toContain('"article":"phases"');
    expect(renderReleasePrepPrompt(rp)).toContain('apps/web/src/help/articles');
  });
});
