import type { AgentDto } from '@aom/shared';

/** First-run hire cap (docs/ARCHITECTURE.md section 9.6): 2 active builders, 1 active agent of each other role. */
export function capFor(roleKey: string): number {
  return roleKey === 'builder' ? 2 : 1;
}

export interface RoleCap {
  roleKey: string;
  active: number;
  cap: number;
  full: boolean;
  reason: string | null;
}

export function roleCap(
  roleKey: string,
  roleName: string,
  agents: Pick<AgentDto, 'roleKey' | 'status' | 'isDevops'>[],
): RoleCap {
  const cap = capFor(roleKey);
  const active = agents.filter((a) => a.roleKey === roleKey && a.status === 'active' && !a.isDevops).length;
  const full = active >= cap;
  return {
    roleKey,
    active,
    cap,
    full,
    reason: full
      ? `${roleName} is at the first-run limit (${active} of ${cap} active). Fire one to hire another.`
      : null,
  };
}
