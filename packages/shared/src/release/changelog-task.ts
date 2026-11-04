import { z } from 'zod';
import { renderUntrusted } from '../prompt/untrusted.ts';
import { type ChangelogEntry, changelogHeadingOf } from './changelog-rewrite.ts';
import {
  type ChangelogProposal,
  ChangelogProposalSchema,
  describeEntryFinding,
  scrubChangelogEntry,
} from './changelog-entries.ts';

/**
 * The model half of the release prep step 'Write changelog': a `release_changelog` BA task (a background shift, no card,
 * no worktree). The BA reads one repository's analysed changes and the entries already under Unreleased and proposes
 * public changelog entries as JSON. The server checks them; the runner merges them into CHANGELOG.md. The BA never edits
 * a repository. Contract shared by the server, the runner and the prompt.
 */

export const RELEASE_CHANGELOG_OUTCOME = {
  done: 'release_changelog_done',
  fail: 'release_changelog_fail',
} as const;

/** What the BA is given for one repository. */
export const ReleaseChangelogTaskSchema = z.object({
  runId: z.uuid(),
  repoId: z.uuid(),
  projectName: z.string(),
  repoName: z.string(),
  releaseBranch: z.string(),
  /** The changes no earlier prep run wrote, each with its source id (the commit id). */
  changes: z
    .array(
      z.object({
        source: z.string(),
        subject: z.string(),
        cards: z.array(z.object({ key: z.string(), title: z.string().nullable() })).default([]),
        areas: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  /** The bullets already under ## [Unreleased], numbered from 1 in this order. */
  existing: z.array(z.object({ heading: z.string(), text: z.string() })).default([]),
});
export type ReleaseChangelogTask = z.infer<typeof ReleaseChangelogTaskSchema>;

export function releaseChangelogBriefOutcomes() {
  return [
    {
      id: RELEASE_CHANGELOG_OUTCOME.done,
      label: 'The changelog entries are proposed',
      kind: 'success' as const,
      data: 'releaseChangelog',
    },
    {
      id: RELEASE_CHANGELOG_OUTCOME.fail,
      label: 'No changelog entries can be written from these changes',
      kind: 'failure' as const,
      data: 'releaseChangelogFail',
    },
  ];
}

export type ProposalCheck =
  | { ok: true; entries: (ChangelogEntry & { sources: string[] })[]; proposal: ChangelogProposal }
  | { ok: false; errors: string[] };

/**
 * Checks a proposal for one repository: the schema, every entry through the public gate, and that every uncovered change
 * is in exactly one of entries, covered or skipped (and nothing else is). Headings are normalised to their case.
 */
export function checkChangelogProposal(
  data: unknown,
  ctx: {
    uncovered: readonly string[];
    existingCount: number;
    publicText: (s: string) => string;
    denyList?: readonly string[];
  },
): ProposalCheck {
  const parsed = ChangelogProposalSchema.safeParse(data);
  if (!parsed.success)
    return {
      ok: false,
      errors: [
        `the proposal is not valid JSON of the expected shape: ${parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
          .join('; ')}`,
      ],
    };
  const p = parsed.data;
  const errors: string[] = [];
  const entries: (ChangelogEntry & { sources: string[] })[] = [];
  p.entries.forEach((e, i) => {
    const findings = scrubChangelogEntry(e, {
      publicText: ctx.publicText,
      ...(ctx.denyList ? { denyList: ctx.denyList } : {}),
    });
    for (const f of findings) errors.push(describeEntryFinding(i, f));
    const heading = changelogHeadingOf(e.heading);
    if (heading && findings.length === 0)
      entries.push({ heading, text: e.text.replace(/\s+/g, ' ').trim(), sources: [...new Set(e.sources)] });
  });
  const wanted = new Set(ctx.uncovered);
  const seen = new Map<string, number>();
  const count = (s: string) => seen.set(s, (seen.get(s) ?? 0) + 1);
  for (const e of p.entries) for (const s of new Set(e.sources)) count(s);
  for (const c of p.covered) {
    count(c.source);
    if (c.existing > ctx.existingCount)
      errors.push(`covered '${c.source}': there is no existing entry ${c.existing}`);
  }
  for (const s of p.skipped) count(s.source);
  const unknown = [...seen.keys()].filter((s) => !wanted.has(s));
  if (unknown.length) errors.push(`unknown changes (not in the list): ${unknown.slice(0, 10).join(', ')}`);
  // Several entries may share a change; a change both written and covered or skipped (or listed twice there) is a conflict.
  const inEntries = new Set(p.entries.flatMap((e) => e.sources));
  const listed = [...p.covered.map((c) => c.source), ...p.skipped.map((s) => s.source)];
  const conflict = [...new Set(listed)].filter(
    (s) => wanted.has(s) && listed.filter((x) => x === s).length + (inEntries.has(s) ? 1 : 0) > 1,
  );
  if (conflict.length)
    errors.push(`changes listed more than once (entries, covered or skipped): ${conflict.slice(0, 10).join(', ')}`);
  const missing = ctx.uncovered.filter((s) => !seen.has(s));
  if (missing.length)
    errors.push(
      `changes not accounted for (put each in an entry's sources, in covered or in skipped): ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` and ${missing.length - 10} more` : ''}`,
    );
  return errors.length ? { ok: false, errors } : { ok: true, entries, proposal: p };
}

export function renderReleaseChangelogInstructions<O extends { id: string; label: string }>(
  brief: { agent: { name: string }; role: { instructions: string; coreRules: string[] } },
  task: ReleaseChangelogTask,
  outcomes: readonly O[],
  commandFor: (o: O) => string,
): string {
  const out: string[] = [];
  out.push('# Who you are');
  out.push(
    `You are ${brief.agent.name}, the business analyst (BA), working in the background for the release of ${task.projectName}. Names are handles, not personas: do not roleplay.`,
  );
  out.push('# Role instructions');
  out.push(brief.role.instructions.trim());
  if (brief.role.coreRules.length > 0) {
    out.push('# Core rules');
    out.push(brief.role.coreRules.map((r) => `- ${r}`).join('\n'));
  }
  out.push('# Your job in this shift');
  out.push(
    [
      `Write the public changelog entries for the repository ${task.repoName} from the changes in the prompt. Follow the "Unattended changelog" step of the Release notes playbook (aom skill show playbook:release-notes --file steps/step-changelog-unattended.md). Nobody answers questions in this shift: decide from what the prompt says.`,
      '',
      '- Headings: only Added, Changed, Deprecated, Removed, Fixed, Security. Normally Added (new), Changed (improved or upgrade notes, start an upgrade note with "Upgrade:") and Fixed. Start a breaking change with the word BREAKING under Changed or Removed.',
      '- One entry is one line: a short phrase naming the feature or fix, then one to four plain sentences on what the user can now do or what no longer goes wrong, and why it matters. Between 20 and 900 characters. **Bold** for a screen label and backticks for a setting a self-hoster needs are fine.',
      '- Never write ticket keys, commit ids, links, #numbers, @handles, host names, URLs, e-mail or IP addresses, secrets, names of people, agents or machines, or anything about how the work was done (reviews, rework, shifts).',
      '- Internal-only work (refactoring, build, tests, tooling) is not written: put it in "skipped" with the reason "internal".',
      '- A change that an existing entry already describes goes into "covered" with that entry\'s number. Do not write it again.',
      '- One entry may cover several changes: list all their ids in its "sources". Every change in the list must appear exactly once: in an entry\'s sources, in covered or in skipped.',
      '- Do not read or edit any repository and do not commit: the platform writes the file.',
    ].join('\n'),
  );
  out.push('# How to report');
  out.push(
    [
      'Write the JSON in a file in your scratch directory:',
      '`{ "entries": [ { "heading": "Added", "text": "...", "sources": ["<change id>"] } ], "covered": [ { "source": "<change id>", "existing": 1 } ], "skipped": [ { "source": "<change id>", "reason": "internal" } ] }`',
      'If the report is refused, fix exactly what it names and report again in this shift. End the shift with exactly one terminal command:',
      ...outcomes.map((o) => `- ${o.id}: ${o.label}\n  \`${commandFor(o)}\``),
    ].join('\n'),
  );
  return `${out.join('\n\n')}\n`;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The prompt: the numbered changes (commit subjects come from the repository, so they are fenced) and existing entries. */
export function renderReleaseChangelogPrompt(task: ReleaseChangelogTask): string {
  const out: string[] = [`# Changelog entries for ${task.repoName} (${task.releaseBranch})`];
  out.push('## Changes to describe');
  out.push(
    renderUntrusted(
      `Changes on ${task.releaseBranch} of ${task.repoName}`,
      task.changes
        .map((c) => {
          const cards = c.cards.map((k) => (k.title ? `${k.key} ${k.title}` : k.key)).join('; ');
          return `- id ${c.source}: ${clip(c.subject, 300)}${cards ? `\n  cards: ${clip(cards, 600)}` : ''}${c.areas.length ? `\n  areas: ${c.areas.slice(0, 10).join(', ')}` : ''}`;
        })
        .join('\n') || '(none)',
    ),
  );
  out.push('## Entries already under ## [Unreleased]');
  out.push(
    task.existing.length
      ? renderUntrusted(
          `CHANGELOG.md of ${task.repoName}`,
          task.existing.map((e, i) => `${i + 1}. [${e.heading}] ${clip(e.text, 900)}`).join('\n'),
        )
      : 'None.',
  );
  return `${out.join('\n\n')}\n`;
}
