import { randomUUID } from 'node:crypto';
import {
  isOrgManager,
  type OrgRole,
  type PatchVaultRequest,
  projectVaultFolder,
  type RegisterVaultRequest,
  streamId,
  type VaultConfig,
  type VaultConfigureCommand,
  type VaultDto,
  type VaultWriteCommand,
} from '@aom/shared';
import { orgRoleOf, type Who } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { closeDeskItemIn, raiseDeskItem } from '../desk-port.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { assertRemoteUrl, orgScope, projectScope, userActor, userScope } from './common.ts';

const vaultScope = (v: Row) => (v.project_id ? projectScope(v.org_id, v.project_id) : orgScope(v.org_id));

// ------------------------------------------------------------------------------------------ queries

/**
 * Vaults the user may see: the organization-level vaults of the request organization (its Owner and Admins only: they
 * sync to their workstations only, owner decision 12) and the vaults of projects they are an active member of.
 */
export async function listVaults(ctx: Ctx, who: Who): Promise<VaultDto[]> {
  const vs = await rows(
    ctx.pool,
    `SELECT v.*, EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = v.org_id AND om.user_id = $1
                          AND om.status = 'active' AND om.role IN ('owner','admin')) AS can_edit
       FROM vaults v
      WHERE (v.project_id IS NULL AND v.org_id = $2 AND $3::boolean)
         OR v.project_id IN (SELECT project_id FROM project_members WHERE user_id = $1 AND status = 'active')
      ORDER BY (v.project_id IS NOT NULL), v.kind, v.created_at`,
    [who.userId, who.orgId, isOrgManager({ orgRole: who.role })],
  );
  const ws = await rows(
    ctx.pool,
    `SELECT id, name FROM workstations WHERE user_id=$1 AND status='active' ORDER BY paired_at`,
    [who.userId],
  );
  const status = await rows(
    ctx.pool,
    `SELECT wv.* FROM workstation_vaults wv WHERE wv.workstation_id = ANY($1::uuid[]) AND wv.vault_id = ANY($2::uuid[])`,
    [ws.map((w) => w.id), vs.map((v) => v.id)],
  );
  return vs.map((v) => ({
    id: v.id,
    orgId: v.org_id,
    projectId: v.project_id,
    kind: v.kind,
    name: v.name,
    remoteUrl: v.remote_url,
    syncIntervalSec: v.sync_interval_sec,
    createdAt: iso(v.created_at) as string,
    canEdit: v.can_edit,
    workstations: ws.map((w) => {
      const s = status.find((x) => x.vault_id === v.id && x.workstation_id === w.id);
      return {
        workstationId: w.id,
        workstationName: w.name,
        localPath: s?.local_path ?? null,
        lastPullAt: iso(s?.last_pull_at),
        lastPushAt: iso(s?.last_push_at),
        lastError: s?.last_error ?? null,
        paused: s?.paused ?? false,
        conflictFiles: s?.conflict_files ?? [],
      };
    }),
  }));
}

// -------------------------------------------------------------------------------------- commands

export async function registerVault(
  ctx: Ctx,
  user: AuthSession['user'],
  org: { id: string; role: OrgRole | null },
  req: RegisterVaultRequest,
): Promise<string> {
  const vaultId = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    let orgId = org.id;
    if (req.kind !== 'project' && !isOrgManager({ orgRole: org.role }))
      throw forbidden('only the organization Owner and Admins can register organization vaults');
    if (req.kind === 'project') {
      const p = await loadVisibleProject(tx, user.id, req.projectId as string);
      if (p.my_role !== 'owner') throw forbidden('only the project owner can register its vault');
      orgId = p.org_id;
      if (await one(tx, 'SELECT 1 FROM vaults WHERE project_id=$1', [p.id]))
        throw conflict('vault_exists', 'this project already has a vault');
    } else if (
      await one(tx, `SELECT 1 FROM vaults WHERE org_id=$1 AND kind='org' AND project_id IS NULL`, [orgId])
    ) {
      throw conflict('vault_exists', 'the organization already has an organization vault; edit it instead');
    }
    assertRemoteUrl(ctx, req.remoteUrl.trim());
    const payload = {
      vaultId,
      orgId,
      projectId: req.projectId,
      kind: req.kind,
      name: req.name ?? (req.kind === 'project' ? 'Project vault' : 'Organization vault'),
      remoteUrl: req.remoteUrl.trim(),
      syncIntervalSec: req.syncIntervalSec,
    };
    await ctx.store.append(
      [
        {
          streamId: streamId.vault(vaultId),
          event: { type: 'VaultRegistered', payload },
          actor: userActor(user.id),
          scope: req.projectId ? projectScope(orgId, req.projectId) : orgScope(orgId),
        },
      ],
      { tx },
    );
  });
  return vaultId;
}

