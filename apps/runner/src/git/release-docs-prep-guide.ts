import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import {
  applyGuideEdits,
  checkGuideUpdate,
  DEFAULT_GUIDE_PATH,
  type GuideChange,
  type GuideEdit,
  type GuideProposal,
  GuideProposalSchema,
  locateSections,
  normalizeGuidePath,
  parseGuide,
  type ReleaseDocsPrepGuideInput,
  ReleaseDocsPrepGuideInputSchema,
  type ReleaseDocsPrepGuideOutput,
} from '@aom/shared';
import { git } from './git.ts';
import { areaOf } from './release-docs-prep.ts';
import type { DocsPrepStepContext, DocsPrepStepHandler } from './release-docs-prep-steps.ts';

/** One change of the release, as the guide writer sees it. */
export interface GuideChangeItem {
  sources: string[];
  title: string;
  subjects: string[];
  files: string[];
  areas: string[];
  routes: string[];
}

const FILES_MAX = 200;
const SUBJECTS_MAX = 20;
const LIST_MAX = 50;
/** The check report is stored on the step row (the server caps it at REPORT_MAX_BYTES = 64 KB). */
const CHECK_REPORT_MAX_BYTES = 48 * 1024;

const lines = (s: string): string[] =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** The changes of the release, one per first-parent merge (or per commit when there are no merges). */
export async function guideChangeItems(ctx: DocsPrepStepContext): Promise<GuideChangeItem[]> {
  const s = ctx.summary;
  if (!s) return [];
  const wt = ctx.worktree;
  const out: GuideChangeItem[] = [];
  const routesOf = (t: string): string[] =>
    [...t.matchAll(/(?<![\w/])(\/[a-z][a-z0-9/_-]*)/g)].map((m) => m[1] as string);
  const finish = (sources: string[], title: string, subjects: string[], files: string[]): void => {
    const areas = [...new Set(files.map((f) => areaOf(f, ctx.payload.components)))];
    out.push({
      sources,
      title,
      subjects,
      files,
      areas,
      routes: [...new Set([title, ...subjects].flatMap(routesOf))],
    });
  };
  if (s.merges.length > 0) {
    for (const m of s.merges) {
      const files = lines((await git(wt, ['diff', '--name-only', `${m.sha}^1`, m.sha])).stdout).slice(
        0,
        FILES_MAX,
      );
      const subjects = lines((await git(wt, ['log', '--format=%s', `${m.sha}^1..${m.sha}^2`])).stdout).slice(
        0,
        SUBJECTS_MAX,
      );
      const sources = m.cardKeys.length > 0 ? m.cardKeys.map((k) => `card:${k}`) : [`merge:${m.sha}`];
      finish(sources, m.subject, subjects, files);
    }
    return out;
  }
  for (const c of s.commits) {
    const files = lines((await git(wt, ['show', '--name-only', '--format=', c.sha])).stdout).slice(
      0,
      FILES_MAX,
    );
    finish([`commit:${c.sha}`], c.subject, [], files);
  }
  return out;
}

const empty = (status: 'passed' | 'failed'): ReleaseDocsPrepGuideOutput => ({
  status,
  changed: [],
  added: [],
  covered: [],
  skippedChanges: [],
  duplicates: 0,
  pdf: 'no change',
  errors: [],
  warnings: [],
  notes: [],
});

const capOutput = (o: ReleaseDocsPrepGuideOutput): ReleaseDocsPrepGuideOutput => ({
  ...o,
  changed: o.changed.slice(0, LIST_MAX),
  added: o.added.slice(0, LIST_MAX),
  covered: o.covered.slice(0, LIST_MAX),
  skippedChanges: o.skippedChanges.slice(0, LIST_MAX),
  errors: o.errors.slice(0, LIST_MAX).map((e) => e.slice(0, 500)),
  warnings: o.warnings.slice(0, LIST_MAX).map((e) => e.slice(0, 500)),
  notes: o.notes.slice(0, LIST_MAX).map((e) => e.slice(0, 500)),
});

const fail = (error: string, o: Partial<ReleaseDocsPrepGuideOutput> = {}) => ({
  ok: false as const,
  error,
  output: capOutput({ ...empty('failed'), ...o, errors: [...(o.errors ?? []), error] }),
});

const tail = (s: string, n = 20): string => s.trim().split('\n').slice(-n).join('\n');

