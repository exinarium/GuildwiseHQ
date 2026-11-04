import { z } from 'zod';

/**
 * Release prep tasks: work inside a prep step that an agent does in a `release_prep` shift (the server dispatches one
 * shift per task; the runner gives it a detached worktree from the run's work ref and lets it change only the files the
 * task names). Generic by `task.kind`; today only `new_video` (Generate videos: write the script of a new video).
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

export const ReleasePrepTaskSchema = z.discriminatedUnion('kind', [NewVideoTaskSchema]);
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

export function writableFilesFor(task: ReleasePrepTask): string[] {
  return newVideoWritableFiles(task.slug);
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

/** The instructions of a release_prep shift (the role's own text is not used: the task is self-contained). */
export function renderReleasePrepInstructions(
  agent: { name: string },
  project: { key: string; name: string },
  rp: ReleasePrepShift,
): string {
  return [
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
}

/** The prompt of a release_prep shift: the task. */
export function renderReleasePrepPrompt(rp: ReleasePrepShift): string {
  const t = rp.task;
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