async function editableVault(tx: Queryable, user: AuthSession['user'], vaultId: string): Promise<Row> {
  const v = await one(
    tx,
    `SELECT v.*, p.org_id AS project_org FROM vaults v LEFT JOIN projects p ON p.id = v.project_id WHERE v.id=$1`,
    [vaultId],
  );
  if (!v) throw notFound('vault not found');
  const manager = isOrgManager({ orgRole: await orgRoleOf(tx, user.id, v.org_id) });
  const visible = v.project_id
    ? await one(
        tx,
        `SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2 AND status='active'`,
        [v.project_id, user.id],
      )
    : manager
      ? { role: 'owner' }
      : undefined;
  if (!visible) throw notFound('vault not found');
  if (v.project_id ? visible.role !== 'owner' : !manager)
    throw forbidden('only the organization Owner and Admins can change this vault');
  return v;
}

export async function updateVault(
  ctx: Ctx,
  user: AuthSession['user'],
  vaultId: string,
  changes: PatchVaultRequest,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const v = await editableVault(tx, user, vaultId);
    if (Object.keys(changes).length === 0) return;
    if (changes.remoteUrl !== undefined) assertRemoteUrl(ctx, changes.remoteUrl.trim());
    await ctx.store.append(
      [
        {
          streamId: streamId.vault(vaultId),
          event: {
            type: 'VaultUpdated',
            payload: {
              vaultId,
              orgId: v.org_id,
              projectId: v.project_id ?? undefined,
              kind: v.kind,
              name: changes.name ?? v.name,
              remoteUrl: changes.remoteUrl?.trim() ?? v.remote_url,
              syncIntervalSec: changes.syncIntervalSec ?? v.sync_interval_sec,
            },
          },
          actor: userActor(user.id),
          scope: vaultScope(v),
        },
      ],
      { tx },
    );
  });
}

/**
 * The manager says the conflict on one of their workstations is resolved: sync of that vault resumes
 * (`vault.configure{resume}`). Called by the M3 endpoint and by the M2 desk resolve for `subkind 'vault_conflict'`.
 */
export async function resolveVaultConflict(
  ctx: Ctx,
  user: AuthSession['user'],
  vaultId: string,
  workstationId: string,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const deskItemId = await resolveVaultConflictIn(ctx, tx, user, vaultId, workstationId);
    await closeDeskItemIn(ctx, tx, deskItemId, { userId: user.id }, 'acknowledged');
  });
  await ctx.services.gateway.deliverPending(workstationId);
}

/** Same inside the caller's append transaction (the desk resolve path); returns the conflict's desk item id. */
export async function resolveVaultConflictIn(
  ctx: Ctx,
  tx: Tx,
  user: AuthSession['user'],
  vaultId: string,
  workstationId: string,
): Promise<string | null> {
  const ws = await one(tx, `SELECT id, user_id FROM workstations WHERE id=$1 AND status='active'`, [
    workstationId,
  ]);
  if (!ws || ws.user_id !== user.id) throw notFound('workstation not found');
  const v = await one(tx, 'SELECT * FROM vaults WHERE id=$1', [vaultId]);
  if (!v) throw notFound('vault not found');
  const wv = await one(
    tx,
    'SELECT paused, desk_item_id FROM workstation_vaults WHERE workstation_id=$1 AND vault_id=$2',
    [workstationId, vaultId],
  );
  if (!wv?.paused)
    throw conflict('not_in_conflict', 'this vault has no unresolved conflict on that workstation');
  await ctx.store.append(
    [
      {
        streamId: streamId.vault(vaultId),
        event: { type: 'VaultConflictResolved', payload: { vaultId, workstationId, resolvedBy: user.id } },
        actor: userActor(user.id),
        scope: vaultScope(v),
      },
    ],
    { tx },
  );
  await queueVaultConfigure(ctx, tx, workstationId, [vaultId]);
  return wv.desk_item_id ?? null;
}

