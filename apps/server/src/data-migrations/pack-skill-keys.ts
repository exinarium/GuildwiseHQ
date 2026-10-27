import { isPackedKey, streamId } from '@aom/shared';
import { qualifiedSkillKeys } from '../capabilities/agent-skills.ts';
import { orgScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { exec, one, rows as selectRows } from '../db/sql.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `pack-skill-keys-2026-10`: a pack's skills are keyed `<pack>:<key>`, but the hire form and the role extension stored skill
 * names exactly as typed, so a hand-typed `bmad-agent-analyst` never matched `bmad-method:bmad-agent-analyst` and the agent's
 * instructions listed it as "not found in the registry". This rewrites each bare name that exactly one pack skill of the
 * organization has (and nothing else in the registry) to that full key: on the agents (`AgentChanged`, private packs of the
 * agent's manager count) and on the role extensions (`RoleExtended` with the same base version, organization packs only).
 * Names that are ambiguous or unknown stay as they are. Idempotent; recorded once in `data_migrations`.
 */
export const PACK_SKILL_KEYS_MIGRATION = 'pack-skill-keys-2026-10';

export interface PackSkillKeysReport {
  agents: Array<{ agentId: string; from: string[]; to: string[] }>;
  extensions: Array<{ orgId: string; roleKey: string; from: string[]; to: string[] }>;
}

const hasBare = (keys: string[]) => keys.some((k) => !isPackedKey(k));
const same = (a: string[], b: string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

export async function migratePackSkillKeys(env: DataMigrationEnv): Promise<PackSkillKeysReport | null> {
  const { pool, store, clock, log } = env;
  if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [PACK_SKILL_KEYS_MIGRATION]))
    return null;
  const report: PackSkillKeysReport = { agents: [], extensions: [] };
  // only organizations that have a pack can have a pack skill to resolve to
  const agents = await selectRows(
    pool,
    `SELECT a.id, a.org_id, a.skills, a.hired_for_project_id, COALESCE(a.manager_user_id, a.hired_by_user_id) AS viewer
       FROM agents a
      WHERE a.status <> 'retired' AND cardinality(a.skills) > 0
        AND EXISTS (SELECT 1 FROM packs p WHERE p.org_id = a.org_id AND p.removed_at IS NULL)
      ORDER BY a.org_id, a.id`,
  );
  for (const a of agents) {
    const from = a.skills as string[];
    if (!hasBare(from)) continue;
    const to = await qualifiedSkillKeys(pool, a.org_id, from, {
      projectId: a.hired_for_project_id,
      userId: a.viewer,
    });
    if (same(from, to)) continue;
    await store.append([
      {
        streamId: streamId.agent(a.id),
        event: { type: 'AgentChanged', payload: { agentId: a.id, changes: { skills: to } } },
        actor: SYSTEM_ACTOR,
        scope: orgScope(a.org_id),
      },
    ]);
    report.agents.push({ agentId: a.id, from, to });
    log(`${PACK_SKILL_KEYS_MIGRATION}: agent ${a.id} skills ${from.join(',')} -> ${to.join(',')}`);
  }
  const exts = await selectRows(
    pool,
    `SELECT e.org_id, e.role_key, e.base_version, e.extensions FROM role_extensions e
      WHERE EXISTS (SELECT 1 FROM packs p WHERE p.org_id = e.org_id AND p.removed_at IS NULL)
      ORDER BY e.org_id, e.role_key`,
  );
  for (const e of exts) {
    const ext = e.extensions as { instructions?: string; skills?: string[]; standingOrders?: string[] };
    const from = ext.skills ?? [];
    if (!hasBare(from)) continue;
    const to = await qualifiedSkillKeys(pool, e.org_id, from);
    if (same(from, to)) continue;
    await store.append([
      {
        streamId: streamId.role(e.org_id, e.role_key),
        event: {
          type: 'RoleExtended',
          payload: {
            orgId: e.org_id,
            roleKey: e.role_key,
            baseVersion: e.base_version,
            extensions: {
              instructions: ext.instructions ?? '',
              skills: to,
              standingOrders: ext.standingOrders ?? [],
            },
          },
        },
        actor: SYSTEM_ACTOR,
        scope: orgScope(e.org_id),
      },
    ]);
    report.extensions.push({ orgId: e.org_id, roleKey: e.role_key, from, to });
    log(`${PACK_SKILL_KEYS_MIGRATION}: ${e.org_id} ${e.role_key} extension skills -> ${to.join(',')}`);
  }
  await exec(
    pool,
    `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING`,
    [PACK_SKILL_KEYS_MIGRATION, clock.now(), JSON.stringify(report)],
  );
  return report;
}
