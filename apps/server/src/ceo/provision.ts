import { randomUUID } from 'node:crypto';
import {
  CEO_ROLE_KEY,
  DEFAULT_AVATAR_STYLE,
  DEFAULT_CEO_POLICY,
  DEFAULT_CEO_SETTINGS,
  randomAvatarSeed,
  streamId,
} from '@aom/shared';
import { loadRole } from '../catalogue/loader.ts';
import { suggestNames } from '../commands/agents.ts';
import { orgScope, SYSTEM_ACTOR } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, rows } from '../db/sql.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { wsServesOrgSql } from '../simulation/fit.ts';

/**
 * The built-in CEO (docs/design/ceo-front-door.md section 2): one free CEO agent per organization, created in the same
 * append as the organization (and by the `ceo-builtin` data migration for organizations that predate it). There is no
 * appoint, dismiss or training period; Pause stays as an emergency stop.
 */

/** The Owner's most recently seen active workstation that may serve the organization, or null. */
async function ownerWorkstation(db: Queryable, orgId: string, ownerId: string): Promise<string | null> {
  const w = await one<{ id: string }>(
    db,
    `SELECT w.id FROM workstations w
      WHERE w.user_id=$1 AND w.status='active' AND ${wsServesOrgSql('w', '$2::uuid')}
      ORDER BY w.last_seen_at DESC NULLS LAST, w.paired_at DESC, w.id LIMIT 1`,
    [ownerId, orgId],
  );
  return w?.id ?? null;
}

/**
 * The events that give an org its built-in CEO; [] when it has one (active or paused) or the role is missing. A CEO that
 * was retired (the old Disable) is replaced by a new one: the old agent keeps its history. Append them after the events
 * that create the organization and its Owner. `simulation` organizations never take a real workstation.
 */
export async function ceoProvisionEvents(
  tx: Queryable,
  ctx: Pick<Ctx, 'pool'>,
  orgId: string,
  ownerId: string,
  opts: { simulation?: boolean } = {},
): Promise<AppendInput[]> {
  if (
    await one(tx, `SELECT 1 FROM agents WHERE org_id=$1 AND role_key=$2 AND status <> 'retired'`, [
      orgId,
      CEO_ROLE_KEY,
    ])
  )
    return [];
  const role = await loadRole(tx, orgId, CEO_ROLE_KEY);
  if (!role) return [];
  const agentId = randomUUID();
  const dm = role.definition.defaultModel;
  const name = (await suggestNames(ctx, orgId, undefined, 1))[0] || 'Chief';
  const workstationId = opts.simulation ? null : await ownerWorkstation(tx, orgId, ownerId);
  return [
    {
      streamId: streamId.agent(agentId),
      event: {
        type: 'AgentHired',
        payload: {
          agentId,
          orgId,
          allowedProjectIds: null,
          hiredByUserId: ownerId,
          workstationId,
          name,
          roleKey: role.key,
          roleVersion: role.version,
          seniority: 'senior',
          runtime: dm.runtime,
          model: dm.model,
          effort: dm.effort,
          skills: role.definition.skills,
          permissions: role.definition.permissions,
          capacity: 1,
          isDevops: false,
          isBuiltin: true,
          avatarSeed: randomAvatarSeed(),
          avatarStyle: DEFAULT_AVATAR_STYLE,
        },
      },
      actor: SYSTEM_ACTOR,
      scope: orgScope(orgId),
    },
    {
      streamId: streamId.ceo(orgId),
      event: {
        type: 'CeoEnabled',
        payload: {
          orgId,
          agentId,
          by: ownerId,
          policy: DEFAULT_CEO_POLICY,
          settings: DEFAULT_CEO_SETTINGS,
        },
      },
      actor: SYSTEM_ACTOR,
      scope: orgScope(orgId),
    },
  ];
}

interface CeoAgentRow {
  id: string;
  org_id: string;
  runtime: string;
  model: string;
}

const rehome = (a: CeoAgentRow, workstationId: string | null): AppendInput => ({
  streamId: streamId.agent(a.id),
  event: {
    type: 'AgentRehomed',
    payload: { agentId: a.id, workstationId, runtime: a.runtime, model: a.model },
  },
  actor: SYSTEM_ACTOR,
  scope: orgScope(a.org_id),
});

/**
 * The Owner paired a workstation: the CEOs of the organizations they own that have no home yet are bound to it, in the
 * same append as `WorkstationPaired`. A simulated workstation serves its simulation organization only.
 */
export async function ceoBindEvents(
  tx: Queryable,
  ownerId: string,
  workstationId: string,
  simulationOrgId?: string,
): Promise<AppendInput[]> {
  const list = await rows<CeoAgentRow>(
    tx,
    `SELECT a.id, a.org_id, a.runtime, a.model FROM agents a JOIN organizations o ON o.id = a.org_id
      WHERE o.owner_user_id=$1 AND a.role_key=$2 AND a.status='active' AND a.workstation_id IS NULL
        AND (CASE WHEN $3::uuid IS NULL THEN NOT o.simulation ELSE o.id = $3::uuid END)`,
    [ownerId, CEO_ROLE_KEY, simulationOrgId ?? null],
  );
  return list.map((a) => rehome(a, workstationId));
}

/**
 * Ownership moved: full power belongs to the Owner, so the CEO leaves the old Owner's workstation and is bound to the new
 * Owner's (or to none until their next pairing). Append after `OrgOwnershipTransferred`.
 */
export async function ceoOwnerChangeEvents(
  tx: Queryable,
  orgId: string,
  newOwnerId: string,
): Promise<AppendInput[]> {
  const a = await one<CeoAgentRow & { workstation_id: string | null }>(
    tx,
    `SELECT id, org_id, runtime, model, workstation_id FROM agents WHERE org_id=$1 AND role_key=$2 AND status <> 'retired'`,
    [orgId, CEO_ROLE_KEY],
  );
  if (!a) return [];
  const next = await ownerWorkstation(tx, orgId, newOwnerId);
  if (next === a.workstation_id) return [];
  return [rehome(a, next)];
}