// ------------------------------------------------------------------- what a workstation should sync

/**
 * Vaults a workstation syncs: the organization-level vaults of the organizations where its user is Owner or Admin
 * (owner decision 12: Members' workstations do not get them) and the vaults of their member projects.
 */
export async function vaultConfigsFor(db: Queryable, userId: string): Promise<VaultConfig[]> {
  const vs = await rows(
    db,
    `SELECT v.* FROM vaults v
      WHERE (v.project_id IS NULL AND v.org_id IN (SELECT om.org_id FROM org_members om
               WHERE om.user_id = $1 AND om.status = 'active' AND om.role IN ('owner','admin')))
         OR v.project_id IN (SELECT project_id FROM project_members WHERE user_id = $1 AND status = 'active')
      ORDER BY v.created_at, v.id`,
    [userId],
  );
  return vs.map((v) => ({
    vaultId: v.id,
    kind: v.kind,
    projectId: v.project_id ?? undefined,
    name: v.name,
    remoteUrl: v.remote_url,
    syncIntervalSec: v.sync_interval_sec,
  }));
}

/** Git identity of vault commits: the workstation's DevOps engineer (docs/ARCHITECTURE.md section 16.3). */
export async function configureCommand(
  db: Queryable,
  workstationId: string,
  resume: string[] = [],
): Promise<VaultConfigureCommand | null> {
  const ws = await one(db, `SELECT id, user_id, name FROM workstations WHERE id=$1 AND status='active'`, [
    workstationId,
  ]);
  if (!ws) return null;
  const devops = await one(
    db,
    `SELECT id, name FROM agents WHERE workstation_id=$1 AND is_devops AND status='active' LIMIT 1`,
    [workstationId],
  );
  return {
    vaults: await vaultConfigsFor(db, ws.user_id),
    identity: {
      name: `${devops?.name ?? 'DevOps'} (aom)`,
      email: `${devops?.id ?? ws.id}@agents.aom.invalid`,
    },
    workstationName: ws.name,
    resume,
  };
}

/**
 * Durable `vault.configure` (full state, replace semantics). Older undelivered configure commands for the
 * workstation are superseded; their pending `resume` requests are carried over.
 */
export async function queueVaultConfigure(
  ctx: Ctx,
  db: Queryable,
  workstationId: string,
  resume: string[] = [],
): Promise<void> {
  // At most one configure row per workstation: finished ones are dropped too (no pile-up per reconnect).
  const old = await rows(
    db,
    `DELETE FROM runner_commands WHERE workstation_id=$1 AND type='vault.configure' RETURNING payload, status`,
    [workstationId],
  );
  const carried = old
    .filter((r) => r.status === 'pending' || r.status === 'sent')
    .flatMap((r) => ((r.payload as { resume?: string[] }).resume ?? []) as string[]);
  const cmd = await configureCommand(db, workstationId, [...new Set([...resume, ...carried])]);
  if (!cmd) return;
  await enqueueRunnerCommand(db, workstationId, 'vault.configure', cmd as unknown as Record<string, unknown>);
}

/** After vaults or memberships changed: re-sync the vault set of every active workstation of `userIds`. */
export async function refreshVaultConfig(ctx: Ctx, userIds: string[]): Promise<void> {
  const list = await rows(
    ctx.pool,
    `SELECT id FROM workstations WHERE user_id = ANY($1::uuid[]) AND status='active'`,
    [[...new Set(userIds)]],
  );
  for (const w of list) {
    await queueVaultConfigure(ctx, ctx.pool, w.id);
    await ctx.services.gateway.deliverPending(w.id);
  }
}

