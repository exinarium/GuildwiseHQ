import { isPackedKey, qualifySkillKeys } from '@aom/shared';
import { one, type Queryable, type Row } from '../db/sql.ts';
import { effectiveRegistry } from './registry.ts';

/**
 * The skills an agent is given in every shift, chat and session turn: its own list (the role's skills at hire, moved along
 * with each role version) plus the skills the owner added to its role with Extend. A role extension applies to every agent
 * on the role, so it is read here and not copied into the agents.
 */
export async function effectiveAgentSkills(
  db: Queryable,
  /** An `agents` row (`org_id`, `role_key`, `skills`). */
  agent: Row,
): Promise<string[]> {
  const own = (agent.skills ?? []) as string[];
  const ext = await one(db, 'SELECT extensions FROM role_extensions WHERE org_id=$1 AND role_key=$2', [
    agent.org_id,
    agent.role_key,
  ]);
  const extra = ((ext?.extensions as { skills?: string[] } | undefined)?.skills ?? []) as string[];
  return [...new Set([...own, ...extra])];
}

/**
 * Skill keys as the registry knows them: a bare name typed by hand (`bmad-prd`) becomes the full key of the one pack skill
 * of that name (`bmad-method:bmad-prd`). Everything else is kept as written (`qualifySkillKey`). Reads the registry only
 * when there is a bare key to look up; private packs count only for `userId` (their owner).
 */
export async function qualifiedSkillKeys(
  db: Queryable,
  orgId: string,
  keys: readonly string[],
  opts: { projectId?: string | null; userId?: string | null } = {},
): Promise<string[]> {
  if (keys.every((k) => isPackedKey(k.trim()))) return [...new Set(keys.map((k) => k.trim()))];
  // All kinds: a bare key that is a playbook or persona must stay as written (see `qualifySkillKey`). Packs that are not
  // approved (yet) are included on purpose: the key is a stable name, an unapproved pack's skill is simply not granted
  // until it is usable, and leaving it out would let the same bare name flip to another pack's skill once approved.
  const reg = await effectiveRegistry(db, orgId, {
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    ...(opts.userId ? { userId: opts.userId } : {}),
  });
  return qualifySkillKeys(keys, reg.items);
}
