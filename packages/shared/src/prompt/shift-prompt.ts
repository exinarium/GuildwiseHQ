import { feedMaxItems } from '../cards/fields.ts';
import type { ShiftBrief } from '../protocol/runner.ts';
import { commandForOutcome } from './commands.ts';
import { renderUntrusted } from './untrusted.ts';

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

const section = (title: string, body: string): string | null =>
  body.trim() ? `## ${title}\n${body.trim()}` : null;

type Handoff = ShiftBrief['handoffs'][number];

/** Handoffs kept in full in the prompt; older ones collapse to one line each. */
export const HANDOFFS_FULL = 4;
/** Character budget for the whole "Previous handoffs" section. */
export const HANDOFFS_BUDGET = 12_000;
const ONE_LINER_NOTE = 160;
const TRUNCATED = '[… truncated, full note on the card page]';

const handoffHead = (h: Handoff): string => `${h.stage} / ${h.agentName} / ${h.outcome} (${h.at})`;

function handoffOneLine(h: Handoff): string {
  const first = (h.note.trim().split('\n')[0] ?? '').trim();
  const cut = first.length > ONE_LINER_NOTE ? `${first.slice(0, ONE_LINER_NOTE - 1)}…` : first;
  return `- ${handoffHead(h)}: ${cut}`;
}

/**
 * Previous handoffs for a shift prompt: the latest few in full, older ones as one line each, the whole section within a
 * character budget (oldest full notes shortened first; the latest is only truncated, never dropped).
 */
/** The reviewer's risk call for the stages that test the card: what to look at first (backlog #70). */
function renderReviewRisk(brief: ShiftBrief): string {
  const r = brief.reviewRisk;
  if (!r) return '';
  const lines = [`Overall risk: ${r.level.toUpperCase()}.`];
  if (r.qaFocus.trim()) lines.push(`QA focus (what the reviewer wants tested by hand):\n${r.qaFocus.trim()}`);
  if (r.analysis.trim())
    lines.push(
      `Risk analysis (blast radius, failure scenarios, what was and was not verified):\n${r.analysis.trim()}`,
    );
  lines.push(
    brief.shift.stage === 'qa_steps'
      ? 'Write explicit steps for the QA focus and for each failure scenario above, in addition to the usual scenarios.'
      : 'Test the QA focus and each failure scenario above first, then the rest of the test plan.',
  );
  return lines.join('\n\n');
}

export function renderHandoffs(handoffs: Handoff[], opts: { full?: number; budget?: number } = {}): string {
  if (handoffs.length === 0) return '';
  const full = Math.max(1, opts.full ?? HANDOFFS_FULL);
  const budget = opts.budget ?? HANDOFFS_BUDGET;
  const fullFrom = { v: Math.max(0, handoffs.length - full) };
  const fullBlock = (h: Handoff, max?: number): string => {
    const note = h.note.trim();
    const body =
      max !== undefined && note.length > max ? `${note.slice(0, Math.max(0, max))}\n${TRUNCATED}` : note;
    return `### ${handoffHead(h)}\n${body}`;
  };
  const build = (latestMax?: number): string => {
    const lines: string[] = [];
    const shortened = fullFrom.v;
    if (shortened > 0)
      lines.push(
        `${shortened} earlier handoff${shortened === 1 ? '' : 's'} shortened to one line each; the full history is on the card page.`,
        ...handoffs.slice(0, fullFrom.v).map(handoffOneLine),
      );
    const fulls = handoffs.slice(fullFrom.v);
    const blocks = fulls.map((h, i) => fullBlock(h, i === fulls.length - 1 ? latestMax : undefined));
    return [...(lines.length ? [lines[0] ?? '', lines.slice(1).join('\n')] : []), ...blocks]
      .filter((x) => x)
      .join('\n\n');
  };
  let out = build();
  while (out.length > budget && fullFrom.v < handoffs.length - 1) {
    fullFrom.v += 1;
    out = build();
  }
  if (out.length > budget) {
    const over = out.length - budget;
    const latest = handoffs[handoffs.length - 1] as Handoff;
    out = build(Math.max(500, latest.note.trim().length - over - TRUNCATED.length - 1));
  }
  return out;
}

