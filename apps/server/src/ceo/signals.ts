import { randomUUID } from 'node:crypto';
import { countRepeats, streamId, suggestForRepeat } from '@aom/shared';
import { orgScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { one, type Queryable, rows } from '../db/sql.ts';
import type { AppendInput } from '../eventstore/types.ts';

/**
 * Repeat detection for the off-system job log (docs/design/ceo-front-door.md section 4.3, with the owner's thresholds of
 * section 14.5): the same kind of job 4 or more times in 7 days, or 10 or more times in 30 days. Deterministic: no model
 * clusters anything. A dismissed repeat hides its key for 90 days; an accepted one only counts jobs logged after it.
 */
export async function repeatEvents(
  db: Queryable,
  orgId: string,
  kind: string,
  now: Date,
): Promise<AppendInput[]> {
  if (kind === 'unlabelled') return [];
  const open = await one(db, `SELECT 1 FROM ceo_repeats WHERE org_id=$1 AND key=$2 AND status='open'`, [
    orgId,
    kind,
  ]);
  if (open) return [];
  const last = await one(
    db,
    `SELECT decision, resolved_at, suppressed_until FROM ceo_repeats
      WHERE org_id=$1 AND key=$2 AND status='resolved' ORDER BY resolved_at DESC LIMIT 1`,
    [orgId, kind],
  );
  if (last?.decision === 'dismissed' && last.suppressed_until && new Date(last.suppressed_until) > now)
    return [];
  const baseline = last && last.decision !== 'dismissed' ? new Date(last.resolved_at) : null;
  const jobs = await rows(
    db,
    `SELECT id, created_at, project_id, first_token FROM ceo_offboard_jobs
      WHERE org_id=$1 AND kind=$2 AND created_at > $3 AND ($4::timestamptz IS NULL OR created_at > $4)
      ORDER BY created_at`,
    [orgId, kind, new Date(now.getTime() - 30 * 86_400_000), baseline],
  );
  const counted = countRepeats(
    jobs.map((j) => new Date(j.created_at)),
    now,
  );
  if (!counted.hit) return [];
  const projectId = jobs.find((j) => j.project_id)?.project_id as string | undefined;
  return [
    {
      streamId: streamId.ceo(orgId),
      event: {
        type: 'CeoRepeatDetected',
        payload: {
          repeatId: randomUUID(),
          orgId,
          key: kind,
          jobIds: jobs.slice(-100).map((j) => j.id),
          suggestion: suggestForRepeat({
            hasProject: !!projectId,
            firstTokens: jobs.map((j) => String(j.first_token ?? '')),
          }),
          count7: counted.count7,
          count30: counted.count30,
          ...(projectId ? { projectId } : {}),
        },
      },
      actor: SYSTEM_ACTOR,
      scope: orgScope(orgId),
    },
  ];
}

/** Re-checks every kind that has recent jobs (the daily report runs it, so a repeat is never missed). */
export async function detectRepeats(db: Queryable, orgId: string, now: Date): Promise<AppendInput[]> {
  const kinds = await rows(
    db,
    `SELECT DISTINCT kind FROM ceo_offboard_jobs WHERE org_id=$1 AND created_at > $2 AND kind <> 'unlabelled'`,
    [orgId, new Date(now.getTime() - 30 * 86_400_000)],
  );
  const out: AppendInput[] = [];
  for (const k of kinds) out.push(...(await repeatEvents(db, orgId, k.kind, now)));
  return out;
}
