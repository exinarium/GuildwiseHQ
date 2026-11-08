import { z } from 'zod';
import { builtinPlaybookText } from '../capabilities/builtin.ts';
import {
  CHANGELOG_PROPOSAL_SHAPE,
  CHANGELOG_WRITER_RULES,
  ChangelogEntriesTaskSchema,
  renderReleaseChangelogPrompt,
} from './changelog-task.ts';

/**
 * Release prep tasks: work inside a prep step that an agent does in a `release_prep` shift (the server dispatches one
 * shift per task; the runner gives it a detached worktree from the run's work ref and lets it change only the files the
 * task names). Generic by `task.kind`: `new_video` (Generate videos: write the script of a new video), and the two
 * proposal kinds `changelog_entries` (Write changelog) and `guide_edits` (Update user guide), whose writer proposes JSON
 * in `release-prep-proposal.json` that the runner and the server check before anything is committed (GWP-134).
 *
 * This is the one writer mechanism of the release prep content steps: PREP_TASK_KINDS says which agent roles may write a
 * kind, and `prepWriterUnavailable` words the one failure.
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const NewVideoTaskSchema = z.object({
  kind: z.literal('new_video'),
  slug: z.string().regex(SLUG_RE),
  title: z.string().min(1).max(200),
  /** The page files of the new screen (repository paths). */
  pages: z.array(z.string().max(400)).max(50),
  /** The card keys that changed those pages. */
  cards: z.array(z.string().max(40)).max(100),
  /** A repair round: the render error of the script written before (its tail). */
  repairOf: z.object({ error: z.string().max(4000) }).optional(),
});
export type NewVideoTask = z.infer<typeof NewVideoTaskSchema>;

export { ChangelogEntriesTaskSchema };
export type { ChangelogEntriesTask } from './changelog-task.ts';

/** The file a proposal task writes (at the worktree root). */
export const PREP_PROPOSAL_FILE = 'release-prep-proposal.json';

/** One change of the release as the guide writer sees it (the section texts are not sent: the writer reads the guide). */
export const GuideChangeSchema = z.object({
  sources: z.array(z.string().max(80)).max(50),
  title: z.string().max(400),
  subjects: z.array(z.string().max(400)).max(20).default([]),
  files: z.array(z.string().max(400)).max(200).default([]),
  areas: z.array(z.string().max(200)).max(50).default([]),
  routes: z.array(z.string().max(200)).max(50).default([]),
  hints: z
    .array(z.object({ section: z.string().max(300), score: z.number(), why: z.string().max(300) }))
    .max(3)
    .default([]),
});
export type GuideChange = z.infer<typeof GuideChangeSchema>;

export const GuideEditsTaskSchema = z.object({
  kind: z.literal('guide_edits'),
  guidePath: z.string().min(1).max(300),
  changes: z.array(GuideChangeSchema).min(1).max(300),
  /** Change ids earlier passed runs already dealt with (the writer must not write them again). */
  coveredSources: z.array(z.string().max(80)).max(2000).default([]),
});
export type GuideEditsTask = z.infer<typeof GuideEditsTaskSchema>;

export const ReleasePrepTaskSchema = z.discriminatedUnion('kind', [
  NewVideoTaskSchema,
  ChangelogEntriesTaskSchema,
  GuideEditsTaskSchema,
]);
export type ReleasePrepTask = z.infer<typeof ReleasePrepTaskSchema>;

/** `shift.start.releasePrep` for `kind: 'release_prep'`; the brief carries a placeholder card. */
export const ReleasePrepShiftSchema = z.object({
  taskId: z.uuid(),
  runId: z.uuid(),
  repoId: z.uuid(),
  step: z.string().max(40),
  phase: z.string().max(40),
  /** The repository's clone on this workstation (normalized remote URL). */
  remoteUrlNormalized: z.string().max(500),
  /** The ref the worktree starts from and the local commit goes to (`refs/guildwise/docs-prep/<run>/work`). */
  workRef: z.string().max(200),
  /** Where to start when the work ref does not exist yet (the analysed head). */
  startSha: z.string().regex(/^[0-9a-f]{40}$/),
  task: ReleasePrepTaskSchema,
  /** The only files the shift may create or change. */
  writable: z.array(z.string().max(400)).min(1).max(20),
});
export type ReleasePrepShift = z.infer<typeof ReleasePrepShiftSchema>;