/** Feed cards (M5): topic, description, window, preferred sites, maximum number of items, seen-list, candidates and taste rules. */
function feedContext(brief: ShiftBrief): string {
  const f = brief.card.fields;
  const lines: string[] = [];
  if (text(f.topic)) lines.push(`- Topic (short label): ${text(f.topic)}`);
  if (text(f.description))
    lines.push(
      `- Description (what the manager actually wants; this is the primary statement of intent, follow it over the topic label):\n\n${text(f.description)}\n`,
    );
  if (text(f.subCategory)) lines.push(`- Sub-category: ${text(f.subCategory)}`);
  lines.push(`- Window: the last ${typeof f.windowHours === 'number' ? f.windowHours : 24} hours`);
  const sites = list(f.preferredSites);
  lines.push(
    `- Preferred sites (search these first): ${sites.length ? sites.join(', ') : 'none, choose where to look'}`,
  );
  lines.push(
    `- Maximum items: ${feedMaxItems(f)} in the digest overall, whatever their kind (article, video, podcast)`,
  );
  const kinds = list(f.kinds);
  if (kinds.length > 0 && kinds.length < 3)
    lines.push(`- Only these kinds of item are wanted: ${kinds.join(', ')} (others are dropped)`);
  const feed = brief.feed;
  if (feed) {
    lines.push(`- Seen-list: ${feed.seenUrls.length} URL(s) already logged for this project; skip them`);
    if (feed.seenUrls.length > 0)
      lines.push(`\n### Seen URLs\n${feed.seenUrls.map((u) => `- ${u}`).join('\n')}`);
    if (feed.candidates.length > 0)
      lines.push(
        `\n### Candidates from the scout\n${feed.candidates
          .map(
            (c) =>
              `- (${c.kind}) ${c.title} | ${c.source} | ${c.publishedAt} | ${c.url}\n  ${c.summary.replace(/\s+/g, ' ')}${
                c.transcript?.status === 'ok' && c.transcript.path
                  ? `\n  Transcript (${c.transcript.chars ?? '?'} chars${c.transcript.autoGenerated ? ', auto-generated captions' : ''}): read the file ${c.transcript.path} in the vault and write the summary from it`
                  : c.transcript
                    ? '\n  Transcript: none available'
                    : ''
              }`,
          )
          .join('\n')}`,
      );
    if (feed.tasteSeed?.length)
      lines.push(
        `\n### Explicit taste rules (set by the manager; follow these first)\n${feed.tasteSeed.map((r) => `- ${r}`).join('\n')}`,
      );
    lines.push(`\n### Taste (taste.md)\n${feed.taste?.trim() ? feed.taste.trim() : 'No taste rules yet.'}`);
  }
  return lines.join('\n');
}

const indent = (text: string, pad: string): string =>
  text
    .split('\n')
    .map((l) => pad + l)
    .join('\n');

