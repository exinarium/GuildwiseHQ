import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import {
  ChangelogProposalSchema,
  checkGuideUpdate,
  filesOutsideWritable,
  GuideProposalSchema,
  PREP_PROPOSAL_FILE,
  type ReleasePrepShift,
} from '@aom/shared';
import { guideCheckContext, tryGuideEdits } from './release-docs-prep-guide.ts';
import { changedFiles, type PrepTaskWorktree } from './release-prep-task.ts';

/**
 * The runner's check of a proposal task (`changelog_entries`, `guide_edits`) at `aom prep done`: the shift may change
 * only the proposal file, which must parse against the kind's schema. For the guide the edits are applied to the guide in
 * the shift's worktree and checked with `checkGuideUpdate` (the same helpers as the apply phase), so the writer can fix a
 * refusal in the same shift. Nothing is committed here: the proposal travels to the server in the report.
 */
export type PrepProposalFinish = { ok: true; proposal: unknown } | { ok: false; findings: string[] };

const tooLong = (list: readonly string[], n = 20) => list.slice(0, n).map((x) => x.slice(0, 500));

export async function finishPrepProposal(
  wt: PrepTaskWorktree,
  rp: ReleasePrepShift,
): Promise<PrepProposalFinish> {
  const files = await changedFiles(wt);
  const outside = filesOutsideWritable(files, [PREP_PROPOSAL_FILE]);
  if (outside.length > 0)
    return {
      ok: false,
      findings: [`changed files outside the task: ${outside.slice(0, 20).join(', ')}. Change only ${PREP_PROPOSAL_FILE}.`],
    };
  const abs = join(wt.path, PREP_PROPOSAL_FILE);
  if (!files.includes(PREP_PROPOSAL_FILE) || !existsSync(abs))
    return { ok: false, findings: [`write your proposal as JSON in ${PREP_PROPOSAL_FILE} first`] };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(abs, 'utf8'));
  } catch {
    return { ok: false, findings: [`${PREP_PROPOSAL_FILE} is not valid JSON`] };
  }
  const task = rp.task;
  if (task.kind === 'changelog_entries') {
    const p = ChangelogProposalSchema.safeParse(raw);
    if (!p.success)
      return {
        ok: false,
        findings: tooLong(p.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)),
      };
    return { ok: true, proposal: p.data };
  }
  if (task.kind !== 'guide_edits') return { ok: false, findings: ['this task has no proposal'] };
  const p = GuideProposalSchema.safeParse(raw);
  if (!p.success)
    return {
      ok: false,
      findings: tooLong(p.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)),
    };
  const guidePath = normalize(task.guidePath);
  if (isAbsolute(guidePath) || guidePath.startsWith('..'))
    return { ok: false, findings: [`refusing the guide path ${guidePath}`] };
  const guideAbs = join(wt.path, guidePath);
  if (!existsSync(guideAbs) || !statSync(guideAbs).isFile())
    return { ok: false, findings: [`the guide ${guidePath} is not in the release work`] };
  const before = await readFile(guideAbs, 'utf8');
  const ctx = guideCheckContext(wt.path, guidePath, []);
  const pre = checkGuideUpdate(null, before, ctx);
  if (pre.errors.length > 0)
    return { ok: false, findings: tooLong([`the user guide has problems before the update: ${pre.errors[0]}`]) };
  const tried = tryGuideEdits(before, p.data, ctx);
  if (tried.errors.length > 0) return { ok: false, findings: tooLong(tried.errors) };
  return { ok: true, proposal: p.data };
}