/** Users whose workstations sync `vault`: the Owner and Admins for org vaults, the active members for a project vault. */
export async function vaultAudience(
  db: Queryable,
  vault: { org_id: string; project_id: string | null },
): Promise<string[]> {
  if (!vault.project_id)
    return (
      await rows<{ user_id: string }>(
        db,
        `SELECT user_id FROM org_members WHERE org_id=$1 AND status='active' AND role IN ('owner','admin')`,
        [vault.org_id],
      )
    ).map((r) => r.user_id);
  return (
    await rows<{ user_id: string }>(
      db,
      `SELECT user_id FROM project_members WHERE project_id=$1 AND status='active'`,
      [vault.project_id],
    )
  ).map((r) => r.user_id);
}

// ------------------------------------------------------------------------- vault of a card / project

/**
 * The one vault a card of `projectId` may read when its shift runs on a workstation of `workstationUserId`:
 * the project vault if the project has one, else the organization vault (only on the workstations of the
 * organization's Owner and Admins). Knowledge never crosses organizations (docs/ARCHITECTURE.md 16.1).
 */
/**
 * Does the project have a knowledge vault of its own, or the organization one? (The same lookup as `vaultForProject`,
 * without the check of one workstation's user.)
 */
export async function projectHasVault(db: Queryable, projectId: string): Promise<boolean> {
  return !!(await one(
    db,
    `SELECT 1 FROM projects p WHERE p.id=$1 AND EXISTS (
       SELECT 1 FROM vaults v WHERE v.project_id = p.id
          OR (v.org_id = p.org_id AND v.kind = 'org' AND v.project_id IS NULL))`,
    [projectId],
  ));
}

export const NO_VAULT_MESSAGE =
  'this project has no knowledge vault, so reports cannot go to the vault; register a vault first or use the repository';

export async function vaultForProject(
  db: Queryable,
  projectId: string,
  workstationUserId: string,
): Promise<{ id: string; kind: 'org' | 'project'; folder: string } | null> {
  const p = await one(db, 'SELECT id, org_id, key, vault_folder, vault_dir FROM projects WHERE id=$1', [
    projectId,
  ]);
  if (!p) return null;
  const v =
    (await one(db, 'SELECT id, kind FROM vaults WHERE project_id=$1', [projectId])) ??
    (isOrgManager({ orgRole: await orgRoleOf(db, workstationUserId, p.org_id) })
      ? await one(db, `SELECT id, kind FROM vaults WHERE org_id=$1 AND kind='org' AND project_id IS NULL`, [
          p.org_id,
        ])
      : undefined);
  if (!v) return null;
  return {
    id: v.id,
    kind: v.kind,
    folder: projectVaultFolder({ key: p.key, vaultFolder: p.vault_folder, vaultDir: p.vault_dir }),
  };
}

// ------------------------------------------------------------------------------------- vault.write

/**
 * A connected workstation of the vault's audience that holds a clone (docs/ARCHITECTURE.md section 16.4); falls back
 * to any connected workstation (the runner clones on demand), then to the owner's most recently seen workstation.
 */
export async function chooseVaultWriteTarget(
  db: Queryable,
  vault: { id: string; org_id: string; project_id: string | null },
): Promise<string | null> {
  const audience = await vaultAudience(db, vault);
  const r = await one<{ id: string }>(
    db,
    `SELECT w.id FROM workstations w
       LEFT JOIN workstation_vaults wv ON wv.workstation_id = w.id AND wv.vault_id = $2
      WHERE w.user_id = ANY($1::uuid[]) AND w.status = 'active'
      ORDER BY w.connected DESC, (wv.local_path IS NOT NULL AND NOT COALESCE(wv.paused, false)) DESC,
               w.last_seen_at DESC NULLS LAST, w.paired_at
      LIMIT 1`,
    [audience, vault.id],
  );
  return r?.id ?? null;
}

