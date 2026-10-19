import { randomUUID } from 'node:crypto';
import { type CeoRepeatDto, type CeoRpc, normalizeJobKind, streamId } from '@aom/shared';
import { agentActor, orgScope } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, type Row, rows } from '../db/sql.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { repeatEvents } from './signals.ts';

type JobRpc = Extract<CeoRpc, { op: 'job' }>;

/** The first word of the command the job was done with: repeated jobs with the same one suggest an automation. */
const firstTokenOf = (command: string | undefined): string | undefined =>
  command?.trim().split(/\s+/)[0]?.slice(0, 60) || undefined;

/**
 * `aom ceo job start|log|repeats` (docs/design/ceo-front-door.md section 4.2). `start` only opens the guard hook on the runner
 * (and remembers the kind); `log` writes the off-board job and re-checks the repeat rule for its kind.
 */
export async function jobOp(
  ctx: Ctx,
  turn: Row | undefined,
  agentId: string,
  orgId: string,
  rpc: JobRpc,
): Promise<{ status: 'executed' | 'refused'; message: string; text?: string }> {
  if (rpc.sub === 'repeats') {
    const list = await listOpenRepeats(ctx.pool, orgId);
    return {
      status: 'executed',
      message: list.length ? 'Repeats waiting for the owner' : 'No repeats right now.',
      text: list.length
        ? list
            .map(
              (r) =>
                `${r.key}: ${r.count7} in 7 days, ${r.count30} in 30 (suggest a ${r.suggestion}) jobs: ${r.jobs.map((j) => j.title).join('; ')}`,
            )
            .join('\n')
        : 'No repeats right now.',
    };
  }
  if (!turn) return { status: 'refused', message: 'the job log belongs to an owner or order turn' };
  if (rpc.sub === 'start') {
    const kind = normalizeJobKind(rpc.kind ?? 'direct-edit');
    await exec(
      ctx.pool,
      `INSERT INTO ceo_flags (org_id, flag, value, at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (org_id, flag) DO UPDATE SET value=EXCLUDED.value, at=EXCLUDED.at`,
      [orgId, `jobstart:${turn.id}`, `${kind}|${(rpc.why ?? '').slice(0, 300)}`, ctx.clock.now()],
    );
    return {
      status: 'executed',
      message: `Job started (${kind}): edits in project clones pass for the rest of this turn.`,
    };
  }
  // log
  const started = await one(ctx.pool, 'SELECT value FROM ceo_flags WHERE org_id=$1 AND flag=$2', [
    orgId,
    `jobstart:${turn.id}`,
  ]);
  const kind = normalizeJobKind(rpc.kind ?? started?.value?.split('|')[0] ?? 'unlabelled');
  const title = (rpc.title ?? started?.value?.split('|')[1] ?? kind).trim().slice(0, 200) || kind;
  let projectId: string | undefined;
  if (rpc.project) {
    const p = await one(ctx.pool, 'SELECT id FROM projects WHERE org_id=$1 AND key=upper($2)', [
      orgId,
      rpc.project,
    ]);
    if (!p) return { status: 'refused', message: `project ${rpc.project.toUpperCase()} not found` };
    projectId = p.id;
  }
  const now = ctx.clock.now();
  const events: AppendInput[] = [
    {
      streamId: streamId.ceo(orgId),
      event: {
        type: 'CeoOffboardJobLogged',
        payload: {
          jobId: randomUUID(),
          orgId,
          turnId: turn.id,
          kind,
          title,
          summary: (rpc.summary ?? '').slice(0, 2000),
          ...(projectId ? { projectId } : {}),
          costMicros: 0,
          durationMs: turn.started_at ? Math.max(0, now.getTime() - new Date(turn.started_at).getTime()) : 0,
          auto: false,
          ...(firstTokenOf(rpc.command) ? { firstToken: firstTokenOf(rpc.command) } : {}),
        },
      },
      actor: agentActor(agentId),
      scope: orgScope(orgId),
    },
  ];
  await ctx.store.append(events);
  // The repeat rule counts the job just written (it is in the projection now).
  const rep = await repeatEvents(ctx.pool, orgId, kind, ctx.clock.now());
  if (rep.length) await ctx.store.append(rep);
  return {
    status: 'executed',
    message: rep.length
      ? `Logged (${kind}). This is a repeat: the owner has asked for this kind of job often enough that the daily report will propose a feature, a skill or an automation.`
      : `Logged (${kind}).`,
  };
}

export async function listOpenRepeats(db: Queryable, orgId: string): Promise<CeoRepeatDto[]> {
  const list = await rows(
    db,
    `SELECT r.*, p.key AS project_key FROM ceo_repeats r LEFT JOIN projects p ON p.id = r.project_id
      WHERE r.org_id=$1 AND r.status='open' ORDER BY r.detected_at DESC LIMIT 20`,
    [orgId],
  );
  const out: CeoRepeatDto[] = [];
  for (const r of list) {
    const jobs = await rows(
      db,
      `SELECT id, title, created_at FROM ceo_offboard_jobs WHERE id = ANY($1::uuid[]) ORDER BY created_at DESC LIMIT 8`,
      [r.job_ids],
    );
    out.push({
      id: r.id,
      key: r.key,
      suggestion: r.suggestion,
      count7: r.count7,
      count30: r.count30,
      projectKey: r.project_key ?? null,
      jobs: jobs.map((j) => ({ id: j.id, title: j.title, at: new Date(j.created_at).toISOString() })),
      detectedAt: new Date(r.detected_at).toISOString(),
    });
  }
  return out;
}
