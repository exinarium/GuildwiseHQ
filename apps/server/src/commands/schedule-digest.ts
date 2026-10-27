import {
  type DigestKind,
  localParts,
  renderFloorReportFallback,
  renderInterestHighlights,
} from '@aom/shared';
import { buildFloorDigest, interestsDigest } from '../ceo/digest.ts';
import { reportingOf } from '../ceo/prefs.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, rows } from '../db/sql.ts';
import { badRequest } from '../errors.ts';

export interface DigestArgs {
  orgId: string;
  projectId: string | null;
  now: Date;
}
export interface DigestText {
  subject: string;
  text: string;
}
export type DigestBuilder = (ctx: Ctx, db: Queryable, args: DigestArgs) => Promise<DigestText>;

/** The organization report as the server's template renders it (the BA's own report stays on the desk). */
const floorReport: DigestBuilder = async (_ctx, db, a) => {
  const prefs = await reportingOf(db, a.orgId);
  const digest = await buildFloorDigest(db, a.orgId, a.now, localParts(a.now, prefs.timezone).date);
  return { subject: `Organization report ${digest.localDate}`, text: renderFloorReportFallback(digest) };
};

/** Cards by stage, what finished this week, open desk items and phases of one project. */
const projectSummary: DigestBuilder = async (_ctx, db, a) => {
  if (!a.projectId) throw badRequest('project_required', 'a project summary needs a project');
  const p = await one(db, 'SELECT key, name FROM projects WHERE id=$1', [a.projectId]);
  if (!p) throw badRequest('project_missing', 'the project is gone');
  const byStage = await rows<{ stage: string; status: string; n: number }>(
    db,
    `SELECT stage, status, count(*)::int AS n FROM cards
      WHERE project_id=$1 AND status NOT IN ('done','cancelled') GROUP BY stage, status ORDER BY stage, status`,
    [a.projectId],
  );
  const since = new Date(a.now.getTime() - 7 * 86_400_000);
  const done = await rows<{ ref: string; title: string }>(
    db,
    `SELECT ref, title FROM cards WHERE project_id=$1 AND status='done' AND updated_at >= $2
      ORDER BY updated_at DESC LIMIT 10`,
    [a.projectId, since],
  );
  const desk = await one<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM desk_items WHERE project_id=$1 AND status='open'`,
    [a.projectId],
  );
  const phases = await rows<{ ref: string; name: string; status: string }>(
    db,
    `SELECT ref, name, status FROM phases WHERE project_id=$1
        AND status NOT IN ('proposed','done','done_with_failures','followups_rejected','discarded','cancelled')
      ORDER BY created_at`,
    [a.projectId],
  );
  const lines = [
    `# ${p.key} ${p.name}`,
    '',
    '## Open work',
    ...(byStage.length ? byStage.map((r) => `- ${r.stage} (${r.status}): ${r.n}`) : ['- none']),
    '',
    '## Finished in the last 7 days',
    ...(done.length ? done.map((c) => `- ${c.ref} ${c.title}`) : ['- none']),
    '',
    '## Phases in progress',
    ...(phases.length ? phases.map((x) => `- ${x.ref} ${x.name}: ${x.status}`) : ['- none']),
    '',
    `Open desk items: ${desk?.n ?? 0}`,
  ];
  return { subject: `${p.key} summary`, text: lines.join('\n') };
};

/** What the interests delivered to the desk in the last 24 hours: the top items of each interest (decision 16). */
const interestsDigestBuilder: DigestBuilder = async (_ctx, db, a) => {
  const d = await interestsDigest(db, a.orgId, new Date(a.now.getTime() - 86_400_000));
  const day = localParts(a.now, (await reportingOf(db, a.orgId)).timezone ?? 'UTC').date;
  const lines = [`# Interests ${day}`, '', ...renderInterestHighlights(d)];
  if (d.failing.length)
    lines.push('', '## Cannot run', ...d.failing.map((f) => `- ${f.interest}: ${f.error ?? 'failing'}`));
  return { subject: `Interests digest ${day}`, text: lines.join('\n') };
};

const builders: Partial<Record<DigestKind, DigestBuilder>> = {
  floor_report: floorReport,
  project_summary: projectSummary,
  interests: interestsDigestBuilder,
};

/** Extra digest kinds register themselves here (the interests digest is built in). */
export function registerDigest(kind: DigestKind, builder: DigestBuilder): void {
  builders[kind] = builder;
}

export const digestAvailable = (kind: DigestKind): boolean => kind in builders;

export async function buildDigest(
  ctx: Ctx,
  db: Queryable,
  kind: DigestKind,
  args: DigestArgs,
): Promise<DigestText> {
  const b = builders[kind];
  if (!b) throw badRequest('digest_unavailable', `the ${kind} digest is not available yet`);
  return b(ctx, db, args);
}