/** Investigate & design: where the architect writes, what was recorded, the investigation-only note for the BA. */
function investigationContext(brief: ShiftBrief): string {
  const inv = brief.investigation;
  if (!inv) return '';
  const lines: string[] = [];
  if (brief.card.investigationOnly)
    lines.push('- This is an investigation-only card: the result is the report; nothing is built.');
  if (brief.shift.stage.startsWith('investigate') && inv.readOnly) {
    lines.push(
      '- DESIGN BEFORE THE DEPENDENCIES HAVE LANDED. This card has no branch yet: you work in a read-only checkout of the project\'s working branch (listed under "Folders you can read"), not in a worktree, and you cannot commit or edit repository files.',
      inv.location === 'vault'
        ? `- Write your report to the file \`${inv.reportPath}\` under your scratch directory (the runner copies it into the project's knowledge vault when you report).`
        : `- Write your report to the file \`${inv.reportPath}\` under your scratch directory (the same relative path), not in the repository: the runner keeps its text on the card and the builder commits it on the card branch when Build starts.`,
    );
    const un = inv.unlandedDependencies ?? [];
    if (un.length > 0) {
      lines.push(
        '- These dependencies are not in the working branch yet. Design on top of their specs and designs below, state your assumptions about what they will provide in a section "Assumptions about unlanded dependencies" of the report, and keep your design adjustable once they land:',
      );
      for (const d of un) {
        lines.push(`  - ${d.ref} ${d.title} (${d.status})`);
        if (d.spec) lines.push(`    Spec:\n${indent(d.spec, '      ')}`);
        if (d.report)
          lines.push(
            `    Design report (${d.report.location === 'vault' ? `in the project vault: ${d.report.reportPath}` : `${d.report.reportPath}`}): ${d.report.summary.replace(/\s+/g, ' ')}`,
            ...(d.report.body ? [indent(d.report.body, '      ')] : []),
          );
      }
    }
    lines.push(
      '- Record every assumption with the report: `aom design --report <path> --summary "..." --assumption "<assumption> | <dependency ref> | <what changes if it is wrong>"` (repeat the flag; or `--assumptions-file <json>`). If the design really assumes nothing about them, say so with `--no-assumptions "<why>"`. After the dependencies land you review these assumptions in a short follow-up shift.',
    );
  } else if (brief.shift.stage.startsWith('investigate') && inv.review) {
    lines.push(
      `- ASSUMPTION REVIEW. You designed this card before ${inv.review.dependencies.join(', ')} landed; they are in the working branch now. Check each assumption below against the landed code, then finish with exactly one of: \`aom design confirm --summary "<how you checked>"\` (all hold; the design stands) or \`aom design revise --report <path> --summary "..." --revised <numbers> --note "<what changed and why>"\` (update the report first; the numbers are the assumptions that did not hold, the others count as confirmed). This is a review, not a new design: change only what the landed code makes wrong.`,
      ...inv.review.assumptions.map(
        (a, i) => `  ${i + 1}. ${a.assumption} (${a.dependency}); if wrong: ${a.ifWrong}`,
      ),
      inv.location === 'vault'
        ? `- The design report is in the project vault: \`${inv.report?.reportPath ?? inv.reportPath}\`. To revise it, write the new text to \`${inv.reportPath}\` under your scratch directory.`
        : inv.report?.body
          ? `- The design report is carried on the card (text below). To revise it, write the revised report to \`${inv.reportPath}\` in your worktree and commit it on the card branch.\n\n${inv.report.body}`
          : `- The design report is \`${inv.report?.reportPath ?? inv.reportPath}\` on the card branch; to revise it, edit and commit it.`,
    );
  } else if (brief.shift.stage.startsWith('investigate')) {
    lines.push(
      inv.location === 'vault'
        ? `- Write your report to the file \`${inv.reportPath}\` under your scratch directory (the runner copies it into the project's knowledge vault when you report). It is not committed to the repository.`
        : `- Write your report to \`${inv.reportPath}\` in your worktree and commit it on the card branch.`,
    );
    if (inv.note) lines.push(`- ${inv.note}`);
    if (inv.mergeMainFirst && !inv.readOnly)
      lines.push('- The latest main branch is merged first (see the note on a waiting merge below, if any).');
  }
  if (inv.report?.body && !brief.shift.stage.startsWith('investigate')) {
    lines.push(
      `- The design report was written before this card had a branch. Create \`${inv.report.reportPath}\` on your branch with exactly the text below, and commit it first, as its own commit:`,
      '```markdown',
      inv.report.body,
      '```',
    );
  }
  if (inv.report) {
    lines.push(
      `- Recorded report: \`${inv.report.reportPath}\` (${inv.report.location === 'vault' ? 'in the project vault' : inv.report.body ? 'carried on the card until you commit it' : `on the card branch${inv.report.commit ? `, commit ${inv.report.commit.slice(0, 10)}` : ''}`})`,
      `- Summary of the report: ${inv.report.summary.replace(/\s+/g, ' ')}`,
    );
    if (inv.report.location === 'repo' && !inv.report.body && !brief.shift.stage.startsWith('investigate'))
      lines.push('- Read the report before you start; it is on your branch.');
  }
  return lines.join('\n');
}

/**
 * Renders the card as a markdown prompt (`-p`): ref, title, type, risk tier, rework round; the card fields;
 * dependencies; all prior handoffs; latest review comments; last thread messages; then the job for this shift
 * (docs/ARCHITECTURE.md section 13.2). Pure and deterministic.
 */
