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
import { orgOwnerId, orgRoleOf, type Who } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { closeDeskItemIn, raiseDeskItem } from '../desk-port.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { assertRemoteUrl, orgScope, projectScope, SYSTEM_ACTOR, userActor, userScope } from './common.ts';

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
    storage: v.storage ?? 'git',
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
  let convertedId: string | null = null;
  await withAppendTx(ctx.pool, async (tx) => {
    let orgId = org.id;
    if (req.kind !== 'project' && !isOrgManager({ orgRole: org.role }))
      throw forbidden('only the organization Owner and Admins can register organization vaults');
    if (req.kind === 'project') {
      const p = await loadVisibleProject(tx, user.id, req.projectId as string);
      if (p.my_role !== 'owner') throw forbidden('only the project owner can register its vault');
      orgId = p.org_id;
      const existing = await one(
        tx,
        'SELECT id, storage, name, sync_interval_sec FROM vaults WHERE project_id=$1',
        [p.id],
      );
      if (existing?.storage === 'local') {
        // The project's automatic local vault is given a remote repository (docs/design/project-graphs.md section 3):
        // the same vault, now synced. The runner keeps the old folder aside and clones the repository.
        assertRemoteUrl(ctx, req.remoteUrl.trim());
        await ctx.store.append(
          [
            {
              streamId: streamId.vault(existing.id),
              event: {
                type: 'VaultUpdated',
                payload: {
                  vaultId: existing.id,
                  orgId: p.org_id,
                  projectId: p.id,
                  kind: 'project',
                  name: req.name ?? existing.name,
                  remoteUrl: req.remoteUrl.trim(),
                  syncIntervalSec: req.syncIntervalSec,
                  storage: 'git',
                },
              },
              actor: userActor(user.id),
              scope: projectScope(p.org_id, p.id),
            },
          ],
          { tx },
        );
        convertedId = existing.id;
        return;
      }
      if (existing) throw conflict('vault_exists', 'this project already has a vault');
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
  return convertedId ?? vaultId;
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
    if (v.storage === 'local' && changes.remoteUrl !== undefined)
      throw conflict(
        'vault_local',
        'this vault is a local folder; register a repository for the project instead',
      );
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
              ...(v.storage === 'local'
                ? { storage: 'local' as const, localWorkstationId: v.local_workstation_id ?? undefined }
                : {}),
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
export async function vaultConfigsFor(
  db: Queryable,
  userId: string,
  workstationId?: string,
): Promise<VaultConfig[]> {
  // A local vault is a folder on one workstation: only the workstation that holds it gets it.
  const vs = await rows(
    db,
    `SELECT v.* FROM vaults v
      WHERE ((v.project_id IS NULL AND v.org_id IN (SELECT om.org_id FROM org_members om
               WHERE om.user_id = $1 AND om.status = 'active' AND om.role IN ('owner','admin')))
         OR v.project_id IN (SELECT project_id FROM project_members WHERE user_id = $1 AND status = 'active'))
        AND (v.storage = 'git' OR v.local_workstation_id = $2::uuid)
      ORDER BY v.created_at, v.id`,
    [userId, workstationId ?? null],
  );
  return vs.map((v) => ({
    vaultId: v.id,
    kind: v.kind,
    projectId: v.project_id ?? undefined,
    name: v.name,
    remoteUrl: v.remote_url,
    syncIntervalSec: v.sync_interval_sec,
    ...(v.storage === 'local' ? { storage: 'local' as const } : {}),
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
    vaults: await vaultConfigsFor(db, ws.user_id, ws.id),
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
  // The project's own repository vault, else the organization vault, else the project's automatic local vault
  // (docs/design/project-graphs.md section 3: an organization vault keeps the knowledge it already holds).
  const v =
    (await one(db, `SELECT id, kind FROM vaults WHERE project_id=$1 AND storage='git'`, [projectId])) ??
    (isOrgManager({ orgRole: await orgRoleOf(db, workstationUserId, p.org_id) })
      ? await one(db, `SELECT id, kind FROM vaults WHERE org_id=$1 AND kind='org' AND project_id IS NULL`, [
          p.org_id,
        ])
      : undefined) ??
    (await one(db, 'SELECT id, kind FROM vaults WHERE project_id=$1', [projectId]));
  if (!v) return null;
  return {
    id: v.id,
    kind: v.kind,
    folder: projectVaultFolder({ key: p.key, vaultFolder: p.vault_folder, vaultDir: p.vault_dir }),
  };
}

/**
 * The vault a conversation (chat, question shift, BA task) of `orgId` may read, read-only, on `workstationId`: the
 * project's vault (or the organization vault) for a project, else the organization vault, which only the workstations
 * of the organization's Owner and Admins get. `folder` is absent for the organization vault as a whole. A project of
 * another organization never matches. Null: nothing to read (no vault, a non-manager workstation, an unknown project).
 */
export async function vaultForConversation(
  db: Queryable,
  scope: { orgId: string; projectId?: string | null; workstationId?: string | null },
): Promise<{ vaultId: string; kind: 'org' | 'project'; folder?: string } | null> {
  if (!scope.workstationId) return null;
  const ws = await one(db, 'SELECT user_id FROM workstations WHERE id=$1', [scope.workstationId]);
  if (!ws) return null;
  if (scope.projectId) {
    const p = await one(db, 'SELECT org_id FROM projects WHERE id=$1', [scope.projectId]);
    if (!p || p.org_id !== scope.orgId) return null;
    const v = await vaultForProject(db, scope.projectId, ws.user_id);
    return v ? { vaultId: v.id, kind: v.kind, folder: v.folder } : null;
  }
  if (!isOrgManager({ orgRole: await orgRoleOf(db, ws.user_id, scope.orgId) })) return null;
  const v = await one(
    db,
    `SELECT id, kind FROM vaults WHERE org_id=$1 AND kind='org' AND project_id IS NULL`,
    [scope.orgId],
  );
  return v ? { vaultId: v.id, kind: v.kind } : null;
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
  const vault = await one(
    db,
    'SELECT id, org_id, project_id, storage, local_workstation_id FROM vaults WHERE id=$1',
    [vaultId],
  );
  if (!vault) return { queued: false, reason: 'vault_not_found' };
  if (vault.storage === 'local') {
    // A local vault exists on one workstation only: the write goes there (queued until it connects).
    if (!vault.local_workstation_id) return { queued: false, reason: 'no_workstation' };
    const commandId = await enqueueRunnerCommand(db, vault.local_workstation_id, 'vault.write', {
      vaultId,
      push: false,
      ...cmd,
    });
    return { queued: true, workstationId: vault.local_workstation_id, commandId };
  }
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

// ------------------------------------------------------------------ every project has a vault (graphs design 3)

/** The Org Owner's primary workstation: the owner's earliest paired, active workstation. */
export async function primaryWorkstationOf(db: Queryable, orgId: string): Promise<string | null> {
  const ownerId = await orgOwnerId(db, orgId);
  const r = await one<{ id: string }>(
    db,
    `SELECT id FROM workstations WHERE user_id=$1 AND status='active' ORDER BY paired_at, id LIMIT 1`,
    [ownerId],
  );
  return r?.id ?? null;
}

/**
 * Every project always has a vault (docs/design/project-graphs.md section 3). When `projectId` has none, a `local` vault is
 * registered on the Org Owner's primary workstation (a folder, no remote, no sync; the owner backs it up). With no
 * workstation yet nothing is registered and the request stays open: `ensureProjectVaultsForWorkstation` answers it when
 * the owner's first workstation connects. Switched off by `projectGraphs.enabled`. Idempotent; returns the vault id when
 * one was registered now.
 */
export async function ensureProjectVaultIn(
  ctx: Ctx,
  tx: Tx,
  projectId: string,
  reason: 'created' | 'migration' | 'workstation',
): Promise<string | null> {
  if (!ctx.config.projectGraphs.enabled) return null;
  const p = await one(tx, `SELECT id, org_id FROM projects WHERE id=$1 AND kind='project'`, [projectId]);
  if (!p) return null;
  if (await one(tx, 'SELECT 1 FROM vaults WHERE project_id=$1', [projectId])) return null;
  const workstationId = await primaryWorkstationOf(tx, p.org_id);
  const events: AppendInput[] = [];
  if (reason !== 'workstation')
    events.push({
      streamId: streamId.project(projectId),
      event: { type: 'ProjectVaultEnsureRequested', payload: { projectId, orgId: p.org_id, reason } },
      actor: SYSTEM_ACTOR,
      scope: projectScope(p.org_id, projectId),
    });
  const vaultId = randomUUID();
  if (workstationId)
    events.push({
      streamId: streamId.vault(vaultId),
      event: {
        type: 'VaultRegistered',
        payload: {
          vaultId,
          orgId: p.org_id,
          projectId,
          kind: 'project',
          name: 'Project vault',
          remoteUrl: '',
          syncIntervalSec: 300,
          storage: 'local',
          localWorkstationId: workstationId,
        },
      },
      actor: SYSTEM_ACTOR,
      scope: projectScope(p.org_id, projectId),
    });
  if (events.length) await ctx.store.append(events, { tx });
  return workstationId ? vaultId : null;
}

/**
 * A workstation connected: when its user owns an organization whose projects lack a vault, those vaults are created now
 * on this workstation (if it is the owner's primary one). A local vault left without a live workstation is claimed here
 * too. Returns the number of vaults registered.
 */
export async function ensureProjectVaultsForWorkstation(ctx: Ctx, workstationId: string): Promise<number> {
  if (!ctx.config.projectGraphs.enabled) return 0;
  const ws = await one(ctx.pool, `SELECT id, user_id FROM workstations WHERE id=$1 AND status='active'`, [
    workstationId,
  ]);
  if (!ws) return 0;
  const orgs = await rows<{ id: string }>(ctx.pool, `SELECT id FROM organizations WHERE owner_user_id=$1`, [
    ws.user_id,
  ]);
  let made = 0;
  for (const o of orgs) {
    if ((await primaryWorkstationOf(ctx.pool, o.id)) !== workstationId) continue;
    const missing = await rows<{ id: string }>(
      ctx.pool,
      `SELECT p.id FROM projects p WHERE p.org_id=$1 AND p.kind='project'
          AND NOT EXISTS (SELECT 1 FROM vaults v WHERE v.project_id = p.id) ORDER BY p.created_at, p.id`,
      [o.id],
    );
    for (const p of missing)
      if (await withAppendTx(ctx.pool, (tx) => ensureProjectVaultIn(ctx, tx, p.id, 'workstation'))) made++;
    const orphans = await rows<{ id: string }>(
      ctx.pool,
      `SELECT v.id FROM vaults v WHERE v.org_id=$1 AND v.storage='local'
          AND (v.local_workstation_id IS NULL
               OR NOT EXISTS (SELECT 1 FROM workstations w WHERE w.id = v.local_workstation_id AND w.status='active'))`,
      [o.id],
    );
    for (const v of orphans)
      await ctx.store.append([
        {
          streamId: streamId.vault(v.id),
          event: { type: 'VaultLocalWorkstationSet', payload: { vaultId: v.id, orgId: o.id, workstationId } },
          actor: SYSTEM_ACTOR,
          scope: orgScope(o.id),
        },
      ]);
  }
  return made;
}

/** The vault that holds a project's graph: its own vault (any storage), else the organization vault. */
export async function graphVaultFor(
  db: Queryable,
  projectId: string,
): Promise<{
  id: string;
  storage: 'git' | 'local';
  kind: 'org' | 'project';
  workstationId: string | null;
} | null> {
  const p = await one(db, 'SELECT org_id FROM projects WHERE id=$1', [projectId]);
  if (!p) return null;
  const v =
    (await one(db, 'SELECT id, kind, storage, local_workstation_id FROM vaults WHERE project_id=$1', [
      projectId,
    ])) ??
    (await one(
      db,
      `SELECT id, kind, storage, local_workstation_id FROM vaults WHERE org_id=$1 AND kind='org' AND project_id IS NULL`,
      [p.org_id],
    ));
  if (!v) return null;
  return { id: v.id, storage: v.storage, kind: v.kind, workstationId: v.local_workstation_id ?? null };
}
