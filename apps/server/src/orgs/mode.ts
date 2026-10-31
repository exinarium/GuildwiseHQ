import { DEV_ONLY_ROLE_KEYS, isBusinessOrg, isBusinessRoleKey } from '@aom/shared';
import { one, type Queryable, rows } from '../db/sql.ts';
import { conflict } from '../errors.ts';

/** 409 `business_mode` when the organization works in Business mode. `FOR SHARE` serialises with a concurrent switch. */
export async function assertDevMode(db: Queryable, orgId: string, message: string): Promise<void> {
  const o = await one<{ mode: string }>(db, 'SELECT mode FROM organizations WHERE id=$1 FOR SHARE', [orgId]);
  if (isBusinessOrg(o)) throw conflict('business_mode', message);
}

/** The organization's mode (`dev` for an unknown organization). */
export async function orgModeOf(db: Queryable, orgId: string): Promise<'dev' | 'business'> {
  const o = await one<{ mode: string }>(db, 'SELECT mode FROM organizations WHERE id=$1', [orgId]);
  return isBusinessOrg(o) ? 'business' : 'dev';
}

/** The sentence for a business role asked for in a dev organization. */
export const businessRoleMsg = (role: string): string =>
  `${role} is a business role: it can be hired in a business organization only.`;

/** 409 `role_not_in_mode` when a business role is hired in a dev organization. */
export async function assertBusinessRoleOffered(
  db: Queryable,
  orgId: string,
  roleKey: string,
  roleName: string,
) {
  if (!isBusinessRoleKey(roleKey)) return;
  if ((await orgModeOf(db, orgId)) !== 'business')
    throw conflict('role_not_in_mode', businessRoleMsg(roleName));
}

export const BUSINESS_MODE_MSG = {
  repo: 'This organization works in Business mode, which does not use code repositories. An Owner or Admin can switch it to Developer mode in Organization settings.',
  hire: (role: string) =>
    `This organization works in Business mode: ${role} agents are for software delivery and cannot be hired here.`,
  packUrl:
    'This organization works in Business mode: packs cannot be added from a git URL. Write your own capability or use the starter gallery instead.',
};

export interface ModeSwitchBlockers {
  repositories: { project: string; name: string }[];
  agents: { name: string; role: string }[];
}

/**
 * What stops an organization from switching to Business mode: connected repositories and active code-role agents. The
 * built-in DevOps engineer of a paired workstation is plumbing the server relies on, so it does not block.
 */
export async function modeSwitchBlockers(db: Queryable, orgId: string): Promise<ModeSwitchBlockers> {
  const repos = await rows<{ key: string; name: string }>(
    db,
    `SELECT p.key, r.name FROM project_repos r JOIN projects p ON p.id = r.project_id
      WHERE p.org_id=$1 AND r.removed_at IS NULL ORDER BY p.key, r.name`,
    [orgId],
  );
  const agents = await rows<{ name: string; role_key: string }>(
    db,
    `SELECT name, role_key FROM agents
      WHERE org_id=$1 AND status <> 'retired' AND NOT is_devops AND role_key = ANY($2) ORDER BY name`,
    [orgId, [...DEV_ONLY_ROLE_KEYS]],
  );
  return {
    repositories: repos.map((r) => ({ project: r.key, name: r.name })),
    agents: agents.map((a) => ({ name: a.name, role: a.role_key })),
  };
}

const ROLE_LABEL: Record<string, string> = {
  builder: 'Builder',
  reviewer: 'Reviewer',
  pre_reviewer: 'Pre-reviewer',
  tester: 'Tester',
  devops: 'DevOps',
};

export function blockersMessage(b: ModeSwitchBlockers): string {
  const parts: string[] = [];
  if (b.repositories.length)
    parts.push(
      `remove ${b.repositories.map((r) => `repository ${r.name} (project ${r.project})`).join(', ')}`,
    );
  if (b.agents.length)
    parts.push(`let go of ${b.agents.map((a) => `${a.name} (${ROLE_LABEL[a.role] ?? a.role})`).join(', ')}`);
  return `Business mode needs an organization without code work. First ${parts.join('; ')}.`;
}