export function renderShiftPrompt(brief: ShiftBrief): string {
  const { card, shift } = brief;
  const f = card.fields;
  const parts: Array<string | null> = [];
  const mail = card.untrusted;
  const outside = new Set(mail?.fields ?? []);
  const from = mail?.from ? ` from ${mail.from}` : '';
  const what = mail?.kind === 'webhook' ? 'Webhook' : 'E-mail';
  /** A text field that came from an outside e-mail goes inside the untrusted block. */
  const guarded = (key: string, title: string, body: string): string | null =>
    outside.has(key)
      ? section(title, renderUntrusted(`${what}${from}: ${title.toLowerCase()}`, body))
      : section(title, body);

  if (mail?.title !== false && mail)
    parts.push(`# ${card.ref}\n${renderUntrusted(`${what} subject${from}`, card.title)}`);
  else parts.push(`# ${card.ref}: ${card.title}`);
  parts.push(
    [
      `- Type: ${card.cardType}`,
      `- Risk tier: ${card.riskTier ?? 'not yet assessed'}`,
      `- Rework round: ${card.reworkRound}`,
      ...(card.parent ? [`- Parent card: ${card.parent.ref} ${card.parent.title}`] : []),
    ].join('\n'),
  );

  if (card.cardType === 'feed') parts.push(section('Feed context', feedContext(brief)));
  parts.push(guarded('context', 'Context', text(f.context)));
  parts.push(guarded('requirements', 'Requirements', text(f.requirements)));
  const criteria = list(f.acceptanceCriteria);
  parts.push(
    guarded('acceptanceCriteria', 'Acceptance criteria', criteria.map((c) => `- [ ] ${c}`).join('\n')),
  );
  parts.push(guarded('affectedAreas', 'Affected areas', text(f.affectedAreas)));
  if (outside.has('constraints') && text(f.constraints))
    parts.push(guarded('constraints', 'Constraints from the sender', text(f.constraints)));
  // Constraints are the card's own field; the organization's and the project's standing orders are binding rules in your
  // instructions. The card's own decisions (answers to its questions) are listed separately, newest few only.
  const constraintLines: string[] = [];
  if (text(f.constraints) && !outside.has('constraints')) constraintLines.push(text(f.constraints));
  parts.push(section('Constraints', constraintLines.join('\n')));
  if (brief.ledger.length > 0) {
    const more = (brief.ledgerTotal ?? brief.ledger.length) - brief.ledger.length;
    parts.push(
      section(
        'Decisions on this card',
        [
          ...brief.ledger.map((l) => `- (${l.scope}) ${l.title}: ${l.body.trim()}`),
          ...(more > 0
            ? [
                `- ${more} older ${more === 1 ? 'entry' : 'entries'} not shown: \`aom ledger search "<query>"\` finds them.`,
              ]
            : []),
        ].join('\n'),
      ),
    );
  }
  if (brief.testWithoutEnvironment && !brief.environment)
    parts.push(
      section(
        'Test environment',
        'No test environment is ready and this project allows testing without one. Run what you can (unit tests, static checks, reading the code against the criteria) and say in your handoff note that no environment was used. Do not wait for one and do not ask DevOps.',
      ),
    );
  parts.push(guarded('testPlan', 'Test plan', text(f.testPlan)));
  // Any other field that holds mail text (a custom workflow's field) is listed in its own block.
  const known = new Set([
    'context',
    'requirements',
    'acceptanceCriteria',
    'affectedAreas',
    'constraints',
    'testPlan',
  ]);
  for (const key of outside) {
    if (known.has(key)) continue;
    const v = f[key];
    const body = typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v);
    parts.push(section(`Field: ${key}`, renderUntrusted(`${what}${from}: ${key}`, body)));
  }
  parts.push(section('Completion action', card.completionAction ?? ''));
  parts.push(
    section(
      'Dependencies',
      card.dependencies
        .map(
          (d) =>
            `- ${d.ref} ${d.title} (${d.status}${d.landed === undefined ? '' : d.landed ? '; landed in the working branch' : '; not landed yet'})`,
        )
        .join('\n'),
    ),
  );
  if (brief.investigation) parts.push(section('Investigation', investigationContext(brief)));
  parts.push(section('Previous handoffs', renderHandoffs(brief.handoffs)));
  if (brief.reviewRisk) parts.push(section("Reviewer's risk analysis", renderReviewRisk(brief)));
  if (card.reworkRound > 0) {
    parts.push(
      section(
        'Review comments to address',
        brief.reviewComments
          .map((r) => {
            const lines = [`### ${r.reviewerName} (${r.at})`];
            if (r.reasons.length) lines.push(`Reasons: ${r.reasons.join(', ')}`);
            if (r.criteriaMissed.length)
              lines.push(`Criteria missed:\n${r.criteriaMissed.map((c) => `- ${c}`).join('\n')}`);
            if (r.comments.trim()) lines.push(r.comments.trim());
            return lines.join('\n');
          })
          .join('\n\n'),
      ),
    );
  }
  parts.push(
    section(
      'Recent thread',
      brief.thread
        .map((m) =>
          m.untrusted
            ? `- ${m.authorName} (${m.kind}, ${m.at}):\n${renderUntrusted(`E-mail reply from ${m.authorName}`, m.body)}`
            : `- ${m.authorName} (${m.kind}, ${m.at}): ${m.body.trim()}`,
        )
        .join('\n'),
    ),
  );

  parts.push(
    [
      '## Your job in this shift',
      `Stage: ${shift.stageLabel}`,
      '',
      `Done criteria: ${shift.doneCriteria}`,
      '',
      'Allowed outcomes (run exactly one when you are done):',
      ...shift.outcomes.map((o) => `- ${o.id} (${o.kind}): ${o.label}\n  \`${commandForOutcome(o)}\``),
    ].join('\n'),
  );

  return `${parts.filter((p): p is string => p !== null).join('\n\n')}\n`;
}
