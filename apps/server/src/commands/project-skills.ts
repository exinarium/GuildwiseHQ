import {
  isOrgManager,
  type ProjectSkillDto,
  type ProjectSkillsResponse,
  type ReviewProjectSkillRequest,
  streamId,
} from '@aom/shared';
import type { Who } from '../auth/org-context.ts';
import type { Ctx } from '../context.ts';
import { iso, one, rows } from '../db/sql.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import { orgScope, userActor } from './common.ts';
import { syncOrg } from './packs.ts';

/**
 * Review list of the capabilities a project's own repository carries (docs/ARCHITECTURE.md section 38.7). A repository is
 * code the organization does not control as tightly as its vault, so an Owner or Admin can see what was found (repository,
 * path, content hash), mark it reviewed (at that hash) or block it. A blocked capability is unusable: the registry marks it
 * and the runners leave it out. Unreviewed ones stay usable (a review is a record, not a gate), as before.
 */
const requireManager = (who: Who): void => {
  if (!isOrgManager({ orgRole: who.role }))
    throw forbidden('only owners and admins review project repository capabilities');
};

export async function listProjectSkills(ctx: Ctx, who: Who): Promise<ProjectSkillsResponse> {
  requireManager(who);
  const r = await rows(
    ctx.pool,
    `SELECT i.project_id, i.kind, i.key, i.name, i.description, i.hash, i.path, i.reported_at,
            p.key AS project_key, p.name AS project_name,
            cr.status AS review_status, cr.hash AS review_hash, cr.reviewed_at, u.display_name AS reviewed_by,
            (SELECT r.name FROM project_repos r WHERE r.project_id = i.project_id AND r.removed_at IS NULL
              ORDER BY r.name LIMIT 1) AS repo
       FROM project_capability_index i
       JOIN projects p ON p.id = i.project_id AND p.org_id = $1
       LEFT JOIN capability_reviews cr ON cr.project_id = i.project_id AND cr.kind = i.kind AND cr.key = i.key
       LEFT JOIN users u ON u.id = cr.reviewed_by
      WHERE i.org_id = $1
      ORDER BY p.key, i.kind, i.key`,
    [who.orgId],
  );
  const items: ProjectSkillDto[] = r.map((x) => ({
    projectId: x.project_id,
    projectKey: x.project_key,
    projectName: x.project_name,
    kind: x.kind,
    key: x.key,
    name: x.name,
    description: x.description,
    hash: x.hash,
    repo: x.repo ?? null,
    path: x.path ?? null,
    status:
      x.review_status === 'blocked'
        ? 'blocked'
        : x.review_status === 'reviewed'
          ? x.review_hash === x.hash
            ? 'reviewed'
            : 'changed'
          : 'unreviewed',
    reviewedHash: x.review_hash ?? null,
    reviewedBy: x.reviewed_by ?? null,
    reviewedAt: iso(x.reviewed_at),
    indexedAt: iso(x.reported_at) as string,
  }));
  return { items };
}

export async function reviewProjectSkill(
  ctx: Ctx,
  who: Who,
  req: ReviewProjectSkillRequest,
): Promise<ProjectSkillsResponse> {
  requireManager(who);
  const cur = await one(
    ctx.pool,
    `SELECT hash FROM project_capability_index WHERE org_id=$1 AND project_id=$2 AND kind=$3 AND key=$4`,
    [who.orgId, req.projectId, req.kind, req.key],
  );
  if (!cur) throw notFound('capability not found');
  // the owner approves exactly what they looked at; blocking and clearing do not depend on it
  if (req.status === 'reviewed' && cur.hash !== req.hash)
    throw conflict('changed', 'The file changed since you looked at it: open the list again.');
  await ctx.store.append([
    {
      streamId: streamId.projectCapabilities(req.projectId),
      event: {
        type: 'ProjectCapabilityReviewed',
        payload: {
          orgId: who.orgId,
          projectId: req.projectId,
          kind: req.kind,
          key: req.key,
          hash: cur.hash,
          status: req.status,
          by: who.userId,
        },
      },
      actor: userActor(who.userId),
      scope: orgScope(who.orgId),
    },
  ]);
  // the runners hear about a block (or its removal) now
  await syncOrg(ctx, who.orgId);
  return listProjectSkills(ctx, who);
}
