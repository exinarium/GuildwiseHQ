import { randomUUID } from 'node:crypto';
import {
  type CreateOrgGraphLinkRequest,
  type GraphOrgPayload,
  isOrgManager,
  type OrgGraphLinkDto,
  type OrgGraphScope,
  type OrgLinkEndpoint,
  type OrgRole,
  projectVaultFolder,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, type Queryable, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { orgScope, userActor } from './common.ts';
import { ensureOrgVaultIn, graphVaultFor, primaryWorkstationOf, vaultAudience } from './vaults.ts';

/**
 * The organization graph, server side (docs/design/project-graphs.md section 8). The graph itself is built on the CEO's
 * workstation from the project graphs and kept in the organization vault; the links derived from code never reach the
 * server. The server keeps only what the Owner asserted (project ids and names they typed) and tells the workstation what
 * to build from: projects (ids, keys, names, whether they are retired), where each project's graph is, and the assertions.
 */

const endpoint = (e: OrgLinkEndpoint): { projectId: string | null; name: string | null } =>
  'projectId' in e ? { projectId: e.projectId, name: null } : { projectId: null, name: e.name.trim() };

function endpointsEqual(a: OrgLinkEndpoint, b: OrgLinkEndpoint): boolean {
  const x = endpoint(a);
  const y = endpoint(b);
  return x.projectId !== null ? x.projectId === y.projectId : x.name?.toLowerCase() === y.name?.toLowerCase();
}

export async function listOrgLinks(ctx: Ctx, orgId: string): Promise<OrgGraphLinkDto[]> {
  const list = await rows(
    ctx.pool,
    `SELECT l.*, fp.key AS from_key, tp.key AS to_key
       FROM org_graph_links l
       LEFT JOIN projects fp ON fp.id = l.from_project_id
       LEFT JOIN projects tp ON tp.id = l.to_project_id
      WHERE l.org_id = $1 AND l.retracted_at IS NULL ORDER BY l.asserted_at, l.link_id`,
    [orgId],
  );
  return list.map((l) => ({
    id: l.link_id,
    from: { projectId: l.from_project_id ?? null, label: l.from_key ?? l.from_name ?? '' },
    to: { projectId: l.to_project_id ?? null, label: l.to_key ?? l.to_name ?? '' },
    kind: l.kind,
    note: l.note ?? null,
    origin: l.origin,
    assertedAt: iso(l.asserted_at) as string,
  }));
}

/** The Owner or an Admin asserts a link (project ids, or names they typed). Appends one event and has the graph rebuilt. */
export async function assertOrgLink(
  ctx: Ctx,
  user: AuthSession['user'],
  org: { id: string; role: OrgRole | null },
  req: CreateOrgGraphLinkRequest & { origin?: 'owner' | 'accepted-draft' },
): Promise<string> {
  if (!isOrgManager({ orgRole: org.role }))
    throw forbidden('only the organization Owner and Admins can assert links between projects');
  if (endpointsEqual(req.from, req.to)) throw badRequest('same_endpoint', 'a link needs two different ends');
  const linkId = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    for (const e of [req.from, req.to]) {
      if (!('projectId' in e)) continue;
      const p = await one(tx, `SELECT 1 FROM projects WHERE id=$1 AND org_id=$2 AND kind='project'`, [
        e.projectId,
        org.id,
      ]);
      if (!p) throw notFound('project not found');
    }
    // the same link twice is one link
    const dup = await one(
      tx,
      `SELECT link_id FROM org_graph_links WHERE org_id=$1 AND retracted_at IS NULL AND kind=$2
          AND from_project_id IS NOT DISTINCT FROM $3::uuid AND lower(COALESCE(from_name,'')) = lower($4)
          AND to_project_id IS NOT DISTINCT FROM $5::uuid AND lower(COALESCE(to_name,'')) = lower($6)`,
      [
        org.id,
        req.kind,
        endpoint(req.from).projectId,
        endpoint(req.from).name ?? '',
        endpoint(req.to).projectId,
        endpoint(req.to).name ?? '',
      ],
    );
    if (dup) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.org(org.id),
          event: {
            type: 'OrgGraphLinkAsserted',
            payload: {
              linkId,
              orgId: org.id,
              from: req.from,
              to: req.to,
              kind: req.kind,
              ...(req.note ? { note: req.note } : {}),
              origin: req.origin ?? 'owner',
              by: user.id,
            },
          },
          actor: userActor(user.id),
          scope: orgScope(org.id),
        },
      ],
      { tx },
    );
  });
  return linkId;
}

export async function retractOrgLink(
  ctx: Ctx,
  user: AuthSession['user'],
  org: { id: string; role: OrgRole | null },
  linkId: string,
): Promise<void> {
  if (!isOrgManager({ orgRole: org.role }))
    throw forbidden('only the organization Owner and Admins can retract links between projects');
  await withAppendTx(ctx.pool, async (tx) => {
    const l = await one(
      tx,
      'SELECT 1 FROM org_graph_links WHERE link_id=$1 AND org_id=$2 AND retracted_at IS NULL',
      [linkId, org.id],
    );
    if (!l) throw notFound('link not found');
    await ctx.store.append(
      [
        {
          streamId: streamId.org(org.id),
          event: { type: 'OrgGraphLinkRetracted', payload: { linkId, orgId: org.id, by: user.id } },
          actor: userActor(user.id),
          scope: orgScope(org.id),
        },
      ],
      { tx },
    );
  });
}

// ------------------------------------------------------------------------------------------ the build request

