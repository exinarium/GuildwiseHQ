import { z } from 'zod';
import { renderUntrusted } from '../prompt/untrusted.ts';
import {
  type ChangelogProposal,
  ChangelogProposalSchema,
  describeEntryFinding,
  scrubChangelogEntry,
} from './changelog-entries.ts';
import { type ChangelogEntry, changelogHeadingOf } from './changelog-rewrite.ts';

/**
 * The model half of the release prep step 'Write changelog': a `changelog_entries` release prep task. The writer reads
 * one repository's analysed changes and the entries already under Unreleased and proposes public changelog entries as
 * JSON (`release-prep-proposal.json`). The server checks them; the runner merges them into CHANGELOG.md. The writer
 * never edits CHANGELOG.md. Contract shared by the server, the runner and the prompt.
 */

/** What the writer is given for one repository. */
export const ChangelogEntriesTaskSchema = z.object({
  kind: z.literal('changelog_entries'),
  projectName: z.string().max(200),
  repoName: z.string().max(200),
  releaseBranch: z.string().max(200),
  /** The changes no earlier prep run wrote, each with its source id (the commit id). */
  changes: z
    .array(
      z.object({
        source: z.string().max(80),
        subject: z.string().max(400),
        cards: z
          .array(
            z.object({
              key: z.string().max(40),
              title: z.string().max(400).nullable(),
              /** `key` is the client's ticket reference of an intake card (added to the entry by the platform). */
              client: z.boolean().optional(),
            }),
          )
          .max(50)
          .default([]),
        areas: z.array(z.string().max(200)).max(50).default([]),
      }),
    )
    .max(700)
    .default([]),
  /** The bullets already under ## [Unreleased], numbered from 1 in this order. */
  existing: z
    .array(z.object({ heading: z.string().max(40), text: z.string().max(2000) }))
    .max(600)
    .default([]),
});
export type ChangelogEntriesTask = z.infer<typeof ChangelogEntriesTaskSchema>;

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
    agentHandles?: readonly string[];
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
      ...(ctx.agentHandles ? { agentHandles: ctx.agentHandles } : {}),
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
    errors.push(
      `changes listed more than once (entries, covered or skipped): ${conflict.slice(0, 10).join(', ')}`,
    );
  const missing = ctx.uncovered.filter((s) => !seen.has(s));
  if (missing.length)
    errors.push(
      `changes not accounted for (put each in an entry's sources, in covered or in skipped): ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` and ${missing.length - 10} more` : ''}`,
    );
  return errors.length ? { ok: false, errors } : { ok: true, entries, proposal: p };
}

/** At most this many client ticket references are added to one entry. */
const MAX_CLIENT_REFS = 5;

/**
 * Adds the client ticket references of an entry's changes after the public gate: `text (ABC-1)` / `text (ABC-1, ABC-7)`.
 * The writer never writes keys; the platform adds the ticket of each intake card the entry describes. Entries without
 * intake cards are returned unchanged, and a reference already at the end of the text is not added twice.
 */
export function withClientRefs<E extends { text: string; sources: string[] }>(
  entries: readonly E[],
  changes: ChangelogEntriesTask['changes'],
): E[] {
  const bySource = new Map(changes.map((c) => [c.source, c]));
  return entries.map((e) => {
    const refs: string[] = [];
    for (const source of e.sources)
      for (const card of bySource.get(source)?.cards ?? [])
        if (card.client === true && card.key.trim() && !refs.includes(card.key.trim()))
          refs.push(card.key.trim());
    if (refs.length === 0) return e;
    const suffix = ` (${refs.slice(0, MAX_CLIENT_REFS).join(', ')})`;
    const text = e.text.trimEnd();
    return text.endsWith(suffix) ? e : { ...e, text: `${text}${suffix}` };
  });
}

/** The rules of the changelog writer (shared by the task instructions and the tests). */
export const CHANGELOG_WRITER_RULES: readonly string[] = [
  'Write the public changelog entries for the repository from the changes in the prompt. Follow the "Unattended changelog" step of the Release notes playbook (aom skill show playbook:release-notes --file steps/step-05-changelog-unattended.md). Nobody answers questions in this shift: decide from what the prompt says.',
  'Headings: only Added, Changed, Deprecated, Removed, Fixed, Security. Normally Added (new), Changed (improved or upgrade notes, start an upgrade note with "Upgrade:") and Fixed. Start a breaking change with the word BREAKING under Changed or Removed.',
  'One entry is one line: a short phrase naming the feature or fix, then one to four plain sentences on what the user can now do or what no longer goes wrong, and why it matters. Between 20 and 900 characters. **Bold** for a screen label and backticks for a setting a self-hoster needs are fine.',
  "Never write ticket keys (the platform adds the client's ticket reference itself where one applies), commit ids, links, #numbers, @handles, host names, URLs, e-mail or IP addresses, secrets, names of people, agents or machines, or anything about how the work was done (reviews, rework, shifts).",
  'Internal-only work (refactoring, build, tests, tooling) is not written: put it in "skipped" with the reason "internal".',
  'A change that an existing entry already describes goes into "covered" with that entry\'s number. Do not write it again.',
  'One entry may cover several changes: list all their ids in its "sources". Every change in the list must appear exactly once: in an entry\'s sources, in covered or in skipped.',
  'Do not edit CHANGELOG.md or any other repository file: the platform writes it.',
];

/** The JSON shape the changelog writer puts in the proposal file. */
export const CHANGELOG_PROPOSAL_SHAPE =
  '{ "entries": [ { "heading": "Added", "text": "...", "sources": ["<change id>"] } ], "covered": [ { "source": "<change id>", "existing": 1 } ], "skipped": [ { "source": "<change id>", "reason": "internal" } ] }';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The prompt: the numbered changes (commit subjects come from the repository, so they are fenced) and existing entries. */
export function renderReleaseChangelogPrompt(task: ChangelogEntriesTask): string {
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