/** The outcome ids of `aom prep done` and `aom prep fail`. */
export const PREP_OUTCOME = { done: 'prep_done', failed: 'prep_failed' } as const;

/** The outcomes a release_prep shift's brief lists. */
export function releasePrepBriefOutcomes() {
  return [
    { id: PREP_OUTCOME.done, label: 'The files are written', kind: 'success' as const, data: 'prepDone' },
    {
      id: PREP_OUTCOME.failed,
      label: 'The files could not be written',
      kind: 'failure' as const,
      data: 'prepFailed',
    },
  ];
}

/** The longest a release_prep shift may run. */
export const RELEASE_PREP_MAX_SHIFT_MINUTES = 45;

/** `aom prep done --summary "..."` / `aom prep fail --reason "..."`: the terminal commands of a release_prep shift. */
export const PrepDoneParamsSchema = z.object({ summary: z.string().trim().min(1).max(4000) });
export const PrepFailParamsSchema = z.object({ reason: z.string().trim().min(1).max(4000) });

/** The result the runner reports at the end of a release_prep shift (after its own checks and commit). */
export const ReleasePrepTaskResultSchema = z.object({
  taskId: z.uuid(),
  ok: z.boolean(),
  /** The agent's summary (done) or reason (fail), or the runner's own refusal. */
  note: z.string().max(4000),
  /** The commit on the work ref (done and committed). */
  commit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  files: z.array(z.string().max(400)).max(50).default([]),
  /** The proposal of a proposal task, checked by the runner (the server checks it again). */
  proposal: z.unknown().optional(),
});
export type ReleasePrepTaskResult = z.infer<typeof ReleasePrepTaskResultSchema>;

/** The files a `new_video` task may write (design 5.4): its spec and narration, the screen map, the video list and the plan. */
export function newVideoWritableFiles(slug: string): string[] {
  return [
    `e2e/video/${slug}.spec.ts`,
    `e2e/video/narration/${slug}.ts`,
    'e2e/video/screens.json',
    'apps/web/src/lib/videos.ts',
    'docs/guide/VIDEO-PLAN.md',
  ];
}

/** The files a task may write: the files of a video, or the one proposal file. */
export function writableFilesFor(task: ReleasePrepTask): string[] {
  return task.kind === 'new_video' ? newVideoWritableFiles(task.slug) : [PREP_PROPOSAL_FILE];
}

export type PrepWriterRole = 'ba' | 'architect' | 'builder';

export interface PrepTaskKindSpec {
  /** The agent roles that may write this kind, in order of preference. The one chooser reads this. */
  roles: readonly PrepWriterRole[];
  /** `files`: the agent writes repository files. `proposal`: the agent writes `release-prep-proposal.json` for checks. */
  result: 'files' | 'proposal';
  /** What the task writes, for messages. */
  what: (task: ReleasePrepTask) => string;
  /** The title of the writer's shift. */
  title: (task: ReleasePrepTask, branch: string) => string;
  /** The step's label in messages (the registry label of the step). */
  step: string;
  /** An extra sentence of the no-writer message: what the owner can do by hand. */
  manual?: string;
}

/** The one registry of writer work: which roles write which task kind. Add a kind here to add a writer step. */
export const PREP_TASK_KINDS: Record<ReleasePrepTask['kind'], PrepTaskKindSpec> = {
  new_video: {
    roles: ['builder'],
    result: 'files',
    step: 'Generate videos',
    what: (t) => (t.kind === 'new_video' ? `the ${t.slug} video` : 'the video'),
    title: (t, branch) => `Write the ${t.kind === 'new_video' ? t.title : ''} video (${branch})`,
  },
  changelog_entries: {
    roles: ['ba', 'architect', 'builder'],
    result: 'proposal',
    step: 'Write changelog',
    what: () => 'the changelog entries',
    title: (_t, branch) => `Write the changelog entries (${branch})`,
    manual: 'Or write the entries under ## [Unreleased] by hand and Skip prep.',
  },
  guide_edits: {
    roles: ['architect', 'ba', 'builder'],
    result: 'proposal',
    step: 'Update user guide',
    what: () => 'the user guide update',
    title: (_t, branch) => `Update the user guide (${branch})`,
  },
};