/** Paths changed in the worktree (untracked files one by one). */
async function changedPaths(wt: string): Promise<string[]> {
  return (await git(wt, ['status', '--porcelain', '-uall'])).stdout
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    .map((p) => (p.includes(' -> ') ? (p.split(' -> ')[1] as string) : p));
}

/** What the guide checks need from the repository (assets, help articles) and the scrub list. */
export function guideCheckContext(wt: string, guidePath: string, denyList: readonly string[]) {
  const guideDir = dirname(guidePath);
  const helpDir = join(wt, 'apps/web/src/help/articles');
  const hasHelp = existsSync(helpDir);
  return {
    assetExists: (rel: string) => existsSync(join(wt, guideDir, rel)),
    ...(hasHelp
      ? {
          helpRef: (slug: string, id: string | null) => {
            const f = join(helpDir, `${slug}.md`);
            if (!existsSync(f)) return false;
            return id === null || new RegExp(`\\{#${id}\\}`).test(readFileSyncSafe(f));
          },
        }
      : {}),
    denyList: [...denyList],
  };
}

export type GuideCheckContextOf = ReturnType<typeof guideCheckContext>;

/**
 * Applies a proposal's edits to the guide text and checks the result with `checkGuideUpdate`. The one place the edits are
 * checked: the shift's `aom prep done` (so the writer can fix a refusal in the same shift) and the apply phase use it.
 */
export function tryGuideEdits(before: string, proposal: GuideProposal, checkCtx: GuideCheckContextOf) {
  const applied = applyGuideEdits(before, proposal.edits);
  if (applied.kind === 'error') return { applied, errors: applied.errors, warnings: [] as string[] };
  if (applied.kind === 'unchanged') return { applied, errors: [] as string[], warnings: [] as string[] };
  const check = checkGuideUpdate(before, applied.md, {
    ...checkCtx,
    changedRanges: applied.written,
    editedSections: applied.changed.length,
    addedSections: applied.added.length,
  });
  return { applied, ...check };
}

const NEWER_SERVER = 'this runner needs a newer server for Update user guide: update the server';

/** The guide path of the step input, or the failure. */
function guidePathOf(ctx: DocsPrepStepContext) {
  const input = ReleaseDocsPrepGuideInputSchema.safeParse(ctx.payload.stepInput ?? {});
  if (!input.success) return { ok: false as const, error: 'the user guide step got an invalid input from the server' };
  const checked = normalizeGuidePath(input.data.guidePath);
  if (!checked.ok)
    return { ok: false as const, error: `refusing the user guide path ${input.data.guidePath}: it ${checked.reason}` };
  const guidePath = checked.path ?? DEFAULT_GUIDE_PATH;
  const where = `${guidePath} on ${ctx.payload.releaseBranch}${input.data.repoName ? ` in ${input.data.repoName}` : ''}`;
  return { ok: true as const, input: input.data, guidePath, where };
}

const NO_GUIDE_NOTE = 'skipped: no user guide in this repository';

/** 'Update user guide', phase `check`: is there a guide, and which changes does it still have to describe? */
async function checkPhase(ctx: DocsPrepStepContext) {
  const wt = ctx.worktree;
  const g = guidePathOf(ctx);
  if (!g.ok) return fail(g.error);
  const { input, guidePath, where } = g;
  const abs = join(wt, guidePath);
  // The first phase decides that the step does not apply: a repository without a guide is skipped, no writer needed.
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    if (input.guidePathConfigured)
      return fail(
        `the user guide ${where} does not exist. Fix the path in Project settings > Release prep (docs and videos), or add the file.`,
      );
    return {
      ok: true as const,
      state: 'skipped' as const,
      note: NO_GUIDE_NOTE,
      files: [],
      output: { ...empty('passed'), skipped: 'no user guide' },
    };
  }
  // never leave the worktree, even through a symlink
  const real = realpathSync(abs);
  const root = realpathSync(wt);
  if (real !== root && !real.startsWith(root + sep))
    return fail(`refusing the user guide ${where}: it points outside the repository`);
  if (!ctx.summary)
    return fail('Update user guide needs Analyse changes: tick it in the release prep settings');

  const items = await guideChangeItems(ctx);
  const covered = new Set(input.coveredSources);
  const uncovered = items.filter((i) => i.sources.some((s) => !covered.has(s)));
  if (uncovered.length === 0)
    return {
      ok: true as const,
      files: [],
      report: { changes: [] },
      output: { ...empty('passed'), nothing: 'no new changes' },
    };

  const before = await readFile(abs, 'utf8');
  const checkCtx = guideCheckContext(wt, guidePath, input.denyList);
  const pre = checkGuideUpdate(null, before, checkCtx);
  if (pre.errors.length > 0)
    return fail(`the user guide has problems before the update: ${pre.errors[0]}`, pre);

  const doc = parseGuide(before);
  const build = (filesCap: number): GuideChange[] =>
    uncovered.map((i) => ({
      sources: i.sources.slice(0, 50),
      title: i.title.slice(0, 400),
      subjects: i.subjects.slice(0, SUBJECTS_MAX).map((x) => x.slice(0, 400)),
      files: i.files.slice(0, filesCap).map((x) => x.slice(0, 400)),
      areas: i.areas.slice(0, 50).map((x) => x.slice(0, 200)),
      routes: i.routes.slice(0, 50).map((x) => x.slice(0, 200)),
      hints: locateSections(doc, i)
        .slice(0, 3)
        .map((h) => ({ section: h.section.slice(0, 300), score: h.score, why: h.why.slice(0, 300) })),
    }));
  // The report goes on the step row and into the writer's task: keep it under the cap by trimming the file lists first.
  let changes = build(FILES_MAX);
  for (const cap of [50, 10, 0]) {
    if (JSON.stringify(changes).length <= CHECK_REPORT_MAX_BYTES) break;
    changes = build(cap);
  }
  while (changes.length > 1 && JSON.stringify(changes).length > CHECK_REPORT_MAX_BYTES)
    changes = changes.slice(0, -1);
  return { ok: true as const, files: [], report: { guidePath, changes } };
}

