import { OrgFolderResultSchema, OrgFoldersReportSchema, type SetOrgFolderRequest } from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { exec, one } from '../db/sql.ts';
import { forbidden, notFound } from '../errors.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';

/**
 * Organisation source folder (docs/RUNNER.md "Organisation source folder"). The owner of a workstation asks its runner
 * to set or clear the folder the architect of one organisation may read; the runner validates (the same check as
 * `aom-runner org-folder set`), writes its own config.json and reports the outcome. The server only queues the request
 * and stores what the runner says: it never decides whether a path is acceptable.
 */

/** `org.folders` from the runner: stored as is (validated). A refused "set" keeps its reason until the next success. */
export async function applyOrgFoldersReport(ctx: Ctx, workstationId: string, report: unknown): Promise<void> {
  const parsed = OrgFoldersReportSchema.pick({ folders: true, candidates: true }).safeParse(report);
  if (!parsed.success) return;
  await exec(
    ctx.pool,
    `UPDATE workstations SET org_folders=$2::jsonb, org_folder_candidates=$3::jsonb, org_folders_checked_at=$4 WHERE id=$1`,
    [
      workstationId,
      JSON.stringify(parsed.data.folders),
      JSON.stringify(parsed.data.candidates),
      ctx.clock.now(),
    ],
  );
}

/** The runner's answer to `org.folder`: a refusal is remembered (per organisation) for the page; a success forgets it. */
export async function applyOrgFolderResult(
  ctx: Ctx,
  workstationId: string,
  payload: Record<string, unknown>,
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  const orgId = typeof payload.orgId === 'string' ? payload.orgId.toLowerCase() : '';
  if (!orgId) return;
  const parsed = OrgFolderResultSchema.safeParse(result);
  const refused = !ok || !parsed.success || !parsed.data.ok;
  if (!refused) {
    await exec(
      ctx.pool,
      `UPDATE workstations SET org_folder_errors = org_folder_errors - $2::text WHERE id=$1`,
      [workstationId, orgId],
    );
    return;
  }
  const reason = (
    (parsed.success ? parsed.data.error : undefined) ??
    error ??
    'The runner could not apply the folder.'
  ).slice(0, 600);
  await exec(
    ctx.pool,
    `UPDATE workstations SET org_folder_errors = org_folder_errors || jsonb_build_object($2::text, $3::text) WHERE id=$1`,
    [workstationId, orgId, reason],
  );
}

/** Queues `org.folder` for (workstation, organisation): the workstation's owner, a member of the organisation. */
export async function requestOrgFolder(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
  body: SetOrgFolderRequest,
): Promise<void> {
  const w = await one(
    ctx.pool,
    `SELECT id FROM workstations WHERE id=$1 AND user_id=$2 AND status='active'`,
    [workstationId, user.id],
  );
  if (!w) throw notFound('workstation not found');
  const orgId = body.orgId.toLowerCase();
  const m = await one(
    ctx.pool,
    `SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active'`,
    [orgId, user.id],
  );
  if (!m) throw forbidden('you are not a member of this organization');
  await enqueueRunnerCommand(ctx.pool, workstationId, 'org.folder', { orgId, path: body.path });
  void Promise.resolve(ctx.services.gateway.deliverPending(workstationId)).catch(() => undefined);
}