export type PrepWriterFailureCode = 'no_writer' | 'writer_unreachable' | 'writer_failed';

const ROLE_NAMES: Record<PrepWriterRole, string> = { ba: 'BA', architect: 'architect', builder: 'builder' };
const joinRoles = (roles: readonly PrepWriterRole[]): string => {
  const names = roles.map((r) => ROLE_NAMES[r]);
  return names.length <= 1
    ? (names[0] ?? 'agent')
    : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
};

/**
 * The one sentence a content step shows when its text could not be written. Used by every finisher of a writer phase, so
 * Write changelog, Update user guide and Generate videos fail the same way.
 */
export function prepWriterUnavailable(
  code: PrepWriterFailureCode,
  kind: ReleasePrepTask['kind'],
  o: { workstation?: string; reason?: string; what?: string } = {},
): string {
  const spec = PREP_TASK_KINDS[kind];
  const ws = o.workstation || 'the workstation that has the repository';
  const what = o.what ?? (kind === 'new_video' ? 'the video' : spec.what({ kind } as ReleasePrepTask));
  const manual = spec.manual ? ` ${spec.manual}` : '';
  if (code === 'no_writer')
    return `${spec.step}: no agent on ${ws} can write ${what}. It needs an active ${joinRoles(spec.roles)} agent on that workstation. Hire or move one there (or turn the step off), then Retry prep.${manual}`;
  if (code === 'writer_unreachable')
    return `${spec.step}: no agent on ${ws} could write ${what} within 2 hours${o.reason ? ` (${o.reason})` : ''}. Check the runner and the agents' model accounts, then Retry prep.${manual}`;
  return `${spec.step}: ${what} could not be written${o.reason ? `: ${o.reason}` : ''}`;
}

/** The changed paths outside the writable list (sorted); empty means the shift kept to its files. */
export function filesOutsideWritable(changed: readonly string[], writable: readonly string[]): string[] {
  const ok = new Set(writable);
  return [...new Set(changed.filter((p) => !ok.has(p)))].sort();
}

/** What a new_video task must have produced to count as done: the spec and its narration. */
export function missingNewVideoFiles(task: NewVideoTask, changed: readonly string[]): string[] {
  const have = new Set(changed);
  return [`e2e/video/${task.slug}.spec.ts`, `e2e/video/narration/${task.slug}.ts`].filter(
    (p) => !have.has(p),
  );
}

const PROPOSAL_SHAPE: Record<'changelog_entries' | 'guide_edits', string> = {
  changelog_entries: CHANGELOG_PROPOSAL_SHAPE,
  guide_edits:
    '{"edits":[{"op":"replace_text","section":"4.28","find":"...","replace":"...","sources":["card:KEY-1"]},{"op":"append","section":"4.28","text":"...","sources":[]},{"op":"add_section","after":"4.28","title":"...","body":"...","sources":[]}],"covered":[{"source":"...","section":"4.28"}],"skipped":[{"source":"...","reason":"..."}],"notes":[]}',
};

/** The instructions of a release_prep shift (the role's own text is not used: the task is self-contained). */
export function renderReleasePrepInstructions(
  agent: { name: string },
  project: { key: string; name: string },
  rp: ReleasePrepShift,
): string {
  const head = [
    `# Release prep task`,
    '',
    `You are ${agent.name}, writing one part of the release preparation of project ${project.key} (${project.name}).`,
    'You work in a detached checkout of the release work (your working directory). Nothing you do is pushed: the release',
    'prep commits it later, after every step passed.',
    '',
    '# Rules',
    '',
    '- Create or change only these files (any other change refuses your work):',
    ...rp.writable.map((f) => `  - ${f}`),
  ];
  const task = rp.task;
  if (task.kind === 'new_video')
    return [
      ...head,
      '- Do not render or record anything, do not start servers, do not install anything: the release prep renders the video',
      '  itself after you finish.',
      '- Use only the demo data the existing video specs use. Never put real names, e-mail addresses or secrets in a script.',
      '- Follow the style of the existing files exactly; do not change the harness, the voice or the video look.',
      '',
      '# How to finish',
      '',
      'Run exactly one of these, on its own:',
      '- `aom prep done --summary "<what you wrote>"` when the files are written;',
      '- `aom prep fail --reason "<why not>"` when you cannot write them.',
      '',
    ].join('\n');
  const rules =
    task.kind === 'changelog_entries'
      ? CHANGELOG_WRITER_RULES.map((r) => `- ${r}`)
      : [guideWriterText()];
  return [
    ...head,
    '- Do not install anything, start servers or build anything: the release prep applies and checks your proposal itself.',
    '- Nobody answers questions in this shift: decide from what the prompt says.',
    '',
    task.kind === 'changelog_entries' ? '# The changelog writer' : '# The user guide writer',
    '',
    ...rules,
    '',
    '# How to finish',
    '',
    `Write your proposal as JSON in \`${PREP_PROPOSAL_FILE}\`, in this shape:`,
    '',
    PROPOSAL_SHAPE[task.kind],
    '',
    'Run exactly one of these, on its own:',
    '- `aom prep done --summary "<what you wrote>"` when the file is written. If the proposal is refused, the refusal names what to fix: fix exactly that and run it again in this shift;',
    '- `aom prep fail --reason "<why not>"` when nothing can be written.',
    '',
  ].join('\n');
}