/** What the workstation builds the organization graph from. Ids, keys, names and the places of the project graphs. */
export async function orgGraphPayload(
  db: Queryable,
  orgId: string,
  vault: { id: string; storage: 'git' | 'local' },
): Promise<GraphOrgPayload> {
  const projects = await rows(
    db,
    `SELECT p.id, p.key, p.name, p.status, p.vault_folder, p.vault_dir,
            EXISTS (SELECT 1 FROM project_graphs g WHERE g.project_id = p.id AND g.status = 'indexed') AS indexed
       FROM projects p WHERE p.org_id = $1 AND p.kind = 'project' ORDER BY p.key, p.id`,
    [orgId],
  );
  const out: GraphOrgPayload['projects'] = [];
  for (const p of projects) {
    const gv = p.indexed ? await graphVaultFor(db, p.id) : null;
    out.push({
      projectId: p.id,
      key: p.key,
      name: p.name,
      retired: p.status !== 'active',
      ...(gv
        ? {
            graph: {
              vaultId: gv.id,
              folder: projectVaultFolder({ key: p.key, vaultFolder: p.vault_folder, vaultDir: p.vault_dir }),
            },
          }
        : {}),
    });
  }
  const links = await rows(
    db,
    `SELECT * FROM org_graph_links WHERE org_id=$1 AND retracted_at IS NULL ORDER BY asserted_at, link_id LIMIT 2000`,
    [orgId],
  );
  return {
    orgId,
    vault: { vaultId: vault.id, storage: vault.storage },
    projects: out,
    assertions: links.map((l) => ({
      linkId: l.link_id,
      from: l.from_project_id ? { projectId: l.from_project_id } : { name: l.from_name },
      to: l.to_project_id ? { projectId: l.to_project_id } : { name: l.to_name },
      kind: l.kind,
      ...(l.note ? { note: l.note } : {}),
    })),
  };
}

/** A graph.org command that was sent less than this long ago is taken to be running. */
const RUNNING_MS = 5 * 60_000;

/**
 * Asks the workstation that holds the organization vault to rebuild the organization graph (a project was indexed, a
 * link was asserted or retracted, a project was archived). One request waits at a time. Registers the organization's
 * vault (a local folder on the Owner's primary workstation) when it has none. Returns whether a command was queued or is
 * already waiting.
 */
export async function dispatchOrgGraph(ctx: Ctx, orgId: string): Promise<boolean> {
  if (!ctx.config.projectGraphs.enabled) return false;
  await withAppendTx(ctx.pool, (tx) => ensureOrgVaultIn(ctx, tx, orgId));
  const v = await one(
    ctx.pool,
    `SELECT id, org_id, project_id, storage, local_workstation_id FROM vaults WHERE org_id=$1 AND kind='org' AND project_id IS NULL`,
    [orgId],
  );
  if (!v) return false;
  let workstationId: string | null;
  if (v.storage === 'local') workstationId = v.local_workstation_id ?? null;
  else {
    // a repository vault: the Owner's primary workstation, or any Owner or Admin workstation that is online
    const audience = await vaultAudience(ctx.pool, v as never);
    const r = await one<{ id: string }>(
      ctx.pool,
      `SELECT w.id FROM workstations w WHERE w.user_id = ANY($1::uuid[]) AND w.status='active'
        ORDER BY (w.id = $2::uuid) DESC, w.connected DESC, w.last_seen_at DESC NULLS LAST, w.paired_at LIMIT 1`,
      [audience, await primaryWorkstationOf(ctx.pool, orgId)],
    );
    workstationId = r?.id ?? null;
  }
  if (!workstationId) return false;
  // One build runs at a time. A request that arrives meanwhile marks the running one dirty (it builds again when it is
  // done, from the state of that moment), so a burst of indexed projects is two builds, not one per project.
  const running = await one<{ id: string }>(
    ctx.pool,
    `SELECT id FROM runner_commands WHERE type='graph.org' AND status='sent' AND workstation_id=$1
        AND payload->>'orgId' = $2 AND sent_at > $3 ORDER BY sent_at DESC LIMIT 1`,
    [workstationId, orgId, new Date(ctx.clock.now().getTime() - RUNNING_MS)],
  );
  if (running) {
    await exec(
      ctx.pool,
      `UPDATE runner_commands SET payload = payload || '{"dirty": true}'::jsonb WHERE id=$1`,
      [running.id],
    );
    return true;
  }
  const payload = await orgGraphPayload(ctx.pool, orgId, { id: v.id, storage: v.storage });
  // A request that has not been sent yet is brought up to date (it would build from stale links).
  const waiting = await one<{ id: string }>(
    ctx.pool,
    `SELECT id FROM runner_commands WHERE type='graph.org' AND status='pending' AND workstation_id=$1
        AND payload->>'orgId' = $2 ORDER BY created_at DESC LIMIT 1`,
    [workstationId, orgId],
  );
  if (waiting) {
    await exec(ctx.pool, 'UPDATE runner_commands SET payload=$2 WHERE id=$1', [
      waiting.id,
      JSON.stringify(payload),
    ]);
    return true;
  }
  await enqueueRunnerCommand(
    ctx.pool,
    workstationId,
    'graph.org',
    payload as unknown as Record<string, unknown>,
  );
  void Promise.resolve(ctx.services.gateway.deliverPending(workstationId)).catch(() => undefined);
  return true;
}

/** Where the CEO's shift or chat finds the organization graph: the organization vault. Undefined: graphs off or no vault. */
export async function orgGraphScopeFor(ctx: Ctx, orgId: string): Promise<OrgGraphScope | undefined> {
  if (!ctx.config.projectGraphs.enabled) return undefined;
  const v = await one(
    ctx.pool,
    `SELECT id FROM vaults WHERE org_id=$1 AND kind='org' AND project_id IS NULL`,
    [orgId],
  );
  return v ? { vaultId: v.id } : undefined;
}
