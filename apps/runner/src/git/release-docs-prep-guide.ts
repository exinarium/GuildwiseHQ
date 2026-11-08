import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import {
  applyGuideEdits,
  builtinPlaybookText,
  checkGuideUpdate,
  DEFAULT_GUIDE_PATH,
  type GuideEdit,
  type GuideProposal,
  GuideProposalSchema,
  guideOutline,
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
const MODEL_MS = 15 * 60_000;

/** The writer's instructions: the built-in playbook `user-guide` (packages/capabilities/playbooks/user-guide). */
export const GUIDE_PLAYBOOK = 'user-guide';
export function guideInstructions(): string {
  const body = builtinPlaybookText(GUIDE_PLAYBOOK);
  if (!body) throw new Error(`the built-in playbook ${GUIDE_PLAYBOOK} is missing`);
  return body.trim();
}

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

/**
 * 'Update user guide': the writer proposes section edits as JSON, the shared helpers apply and check them, and the
 * PDF guide is rebuilt with the repository's own scripts when the text changed. Edits files only; never commits.
 */
export const runGuideStep: DocsPrepStepHandler = async (ctx) => {
  const wt = ctx.worktree;
  const input = ReleaseDocsPrepGuideInputSchema.safeParse(ctx.payload.stepInput ?? {});
  if (!input.success) return fail('the user guide step got an invalid input from the server');
  const checked = normalizeGuidePath(input.data.guidePath);
  if (!checked.ok) return fail(`refusing the user guide path ${input.data.guidePath}: it ${checked.reason}`);
  const guidePath = checked.path ?? DEFAULT_GUIDE_PATH;
  const where = `${guidePath} on ${ctx.payload.releaseBranch}${input.data.repoName ? ` in ${input.data.repoName}` : ''}`;
  const abs = join(wt, guidePath);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    if (input.data.guidePathConfigured)
      return fail(
        `the user guide ${where} does not exist. Fix the path in Project settings > Release prep (docs and videos), or add the file.`,
      );
    return { ok: true, files: [], output: { ...empty('passed'), skipped: 'no user guide' } };
  }
  // never leave the worktree, even through a symlink
  const real = realpathSync(abs);
  const root = realpathSync(wt);
  if (real !== root && !real.startsWith(root + sep))
    return fail(`refusing the user guide ${where}: it points outside the repository`);
  if (!ctx.summary)
    return fail('Update user guide needs Analyse changes: tick it in the release prep settings');

  const items = await guideChangeItems(ctx);
  const covered = new Set(input.data.coveredSources);
  const uncovered = items.filter((i) => i.sources.some((s) => !covered.has(s)));
  if (uncovered.length === 0)
    return { ok: true, files: [], output: { ...empty('passed'), nothing: 'no new changes' } };

  const before = await readFile(abs, 'utf8');
  const guideDir = dirname(guidePath);
  const helpDir = join(wt, 'apps/web/src/help/articles');
  const hasHelp = existsSync(helpDir);
  const checkCtx = {
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
    denyList: input.data.denyList,
  };
  const pre = checkGuideUpdate(null, before, checkCtx);
  if (pre.errors.length > 0)
    return fail(`the user guide has problems before the update: ${pre.errors[0]}`, pre);

  const doc = parseGuide(before);
  const sectionText = (ref: string): string => {
    const s = doc.sections.find((x) => x.heading.text === ref);
    return s ? doc.lines.slice(s.heading.line, s.end).join('\n') : '';
  };
  const hinted = new Set<string>();
  const changes = uncovered.map((i) => {
    const hints = locateSections(doc, i).slice(0, 3);
    for (const h of hints) hinted.add(h.section);
    return { ...i, hints };
  });
  const outFile = join(ctx.outDir, 'guide.json');
  const prompt = (extra = ''): string =>
    [
      `Write the JSON to ${outFile}.`,
      `The guide is ${guidePath}. Its outline:\n${guideOutline(doc)}`,
      `The changes (with the sections that most likely describe them):\n${JSON.stringify(changes, null, 1)}`,
      `The current text of those sections:\n${[...hinted].map(sectionText).join('\n\n')}`,
      extra,
    ]
      .filter(Boolean)
      .join('\n\n');

  const ask = async (extra?: string): Promise<GuideProposal | string> => {
    const r = await ctx.runModel({
      instructions: guideInstructions(),
      prompt: prompt(extra),
      readDirs: [wt],
      writeDir: ctx.outDir,
      timeoutMs: MODEL_MS,
    });
    if (!r.ok) return r.error;
    if ((await changedPaths(wt)).length > 0) return 'the writer changed files in the repository';
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(outFile, 'utf8'));
    } catch {
      return 'the writer did not write a valid JSON file';
    }
    const p = GuideProposalSchema.safeParse(raw);
    return p.success ? p.data : `the writer's JSON is not valid: ${p.error.issues[0]?.message ?? ''}`;
  };

  const attempt = (proposal: GuideProposal) => {
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
  };

  let proposal = await ask();
  if (typeof proposal === 'string') return fail(proposal);
  let result = attempt(proposal);
  if (result.errors.length > 0) {
    const named = [...new Set(proposal.edits.map((e) => (e.op === 'add_section' ? e.after : e.section)))];
    const again = await ask(
      `Your previous edits were refused:\n- ${result.errors.join('\n- ')}\nSections you named, as they are now:\n${named
        .map(
          (n) => doc.sections.find((s) => s.heading.number === n || s.heading.text === n)?.heading.text ?? n,
        )
        .map(sectionText)
        .join('\n\n')}\nReturn the whole JSON again.`,
    );
    if (typeof again === 'string') return fail(again);
    proposal = again;
    result = attempt(proposal);
    if (result.errors.length > 0)
      return fail(`the guide update was refused: ${result.errors[0]}`, {
        errors: result.errors,
        warnings: result.warnings,
      });
  }

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
    const pdf = guidePdfMeta(input.data.release, new Date());
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
