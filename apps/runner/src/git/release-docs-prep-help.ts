import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import {
  applyHelpEdits,
  checkHelpUpdate,
  type HelpChange,
  type HelpEdit,
  type HelpProposal,
  HelpProposalSchema,
  locateHelpSections,
  parseHelpArticle,
  ReleaseDocsPrepHelpInputSchema,
  type ReleaseDocsPrepHelpOutput,
} from '@aom/shared';
import { git } from './git.ts';
import { guideChangeItems } from './release-docs-prep-guide.ts';
import type { DocsPrepStepContext, DocsPrepStepHandler } from './release-docs-prep-steps.ts';

const LIST_MAX = 50;
const FILES_MAX = 200;
/** The check report is stored on the step row (the server caps it at REPORT_MAX_BYTES = 64 KB). */
const CHECK_REPORT_MAX_BYTES = 48 * 1024;

const empty = (status: 'passed' | 'failed'): ReleaseDocsPrepHelpOutput => ({
  status,
  changed: [],
  added: [],
  covered: [],
  skippedChanges: [],
  duplicates: 0,
  errors: [],
  warnings: [],
  notes: [],
});

const capOutput = (o: ReleaseDocsPrepHelpOutput): ReleaseDocsPrepHelpOutput => ({
  ...o,
  changed: o.changed.slice(0, LIST_MAX),
  added: o.added.slice(0, LIST_MAX),
  covered: o.covered.slice(0, LIST_MAX),
  skippedChanges: o.skippedChanges.slice(0, LIST_MAX),
  errors: o.errors.slice(0, LIST_MAX).map((e) => e.slice(0, 500)),
  warnings: o.warnings.slice(0, LIST_MAX).map((e) => e.slice(0, 500)),
  notes: o.notes.slice(0, LIST_MAX).map((e) => e.slice(0, 500)),
});

const fail = (error: string, o: Partial<ReleaseDocsPrepHelpOutput> = {}) => ({
  ok: false as const,
  error,
  output: capOutput({ ...empty('failed'), ...o, errors: [...(o.errors ?? []), error] }),
});

/** The Help articles of a folder (direct `*.md` children only), slug to content. */
export function readHelpArticles(wt: string, helpDir: string): Record<string, string> {
  const dir = join(wt, helpDir);
  const out: Record<string, string> = {};
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return out;
  for (const name of readdirSync(dir).sort()) {
    const m = /^([a-z0-9-]+)\.md$/.exec(name);
    if (!m) continue;
    const f = join(dir, name);
    if (statSync(f).isFile()) out[m[1] as string] = readFileSync(f, 'utf8');
  }
  return out;
}

/**
 * Applies a proposal's edits to the Help articles and checks the result with `checkHelpUpdate`. The one place the edits
 * are checked: the shift's `aom prep done` (so the writer can fix a refusal in the same shift) and the apply phase use it.
 */
export function tryHelpEdits(
  before: Record<string, string>,
  proposal: Pick<HelpProposal, 'edits'>,
  denyList: readonly string[] = [],
) {
  const applied = applyHelpEdits(before, proposal.edits);
  if (applied.kind === 'error') return { applied, errors: applied.errors, warnings: [] as string[] };
  if (applied.kind === 'unchanged') return { applied, errors: [] as string[], warnings: [] as string[] };
  const check = checkHelpUpdate(
    before,
    { ...before, ...applied.files },
    {
      changedRanges: applied.written,
      editedSections: applied.changed.length,
      addedSections: applied.added.length,
      denyList,
    },
  );
  return { applied, ...check };
}

/** A Help folder relative to the repository that stays inside it; null when it is absolute or climbs out. */
export function safeHelpDir(raw: string): string | null {
  const n = normalize(raw).replace(/\\/g, '/').replace(/\/+$/, '');
  if (!n || n === '.' || isAbsolute(n) || /^[A-Za-z]:/.test(n) || n.split('/').includes('..')) return null;
  return n;
}