/** The guide writer's instructions: the built-in playbook `user-guide`. */
export const GUIDE_PLAYBOOK = 'user-guide';
function guideWriterText(): string {
  const body = builtinPlaybookText(GUIDE_PLAYBOOK);
  if (!body) throw new Error(`the built-in playbook ${GUIDE_PLAYBOOK} is missing`);
  return body.trim();
}

/** The prompt of a release_prep shift: the task. */
export function renderReleasePrepPrompt(rp: ReleasePrepShift): string {
  const t = rp.task;
  if (t.kind === 'changelog_entries') return renderReleaseChangelogPrompt(t);
  if (t.kind === 'guide_edits') {
    return [
      `Update the user guide \`${t.guidePath}\` for the changes of this release. Read the guide in your working directory first (its outline, then the sections named in the hints).`,
      '',
      'The changes, each with the sections that most likely describe them:',
      '',
      JSON.stringify(t.changes, null, 1),
      ...(t.coveredSources.length
        ? ['', `${t.coveredSources.length} changes were dealt with by an earlier prep run: do not write them again.`]
        : []),
      '',
      `Then write \`${PREP_PROPOSAL_FILE}\` and finish with \`aom prep done --summary "..."\` (or \`aom prep fail --reason "..."\`).`,
    ].join('\n');
  }
  const lines = [
    `Write the script of a new help video: "${t.title}" (slug \`${t.slug}\`).`,
    '',
    'The new screen:',
    ...(t.pages.length
      ? t.pages.map((p) => `- ${p}`)
      : ['- (no page file named; find the screen from the slug)']),
    ...(t.cards.length ? ['', `Changed by: ${t.cards.join(', ')}.`] : []),
    '',
    'Steps:',
    `1. Copy \`e2e/video/template/slug.spec.ts\` to \`e2e/video/${t.slug}.spec.ts\` and \`e2e/video/narration/slug.ts\` to \`e2e/video/narration/${t.slug}.ts\`, and fill them in.`,
    '   Use `e2e/video/backlog.spec.ts` with `e2e/video/narration/backlog.ts`, and one spec of a nearby section, as style examples.',
    '2. Follow the rules in `docs/guide/VIDEO-PLAN.md`: start on the page through the sidebar, about 2.4 words a second, demo data only.',
    `3. In \`e2e/video/screens.json\` add \`videos.${t.slug}\` with the screens it shows and their page files, and remove its \`planned\` entry if there is one.`,
    `4. In \`apps/web/src/lib/videos.ts\` add or update the \`${t.slug}\` entry with \`published: true\`, choosing its nav, paths and help from the nav config and the Help articles.`,
    `5. Add a short entry for the video to \`docs/guide/VIDEO-PLAN.md\`.`,
  ];
  if (t.repairOf)
    lines.push(
      '',
      'This is a second try: the script written before failed to record with this error. Fix the script so it records:',
      '',
      '```',
      t.repairOf.error,
      '```',
    );
  lines.push('', 'Then finish with `aom prep done --summary "..."` (or `aom prep fail --reason "..."`).');
  return lines.join('\n');
}

/** The author row's error for one video. */
export const authorFailure = (slug: string, reason: string): string =>
  `${slug}: could not write the video script: ${reason}`;
