import { randomUUID } from 'node:crypto';
import {
  BMAD_MARKER_SKILL,
  BMAD_ROLE_SET,
  BUILTIN_ROLES,
  bmadRoleSet,
  DESK_SUBKIND_DEFINITION,
  isOrgManager,
  type PackItem,
  type RoleDefinition,
  RoleDefinitionSchema,
  type RoleSetKey,
  roleSetIssues,
  streamId,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import { packUsable } from '../capabilities/registry.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { rebaseAgentsToCurrentRoles } from '../hr/follow-role.ts';
import { orgScope, SYSTEM_ACTOR, userActor } from './common.ts';

/**
 * Role sets (docs/bmad-roles.md). Switching an organization to the BMAD role set registers the set's versions of the built-in
 * roles (and its custom UX designer) as ONE approval on the Owner's desk; on approval the agents move to them like to any new
 * version of their role (`rebaseAgentsToCurrentRoles`: permissions and skills, own deviations kept). Switching back supersedes
 * the set's versions of the built-in roles and moves the agents back to the built-in versions. A version of the set never
 * changes a role's instructions, core rules, permissions or stages (`roleSetIssues`), only its persona and skills.
 */

export interface RoleSetStatus {
  roleSet: string;
  /** The imported pack whose skills the set's roles are given. */
  pack: string | null;
  /** The desk item that holds the set's versions waiting for approval. */
  pendingDeskItemId: string | null;
  roles: Array<{ key: string; version: number; status: string }>;
}

/** The rows of the organization that belong to a role set (pending, active or superseded). */
async function roleSetRows(db: Queryable, orgId: string, statuses: string[]) {
  return rows(
    db,
    `SELECT id, key, version, status, desk_item_id, definition FROM role_definitions
      WHERE org_id=$1 AND definition ? 'roleSet' AND status = ANY($2::text[]) ORDER BY key, version DESC`,
    [orgId, statuses],
  );
}

export async function roleSetStatus(db: Queryable, orgId: string): Promise<RoleSetStatus> {
  const org = await one(db, 'SELECT role_set, role_set_pack FROM organizations WHERE id=$1', [orgId]);
  const live = await roleSetRows(db, orgId, ['pending_approval', 'active']);
  return {
    roleSet: (org?.role_set as string | undefined) ?? 'guildwise',
    pack: (org?.role_set_pack as string | null | undefined) ?? null,
    pendingDeskItemId:
      (live.find((r) => r.status === 'pending_approval')?.desk_item_id as string | undefined) ?? null,
    roles: live.map((r) => ({ key: r.key, version: r.version, status: r.status })),
  };
}

/**
 * The organization's pack that holds the BMAD skills: an organization pack (not a private one, so every agent can use its
 * skills) whose snapshot has `<pack>:bmad-agent-analyst`. An approved one wins over one that is not approved yet.
 */
export async function findBmadPack(db: Queryable, orgId: string): Promise<string | null> {
  const packs = await rows(
    db,
    `SELECT name, snapshot, pinned_sha, content_hash, trusted, trusted_sha, trusted_hash, integrity_failed, visibility
       FROM packs WHERE org_id=$1 AND removed_at IS NULL AND visibility='org' AND snapshot IS NOT NULL ORDER BY name`,
    [orgId],
  );
  const bmad = packs.filter((p) =>
    ((p.snapshot?.items ?? []) as PackItem[]).some(
      (i) => i.kind === 'skill' && i.key === `${p.name}:${BMAD_MARKER_SKILL}`,
    ),
  );
  return ((bmad.find((p) => packUsable(p as never).usable) ?? bmad[0])?.name as string | undefined) ?? null;
}

const builtinOf = (key: string, version?: number): RoleDefinition | undefined =>
  BUILTIN_ROLES.find((r) => r.key === key && (version === undefined || r.version === version));

/** The definition without what changes from one registration to the next (its version). */
const comparable = (d: RoleDefinition) => JSON.stringify({ ...RoleDefinitionSchema.parse(d), version: 0 });

/**
 * Registers the set's versions that differ from the organization's newest version of the set, as drafts submitted together on
 * one desk item. Returns the desk item, or null when every role is already current. A role's version number is above every
 * version of its key (built-in and the organization's), so the agents follow it once it is approved.
 */
export async function proposeRoleSet(
  ctx: Ctx,
  tx: Tx,
  orgId: string,
  pack: string,
  by: { userId?: string },
): Promise<string | null> {
  const existing = await roleSetRows(tx, orgId, ['pending_approval', 'active']);
  // what the Owner already rejected is not offered again (only the start-up sync can propose without a person asking)
  const rejected = by.userId ? [] : await roleSetRows(tx, orgId, ['rejected']);
  const toRegister: Array<{ id: string; def: RoleDefinition }> = [];
  for (const def of bmadRoleSet(pack)) {
    const issues = roleSetIssues(def, builtinOf(def.key, def.roleSet?.builtinVersion));
    if (issues.length) throw new Error(`the BMAD role set is invalid for ${def.key}: ${issues.join('; ')}`);
    const newest = existing.find((r) => r.key === def.key);
    if (newest && comparable(newest.definition) === comparable(def)) continue;
    if (rejected.some((r) => r.key === def.key && comparable(r.definition) === comparable(def))) continue;
    const top = await one<{ v: number | null }>(
      tx,
      `SELECT max(version) AS v FROM role_definitions WHERE key=$2 AND (org_id=$1 OR org_id IS NULL)`,
      [orgId, def.key],
    );
    const version = Number(top?.v ?? 0) + 1;
    toRegister.push({ id: randomUUID(), def: RoleDefinitionSchema.parse({ ...def, version }) });
  }
  if (toRegister.length === 0) return null;
  const deskItemId = randomUUID();
  const actor = by.userId ? userActor(by.userId) : SYSTEM_ACTOR;
  const scope = orgScope(orgId);
  const events: AppendInput[] = [];
  for (const r of toRegister)
    events.push({
      streamId: streamId.role(orgId, r.def.key),
      event: {
        type: 'RoleVersionRegistered',
        payload: {
          roleVersionId: r.id,
          orgId,
          key: r.def.key,
          version: r.def.version,
          definition: r.def,
          status: 'draft',
        },
      },
      actor,
      scope,
    });
  events.push({
    streamId: streamId.desk(deskItemId),
    event: {
      type: 'DeskItemCreated',
      payload: {
        deskItemId,
        kind: 'approval',
        subkind: DESK_SUBKIND_DEFINITION,
        title: `Approve the BMAD role set (${toRegister.length} role${toRegister.length === 1 ? '' : 's'})`,
        body: [
          `The roles take the personas and skills of the BMAD Method (pack \`${pack}\`). Their instructions, core rules, permissions and stages stay the built-in ones. On approval every agent on these roles moves to the new version.`,
          '',
          ...toRegister.map(
            (r) =>
              `- ${r.def.name} (\`${r.def.key}\`) v${r.def.version}: skills ${r.def.skills.map((s) => `\`${s}\``).join(', ') || 'none'}`,
          ),
        ].join('\n'),
        options: [],
        blocking: false,
        pinned: false,
        affectedCardIds: [],
        askedBy: { kind: 'system' },
      },
    },
    actor: SYSTEM_ACTOR,
    scope,
  });
  for (const r of toRegister)
    events.push({
      streamId: streamId.role(orgId, r.def.key),
      event: { type: 'RoleVersionSubmitted', payload: { roleVersionId: r.id, deskItemId } },
      actor,
      scope,
    });
  await ctx.store.append(events, { tx });
  return deskItemId;
}

/** Switches the organization's role set (Owner and Admins). */
export async function setRoleSet(
  ctx: Ctx,
  user: { id: string },
  orgId: string,
  roleSet: RoleSetKey,
): Promise<RoleSetStatus> {
  if (!isOrgManager({ orgRole: await orgRoleOf(ctx.pool, user.id, orgId) }))
    throw forbidden('only the organization Owner and Admins can change the role set');
  await withAppendTx(ctx.pool, async (tx) => {
    await one(tx, 'SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE', [orgId]);
    const status = await roleSetStatus(tx, orgId);
    if (status.pendingDeskItemId)
      throw conflict(
        'role_set_pending',
        'the role set waits for approval on the desk: approve or reject it before you switch again',
        { deskItemId: status.pendingDeskItemId },
      );
    if (roleSet === BMAD_ROLE_SET) {
      const pack = await findBmadPack(tx, orgId);
      if (!pack)
        throw badRequest(
          'bmad_pack_missing',
          `import the BMAD Method as an organization pack first (Capabilities > Packs): no pack has the ${BMAD_MARKER_SKILL} skill`,
        );
      await proposeRoleSet(ctx, tx, orgId, pack, { userId: user.id });
      if (status.roleSet !== roleSet || status.pack !== pack)
        await ctx.store.append(
          [
            {
              streamId: streamId.org(orgId),
              event: { type: 'OrgRoleSetChanged', payload: { orgId, roleSet, pack, by: user.id } },
              actor: userActor(user.id),
              scope: orgScope(orgId),
            },
          ],
          { tx },
        );
      return;
    }
    // back to the stock roles: the set's versions of built-in roles stop being current (its custom role stays)
    const active = (await roleSetRows(tx, orgId, ['active'])).filter((r) => builtinOf(r.key));
    const events: AppendInput[] = [];
    if (active.length)
      events.push({
        streamId: streamId.org(orgId),
        event: {
          type: 'RoleSetVersionsWithdrawn',
          payload: { orgId, roleVersionIds: active.map((r) => r.id) },
        },
        actor: userActor(user.id),
        scope: orgScope(orgId),
      });
    if (status.roleSet !== roleSet)
      events.push({
        streamId: streamId.org(orgId),
        event: { type: 'OrgRoleSetChanged', payload: { orgId, roleSet, by: user.id } },
        actor: userActor(user.id),
        scope: orgScope(orgId),
      });
    if (events.length) await ctx.store.append(events, { tx });
    for (const key of new Set(active.map((r) => r.key as string)))
      await rebaseAgentsToCurrentRoles(ctx, { orgId, roleKey: key, tx, allowDown: true });
  });
  return roleSetStatus(ctx.pool, orgId);
}

/**
 * At boot: an organization on the BMAD role set whose versions are behind the code (a regenerated BMAD commit, a new built-in
 * version) gets the changed roles as a new approval on its desk. Nothing changes until the Owner approves. Returns how many
 * organizations got one.
 */
export async function syncRoleSets(ctx: Ctx): Promise<number> {
  const orgs = await rows(ctx.pool, `SELECT id, role_set_pack FROM organizations WHERE role_set=$1`, [
    BMAD_ROLE_SET,
  ]);
  let n = 0;
  for (const o of orgs) {
    const proposed = await withAppendTx(ctx.pool, async (tx) => {
      if ((await roleSetStatus(tx, o.id)).pendingDeskItemId) return null;
      const pack = (await findBmadPack(tx, o.id)) ?? (o.role_set_pack as string | null);
      return pack ? proposeRoleSet(ctx, tx, o.id, pack, {}) : null;
    });
    if (proposed) n++;
  }
  return n;
}