/** The app that owns the Help folder (`apps/web/` for `apps/web/src/help/articles`). */
const appOf = (helpDir: string): string => {
  const i = helpDir.indexOf('/src/');
  return i > 0 ? `${helpDir.slice(0, i)}/` : `${helpDir}/`;
};

const NEWER_SERVER = 'this runner needs a newer server for Update Help articles: update the server';
const NO_HELP_NOTE = 'skipped: no Help articles in this repository';
const NOTHING_RELEVANT = 'no changed area is covered by a Help article';

function inputOf(ctx: DocsPrepStepContext) {
  const input = ReleaseDocsPrepHelpInputSchema.safeParse(ctx.payload.stepInput ?? {});
  if (!input.success)
    return { ok: false as const, error: 'the Help articles step got an invalid input from the server' };
  const helpDir = safeHelpDir(input.data.helpDir);
  if (!helpDir) return { ok: false as const, error: `refusing the Help folder ${input.data.helpDir}` };
  const abs = join(ctx.worktree, helpDir);
  if (existsSync(abs)) {
    // never leave the worktree, even through a symlink
    const real = realpathSync(abs);
    const root = realpathSync(ctx.worktree);
    if (real !== root && !real.startsWith(root + sep))
      return {
        ok: false as const,
        error: `refusing the Help folder ${helpDir}: it points outside the repository`,
      };
  }
  return { ok: true as const, input: input.data, helpDir };
}

const skippedNoHelp = () => ({
  ok: true as const,
  state: 'skipped' as const,
  note: NO_HELP_NOTE,
  files: [],
  output: { ...empty('passed'), skipped: 'no help articles' as const },
});

/** 'Update Help articles', phase `check`: are there Help articles, and which changes may need them updated? */
async function checkPhase(ctx: DocsPrepStepContext) {
  const g = inputOf(ctx);
  if (!g.ok) return fail(g.error);
  const { input, helpDir } = g;
  const files = readHelpArticles(ctx.worktree, helpDir);
  // The first phase decides that the step does not apply: no Help articles, no writer.
  if (Object.keys(files).length === 0) return skippedNoHelp();
  if (!ctx.summary)
    return fail('Update Help articles needs Analyse changes: tick it in the release prep settings');
  const pre = checkHelpUpdate(null, files, { denyList: input.denyList });
  if (pre.errors.length > 0)
    return fail(`the Help articles have problems before the update: ${pre.errors[0]}`, pre);

  const items = await guideChangeItems(ctx);
  const covered = new Set(input.coveredSources);
  const uncovered = items.filter((i) => i.sources.some((s) => !covered.has(s)));
  const docs = Object.fromEntries(Object.entries(files).map(([slug, md]) => [slug, parseHelpArticle(md)]));
  const app = appOf(helpDir);
  const relevant = uncovered
    .map((i) => ({ item: i, hints: locateHelpSections(docs, i).slice(0, 3) }))
    // a change with a matching section, or one in the app that shows the Help (a new feature may need a new section)
    .filter(({ item, hints }) => hints.length > 0 || item.files.some((f) => f.startsWith(app)));
  if (relevant.length === 0)
    return {
      ok: true as const,
      files: [],
      report: { changes: [] },
      output: { ...empty('passed'), nothing: uncovered.length ? NOTHING_RELEVANT : 'no new changes' },
    };
  const build = (filesCap: number): HelpChange[] =>
    relevant.map(({ item: i, hints }) => ({
      sources: i.sources.slice(0, 50),
      title: i.title.slice(0, 400),
      subjects: i.subjects.slice(0, 20).map((x) => x.slice(0, 400)),
      files: i.files.slice(0, filesCap).map((x) => x.slice(0, 400)),
      areas: i.areas.slice(0, 50).map((x) => x.slice(0, 200)),
      routes: i.routes.slice(0, 50).map((x) => x.slice(0, 200)),
      hints: hints.map((h) => ({
        article: h.article,
        section: h.section,
        score: h.score,
        why: h.why.slice(0, 300),
      })),
    }));
  // The report goes on the step row and into the writer's task: keep it under the cap by trimming the file lists first.
  let changes = build(FILES_MAX);
  for (const cap of [50, 10, 0]) {
    if (JSON.stringify(changes).length <= CHECK_REPORT_MAX_BYTES) break;
    changes = build(cap);
  }
  while (changes.length > 1 && JSON.stringify(changes).length > CHECK_REPORT_MAX_BYTES)
    changes = changes.slice(0, -1);
  return { ok: true as const, files: [], report: { helpDir, changes } };
}

