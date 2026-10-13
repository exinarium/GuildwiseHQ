import { type AgentPermissions, AgentPermissionsSchema, rebasePermissions, streamId } from '@aom/shared';
import { loadRole } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';

const SYSTEM = { kind: 'system', id: null } as const;

/**
 * Agents follow their role. For every active agent (optionally only those of one role key / organization) whose role
 * has a newer active version, append `AgentPermissionsRebased`: the new version's permissions plus the agent's own
 * deviations from the version it was derived from (`newRole + (agent - oldRole)`). The agent's `roleVersion` moves
 * with it, so its instructions follow the role too. Idempotent: an agent already on the current version is untouched.
 */
export async function rebaseAgentsToCurrentRoles(
  ctx: Ctx,
  opts: { orgId?: string; roleKey?: string; tx?: Tx } = {},
): Promise<number> {
  const run = async (tx: Tx): Promise<number> => {
    const agents = await rows(
      tx,
      `SELECT id, org_id, role_key, role_version, seniority, permissions FROM agents
        WHERE status <> 'retired' AND ($1::uuid IS NULL OR org_id = $1) AND ($2::text IS NULL OR role_key = $2)`,
      [opts.orgId ?? null, opts.roleKey ?? null],
    );
    const events: AppendInput[] = [];
    for (const a of agents) {
      const current = await loadRole(tx, a.org_id, a.role_key);
      if (!current || current.version <= a.role_version) continue;
      if (!current.definition.seniorityLevels.includes(a.seniority)) continue;
      const own = AgentPermissionsSchema.safeParse(a.permissions);
      if (!own.success) continue;
      const past = await rows<{ definition: unknown; version: number }>(
        tx,
        `SELECT definition, version FROM role_definitions
          WHERE key=$2 AND (org_id = $1 OR org_id IS NULL) AND version <= $3 AND status IN ('active','superseded')
          ORDER BY version`,
        [a.org_id, a.role_key, a.role_version],
      );
      const perms = past.map((p) => (p.definition as { permissions?: AgentPermissions }).permissions);
      const pinned = past.filter((p) => p.version === a.role_version).at(-1);
      const base = (pinned?.definition as { permissions?: AgentPermissions } | undefined)?.permissions;
      if (!base) continue;
      const known = (f: 'allowedTools' | 'deniedShellPatterns' | 'riskTiers') =>
        perms.flatMap((p) => p?.[f] ?? []);
      const next = rebasePermissions(
        {
          role: base,
          knownTools: known('allowedTools'),
          knownDeniedShell: known('deniedShellPatterns'),
          knownRiskTiers: known('riskTiers'),
        },
        own.data,
        current.definition.permissions,
      );
      events.push({
        streamId: streamId.agent(a.id),
        event: {
          type: 'AgentPermissionsRebased',
          payload: {
            agentId: a.id,
            roleKey: a.role_key,
            fromRoleVersion: a.role_version,
            toRoleVersion: current.version,
            previous: own.data,
            permissions: next,
          },
        },
        actor: SYSTEM,
        scope: { orgId: a.org_id, projectId: null, audience: 'org' },
      });
    }
    if (events.length) await ctx.store.append(events, { tx });
    return events.length;
  };
  return opts.tx ? run(opts.tx) : withAppendTx(ctx.pool, run);
}