/**
 * 'Update user guide': `check` finds the guide and the changes it has to describe (no guide: skipped), the server has a
 * writer agent propose section edits (a release prep task, checked at `aom prep done`), and `apply` applies and checks
 * them with the shared helpers and rebuilds the PDF guide with the repository's own scripts when the text changed.
 * Edits files only; never commits.
 */
export const runGuideStep: DocsPrepStepHandler = async (ctx) => {
  if (ctx.phase === 'check') return checkPhase(ctx);
  if (ctx.phase !== 'apply') return fail(NEWER_SERVER);
  const wt = ctx.worktree;
  const g = guidePathOf(ctx);
  if (!g.ok) return fail(g.error);
  const { input, guidePath } = g;
  const abs = join(wt, guidePath);
  if (!existsSync(abs) || !statSync(abs).isFile())
    return {
      ok: true,
      state: 'skipped',
      note: NO_GUIDE_NOTE,
      files: [],
      output: { ...empty('passed'), skipped: 'no user guide' },
    };
  const rawProposal = ctx.input?.proposal;
  if (rawProposal === undefined || rawProposal === null)
    return { ok: true, files: [], output: { ...empty('passed'), nothing: 'no new changes' } };
  const parsedProposal = GuideProposalSchema.safeParse(rawProposal);
  if (!parsedProposal.success)
    return fail(`the guide proposal is not valid: ${parsedProposal.error.issues[0]?.message ?? ''}`);
  const proposal = parsedProposal.data;

  const before = await readFile(abs, 'utf8');
  const guideDir = dirname(guidePath);
  const checkCtx = guideCheckContext(wt, guidePath, input.denyList);
  const pre = checkGuideUpdate(null, before, checkCtx);
  if (pre.errors.length > 0)
    return fail(`the user guide has problems before the update: ${pre.errors[0]}`, pre);

  // The writer is gone by now: a refusal can only come from the work having moved since the shift checked it.
  const result = tryGuideEdits(before, proposal, checkCtx);
  if (result.errors.length > 0)
    return fail(`the guide update was refused: ${result.errors[0]}`, {
      errors: result.errors,
      warnings: result.warnings,
    });

  const sourcesFor = (pick: (e: GuideEdit) => boolean): string[] => [
    ...new Set(proposal.edits.filter(pick).flatMap((e) => e.sources)),
  ];
  const base: ReleaseDocsPrepGuideOutput = {
    ...empty('passed'),
    covered: proposal.covered,
    skippedChanges: proposal.skipped,
    notes: proposal.notes,
    warnings: result.warnings,
  };
  const a = result.applied;
  if (a.kind !== 'changed')
    return {
      ok: true,
      files: [],
      output: capOutput({
        ...base,
        duplicates: a.kind === 'unchanged' ? a.duplicates.length : 0,
        nothing: 'no guide change needed',
      }),
    };

  const num = (t: string): string => /^(\d+\.\d+[a-z]?)/.exec(t)?.[1] ?? t;
  const out: ReleaseDocsPrepGuideOutput = {
    ...base,
    duplicates: a.duplicates.length,
    changed: a.changed.map((section) => ({
      section,
      sources: sourcesFor(
        (e) => e.op !== 'add_section' && [section, num(section)].includes(e.section.trim()),
      ),
    })),
    added: a.added.map((x) => ({
      ...x,
      sources: sourcesFor((e) => e.op === 'add_section' && x.section.endsWith(e.title.trim())),
    })),
  };
  await writeFile(abs, a.md, 'utf8');

  // The PDF guide, built the way docs/guide/README.md says, only when the text changed.
  const scripts = join(guideDir, 'guide');
  const assemble = join(scripts, 'assemble-guide.mjs');
  const build = join(scripts, 'build-guide.mjs');
  // The scripts read ../USER-GUIDE.md: they can only rebuild a guide of that name.
  const pdfReadsThisFile = basename(guidePath) === 'USER-GUIDE.md';
  if (!pdfReadsThisFile || !existsSync(join(wt, assemble))) {
    out.pdf = 'no PDF build';
    if (!pdfReadsThisFile && existsSync(join(wt, assemble)))
      out.notes = [
        ...out.notes,
        `the PDF guide was not rebuilt: its scripts build USER-GUIDE.md, not ${guidePath}`,
      ];
  } else {
    // The date and release come from the release being prepared, but only a build script that takes the flags
    // can show them (a release branch cut before the flags existed keeps the date written in it).
    const buildText = existsSync(join(wt, build)) ? readFileSyncSafe(join(wt, build)) : '';
    const pdf = guidePdfMeta(input.release, new Date());
    const buildArgs = [build];
    if (buildText.includes('--date')) {
      buildArgs.push('--date', pdf.date);
      out.pdfDate = pdf.date;
      out.pdfDateSource = pdf.source;
      if (pdf.edition && buildText.includes('--edition')) {
        buildArgs.push('--edition', pdf.edition);
        out.pdfEdition = pdf.edition;
      }
      if (pdf.source === 'run')
        out.notes = [
          ...out.notes,
          `the release has no date yet, so the PDF shows ${pdf.fromRunner ? 'today on this workstation' : 'the day this prep run started'} (${pdf.date})`,
        ];
    } else if (buildText)
      out.warnings = [
        ...out.warnings,
        'the PDF build script takes no --date, so the PDF keeps the date written in it',
      ];
    const steps: Array<[string, string[], number]> = [
      ['corepack', ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline'], 10 * 60_000],
      ['corepack', ['pnpm', '--filter', '@aom/e2e', 'exec', 'playwright', 'install', 'chromium'], 5 * 60_000],
      ['node', [assemble], 2 * 60_000],
      ...(existsSync(join(wt, build))
        ? ([['node', buildArgs, 10 * 60_000]] as Array<[string, string[], number]>)
        : []),
    ];
    for (const [cmd, args, timeoutMs] of steps) {
      const r = await ctx.exec(cmd, args, { cwd: wt, timeoutMs });
      if (r.exitCode !== 0 || r.timedOut)
        return fail(
          `the PDF guide could not be built: ${r.timedOut ? 'timed out' : tail(`${r.stdout}\n${r.stderr}`)}`,
          out,
        );
    }
    const assembled = await readFile(abs, 'utf8');
    const post = checkGuideUpdate(before, assembled, checkCtx);
    if (post.errors.length > 0) return fail(`the assembled guide has problems: ${post.errors[0]}`, out);
    out.pdf = 'rebuilt';
  }

  const changed = await changedPaths(wt);
  const inside = (p: string): boolean => p === guidePath || !relative(scripts, p).startsWith('..');
  const outside = changed.filter((p) => !inside(p));
  if (outside.length > 0) return fail(`the guide build changed ${outside.join(', ')}`, out);
  return { ok: true, files: changed, output: capOutput(out) };
};

/** What the PDF build gets: the release date (else the run date, else today on this runner) and the version. */
export function guidePdfMeta(
  release: ReleaseDocsPrepGuideInput['release'],
  now: Date,
): { date: string; source: 'release' | 'run'; edition: string | null; fromRunner: boolean } {
  const date = release?.date ?? release?.runDate ?? now.toISOString().slice(0, 10);
  return {
    date,
    source: release?.date ? 'release' : 'run',
    edition: release?.version ?? null,
    fromRunner: !release,
  };
}

function readFileSyncSafe(f: string): string {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return '';
  }
}