/** Paths changed in the worktree (untracked files one by one). */
async function changedPaths(wt: string): Promise<string[]> {
  return (await git(wt, ['status', '--porcelain', '-uall'])).stdout
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    .map((p) => (p.includes(' -> ') ? (p.split(' -> ')[1] as string) : p));
}

/**
 * 'Update Help articles': `check` finds the Help articles and the changes that may need them updated (no articles:
 * skipped), the server has a writer agent propose section edits (a release prep task, checked at `aom prep done`), and
 * `apply` applies and checks them with the shared helpers. A refused update writes nothing. Edits files only; never commits.
 */
export const runHelpStep: DocsPrepStepHandler = async (ctx) => {
  if (ctx.phase === 'check') return checkPhase(ctx);
  if (ctx.phase !== 'apply') return fail(NEWER_SERVER);
  const g = inputOf(ctx);
  if (!g.ok) return fail(g.error);
  const { input, helpDir } = g;
  const before = readHelpArticles(ctx.worktree, helpDir);
  if (Object.keys(before).length === 0) return skippedNoHelp();
  const raw = ctx.input?.proposal;
  if (raw === undefined || raw === null)
    return { ok: true, files: [], output: { ...empty('passed'), nothing: 'no new changes' } };
  const parsed = HelpProposalSchema.safeParse(raw);
  if (!parsed.success)
    return fail(`the Help proposal is not valid: ${parsed.error.issues[0]?.message ?? ''}`);
  const proposal = parsed.data;
  const pre = checkHelpUpdate(null, before, { denyList: input.denyList });
  if (pre.errors.length > 0)
    return fail(`the Help articles have problems before the update: ${pre.errors[0]}`, pre);

  const result = tryHelpEdits(before, proposal, input.denyList);
  if (result.errors.length > 0)
    return fail(`the Help update was refused: ${result.errors[0]}`, {
      errors: result.errors,
      warnings: result.warnings,
    });
  const base: ReleaseDocsPrepHelpOutput = {
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
        nothing: 'no Help change needed',
      }),
    };

  const after = { ...before, ...a.files };
  const describe = (article: string, section: string) => {
    const doc = parseHelpArticle(after[article] ?? '');
    return {
      title: (doc.meta.title ?? article).slice(0, 200),
      heading: (doc.headings.find((h) => h.id === section)?.text ?? section).slice(0, 200),
    };
  };
  const sourcesFor = (pick: (e: HelpEdit) => boolean): string[] => [
    ...new Set(proposal.edits.filter(pick).flatMap((e) => e.sources)),
  ];
  const out: ReleaseDocsPrepHelpOutput = {
    ...base,
    duplicates: a.duplicates.length,
    changed: a.changed.map((c) => ({
      ...c,
      ...describe(c.article, c.section),
      sources: sourcesFor(
        (e) => e.op !== 'add_section' && e.article === c.article && e.section === c.section,
      ),
    })),
    added: a.added.map((x) => ({
      ...x,
      ...describe(x.article, x.section),
      sources: sourcesFor((e) => e.op === 'add_section' && e.article === x.article && e.id === x.section),
    })),
  };
  for (const [slug, md] of Object.entries(a.files))
    await writeFile(join(ctx.worktree, helpDir, `${slug}.md`), md, 'utf8');

  const allowed = new Set(Object.keys(a.files).map((slug) => `${helpDir}/${slug}.md`));
  const changed = await changedPaths(ctx.worktree);
  const outside = changed.filter((p) => !allowed.has(p));
  if (outside.length > 0)
    return fail(`the Help update changed files outside ${helpDir}: ${outside.join(', ')}`, out);
  return { ok: true, files: changed, output: capOutput(out) };
};