/** Queues a `vault.write` command for the vault and delivers it if the target runner is connected. */
export async function enqueueVaultWrite(
  ctx: Ctx,
  db: Queryable,
  vaultId: string,
  cmd: Omit<VaultWriteCommand, 'vaultId' | 'push'> & { push?: boolean },
): Promise<{ queued: boolean; workstationId?: string; commandId?: string; reason?: string }> {
  const vault = await one(db, 'SELECT id, org_id, project_id FROM vaults WHERE id=$1', [vaultId]);
  if (!vault) return { queued: false, reason: 'vault_not_found' };
  const workstationId = await chooseVaultWriteTarget(db, vault as never);
  if (!workstationId) return { queued: false, reason: 'no_workstation' };
  const commandId = await enqueueRunnerCommand(db, workstationId, 'vault.write', {
    vaultId,
    push: true,
    ...cmd,
  });
  return { queued: true, workstationId, commandId };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A runner could not rebase a vault onto its remote and paused syncing it: a pinned desk escalation (through the
 * desk port) and `VaultSyncConflict`. Repeated reports while paused are ignored.
 */
export async function applyVaultConflict(
  ctx: Ctx,
  tx: Tx,
  ws: { id: string; userId: string },
  msg: { vaultId: string; files: string[] },
): Promise<void> {
  if (!UUID_RE.test(msg.vaultId)) return;
  const v = await one(tx, 'SELECT * FROM vaults WHERE id=$1', [msg.vaultId]);
  if (!v || !(await vaultAudience(tx, v as never)).includes(ws.userId)) return;
  const wv = await one(tx, 'SELECT paused FROM workstation_vaults WHERE workstation_id=$1 AND vault_id=$2', [
    ws.id,
    v.id,
  ]);
  if (wv?.paused) return;
  const { deskItemId } = await raiseDeskItem(ctx, tx, {
    kind: 'escalation',
    subkind: 'vault_conflict',
    title: `Vault sync conflict: ${v.name}`,
    body: `Local and remote edits to ${msg.files.length ? msg.files.join(', ') : 'the vault'} cannot be merged automatically. Syncing of this vault is paused on this workstation until you resolve it.`,
    pinned: true,
    blocking: false,
    orgId: v.org_id,
    projectId: v.project_id,
    routeToUserId: ws.userId,
    context: { vaultId: v.id, workstationId: ws.id, files: msg.files },
  });
  await ctx.store.append(
    [
      {
        streamId: streamId.vault(v.id),
        event: {
          type: 'VaultSyncConflict',
          payload: { vaultId: v.id, workstationId: ws.id, files: msg.files, deskItemId },
        },
        actor: { kind: 'runner', id: ws.id },
        scope: userScope(ws.userId),
      },
    ],
    { tx },
  );
}

export async function markVaultStatus(
  ctx: Ctx,
  workstationId: string,
  s: {
    vaultId: string;
    lastPullAt: string | null;
    lastPushAt: string | null;
    error?: string;
    localPath?: string;
  },
): Promise<void> {
  if (!UUID_RE.test(s.vaultId)) return;
  await exec(
    ctx.pool,
    `INSERT INTO workstation_vaults (workstation_id, vault_id, last_pull_at, last_push_at, last_error, local_path)
     SELECT $1, v.id, $3, $4, $5, $6 FROM vaults v WHERE v.id = $2
     ON CONFLICT (workstation_id, vault_id) DO UPDATE
       SET last_pull_at = COALESCE(EXCLUDED.last_pull_at, workstation_vaults.last_pull_at),
           last_push_at = COALESCE(EXCLUDED.last_push_at, workstation_vaults.last_push_at),
           last_error = EXCLUDED.last_error,
           local_path = COALESCE(EXCLUDED.local_path, workstation_vaults.local_path)`,
    [workstationId, s.vaultId, s.lastPullAt, s.lastPushAt, s.error ?? null, s.localPath ?? null],
  );
}
